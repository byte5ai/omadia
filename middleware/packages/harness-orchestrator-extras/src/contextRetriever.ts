import type { EmbeddingClient } from '@omadia/embeddings';
import {
  turnNodeId,
  type AgentPrioritiesStore,
  type AgentPriorityRecord,
  type EntityCapturedTurnsHit,
  type EntryType,
  type GraphNode,
  type KnowledgeGraph,
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

  // OB-74 (Palaia Phase 5) — Token-Budget-Assembler-Knöpfe.
  /** Default-Budget für `assembleForBudget`, falls Caller keins angibt.
   *  Default 6000 (~24k chars bei charsPerToken=4). */
  defaultBudgetTokens?: number;
  /** Faustregel für Token-Schätzung in `chars / charsPerToken`. Default 4. */
  charsPerToken?: number;
  /** Score-Multiplier für `manuallyAuthored=true`-Hits. Default 1.3 (palaia). */
  manualBoostFactor?: number;
  /** Über dieser Anzahl Hits aktiviert sich der Compact-Snippet-Mode.
   *  Default 100. */
  compactModeThreshold?: number;
}

export interface ContextBuildInput {
  userMessage: string;
  sessionScope?: string;
  userId?: string;
  /** External id of the turn currently being answered — excluded from hits. */
  currentTurnId?: string;
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
  };
}

// ---------------------------------------------------------------------------
// OB-74 (Palaia Phase 5) — Token-Budget-Assembler.
//
// `assembleForBudget` ergänzt `build` um eine token-aware Greedy-Fill-Pipeline:
//   1. Tail-Turns (chronologisch, score=1.0 synthetic) gehen ZUERST in den
//      Fill — Recency wins, auch gegen höher-gescorte Hybrid-Hits.
//   2. Verbleibende Hits (Entity-Hits + Hybrid-FTS) werden nach Score
//      DESC sortiert (ties broken by turnId ASC für Determinismus).
//   3. Score-Multiplier: `manuallyAuthored=true` → ×manualBoostFactor (1.3),
//      `agent_priorities[entry].action='boost'` → ×weight.
//   4. Filter: `agent_priorities[entry].action='block'` → drop.
//   5. Compact-Mode bei >compactModeThreshold (100) Kandidaten — pro Hit nur
//      ein ~120-char-Snippet statt full-body, sonst frisst der Pool das
//      Budget.
//   6. Greedy Fill bis tokensUsed + hitTokens > budget → break.
// ---------------------------------------------------------------------------

export interface AssembleForBudgetInput {
  userMessage: string;
  sessionScope?: string;
  userId?: string;
  /** External id of the turn currently being answered — excluded from hits. */
  currentTurnId?: string;
  /** Wer fragt — driver für agent_priorities-Lookup. */
  agentId: string;
  /** Optional override; sonst `defaultBudgetTokens` aus den ContextRetriever-Opts. */
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
  /** Final score nach allen Multiplier (raw × manual × agent). */
  score: number;
  /** Charcount des gerenderten Chunks (tail-block ODER full ODER snippet). */
  chars: number;
  /** Welcher Recall-Pfad hat diesen Hit geliefert / ggf. welcher Multiplier
   *  hat ihn aufgewertet. `manual-boost` / `agent-boost` overriden bloß
   *  `entity`/`fts` wenn relevant — Audit-Karte zeigt den dominanten Grund. */
  reason: AssembledHitReason;
}

export interface AssembledExclusion {
  turnId: string;
  reason: 'budget-exceeded' | 'agent-blocked';
}

export interface AssembledContext {
  /** Final-rendered prose, ≤ budget tokens (best-effort, basierend auf
   *  `chars/charsPerToken`). Leerer String wenn nichts gepasst hat. */
  text: string;
  included: AssembledHit[];
  excluded: AssembledExclusion[];
  stats: {
    /** Größe des candidate pools VOR dem Greedy-Fill. */
    candidatePool: number;
    /** True wenn der Pool > compactModeThreshold war. */
    compactMode: boolean;
    /** Tatsächlich konsumierte Token (Schätzung via charsPerToken). */
    tokensUsed: number;
  };
}

interface CandidateHit {
  turnId: string;
  scope: string;
  time: string;
  userMessage: string;
  assistantAnswer: string;
  /** Score VOR Multiplier (raw hybrid score oder synthetic 1.0 für tail). */
  rawScore: number;
  /** Quelle des Hits — verschmolzen mit Multiplier-Reason im Output. */
  origin: 'tail' | 'entity' | 'fts';
  manuallyAuthored: boolean;
  /** Inkrementeller Boost durch `agent_priorities.action='boost'`. */
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
 *  2. Entity-anchored turns — turns that captured an OdooEntity or
 *     ConfluencePage whose label/id appears in the current user message.
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
    /** OB-74 (Palaia Phase 5) — optional. Wenn der KG-Provider die
     *  `agentPriorities@1`-Capability nicht published, läuft der
     *  Assembler ohne Block/Boost (manual_authored × 1.3 bleibt aktiv). */
    private readonly agentPriorities?: AgentPrioritiesStore,
  ) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  async build(input: ContextBuildInput): Promise<ContextBuildResult> {
    const extractedTerms = extractCandidateTerms(input.userMessage);

    const [tail, entityHits, ftsHits] = await Promise.all([
      this.loadTail(input),
      this.loadEntityHits(input, extractedTerms),
      this.loadFtsHits(input),
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
      maxChars: this.opts.maxChars,
    });

    // Structured one-liner so we can diagnose "follow-up forgot its context"
    // without adding verbose retrieval traces. stderr is used so Fly's log
    // aggregator reliably forwards it (we've seen stdout INFO lines dropped).
    const scope = input.sessionScope ?? '<no-scope>';
    const termsPreview = extractedTerms.slice(0, 5).join(',');
    console.error(
      `[context:inner] scope=${scope} tail=${String(tail.length)} entity-hits=${String(entityHitsFiltered.length)} fts=${String(ftsHitsFiltered.length)} terms=[${termsPreview}] rendered=${String(text.length)}B`,
    );

    return {
      text,
      sources: {
        verbatimTurns: tail,
        entityHits: entityHitsFiltered,
        ftsHits: ftsHitsFiltered,
        relatedEntities,
        extractedTerms,
      },
    };
  }

  /**
   * OB-74 (Palaia Phase 5) — Token-Budget Greedy-Fill Assembler.
   *
   * Sammelt dieselben Recall-Legs wie `build()`, aber sortiert/filtert die
   * Hit-Liste agent-spezifisch (Block/Boost via `agent_priorities`),
   * applied `manuallyAuthored × manualBoostFactor`, und füllt einen
   * Token-Budget greedy nach Score. Tail-Turns gehen zuerst in den Fill —
   * Recency wins gegen höher-gescortes Hybrid.
   *
   * Side-effect-frei zu `build()`: ruft die gleichen Graph-Methoden auf,
   * mutiert keinen geteilten State.
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
    };

    const [tail, entityHits, ftsHits, prioritiesIndex] = await Promise.all([
      this.loadTail(buildInput),
      this.loadEntityHits(buildInput, extractedTerms),
      this.loadFtsHits(buildInput),
      this.loadAgentPriorities(input.agentId),
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
          // Entity-Hits haben keinen score → synthetic 0.7 (zwischen tail
          // und ungeranktem FTS, Operator-Erfahrung aus OB-72 zeigt sie sind
          // hochrelevant wenn die Entity getroffen wurde).
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

    // Greedy fill — tail-turns FIRST (chronological), then everything else
    // sorted by score DESC (ties → turnId ASC for determinism).
    const tailTurns = filtered.filter((c) => c.origin === 'tail');
    const nonTail = filtered
      .filter((c) => c.origin !== 'tail')
      .sort((a, b) => {
        if (b.rawScore !== a.rawScore) return b.rawScore - a.rawScore;
        return a.turnId.localeCompare(b.turnId);
      });
    const fillOrder = [...tailTurns, ...nonTail];

    const included: AssembledHit[] = [];
    let tokensUsed = 0;
    for (const c of fillOrder) {
      const chunk = renderHitChunk(c, compactMode);
      const chunkChars = chunk.length;
      const chunkTokens = Math.ceil(chunkChars / charsPerToken);
      if (tokensUsed + chunkTokens > budgetTokens) {
        excluded.push({ turnId: c.turnId, reason: 'budget-exceeded' });
        continue;
      }
      tokensUsed += chunkTokens;
      included.push({
        turnId: c.turnId,
        score: c.rawScore,
        chars: chunkChars,
        reason: pickReason(c),
      });
      // Defensive: budget check on chars too (rounding can edge out the
      // token estimate by 1-2 tokens; chars cap is the hard ceiling).
      if (chunkChars > budgetChars) break;
    }

    const text = renderAssembled(fillOrder, included, compactMode);

    const scope = input.sessionScope ?? '<no-scope>';
    console.error(
      `[context:assembled] scope=${scope} agent=${input.agentId} pool=${String(filtered.length)} included=${String(included.length)} excluded=${String(excluded.length)} compact=${String(compactMode)} tokens=${String(tokensUsed)}/${String(budgetTokens)}`,
    );

    return {
      text,
      included,
      excluded,
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
          if (n.type !== 'OdooEntity' && n.type !== 'ConfluencePage') continue;
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
      perEntityLimit: 2,
      entityLimit: this.opts.entityLimit,
    });
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
      limit: this.opts.ftsLimit,
    });
  }
}

interface RenderInput {
  verbatimTurns: Array<{ time: string; userMessage: string; assistantAnswer: string }>;
  entityHits: EntityCapturedTurnsHit[];
  ftsHits: TurnSearchHit[];
  relatedEntities: GraphNode[];
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

  return parts.join('\n');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

// ---------------------------------------------------------------------------
// OB-74 (Palaia Phase 5) — Assembler-Render-Helper.
// ---------------------------------------------------------------------------

const COMPACT_USER_CHARS = 80;
const COMPACT_ASSISTANT_CHARS = 40;

/**
 * Render a single hit as a context chunk. Compact-Mode-Snippet (~120 chars)
 * wenn der candidate pool > compactModeThreshold ist; sonst das übliche
 * Tail-Format mit einer truncate-Cap auf 600/1200 chars (analog `renderContext`).
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
