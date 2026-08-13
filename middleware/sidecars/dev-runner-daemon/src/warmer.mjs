/**
 * Epic #470 W1 — image-cache warming loop + the state `/v1/health` reports (spec §4).
 *
 * The engine already knows HOW to warm: `ContainerEngine.warmImages(refs)` pulls
 * every ref against dind and resolves each to the digest of the repository it
 * actually pulled (`repositoryOf` in `jobs.mjs` — a multi-registry image has
 * several `RepoDigests`, and they are not interchangeable). This unit adds the
 * WHEN and the WHAT-WE-REPORT around that call:
 *
 *   - a periodic loop that warms on boot and on a configurable interval;
 *   - a single warm-state object (`digests`, `warm`, `lastWarmedAt`, `lastError`)
 *     that `GET /v1/health` reports;
 *   - de-duplication so a second warm (an admin `POST /v1/warm` landing while the
 *     boot pull is still running, or a tick that overtakes a slow pull) JOINS the
 *     in-flight pull instead of launching a second one against the engine.
 *
 * Three lessons are baked in:
 *   (a) the interval timer is `unref`'d, never stacks (a tick joins the in-flight
 *       pull rather than starting a new one), and stops on `stop()` — otherwise
 *       the test process hangs and node reports `# cancelled N` with `# fail 0`;
 *   (b) a pull FAILURE never marks an image warm and never clobbers the
 *       last-known-good digest set — a health endpoint that lies is worse than one
 *       that says nothing. `warm` only ever becomes true after a pull SUCCEEDS;
 *   (c) a failed pull is logged and left for the next tick to retry; it never
 *       rejects the loop (which would surface as an unhandled rejection / crash),
 *       though an on-demand `warm()` still rejects so the admin route can report it.
 *
 * SEAM NOTE (for the orchestrator wiring this into `daemon.mjs`, which this unit
 * does not touch): construct one warmer with the engine + `DEV_RUNNER_IMAGES`
 * refs, then
 *   - `GET  /v1/health` reads `warmer.getState()` → `{ digests, warm, ... }`
 *     (drop-in for the old `warmState.digests` / `warmState.warm`);
 *   - `POST /v1/warm` does `const digests = await warmer.warm();`
 *   - `main()` calls `warmer.start()` after `listen`, and the shutdown path calls
 *     `warmer.stop()`.
 * No route SHAPE changes — the same two fields (`warmedDigests`, `imageWarm`) come
 * out, now sourced from the warmer rather than an inline object.
 */

import { withDeadline } from './deadline.mjs';

/** Default warm interval: every 6 h (spec §4). */
export const DEFAULT_WARM_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * The warm state `/v1/health` reports. `warm` is the load-bearing invariant: it
 * is false until a pull has SUCCEEDED at least once, and a later failure never
 * flips it back to false or empties `digests` — the images are still cached, the
 * failure is only about refreshing them.
 * @typedef {object} WarmState
 * @property {string[]} digests Digests from the last SUCCESSFUL warm (one per ref).
 * @property {boolean} warm True once a pull has succeeded and resolved ≥1 digest.
 * @property {string | null} lastWarmedAt ISO-8601 of the last successful warm, or null.
 * @property {string | null} lastError Message of the most recent pull failure, or null.
 */

/**
 * A milliseconds-since-epoch clock seam so `lastWarmedAt` is deterministic in tests.
 * @typedef {object} Clock
 * @property {() => number} now
 */

/**
 * Only the slice of `ContainerEngine` the warmer needs: pull the refs and resolve
 * each to the digest of the repository actually pulled.
 * @typedef {object} WarmEngine
 * @property {(refs: readonly string[]) => Promise<string[]>} warmImages
 */

/**
 * The image-cache warmer: a periodic pull loop plus the health-reported state.
 * @typedef {object} ImageWarmer
 * @property {() => Promise<string[]>} warm Pull now; concurrent calls join one pull.
 * @property {() => void} start Warm on boot, then on the interval (idempotent).
 * @property {() => void} stop Clear the interval (idempotent).
 * @property {() => WarmState} getState Snapshot of the health-reported state.
 * @property {() => boolean} isRunning True while the interval is armed.
 */



/** @type {Clock} */
const SYSTEM_CLOCK = { now: () => Date.now() };

/**
 * Build an image-cache warmer over a container engine.
 *
 * @param {object} deps
 * @param {WarmEngine} deps.engine The container engine (its `warmImages`).
 * @param {readonly string[]} [deps.refs] Refs to warm (`DEV_RUNNER_IMAGES`); default none.
 * @param {number} [deps.pullTimeoutMs] Abandon a pull that outruns this (default 30 min).
 * @param {number} [deps.intervalMs] Warm interval (default 6 h).
 * @param {{ warn: (msg: string) => void, info?: (msg: string) => void }} [deps.logger]
 * @param {Clock} [deps.clock]
 * @param {typeof setInterval} [deps.setInterval] Timer seam (test injection).
 * @param {typeof clearInterval} [deps.clearInterval] Timer seam (test injection).
 * @returns {ImageWarmer}
 */
export function createImageWarmer(deps) {
  const engine = deps.engine;
  const refs = deps.refs ?? [];
  const intervalMs = deps.intervalMs ?? DEFAULT_WARM_INTERVAL_MS;
  const logger = deps.logger ?? console;
  const clock = deps.clock ?? SYSTEM_CLOCK;
  const setIntervalImpl = deps.setInterval ?? setInterval;
  /** A pull that outruns this is abandoned; the next tick retries. */
  const pullTimeoutMs = deps.pullTimeoutMs ?? 30 * 60 * 1000;
  const clearIntervalImpl = deps.clearInterval ?? clearInterval;

  /** @type {WarmState} */
  const state = { digests: [], warm: false, lastWarmedAt: null, lastError: null };

  /** The single in-flight pull, or null when idle. A second `warm()` returns THIS
   *  so concurrent warms (admin POST overlapping the boot pull, or a tick
   *  overtaking a slow pull) never launch a second engine pull — no stampede, no
   *  stacking. */
  /** @type {Promise<string[]> | null} */
  let inflight = null;

  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null;

  /** Run one pull and commit its result to `state`. On success the digest set and
   *  `warm` are replaced from the resolved digests. On failure NOTHING about the
   *  warm result is touched — `warm` and `digests` keep their last-good values —
   *  the error is recorded + logged, and it is re-thrown so an on-demand caller
   *  (`POST /v1/warm`) sees it; the loop swallows it (see `tick`).
   *  @returns {Promise<string[]>} */
  async function runWarm() {
    try {
      // The deadline sits around the ENGINE call, not around the in-flight
      // dedup wrapper: a hung pull must surface as an ordinary failure (recorded
      // in `lastError`, retried next tick) rather than holding the slot forever
      // so every later warm joins a pull that will never settle.
      const resolved = await withDeadline(engine.warmImages(refs), pullTimeoutMs, 'image pull');
      state.digests = resolved;
      // A pull that resolves zero digests is a success but not "warm" — mirrors
      // the empty-refs case: there is nothing cached to launch from.
      state.warm = resolved.length > 0;
      state.lastWarmedAt = new Date(clock.now()).toISOString();
      state.lastError = null;
      return resolved;
    } catch (err) {
      // A failure must NEVER mark the image warm and must NEVER clobber the
      // last-known-good digest set (lesson (b)). Record the reason for /v1/health
      // and log it; the next tick retries.
      const message = err instanceof Error ? err.message : String(err);
      state.lastError = message;
      logger.warn(`[dev-runner-daemon] image warm failed (retrying next tick): ${message}`);
      throw err;
    }
  }

  /** Pull now, or join the pull already running. The in-flight promise is the
   *  dedup key; it is cleared once the pull settles so the NEXT `warm()` starts a
   *  fresh pull.
   *  @returns {Promise<string[]>} */
  function warm() {
    if (inflight) return inflight;
    const run = runWarm();
    inflight = run;
    // Clear the slot once the pull settles. This branch handles BOTH outcomes so
    // it never becomes an unhandled rejection — the caller still gets `run` (with
    // its real resolution/rejection) and attaches its own handler independently.
    const clearSlot = () => {
      if (inflight === run) inflight = null;
    };
    run.then(clearSlot, clearSlot);
    return run;
  }

  /** One interval tick: warm, and SWALLOW any failure. `runWarm` already logged
   *  and recorded it; letting it reject here would become an unhandled rejection
   *  and could crash the daemon (lesson (c)). The failure is retried next tick. */
  function tick() {
    void warm().catch(() => {});
  }

  return {
    warm,

    start() {
      if (timer) return; // idempotent — one loop only
      // Boot warm is fire-and-forget: the daemon must start serving immediately,
      // and /v1/health honestly reports warm:false until this first pull succeeds
      // (spec §4 — provision does not hard-require warmth).
      tick();
      timer = setIntervalImpl(tick, intervalMs);
      // A warm loop must not keep the process alive on its own (lesson (a)): an
      // unref'd timer lets node exit — and lets the test runner finish instead of
      // hanging and reporting `# cancelled N`.
      if (timer && typeof timer.unref === 'function') timer.unref();
    },

    stop() {
      if (timer) {
        clearIntervalImpl(timer);
        timer = null;
      }
    },

    getState() {
      // Return a COPY so a health handler cannot mutate the live state, and the
      // digests array is snapshotted (not aliased) for the same reason.
      return {
        digests: [...state.digests],
        warm: state.warm,
        lastWarmedAt: state.lastWarmedAt,
        lastError: state.lastError,
      };
    },

    isRunning() {
      return timer !== null;
    },
  };
}
