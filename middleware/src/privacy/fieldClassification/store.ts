/**
 * Field classification (#1556 follow-up) — persistence.
 *
 * `privacy_field_candidates` (one row per tool + scope + field path),
 * `privacy_model_verdicts` (cached schema-only verdicts) and
 * `privacy_field_classification_visits` (per-admin last visit), created by
 * `migrations/0065_privacy_field_classification.sql`;
 * `privacy_field_bulk_batches` (bulk accepts, for undo) and
 * `decision_batch_id` from `0066_privacy_field_auto_approve.sql`. Every
 * statement is parameterized. No column holds a field value.
 *
 * `InMemoryFieldClassificationStore` is the same contract without Postgres,
 * for tests and for the in-memory backend's absence of a pool.
 */

import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import type { FieldObservation, FieldValueShape, ModelPersonalVerdict } from '@omadia/plugin-api';

import type {
  DecisionAction,
  FieldReason,
  FieldStatus,
  SampleVerdictSummary,
} from './engine.js';
import { isValidFieldIdentity } from './engine.js';

export interface CandidateDecision {
  readonly action: DecisionAction;
  readonly fingerprint: string;
  readonly byId: string | null;
  readonly byEmail: string | null;
  readonly at: string;
  /** The bulk batch the decision belongs to; null / absent for one field. */
  readonly batchId?: string | null;
}

/**
 * What a decision write expects to replace (compare-and-set): the decision
 * the caller read (`null` = none) and the candidate's fingerprint then. A
 * write whose expectation no longer holds — an admin or a recompute decided
 * meanwhile, or the field changed — is not made.
 */
export interface DecisionExpectation {
  readonly decision: Pick<CandidateDecision, 'action' | 'fingerprint' | 'at'> | null;
  readonly fingerprint: string;
}

/** The same decision (action, fingerprint decided on, time)? */
export function sameDecision(
  a: Pick<CandidateDecision, 'action' | 'fingerprint' | 'at'> | null,
  b: Pick<CandidateDecision, 'action' | 'fingerprint' | 'at'> | null,
): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.action === b.action &&
    a.fingerprint === b.fingerprint &&
    new Date(a.at).getTime() === new Date(b.at).getTime()
  );
}

/** One entry a bulk accept wrote. */
export interface BulkBatchEntry {
  readonly candidateId: string;
  readonly entry: string;
}

export interface BulkBatch {
  readonly id: string;
  readonly actorId: string | null;
  readonly actorEmail: string | null;
  readonly createdAt: string;
  readonly undoneAt: string | null;
  readonly undoneBy: string | null;
  readonly entries: readonly BulkBatchEntry[];
}

export interface FieldCandidate {
  readonly id: string;
  readonly toolName: string;
  /** An Odoo model, a dataset id, or `-`. */
  readonly scope: string;
  readonly fieldPath: string;
  /** The field's schema label where the source has one; never a value. */
  readonly label: string | null;
  readonly valueShape: FieldValueShape;
  readonly relationModels: readonly string[];
  readonly status: FieldStatus;
  readonly reasons: readonly FieldReason[];
  readonly fingerprint: string;
  readonly sampleVerdict: SampleVerdictSummary | null;
  /** Shape-masked preview strings (no letter or digit survives). */
  readonly maskedPreview: readonly string[];
  readonly decision: CandidateDecision | null;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly seenCount: number;
  readonly computedAt: string | null;
  readonly lastStatusChangeAt: string;
}

export interface CandidateClassificationUpdate {
  readonly relationModels: readonly string[];
  readonly status: FieldStatus;
  readonly reasons: readonly FieldReason[];
  readonly fingerprint: string;
  /** `undefined` keeps the stored verdict. */
  readonly sampleVerdict?: SampleVerdictSummary;
  /** `undefined` or empty keeps the stored preview. */
  readonly maskedPreview?: readonly string[];
  readonly computedAt: string;
}

export interface StoredModelVerdict {
  readonly model: string;
  readonly verdict: ModelPersonalVerdict;
  readonly source: 'builtin' | 'haiku';
  readonly confidence: number;
  readonly reason: string;
  /** A source verdict's field-set hash (`sourceFieldsHash`); empty for a
   *  relation target. */
  readonly fieldsHash: string;
  readonly decidedAt: string;
}

export interface OpenFieldCounts {
  readonly needsClarification: number;
  readonly suggested: number;
  /** Confirmed fields that now point to a person model or changed since. */
  readonly confirmedConflict: number;
  /** Auto-approvals the recompute took back; they need review. */
  readonly autoRevoked: number;
  /** Fields auto-approved after the visitor's last visit of the page; 0
   *  without a visitor or a recorded visit. */
  readonly autoApprovedNew: number;
}

export interface FieldClassificationStore {
  list(filter?: { readonly toolName?: string }): Promise<FieldCandidate[]>;
  get(id: string): Promise<FieldCandidate | undefined>;
  /** Insert or merge one observation per tool + scope + field (counts add
   *  up, the latest label wins). */
  upsertObservation(obs: FieldObservation): Promise<void>;
  /** Insert a field read from a source's schema (`seenCount` 0) unless the
   *  tool + scope + field already exists; an existing row is left as is.
   *  The first real observation then sets its first-seen time. */
  seedField(obs: FieldObservation): Promise<void>;
  saveClassification(id: string, update: CandidateClassificationUpdate): Promise<void>;
  /** Set (or with `null` clear) the decision and the shown status. With
   *  `expected`, compare-and-set: written only while the stored decision and
   *  fingerprint still match it. True when the row was written. */
  saveDecision(
    id: string,
    decision: CandidateDecision | null,
    status: FieldStatus,
    expected?: DecisionExpectation,
  ): Promise<boolean>;
  modelVerdicts(models: readonly string[], notBefore: Date): Promise<StoredModelVerdict[]>;
  saveModelVerdicts(verdicts: readonly Omit<StoredModelVerdict, 'decidedAt'>[]): Promise<void>;
  /** Fields an admin still has to look at, per open status (a decision
   *  moves the status away from each of them). */
  countOpen(visitor?: string): Promise<OpenFieldCounts>;
  lastComputedAt(): Promise<string | null>;
  lastVisit(actor: string): Promise<string | null>;
  markVisit(actor: string, at: Date): Promise<void>;
  /** Record a bulk accept; returns its id. */
  createBulkBatch(batch: {
    readonly actorId: string | null;
    readonly actorEmail: string | null;
    readonly entries: readonly BulkBatchEntry[];
  }): Promise<string>;
  getBulkBatch(id: string): Promise<BulkBatch | undefined>;
  /** The most recent batch not undone yet. */
  latestOpenBulkBatch(): Promise<BulkBatch | undefined>;
  /** Mark a batch undone; false when it already was (or does not exist). */
  markBulkBatchUndone(id: string, by: string, at: Date): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

interface CandidateRow {
  id: string;
  tool_name: string;
  scope: string;
  field_path: string;
  label: string | null;
  value_shape: FieldValueShape;
  relation_models: string[];
  status: FieldStatus;
  reasons: FieldReason[] | null;
  fingerprint: string;
  sample_verdict: SampleVerdictSummary | null;
  masked_preview: string[] | null;
  decision: DecisionAction | null;
  decision_fingerprint: string | null;
  decided_by_id: string | null;
  decided_by_email: string | null;
  decided_at: Date | null;
  decision_batch_id: string | null;
  first_seen_at: Date;
  last_seen_at: Date;
  seen_count: number;
  computed_at: Date | null;
  last_status_change_at: Date;
}

const CANDIDATE_COLS = `id, tool_name, scope, field_path, label, value_shape, relation_models,
  status, reasons, fingerprint, sample_verdict, masked_preview, decision, decision_fingerprint, decided_by_id,
  decided_by_email, decided_at, decision_batch_id, first_seen_at, last_seen_at, seen_count, computed_at,
  last_status_change_at`;

function toCandidate(row: CandidateRow): FieldCandidate {
  return {
    id: row.id,
    toolName: row.tool_name,
    scope: row.scope,
    fieldPath: row.field_path,
    label: row.label,
    valueShape: row.value_shape,
    relationModels: row.relation_models,
    status: row.status,
    reasons: row.reasons ?? [],
    fingerprint: row.fingerprint,
    sampleVerdict: row.sample_verdict,
    maskedPreview: row.masked_preview ?? [],
    decision:
      row.decision !== null && row.decided_at !== null
        ? {
            action: row.decision,
            fingerprint: row.decision_fingerprint ?? '',
            byId: row.decided_by_id,
            byEmail: row.decided_by_email,
            at: row.decided_at.toISOString(),
            batchId: row.decision_batch_id,
          }
        : null,
    firstSeenAt: row.first_seen_at.toISOString(),
    lastSeenAt: row.last_seen_at.toISOString(),
    seenCount: row.seen_count,
    computedAt: row.computed_at?.toISOString() ?? null,
    lastStatusChangeAt: row.last_status_change_at.toISOString(),
  };
}

/** Open counts from the listable rows: their status and, for
 *  `auto_approved`, when they were decided. */
function countOpenOf(
  rows: readonly { readonly status: FieldStatus; readonly decidedAt: string | null }[],
  lastVisit: string | null,
): OpenFieldCounts {
  const of = (status: FieldStatus): number => rows.filter((r) => r.status === status).length;
  return {
    needsClarification: of('needs_clarification'),
    suggested: of('suggested'),
    confirmedConflict: of('confirmed_conflict'),
    autoRevoked: of('auto_revoked'),
    autoApprovedNew:
      lastVisit === null
        ? 0
        : rows.filter((r) => r.status === 'auto_approved' && r.decidedAt !== null && r.decidedAt > lastVisit)
            .length,
  };
}

interface BulkBatchRow {
  id: string;
  actor_id: string | null;
  actor_email: string | null;
  created_at: Date;
  undone_at: Date | null;
  undone_by: string | null;
  entries: BulkBatchEntry[];
}

const BULK_COLS = 'id, actor_id, actor_email, created_at, undone_at, undone_by, entries';

function toBulkBatch(row: BulkBatchRow): BulkBatch {
  return {
    id: row.id,
    actorId: row.actor_id,
    actorEmail: row.actor_email,
    createdAt: row.created_at.toISOString(),
    undoneAt: row.undone_at?.toISOString() ?? null,
    undoneBy: row.undone_by,
    entries: Array.isArray(row.entries) ? row.entries : [],
  };
}

export class PgFieldClassificationStore implements FieldClassificationStore {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async list(filter: { readonly toolName?: string } = {}): Promise<FieldCandidate[]> {
    const result =
      filter.toolName !== undefined
        ? await this.pool.query<CandidateRow>(
            `SELECT ${CANDIDATE_COLS} FROM privacy_field_candidates
              WHERE tool_name = $1 ORDER BY tool_name, scope, field_path`,
            [filter.toolName],
          )
        : await this.pool.query<CandidateRow>(
            `SELECT ${CANDIDATE_COLS} FROM privacy_field_candidates ORDER BY tool_name, scope, field_path`,
          );
    return result.rows.map(toCandidate);
  }

  async get(id: string): Promise<FieldCandidate | undefined> {
    const result = await this.pool.query<CandidateRow>(
      `SELECT ${CANDIDATE_COLS} FROM privacy_field_candidates WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? toCandidate(row) : undefined;
  }

  async upsertObservation(obs: FieldObservation): Promise<void> {
    await this.pool.query(
      `INSERT INTO privacy_field_candidates
         (tool_name, scope, field_path, label, value_shape, seen_count, first_seen_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (tool_name, scope, field_path) DO UPDATE SET
         value_shape   = EXCLUDED.value_shape,
         label         = COALESCE(EXCLUDED.label, privacy_field_candidates.label),
         seen_count    = privacy_field_candidates.seen_count + EXCLUDED.seen_count,
         -- A row seeded from the schema (seen 0 times) was never seen: its
         -- first real sighting is this one.
         first_seen_at = CASE WHEN privacy_field_candidates.seen_count = 0
                           THEN EXCLUDED.first_seen_at
                           ELSE LEAST(privacy_field_candidates.first_seen_at, EXCLUDED.first_seen_at) END,
         last_seen_at  = GREATEST(privacy_field_candidates.last_seen_at, EXCLUDED.last_seen_at)`,
      [
        obs.toolName,
        obs.scope,
        obs.fieldPath,
        obs.label ?? null,
        obs.valueShape,
        obs.seenCount,
        obs.firstSeenAt,
        obs.lastSeenAt,
      ],
    );
  }

  async seedField(obs: FieldObservation): Promise<void> {
    await this.pool.query(
      `INSERT INTO privacy_field_candidates
         (tool_name, scope, field_path, label, value_shape, seen_count, first_seen_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, 0, $6, $7)
       ON CONFLICT (tool_name, scope, field_path) DO NOTHING`,
      [obs.toolName, obs.scope, obs.fieldPath, obs.label ?? null, obs.valueShape, obs.firstSeenAt, obs.lastSeenAt],
    );
  }

  async saveClassification(id: string, update: CandidateClassificationUpdate): Promise<void> {
    await this.pool.query(
      `UPDATE privacy_field_candidates SET
         relation_models = $2::text[],
         last_status_change_at = CASE WHEN status IS DISTINCT FROM $3 THEN NOW() ELSE last_status_change_at END,
         status = $3,
         reasons = $4::jsonb,
         fingerprint = $5,
         sample_verdict = COALESCE($6::jsonb, sample_verdict),
         computed_at = $7,
         masked_preview = CASE WHEN cardinality($8::text[]) > 0 THEN $8::text[] ELSE masked_preview END
       WHERE id = $1`,
      [
        id,
        [...update.relationModels],
        update.status,
        JSON.stringify(update.reasons),
        update.fingerprint,
        update.sampleVerdict !== undefined ? JSON.stringify(update.sampleVerdict) : null,
        update.computedAt,
        [...(update.maskedPreview ?? [])],
      ],
    );
  }

  async saveDecision(
    id: string,
    decision: CandidateDecision | null,
    status: FieldStatus,
    expected?: DecisionExpectation,
  ): Promise<boolean> {
    const params: unknown[] = [
      id,
      decision?.action ?? null,
      decision?.fingerprint ?? null,
      decision?.byId ?? null,
      decision?.byEmail ?? null,
      decision?.at ?? null,
      status,
      decision?.batchId ?? null,
    ];
    let guard = '';
    if (expected !== undefined) {
      params.push(expected.fingerprint);
      guard = ` AND fingerprint = $${String(params.length)}`;
      if (expected.decision === null) {
        // `toCandidate` reads a row without a decision time as undecided.
        guard += ' AND (decision IS NULL OR decided_at IS NULL)';
      } else {
        params.push(expected.decision.action, expected.decision.fingerprint, expected.decision.at);
        const n = params.length;
        guard +=
          ` AND decision = $${String(n - 2)} AND COALESCE(decision_fingerprint, '') = $${String(n - 1)}` +
          ` AND decided_at = $${String(n)}::timestamptz`;
      }
    }
    const result = await this.pool.query(
      `UPDATE privacy_field_candidates SET
         decision = $2, decision_fingerprint = $3, decided_by_id = $4,
         decided_by_email = $5, decided_at = $6, decision_batch_id = $8,
         last_status_change_at = CASE WHEN status IS DISTINCT FROM $7 THEN NOW() ELSE last_status_change_at END,
         status = $7
       WHERE id = $1${guard}`,
      params,
    );
    return (result.rowCount ?? 0) > 0;
  }

  async modelVerdicts(models: readonly string[], notBefore: Date): Promise<StoredModelVerdict[]> {
    if (models.length === 0) return [];
    const result = await this.pool.query<{
      model: string;
      verdict: ModelPersonalVerdict;
      source: 'builtin' | 'haiku';
      confidence: number;
      reason: string;
      fields_hash: string;
      decided_at: Date;
    }>(
      `SELECT model, verdict, source, confidence, reason, fields_hash, decided_at
         FROM privacy_model_verdicts
        WHERE model = ANY($1::text[]) AND decided_at >= $2`,
      [[...models], notBefore.toISOString()],
    );
    return result.rows.map((r) => ({
      model: r.model,
      verdict: r.verdict,
      source: r.source,
      confidence: Number(r.confidence),
      reason: r.reason,
      fieldsHash: r.fields_hash,
      decidedAt: r.decided_at.toISOString(),
    }));
  }

  async saveModelVerdicts(
    verdicts: readonly Omit<StoredModelVerdict, 'decidedAt'>[],
  ): Promise<void> {
    for (const v of verdicts) {
      await this.pool.query(
        `INSERT INTO privacy_model_verdicts
           (model, verdict, source, confidence, reason, fields_hash, decided_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (model) DO UPDATE SET
           verdict = EXCLUDED.verdict, source = EXCLUDED.source,
           confidence = EXCLUDED.confidence, reason = EXCLUDED.reason,
           fields_hash = EXCLUDED.fields_hash,
           decided_at = EXCLUDED.decided_at`,
        [v.model, v.verdict, v.source, v.confidence, v.reason, v.fieldsHash],
      );
    }
  }

  async countOpen(visitor?: string): Promise<OpenFieldCounts> {
    const result = await this.pool.query<{
      tool_name: string;
      scope: string;
      field_path: string;
      status: FieldStatus;
      decided_at: Date | null;
    }>(
      `SELECT tool_name, scope, field_path, status, decided_at FROM privacy_field_candidates
        WHERE status IN ('needs_clarification', 'suggested', 'confirmed_conflict',
                         'auto_revoked', 'auto_approved')`,
    );
    const lastVisit = visitor !== undefined ? await this.lastVisit(visitor) : null;
    // The page hides rows that cannot form one scoped entry (the grammar
    // lives in the guard's parser, not in SQL); so does the count.
    return countOpenOf(
      result.rows
        .filter((r) =>
          isValidFieldIdentity({ toolName: r.tool_name, scope: r.scope, fieldPath: r.field_path }),
        )
        .map((r) => ({ status: r.status, decidedAt: r.decided_at?.toISOString() ?? null })),
      lastVisit,
    );
  }

  async lastComputedAt(): Promise<string | null> {
    const result = await this.pool.query<{ at: Date | null }>(
      `SELECT MAX(computed_at) AS at FROM privacy_field_candidates`,
    );
    return result.rows[0]?.at?.toISOString() ?? null;
  }

  async lastVisit(actor: string): Promise<string | null> {
    const result = await this.pool.query<{ visited_at: Date }>(
      `SELECT visited_at FROM privacy_field_classification_visits WHERE actor = $1`,
      [actor],
    );
    return result.rows[0]?.visited_at.toISOString() ?? null;
  }

  async markVisit(actor: string, at: Date): Promise<void> {
    await this.pool.query(
      `INSERT INTO privacy_field_classification_visits (actor, visited_at) VALUES ($1, $2)
       ON CONFLICT (actor) DO UPDATE SET visited_at = EXCLUDED.visited_at`,
      [actor, at.toISOString()],
    );
  }

  async createBulkBatch(batch: {
    readonly actorId: string | null;
    readonly actorEmail: string | null;
    readonly entries: readonly BulkBatchEntry[];
  }): Promise<string> {
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO privacy_field_bulk_batches (actor_id, actor_email, entries)
       VALUES ($1, $2, $3::jsonb) RETURNING id`,
      [batch.actorId, batch.actorEmail, JSON.stringify(batch.entries)],
    );
    const id = result.rows[0]?.id;
    if (id === undefined) throw new Error('bulk batch insert returned no id');
    return id;
  }

  async getBulkBatch(id: string): Promise<BulkBatch | undefined> {
    const result = await this.pool.query<BulkBatchRow>(
      `SELECT ${BULK_COLS} FROM privacy_field_bulk_batches WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? toBulkBatch(row) : undefined;
  }

  async latestOpenBulkBatch(): Promise<BulkBatch | undefined> {
    const result = await this.pool.query<BulkBatchRow>(
      `SELECT ${BULK_COLS} FROM privacy_field_bulk_batches
        WHERE undone_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 1`,
    );
    const row = result.rows[0];
    return row ? toBulkBatch(row) : undefined;
  }

  async markBulkBatchUndone(id: string, by: string, at: Date): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE privacy_field_bulk_batches SET undone_at = $2, undone_by = $3
        WHERE id = $1 AND undone_at IS NULL`,
      [id, at.toISOString(), by],
    );
    return (result.rowCount ?? 0) > 0;
  }
}

// ---------------------------------------------------------------------------
// In memory
// ---------------------------------------------------------------------------

export class InMemoryFieldClassificationStore implements FieldClassificationStore {
  private readonly rows = new Map<string, FieldCandidate>();
  private readonly verdicts = new Map<string, StoredModelVerdict>();
  private readonly visits = new Map<string, string>();
  private readonly batches = new Map<string, BulkBatch>();
  private batchSeq = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  async list(filter: { readonly toolName?: string } = {}): Promise<FieldCandidate[]> {
    return [...this.rows.values()]
      .filter((r) => filter.toolName === undefined || r.toolName === filter.toolName)
      .sort(
        (a, b) =>
          a.toolName.localeCompare(b.toolName) ||
          a.scope.localeCompare(b.scope) ||
          a.fieldPath.localeCompare(b.fieldPath),
      );
  }

  async get(id: string): Promise<FieldCandidate | undefined> {
    return this.rows.get(id);
  }

  async upsertObservation(obs: FieldObservation): Promise<void> {
    const existing = [...this.rows.values()].find(
      (r) => r.toolName === obs.toolName && r.scope === obs.scope && r.fieldPath === obs.fieldPath,
    );
    if (existing === undefined) {
      const id = randomUUID();
      this.rows.set(id, {
        id,
        toolName: obs.toolName,
        scope: obs.scope,
        fieldPath: obs.fieldPath,
        label: obs.label ?? null,
        valueShape: obs.valueShape,
        relationModels: [],
        status: 'needs_clarification',
        reasons: [],
        fingerprint: '',
        sampleVerdict: null,
        maskedPreview: [],
        decision: null,
        firstSeenAt: obs.firstSeenAt,
        lastSeenAt: obs.lastSeenAt,
        seenCount: obs.seenCount,
        computedAt: null,
        lastStatusChangeAt: this.now().toISOString(),
      });
      return;
    }
    this.rows.set(existing.id, {
      ...existing,
      valueShape: obs.valueShape,
      label: obs.label ?? existing.label,
      seenCount: existing.seenCount + obs.seenCount,
      firstSeenAt:
        existing.seenCount === 0 || obs.firstSeenAt < existing.firstSeenAt
          ? obs.firstSeenAt
          : existing.firstSeenAt,
      lastSeenAt: obs.lastSeenAt > existing.lastSeenAt ? obs.lastSeenAt : existing.lastSeenAt,
    });
  }

  async seedField(obs: FieldObservation): Promise<void> {
    const exists = [...this.rows.values()].some(
      (r) => r.toolName === obs.toolName && r.scope === obs.scope && r.fieldPath === obs.fieldPath,
    );
    if (!exists) await this.upsertObservation({ ...obs, seenCount: 0 });
  }

  async saveClassification(id: string, update: CandidateClassificationUpdate): Promise<void> {
    const row = this.rows.get(id);
    if (row === undefined) return;
    this.rows.set(id, {
      ...row,
      relationModels: [...update.relationModels],
      status: update.status,
      reasons: update.reasons,
      fingerprint: update.fingerprint,
      sampleVerdict: update.sampleVerdict ?? row.sampleVerdict,
      maskedPreview:
        update.maskedPreview !== undefined && update.maskedPreview.length > 0
          ? [...update.maskedPreview]
          : row.maskedPreview,
      computedAt: update.computedAt,
      lastStatusChangeAt:
        row.status !== update.status ? this.now().toISOString() : row.lastStatusChangeAt,
    });
  }

  async saveDecision(
    id: string,
    decision: CandidateDecision | null,
    status: FieldStatus,
    expected?: DecisionExpectation,
  ): Promise<boolean> {
    const row = this.rows.get(id);
    if (row === undefined) return false;
    if (
      expected !== undefined &&
      (row.fingerprint !== expected.fingerprint || !sameDecision(row.decision, expected.decision))
    ) {
      return false;
    }
    this.rows.set(id, {
      ...row,
      decision,
      status,
      lastStatusChangeAt: row.status !== status ? this.now().toISOString() : row.lastStatusChangeAt,
    });
    return true;
  }

  async modelVerdicts(models: readonly string[], notBefore: Date): Promise<StoredModelVerdict[]> {
    return models
      .map((m) => this.verdicts.get(m))
      .filter((v): v is StoredModelVerdict => v !== undefined && v.decidedAt >= notBefore.toISOString());
  }

  async saveModelVerdicts(
    verdicts: readonly Omit<StoredModelVerdict, 'decidedAt'>[],
  ): Promise<void> {
    const at = this.now().toISOString();
    for (const v of verdicts) this.verdicts.set(v.model, { ...v, decidedAt: at });
  }

  async countOpen(visitor?: string): Promise<OpenFieldCounts> {
    return countOpenOf(
      [...this.rows.values()]
        .filter((r) => isValidFieldIdentity(r))
        .map((r) => ({ status: r.status, decidedAt: r.decision?.at ?? null })),
      visitor !== undefined ? await this.lastVisit(visitor) : null,
    );
  }

  async lastComputedAt(): Promise<string | null> {
    let max: string | null = null;
    for (const r of this.rows.values()) {
      if (r.computedAt !== null && (max === null || r.computedAt > max)) max = r.computedAt;
    }
    return max;
  }

  async lastVisit(actor: string): Promise<string | null> {
    return this.visits.get(actor) ?? null;
  }

  async markVisit(actor: string, at: Date): Promise<void> {
    this.visits.set(actor, at.toISOString());
  }

  async createBulkBatch(batch: {
    readonly actorId: string | null;
    readonly actorEmail: string | null;
    readonly entries: readonly BulkBatchEntry[];
  }): Promise<string> {
    const id = randomUUID();
    // A sequence keeps `latestOpenBulkBatch` exact within one millisecond.
    this.batchSeq += 1;
    const createdAt = new Date(this.now().getTime() + this.batchSeq).toISOString();
    this.batches.set(id, {
      id,
      actorId: batch.actorId,
      actorEmail: batch.actorEmail,
      createdAt,
      undoneAt: null,
      undoneBy: null,
      entries: [...batch.entries],
    });
    return id;
  }

  async getBulkBatch(id: string): Promise<BulkBatch | undefined> {
    return this.batches.get(id);
  }

  async latestOpenBulkBatch(): Promise<BulkBatch | undefined> {
    return [...this.batches.values()]
      .filter((b) => b.undoneAt === null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  }

  async markBulkBatchUndone(id: string, by: string, at: Date): Promise<boolean> {
    const batch = this.batches.get(id);
    if (batch === undefined || batch.undoneAt !== null) return false;
    this.batches.set(id, { ...batch, undoneAt: at.toISOString(), undoneBy: by });
    return true;
  }
}
