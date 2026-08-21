// Persistence for the ephemeral-workflow lifecycle (#330 Workstream A):
// guardrail counters, the reapable-row query, and the two removal shapes.
// "Removal" is logical by default (disable + reaped_at — the run history and
// version graph stay as audit trace); a physical DELETE happens only for rows
// no run references (a failed start left them behind), which the versions
// FK cascades while conductor_runs.workflow_version_id (RESTRICT) guarantees
// referenced rows can never be deleted by accident.

import type { Pool } from 'pg';

export interface ReapableWorkflow {
  id: string;
  slug: string;
  /** true when the TTL elapsed — active runs get a cancel request before the reap. */
  expired: boolean;
}

export class ConductorEphemeralStore {
  constructor(private readonly pool: Pool) {}

  /** Active (running/waiting) runs across all ephemeral workflows this agent created. */
  async countActiveRunsByAgent(agentId: string): Promise<number> {
    const r = await this.pool.query<{ count: string }>(
      `SELECT count(*) AS count
         FROM conductor_runs r
         JOIN conductor_workflow_versions v ON r.workflow_version_id = v.id
         JOIN conductor_workflows w ON v.workflow_id = w.id
        WHERE w.origin = 'ephemeral'
          AND w.created_by_agent = $1
          AND r.status IN ('running', 'waiting')`,
      [agentId],
    );
    return Number(r.rows[0]?.count ?? 0);
  }

  /** Ephemeral workflows this agent created since `cutoff` (rate-limit window). */
  async countRecentCreatesByAgent(agentId: string, cutoff: Date): Promise<number> {
    const r = await this.pool.query<{ count: string }>(
      `SELECT count(*) AS count
         FROM conductor_workflows
        WHERE origin = 'ephemeral'
          AND created_by_agent = $1
          AND created_at > $2`,
      [agentId, cutoff],
    );
    return Number(r.rows[0]?.count ?? 0);
  }

  /**
   * Un-reaped ephemeral workflows due for removal: TTL elapsed, OR every run
   * reached a terminal state (at least one run must exist — a freshly created
   * workflow whose start is still in flight is not reapable before its TTL).
   */
  async listReapable(now: Date): Promise<ReapableWorkflow[]> {
    const r = await this.pool.query<{ id: string; slug: string; expired: boolean }>(
      `SELECT w.id, w.slug, (w.expires_at <= $1) AS expired
         FROM conductor_workflows w
        WHERE w.origin = 'ephemeral'
          AND w.reaped_at IS NULL
          AND (
            w.expires_at <= $1
            OR (
              EXISTS (
                SELECT 1 FROM conductor_workflow_versions v
                  JOIN conductor_runs r ON r.workflow_version_id = v.id
                 WHERE v.workflow_id = w.id
              )
              AND NOT EXISTS (
                SELECT 1 FROM conductor_workflow_versions v
                  JOIN conductor_runs r ON r.workflow_version_id = v.id
                 WHERE v.workflow_id = w.id
                   AND r.status IN ('running', 'waiting')
              )
            )
          )`,
      [now],
    );
    return r.rows.map((row) => ({ id: row.id, slug: row.slug, expired: row.expired }));
  }

  /**
   * #759 cancel-request for every still-active run of the workflow — the driver
   * honours it at the next step boundary; a 'waiting' run cancels immediately.
   * Idempotent: rows that already carry a request are left untouched.
   */
  async requestCancelActiveRuns(workflowId: string, requestedBy: string): Promise<number> {
    const r = await this.pool.query(
      `UPDATE conductor_runs
          SET cancel_requested_by = $2, cancel_requested_at = now()
        WHERE workflow_version_id IN (
                SELECT id FROM conductor_workflow_versions WHERE workflow_id = $1
              )
          AND status IN ('running', 'waiting')
          AND cancel_requested_at IS NULL`,
      [workflowId, requestedBy],
    );
    return r.rowCount ?? 0;
  }

  /** Logical removal: not startable (disabled), never listed (origin filter),
   *  stamped `reaped_at`. Idempotent — a reaped row is never re-stamped. */
  async markReaped(workflowId: string): Promise<void> {
    await this.pool.query(
      `UPDATE conductor_workflows
          SET status = 'disabled', reaped_at = now(), updated_at = now()
        WHERE id = $1 AND origin = 'ephemeral' AND reaped_at IS NULL`,
      [workflowId],
    );
  }

  /**
   * Physical removal, guarded: only an ephemeral workflow no run references
   * (versions cascade with it). Referenced rows stay — discard the scaffold,
   * never the minutes.
   */
  async hardDeleteUnreferenced(workflowId: string): Promise<boolean> {
    const r = await this.pool.query(
      `DELETE FROM conductor_workflows w
        WHERE w.id = $1
          AND w.origin = 'ephemeral'
          AND NOT EXISTS (
            SELECT 1 FROM conductor_workflow_versions v
              JOIN conductor_runs r ON r.workflow_version_id = v.id
             WHERE v.workflow_id = w.id
          )`,
      [workflowId],
    );
    return (r.rowCount ?? 0) > 0;
  }
}
