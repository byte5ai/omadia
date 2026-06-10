import type { EmbeddingClient } from '@omadia/embeddings';
import {
  turnNodeId,
  type AgentPrioritiesStore,
  type AgentPriorityRecord,
  type EntityCapturedTurnsHit,
  type EntryType,
  type GraphNode,
  type KnowledgeGraph,
  type MemorableKnowledgeHit,
  type PalaiaExcerptHit,
  type PalaiaExcerptNode,
  type ProcessMemoryService,
  type RecalledContext,
  type RecalledInsight,
  type RecalledPlan,
  type RecalledProcess,
  type TurnSearchHit,
} from '@omadia/plugin-api';

export interface ContextRetrieverOptions {
  /** Verbatim tail depth (most recent turns of the active chat). */
  tailSize?: number;
  /** Max FTS hits across all chats. */
  ftsLimit?: number;
  /** Max distinct entities matched by name/id in the user message. */
  entityLimit?: number;
  /** Soft cap on the rendered context in characters. ~4 chars per token. */
  maxChars?: number;
  // OB-72: hybrid-retrieval knobs forwarded to `searchTurnsByEmbedding`.
  // Defaults preserve pre-OB-72 behaviour when callers don't set them.
  /** Min hybrid score in [0,1]; hits below dropped. Default 0 (off). */
  recallMinScore?: number;
  /** Recency-decay rate (per day). Default 0.05 (~14d half-life). 0 disables. */
  recallRecencyBoost?: number;
  /** Per-entry-type score multipliers. Default 1.0 each (neutral). */
  recallTypeWeights?: Partial<Record<EntryType, number>>;

  // OB-74 (Palaia Phase 5) — Token-Budget-Assembler knobs.
  /** Default budget for `assembleForBudget` when the caller does not pass one.
   *  Default 6000 (~24k chars at charsPerToken=4). */
  defaultBudgetTokens?: number;
  /** Rule-of-thumb for token estimation in `chars / charsPerToken`. Default 4. */
  charsPerToken?: number;
  /** Score multiplier for `manuallyAuthored=true` hits. Default 1.3 (palaia). */
  manualBoostFactor?: number;
  /** Above this hit count, Compact-Snippet-Mode activates.
   *  Default 100. */
  compactModeThreshold?: number;

  // Slice 7 — Memory + Excerpt semantic recall knobs.
  /** Disable the memory-recall leg entirely. Default false (= enabled
   *  whenever an embeddingClient is wired). Set to true via
   *  KG_ACL_MEMORY_RECALL_ENABLED=false at the plugin layer to A/B
   *  with vs without curated-memory injection. */
  memoryRecallDisabled?: boolean;
  /** Max MK hits surfaced per turn. Default 3. */
  memoryLimit?: number;
  /** Max excerpt-quotes rendered per surfaced MK. Default 2. */
  excerptsPerMemory?: number;
  /** Min cosine similarity for both MK and excerpt search. Default 0.5
   *  — higher than Turn-search (0.3) because curated memory should
   *  surface only on a strong match. */
  memoryMinSimilarity?: number;
  /** Score multiplier for memory-origin hits in the assembler. Default
   *  1.2 — curated memory ranks above raw FTS hits at similar cosine. */
  memoryBoostFactor?: number;

  // Cross-session recall probe — Plan + Process + team-scoped insights.
  /**
   * Opt-in team-scope recall. When true, the curated-memory leg admits
   * `team`/`public` MemorableKnowledge across the tenant (not just rows the
   * viewer owns). `private` stays owner-only. Default false. Forwarded to
   * `searchMemorableKnowledgeByEmbedding` / `searchExcerptsByEmbedding`.
   */
  teamVisibility?: boolean;
  /** Disable the cross-session plan-recall leg. Default false. */
  planRecallDisabled?: boolean;
  /** Max prior-session plans surfaced per turn. Default 3. */
  planLimit?: number;
  /** Only surface plans with ≥1 pending/in_progress step. Default true. */
  planOpenOnly?: boolean;
  /** Disable the process-memory recall leg. Default false (= enabled
   *  whenever a ProcessMemoryService is wired). */
  processRecallDisabled?: boolean;
  /** Max stored processes surfaced per turn. Default 3. */
  processLimit?: number;
  /** Min hybrid score for a process to be surfaced. Default 0.3. */
  processMinScore?: number;
}

export interface ContextBuildInput {
  userMessage: string;
  sessionScope?: string;
  userId?: string;
  /** External id of the turn currently being answered — excluded from hits. */
  currentTurnId?: string;
  /**
   * Per-orchestrator KG isolation — the `<agentSlug>::` prefix that selects
   * the recalling Agent's own turns/plans. Forwarded to every scope-filtered
   * KG read (`searchTurns`, `searchTurnsByEmbedding`, `findEntityCapturedTurns`,
   * `listRecentPlans`). Undefined → legacy cross-agent recall (no regression
   * for callers that don't set it).
   */
  agentScopePrefix?: string;
  /**
   * Per-orchestrator KG isolation — the recalling Agent's slug, forwarded to
   * curated-memory reads (`searchMemorableKnowledgeByEmbedding` /
   * `searchExcerptsByEmbedding`) as `viewerAgentSlug` so owner-gated MK is
   * constrained to this Agent's `origin_agent`. team/public-promoted MK still
   * crosses Agents. Undefined → no agent constraint.
   */
  agentSlug?: string;
}

export interface ContextBuildResult {
  /** Rendered context block. Empty string when nothing useful was found. */
  text: string;
  /** Structured trace of what went in — useful for logging and tests. */
  sources: {
    verbatimTurns: Array<{ time: string; userMessage: string; assistantAnswer: string }>;
    entityHits: EntityCapturedTurnsHit[];
    ftsHits: TurnSearchHit[];
    /**
     * Entities CAPTURED in the semantic-hit turns. Deduped across hits.
     * Gives the LLM a terse "these are the entities the related turns
     * touched" index without re-reading the full turn prose.
     */
    relatedEntities: GraphNode[];
    extractedTerms: string[];
    /** Slice 7 — curated-memory recall results. Empty when the leg
     *  was skipped (no embedding client, no userId, or
     *  memoryRecallDisabled). */
    memoryHits: MemoryRecallHit[];
  };
}

/**
 * Slice 7 — one curated-memory hit ready to render. Either the MK
 * itself matched semantically, or one or more of its excerpts did
 * (deduped: an excerpt-hit always resolves to its parent MK).
 */
export interface MemoryRecallHit {
  /** The MemorableKnowledge node (kind / summary / rationale / …). */
  mk: GraphNode;
  /** Excerpts under this MK that survived the cosine + per-MK cap.
   *  Empty array means "MK matched directly, no excerpt drove the hit". */
  excerpts: PalaiaExcerptNode[];
  /** Final score = max(MK cosine, best-excerpt cosine). Used to
   *  rank against other recall sources in the assembler. */
  score: number;
}

// ---------------------------------------------------------------------------
// OB-74 (Palaia Phase 5) — Token-Budget-Assembler.
//
// `assembleForBudget` augments `build` with a token-aware greedy-fill pipeline:
//   1. Tail turns (chronological, score=1.0 synthetic) go into the fill
//      FIRST — recency wins, even against higher-scored hybrid hits.
//   2. Remaining hits (entity-hits + hybrid-FTS) are sorted by score
//      DESC (ties broken by turnId ASC for determinism).
//   3. Score multipliers: `manuallyAuthored=true` → ×manualBoostFactor (1.3),
//      `agent_priorities[entry].action='boost'` → ×weight.
//   4. Filter: `agent_priorities[entry].action='block'` → drop.
//   5. Compact-Mode at >compactModeThreshold (100) candidates — only a
//      ~120-char snippet per hit instead of the full body, otherwise the
//      pool eats the budget.
//   6. Greedy fill until tokensUsed + hitTokens > budget → break.
// ---------------------------------------------------------------------------

export interface AssembleForBudgetInput {
  userMessage: string;
  sessionScope?: string;
  userId?: string;
  /** External id of the turn currently being answered — excluded from hits. */
  currentTurnId?: string;
  /** Who is asking — driver for agent_priorities lookup. */
  agentId: string;
  /**
   * Per-orchestrator KG isolation (opt-in). When set (the orchestrator passes
   * `<agentSlug>::`), every recall leg is constrained to this Agent's own
   * turns/plans, and curated-memory recall is constrained to its `origin_agent`
   * (`agentId` becomes the `viewerAgentSlug`). The orchestrator also passes an
   * already-qualified `sessionScope`. Omitted → legacy cross-scope recall
   * (direct-retriever callers and sub-agents are unaffected).
   */
  agentScopePrefix?: string;
  /** Optional override; otherwise `defaultBudgetTokens` from ContextRetriever-Opts. */
  budget?: { tokens: number };
}

export type AssembledHitReason =
  | 'tail'
  | 'entity'
  | 'fts'
  | 'manual-boost'
  | 'agent-boost';

export interface AssembledHit {
  turnId: string;
  /** Final score after all multipliers (raw × manual × agent). */
  score: number;
  /** Char count of the rendered chunk (tail-block OR full OR snippet). */
  chars: number;
  /** Which recall path delivered this hit / which multiplier boosted it,
   *  if any. `manual-boost` / `agent-boost` only override `entity`/`fts`
   *  when relevant — the audit card shows the dominant reason. */
  reason: AssembledHitReason;
}

export interface AssembledExclusion {
  turnId: string;
  reason: 'budget-exceeded' | 'agent-blocked';
}

// Cross-session recall payload types (RecalledContext / RecalledPlan /
// RecalledProcess / RecalledInsight) live in @omadia/plugin-api so the
// channel-facing answer contract can reference them without a circular
// dependency. Imported at the top of this file and re-exported via index.ts.

export interface AssembledContext {
  /** Final-rendered prose, ≤ budget tokens (best-effort, based on
   *  `chars/charsPerToken`). Empty string when nothing fit. */
  text: string;
  included: AssembledHit[];
  excluded: AssembledExclusion[];
  /** Cross-session probe payload — plans/processes/insights from prior
   *  sessions. Same content as the rendered recall blocks, structured for
   *  the visible recall card. */
  recalled: RecalledContext;
  stats: {
    /** Size of the candidate pool BEFORE the greedy-fill. */
    candidatePool: number;
    /** True when the pool was > compactModeThreshold. */
    compactMode: boolean;
    /** Actually consumed tokens (estimate via charsPerToken). */
    tokensUsed: number;
  };
}

interface CandidateHit {
  turnId: string;
  scope: string;
  time: string;
  userMessage: string;
  assistantAnswer: string;
  /** Score BEFORE multipliers (raw hybrid score or synthetic 1.0 for tail). */
  rawScore: number;
  /** Origin of the hit — merged with multiplier reason in the output. */
  origin: 'tail' | 'entity' | 'fts';
  manuallyAuthored: boolean;
  /** Incremental boost via `agent_priorities.action='boost'`. */
  agentBoosted: boolean;
}

const DEFAULTS: Required<
  Omit<ContextRetrieverOptions, 'recallTypeWeights'>
> & { recallTypeWeights: Partial<Record<EntryType, number>> } = {
  tailSize: 3,
  ftsLimit: 5,
  entityLimit: 5,
  maxChars: 12_000,
  recallMinScore: 0,
  recallRecencyBoost: 0.05,
  recallTypeWeights: { memory: 1.0, process: 1.0, task: 1.0 },
  defaultBudgetTokens: 6_000,
  charsPerToken: 4,
  manualBoostFactor: 1.3,
  compactModeThreshold: 100,
  // Slice 7 defaults.
  memoryRecallDisabled: false,
  memoryLimit: 3,
  excerptsPerMemory: 2,
  memoryMinSimilarity: 0.5,
  memoryBoostFactor: 1.2,
  // Cross-session recall probe defaults.
  teamVisibility: false,
  planRecallDisabled: false,
  planLimit: 3,
  planOpenOnly: true,
  processRecallDisabled: false,
  processLimit: 3,
  processMinScore: 0.3,
};

// Tiny, language-agnostic stopword list. We keep it short because the real
// signal comes from proper nouns and IDs which survive any sensible filter.
// Mixing German + English entries since both show up in user queries.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'have', 'was', 'are',
  'der', 'die', 'das', 'und', 'ist', 'mit', 'für', 'von', 'zu', 'im', 'auf',
  'ich', 'du', 'er', 'sie', 'es', 'wir', 'ihr', 'was', 'wer', 'wie', 'warum',
  'nicht', 'kein', 'keine', 'noch', 'bei', 'dem', 'den', 'des', 'ein', 'eine',
  'wird', 'werden', 'wurde', 'sind', 'war', 'hat', 'habe', 'haben', 'auch',
  'bitte', 'danke', 'hallo', 'hi',
  // Common German imperatives that would otherwise slip through the 4+ filter
  // at the start of a request ("Zeig mir …", "Gibt es …").
  'zeig', 'zeige', 'gib', 'gibt', 'sag', 'sage', 'mach', 'mache', 'frag',
  'frage', 'hole', 'hol', 'finde', 'such', 'suche', 'liste', 'nenn', 'nenne',
  'erklär', 'erkläre', 'prüfe', 'prüf',
]);

/**
 * Extracts candidate terms for entity-anchoring from a free-text message.
 * Keeps tokens containing digits (likely ids), tokens with uppercase chars
 * (likely proper nouns / company names), and anything 4+ chars that isn't a
 * stopword. Deduped, capped at 10.
 */
export function extractCandidateTerms(message: string): string[] {
  const raw = message.split(/[\s,.;:!?()[\]{}'"<>]+/u).filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tok of raw) {
    const lower = tok.toLowerCase();
    const hasDigit = /\d/.test(tok);
    // "Interior" uppercase (anything past position 0) distinguishes "GmbH",
    // "macOS", "iPhone" from sentence-initial capitalisation like "Zeig".
    const hasInteriorUpper = /[A-ZÄÖÜ]/.test(tok.slice(1));
    const isAllUpper = tok.length >= 2 && tok === tok.toUpperCase() && /[A-ZÄÖÜ]/.test(tok);
    const keep =
      hasDigit ||
      isAllUpper ||
      hasInteriorUpper ||
      (tok.length >= 4 && !STOPWORDS.has(lower));
    if (!keep) continue;
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(tok);
    if (out.length >= 10) break;
  }
  return out;
}

/**
 * Retrieves conversational context for the current turn from the knowledge
 * graph and renders it as a single text block ready to be injected as a
 * cacheable system block. Combines three signals with decreasing priority:
 *
 *  1. Verbatim tail — last N turns of the active chat (dialog coherence).
 *  2. Entity-anchored turns — turns that captured an entity node
 *     (OdooEntity / ConfluencePage / PluginEntity) whose label/id appears
 *     in the current user message.
 *  3. Full-text search hits — cross-chat, scoped to the same user.
 *
 * Dedupes by turn id. Honours a soft character budget: once the budget is
 * exhausted later signals are trimmed. Returns empty `text` when no signal
 * remains — callers should then skip the injection entirely.
 */
export class ContextRetriever {
  private readonly opts: Required<ContextRetrieverOptions>;

  constructor(
    private readonly graph: KnowledgeGraph,
    opts: ContextRetrieverOptions = {},
    private readonly embeddingClient?: EmbeddingClient,
    /** OB-74 (Palaia Phase 5) — optional. When the KG provider does not
     *  publish the `agentPriorities@1` capability, the assembler runs
     *  without Block/Boost (manual_authored × 1.3 stays active). */
    private readonly agentPriorities?: AgentPrioritiesStore,
    /** Cross-session recall probe — optional. When wired, the assembler adds
     *  a stored-process recall leg (semantic query over the `processes`
     *  store). Absent → the leg is skipped, plan + memory legs still run. */
    private readonly processMemory?: ProcessMemoryService,
  ) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  async build(input: ContextBuildInput): Promise<ContextBuildResult> {
    const extractedTerms = extractCandidateTerms(input.userMessage);

    const [tail, entityHits, ftsHits, memoryHits] = await Promise.all([
      this.loadTail(input),
      this.loadEntityHits(input, extractedTerms),
      this.loadFtsHits(input),
      this.loadMemoryHits(input),
    ]);

    const seenTurnIds = new Set<string>();
    for (const t of tail) seenTurnIds.add(`turn:${input.sessionScope ?? ''}:${t.time}`);

    const entityHitsFiltered: EntityCapturedTurnsHit[] = [];
    for (const hit of entityHits) {
      const filteredTurns = hit.turns.filter((t) => !seenTurnIds.has(t.turnId));
      for (const t of filteredTurns) seenTurnIds.add(t.turnId);
      if (filteredTurns.length > 0) {
        entityHitsFiltered.push({ entity: hit.entity, turns: filteredTurns });
      }
    }
    const ftsHitsFiltered = ftsHits.filter((h) => !seenTurnIds.has(h.turnId));

    // Aggregate entities captured by the semantic-hit turns. The text of
    // each turn already mentions these entities, but a deduped list helps
    // the model spot cross-turn entity reuse ("Lilium came up in three
    // past chats") which is hard to see from prose alone.
    const relatedEntities = await this.collectRelatedEntities(ftsHitsFiltered);

    const text = renderContext({
      verbatimTurns: tail,
      entityHits: entityHitsFiltered,
      ftsHits: ftsHitsFiltered,
      relatedEntities,
      memoryHits,
      maxChars: this.opts.maxChars,
    });

    // Structured one-liner so we can diagnose "follow-up forgot its context"
    // without adding verbose retrieval traces. stderr is used so Fly's log
    // aggregator reliably forwards it (we've seen stdout INFO lines dropped).
    const scope = input.sessionScope ?? '<no-scope>';
    const termsPreview = extractedTerms.slice(0, 5).join(',');
    console.error(
      `[context:inner] scope=${scope} tail=${String(tail.length)} entity-hits=${String(entityHitsFiltered.length)} fts=${String(ftsHitsFiltered.length)} memory=${String(memoryHits.length)} terms=[${termsPreview}] rendered=${String(text.length)}B`,
    );

    return {
      text,
      sources: {
        verbatimTurns: tail,
        entityHits: entityHitsFiltered,
        ftsHits: ftsHitsFiltered,
        relatedEntities,
        extractedTerms,
        memoryHits,
      },
    };
  }

  /**
   * OB-74 (Palaia Phase 5) — Token-Budget Greedy-Fill Assembler.
   *
   * Collects the same recall legs as `build()`, but sorts/filters the
   * hit list agent-specific (Block/Boost via `agent_priorities`),
   * applies `manuallyAuthored × manualBoostFactor`, and greedy-fills a
   * token budget by score. Tail turns go into the fill first —
   * recency wins against higher-scored hybrid.
   *
   * Side-effect-free relative to `build()`: calls the same graph methods,
   * does not mutate shared state.
   */
  async assembleForBudget(
    input: AssembleForBudgetInput,
  ): Promise<AssembledContext> {
    const charsPerToken = Math.max(1, this.opts.charsPerToken);
    const budgetTokens = Math.max(
      1,
      input.budget?.tokens ?? this.opts.defaultBudgetTokens,
    );
    const budgetChars = budgetTokens * charsPerToken;

    const extractedTerms = extractCandidateTerms(input.userMessage);
    const buildInput: ContextBuildInput = {
      userMessage: input.userMessage,
      ...(input.sessionScope ? { sessionScope: input.sessionScope } : {}),
      ...(input.userId ? { userId: input.userId } : {}),
      ...(input.currentTurnId ? { currentTurnId: input.currentTurnId } : {}),
      // Per-orchestrator KG isolation is OPT-IN: only when the caller (the
      // orchestrator) passes an agent prefix do we constrain recall to that
      // Agent. Its `sessionScope` then already arrives qualified, so
      // getSession / turnNodeId stay consistent with the ingest side.
      ...(input.agentScopePrefix
        ? {
            agentScopePrefix: input.agentScopePrefix,
            agentSlug: input.agentId,
          }
        : {}),
    };

    const [
      tail,
      entityHits,
      ftsHits,
      prioritiesIndex,
      planHits,
      processHits,
      memoryHits,
    ] = await Promise.all([
      this.loadTail(buildInput),
      this.loadEntityHits(buildInput, extractedTerms),
      this.loadFtsHits(buildInput),
      this.loadAgentPriorities(input.agentId),
      this.loadPlanHits(buildInput),
      this.loadProcessHits(buildInput),
      this.loadMemoryHits(buildInput),
    ]);

    // Build candidate pool. Tail first (chronological → fills first).
    const seen = new Set<string>();
    const candidates: CandidateHit[] = [];

    if (input.sessionScope) {
      for (const t of tail) {
        const turnId = turnNodeId(input.sessionScope, t.time);
        if (seen.has(turnId)) continue;
        seen.add(turnId);
        candidates.push({
          turnId,
          scope: input.sessionScope,
          time: t.time,
          userMessage: t.userMessage,
          assistantAnswer: t.assistantAnswer,
          rawScore: 1.0, // synthetic — tail is always relevant for recency
          origin: 'tail',
          // Tail score is synthetic 1.0 → manual_boost is moot, leave false
          // so it doesn't show up as "manual-boost" reason in the audit.
          manuallyAuthored: false,
          agentBoosted: false,
        });
      }
    }

    for (const hit of entityHits) {
      for (const t of hit.turns) {
        if (seen.has(t.turnId)) continue;
        seen.add(t.turnId);
        candidates.push({
          turnId: t.turnId,
          scope: t.scope,
          time: t.time,
          userMessage: t.userMessage,
          assistantAnswer: t.assistantAnswer,
          // Entity hits have no score → synthetic 0.7 (between tail
          // and unranked FTS; operator experience from OB-72 shows they
          // are highly relevant whenever the entity was hit).
          rawScore: 0.7,
          origin: 'entity',
          manuallyAuthored: false,
          agentBoosted: false,
        });
      }
    }

    for (const hit of ftsHits) {
      if (seen.has(hit.turnId)) continue;
      seen.add(hit.turnId);
      candidates.push({
        turnId: hit.turnId,
        scope: hit.scope,
        time: hit.time,
        userMessage: hit.userMessage,
        assistantAnswer: hit.assistantAnswer,
        rawScore: hit.rank,
        origin: 'fts',
        manuallyAuthored: hit.manuallyAuthored === true,
        agentBoosted: false,
      });
    }

    // Apply agent block + boost.
    const excluded: AssembledExclusion[] = [];
    const filtered: CandidateHit[] = [];
    for (const c of candidates) {
      const pri = prioritiesIndex.get(c.turnId);
      if (pri?.action === 'block') {
        excluded.push({ turnId: c.turnId, reason: 'agent-blocked' });
        continue;
      }
      if (pri?.action === 'boost') {
        c.agentBoosted = true;
        c.rawScore = c.rawScore * (Number.isFinite(pri.weight) ? pri.weight : 1);
      }
      filtered.push(c);
    }

    // Apply manual_authored boost AFTER agent boost (independent multiplier).
    for (const c of filtered) {
      if (c.manuallyAuthored && c.origin !== 'tail') {
        c.rawScore = c.rawScore * this.opts.manualBoostFactor;
      }
    }

    const compactMode = filtered.length > this.opts.compactModeThreshold;

    // Tail-turns FIRST (chronological for RENDERING), then everything else
    // sorted by score DESC (ties → turnId ASC for determinism).
    const tailTurns = filtered.filter((c) => c.origin === 'tail');
    const nonTail = filtered
      .filter((c) => c.origin !== 'tail')
      .sort((a, b) => {
        if (b.rawScore !== a.rawScore) return b.rawScore - a.rawScore;
        return a.turnId.localeCompare(b.turnId);
      });
    const fillOrder = [...tailTurns, ...nonTail];
    // SELECTION order differs from render order on one axis: within the tail we
    // budget newest-first, so if anything has to drop it's the oldest tail turn
    // — never the immediately-preceding one a follow-up depends on. `tailTurns`
    // arrives chronological (oldest→newest); reverse for selection. Rendering
    // still uses `fillOrder` (chronological), so the prose reads in order.
    const tailNewestFirst = [...tailTurns].reverse();
    const selectionOrder = [...tailNewestFirst, ...nonTail];

    // Cross-session recall blocks (plans / processes / insights) are NOT
    // turn-shaped, so they render outside the turn greedy-fill as their own
    // prepended section. They are the headline of the recall probe → they get
    // first claim on up to half the budget. CONTINUITY GUARD: that half is
    // taken from the budget AFTER reserving the verbatim tail, so a fuller
    // insights leg (e.g. once auto-promotion is on) can never evict the recent
    // in-session turns and make a follow-up silently lose the latest state. The
    // tail reservation is capped so a pathological giant turn can't starve
    // recall entirely. When every recall leg is empty the blocks render to ''
    // and the turn budget is untouched (byte-identical to pre-probe behaviour).
    const insights: RecalledInsight[] = memoryHits.map((h) => ({
      mkId: h.mk.id,
      kind: String(h.mk.props['kind'] ?? 'memory'),
      summary: truncate(String(h.mk.props['summary'] ?? ''), 300),
      score: h.score,
    }));
    const recalled: RecalledContext = {
      plans: planHits,
      processes: processHits,
      insights,
    };
    const tailReserveCapChars = Math.floor(budgetChars * 0.6);
    let tailReservedChars = 0;
    for (let i = 0; i < tailNewestFirst.length; i++) {
      const chars = renderHitChunk(
        tailNewestFirst[i] as CandidateHit,
        compactMode,
      ).length;
      // The single most-recent turn (i === 0) is ALWAYS reserved — it is the
      // one piece of state a follow-up cannot do without, even if it is large.
      // The 0.6 cap only limits the OLDER tail turns so they can't, together,
      // starve cross-session recall.
      if (i > 0 && tailReservedChars + chars > tailReserveCapChars) break;
      tailReservedChars += chars;
    }
    tailReservedChars = Math.min(tailReservedChars, budgetChars);
    const recallBudgetChars = Math.floor(
      Math.max(0, budgetChars - tailReservedChars) * 0.5,
    );
    const recallBlocksText = renderRecallBlocks(recalled, recallBudgetChars);
    const recallTokens =
      recallBlocksText.length > 0
        ? Math.ceil(recallBlocksText.length / charsPerToken)
        : 0;
    const turnBudgetTokens = Math.max(0, budgetTokens - recallTokens);
    const turnBudgetChars = turnBudgetTokens * charsPerToken;

    const included: AssembledHit[] = [];
    let turnTokensUsed = 0;
    for (const c of selectionOrder) {
      const chunk = renderHitChunk(c, compactMode);
      const chunkChars = chunk.length;
      const chunkTokens = Math.ceil(chunkChars / charsPerToken);
      if (turnTokensUsed + chunkTokens > turnBudgetTokens) {
        excluded.push({ turnId: c.turnId, reason: 'budget-exceeded' });
        continue;
      }
      turnTokensUsed += chunkTokens;
      included.push({
        turnId: c.turnId,
        score: c.rawScore,
        chars: chunkChars,
        reason: pickReason(c),
      });
      // Defensive: budget check on chars too (rounding can edge out the
      // token estimate by 1-2 tokens; chars cap is the hard ceiling).
      if (chunkChars > turnBudgetChars) break;
    }

    const turnText = renderAssembled(fillOrder, included, compactMode);
    const text =
      recallBlocksText.length > 0
        ? turnText.length > 0
          ? `${recallBlocksText}\n\n${turnText}`
          : recallBlocksText
        : turnText;
    const tokensUsed = turnTokensUsed + recallTokens;

    const scope = input.sessionScope ?? '<no-scope>';
    console.error(
      `[context:assembled] scope=${scope} agent=${input.agentId} pool=${String(filtered.length)} included=${String(included.length)} excluded=${String(excluded.length)} compact=${String(compactMode)} plans=${String(recalled.plans.length)} processes=${String(recalled.processes.length)} insights=${String(recalled.insights.length)} tokens=${String(tokensUsed)}/${String(budgetTokens)}`,
    );

    return {
      text,
      included,
      excluded,
      recalled,
      stats: {
        candidatePool: filtered.length,
        compactMode,
        tokensUsed,
      },
    };
  }

  /** Bulk-load and index the agent's block/boost-list. Empty Map when
   *  no service is wired or the agent has no entries. */
  private async loadAgentPriorities(
    agentId: string,
  ): Promise<Map<string, AgentPriorityRecord>> {
    if (!this.agentPriorities) return new Map();
    try {
      const records = await this.agentPriorities.listForAgent(agentId);
      const idx = new Map<string, AgentPriorityRecord>();
      for (const r of records) idx.set(r.entryExternalId, r);
      return idx;
    } catch (err) {
      console.error(
        '[context:assembled] agent-priorities lookup failed — proceeding without block/boost:',
        err instanceof Error ? err.message : err,
      );
      return new Map();
    }
  }

  /**
   * For each semantically-related turn we found, fetch its CAPTURED entity
   * neighbours and return the deduped union. Capped at 10 to keep the
   * rendered block short; the turns themselves still hold the full prose.
   * Failures log on stderr and return [] — a down graph call must not kill
   * the whole retrieval.
   */
  private async collectRelatedEntities(
    hits: readonly TurnSearchHit[],
  ): Promise<GraphNode[]> {
    if (hits.length === 0) return [];
    const seen = new Map<string, GraphNode>();
    for (const hit of hits) {
      try {
        // hit.turnId already uses the canonical scheme `turn:<scope>:<time>`.
        // Defensive: normalise via helper in case a backend returns a UUID.
        const externalId = hit.turnId.startsWith('turn:')
          ? hit.turnId
          : turnNodeId(hit.scope, hit.time);
        const neighbours = await this.graph.getNeighbors(externalId);
        for (const n of neighbours) {
          // Entity nodes the KG knows: the legacy Odoo/Confluence sync
          // targets PLUS the generic `PluginEntity` written by every other
          // integration plugin. Anything else (Turn/Session/Fact/…) is
          // skipped — keep this in sync with the KG's entity node types.
          if (
            n.type !== 'OdooEntity' &&
            n.type !== 'ConfluencePage' &&
            n.type !== 'PluginEntity'
          ) {
            continue;
          }
          if (seen.has(n.id)) continue;
          seen.set(n.id, n);
          if (seen.size >= 10) return [...seen.values()];
        }
      } catch (err) {
        console.error(
          '[context] related-entities lookup failed for turn',
          hit.turnId,
          err instanceof Error ? err.message : err,
        );
      }
    }
    return [...seen.values()];
  }

  private async loadTail(
    input: ContextBuildInput,
  ): Promise<Array<{ time: string; userMessage: string; assistantAnswer: string }>> {
    if (!input.sessionScope) return [];
    const session = await this.graph.getSession(input.sessionScope);
    if (!session) return [];
    const turns = session.turns
      .map((t) => ({
        time: String(t.turn.props['time'] ?? ''),
        userMessage: String(t.turn.props['userMessage'] ?? ''),
        assistantAnswer: String(t.turn.props['assistantAnswer'] ?? ''),
      }))
      .filter(
        (t) =>
          t.time.length > 0 &&
          (t.userMessage.length > 0 || t.assistantAnswer.length > 0),
      );
    return turns.slice(-this.opts.tailSize);
  }

  private async loadEntityHits(
    input: ContextBuildInput,
    terms: readonly string[],
  ): Promise<EntityCapturedTurnsHit[]> {
    if (terms.length === 0) return [];
    return this.graph.findEntityCapturedTurns({
      terms,
      ...(input.userId ? { userId: input.userId } : {}),
      ...(input.sessionScope ? { excludeScope: input.sessionScope } : {}),
      ...(input.agentScopePrefix
        ? { agentScopePrefix: input.agentScopePrefix }
        : {}),
      perEntityLimit: 2,
      entityLimit: this.opts.entityLimit,
    });
  }

  /**
   * Cross-session recall probe — resumable plans from PRIOR sessions,
   * **relevance-filtered** against the current message. Tenant-wide (the team
   * scope); the current session's own plan is excluded (the tail covers it).
   *
   * Plans carry no embedding, so relevance is lexical: a plan only surfaces
   * when its text (strategy + step goals) shares a candidate term with the
   * user message — the same term extractor the entity leg uses. Recency alone
   * is wrong (a question about onboarding must not resurface last week's
   * diagram plan); ranked by term-overlap, recency as the tiebreak. When the
   * message yields no candidate terms (a bare "weiter") we fall back to
   * recency so a contentless continuation still resumes recent open work.
   * On any error returns [] — a degraded recall path must not kill the turn.
   */
  private async loadPlanHits(
    input: ContextBuildInput,
  ): Promise<RecalledPlan[]> {
    if (this.opts.planRecallDisabled) return [];
    const limit = Math.max(1, this.opts.planLimit);
    const terms = extractCandidateTerms(input.userMessage).map((t) =>
      t.toLowerCase(),
    );
    try {
      // Over-fetch a wider candidate window so the relevance filter has
      // something to choose from (recency-only would pick the latest N).
      const plans = await this.graph.listRecentPlans({
        limit: Math.max(limit * 4, 12),
        openOnly: this.opts.planOpenOnly,
        ...(input.agentScopePrefix
          ? { agentScopePrefix: input.agentScopePrefix }
          : {}),
      });
      // Cross-session only — drop same-session plans before fetching steps so
      // the batched read does no wasted work.
      const candidates = plans.filter(
        (p) => p.props['scope'] !== input.sessionScope,
      );
      // One round-trip for every candidate's steps instead of a serial
      // getPlanSteps per plan (the old loop was up to ~24 sequential Neon
      // round-trips on the turn's context-build hot path).
      const stepsByPlan = await this.graph.getPlanStepsForPlans(
        candidates.map((p) => p.id),
      );
      const scored: Array<{ hit: RecalledPlan; score: number }> = [];
      for (const p of candidates) {
        const steps = stepsByPlan.get(p.id) ?? [];
        const openStepGoals: string[] = [];
        const goalTexts: string[] = [];
        let doneCount = 0;
        for (const s of steps) {
          const status = s.props['status'];
          const goal = String(s.props['goal'] ?? '');
          if (goal.length > 0) goalTexts.push(goal);
          if (status === 'done') doneCount += 1;
          else if (status === 'pending' || status === 'in_progress') {
            if (goal.length > 0) openStepGoals.push(goal);
          }
        }
        // Relevance = how many query terms appear in strategy + step goals.
        const haystack =
          `${String(p.props['strategy'] ?? '')} ${goalTexts.join(' ')}`.toLowerCase();
        const score =
          terms.length === 0
            ? 0
            : terms.filter((t) => haystack.includes(t)).length;
        // Drop topically-unrelated plans. With no query terms (bare
        // continuation) every plan scores 0 → keep the recency fallback.
        if (terms.length > 0 && score === 0) continue;
        scored.push({
          hit: {
            planId: p.id,
            scope: String(p.props['scope'] ?? ''),
            ...(typeof p.props['strategy'] === 'string'
              ? { strategy: p.props['strategy'] }
              : {}),
            ...(typeof p.props['createdAt'] === 'string'
              ? { createdAt: p.props['createdAt'] }
              : {}),
            openStepGoals,
            doneCount,
            totalCount: steps.length,
          },
          score,
        });
      }
      // Rank by term-overlap DESC; `listRecentPlans` already returned
      // createdAt-desc, so a stable sort keeps recency as the tiebreak.
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, limit).map((s) => s.hit);
    } catch (err) {
      console.error(
        '[context:plan] plan recall failed — continuing without:',
        err instanceof Error ? err.message : err,
      );
      return [];
    }
  }

  /**
   * Cross-session recall probe — stored processes semantically matching the
   * user message (`processMemory@1` hybrid query, tenant-wide = team). Skipped
   * when no ProcessMemoryService is wired or the leg is disabled. `private`
   * processes are dropped (the store does not filter visibility itself). On
   * any error returns [].
   */
  private async loadProcessHits(
    input: ContextBuildInput,
  ): Promise<RecalledProcess[]> {
    if (this.opts.processRecallDisabled || !this.processMemory) return [];
    try {
      const hits = await this.processMemory.query({
        query: input.userMessage,
        limit: this.opts.processLimit,
      });
      return hits
        .filter((h) => h.score >= this.opts.processMinScore)
        .filter((h) => (h.record.visibility || 'team') !== 'private')
        .map((h) => ({
          id: h.record.id,
          title: h.record.title,
          scope: h.record.scope,
          stepCount: h.record.steps.length,
          score: h.score,
        }));
    } catch (err) {
      console.error(
        '[context:process] process recall failed — continuing without:',
        err instanceof Error ? err.message : err,
      );
      return [];
    }
  }

  /**
   * Slice 7 — semantic recall over curated memories + their verbatim
   * excerpts. Skipped when:
   *   - no embeddingClient is wired (the legs need a query vector)
   *   - no `userId` on the input (ACL gate is non-bypassable)
   *   - `memoryRecallDisabled` is true (operator A/B kill switch)
   *
   * Strategy: run MK-search and excerpt-search in parallel against
   * the same query embedding; dedupe on parent-MK external_id so a
   * single MK never fires twice (excerpt-hit takes priority — verbatim
   * matched, the user's question used wording close to the source);
   * fetch parent MKs for excerpt-only hits; pack the top
   * `memoryLimit` memories with up to `excerptsPerMemory` quotes
   * each; score = max(direct MK cosine, best excerpt cosine).
   *
   * On any error returns []: a degraded recall path must not kill the
   * whole turn.
   */
  private async loadMemoryHits(
    input: ContextBuildInput,
  ): Promise<MemoryRecallHit[]> {
    if (this.opts.memoryRecallDisabled) return [];
    if (!this.embeddingClient || !input.userId) return [];

    let queryVector: number[];
    try {
      queryVector = await this.embeddingClient.embed(input.userMessage);
    } catch (err) {
      console.error(
        '[context:memory] query embed failed — skipping memory recall:',
        err instanceof Error ? err.message : err,
      );
      return [];
    }
    if (queryVector.length === 0) return [];

    const overshoot = Math.max(this.opts.memoryLimit * 2, 6);
    const excerptOvershoot = Math.max(
      this.opts.memoryLimit * this.opts.excerptsPerMemory * 2,
      10,
    );

    let mkHits: MemorableKnowledgeHit[];
    let excerptHits: PalaiaExcerptHit[];
    try {
      [mkHits, excerptHits] = await Promise.all([
        this.graph.searchMemorableKnowledgeByEmbedding({
          queryEmbedding: queryVector,
          viewerOmadiaUserId: input.userId,
          limit: overshoot,
          minSimilarity: this.opts.memoryMinSimilarity,
          teamVisibility: this.opts.teamVisibility,
          ...(input.agentSlug ? { viewerAgentSlug: input.agentSlug } : {}),
        }),
        this.graph.searchExcerptsByEmbedding({
          queryEmbedding: queryVector,
          viewerOmadiaUserId: input.userId,
          limit: excerptOvershoot,
          minSimilarity: this.opts.memoryMinSimilarity,
          teamVisibility: this.opts.teamVisibility,
          ...(input.agentSlug ? { viewerAgentSlug: input.agentSlug } : {}),
        }),
      ]);
    } catch (err) {
      console.error(
        '[context:memory] backend search failed — skipping memory recall:',
        err instanceof Error ? err.message : err,
      );
      return [];
    }

    // Group excerpt-hits by their parent MK so we can fold them into
    // the per-MK render. Sort each group desc so the strongest matches
    // surface first.
    const excerptsByMk = new Map<string, PalaiaExcerptHit[]>();
    for (const eh of excerptHits) {
      const list = excerptsByMk.get(eh.parentMkId) ?? [];
      list.push(eh);
      excerptsByMk.set(eh.parentMkId, list);
    }
    for (const list of excerptsByMk.values()) {
      list.sort((a, b) => b.cosineSim - a.cosineSim);
    }

    // Index MK-hits + collect parent-MK ids that only excerpts matched.
    const mkById = new Map<string, MemorableKnowledgeHit>();
    for (const mh of mkHits) mkById.set(mh.mk.id, mh);
    const parentsToFetch: string[] = [];
    for (const parentId of excerptsByMk.keys()) {
      if (!mkById.has(parentId)) parentsToFetch.push(parentId);
    }

    // Fetch missing parent MKs (excerpt-only matches). Done sequentially
    // to keep the path simple — count is bounded by excerptOvershoot.
    for (const parentId of parentsToFetch) {
      try {
        const node = await this.graph.getMemorableKnowledge(
          parentId,
          input.userId,
        );
        if (!node) continue; // ACL drop or already deleted
        // Synthetic MK-hit at score 0 — best excerpt drives the score below.
        mkById.set(node.id, { mk: node, cosineSim: 0 });
      } catch {
        // swallow — best-effort fetch
      }
    }

    const merged: MemoryRecallHit[] = [];
    for (const [mkId, mh] of mkById.entries()) {
      const excerpts = (excerptsByMk.get(mkId) ?? []).slice(
        0,
        this.opts.excerptsPerMemory,
      );
      const bestExcerpt = excerpts[0]?.cosineSim ?? 0;
      const score = Math.max(mh.cosineSim, bestExcerpt);
      merged.push({
        mk: mh.mk,
        excerpts: excerpts.map((e) => e.excerpt),
        score,
      });
    }
    merged.sort((a, b) => b.score - a.score);
    return merged.slice(0, this.opts.memoryLimit);
  }

  private async loadFtsHits(input: ContextBuildInput): Promise<TurnSearchHit[]> {
    // Vector search first when we have an embedding client + the backend
    // supports it. Semantic recall catches paraphrases ("kredite" ↔ "darlehen")
    // that plainto_tsquery misses. Empty result → fall through to FTS as a
    // lexical safety net (good for specific ids / names).
    if (this.embeddingClient) {
      try {
        const vector = await this.embeddingClient.embed(input.userMessage);
        if (vector.length > 0) {
          const hits = await this.graph.searchTurnsByEmbedding({
            queryEmbedding: vector,
            // OB-72: pass the user message verbatim as the FTS leg.
            // `plainto_tsquery('simple', …)` accepts arbitrary punctuation,
            // so no extra tokenisation needed. When the backend gets a
            // non-empty ftsQuery it switches to hybrid scoring.
            ftsQuery: input.userMessage,
            ...(input.userId ? { userId: input.userId } : {}),
            ...(input.sessionScope ? { excludeScope: input.sessionScope } : {}),
            ...(input.currentTurnId
              ? { excludeTurnIds: [input.currentTurnId] }
              : {}),
            ...(input.agentScopePrefix
              ? { agentScopePrefix: input.agentScopePrefix }
              : {}),
            limit: this.opts.ftsLimit,
            recallMinScore: this.opts.recallMinScore,
            recallRecencyBoost: this.opts.recallRecencyBoost,
            typeWeights: this.opts.recallTypeWeights,
          });
          if (hits.length > 0) return hits;
        }
      } catch (err) {
        console.error(
          '[context] vector search failed, falling back to FTS:',
          err instanceof Error ? err.message : err,
        );
      }
    }
    return this.graph.searchTurns({
      query: input.userMessage,
      ...(input.userId ? { userId: input.userId } : {}),
      ...(input.sessionScope ? { excludeScope: input.sessionScope } : {}),
      ...(input.currentTurnId ? { excludeTurnIds: [input.currentTurnId] } : {}),
      ...(input.agentScopePrefix
        ? { agentScopePrefix: input.agentScopePrefix }
        : {}),
      limit: this.opts.ftsLimit,
    });
  }
}

interface RenderInput {
  verbatimTurns: Array<{ time: string; userMessage: string; assistantAnswer: string }>;
  entityHits: EntityCapturedTurnsHit[];
  ftsHits: TurnSearchHit[];
  relatedEntities: GraphNode[];
  /** Slice 7 — curated-memory hits to render in their own section. */
  memoryHits: MemoryRecallHit[];
  maxChars: number;
}

function renderContext(input: RenderInput): string {
  const parts: string[] = [];
  let budget = input.maxChars;

  const push = (s: string): boolean => {
    if (s.length + 1 > budget) return false;
    parts.push(s);
    budget -= s.length + 1;
    return true;
  };

  if (input.verbatimTurns.length > 0) {
    push('## Letzte Turns in diesem Chat');
    for (const t of input.verbatimTurns) {
      const chunk = `- [${t.time}]\n  Nutzer: ${truncate(t.userMessage, 600)}\n  Assistent: ${truncate(t.assistantAnswer, 1200)}`;
      if (!push(chunk)) break;
    }
  }

  if (input.entityHits.length > 0 && budget > 500) {
    push('\n## Früher besprochene Entitäten (aus anderen Chats dieses Users)');
    for (const hit of input.entityHits) {
      const label =
        String(hit.entity.props['displayName'] ?? '') ||
        String(hit.entity.props['id'] ?? hit.entity.id);
      const system = String(hit.entity.props['system'] ?? '');
      const model = String(hit.entity.props['model'] ?? '');
      const header = `- ${label} (${system}:${model})`;
      if (!push(header)) break;
      for (const t of hit.turns) {
        const chunk = `  • [${t.time}] Frage: ${truncate(t.userMessage, 400)}\n    Antwort: ${truncate(t.assistantAnswer, 800)}`;
        if (!push(chunk)) break;
      }
    }
  }

  if (input.ftsHits.length > 0 && budget > 500) {
    push('\n## Inhaltlich ähnliche frühere Turns');
    for (const h of input.ftsHits) {
      const chunk = `- [${h.time}] (rank ${h.rank.toFixed(2)})\n  Frage: ${truncate(h.userMessage, 400)}\n  Antwort: ${truncate(h.assistantAnswer, 800)}`;
      if (!push(chunk)) break;
    }
  }

  if (input.relatedEntities.length > 0 && budget > 200) {
    push('\n## Entitäten aus diesen semantisch verwandten Turns');
    for (const e of input.relatedEntities) {
      const label =
        String(e.props['displayName'] ?? '') ||
        String(e.props['id'] ?? e.id);
      const system = String(e.props['system'] ?? '');
      const model = String(e.props['model'] ?? '');
      const id = String(e.props['id'] ?? '');
      const modelOrType = model || e.type;
      const chunk = `- ${label} (${system || e.type}:${modelOrType}${id ? `:${id}` : ''})`;
      if (!push(chunk)) break;
    }
  }

  // Slice 7 — curated-memory section. Rendered LAST so it follows the
  // recall sources (tail / entity / FTS) the LLM already trusts; this
  // keeps the prompt-cache prefix stable when the memory leg returns
  // [] (frequent in cold-start), at the cost of placing the strongest
  // signal at the bottom (LLM still sees it within the same block).
  if (input.memoryHits.length > 0 && budget > 400) {
    push('\n## Verwandte Memories');
    for (const hit of input.memoryHits) {
      const chunk = renderMemoryChunk(hit);
      if (!push(chunk)) break;
    }
  }

  return parts.join('\n');
}

/**
 * Slice 7 — render a single memory-recall hit. One header line per
 * MK with kind + summary, optional truncated rationale, and up to N
 * verbatim excerpt blockquotes. Hard char-cap per render so a few
 * verbose memories don't blow the context budget.
 */
function renderMemoryChunk(hit: MemoryRecallHit): string {
  const kind = String(hit.mk.props['kind'] ?? 'memory');
  const summary = truncate(String(hit.mk.props['summary'] ?? ''), 400);
  const rationaleRaw = hit.mk.props['rationale'];
  const lines = [
    `### ${kind}: ${summary} (score=${hit.score.toFixed(2)})`,
  ];
  if (typeof rationaleRaw === 'string' && rationaleRaw.length > 0) {
    lines.push(truncate(rationaleRaw, 300));
  }
  for (const ex of hit.excerpts) {
    const quote = truncate(ex.props.text, 240);
    lines.push(`> "${quote}"`);
  }
  return lines.join('\n');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/**
 * Cross-session recall probe — render the plan / process / insight blocks
 * that precede the turn context in the assembled prompt. Budget-aware via a
 * char cap; returns '' when nothing was recalled so the turn budget stays
 * untouched (byte-identical to pre-probe behaviour).
 */
function renderRecallBlocks(
  recalled: RecalledContext,
  maxChars: number,
): string {
  if (
    recalled.plans.length === 0 &&
    recalled.processes.length === 0 &&
    recalled.insights.length === 0
  ) {
    return '';
  }
  const parts: string[] = [];
  let budget = maxChars;
  const push = (s: string): boolean => {
    if (s.length + 1 > budget) return false;
    parts.push(s);
    budget -= s.length + 1;
    return true;
  };

  if (recalled.plans.length > 0) {
    push('## Aus früheren Sessions — offene Pläne');
    for (const p of recalled.plans) {
      const label = p.strategy ? truncate(p.strategy, 120) : 'Plan';
      const open =
        p.openStepGoals.length > 0
          ? ` · offen: ${truncate(p.openStepGoals.join('; '), 300)}`
          : '';
      const when = p.createdAt ? ` · ${p.createdAt}` : '';
      const chunk = `- ${label} (${p.doneCount}/${p.totalCount} Schritte erledigt)${open}${when}`;
      if (!push(chunk)) break;
    }
  }

  if (recalled.processes.length > 0 && budget > 200) {
    push('\n## Aus früheren Sessions — gespeicherte Prozesse');
    for (const pr of recalled.processes) {
      const chunk = `- ${truncate(pr.title, 160)} (${String(pr.stepCount)} Schritte, score ${pr.score.toFixed(2)})`;
      if (!push(chunk)) break;
    }
  }

  if (recalled.insights.length > 0 && budget > 200) {
    push('\n## Aus früheren Sessions — verwandte Erkenntnisse');
    for (const ins of recalled.insights) {
      const chunk = `- ${ins.kind}: ${truncate(ins.summary, 300)} (score ${ins.score.toFixed(2)})`;
      if (!push(chunk)) break;
    }
  }

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// OB-74 (Palaia Phase 5) — Assembler render helpers.
// ---------------------------------------------------------------------------

const COMPACT_USER_CHARS = 80;
const COMPACT_ASSISTANT_CHARS = 40;

/**
 * Render a single hit as a context chunk. Compact-Mode-Snippet (~120 chars)
 * when the candidate pool > compactModeThreshold; otherwise the usual
 * tail format with a truncate cap at 600/1200 chars (analogous to `renderContext`).
 */
function renderHitChunk(hit: CandidateHit, compactMode: boolean): string {
  const time = hit.time;
  if (compactMode) {
    const u = truncate(hit.userMessage, COMPACT_USER_CHARS);
    const a = truncate(hit.assistantAnswer, COMPACT_ASSISTANT_CHARS);
    return `- [${time}] ${u} … ${a}`;
  }
  return `- [${time}]\n  Nutzer: ${truncate(hit.userMessage, 600)}\n  Assistent: ${truncate(hit.assistantAnswer, 1200)}`;
}

function pickReason(c: CandidateHit): AssembledHitReason {
  // Multiplier reasons override origin in the audit so the operator sees
  // what *changed* the ranking — the recall-leg origin is implied by score.
  if (c.agentBoosted) return 'agent-boost';
  if (c.manuallyAuthored && c.origin !== 'tail') return 'manual-boost';
  return c.origin;
}

interface AssembledHitLookup {
  candidate: CandidateHit;
  meta: AssembledHit;
}

function renderAssembled(
  fillOrder: ReadonlyArray<CandidateHit>,
  included: ReadonlyArray<AssembledHit>,
  compactMode: boolean,
): string {
  if (included.length === 0) return '';
  const includedIds = new Set(included.map((h) => h.turnId));
  const ordered: AssembledHitLookup[] = [];
  for (const c of fillOrder) {
    if (!includedIds.has(c.turnId)) continue;
    const meta = included.find((h) => h.turnId === c.turnId);
    if (meta) ordered.push({ candidate: c, meta });
  }

  const parts: string[] = [];
  const tail = ordered.filter((o) => o.candidate.origin === 'tail');
  const recall = ordered.filter((o) => o.candidate.origin !== 'tail');

  if (tail.length > 0) {
    parts.push('## Letzte Turns in diesem Chat');
    for (const o of tail) {
      parts.push(renderHitChunk(o.candidate, compactMode));
    }
  }
  if (recall.length > 0) {
    parts.push(
      compactMode
        ? '\n## Inhaltlich verwandte Turns (compact)'
        : '\n## Inhaltlich verwandte Turns',
    );
    for (const o of recall) {
      parts.push(renderHitChunk(o.candidate, compactMode));
    }
  }
  return parts.join('\n');
}
