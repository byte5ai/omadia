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

const CURRENT_SCHEMA_VERSION = 4;

// v1 baseline drafts table. In v3 the historical `installed_agent_id` column
// was renamed to `published_agent_id` — for fresh installs we create the
// table directly with the v3 column name (saving a no-op rename); the
// migration path handles existing v1/v2 DBs that still carry the old name.
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
  published_agent_id      TEXT,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL,
  deleted_at              INTEGER
);
CREATE INDEX IF NOT EXISTS idx_drafts_user_active
  ON drafts(user_email, deleted_at, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_drafts_published_purge
  ON drafts(status, deleted_at);
`;

// Issue #56 — v2 adds the builder_audit fire-and-forget table. Idempotent
// `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` so re-running
// against an already-v2 DB is a no-op; mid-flight upgrade from v1 picks up
// the table without losing existing drafts.
const SCHEMA_V2_SQL = `
CREATE TABLE IF NOT EXISTS builder_audit (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id      TEXT NOT NULL,
  user_email    TEXT NOT NULL,
  action        TEXT NOT NULL,
  details_json  TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_builder_audit_draft
  ON builder_audit(draft_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_builder_audit_user
  ON builder_audit(user_email, created_at DESC);
`;

/**
 * V4 — Native issue-reporting + workaround-tracking (concept plan:
 * docs/plans/native-issue-reporting.md). Three additive tables; no changes
 * to the existing `drafts` columns. Spec-side workaround data lives inside
 * `spec_json` (immutable identity) while operational state lives in
 * `agent_workaround_state` so re-installs of the same spec keep their
 * lifecycle state.
 *
 * Numbered v4 to layer on top of v3 (the `installed_agent_id`→
 * `published_agent_id` rename from PR #98). v2 stays the audit table from
 * issue #56; v3 is the column rename; v4 introduces these issue-reporting
 * tables. The migration logic in `runMigrations` handles all four upgrade
 * paths idempotently.
 */
const SCHEMA_V4_SQL = `
CREATE TABLE IF NOT EXISTS github_issue_cache (
  repo_owner       TEXT NOT NULL,
  repo_name        TEXT NOT NULL,
  issue_number     INTEGER NOT NULL,
  state            TEXT NOT NULL,
  closed_at        INTEGER,
  cached_at        INTEGER NOT NULL,
  etag             TEXT,
  backoff_until    INTEGER,
  pending_until    INTEGER,
  PRIMARY KEY (repo_owner, repo_name, issue_number)
);

CREATE TABLE IF NOT EXISTS agent_workaround_state (
  installed_agent_id     TEXT NOT NULL,
  workaround_id          TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'active',
  resolved_at            INTEGER,
  last_status_lookup_at  INTEGER,
  patch_context_json     TEXT,
  created_at             INTEGER NOT NULL,
  PRIMARY KEY (installed_agent_id, workaround_id)
);
CREATE INDEX IF NOT EXISTS idx_workaround_state_status
  ON agent_workaround_state(status);

CREATE TABLE IF NOT EXISTS builder_triage_log (
  id                TEXT PRIMARY KEY,
  draft_id          TEXT NOT NULL,
  user_email        TEXT NOT NULL,
  fingerprint       TEXT NOT NULL,
  classification    TEXT NOT NULL,
  confidence        REAL NOT NULL,
  reason            TEXT,
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_triage_log_user_recent
  ON builder_triage_log(user_email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_triage_log_fingerprint
  ON builder_triage_log(fingerprint);
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
  publishedAgentId?: string | null;
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
  published_agent_id: string | null;
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
  published_agent_id: string | null;
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
   * Grace period (ms) after soft-deletion before `purgePublished` hard-
   * deletes published drafts. Default: 30 days. Non-published drafts are
   * never auto-purged.
   */
  publishedPurgeGraceMs?: number;
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

const DEFAULT_PUBLISHED_PURGE_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

function shouldFireOnUpdated(patch: DraftUpdate): boolean {
  return patch.spec !== undefined || patch.name !== undefined;
}

export class DraftStore {
  private db: SqliteDatabase | null = null;
  private readonly dbPath: string;
  private readonly publishedPurgeGraceMs: number;
  private readonly onUpdated: DraftStoreOptions['onUpdated'];

  constructor(opts: DraftStoreOptions) {
    this.dbPath = opts.dbPath;
    this.publishedPurgeGraceMs =
      opts.publishedPurgeGraceMs ?? DEFAULT_PUBLISHED_PURGE_GRACE_MS;
    this.onUpdated = opts.onUpdated;
  }

  async open(): Promise<void> {
    await fs.mkdir(path.dirname(this.dbPath), { recursive: true });
    const db = new Database(this.dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = NORMAL');
    await this.runMigrations(db);
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
         published_agent_id, created_at, updated_at, deleted_at
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
   * non-deleted draft owned by `userEmail` whose last-successful publish
   * pinned `published_agent_id == agentId`. Returns `null` if no such
   * draft exists — typically because the source draft was hard-deleted
   * after publish OR another user published the plugin.
   *
   * The current Conflict-Resolution policy (Open-Question #2: block on
   * duplicate_version) guarantees at most one draft per (user, agent_id,
   * version) tuple; multiple drafts can pin the same agent_id only via
   * Edit-from-Store re-publish with a version bump. `ORDER BY
   * updated_at DESC LIMIT 1` resolves that to "the most recently
   * published version" — what the operator expects when they click
   * Edit on the store-card.
   */
  async findByPublishedAgentId(
    userEmail: string,
    agentId: string,
  ): Promise<Draft | null> {
    const db = this.required();
    const row = db
      .prepare(
        `SELECT * FROM drafts
         WHERE user_email = ?
           AND published_agent_id = ?
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
                      published_agent_id, created_at, updated_at
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
      // Normalize on write so already-persisted drafts heal themselves on
      // the next auto-save, not just on read.
      params.push(JSON.stringify(normalizeSkeletonArrays(patch.spec)));
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
    if (patch.publishedAgentId !== undefined) {
      fields.push('published_agent_id = ?');
      params.push(patch.publishedAgentId);
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
   * (`purgePublished`). Regular user-delete goes through `softDelete`.
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
   * `status` is `'published'` AND whose grace period has elapsed. Drafts
   * that never got published are never auto-purged — losing in-flight work
   * to a cron job would be a UX regression.
   */
  async purgePublished(now = Date.now()): Promise<number> {
    const db = this.required();
    const cutoff = now - this.publishedPurgeGraceMs;
    const result = db
      .prepare(
        `DELETE FROM drafts
         WHERE status = 'published'
           AND deleted_at IS NOT NULL
           AND deleted_at < ?`,
      )
      .run(cutoff);
    return result.changes;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async runMigrations(db: SqliteDatabase): Promise<void> {
    const current = db.pragma('user_version', { simple: true }) as number;

    if (current > CURRENT_SCHEMA_VERSION) {
      throw new Error(
        `drafts.db schema version ${String(current)} is newer than this middleware supports ` +
          `(max ${String(CURRENT_SCHEMA_VERSION)}). Refusing to open — downgrade would corrupt data.`,
      );
    }

    if (current === 0) {
      // Fresh DB: install at the final v4 layout in one shot. SCHEMA_V1_SQL
      // creates the drafts table with the v3 column name (`published_agent_id`)
      // directly, so no rename is needed on this path. SCHEMA_V2_SQL adds the
      // audit table (#56); SCHEMA_V4_SQL adds the issue-reporting tables.
      // The migration paths below handle existing v1/v2/v3 DBs.
      db.exec(SCHEMA_V1_SQL);
      db.exec(SCHEMA_V2_SQL);
      db.exec(SCHEMA_V4_SQL);
      db.pragma(`user_version = ${String(CURRENT_SCHEMA_VERSION)}`);
      this.assertSchemaIntegrity(db);
      return;
    }

    if (current === 1) {
      // v1 → v4: add audit table (#56), rename installed_agent_id →
      // published_agent_id (#98), and add issue-reporting tables (#101).
      // Online backup BEFORE the destructive column rename.
      await this.backupBeforeV3(db);
      db.transaction(() => {
        db.exec(SCHEMA_V2_SQL);
        this.renameInstalledToPublished(db);
        db.exec(SCHEMA_V4_SQL);
        db.pragma(`user_version = ${String(CURRENT_SCHEMA_VERSION)}`);
      })();
      this.assertSchemaIntegrity(db);
      return;
    }

    if (current === 2) {
      // v2 → v4: rename installed_agent_id → published_agent_id and add
      // issue-reporting tables. TODO(2026-08-01): Remove the rename branches
      // once the eigene Instanz is on v3+ — replace with a fatal error
      // directing operators to restore from `.bak-v2-*` backup.
      await this.backupBeforeV3(db);
      db.transaction(() => {
        this.renameInstalledToPublished(db);
        db.exec(SCHEMA_V4_SQL);
        db.pragma(`user_version = ${String(CURRENT_SCHEMA_VERSION)}`);
      })();
      this.assertSchemaIntegrity(db);
      return;
    }

    if (current === 3) {
      // v3 → v4: only add the issue-reporting tables. No column rename, so no
      // pre-write backup needed — the SCHEMA_V4_SQL statements are all
      // `CREATE TABLE IF NOT EXISTS` and re-runnable.
      db.transaction(() => {
        db.exec(SCHEMA_V4_SQL);
        db.pragma(`user_version = ${String(CURRENT_SCHEMA_VERSION)}`);
      })();
      this.assertSchemaIntegrity(db);
      return;
    }

    if (current === CURRENT_SCHEMA_VERSION) {
      // Idempotent re-open. Still validate the schema — protects against an
      // operator who pinned user_version by hand without running the
      // migration.
      this.assertSchemaIntegrity(db);
      return;
    }

    throw new Error(
      `drafts.db schema version ${String(current)} is unhandled (max ${String(CURRENT_SCHEMA_VERSION)}). ` +
        `Refusing to open — investigate manually.`,
    );
  }

  private async backupBeforeV3(db: SqliteDatabase): Promise<void> {
    // Online backup BEFORE we touch the column rename. Timestamped so
    // re-running the migration (after rollback) never overwrites an earlier
    // snapshot. Tagged `.bak-v<current>-` so the source version is obvious.
    const current = db.pragma('user_version', { simple: true }) as number;
    const backupPath = `${this.dbPath}.bak-v${String(current)}-${String(Date.now())}`;
    await db.backup(backupPath);
    console.log(
      `[draftStore] migrating drafts.db v${String(current)} → v${String(CURRENT_SCHEMA_VERSION)}; backup written to ${backupPath}`,
    );
  }

  private renameInstalledToPublished(db: SqliteDatabase): void {
    // DDL helper: rename status value + column + index. SQLite ≥ 3.25 (which
    // better-sqlite3 ships) supports ALTER TABLE … RENAME COLUMN. Caller is
    // responsible for the surrounding transaction + user_version pragma.
    db.exec(`UPDATE drafts SET status = 'published' WHERE status = 'installed'`);
    db.exec(
      `ALTER TABLE drafts RENAME COLUMN installed_agent_id TO published_agent_id`,
    );
    // The v1 index referenced the column by name in its own identifier;
    // rename the index too so DB introspection stays clean.
    db.exec(`DROP INDEX IF EXISTS idx_drafts_installed_purge`);
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_drafts_published_purge ON drafts(status, deleted_at)`,
    );
  }

  private assertSchemaIntegrity(db: SqliteDatabase): void {
    // Post-migration sanity check. Refuses to start if the column the code
    // expects is missing — surfaces schema drift at boot, not at the first
    // query under traffic.
    const cols = (
      db
        .prepare(`SELECT name FROM pragma_table_info('drafts')`)
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    if (!cols.includes('published_agent_id')) {
      throw new Error(
        'drafts.db schema missing `published_agent_id` column after migration. ' +
          'Aborting to avoid silent corruption. Restore the most recent ' +
          '`drafts.db.bak-v*` backup if a v1/v2 schema was unexpectedly opened.',
      );
    }
    if (cols.includes('installed_agent_id')) {
      throw new Error(
        'drafts.db still has legacy `installed_agent_id` column after migration. ' +
          'Aborting. Investigate manually before continuing.',
      );
    }
  }

  // ── audit log (issue #56) ─────────────────────────────────────────────────

  /**
   * Append a single audit event. Synchronous SQLite write under the hood;
   * wrapped in a Promise for the AuditLogger surface. Throws on DB errors
   * — callers (e.g. `audit.ts`) swallow exceptions because the audit log
   * is fire-and-forget.
   */
  async appendAudit(event: {
    draftId: string;
    userEmail: string;
    action: string;
    details: Readonly<Record<string, unknown>>;
  }): Promise<void> {
    const db = this.required();
    db.prepare(
      `INSERT INTO builder_audit (draft_id, user_email, action, details_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      event.draftId,
      event.userEmail,
      event.action,
      JSON.stringify(event.details ?? {}),
      Date.now(),
    );
    return Promise.resolve();
  }

  /**
   * Paginated audit listing for a draft, newest-first. Returns a tuple of
   * `events` and `total` so the UI can render the "X of Y" footer without
   * a second round-trip. Owner-scoped: events are filtered by the calling
   * `userEmail` to mirror the draft-load access pattern.
   */
  async listAudit(
    userEmail: string,
    draftId: string,
    opts: { limit?: number; offset?: number } = {},
  ): Promise<{
    events: {
      id: number;
      draftId: string;
      userEmail: string;
      action: string;
      details: Record<string, unknown>;
      createdAt: number;
    }[];
    total: number;
  }> {
    const db = this.required();
    const limit = Math.max(1, Math.min(200, opts.limit ?? 30));
    const offset = Math.max(0, opts.offset ?? 0);

    const total = (
      db
        .prepare(
          `SELECT COUNT(*) as n FROM builder_audit
             WHERE draft_id = ? AND user_email = ?`,
        )
        .get(draftId, userEmail) as { n: number }
    ).n;

    const rows = db
      .prepare(
        `SELECT id, draft_id, user_email, action, details_json, created_at
           FROM builder_audit
          WHERE draft_id = ? AND user_email = ?
          ORDER BY created_at DESC, id DESC
          LIMIT ? OFFSET ?`,
      )
      .all(draftId, userEmail, limit, offset) as {
      id: number;
      draft_id: string;
      user_email: string;
      action: string;
      details_json: string;
      created_at: number;
    }[];

    return Promise.resolve({
      total,
      events: rows.map((r) => ({
        id: r.id,
        draftId: r.draft_id,
        userEmail: r.user_email,
        action: r.action,
        details: JSON.parse(r.details_json) as Record<string, unknown>,
        createdAt: r.created_at,
      })),
    });
  }

  private required(): SqliteDatabase {
    if (!this.db) {
      throw new Error('DraftStore.open() must be called before use');
    }
    return this.db;
  }
}

/**
 * Skeleton arrays may be missing on persisted drafts: the LLM's `patch_spec`
 * can omit untouched fields, and the strict `AgentSpecSchema` (with Zod
 * `.default([])`) only runs at install/codegen time — not on every save.
 * UI consumers (Workspace, SpecOverview, SpecEditor, manifestLinter) already
 * read these defensively with `?? []`; this normalizer hardens the store
 * itself so every Draft handed back to the API layer has the expected array
 * shape regardless of which build phase the LLM was in.
 *
 * Intentionally does NOT validate content (no Zod parse) — drafts mid-build
 * may have empty `id` / `skill.role` / etc., and we don't want to reject
 * them on read. Only fills `undefined`/`null` array slots with `[]` and
 * ensures the structural sub-objects (`network`, `playbook`) exist.
 */
function normalizeSkeletonArrays(input: unknown): AgentSpecSkeleton {
  const spec = (input ?? {}) as Record<string, unknown>;
  const ensureArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

  const network = (spec.network ?? {}) as Record<string, unknown>;
  const playbook = (spec.playbook ?? {}) as Record<string, unknown>;

  return {
    ...(spec as object),
    depends_on: ensureArr(spec.depends_on) as string[],
    tools: ensureArr(spec.tools),
    setup_fields: ensureArr(spec.setup_fields),
    network: {
      ...(network as object),
      outbound: ensureArr(network.outbound) as string[],
    },
    playbook: {
      ...(playbook as object),
      when_to_use: (playbook.when_to_use as string | undefined) ?? '',
      not_for: ensureArr(playbook.not_for) as string[],
      example_prompts: ensureArr(playbook.example_prompts) as string[],
    },
    external_reads: ensureArr(spec.external_reads),
    ui_routes: ensureArr(spec.ui_routes),
  } as AgentSpecSkeleton;
}

function rowToDraft(row: DraftRow): Draft {
  return {
    id: row.id,
    userEmail: row.user_email,
    name: row.name,
    spec: normalizeSkeletonArrays(JSON.parse(row.spec_json)),
    slots: JSON.parse(row.slots_json) as Record<string, string>,
    transcript: JSON.parse(row.transcript_json) as TranscriptEntry[],
    previewTranscript: JSON.parse(row.preview_transcript_json) as TranscriptEntry[],
    codegenModel: normalizeModel(row.codegen_model),
    previewModel: normalizeModel(row.preview_model),
    status: normalizeStatus(row.status),
    publishedAgentId: row.published_agent_id,
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
    publishedAgentId: row.published_agent_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeModel(value: string): BuilderModelId {
  return BuilderModelRegistry.has(value) ? value : DEFAULT_BUILDER_MODEL;
}

function normalizeStatus(value: string): DraftStatus {
  if (value === 'published' || value === 'archived') return value;
  return 'draft';
}
