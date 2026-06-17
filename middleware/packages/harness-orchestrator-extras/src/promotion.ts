/**
 * @omadia/orchestrator-extras — Auto-Promotion (KG-ACL Slice 4b).
 *
 * Reads the just-persisted Turn's `significance` column; if it crosses
 * the configured threshold, materialises a MemorableKnowledge node with
 * `derivedFromTurnIds=[turnId]` + `aclOwners=[userId]`. Idempotent by
 * lookup against the DERIVED_FROM edge so a re-run on the same turn
 * does not produce duplicates.
 *
 * Significance lives on `graph_nodes.significance` (column, not JSONB
 * property). Capture-filter writes it via NeonKnowledgeGraph.ingestTurn
 * when a SignificanceScorer is configured — i.e. only when
 * `capture_level >= normal`. At `minimal` the score stays null and this
 * function declines to promote (reason='no-significance').
 *
 * Failure semantics: never throws. Returns a `PromoteTurnResult` with
 * `reason` for telemetry / logging. The orchestrator runs this as a
 * fire-and-forget after `sessionLogger.log` — failure logs but does
 * not interrupt the chat-stream done event.
 *
 * Plan-doc-deviation: the Master-Plan envisioned `promotion.ts` inside
 * `harness-knowledge-graph-neon`. Living in orchestrator-extras keeps
 * the orchestrator -> kg-neon dep direction clean (orchestrator already
 * depends on orchestrator-extras) and the helper next to its Palaia
 * siblings (factExtractor, significanceScorer, excerptExtractor).
 */

import type { Pool } from 'pg';
import type {
  KnowledgeGraph,
  MemorableKind,
  PalaiaExcerpt,
} from '@omadia/plugin-api';

export interface PromoteTurnInput {
  pool: Pool;
  tenantId: string;
  kg: KnowledgeGraph;
  /** External id of the persisted Turn node, e.g.
   *  `turn:<sessionId>:<isoTimestamp>`. */
  turnId: string;
  /** Cluster-root `omadiaUserId` to install as the sole acl_owner +
   *  the sole INVOLVED edge target. Falls back to behaviour-skip if
   *  empty (auto-promotion only makes sense with a known owner). */
  userId: string;
  /** Significance score required to trigger. Anything below this is
   *  skipped with reason='below-threshold'. Score=null (scorer-off)
   *  is skipped with reason='no-significance'. */
  threshold: number;
  /**
   * Optional Palaia-Excerpt suggestion from Slice 4a. When present,
   * the resulting MK uses {suggestedKind, suggestedSummary,
   * suggestedRationale} verbatim — manual + auto saves end up with
   * comparable payloads. When absent, we fall back to a naive
   * `insight` + first-500-chars-of-assistant-answer summary so the
   * promotion still produces something readable in `/memories`.
   */
  palaiaExcerpt?: PalaiaExcerpt;
  /** Fallback summary source — typically the cleaned assistant answer.
   *  Only used when `palaiaExcerpt` is absent. */
  fallbackAssistantAnswer: string;
  /**
   * Per-orchestrator KG isolation — the Agent (orchestrator) slug that
   * produced this turn. Stamped as `origin_agent` on the resulting MK so
   * recall default-isolates it to this Agent (team/public promotion stays
   * cross-agent). Omit on legacy / single-agent boots.
   */
  originAgent?: string;
  /**
   * Trigger T3 — durable auto-promotion. When set, an auto-promoted MK is
   * additionally marked `manuallyAuthored=true` (→ always-surface durable
   * recall tier) iff `significance >= durableMinSignificance`, its `kind` is in
   * `durableKinds`, and it passes the narration/snapshot hygiene check. Undefined
   * → never auto-mark durable (pre-T3 behaviour). Re-pollution guard.
   */
  durableMinSignificance?: number;
  /** Kinds eligible for durable auto-promotion. Default `['reference']`. */
  durableKinds?: MemorableKind[];
  /** Optional log sink. Defaults to `console.error`. */
  log?: (msg: string) => void;
}

export interface PromoteTurnResult {
  promoted: boolean;
  reason:
    | 'promoted'
    | 'below-threshold'
    | 'no-significance'
    | 'hygiene-skip'
    | 'already-promoted'
    | 'missing-user'
    | 'missing-turn'
    | 'error';
  mkId?: string;
  significance: number | null;
}

const MAX_FALLBACK_SUMMARY_LEN = 500;

/**
 * One-shot. Caller passes `void` semantics (fire-and-forget) so the
 * chat-stream's `done` event isn't gated on this. Idempotent via
 * DERIVED_FROM edge lookup.
 */
export async function promoteTurnIfSignificant(
  input: PromoteTurnInput,
): Promise<PromoteTurnResult> {
  const log = input.log ?? ((msg): void => console.error(msg));

  if (input.userId.length === 0) {
    log(`[promotion] skip turn=${input.turnId} reason=missing-user`);
    return { promoted: false, reason: 'missing-user', significance: null };
  }

  try {
    const sigRow = await input.pool.query<{
      significance: number | null;
    }>(
      `SELECT significance FROM graph_nodes
       WHERE external_id = $1 AND tenant_id = $2 AND type = 'Turn'
       LIMIT 1`,
      [input.turnId, input.tenantId],
    );
    if (sigRow.rows.length === 0) {
      log(`[promotion] skip turn=${input.turnId} reason=missing-turn`);
      return { promoted: false, reason: 'missing-turn', significance: null };
    }
    const significance = sigRow.rows[0]!.significance;

    if (significance === null) {
      log(
        `[promotion] skip turn=${input.turnId} reason=no-significance (capture_level<normal?)`,
      );
      return { promoted: false, reason: 'no-significance', significance: null };
    }
    if (significance < input.threshold) {
      log(
        `[promotion] skip turn=${input.turnId} reason=below-threshold significance=${significance.toFixed(2)} threshold=${input.threshold.toFixed(2)}`,
      );
      return {
        promoted: false,
        reason: 'below-threshold',
        significance,
      };
    }

    // Idempotency: check for an existing MK that DERIVED_FROM this turn.
    const existingRow = await input.pool.query<{ external_id: string }>(
      `SELECT mk.external_id
       FROM graph_edges e
       JOIN graph_nodes fn ON fn.id = e.from_node
       JOIN graph_nodes tn ON tn.id = e.to_node
       JOIN graph_nodes mk ON mk.id = fn.id
       WHERE e.type = 'DERIVED_FROM'
         AND fn.type = 'MemorableKnowledge'
         AND tn.external_id = $1
         AND tn.tenant_id = $2
         AND fn.tenant_id = $2
       LIMIT 1`,
      [input.turnId, input.tenantId],
    );
    if (existingRow.rows.length > 0) {
      const existingMkId = existingRow.rows[0]!.external_id;
      log(
        `[promotion] skip turn=${input.turnId} reason=already-promoted mk=${existingMkId}`,
      );
      return {
        promoted: false,
        reason: 'already-promoted',
        mkId: existingMkId,
        significance,
      };
    }

    const { kind, summary, rationale } = buildPayload(
      input.palaiaExcerpt,
      input.fallbackAssistantAnswer,
    );

    // Ingest hygiene — applied to ALL auto-harvest, not just the durable tier.
    // First-person agent narration ("Ich schaue kurz in den Memory…") and
    // trivially short fragments scored high enough to clear the significance
    // threshold and were being stored as fuzzy MK every session, re-polluting
    // recall. Drop them entirely so they never enter the KG.
    if (!passesIngestHygiene(summary)) {
      log(
        `[promotion] skip turn=${input.turnId} reason=hygiene (agent narration) significance=${significance.toFixed(2)}`,
      );
      return { promoted: false, reason: 'hygiene-skip', significance };
    }

    // Trigger T3 — durable auto-promotion gate. Conservative by design: only
    // high-significance, substantial reference knowledge is marked durable, so
    // time-bound snapshots / short fragments never reach the always-surface
    // tier (narration is already dropped above).
    const durableKinds = input.durableKinds ?? ['reference'];
    const durable =
      input.durableMinSignificance !== undefined &&
      significance >= input.durableMinSignificance &&
      durableKinds.includes(kind) &&
      isDurableContentLengthOk(summary, rationale);

    const result = await input.kg.createMemorableKnowledge({
      kind,
      summary,
      ...(rationale !== undefined ? { rationale } : {}),
      significance,
      ...(durable ? { manuallyAuthored: true } : {}),
      createdBy: `auto:${input.userId}`,
      involvedOmadiaUserIds: [input.userId],
      aclOwners: [input.userId],
      ...(input.originAgent ? { originAgent: input.originAgent } : {}),
      derivedFromTurnIds: [input.turnId],
      // Slice 6.5 — symmetric to manual save: persist the verbatim
      // source-snippets so the auto-promoted MK has the same
      // provenance trail as a hand-saved one. Only when the
      // extractor produced any (skip empty arrays — no point
      // persisting a hard-cap-zero batch).
      ...(input.palaiaExcerpt && input.palaiaExcerpt.excerpts.length > 0
        ? {
            palaiaExcerpts: {
              texts: [...input.palaiaExcerpt.excerpts],
              source: input.palaiaExcerpt.source,
            },
          }
        : {}),
    });

    log(
      `[promotion] PROMOTED turn=${input.turnId} mk=${result.memorableKnowledgeNodeId} significance=${significance.toFixed(2)} kind=${kind} durable=${durable ? 'yes' : 'no'}`,
    );
    return {
      promoted: true,
      reason: 'promoted',
      mkId: result.memorableKnowledgeNodeId,
      significance,
    };
  } catch (err) {
    log(
      `[promotion] FAIL turn=${input.turnId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { promoted: false, reason: 'error', significance: null };
  }
}

/**
 * Ingest hygiene gate for ALL auto-harvested MemorableKnowledge (not just the
 * durable tier). Rejects first-person agent narration / meta-process preambles
 * ("Ich schaue zuerst in den Memory…") — the dominant pollution class observed
 * in the live KG — so they never enter the KG and re-pollute recall every
 * session. Deliberately does NOT reject on length: short FACTS ("Preis 1200€",
 * "Migration 0007 ist live.") are legitimate. The durable tier adds its own
 * length floor. Conservative: returns false when unsure.
 */
function passesIngestHygiene(summary: string): boolean {
  const head = summary.trim();
  const NARRATION =
    /^(ich\s+(schaue|schau|prüfe|pruefe|sehe|gucke|lese|checke|werde|muss)|lass\s+mich|du\s+hast\s+recht|moment\b|kurz\b|let me\b|i\s+will\b|i'?ll\b|looking\b|checking\b)/i;
  if (NARRATION.test(head)) return false;
  return true;
}

/** Durable tier requires substantial content on top of ingest hygiene. */
function isDurableContentLengthOk(summary: string, rationale?: string): boolean {
  return `${summary} ${rationale ?? ''}`.trim().length >= 40;
}

function buildPayload(
  excerpt: PalaiaExcerpt | undefined,
  fallbackAnswer: string,
): { kind: MemorableKind; summary: string; rationale?: string } {
  if (excerpt) {
    return {
      kind: excerpt.suggestedKind,
      summary: excerpt.suggestedSummary,
      ...(excerpt.suggestedRationale !== undefined
        ? { rationale: excerpt.suggestedRationale }
        : {}),
    };
  }
  const trimmed = fallbackAnswer.trim().replace(/\s+/g, ' ');
  const summary =
    trimmed.length > MAX_FALLBACK_SUMMARY_LEN
      ? `${trimmed.slice(0, MAX_FALLBACK_SUMMARY_LEN - 1).trimEnd()}…`
      : trimmed;
  return { kind: 'insight', summary };
}
