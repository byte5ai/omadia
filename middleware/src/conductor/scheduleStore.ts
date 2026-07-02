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
}

interface ScheduleRow {
  id: string;
  workflow_id: string;
  workflow_slug: string;
  workflow_status: 'enabled' | 'disabled';
  cron: string;
  timezone: string;
}

/**
 * Persistence for a workflow's cron schedules (`conductor_schedules`). Sibling of the Agent
 * Builder's `agent_schedules`, polled by ConductorScheduleWorker on the same minute tick
 * (resolved decision #2). UTC-only, matching `cronMatches` (timezone is a future enhancement).
 */
export class ConductorScheduleStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Reconcile a workflow's schedules to match the cron triggers in its published graph.
   * Replace-all (a workflow has few cron triggers): drop the old rows, insert the current
   * valid ones. Invalid cron expressions are skipped (the graph validator does not yet lint cron).
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
    await client.query('DELETE FROM conductor_schedules WHERE workflow_id = $1', [workflowId]);
    for (const cron of crons) {
      await client.query(
        `INSERT INTO conductor_schedules (workflow_id, cron, status) VALUES ($1, $2, 'enabled')`,
        [workflowId, cron],
      );
    }
  }

  /** All enabled schedules joined to their workflow (slug + status), for the worker tick. */
  async listEnabled(): Promise<ConductorSchedule[]> {
    const r = await this.pool.query<ScheduleRow>(
      `SELECT s.id, s.workflow_id, w.slug AS workflow_slug, w.status AS workflow_status,
              s.cron, s.timezone
         FROM conductor_schedules s
         JOIN conductor_workflows w ON w.id = s.workflow_id
        WHERE s.status = 'enabled'`,
    );
    return r.rows.map((row) => ({
      id: row.id,
      workflowId: row.workflow_id,
      workflowSlug: row.workflow_slug,
      workflowEnabled: row.workflow_status === 'enabled',
      cron: row.cron,
      timezone: row.timezone,
    }));
  }

  /**
   * Atomically claim this schedule's slot for the given minute. `last_run_at` advances to now()
   * only if it was unset or in a prior minute, so a cron fires at most once per minute even
   * across restarts and multiple replicas. Returns true iff this caller won the slot.
   */
  async claimRun(scheduleId: string, claimedBy: string): Promise<boolean> {
    // The minute slot is computed entirely from the DB clock (`date_trunc('minute', now())`) on BOTH
    // the compare and the write, so replica/app clock skew can never let two callers win the same
    // minute (mixing app-time in WHERE with now() in SET would). First winner advances last_run_at
    // to this minute; every other caller that minute then matches 0 rows.
    const r = await this.pool.query(
      `UPDATE conductor_schedules
          SET last_run_at = date_trunc('minute', now()), claimed_by = $2, claimed_at = now()
        WHERE id = $1
          AND (last_run_at IS NULL OR last_run_at < date_trunc('minute', now()))`,
      [scheduleId, claimedBy],
    );
    return (r.rowCount ?? 0) > 0;
  }
}
