/**
 * Epic #470 W4 — the tracker-triggered job poller (spec §4).
 *
 * POLLING, not webhooks. GitHub Issues is covered by the webhook path (§3); this
 * loop drives PLUGIN trackers (Jira etc.), for which webhook auth is too
 * inconsistent to standardise (§4 Jira note). Jira/GitLab inbound webhooks are
 * explicitly NOT built.
 *
 * Per repo that has a tracker binding AND `'tracker' ∈ allowed_triggers`, every
 * `tracker_poll_interval_s` (default 300, floored at 60):
 *   1. resolve the repo's tracker via the W3 `TrackerRegistry`;
 *   2. `listOpenTickets({ label: repo.triggerLabel })`;
 *   3. keep tickets updated since `dev_repos.tracker_poll_cursor`;
 *   4. dedupe by an active job on `source_ref = <owner>/<name>#<number>`
 *      (`hasActiveTriggerJob`, source='tracker');
 *   5. create a job via `createTriggerJob` with `source='tracker'`;
 *   6. advance the poll cursor to the newest ticket update observed.
 *
 * The SAME structural refusals as webhook jobs apply — a tracker job never runs on
 * the `local` backend and never on a `device_flow` repo — because they live in
 * `createTriggerJob`, the one choke point every trigger source funnels through.
 * Tracker text is equally hostile and flows through the W3 diff-policy engine at
 * apply time unchanged.
 *
 * A tracker error backs the repo off WITHOUT advancing the cursor, so no ticket is
 * silently skipped. On a tracker error we still record the poll attempt (in-memory
 * `lastPolledAt`) so the repo waits its interval before retrying — the backoff.
 *
 * Boot registration is a one-liner the caller wires (see index.ts note); this file
 * exposes only the factory + start/stop.
 */

import type { Pool } from 'pg';

import type { DevPlatformTracker } from '../../routes/devPlatformShared.js';
import type { Ticket } from '../githubIssuesTracker.js';
import type {
  CreateTriggerJobInput,
  CreateTriggerJobResult,
} from './triggerJobService.js';
import type { DevJobSource, DevRepo, RunnerBackendKind } from '../types.js';

/** Lower bound on the effective poll interval, in seconds (spec §4). */
export const MIN_TRACKER_POLL_INTERVAL_S = 60;
/** Default page size for a tracker listing. */
const DEFAULT_LIST_LIMIT = 100;
/** Default base scheduler tick when `start()` is used without an override. */
const DEFAULT_TICK_MS = 60_000;

/** Clamp a repo's configured interval to the floor (spec §4). */
export function effectivePollIntervalS(intervalS: number): number {
  const n = Math.trunc(intervalS);
  if (!Number.isFinite(n) || n < MIN_TRACKER_POLL_INTERVAL_S) {
    return MIN_TRACKER_POLL_INTERVAL_S;
  }
  return n;
}

/** One pollable repo plus the poll state the loop needs (from `dev_repos`). */
export interface TrackerPollRepoRow {
  repo: DevRepo;
  /** `dev_repos.tracker_poll_interval_s` (default 300). */
  pollIntervalS: number;
  /** `dev_repos.tracker_poll_cursor` as ISO-8601, or null when never polled. */
  pollCursor: string | null;
}

/** The persistence seam the poller needs. Concrete pg impl below; tests fake it. */
export interface TrackerPollStore {
  /** Repos with a tracker binding AND `'tracker' ∈ allowed_triggers`, with poll
   *  state. */
  listPollableRepos(): Promise<TrackerPollRepoRow[]>;
  /** Advance the poll cursor FORWARD to `iso` (a no-op if already at/after it). */
  advancePollCursor(repoId: string, iso: string): Promise<void>;
}

type TimerHandle = ReturnType<typeof setTimeout>;

export interface TrackerPollerDeps {
  store: TrackerPollStore;
  /** Resolve a repo's tracker (W3 `TrackerRegistry.resolveTrackerForRepo`). */
  resolveTracker: (repo: DevRepo) => Promise<DevPlatformTracker | null>;
  /** Non-terminal active-job probe (`hasActiveTriggerJob`, source='tracker'). */
  hasActiveJob: (repoId: string, sourceRef: string, source: DevJobSource) => Promise<boolean>;
  /** The structural-policy job-creation seam (`createTriggerJob`). */
  createTriggerJob: (input: CreateTriggerJobInput) => Promise<CreateTriggerJobResult>;
  /** Mint the one-time runner token; only the hash is persisted. */
  mintRunnerToken: () => { token: string; hash: string };
  /** Backend assigned to tracker jobs. `'local'` is structurally refused by the
   *  job service — never selected in production. */
  trackerBackend: RunnerBackendKind;
  /** Page size per tracker listing (default 100). */
  listLimit?: number;
  /** Base scheduler tick for `start()` (default 60s). Per-repo intervals still
   *  gate individual polls; this is only how often the sweep wakes. */
  tickMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (t: TimerHandle) => void;
  log?: (msg: string) => void;
}

export interface TrackerPoller {
  /** Sweep every due repo exactly once. Safe to call directly (tests do). */
  pollOnce(): Promise<void>;
  /** Begin the periodic sweep. Idempotent. */
  start(): void;
  /** Stop the periodic sweep. Idempotent. */
  stop(): void;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createTrackerPoller(deps: TrackerPollerDeps): TrackerPoller {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t));
  const listLimit = deps.listLimit ?? DEFAULT_LIST_LIMIT;
  const tickMs = deps.tickMs ?? DEFAULT_TICK_MS;

  /** Wall-clock ms of the last poll attempt per repo — the per-repo interval gate
   *  and the tracker-error backoff. In-memory only: a restart re-polls
   *  immediately, and the cursor + active-job dedupe keep that from duplicating
   *  jobs. */
  const lastPolledAt = new Map<string, number>();

  let timer: TimerHandle | null = null;
  let sweepInFlight = false;
  let stopped = false;

  async function pollRepo(row: TrackerPollRepoRow): Promise<void> {
    const { repo } = row;
    const tracker = await deps.resolveTracker(repo);
    if (!tracker) {
      log(`[tracker-poll] no tracker bound for ${repo.owner}/${repo.name}`);
      return;
    }

    let tickets: Ticket[];
    try {
      tickets = await tracker.listOpenTickets({ limit: listLimit, label: repo.triggerLabel });
    } catch (err) {
      // Backoff WITHOUT advancing the cursor — never skip a ticket over an error.
      log(`[tracker-poll] list failed for ${repo.owner}/${repo.name}: ${errMessage(err)}`);
      return;
    }

    const cursorMs = row.pollCursor ? Date.parse(row.pollCursor) : NaN;
    const hasCursor = Number.isFinite(cursorMs);
    let maxUpdatedMs = hasCursor ? cursorMs : 0;
    let sawUpdated = false;

    for (const ticket of tickets) {
      const updatedMs = ticket.updatedAt ? Date.parse(ticket.updatedAt) : NaN;
      const updatedValid = Number.isFinite(updatedMs);

      // Cursor filter: a ticket updated at/before the cursor was already processed.
      if (hasCursor && updatedValid && updatedMs <= cursorMs) continue;

      const sourceRef = `${repo.owner}/${repo.name}#${String(ticket.number)}`;
      if (await deps.hasActiveJob(repo.id, sourceRef, 'tracker')) {
        log(`[tracker-poll] active job exists for ${sourceRef} — deduped`);
      } else {
        const minted = deps.mintRunnerToken();
        const result = await deps.createTriggerJob({
          repo,
          backend: deps.trackerBackend,
          kind: 'fix_issue',
          brief: `${ticket.title}\n\n${ticket.body}`,
          sourceRef,
          source: 'tracker',
          createdBy: 'tracker:poll',
          runnerTokenHash: minted.hash,
          // No (repo, sender) trust ledger exists for plugin trackers, so the
          // webhook first-source gate has no analogue here; structural refusals +
          // the W3 apply-gate remain the guards (spec §4 lists only the refusals).
          requireGate: false,
          senderLogin: ticket.authorLogin || undefined,
        });
        if (result.decision === 'refused_policy') {
          log(`[tracker-poll] ${sourceRef} refused_policy: ${result.reason ?? ''}`);
        } else if (result.decision === 'deduped_active_job') {
          log(`[tracker-poll] ${sourceRef} deduped (unique index)`);
        } else {
          log(`[tracker-poll] job ${result.job?.id ?? '?'} created for ${sourceRef}`);
        }
      }

      if (updatedValid) {
        maxUpdatedMs = Math.max(maxUpdatedMs, updatedMs);
        sawUpdated = true;
      }
    }

    // Advance the cursor forward only, to the newest update we processed.
    if (sawUpdated && maxUpdatedMs > (hasCursor ? cursorMs : 0)) {
      await deps.store.advancePollCursor(repo.id, new Date(maxUpdatedMs).toISOString());
    }
  }

  async function pollOnce(): Promise<void> {
    const rows = await deps.store.listPollableRepos();
    const t = now();
    for (const row of rows) {
      // Defence in depth: the store filters, but never poll a repo that opted out.
      if (!row.repo.allowedTriggers.includes('tracker')) continue;
      const intervalMs = effectivePollIntervalS(row.pollIntervalS) * 1000;
      const last = lastPolledAt.get(row.repo.id) ?? 0;
      if (t - last < intervalMs) continue;
      // Stamp BEFORE the async poll so a slow tracker can't be re-entered next tick.
      lastPolledAt.set(row.repo.id, t);
      await pollRepo(row);
    }
  }

  function scheduleNext(): void {
    if (stopped) return;
    timer = setTimer(() => {
      void tick();
    }, tickMs);
  }

  async function tick(): Promise<void> {
    if (stopped || sweepInFlight) {
      scheduleNext();
      return;
    }
    sweepInFlight = true;
    try {
      await pollOnce();
    } catch (err) {
      log(`[tracker-poll] sweep failed: ${errMessage(err)}`);
    } finally {
      sweepInFlight = false;
      scheduleNext();
    }
  }

  function start(): void {
    if (timer || stopped) return;
    scheduleNext();
  }

  function stop(): void {
    stopped = true;
    if (timer) {
      clearTimer(timer);
      timer = null;
    }
  }

  return { pollOnce, start, stop };
}

/**
 * Concrete `TrackerPollStore` over Postgres. Reads the poll columns added in 0027
 * (`tracker_poll_interval_s`, `tracker_poll_cursor`) directly — they are not on
 * the `DevRepo` view — and hydrates the full repo via the injected `DevRepoStore`.
 */
export class PgTrackerPollStore implements TrackerPollStore {
  constructor(
    private readonly pool: Pool,
    private readonly repos: { getRepo(id: string): Promise<DevRepo | null> },
  ) {}

  async listPollableRepos(): Promise<TrackerPollRepoRow[]> {
    const r = await this.pool.query<{
      id: string;
      tracker_poll_interval_s: number | string;
      tracker_poll_cursor: Date | string | null;
    }>(
      `SELECT id, tracker_poll_interval_s, tracker_poll_cursor
         FROM dev_repos
        WHERE 'tracker' = ANY(allowed_triggers)
          AND (tracker_kind IS NOT NULL OR credential_kind = 'github_app')`,
    );
    const rows: TrackerPollRepoRow[] = [];
    for (const row of r.rows) {
      const repo = await this.repos.getRepo(row.id);
      if (!repo) continue;
      const cursor = row.tracker_poll_cursor;
      rows.push({
        repo,
        pollIntervalS: Number(row.tracker_poll_interval_s),
        pollCursor: cursor == null ? null : new Date(cursor as string | Date).toISOString(),
      });
    }
    return rows;
  }

  async advancePollCursor(repoId: string, iso: string): Promise<void> {
    await this.pool.query(
      `UPDATE dev_repos
          SET tracker_poll_cursor = $2, updated_at = now()
        WHERE id = $1
          AND (tracker_poll_cursor IS NULL OR tracker_poll_cursor < $2)`,
      [repoId, iso],
    );
  }
}
