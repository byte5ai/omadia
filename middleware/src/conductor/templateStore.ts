// DB-backed conductor template store (issue #478). User-authored TemplateManifests
// persisted in conductor_templates (header: owner, review status, latest version)
// + conductor_template_versions (immutable JSONB manifest snapshots — publishing
// appends, never updates, mirroring the workflow version store). Telemetry rows in
// conductor_template_instantiations are append-only and anonymous (no per-user
// tracking). Schema: migrations/0006_templates.sql.
//
// The `version` column is the single source of truth: manifests are stored with
// the column value stamped into `manifest.version` at write AND re-stamped at
// read, so the JSONB field can never drift from the row.

import type { Pool, PoolClient } from 'pg';

import { checkTemplateManifest } from '@omadia/conductor-core';
import type { TemplateManifest, ValidationError } from '@omadia/conductor-core';

/** Review-gate status of a user template. Growable — no DB CHECK (#470 lesson). */
export type TemplateStatus = 'private' | 'pending' | 'shared';

export interface TemplateRecord {
  id: string;
  createdBy: string;
  status: TemplateStatus;
  latestVersion: number;
  reviewedBy: string | null;
  createdAt: string;
  updatedAt: string;
  /** The LATEST manifest, `manifest.version` stamped from the version column. */
  manifest: TemplateManifest;
}

/** Thrown by create() when the id is already taken — detected by the INSERT's
 *  unique violation itself, never a racy pre-check. Routes map it to 409. */
export class TemplateIdExistsError extends Error {
  constructor(readonly id: string) {
    super(`a template with id '${id}' already exists`);
    this.name = 'TemplateIdExistsError';
  }
}

/** Thrown by create()/addVersion() when the manifest fails checkTemplateManifest.
 *  Carries the check's issues array; routes map it to 400 template_invalid. */
export class TemplateInvalidError extends Error {
  constructor(readonly errors: ValidationError[]) {
    super(`template manifest invalid: ${errors.map((e) => e.message).join('; ')}`);
    this.name = 'TemplateInvalidError';
  }
}

interface TemplateRow {
  id: string;
  created_by: string;
  status: TemplateStatus;
  latest_version: number;
  reviewed_by: string | null;
  created_at: string;
  updated_at: string;
  manifest: TemplateManifest;
}

export interface ConductorTemplateStore {
  create(manifest: TemplateManifest, createdBy: string): Promise<TemplateRecord>;
  /** Append version latestVersion+1 atomically. Author-only is the CALLER's check
   *  (routes resolve ownership through the viewer-scoped catalog first). Returns
   *  undefined when the template vanished between check and write. */
  addVersion(id: string, manifest: TemplateManifest): Promise<TemplateRecord | undefined>;
  get(id: string): Promise<TemplateRecord | undefined>;
  list(): Promise<TemplateRecord[]>;
  delete(id: string): Promise<boolean>;
  setStatus(id: string, status: TemplateStatus, reviewedBy?: string): Promise<TemplateRecord | undefined>;
  listVersions(id: string): Promise<Array<{ version: number; createdAt: string }>>;
  getVersion(id: string, version: number): Promise<TemplateManifest | undefined>;
  /** Append-only anonymous telemetry — one row per instantiation. */
  recordInstantiation(input: { templateId: string; templateName: string; version: number; workflowSlug: string }): Promise<void>;
  /** template_id → count over the telemetry table (GROUP BY template_id). */
  instantiationCounts(): Promise<Record<string, number>>;
  /** Stamp {template_id, template_version} provenance onto a workflow row INSIDE
   *  the caller's transaction (createOrPublish's onPublished client). */
  stampWorkflowProvenance(client: PoolClient, workflowId: string, templateId: string, version: number): Promise<void>;
}

const ROW_COLS = 't.id, t.created_by, t.status, t.latest_version, t.reviewed_by, t.created_at, t.updated_at';
const RECORD_SELECT = `
  SELECT ${ROW_COLS}, v.manifest
    FROM conductor_templates t
    JOIN conductor_template_versions v
      ON v.template_id = t.id AND v.version = t.latest_version`;

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

export function createTemplateStore(pool: Pool, log: (msg: string) => void = () => undefined): ConductorTemplateStore {
  function toRecord(r: TemplateRow): TemplateRecord {
    return {
      id: r.id,
      createdBy: r.created_by,
      status: r.status,
      latestVersion: r.latest_version,
      reviewedBy: r.reviewed_by,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      // Version column is authoritative — stamp it into the manifest on read.
      manifest: { ...r.manifest, version: r.latest_version },
    };
  }

  function checkedManifest(manifest: TemplateManifest, version: number): string {
    const result = checkTemplateManifest(manifest);
    if (!result.ok) throw new TemplateInvalidError(result.errors);
    return JSON.stringify({ ...manifest, version });
  }

  return {
    async create(manifest, createdBy) {
      const stored = checkedManifest(manifest, 1);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        try {
          await client.query(
            `INSERT INTO conductor_templates (id, created_by, status, latest_version)
             VALUES ($1, $2, 'private', 1)`,
            [manifest.id, createdBy],
          );
        } catch (err) {
          if (isUniqueViolation(err)) throw new TemplateIdExistsError(manifest.id);
          throw err;
        }
        await client.query(
          `INSERT INTO conductor_template_versions (template_id, version, manifest)
           VALUES ($1, 1, $2::jsonb)`,
          [manifest.id, stored],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
      return (await this.get(manifest.id))!;
    },

    async addVersion(id, manifest) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Serialize concurrent publishes of the same template so version
        // numbering can't collide (same pattern as the workflow store).
        const locked = await client.query<{ latest_version: number }>(
          'SELECT latest_version FROM conductor_templates WHERE id = $1 FOR UPDATE',
          [id],
        );
        const current = locked.rows[0];
        if (!current) {
          await client.query('ROLLBACK');
          return undefined;
        }
        const next = current.latest_version + 1;
        const stored = checkedManifest(manifest, next);
        await client.query(
          `INSERT INTO conductor_template_versions (template_id, version, manifest)
           VALUES ($1, $2, $3::jsonb)`,
          [id, next, stored],
        );
        await client.query(
          'UPDATE conductor_templates SET latest_version = $2, updated_at = now() WHERE id = $1',
          [id, next],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
      return this.get(id);
    },

    async get(id) {
      const r = await pool.query<TemplateRow>(`${RECORD_SELECT} WHERE t.id = $1`, [id]);
      return r.rows[0] ? toRecord(r.rows[0]) : undefined;
    },

    async list() {
      const r = await pool.query<TemplateRow>(`${RECORD_SELECT} ORDER BY t.id`);
      return r.rows.map(toRecord);
    },

    async delete(id) {
      const r = await pool.query('DELETE FROM conductor_templates WHERE id = $1', [id]);
      return (r.rowCount ?? 0) > 0;
    },

    async setStatus(id, status, reviewedBy) {
      const r = await pool.query<{ id: string }>(
        `UPDATE conductor_templates
            SET status = $2, reviewed_by = COALESCE($3, reviewed_by), updated_at = now()
          WHERE id = $1
        RETURNING id`,
        [id, status, reviewedBy ?? null],
      );
      if (!r.rows[0]) return undefined;
      return this.get(id);
    },

    async listVersions(id) {
      const r = await pool.query<{ version: number; created_at: string }>(
        'SELECT version, created_at FROM conductor_template_versions WHERE template_id = $1 ORDER BY version',
        [id],
      );
      return r.rows.map((row) => ({ version: row.version, createdAt: row.created_at }));
    },

    async getVersion(id, version) {
      const r = await pool.query<{ manifest: TemplateManifest; version: number }>(
        'SELECT manifest, version FROM conductor_template_versions WHERE template_id = $1 AND version = $2',
        [id, version],
      );
      const row = r.rows[0];
      return row ? { ...row.manifest, version: row.version } : undefined;
    },

    async recordInstantiation(input) {
      await pool.query(
        `INSERT INTO conductor_template_instantiations (template_id, template_name, template_version, workflow_slug)
         VALUES ($1, $2, $3, $4)`,
        [input.templateId, input.templateName, input.version, input.workflowSlug],
      );
      log(`[conductor] template '${input.templateId}' v${String(input.version)} instantiated as '${input.workflowSlug}'`);
    },

    async instantiationCounts() {
      const r = await pool.query<{ template_id: string; count: string }>(
        `SELECT template_id, COUNT(*)::text AS count
           FROM conductor_template_instantiations
          WHERE template_id IS NOT NULL
          GROUP BY template_id`,
      );
      const counts: Record<string, number> = {};
      for (const row of r.rows) counts[row.template_id] = Number(row.count);
      return counts;
    },

    async stampWorkflowProvenance(client, workflowId, templateId, version) {
      await client.query(
        'UPDATE conductor_workflows SET template_id = $2, template_version = $3 WHERE id = $1',
        [workflowId, templateId, version],
      );
    },
  };
}
