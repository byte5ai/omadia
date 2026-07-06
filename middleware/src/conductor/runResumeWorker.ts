import { randomUUID } from 'node:crypto';

import type { ConductorRunStore } from './runStore.js';
import type { ConductorRunExecutor } from './runExecutor.js';

// Resume-safety invariant: this MUST stay strictly greater than RealStepEffects' DEFAULT_STEP_TIMEOUT_MS
// so a live step always settles before its run could be claimed as stale. A test asserts the ordering.
export const DEFAULT_RESUME_STALE_MS = 900_000; // 15 min

/**
 * Re-drives runs left 'running' by a process restart (US2 / SC-002). A run is driven
 * in-process by the executor; if the process dies mid-drive, nothing re-drives it — the
 * row just stays 'running' forever. This worker is the authoritative resume path
 * (per plan §7-E: reconcile is the source of truth, LISTEN/NOTIFY is only an optimisation,
 * and it is disabled by default here).
 *
 * Two guarantees keep it from racing a LIVE drive:
 *   1. Heartbeat + staleness. Every step a live drive records refreshes `conductor_runs.claimed_at`.
 *      This worker claims only rows whose heartbeat is older than `staleMs`. `staleMs` MUST be set
 *      comfortably larger than the orchestrator's hard per-turn wall-clock cap (a single agent step
 *      is otherwise unbounded), so an actively-driven run is never mistaken for orphaned.
 *   2. Lease fencing. The claim stamps a fresh per-tick lease onto `claimed_by`; the executor fences
 *      every step write on that token. If a stalled live drive is nonetheless claimed, its next write
 *      throws RunLeaseLostError and it stops — the new owner drives on. RealStepEffects additionally
 *      enforces a per-step hard timeout (`stepTimeoutMs`) strictly < `staleMs`, so a step always settles
 *      (or fails) before its run could be claimed — closing the last single-step at-least-once window.
 *
 * graphPool-gated by the caller, like the await worker.
 */
export class ConductorRunResumeWorker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  /** Runs this worker is currently re-driving — never claim/drive the same run twice at once. */
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly deps: {
      runStore: ConductorRunStore;
      executor: ConductorRunExecutor;
      /** Per-boot id for log attribution (the fencing token is a fresh per-tick lease, not this). */
      claimerId?: string;
      intervalMs?: number;
      staleMs?: number;
      /** Max runs driven concurrently by this worker. */
      maxConcurrent?: number;
      log?: (msg: string) => void;
    },
  ) {}

  start(): void {
    if (this.timer) return;
    const interval = this.deps.intervalMs ?? 60_000;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), interval);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    this.deps.log?.('[conductor] run-resume worker started (orphaned-run reconcile)');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async tick(): Promise<void> {
    if (this.ticking) return; // never let two ticks overlap
    this.ticking = true;
    try {
      const staleMs = this.deps.staleMs ?? DEFAULT_RESUME_STALE_MS; // 15 min ≫ any single orchestrator turn
      const maxConcurrent = this.deps.maxConcurrent ?? 20;
      const slots = maxConcurrent - this.inFlight.size;
      if (slots <= 0) return; // already saturated; let in-flight drives finish first

      const lease = randomUUID(); // fresh lease per tick — fences the runs claimed this round
      let claimed;
      try {
        claimed = await this.deps.runStore.claimResumableRuns(lease, staleMs, slots);
      } catch (err) {
        this.deps.log?.(`[conductor] resume worker claim failed: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      for (const run of claimed) {
        if (this.inFlight.has(run.id)) continue; // defensive: a previous tick still driving it
        this.inFlight.add(run.id);
        this.deps.log?.(`[conductor] resuming orphaned run ${run.id} at step '${run.currentStepId ?? '?'}'`);
        // Fire-and-forget: a drive can take a while (real agent turns). The lease + heartbeat
        // protect it from re-claim; the in-flight set bounds concurrency. Errors are logged, never thrown.
        void this.deps.executor
          .resumeRun(run.id, lease)
          .catch((err) => {
            this.deps.log?.(`[conductor] resume run ${run.id} failed: ${err instanceof Error ? err.message : String(err)}`);
          })
          .finally(() => {
            this.inFlight.delete(run.id);
          });
      }
    } finally {
      this.ticking = false;
    }
  }
}
