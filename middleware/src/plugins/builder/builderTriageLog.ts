import { randomUUID } from 'node:crypto';

import Database from 'better-sqlite3';
import type { Database as SqliteDatabase } from 'better-sqlite3';

import type { TriageClassification } from './platformIssueTriage.js';

/**
 * Persisted triage log (concept plan: docs/plans/native-issue-reporting.md).
 *
 * Two responsibilities:
 *
 *   1. Capture every triage decision (incl. discarded ones) so the
 *      operator can see in the Builder UI that the system actually
 *      considered the failure. This avoids the "system felt broken
 *      because it never tried" failure mode.
 *
 *   2. Serve as the local rate-limit source — at most 3 `platform`
 *      classifications per operator per 24 h end up as new issue
 *      submissions. The counter ignores `agent`/`ambiguous` entries
 *      and only counts platform-classified rows.
 *
 * Backed by the v2 `builder_triage_log` table.
 */

export interface TriageLogEntry {
  id: string;
  draftId: string;
  userEmail: string;
  fingerprint: string;
  classification: TriageClassification;
  confidence: number;
  reason: string;
  createdAt: number;
}

export interface BuilderTriageLogOptions {
  dbPath: string;
  /** Time window (ms) for the platform-classification rate-limit count.
   *  Default 24 hours. */
  rateWindowMs?: number;
  now?: () => number;
}

const DEFAULT_RATE_WINDOW_MS = 24 * 60 * 60 * 1000;

export class BuilderTriageLog {
  private db: SqliteDatabase | null = null;
  private readonly dbPath: string;
  private readonly rateWindowMs: number;
  private readonly now: () => number;

  constructor(opts: BuilderTriageLogOptions) {
    this.dbPath = opts.dbPath;
    this.rateWindowMs = opts.rateWindowMs ?? DEFAULT_RATE_WINDOW_MS;
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

  record(input: {
    draftId: string;
    userEmail: string;
    fingerprint: string;
    classification: TriageClassification;
    confidence: number;
    reason: string;
  }): TriageLogEntry {
    const db = this.required();
    const id = randomUUID();
    const createdAt = this.now();
    db.prepare(
      `INSERT INTO builder_triage_log
        (id, draft_id, user_email, fingerprint, classification, confidence, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.draftId,
      input.userEmail,
      input.fingerprint,
      input.classification,
      input.confidence,
      input.reason,
      createdAt,
    );
    return { id, createdAt, ...input };
  }

  /**
   * Count of `platform`-classified entries the given operator wrote
   * inside the rate window. The caller uses this against the per-day
   * cap (default 3) before promoting a triage to an issue submission.
   */
  platformCountInWindow(userEmail: string): number {
    const db = this.required();
    const cutoff = this.now() - this.rateWindowMs;
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM builder_triage_log
         WHERE user_email = ? AND classification = 'platform' AND created_at >= ?`,
      )
      .get(userEmail, cutoff) as { n: number };
    return row.n;
  }

  /**
   * Recent triage decisions for a draft, newest first. Surfaced in
   * the Builder UI as the "Triage notiert" hint.
   */
  recent(draftId: string, limit = 20): TriageLogEntry[] {
    const db = this.required();
    const rows = db
      .prepare(
        `SELECT id, draft_id, user_email, fingerprint, classification, confidence, reason, created_at
         FROM builder_triage_log
         WHERE draft_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(draftId, limit) as Array<{
      id: string;
      draft_id: string;
      user_email: string;
      fingerprint: string;
      classification: string;
      confidence: number;
      reason: string;
      created_at: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      draftId: r.draft_id,
      userEmail: r.user_email,
      fingerprint: r.fingerprint,
      classification: normalizeClassification(r.classification),
      confidence: r.confidence,
      reason: r.reason,
      createdAt: r.created_at,
    }));
  }

  private required(): SqliteDatabase {
    if (!this.db) {
      throw new Error('BuilderTriageLog.open() must be called before use');
    }
    return this.db;
  }
}

function normalizeClassification(value: string): TriageClassification {
  if (value === 'platform' || value === 'agent' || value === 'ambiguous') {
    return value;
  }
  return 'ambiguous';
}
