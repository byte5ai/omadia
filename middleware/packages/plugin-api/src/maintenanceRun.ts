/**
 * Spec 2042 §5.10 — a maintenance run of the model gateway.
 *
 * A job that keeps an index current (an embedding backfill, a re-index) runs
 * its model calls as a maintenance run: charged to the instance's
 * maintenance budget, bounded by a budget and a deadline per run, and only
 * ever `embed` — a `complete` or `transcribe` inside it is refused. It never
 * posts to people.
 *
 * Published by the kernel as `maintenanceRun@1`; declare it under
 * `optional_requires` and resolve it when the work runs (kernel services are
 * published after plugins activate at boot).
 */
export interface MaintenanceRunService {
  /**
   * Run `work` as one maintenance run named `name` (e.g. `embedding_backfill`).
   * Rejects when the instance's daily maintenance budget is used up; every
   * model call inside `work` beyond the run's budget or deadline is refused.
   */
  run<T>(name: string, work: () => Promise<T>): Promise<T>;
}

export const MAINTENANCE_RUN_SERVICE_NAME = 'maintenanceRun';
