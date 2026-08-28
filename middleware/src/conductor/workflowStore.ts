import type { Pool, PoolClient } from 'pg';
import type { WorkflowGraph } from '@omadia/conductor-core';

export interface ConductorWorkflow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  status: 'enabled' | 'disabled';
  activeVersionId: string | null;
  /** Template provenance (#478): which template manifest (id + version) this
   *  workflow was instantiated from. Informational only — copy-not-reference
   *  stands, the columns power the "template updated" hint, never execution.
   *  Optional so pre-#478 fakes/fixtures keep typechecking; null when the
   *  workflow was not instantiated from a template. */
  templateId?: string | null;
  templateVersion?: number | null;
  /** #330 — 'manual' = user-authored library entry, 'ephemeral' = agent-generated
   *  JIT instance of a curated pattern. Optional so pre-#330 fakes/fixtures keep
   *  typechecking; absent reads as 'manual'. */
  origin?: 'manual' | 'ephemeral';
  /** #330 — mandatory TTL for ephemeral workflows (CHECK-enforced); null on manual. */
  expiresAt?: Date | null;
  /** #330 — the agent that generated an ephemeral workflow; null on manual. */
  createdByAgent?: string | null;
  /** #330 — set when the reaper logically removed the definition (disabled +
   *  hidden). The run history and version graph are retained as audit trace. */
  reapedAt?: Date | null;
}

export interface ConductorVersion {
  id: string;
  workflowId: string;
  version: number;
  graph: WorkflowGraph;
}

interface WorkflowRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  status: 'enabled' | 'disabled';
  active_version_id: string | null;
  template_id: string | null;
  template_version: number | null;
  origin: 'manual' | 'ephemeral';
  expires_at: Date | null;
  created_by_agent: string | null;
  reaped_at: Date | null;
}

interface VersionRow {
  id: string;
  workflow_id: string;
  version: number;
  graph: WorkflowGraph;
}

/** Thrown by createOrPublish({ expectNew: true }) when the slug is already taken. The
 *  conflict is detected by the INSERT itself (ON CONFLICT DO NOTHING), so two racing
 *  creates of the same fresh slug can never both publish -- no pre-check involved. */
export class WorkflowSlugExistsError extends Error {
  constructor(readonly slug: string) {
    super(`a workflow with slug '${slug}' already exists`);
    this.name = 'WorkflowSlugExistsError';
  }
}

function toWorkflow(r: WorkflowRow): ConductorWorkflow {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    description: r.description,
    status: r.status,
    activeVersionId: r.active_version_id,
    templateId: r.template_id,
    templateVersion: r.template_version,
    origin: r.origin,
    expiresAt: r.expires_at,
    createdByAgent: r.created_by_agent,
    reapedAt: r.reaped_at,
  };
}

const WORKFLOW_COLS = 'id, slug, name, description, status, active_version_id, template_id, template_version, origin, expires_at, created_by_agent, reaped_at';

/**
 * Persistence for workflow headers + immutable versions. A publish snapshots the
 * supplied graph into a new monotonic version and points `active_version_id` at it
 * (FR-027 — runs already in flight keep their version).
 */
export class ConductorWorkflowStore {
  constructor(private readonly pool: Pool) {}

  async getBySlug(slug: string): Promise<ConductorWorkflow | null> {
    const r = await this.pool.query<WorkflowRow>(
      `SELECT ${WORKFLOW_COLS} FROM conductor_workflows WHERE slug = $1`,
      [slug],
    );
    return r.rows[0] ? toWorkflow(r.rows[0]) : null;
  }

  async getById(id: string): Promise<ConductorWorkflow | null> {
    const r = await this.pool.query<WorkflowRow>(
      `SELECT ${WORKFLOW_COLS} FROM conductor_workflows WHERE id = $1`,
      [id],
    );
    return r.rows[0] ? toWorkflow(r.rows[0]) : null;
  }

  async list(): Promise<ConductorWorkflow[]> {
    // #330 — the library is the user-authored surface: ephemeral (agent-generated)
    // workflows never appear here, whatever their lifecycle state. Filtering in the
    // store covers both consumers at once — the library route stays clutter-free AND
    // the event router never event-triggers an ephemeral workflow: those are
    // run-scoped (exactly one run, started by createEphemeralRun), not standing
    // event subscribers. The reaped_at filter extends the same contract to deleted
    // manual workflows (operator DELETE, logical shape): hidden from the library and
    // never event-triggered again, while the row stays as audit trace.
    const r = await this.pool.query<WorkflowRow>(
      `SELECT ${WORKFLOW_COLS} FROM conductor_workflows WHERE origin = 'manual' AND reaped_at IS NULL ORDER BY created_at DESC`,
    );
    return r.rows.map(toWorkflow);
  }

  /** #330 round 4 — the operator lens over live facilitations: every not-yet-
   *  reaped ephemeral workflow. Deliberately a separate method: the library
   *  list() above stays user-authored-only by contract. */
  async listEphemeralActive(): Promise<ConductorWorkflow[]> {
    const r = await this.pool.query<WorkflowRow>(
      `SELECT ${WORKFLOW_COLS} FROM conductor_workflows WHERE origin = 'ephemeral' AND reaped_at IS NULL ORDER BY created_at DESC`,
    );
    return r.rows.map(toWorkflow);
  }

  async getVersion(versionId: string): Promise<ConductorVersion | null> {
    const r = await this.pool.query<VersionRow>(
      'SELECT id, workflow_id, version, graph FROM conductor_workflow_versions WHERE id = $1',
      [versionId],
    );
    const row = r.rows[0];
    return row ? { id: row.id, workflowId: row.workflow_id, version: row.version, graph: row.graph } : null;
  }

  /**
   * Create a workflow (if the slug is new) and publish `graph` as the next version,
   * setting it active. If the slug already exists, publishes a new version on it.
   * Returns the workflow plus the newly published version.
   */
  async createOrPublish(input: {
    slug: string;
    name: string;
    description?: string | null;
    graph: WorkflowGraph;
    publishedBy?: string | null;
    enable?: boolean;
    /** Create-only mode: throw WorkflowSlugExistsError when the slug already exists
     *  instead of publishing a new version onto it (the template-instantiate route's
     *  "create new" contract). Atomic -- the INSERT's conflict clause decides, not a
     *  racy SELECT-then-INSERT. Default (absent/false) keeps the idempotent upsert. */
    expectNew?: boolean;
    /** #330 — create-time provenance for ephemeral (agent-generated) workflows. Only
     *  honoured on first create (the conflict branch never rewrites origin); callers
     *  passing origin 'ephemeral' must pass expiresAt too (schema CHECK). */
    origin?: 'manual' | 'ephemeral';
    expiresAt?: Date | null;
    createdByAgent?: string | null;
    /** Runs inside the publish transaction after the version is set active — used to reconcile cron
     *  schedules atomically with the publish (a throw rolls the whole publish back, so a failed
     *  reconcile never leaves stale schedules behind). */
    onPublished?: (client: PoolClient, workflowId: string) => Promise<void>;
  }): Promise<{ workflow: ConductorWorkflow; version: ConductorVersion }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Idempotent upsert — race-safe under concurrent/double-submitted publishes of the
      // same slug (a SELECT-then-INSERT would let two requests both pass the check and one
      // hit the unique-constraint). Status is only set on first create, never changed here.
      // In expectNew mode the conflict clause flips to DO NOTHING: zero returned rows
      // means the slug is taken and the publish aborts with WorkflowSlugExistsError.
      // The DO UPDATE's reaped_at guard makes a deleted slug behave like a taken
      // one (zero returned rows → WorkflowSlugExistsError): publishing must not
      // silently resurrect a logically removed workflow — it would stay hidden
      // (reaped_at set) while collecting versions and cron schedules.
      const conflictClause = input.expectNew
        ? 'ON CONFLICT (slug) DO NOTHING'
        : `ON CONFLICT (slug) DO UPDATE
           SET name = EXCLUDED.name, description = EXCLUDED.description, updated_at = now()
           WHERE conductor_workflows.reaped_at IS NULL`;
      const upserted = await client.query<{ id: string }>(
        `INSERT INTO conductor_workflows (slug, name, description, status, origin, expires_at, created_by_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ${conflictClause}
         RETURNING id`,
        [
          input.slug,
          input.name,
          input.description ?? null,
          input.enable ? 'enabled' : 'disabled',
          input.origin ?? 'manual',
          input.expiresAt ?? null,
          input.createdByAgent ?? null,
        ],
      );
      const workflowId = upserted.rows[0]?.id;
      if (workflowId === undefined) throw new WorkflowSlugExistsError(input.slug);
      // Serialize concurrent publishes of the same workflow so version numbering can't collide.
      await client.query('SELECT id FROM conductor_workflows WHERE id = $1 FOR UPDATE', [workflowId]);

      const next = await client.query<{ next: number }>(
        `SELECT COALESCE(MAX(version), 0) + 1 AS next
           FROM conductor_workflow_versions WHERE workflow_id = $1`,
        [workflowId],
      );
      const versionNumber = next.rows[0]!.next;

      const versionRow = await client.query<VersionRow>(
        `INSERT INTO conductor_workflow_versions (workflow_id, version, graph, published_by)
         VALUES ($1, $2, $3::jsonb, $4)
         RETURNING id, workflow_id, version, graph`,
        [workflowId, versionNumber, JSON.stringify(input.graph), input.publishedBy ?? null],
      );
      const version = versionRow.rows[0]!;

      const wfRow = await client.query<WorkflowRow>(
        `UPDATE conductor_workflows
            SET active_version_id = $2, updated_at = now()
          WHERE id = $1
        RETURNING ${WORKFLOW_COLS}`,
        [workflowId, version.id],
      );

      // Atomic side-effects of publishing (e.g. cron-schedule reconcile) — same transaction.
      if (input.onPublished) await input.onPublished(client, workflowId);

      await client.query('COMMIT');
      return {
        workflow: toWorkflow(wfRow.rows[0]!),
        version: { id: version.id, workflowId: version.workflow_id, version: version.version, graph: version.graph },
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async setStatus(slug: string, status: 'enabled' | 'disabled'): Promise<void> {
    // reaped_at guard: a deleted (logically removed) workflow must never be
    // re-enabled — that would be a hidden, startable zombie (invisible to the
    // library and event router, but cron- and manually-runnable).
    await this.pool.query(
      'UPDATE conductor_workflows SET status = $2, updated_at = now() WHERE slug = $1 AND reaped_at IS NULL',
      [slug, status],
    );
  }

  /** True while any run of any of the workflow's versions is running/waiting —
   *  deletion is blocked then (the operator cancels via the #759 route first). */
  async hasActiveRuns(workflowId: string): Promise<boolean> {
    const r = await this.pool.query<{ count: string }>(
      `SELECT count(*) AS count
         FROM conductor_runs r
         JOIN conductor_workflow_versions v ON r.workflow_version_id = v.id
        WHERE v.workflow_id = $1
          AND r.status IN ('running', 'waiting')`,
      [workflowId],
    );
    return Number(r.rows[0]?.count ?? 0) > 0;
  }

  /** Logical removal — the #330 reaper shape extended to manual workflows:
   *  disabled (not startable, the cron worker skips it), stamped `reaped_at`
   *  (hidden from list(), so neither the library nor the event router sees it),
   *  run history + versions retained as audit trace. Idempotent — a removed
   *  row is never re-stamped. */
  async removeLogical(workflowId: string): Promise<void> {
    // One statement so the workflow and its cron schedules disable atomically —
    // the schedules must not stay enabled (the worker's workflowEnabled check
    // would then be the only thing keeping a deleted workflow's cron quiet).
    await this.pool.query(
      `WITH removed AS (
         UPDATE conductor_workflows
            SET status = 'disabled', reaped_at = now(), updated_at = now()
          WHERE id = $1 AND origin = 'manual' AND reaped_at IS NULL
        RETURNING id
       )
       UPDATE conductor_schedules s
          SET status = 'disabled'
         FROM removed
        WHERE s.workflow_id = removed.id`,
      [workflowId],
    );
  }

  /**
   * Physical removal, guarded: only a manual workflow no run references (its
   * versions, drafts and schedules cascade with it — conductor_runs' FK blocks
   * referenced rows at the DB level). Returns false when runs exist; the caller
   * falls back to removeLogical.
   */
  async hardDeleteUnreferenced(workflowId: string): Promise<boolean> {
    const r = await this.pool.query(
      `DELETE FROM conductor_workflows w
        WHERE w.id = $1
          AND w.origin = 'manual'
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
