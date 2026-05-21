import Database from 'better-sqlite3';
import type { Database as SqliteDatabase } from 'better-sqlite3';

import type { Workaround } from './types.js';

/**
 * Workaround operational-state store (concept plan: docs/plans/native-
 * issue-reporting.md). Backed by the v2 `agent_workaround_state` table.
 *
 * The spec holds immutable Workaround identity (issueRef, fingerprint,
 * summary, createdAt). Operational state — `active` vs. `resolved`,
 * `resolvedAt`, the last-status-lookup timestamp, and the patch
 * context the Builder uses on rebuild — lives here so re-installing
 * the same spec keeps the lifecycle.
 *
 * Records are keyed by (installedAgentId, workaroundId). Multiple
 * installed versions of the same source spec each get their own
 * lifecycle: rolling back to an older version restores the older
 * agent's workaround state without touching the newer one's.
 */

export type WorkaroundStatus = 'active' | 'resolved';

export interface WorkaroundOperationalState {
  installedAgentId: string;
  workaroundId: string;
  status: WorkaroundStatus;
  resolvedAt: number | null;
  lastStatusLookupAt: number | null;
  patchContext: WorkaroundPatchContext | null;
  createdAt: number;
}

/**
 * Builder-generated context used when the operator triggers a rebuild
 * after the upstream fix lands. Fingerprint + the spec-diff allow the
 * next builder turn to revert exactly the lines the workaround
 * introduced. `relevantFiles` and `reasoning` are LLM-authored hints
 * — the builder MUST verify against the live spec before acting.
 */
export interface WorkaroundPatchContext {
  fingerprint: string;
  /** Builder's explanation of what the workaround changed. */
  reasoning: string;
  /** Files in the generated agent the workaround touched. */
  relevantFiles: string[];
  /** Optional diff of the spec before vs after the workaround was applied. */
  specDiff?: string;
}

export interface WorkaroundStateStoreOptions {
  dbPath: string;
  now?: () => number;
}

export class WorkaroundStateStore {
  private db: SqliteDatabase | null = null;
  private readonly dbPath: string;
  private readonly now: () => number;

  constructor(opts: WorkaroundStateStoreOptions) {
    this.dbPath = opts.dbPath;
    this.now = opts.now ?? (() => Date.now());
  }

  async open(): Promise<void> {
    const db = new Database(this.dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = NORMAL');
    this.db = db;
    return Promise.resolve();
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    return Promise.resolve();
  }

  /**
   * Mark a workaround as active. Idempotent: a second call with the
   * same key keeps the original createdAt + patch context but resets
   * status to `active` (the rebuild path uses `markResolved` instead).
   */
  markActive(input: {
    installedAgentId: string;
    workaround: Workaround;
    patchContext?: WorkaroundPatchContext;
  }): void {
    const db = this.required();
    const existing = db
      .prepare(
        `SELECT created_at, patch_context_json FROM agent_workaround_state
         WHERE installed_agent_id = ? AND workaround_id = ?`,
      )
      .get(input.installedAgentId, input.workaround.id) as
      | { created_at: number; patch_context_json: string | null }
      | undefined;

    const createdAt = existing?.created_at ?? input.workaround.createdAt;
    const patchContextJson = input.patchContext
      ? JSON.stringify(input.patchContext)
      : existing?.patch_context_json ?? null;

    db.prepare(
      `INSERT INTO agent_workaround_state
        (installed_agent_id, workaround_id, status, resolved_at,
         last_status_lookup_at, patch_context_json, created_at)
       VALUES (?, ?, 'active', NULL, NULL, ?, ?)
       ON CONFLICT(installed_agent_id, workaround_id) DO UPDATE SET
         status = 'active',
         resolved_at = NULL,
         patch_context_json = COALESCE(excluded.patch_context_json, patch_context_json)`,
    ).run(
      input.installedAgentId,
      input.workaround.id,
      patchContextJson,
      createdAt,
    );
  }

  markResolved(input: {
    installedAgentId: string;
    workaroundId: string;
  }): boolean {
    const db = this.required();
    const result = db
      .prepare(
        `UPDATE agent_workaround_state
         SET status = 'resolved', resolved_at = ?
         WHERE installed_agent_id = ? AND workaround_id = ?`,
      )
      .run(this.now(), input.installedAgentId, input.workaroundId);
    return result.changes > 0;
  }

  recordStatusLookup(input: {
    installedAgentId: string;
    workaroundId: string;
  }): boolean {
    const db = this.required();
    const result = db
      .prepare(
        `UPDATE agent_workaround_state
         SET last_status_lookup_at = ?
         WHERE installed_agent_id = ? AND workaround_id = ?`,
      )
      .run(this.now(), input.installedAgentId, input.workaroundId);
    return result.changes > 0;
  }

  setPatchContext(input: {
    installedAgentId: string;
    workaroundId: string;
    patchContext: WorkaroundPatchContext;
  }): boolean {
    const db = this.required();
    const result = db
      .prepare(
        `UPDATE agent_workaround_state
         SET patch_context_json = ?
         WHERE installed_agent_id = ? AND workaround_id = ?`,
      )
      .run(
        JSON.stringify(input.patchContext),
        input.installedAgentId,
        input.workaroundId,
      );
    return result.changes > 0;
  }

  getOperationalState(input: {
    installedAgentId: string;
    workaroundId: string;
  }): WorkaroundOperationalState | null {
    const db = this.required();
    const row = db
      .prepare(
        `SELECT installed_agent_id, workaround_id, status, resolved_at,
                last_status_lookup_at, patch_context_json, created_at
         FROM agent_workaround_state
         WHERE installed_agent_id = ? AND workaround_id = ?`,
      )
      .get(input.installedAgentId, input.workaroundId) as
      | StateRow
      | undefined;
    return row ? rowToState(row) : null;
  }

  /** Every operational entry for a given installed agent. */
  listForAgent(installedAgentId: string): WorkaroundOperationalState[] {
    const db = this.required();
    const rows = db
      .prepare(
        `SELECT installed_agent_id, workaround_id, status, resolved_at,
                last_status_lookup_at, patch_context_json, created_at
         FROM agent_workaround_state
         WHERE installed_agent_id = ?
         ORDER BY created_at DESC`,
      )
      .all(installedAgentId) as StateRow[];
    return rows.map(rowToState);
  }

  /**
   * Convenience helper called by installCommit after a successful
   * install: pulls every workaround from the spec and persists an
   * `active` row for each. Idempotent thanks to the upsert in
   * markActive.
   */
  initializeForInstall(input: {
    installedAgentId: string;
    workarounds: ReadonlyArray<Workaround>;
  }): void {
    for (const w of input.workarounds) {
      this.markActive({
        installedAgentId: input.installedAgentId,
        workaround: w,
      });
    }
  }

  private required(): SqliteDatabase {
    if (!this.db) {
      throw new Error('WorkaroundStateStore.open() must be called before use');
    }
    return this.db;
  }
}

interface StateRow {
  installed_agent_id: string;
  workaround_id: string;
  status: string;
  resolved_at: number | null;
  last_status_lookup_at: number | null;
  patch_context_json: string | null;
  created_at: number;
}

function rowToState(row: StateRow): WorkaroundOperationalState {
  return {
    installedAgentId: row.installed_agent_id,
    workaroundId: row.workaround_id,
    status: row.status === 'resolved' ? 'resolved' : 'active',
    resolvedAt: row.resolved_at,
    lastStatusLookupAt: row.last_status_lookup_at,
    patchContext: row.patch_context_json
      ? (JSON.parse(row.patch_context_json) as WorkaroundPatchContext)
      : null,
    createdAt: row.created_at,
  };
}
