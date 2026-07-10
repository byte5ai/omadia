/**
 * Epic #470 W1 — lease reaper, orphan sweep, boot-time state rebuild (spec §7).
 *
 * THIS UNIT CLOSES THE GAP EVERY PRIOR AUDIT NOTED: `leaseExpiresAt` was recorded
 * and renewed but never ENFORCED. A wedged or compromised middleware could create
 * allowed-image jobs and leave dind resources pinned indefinitely, because the
 * daemon only ever tore a container down when the middleware ASKED (DELETE). The
 * reaper makes the daemon self-authoritative for containers: the two-sided
 * authority the spec's §7 table demands — the daemon lease reaper is authoritative
 * for containers (survives middleware death); the middleware `reap()` for DB state.
 *
 * Three jobs, one periodic timer:
 *
 *  1. LEASE ENFORCEMENT — every sweep, any LIVE registered job whose lease has
 *     passed is torn down through the EXACT same path as a DELETE
 *     (`JobManager.destroy`): deduplicated per id, cleanup proven before the
 *     record is forgotten, a failed teardown surfaced and the handle RETAINED for
 *     the next sweep. There is no second teardown here (hard-won lesson (a): never
 *     drop the only handle on a live resource before its removal is proven).
 *
 *  2. BOOT-TIME STATE REBUILD — on start the daemon rebuilds its registry from the
 *     engine: every labelled container is re-adopted (so a daemon restart does not
 *     orphan a live job), and any adopted job already past its lease is reaped as
 *     `boot_stale`.
 *
 *  3. ORPHAN SWEEP — labelled containers/networks/volumes with NO corresponding
 *     tracked job are removed, including the partial network/volume a failed
 *     `createJobContainer` rollback could not clear (they carry the deterministic
 *     `omadia-job-<id>` names and this daemon's label). A resource whose id is
 *     still tracked — live OR mid-create — is never touched (lesson (a): a
 *     provisioning job's resources exist before its record lands in `#jobs`).
 *
 * The timer is unref'd and single-flighted: a slow pass never stacks on the next
 * tick, and a hung engine call cannot pin the process open or wedge the daemon
 * (lesson (d) — the tests must not hang). Every reap logs the job id and the
 * reason (`lease_expired` | `lifetime_exceeded` | `orphan` | `boot_stale`) so a
 * reap is observable.
 */

import { jobNetworkName, jobVolumeName } from './clamp.mjs';

/**
 * @typedef {import('./jobs.mjs').JobManager} JobManager
 * @typedef {import('./jobs.mjs').ContainerEngine} ContainerEngine
 * @typedef {import('./jobs.mjs').JobContainer} JobContainer
 */

/**
 * A monotonic-enough clock seam so lease math is deterministic in tests.
 * @typedef {object} Clock
 * @property {() => number} now Milliseconds since the epoch.
 */

/**
 * The reaper's log sink. `info` records each reap; `warn` records a teardown that
 * failed and will be retried. Both optional so `console` satisfies it directly.
 * @typedef {object} ReaperLogger
 * @property {(msg: string) => void} [info]
 * @property {(msg: string) => void} [warn]
 * @property {(msg: string) => void} [log]
 */

/** Default sweep cadence (spec §7: "its 60 s reaper"). The middleware renews at
 *  TTL/3 and the min lease is 30 s, so a 30 s cadence catches an expired lease
 *  within one interval without hammering the engine. */
export const DEFAULT_SWEEP_INTERVAL_MS = 30_000;
/** Floor: a sub-second cadence would spin the engine list calls pointlessly. */
const MIN_SWEEP_INTERVAL_MS = 1_000;

/** @type {Clock} */
const SYSTEM_CLOCK = { now: () => Date.now() };

/**
 * Resolve the sweep cadence from `DEV_RUNNER_SWEEP_INTERVAL_MS` (spec §8 config).
 * Unset, non-numeric, or below the floor falls back to the default so the sweep
 * is never accidentally disabled or set to a busy-loop.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function resolveSweepIntervalMs(env = {}) {
  const raw = env.DEV_RUNNER_SWEEP_INTERVAL_MS;
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_SWEEP_INTERVAL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < MIN_SWEEP_INTERVAL_MS) return DEFAULT_SWEEP_INTERVAL_MS;
  return Math.round(n);
}

/**
 * True when a lease is at or past the clock — or missing/unparseable. A container
 * we cannot prove is still leased is treated as expired: leaving an un-leased
 * container adopted forever would defeat the whole point of the reaper.
 * @param {string} leaseExpiresAt ISO-8601, or '' when the label was absent.
 * @param {number} nowMs
 * @returns {boolean}
 */
export function isLeaseExpired(leaseExpiresAt, nowMs) {
  if (typeof leaseExpiresAt !== 'string' || leaseExpiresAt.trim() === '') return true;
  const t = Date.parse(leaseExpiresAt);
  if (Number.isNaN(t)) return true;
  return t <= nowMs;
}


/**
 * Reject if `p` has not settled within `ms`. The reaper's single-flight guard
 * would otherwise be held forever by one hung engine call, silently disabling
 * lease and lifetime enforcement — the loop would look alive and do nothing.
 * The hung work is abandoned, not cancelled: docker has no cancellation here,
 * but the next pass gets to run.
 * @template T @param {Promise<T>} p @param {number} ms @param {string} label
 * @returns {Promise<T>}
 */
function withDeadline(p, ms, label) {
  /** @type {ReturnType<typeof setTimeout>} */
  let timer;
  const deadline = new Promise((_, reject) => {
    // NOT unref'd: an unref'd deadline lets node exit before it fires, so the
    // awaited race never settles and the caller hangs. It is always cleared in
    // `finally`, so it cannot keep the process alive either.
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

/** @param {unknown} err @returns {string} */
function errMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The lease reaper. Owns no state of its own beyond the timer + a single-flight
 * flag; it reconciles the JobManager registry against the engine's label set.
 *
 * @param {object} deps
 * @param {JobManager} deps.jobManager The registry + the deduplicated teardown authority.
 * @param {ContainerEngine} deps.engine The label-set ground truth and teardown executor.
 * @param {number} [deps.intervalMs] Sweep cadence (default 30 s).
 * @param {number} [deps.passTimeoutMs] Abandon a sweep/rebuild that outruns this.
 * @param {number} [deps.bootGraceMs] Window an adopted job gets to have its lease
 *   re-asserted after a daemon restart (default: the sweep interval).
 * @param {Clock} [deps.clock]
 * @param {ReaperLogger} [deps.logger]
 * @returns {{ start: () => Promise<void>, stop: () => void, sweep: () => Promise<void>, rebuild: () => Promise<void> }}
 */
export function createReaper(deps) {
  /** Window an adopted job gets to have its lease re-asserted after a daemon
   *  restart. Defaults to the sweep interval: one full sweep to be renewed. */
  const bootGraceMs = deps.bootGraceMs ?? deps.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  /** A pass that outruns this is abandoned so the loop keeps sweeping. */
  const passTimeoutMs = deps.passTimeoutMs ?? Math.max(30_000, (deps.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS) * 5);
  const jobManager = deps.jobManager;
  const engine = deps.engine;
  const intervalMs = deps.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  const clock = deps.clock ?? SYSTEM_CLOCK;
  const logger = deps.logger ?? console;
  const info = logger.info ?? logger.log ?? (() => {});
  const warn = logger.warn ?? info;

  /** Jobs a `boot_stale` teardown could not remove. Their record survives with a
   *  future lease, so the ordinary lease sweep would never retry them — they are
   *  retried explicitly, every sweep, until the engine lets them go. */
  const forceReap = new Set();

  /** Has a boot rebuild ever COMPLETED? The orphan sweep decides what to destroy
   *  by asking "is this job tracked?" — so an empty registry makes every live
   *  container look like a leak. If the rebuild never ran (a transient dind
   *  listing error is enough), sweeping would delete exactly the jobs the
   *  rebuild exists to adopt. Nothing is swept until a rebuild has succeeded. */
  let rebuilt = false;

  /** @type {ReturnType<typeof setInterval> | undefined} */
  let timer;
  /** Single-flight guard: the sweep never runs two passes at once (spec §7). */
  let running = false;

  /** @param {string} jobId @param {string} reason */
  function logReap(jobId, reason) {
    info(`[dev-runner-daemon] reaped job ${jobId} (${reason})`);
  }

  /**
   * Tear a REGISTERED job down through the same deduplicated path a DELETE uses.
   * A failed teardown keeps the record (JobManager retains it), so the next sweep
   * retries — the failure is surfaced, never swallowed, and the handle is kept.
   * @param {string} jobId @param {'lease_expired' | 'boot_stale' | 'lifetime_exceeded'} reason
   */
  async function reapRegistered(jobId, reason) {
    try {
      const torn = await jobManager.destroy(jobId);
      if (torn) logReap(jobId, reason);
      forceReap.delete(jobId);
    } catch (err) {
      // The handle is retained by JobManager. But a `boot_stale` corpse keeps a
      // graced (future) lease, so the ordinary lease sweep would never look at
      // it again — remember it and retry every sweep.
      if (reason === 'boot_stale') forceReap.add(jobId);
      warn(`[dev-runner-daemon] reap of ${jobId} (${reason}) failed; handle retained for retry: ${errMessage(err)}`);
    }
  }

  /**
   * Reap every LIVE job whose lease has expired. `list()` is a snapshot, so
   * destroying a job mid-iteration is safe.
   * @param {number} nowMs
   */
  async function reapExpiredLeases(nowMs) {
    for (const jobId of [...forceReap]) {
      await reapRegistered(jobId, 'boot_stale');
    }
    for (const record of jobManager.list()) {
      // The lease says "the middleware still wants this". The hard deadline says
      // "the daemon will not run it any longer, whatever the middleware wants" —
      // without it, endless renewals pin a container forever and the daemon is
      // no longer self-authoritative for containers.
      const pastDeadline = isLeaseExpired(record.hardDeadlineAt, nowMs);
      if (pastDeadline || isLeaseExpired(record.leaseExpiresAt, nowMs)) {
        await reapRegistered(record.jobId, pastDeadline ? 'lifetime_exceeded' : 'lease_expired');
      }
    }
  }

  /**
   * Remove labelled resources with no tracked job — full leaks AND the partial
   * network/volume a failed create left behind. Resources are grouped by job id
   * so one teardown clears a job's container+network+volume together; a job id
   * the registry still tracks (live or mid-create) is skipped (lesson (a)).
   */
  async function reapOrphans() {
    const inv = await engine.listManagedResources();
    /** @type {Map<string, { containerId: string, networkId: string, volumeName: string }>} */
    const groups = new Map();
    /** @param {string} jobId */
    const groupFor = (jobId) => {
      let g = groups.get(jobId);
      if (!g) {
        g = { containerId: '', networkId: '', volumeName: '' };
        groups.set(jobId, g);
      }
      return g;
    };
    for (const c of inv.containers) groupFor(c.jobId).containerId = c.containerId;
    for (const n of inv.networks) groupFor(n.jobId).networkId = n.id || jobNetworkName(n.jobId);
    for (const v of inv.volumes) groupFor(v.jobId).volumeName = v.id || jobVolumeName(v.jobId);

    for (const [jobId, handle] of groups) {
      // Live or mid-create → its resources are legitimately in use (lesson (a)).
      if (jobManager.tracks(jobId)) continue;
      /** @type {JobContainer} */
      const container = { ...handle, imageDigest: '' };
      try {
        await engine.destroyJobContainer(container);
        logReap(jobId, 'orphan');
      } catch (err) {
        warn(`[dev-runner-daemon] orphan reap of ${jobId} failed; will retry next sweep: ${errMessage(err)}`);
      }
    }
  }

  /**
   * Re-adopt every labelled container into the registry so a daemon restart does
   * not orphan a live job, then reap any adopted job already past its lease and
   * finally clear dangling per-job networks/volumes.
   */
  async function rebuild() {
    const nowMs = clock.now();
    const inv = await engine.listManagedResources();
    /** @type {string[]} */
    const staleAtBoot = [];
    for (const c of inv.containers) {
      /** @type {JobContainer} */
      const container = {
        containerId: c.containerId,
        // The per-job network + volume are deterministically named, so the
        // teardown handle is reconstructable from the job id alone even when the
        // engine listing only carried the container.
        networkId: jobNetworkName(c.jobId),
        volumeName: jobVolumeName(c.jobId),
        imageDigest: c.imageDigest,
      };
      // A container that is no longer RUNNING is stale whatever its lease says:
      // its runner exited and nobody is coming back for it. That, not the lease
      // label, is the honest boot-time staleness signal.
      if (!c.running) {
        staleAtBoot.push(c.jobId);
      }
      // GRACE, for the ones still running. The lease label is frozen at create
      // time, but a live job's lease is renewed in memory — and that memory died
      // with the old daemon. A healthy job renewed for an hour looks, from its
      // label alone, an hour overdue; reaping on the label would kill exactly
      // the jobs this rebuild exists to preserve. So every adopted job gets a
      // window: long enough for the middleware to re-assert its lease against
      // the restarted daemon, short enough that a job whose middleware never
      // returns still dies — the ordinary sweep then reaps it as
      // `lease_expired`, one interval later, through the same path.
      const labelExpiry = Date.parse(c.leaseExpiresAt);
      const graced = Number.isNaN(labelExpiry)
        ? nowMs + bootGraceMs
        : Math.max(labelExpiry, nowMs + bootGraceMs);
      jobManager.adopt(c.jobId, container, new Date(graced).toISOString(), c.createdAtMs);
    }
    // The registry now mirrors the engine, so the orphan sweep can trust "not
    // tracked" to mean "leaked". Set BEFORE the reaps below so they may run.
    rebuilt = true;
    // Exited containers die now, through the same deduplicated teardown a DELETE
    // uses — the grace window is for the living, not for corpses.
    for (const jobId of staleAtBoot) {
      await reapRegistered(jobId, 'boot_stale');
    }
    // Partial resources a failed create could not roll back — no container, just a
    // labelled network/volume under the deterministic name.
    await reapOrphans();
  }

  /** One full periodic pass: enforce leases, then sweep orphans.
   *  @param {number} nowMs */
  async function sweepPass(nowMs) {
    await reapExpiredLeases(nowMs);
    // The orphan sweep asks "is this job tracked?" and destroys whatever is not.
    // An empty registry therefore makes every live container look like a leak.
    // Until a boot rebuild has SUCCEEDED the registry is not trustworthy, so the
    // sweep enforces leases (only over jobs it actually knows) but destroys
    // nothing it never had a chance to adopt.
    if (!rebuilt) {
      warn('[dev-runner-daemon] orphan sweep skipped: no successful boot rebuild yet');
      return;
    }
    await reapOrphans();
  }

  /**
   * Run `fn` under the single-flight guard, swallowing (but logging) any error so
   * an engine blip logs and retries next tick rather than killing the timer.
   * @param {() => Promise<void>} fn @param {string} label
   */
  async function guarded(fn, label) {
    if (running) return false; // a pass is already in flight — never stack (spec §7)
    running = true;
    try {
      // A hung engine call must not wedge the loop: without a deadline, `running`
      // would stay true forever and every later sweep would return immediately —
      // leases and hard deadlines would silently stop being enforced.
      await withDeadline(fn(), passTimeoutMs, label);
      return true;
    } catch (err) {
      warn(`[dev-runner-daemon] ${label} failed; retrying next tick: ${errMessage(err)}`);
      return false;
    } finally {
      running = false;
    }
  }

  return {
    async start() {
      // Rebuild BEFORE the timer so the first periodic pass sees a rebuilt
      // registry, then arm an unref'd interval that never stacks.
      await guarded(rebuild, 'boot rebuild');
      timer = setInterval(() => {
        // A rebuild that failed is retried on every tick. Until one succeeds the
        // registry is not trustworthy, so nothing is swept — a transient listing
        // error must never turn live jobs into orphan-sweep victims.
        void (async () => {
          if (!rebuilt) {
            await guarded(rebuild, 'boot rebuild (retry)');
            return;
          }
          await guarded(() => sweepPass(clock.now()), 'sweep');
        })();
      }, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
    // Exposed for tests + a manual poke; both honour the single-flight guard.
    async sweep() {
      await guarded(() => sweepPass(clock.now()), 'sweep');
    },
    async rebuild() {
      await guarded(rebuild, 'boot rebuild');
    },
  };
}
