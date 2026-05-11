import type { Pool } from 'pg';

import type {
  NudgeEmissionRecord,
  NudgeStateRecord,
  NudgeStateStore,
} from '@omadia/plugin-api';
import {
  NUDGE_REGRESSION_AFTER_MISSES,
  NUDGE_RETIRE_AFTER_STREAK,
  NUDGE_SUPPRESS_DEFAULT_DAYS,
} from '@omadia/plugin-api';

/**
 * @omadia/knowledge-graph-neon — NeonNudgeStateStore (Palaia Phase 8 /
 * OB-77 Slice 2).
 *
 * Tenant-scoped Pool-backed Implementation der `nudgeStateStore@1`-Capability.
 * Eine Row pro (tenant, agent, nudge_id) — siehe Migration 0010.
 *
 * Hot-Paths:
 *  - `read` — pipeline pre-call probe (suppress/retire short-circuit).
 *  - `recordEmission` — INSERT into nudge_emissions + UPSERT nudge_state row
 *    in one round-trip (single CTE).
 *  - `recordFollow` — increment success_streak, mark most-recent unfollowed
 *    emission as followed, set retired_at when streak hits the threshold.
 *  - `recordRegression` — increment regression_count + suppress when the
 *    threshold is hit (suppress for `NUDGE_SUPPRESS_DEFAULT_DAYS`).
 */

interface NudgeStateRow {
  agent_id: string;
  nudge_id: string;
  success_streak: number | string;
  regression_count: number | string;
  suppressed_until: Date | string | null;
  retired_at: Date | string | null;
  last_emitted_at: Date | string | null;
  last_followed_at: Date | string | null;
}

export interface NeonNudgeStateStoreOptions {
  pool: Pool;
  tenantId: string;
}

function toDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

function rowToRecord(row: NudgeStateRow): NudgeStateRecord {
  return {
    agentId: row.agent_id,
    nudgeId: row.nudge_id,
    successStreak: Number(row.success_streak),
    regressionCount: Number(row.regression_count),
    suppressedUntil: toDate(row.suppressed_until),
    retiredAt: toDate(row.retired_at),
    lastEmittedAt: toDate(row.last_emitted_at),
    lastFollowedAt: toDate(row.last_followed_at),
  };
}

export class NeonNudgeStateStore implements NudgeStateStore {
  private readonly pool: Pool;
  private readonly tenantId: string;

  constructor(opts: NeonNudgeStateStoreOptions) {
    this.pool = opts.pool;
    this.tenantId = opts.tenantId;
  }

  async read(
    agentId: string,
    nudgeId: string,
  ): Promise<NudgeStateRecord | null> {
    const result = await this.pool.query<NudgeStateRow>(
      `
      SELECT agent_id, nudge_id,
             success_streak, regression_count,
             suppressed_until, retired_at,
             last_emitted_at, last_followed_at
        FROM nudge_state
       WHERE tenant_id = $1
         AND agent_id  = $2
         AND nudge_id  = $3
       LIMIT 1
      `,
      [this.tenantId, agentId, nudgeId],
    );
    const row = result.rows[0];
    return row ? rowToRecord(row) : null;
  }

  async recordEmission(record: NudgeEmissionRecord): Promise<void> {
    const ctaJson = record.cta ? JSON.stringify(record.cta) : null;
    const successJson: string | null = null;
    await this.pool.query(
      `
      WITH inserted AS (
        INSERT INTO nudge_emissions (
          tenant_id, agent_id, nudge_id, turn_id, tool_name,
          workflow_hash, hint_text, cta_json, success_signal_json
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)
        RETURNING emitted_at
      )
      INSERT INTO nudge_state (
        tenant_id, agent_id, nudge_id, last_emitted_at, updated_at
      )
      SELECT $1, $2, $3, emitted_at, NOW() FROM inserted
      ON CONFLICT (tenant_id, agent_id, nudge_id) DO UPDATE SET
        last_emitted_at = EXCLUDED.last_emitted_at,
        updated_at      = NOW()
      `,
      [
        this.tenantId,
        record.agentId,
        record.nudgeId,
        record.turnId,
        record.toolName,
        record.workflowHash ?? null,
        record.hintText,
        ctaJson,
        successJson,
      ],
    );
  }

  async recordFollow(
    agentId: string,
    nudgeId: string,
    turnId: string,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Mark the most recent unfollowed emission for this (agent, nudge_id)
      // as followed. When no open emission exists (e.g. follow detected
      // outside the soft window) we still bump the streak — the agent
      // demonstrated the desired behaviour, just without a tracked emit.
      await client.query(
        `
        UPDATE nudge_emissions
           SET followed_at = NOW(),
               follow_turn_id = $4
         WHERE id = (
           SELECT id FROM nudge_emissions
            WHERE tenant_id = $1
              AND agent_id  = $2
              AND nudge_id  = $3
              AND followed_at IS NULL
              AND regression_at IS NULL
            ORDER BY emitted_at DESC
            LIMIT 1
         )
        `,
        [this.tenantId, agentId, nudgeId, turnId],
      );

      // Bump streak, reset regression, set retired_at when threshold reached.
      await client.query(
        `
        INSERT INTO nudge_state (
          tenant_id, agent_id, nudge_id,
          success_streak, regression_count, last_followed_at, updated_at
        ) VALUES ($1, $2, $3, 1, 0, NOW(), NOW())
        ON CONFLICT (tenant_id, agent_id, nudge_id) DO UPDATE SET
          success_streak    = nudge_state.success_streak + 1,
          regression_count  = 0,
          last_followed_at  = NOW(),
          retired_at        = CASE
            WHEN nudge_state.success_streak + 1 >= $4 THEN NOW()
            ELSE nudge_state.retired_at
          END,
          updated_at        = NOW()
        `,
        [this.tenantId, agentId, nudgeId, NUDGE_RETIRE_AFTER_STREAK],
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async recordRegression(agentId: string, nudgeId: string): Promise<void> {
    const suppressUntil = new Date(
      Date.now() + NUDGE_SUPPRESS_DEFAULT_DAYS * 24 * 60 * 60 * 1000,
    );
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Mark the open emission as regressed. Same defensive lookup as
      // recordFollow — no-op when there's nothing to mark.
      await client.query(
        `
        UPDATE nudge_emissions
           SET regression_at = NOW()
         WHERE id = (
           SELECT id FROM nudge_emissions
            WHERE tenant_id = $1
              AND agent_id  = $2
              AND nudge_id  = $3
              AND followed_at IS NULL
              AND regression_at IS NULL
            ORDER BY emitted_at DESC
            LIMIT 1
         )
        `,
        [this.tenantId, agentId, nudgeId],
      );

      // Bump regression. When the count hits the threshold, suppress for
      // `NUDGE_SUPPRESS_DEFAULT_DAYS` so we stop badgering the agent — the
      // operator can also unsuppress via the admin UI later.
      await client.query(
        `
        INSERT INTO nudge_state (
          tenant_id, agent_id, nudge_id,
          success_streak, regression_count, updated_at
        ) VALUES ($1, $2, $3, 0, 1, NOW())
        ON CONFLICT (tenant_id, agent_id, nudge_id) DO UPDATE SET
          regression_count  = nudge_state.regression_count + 1,
          suppressed_until  = CASE
            WHEN nudge_state.regression_count + 1 >= $4 THEN $5::timestamptz
            ELSE nudge_state.suppressed_until
          END,
          updated_at        = NOW()
        `,
        [
          this.tenantId,
          agentId,
          nudgeId,
          NUDGE_REGRESSION_AFTER_MISSES,
          suppressUntil.toISOString(),
        ],
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async suppress(agentId: string, nudgeId: string, until: Date): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO nudge_state (
        tenant_id, agent_id, nudge_id, suppressed_until, updated_at
      ) VALUES ($1, $2, $3, $4::timestamptz, NOW())
      ON CONFLICT (tenant_id, agent_id, nudge_id) DO UPDATE SET
        suppressed_until = EXCLUDED.suppressed_until,
        updated_at       = NOW()
      `,
      [this.tenantId, agentId, nudgeId, until.toISOString()],
    );
  }
}
