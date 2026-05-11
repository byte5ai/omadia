import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import Database from 'better-sqlite3';
import type { Database as SqliteDatabase } from 'better-sqlite3';

import {
  type AgentSpecSkeleton,
  type Draft,
  type DraftStatus,
  type DraftSummary,
  type BuilderModelId,
  type TranscriptEntry,
  emptyAgentSpec,
} from './types.js';
import { DEFAULT_BUILDER_MODEL, BuilderModelRegistry } from './modelRegistry.js';

/**
 * SQLite-backed store for Agent-Builder drafts. Phase B.0 of the builder MVP
 * (see docs/harness-platform/plans/agent-builder-mvp.md).
 *
 * The database lives on the same Fly volume as the vault + uploaded packages
 * (`/data/builder/drafts.db`). WAL mode is enabled so concurrent reads don't
 * block the auto-save writes coming from the builder routes. All heavy state
 * (spec, slots, transcripts) is persisted as JSON text — validation against
 * the proper AgentSpec Zod schema happens in higher layers (B.1+). The store
 * is type-agnostic and treats everything spec-shaped as opaque JSON.
 *
 * Every query is scoped by `user_email`: a draft belongs to exactly one admin
 * and is unreadable by any other admin (ownership check in load/update/delete).
 *
 * The API is async to match sibling stores (UploadedPackageStore,
 * FileInstalledRegistry) even though better-sqlite3 is synchronous — wrapping
 * the sync calls in `Promise.resolve` keeps callers uniform and leaves a seam
 * for a future worker-thread migration if we ever need it.
 */

const CURRENT_SCHEMA_VERSION = 1;

const SCHEMA_V1_SQL = `
CREATE TABLE IF NOT EXISTS drafts (
  id                      TEXT PRIMARY KEY,
  user_email              TEXT NOT NULL,
  name                    TEXT NOT NULL,
  spec_json               TEXT NOT NULL,
  slots_json              TEXT NOT NULL DEFAULT '{}',
  transcript_json         TEXT NOT NULL DEFAULT '[]',
  preview_transcript_json TEXT NOT NULL DEFAULT '[]',
  codegen_model           TEXT NOT NULL DEFAULT 'sonnet',
  preview_model           TEXT NOT NULL DEFAULT 'sonnet',
  status                  TEXT NOT NULL DEFAULT 'draft',
  installed_agent_id      TEXT,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL,
  deleted_at              INTEGER
);
CREATE INDEX IF NOT EXISTS idx_drafts_user_active
  ON drafts(user_email, deleted_at, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_drafts_installed_purge
  ON drafts(status, deleted_at);
`;

export interface DraftUpdate {
  name?: string;
  spec?: AgentSpecSkeleton;
  slots?: Record<string, string>;
  transcript?: TranscriptEntry[];
  previewTranscript?: TranscriptEntry[];
  codegenModel?: BuilderModelId;
  previewModel?: BuilderModelId;
  status?: DraftStatus;
  installedAgentId?: string | null;
}

interface DraftRow {
  id: string;
  user_email: string;
  name: string;
  spec_json: string;
  slots_json: string;
  transcript_json: string;
  preview_transcript_json: string;
  codegen_model: string;
  preview_model: string;
  status: string;
  installed_agent_id: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

interface DraftSummaryRow {
  id: string;
  name: string;
  status: string;
  codegen_model: string;
  preview_model: string;
  installed_agent_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface DraftListOptions {
  /** `'active'` (default) hides soft-deleted rows; `'all'` returns them too. */
  scope?: 'active' | 'all' | 'deleted';
  /** Optional status filter, applied on top of the scope filter. */
  status?: DraftStatus;
}

export interface DraftStoreOptions {
  dbPath: string;
  /**
   * Grace period (ms) after soft-deletion before `purgeInstalled` hard-
   * deletes installed drafts. Default: 30 days. Non-installed drafts are
   * never auto-purged.
   */
  installedPurgeGraceMs?: number;
  /**
   * OB-83 — optional post-update hook. Called after every successful
   * `update()` whose patch touched `spec` or `name` (i.e. fields that
   * the rendered `agent.md` depends on). Wired by `index.ts` to mirror
   * builder drafts into Phase-2.1.5 `profile_agent_md` so Phase-2.2
   * snapshots have a non-empty source.
   *
   * The hook receives the freshly-loaded draft + the patch + the actor
   * email. Failures are swallowed by the store with a console warning;
   * primary draft state is already committed to SQLite, so a mirror
   * failure must NOT roll the user-visible save back.
   */
  onUpdated?: (event: {
    draft: Draft;
    patch: DraftUpdate;
    userEmail: string;
  }) => Promise<void>;
}

const DEFAULT_INSTALLED_PURGE_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

function shouldFireOnUpdated(patch: DraftUpdate): boolean {
  return patch.spec !== undefined || patch.name !== undefined;
}

export class DraftStore {
  private db: SqliteDatabase | null = null;
  private readonly dbPath: string;
  private readonly installedPurgeGraceMs: number;
  private readonly onUpdated: DraftStoreOptions['onUpdated'];

  constructor(opts: DraftStoreOptions) {
    this.dbPath = opts.dbPath;
    this.installedPurgeGraceMs =
      opts.installedPurgeGraceMs ?? DEFAULT_INSTALLED_PURGE_GRACE_MS;
    this.onUpdated = opts.onUpdated;
  }

  async open(): Promise<void> {
    await fs.mkdir(path.dirname(this.dbPath), { recursive: true });
    const db = new Database(this.dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = NORMAL');
    this.runMigrations(db);
    this.db = db;
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    return Promise.resolve();
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  async create(userEmail: string, name: string): Promise<Draft> {
    const db = this.required();
    const now = Date.now();
    const id = randomUUID();
    const safeName = name.trim() || 'Neuer Agent';
    const spec = emptyAgentSpec();
    // 2026-05-06: codegen-default ist Opus 4.7, preview-default bleibt
    // Sonnet 4.6 (Cost-Split — siehe modelRegistry.ts-Comment).
    const codegenDefault = BuilderModelRegistry.defaultCodegen();
    const previewDefault = BuilderModelRegistry.defaultPreview();

    db.prepare(
      `INSERT INTO drafts (
         id, user_email, name, spec_json, slots_json,
         transcript_json, preview_transcript_json,
         codegen_model, preview_model, status,
         installed_agent_id, created_at, updated_at, deleted_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)`,
    ).run(
      id,
      userEmail,
      safeName,
      JSON.stringify(spec),
      '{}',
      '[]',
      '[]',
      codegenDefault,
      previewDefault,
      'draft',
      now,
      now,
    );

    const row = db
      .prepare('SELECT * FROM drafts WHERE id = ?')
      .get(id) as DraftRow;
    return rowToDraft(row);
  }

  async load(userEmail: string, id: string): Promise<Draft | null> {
    const db = this.required();
    const row = db
      .prepare(
        'SELECT * FROM drafts WHERE id = ? AND user_email = ? AND deleted_at IS NULL',
      )
      .get(id, userEmail) as DraftRow | undefined;
    return row ? rowToDraft(row) : null;
  }

  /**
   * Owner-agnostic lookup by draft id. Used by the Phase-2.2.5
   * profileLoader to decide whether a `profile_id` refers to a Builder-
   * Draft (has a row here, no matter which operator owns it) or a
   * Bootstrap-Profile / unknown id (no row → fall back to registry-wide
   * pin semantics).
   *
   * Soft-deleted drafts return null so a snapshot of a stale id isn't
   * polluted by tombstoned content. Cross-user reads are intentional —
   * the SnapshotService uses the `actor` from its own input for audit,
   * not the draft's owner email.
   */
  async findById(id: string): Promise<Draft | null> {
    const db = this.required();
    const row = db
      .prepare(
        'SELECT * FROM drafts WHERE id = ? AND deleted_at IS NULL',
      )
      .get(id) as DraftRow | undefined;
    return row ? rowToDraft(row) : null;
  }

  /**
   * Edit-from-Store lookup (B.6-3). Returns the most recently updated
   * non-deleted draft owned by `userEmail` whose last-successful install
   * pinned `installed_agent_id == agentId`. Returns `null` if no such
   * draft exists — typically because the source draft was hard-deleted
   * after install OR another user installed the plugin.
   *
   * The current Conflict-Resolution policy (Open-Question #2: block on
   * duplicate_version) guarantees at most one draft per (user, agent_id,
   * version) tuple; multiple drafts can pin the same agent_id only via
   * Edit-from-Store re-install with a version bump. `ORDER BY
   * updated_at DESC LIMIT 1` resolves that to "the most recently
   * installed version" — what the operator expects when they click
   * Edit on the store-card.
   */
  async findByInstalledAgentId(
    userEmail: string,
    agentId: string,
  ): Promise<Draft | null> {
    const db = this.required();
    const row = db
      .prepare(
        `SELECT * FROM drafts
         WHERE user_email = ?
           AND installed_agent_id = ?
           AND deleted_at IS NULL
         ORDER BY updated_at DESC
         LIMIT 1`,
      )
      .get(userEmail, agentId) as DraftRow | undefined;
    return row ? rowToDraft(row) : null;
  }

  async list(
    userEmail: string,
    opts: DraftListOptions = {},
  ): Promise<DraftSummary[]> {
    const db = this.required();
    const scope = opts.scope ?? 'active';

    let sql = `SELECT id, name, status, codegen_model, preview_model,
                      installed_agent_id, created_at, updated_at
               FROM drafts WHERE user_email = ?`;
    const params: unknown[] = [userEmail];

    if (scope === 'active') sql += ' AND deleted_at IS NULL';
    else if (scope === 'deleted') sql += ' AND deleted_at IS NOT NULL';
    // 'all' → no filter

    if (opts.status) {
      sql += ' AND status = ?';
      params.push(opts.status);
    }

    sql += ' ORDER BY updated_at DESC';

    const rows = db.prepare(sql).all(...params) as DraftSummaryRow[];
    return rows.map(summaryRowToSummary);
  }

  async count(
    userEmail: string,
    opts: { scope?: 'active' | 'all' } = {},
  ): Promise<number> {
    const db = this.required();
    const scope = opts.scope ?? 'active';
    const sql =
      scope === 'active'
        ? 'SELECT COUNT(*) AS n FROM drafts WHERE user_email = ? AND deleted_at IS NULL'
        : 'SELECT COUNT(*) AS n FROM drafts WHERE user_email = ?';
    const row = db.prepare(sql).get(userEmail) as { n: number };
    return row.n;
  }

  async update(
    userEmail: string,
    id: string,
    patch: DraftUpdate,
  ): Promise<Draft | null> {
    const db = this.required();
    const exists = db
      .prepare(
        'SELECT id FROM drafts WHERE id = ? AND user_email = ? AND deleted_at IS NULL',
      )
      .get(id, userEmail) as { id: string } | undefined;
    if (!exists) return null;

    const fields: string[] = [];
    const params: unknown[] = [];

    if (patch.name !== undefined) {
      fields.push('name = ?');
      params.push(patch.name);
    }
    if (patch.spec !== undefined) {
      fields.push('spec_json = ?');
      params.push(JSON.stringify(patch.spec));
    }
    if (patch.slots !== undefined) {
      fields.push('slots_json = ?');
      params.push(JSON.stringify(patch.slots));
    }
    if (patch.transcript !== undefined) {
      fields.push('transcript_json = ?');
      params.push(JSON.stringify(patch.transcript));
    }
    if (patch.previewTranscript !== undefined) {
      fields.push('preview_transcript_json = ?');
      params.push(JSON.stringify(patch.previewTranscript));
    }
    if (patch.codegenModel !== undefined) {
      fields.push('codegen_model = ?');
      params.push(patch.codegenModel);
    }
    if (patch.previewModel !== undefined) {
      fields.push('preview_model = ?');
      params.push(patch.previewModel);
    }
    if (patch.status !== undefined) {
      fields.push('status = ?');
      params.push(patch.status);
    }
    if (patch.installedAgentId !== undefined) {
      fields.push('installed_agent_id = ?');
      params.push(patch.installedAgentId);
    }

    if (fields.length === 0) {
      return this.load(userEmail, id);
    }

    fields.push('updated_at = ?');
    params.push(Date.now());
    params.push(id, userEmail);

    db.prepare(
      `UPDATE drafts SET ${fields.join(', ')}
       WHERE id = ? AND user_email = ? AND deleted_at IS NULL`,
    ).run(...params);

    const updated = await this.load(userEmail, id);
    if (updated && this.onUpdated && shouldFireOnUpdated(patch)) {
      try {
        await this.onUpdated({ draft: updated, patch, userEmail });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[draftStore] onUpdated hook failed for ${id}: ${msg} — primary state is already saved`,
        );
      }
    }
    return updated;
  }

  async softDelete(userEmail: string, id: string): Promise<boolean> {
    const db = this.required();
    const now = Date.now();
    const result = db
      .prepare(
        `UPDATE drafts SET deleted_at = ?, updated_at = ?
         WHERE id = ? AND user_email = ? AND deleted_at IS NULL`,
      )
      .run(now, now, id, userEmail);
    return result.changes > 0;
  }

  async restore(userEmail: string, id: string): Promise<boolean> {
    const db = this.required();
    const result = db
      .prepare(
        `UPDATE drafts SET deleted_at = NULL, updated_at = ?
         WHERE id = ? AND user_email = ? AND deleted_at IS NOT NULL`,
      )
      .run(Date.now(), id, userEmail);
    return result.changes > 0;
  }

  /**
   * Hard-delete the row. Reserved for CLI/admin use or the auto-cleanup path
   * (`purgeInstalled`). Regular user-delete goes through `softDelete`.
   */
  async hardDelete(userEmail: string, id: string): Promise<boolean> {
    const db = this.required();
    const result = db
      .prepare('DELETE FROM drafts WHERE id = ? AND user_email = ?')
      .run(id, userEmail);
    return result.changes > 0;
  }

  /**
   * Best-effort daily cleanup: hard-delete soft-deleted drafts whose
   * `status` is `'installed'` AND whose grace period has elapsed. Drafts
   * that never got installed are never auto-purged — losing in-flight work
   * to a cron job would be a UX regression.
   */
  async purgeInstalled(now = Date.now()): Promise<number> {
    const db = this.required();
    const cutoff = now - this.installedPurgeGraceMs;
    const result = db
      .prepare(
        `DELETE FROM drafts
         WHERE status = 'installed'
           AND deleted_at IS NOT NULL
           AND deleted_at < ?`,
      )
      .run(cutoff);
    return result.changes;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private runMigrations(db: SqliteDatabase): void {
    const current = db.pragma('user_version', { simple: true }) as number;
    if (current < 1) {
      db.exec(SCHEMA_V1_SQL);
      db.pragma(`user_version = ${String(CURRENT_SCHEMA_VERSION)}`);
      return;
    }
    // Future schema bumps land here as `if (current < 2) { … }` branches. For
    // now the schema version is pinned at 1 and we trust `CREATE TABLE IF NOT
    // EXISTS` to keep fresh DBs aligned with existing ones.
    if (current > CURRENT_SCHEMA_VERSION) {
      throw new Error(
        `drafts.db schema version ${String(current)} is newer than this middleware supports ` +
          `(max ${String(CURRENT_SCHEMA_VERSION)}). Refusing to open — downgrade would corrupt data.`,
      );
    }
  }

  private required(): SqliteDatabase {
    if (!this.db) {
      throw new Error('DraftStore.open() must be called before use');
    }
    return this.db;
  }
}

function rowToDraft(row: DraftRow): Draft {
  return {
    id: row.id,
    userEmail: row.user_email,
    name: row.name,
    spec: JSON.parse(row.spec_json) as AgentSpecSkeleton,
    slots: JSON.parse(row.slots_json) as Record<string, string>,
    transcript: JSON.parse(row.transcript_json) as TranscriptEntry[],
    previewTranscript: JSON.parse(row.preview_transcript_json) as TranscriptEntry[],
    codegenModel: normalizeModel(row.codegen_model),
    previewModel: normalizeModel(row.preview_model),
    status: normalizeStatus(row.status),
    installedAgentId: row.installed_agent_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

function summaryRowToSummary(row: DraftSummaryRow): DraftSummary {
  return {
    id: row.id,
    name: row.name,
    status: normalizeStatus(row.status),
    codegenModel: normalizeModel(row.codegen_model),
    previewModel: normalizeModel(row.preview_model),
    installedAgentId: row.installed_agent_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeModel(value: string): BuilderModelId {
  return BuilderModelRegistry.has(value) ? value : DEFAULT_BUILDER_MODEL;
}

function normalizeStatus(value: string): DraftStatus {
  if (value === 'installed' || value === 'archived') return value;
  return 'draft';
}
