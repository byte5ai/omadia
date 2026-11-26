import type { Pool, PoolClient } from 'pg';
import type { WorkflowGraph } from '@omadia/conductor-core';

import { isValidCron } from '../scheduler/cron.js';

export interface ConductorSchedule {
  id: string;
  workflowId: string;
  workflowSlug: string;
  /** The workflow header's status — a cron only fires while its workflow is enabled. */
  workflowEnabled: boolean;
  cron: string;
  timezone: string;
  lastCheckedAt: Date;
  pollMinute: Date;
  lastRunAt: Date | null;
}

interface ScheduleRow {
  id: string;
  workflow_id: string;
  workflow_slug: string;
  workflow_status: 'enabled' | 'disabled';
  cron: string;
  timezone: string;
  last_checked_at: Date;
  poll_minute: Date;
  last_run_at: Date | null;
}

/**
 * Persistence for a workflow's cron schedules (`conductor_schedules`). Sibling of the Agent
 * Builder's `agent_schedules`, polled by ConductorScheduleWorker on the same minute tick
 * (resolved decision #2).
 */
export class ConductorScheduleStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Reconcile a workflow's schedules to match the cron triggers in its published graph.
   * Keep matching rows so their time zones and poll history survive a republish.
   */
  async reconcile(workflowId: string, graph: WorkflowGraph): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.reconcileOnClient(client, workflowId, graph);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * The reconcile body on a caller-supplied client — lets `createOrPublish` run it INSIDE its own
   * transaction so the new version and its cron schedules commit atomically. Without this, a failed
   * reconcile after a committed publish would leave stale `conductor_schedules` firing forever
   * (e.g. an operator removing a cron trigger but the reconcile rolling back).
   */
  async reconcileOnClient(client: PoolClient, workflowId: string, graph: WorkflowGraph): Promise<void> {
    // De-duplicate identical expressions so two equal cron triggers don't double-fire each minute.
    const crons = [
      ...new Set(
        (graph.triggers ?? [])
          .filter((t) => t.kind === 'cron' && typeof t.cron === 'string' && isValidCron(t.cron))
          .map((t) => t.cron!.trim()),
      ),
    ];
    await client.query(
      'DELETE FROM conductor_schedules WHERE workflow_id = $1 AND NOT (btrim(cron) = ANY($2::text[]))',
      [workflowId, crons],
    );
    for (const cron of crons) {
      await client.query(
        `INSERT INTO conductor_schedules (workflow_id, cron, status)
         SELECT $1, $2, 'enabled'
          WHERE NOT EXISTS (SELECT 1 FROM conductor_schedules WHERE workflow_id = $1 AND btrim(cron) = $2)`,
        [workflowId, cron],
      );
    }
  }

  async listForWorkflow(workflowId: string): Promise<Array<{ cron: string; timezone: string }>> {
    const { rows } = await this.pool.query<{ cron: string; timezone: string }>(
      'SELECT cron, timezone FROM conductor_schedules WHERE workflow_id = $1 ORDER BY created_at, id',
      [workflowId],
    );
    return rows;
  }

  /** Disabled schedules are also inspected so due slots have a suppression record. */
  async listForPoll(): Promise<ConductorSchedule[]> {
    const r = await this.pool.query<ScheduleRow>(
      `SELECT s.id, s.workflow_id, w.slug AS workflow_slug,
              CASE WHEN s.status = 'enabled' THEN w.status ELSE 'disabled' END AS workflow_status,
              s.cron, s.timezone, s.last_checked_at, s.last_run_at,
              date_trunc('minute', statement_timestamp()) AS poll_minute
         FROM conductor_schedules s
         JOIN conductor_workflows w ON w.id = s.workflow_id
        WHERE w.reaped_at IS NULL
          AND s.last_checked_at < date_trunc('minute', statement_timestamp())`,
    );
    return r.rows.map((row) => ({
      id: row.id,
      workflowId: row.workflow_id,
      workflowSlug: row.workflow_slug,
      workflowEnabled: row.workflow_status === 'enabled',
      cron: row.cron,
      timezone: row.timezone,
      lastCheckedAt: row.last_checked_at,
      pollMinute: row.poll_minute,
      lastRunAt: row.last_run_at,
    }));
  }

  /**
   * Compare and advance the inspection cursor. When a run is due, also advance
   * its dispatch claim in the same write. DB time is authoritative for both.
   */
  async claimPoll(schedule: ConductorSchedule, claimedBy: string, willFire: boolean): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE conductor_schedules
          SET last_checked_at = $3,
              last_run_at = CASE WHEN $5 THEN $3 ELSE last_run_at END,
              claimed_by = CASE WHEN $5 THEN $2 ELSE claimed_by END,
              claimed_at = CASE WHEN $5 THEN statement_timestamp() ELSE claimed_at END
        WHERE id = $1
          AND $3 = date_trunc('minute', statement_timestamp())
          AND last_checked_at = $4
          AND last_checked_at < $3
          AND (NOT $5 OR last_run_at IS NULL OR last_run_at < $3)`,
      [schedule.id, claimedBy, schedule.pollMinute, schedule.lastCheckedAt, willFire],
    );
    return (r.rowCount ?? 0) > 0;
  }
}
