/**
 * Field classification (#1556 follow-up) — persistence.
 *
 * `privacy_field_candidates` (one row per tool + field path),
 * `privacy_model_verdicts` (cached schema-only verdicts) and
 * `privacy_field_classification_visits` (per-admin last visit), created by
 * `migrations/0065_privacy_field_classification.sql`. Every statement is
 * parameterized. No column holds a field value.
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

export interface CandidateDecision {
  readonly action: DecisionAction;
  readonly fingerprint: string;
  readonly byId: string | null;
  readonly byEmail: string | null;
  readonly at: string;
}

export interface FieldCandidate {
  readonly id: string;
  readonly toolName: string;
  readonly fieldPath: string;
  readonly valueShape: FieldValueShape;
  readonly sourceModels: readonly string[];
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
  readonly decidedAt: string;
}

export interface OpenFieldCounts {
  readonly needsClarification: number;
  readonly suggested: number;
  /** Confirmed fields that now point to a person model or changed since. */
  readonly confirmedConflict: number;
}

export interface FieldClassificationStore {
  list(filter?: { readonly toolName?: string }): Promise<FieldCandidate[]>;
  get(id: string): Promise<FieldCandidate | undefined>;
  /** Insert or merge one observation (source models union, counts add up). */
  upsertObservation(obs: FieldObservation): Promise<void>;
  saveClassification(id: string, update: CandidateClassificationUpdate): Promise<void>;
  /** Set (or with `null` clear) the admin decision and the shown status. */
  saveDecision(id: string, decision: CandidateDecision | null, status: FieldStatus): Promise<void>;
  modelVerdicts(models: readonly string[], notBefore: Date): Promise<StoredModelVerdict[]>;
  saveModelVerdicts(verdicts: readonly Omit<StoredModelVerdict, 'decidedAt'>[]): Promise<void>;
  /** Fields an admin still has to look at, per open status (a decision
   *  moves the status away from each of them). */
  countOpen(): Promise<OpenFieldCounts>;
  lastComputedAt(): Promise<string | null>;
  lastVisit(actor: string): Promise<string | null>;
  markVisit(actor: string, at: Date): Promise<void>;
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

interface CandidateRow {
  id: string;
  tool_name: string;
  field_path: string;
  value_shape: FieldValueShape;
  source_models: string[];
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
  first_seen_at: Date;
  last_seen_at: Date;
  seen_count: number;
  computed_at: Date | null;
  last_status_change_at: Date;
}

const CANDIDATE_COLS = `id, tool_name, field_path, value_shape, source_models, relation_models,
  status, reasons, fingerprint, sample_verdict, masked_preview, decision, decision_fingerprint, decided_by_id,
  decided_by_email, decided_at, first_seen_at, last_seen_at, seen_count, computed_at,
  last_status_change_at`;

function toCandidate(row: CandidateRow): FieldCandidate {
  return {
    id: row.id,
    toolName: row.tool_name,
    fieldPath: row.field_path,
    valueShape: row.value_shape,
    sourceModels: row.source_models,
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
          }
        : null,
    firstSeenAt: row.first_seen_at.toISOString(),
    lastSeenAt: row.last_seen_at.toISOString(),
    seenCount: row.seen_count,
    computedAt: row.computed_at?.toISOString() ?? null,
    lastStatusChangeAt: row.last_status_change_at.toISOString(),
  };
}

export class PgFieldClassificationStore implements FieldClassificationStore {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async list(filter: { readonly toolName?: string } = {}): Promise<FieldCandidate[]> {
    const result =
      filter.toolName !== undefined
        ? await this.pool.query<CandidateRow>(
            `SELECT ${CANDIDATE_COLS} FROM privacy_field_candidates
              WHERE tool_name = $1 ORDER BY tool_name, field_path`,
            [filter.toolName],
          )
        : await this.pool.query<CandidateRow>(
            `SELECT ${CANDIDATE_COLS} FROM privacy_field_candidates ORDER BY tool_name, field_path`,
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
         (tool_name, field_path, value_shape, source_models, seen_count, first_seen_at, last_seen_at)
       VALUES ($1, $2, $3, $4::text[], $5, $6, $7)
       ON CONFLICT (tool_name, field_path) DO UPDATE SET
         value_shape   = EXCLUDED.value_shape,
         source_models = ARRAY(
           SELECT DISTINCT m FROM unnest(privacy_field_candidates.source_models || EXCLUDED.source_models) AS m
            ORDER BY m),
         seen_count    = privacy_field_candidates.seen_count + EXCLUDED.seen_count,
         first_seen_at = LEAST(privacy_field_candidates.first_seen_at, EXCLUDED.first_seen_at),
         last_seen_at  = GREATEST(privacy_field_candidates.last_seen_at, EXCLUDED.last_seen_at)`,
      [
        obs.toolName,
        obs.fieldPath,
        obs.valueShape,
        [...new Set(obs.sourceModels)].sort(),
        obs.seenCount,
        obs.firstSeenAt,
        obs.lastSeenAt,
      ],
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
  ): Promise<void> {
    await this.pool.query(
      `UPDATE privacy_field_candidates SET
         decision = $2, decision_fingerprint = $3, decided_by_id = $4,
         decided_by_email = $5, decided_at = $6,
         last_status_change_at = CASE WHEN status IS DISTINCT FROM $7 THEN NOW() ELSE last_status_change_at END,
         status = $7
       WHERE id = $1`,
      [
        id,
        decision?.action ?? null,
        decision?.fingerprint ?? null,
        decision?.byId ?? null,
        decision?.byEmail ?? null,
        decision?.at ?? null,
        status,
      ],
    );
  }

  async modelVerdicts(models: readonly string[], notBefore: Date): Promise<StoredModelVerdict[]> {
    if (models.length === 0) return [];
    const result = await this.pool.query<{
      model: string;
      verdict: ModelPersonalVerdict;
      source: 'builtin' | 'haiku';
      confidence: number;
      reason: string;
      decided_at: Date;
    }>(
      `SELECT model, verdict, source, confidence, reason, decided_at
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
      decidedAt: r.decided_at.toISOString(),
    }));
  }

  async saveModelVerdicts(
    verdicts: readonly Omit<StoredModelVerdict, 'decidedAt'>[],
  ): Promise<void> {
    for (const v of verdicts) {
      await this.pool.query(
        `INSERT INTO privacy_model_verdicts (model, verdict, source, confidence, reason, decided_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (model) DO UPDATE SET
           verdict = EXCLUDED.verdict, source = EXCLUDED.source,
           confidence = EXCLUDED.confidence, reason = EXCLUDED.reason,
           decided_at = EXCLUDED.decided_at`,
        [v.model, v.verdict, v.source, v.confidence, v.reason],
      );
    }
  }

  async countOpen(): Promise<OpenFieldCounts> {
    const result = await this.pool.query<{ status: string; n: string }>(
      `SELECT status, COUNT(*)::text AS n FROM privacy_field_candidates
        WHERE status IN ('needs_clarification', 'suggested', 'confirmed_conflict')
        GROUP BY status`,
    );
    const of = (status: string): number =>
      Number(result.rows.find((r) => r.status === status)?.n ?? 0);
    return {
      needsClarification: of('needs_clarification'),
      suggested: of('suggested'),
      confirmedConflict: of('confirmed_conflict'),
    };
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
}

// ---------------------------------------------------------------------------
// In memory
// ---------------------------------------------------------------------------

export class InMemoryFieldClassificationStore implements FieldClassificationStore {
  private readonly rows = new Map<string, FieldCandidate>();
  private readonly verdicts = new Map<string, StoredModelVerdict>();
  private readonly visits = new Map<string, string>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async list(filter: { readonly toolName?: string } = {}): Promise<FieldCandidate[]> {
    return [...this.rows.values()]
      .filter((r) => filter.toolName === undefined || r.toolName === filter.toolName)
      .sort((a, b) =>
        a.toolName === b.toolName
          ? a.fieldPath.localeCompare(b.fieldPath)
          : a.toolName.localeCompare(b.toolName),
      );
  }

  async get(id: string): Promise<FieldCandidate | undefined> {
    return this.rows.get(id);
  }

  async upsertObservation(obs: FieldObservation): Promise<void> {
    const existing = [...this.rows.values()].find(
      (r) => r.toolName === obs.toolName && r.fieldPath === obs.fieldPath,
    );
    if (existing === undefined) {
      const id = randomUUID();
      this.rows.set(id, {
        id,
        toolName: obs.toolName,
        fieldPath: obs.fieldPath,
        valueShape: obs.valueShape,
        sourceModels: [...new Set(obs.sourceModels)].sort(),
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
      sourceModels: [...new Set([...existing.sourceModels, ...obs.sourceModels])].sort(),
      seenCount: existing.seenCount + obs.seenCount,
      firstSeenAt: obs.firstSeenAt < existing.firstSeenAt ? obs.firstSeenAt : existing.firstSeenAt,
      lastSeenAt: obs.lastSeenAt > existing.lastSeenAt ? obs.lastSeenAt : existing.lastSeenAt,
    });
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
  ): Promise<void> {
    const row = this.rows.get(id);
    if (row === undefined) return;
    this.rows.set(id, {
      ...row,
      decision,
      status,
      lastStatusChangeAt: row.status !== status ? this.now().toISOString() : row.lastStatusChangeAt,
    });
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

  async countOpen(): Promise<OpenFieldCounts> {
    const rows = [...this.rows.values()];
    return {
      needsClarification: rows.filter((r) => r.status === 'needs_clarification').length,
      suggested: rows.filter((r) => r.status === 'suggested').length,
      confirmedConflict: rows.filter((r) => r.status === 'confirmed_conflict').length,
    };
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
}
