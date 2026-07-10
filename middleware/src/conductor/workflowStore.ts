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
  };
}

const WORKFLOW_COLS = 'id, slug, name, description, status, active_version_id, template_id, template_version';

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
    const r = await this.pool.query<WorkflowRow>(
      `SELECT ${WORKFLOW_COLS} FROM conductor_workflows ORDER BY created_at DESC`,
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
      const conflictClause = input.expectNew
        ? 'ON CONFLICT (slug) DO NOTHING'
        : `ON CONFLICT (slug) DO UPDATE
           SET name = EXCLUDED.name, description = EXCLUDED.description, updated_at = now()`;
      const upserted = await client.query<{ id: string }>(
        `INSERT INTO conductor_workflows (slug, name, description, status)
         VALUES ($1, $2, $3, $4)
         ${conflictClause}
         RETURNING id`,
        [input.slug, input.name, input.description ?? null, input.enable ? 'enabled' : 'disabled'],
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
    await this.pool.query(
      'UPDATE conductor_workflows SET status = $2, updated_at = now() WHERE slug = $1',
      [slug, status],
    );
  }
}
