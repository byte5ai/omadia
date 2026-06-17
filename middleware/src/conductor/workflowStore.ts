import type { Pool } from 'pg';
import type { WorkflowGraph } from '@omadia/conductor-core';

export interface ConductorWorkflow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  status: 'enabled' | 'disabled';
  activeVersionId: string | null;
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
}

interface VersionRow {
  id: string;
  workflow_id: string;
  version: number;
  graph: WorkflowGraph;
}

function toWorkflow(r: WorkflowRow): ConductorWorkflow {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    description: r.description,
    status: r.status,
    activeVersionId: r.active_version_id,
  };
}

/**
 * Persistence for workflow headers + immutable versions. A publish snapshots the
 * supplied graph into a new monotonic version and points `active_version_id` at it
 * (FR-027 — runs already in flight keep their version).
 */
export class ConductorWorkflowStore {
  constructor(private readonly pool: Pool) {}

  async getBySlug(slug: string): Promise<ConductorWorkflow | null> {
    const r = await this.pool.query<WorkflowRow>(
      'SELECT id, slug, name, description, status, active_version_id FROM conductor_workflows WHERE slug = $1',
      [slug],
    );
    return r.rows[0] ? toWorkflow(r.rows[0]) : null;
  }

  async list(): Promise<ConductorWorkflow[]> {
    const r = await this.pool.query<WorkflowRow>(
      'SELECT id, slug, name, description, status, active_version_id FROM conductor_workflows ORDER BY created_at DESC',
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
  }): Promise<{ workflow: ConductorWorkflow; version: ConductorVersion }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const existing = await client.query<WorkflowRow>(
        'SELECT id, slug, name, description, status, active_version_id FROM conductor_workflows WHERE slug = $1 FOR UPDATE',
        [input.slug],
      );

      let workflowId: string;
      if (existing.rows[0]) {
        workflowId = existing.rows[0].id;
        await client.query(
          `UPDATE conductor_workflows
             SET name = $2, description = $3, updated_at = now()
           WHERE id = $1`,
          [workflowId, input.name, input.description ?? null],
        );
      } else {
        const created = await client.query<{ id: string }>(
          `INSERT INTO conductor_workflows (slug, name, description, status)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [input.slug, input.name, input.description ?? null, input.enable ? 'enabled' : 'disabled'],
        );
        workflowId = created.rows[0]!.id;
      }

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
        RETURNING id, slug, name, description, status, active_version_id`,
        [workflowId, version.id],
      );

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
