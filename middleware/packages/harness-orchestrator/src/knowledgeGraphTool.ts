import { z } from 'zod';
import type { EmbeddingClient } from '@omadia/embeddings';
import type { KnowledgeGraph, SessionSummary, SessionView } from '@omadia/plugin-api';

const KnowledgeGraphInputSchema = z.object({
  query: z.enum([
    'stats',
    'list_sessions',
    'find_entity',
    'session_summary',
    'search_turns',
    'search_turns_semantic',
  ]),
  /** Substring match against displayName (case-insensitive). Used by `find_entity`. */
  name_contains: z.string().min(1).max(200).optional(),
  /** Restrict entity search to one model (e.g. `hr.employee`). Used by `find_entity`. */
  model: z.string().min(1).max(120).optional(),
  /** Session scope to summarise. Used by `session_summary`. */
  scope: z.string().min(1).max(200).optional(),
  /** Free-text query for `search_turns` (FTS) and `search_turns_semantic`
   *  (embedding cosine). Keep short — 2–8 words works best. */
  text: z.string().min(1).max(500).optional(),
  /** Cap on items returned for list-style queries. Default 20, max 100. */
  limit: z.number().int().min(1).max(100).default(20),
});

export const KNOWLEDGE_GRAPH_TOOL_NAME = 'query_knowledge_graph';

export const knowledgeGraphToolSpec = {
  name: KNOWLEDGE_GRAPH_TOOL_NAME,
  description:
    'Read-only lookup against the middleware\'s local knowledge graph of past sessions, turns, and the integration entities they touched. Use BEFORE delegating to a sub-agent when the user references prior work ("wie bei Müller letztens", "die Diskussion über Projekt X", "das gleiche wie gestern"). Queries:\n- `stats`: node/edge counts.\n- `list_sessions`: recent sessions with counts.\n- `find_entity`: entities by `name_contains` and/or `model`, plus turns that mentioned them. Use for "wer ist …" / "haben wir Kunde X" questions.\n- `session_summary`: turns in one scope with captured entities.\n- **`search_turns`**: full-text search across ALL past turn bodies (userMessage + assistantAnswer). Use for topical questions like "haben wir schon mal über Mahnwesen gesprochen?" — pass `text` with the keyword(s).\n- **`search_turns_semantic`**: embedding-based (cosine) search. Use for paraphrases / conceptual questions where exact keywords may not appear ("Rechnungsprobleme" ≈ "offene Posten", "Darlehen" ≈ "Kredit"). Pass `text`. More expensive than `search_turns`; prefer it when FTS returns nothing.',
  input_schema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        enum: [
          'stats',
          'list_sessions',
          'find_entity',
          'session_summary',
          'search_turns',
          'search_turns_semantic',
        ],
      },
      name_contains: { type: 'string' },
      model: { type: 'string' },
      scope: { type: 'string' },
      text: { type: 'string' },
      limit: { type: 'integer' },
    },
    required: ['query'],
  },
};

/**
 * What one turn may see through this tool. Absent: the whole tenant graph, as
 * before. Neither variant ever degrades into "no restriction" — the `null`
 * forms mean the turn sees nothing.
 *
 *  - `restrictToScope` — `enforce-strict`: only the turn's own conversation,
 *    by its graph scope (`<agentSlug>::<scope>`). `null` = no conversation.
 *  - `audienceOwners` — `members`: only turns of this agent
 *    (`agentScopePrefix`) whose owners include everyone present. `null` = the
 *    room's audience is not known.
 */
export type KnowledgeGraphToolView =
  | { readonly restrictToScope: string | null }
  | { readonly audienceOwners: readonly string[] | null; readonly agentScopePrefix: string };

const RESTRICTED_NOTE: Record<'conversation' | 'members', string> = {
  conversation: 'context memory is enforce-strict: only this conversation is visible',
  members: 'context memory is members: only knowledge everyone present owns is visible',
};

/** One turn's access to the graph, derived once from its view. */
interface ToolAccess {
  /** Set when any restriction applies; reported back to the model. */
  readonly note?: string;
  /** The turn may see nothing at all. */
  readonly none: boolean;
  /** Pushed down into the backend's turn searches. */
  readonly searchOptions: { agentScopePrefix?: string; audienceOwners?: readonly string[] };
  /** Cheap scope pre-filter; the owner rule is applied by `readSession`. */
  scopeAllowed(scope: string): boolean;
  /** The session as this turn may see it, or null. */
  readSession(scope: string): Promise<SessionView | null>;
}

export class KnowledgeGraphTool {
  constructor(
    private readonly graph: KnowledgeGraph,
    private readonly embeddingClient?: EmbeddingClient,
  ) {}

  private access(view: KnowledgeGraphToolView | undefined): ToolAccess {
    if (view === undefined) {
      return {
        none: false,
        searchOptions: {},
        scopeAllowed: () => true,
        readSession: (scope) => this.graph.getSession(scope),
      };
    }
    if ('restrictToScope' in view) {
      const only = view.restrictToScope;
      // Exact match: the search pre-filter is a LIKE prefix, not equality.
      const allowed = (scope: string): boolean => only !== null && scope === only;
      return {
        note: RESTRICTED_NOTE.conversation,
        none: only === null,
        searchOptions: only ? { agentScopePrefix: only } : {},
        scopeAllowed: allowed,
        readSession: async (scope) => (allowed(scope) ? this.graph.getSession(scope) : null),
      };
    }
    const audience = view.audienceOwners;
    const allowed = (scope: string): boolean =>
      audience !== null && scope.startsWith(view.agentScopePrefix);
    return {
      note: RESTRICTED_NOTE.members,
      none: audience === null,
      searchOptions: audience
        ? { agentScopePrefix: view.agentScopePrefix, audienceOwners: audience }
        : {},
      scopeAllowed: allowed,
      readSession: async (scope) =>
        allowed(scope) && audience ? this.graph.getSession(scope, { audienceOwners: audience }) : null,
    };
  }

  /** Every session this turn may see, as it may see it. */
  private async visibleSessions(
    access: ToolAccess,
  ): Promise<Array<{ summary: SessionSummary; view: SessionView }>> {
    if (access.none) return [];
    const out: Array<{ summary: SessionSummary; view: SessionView }> = [];
    for (const summary of await this.graph.listSessions()) {
      if (!access.scopeAllowed(summary.scope)) continue;
      const view = await access.readSession(summary.scope);
      if (view) out.push({ summary, view });
    }
    return out;
  }

  async handle(input: unknown, view?: KnowledgeGraphToolView): Promise<string> {
    const parsed = KnowledgeGraphInputSchema.safeParse(input);
    if (!parsed.success) {
      return `Error: invalid knowledge-graph input — ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`;
    }
    const args = parsed.data;
    const access = this.access(view);
    const noteField = access.note ? { restricted: access.note } : {};

    switch (args.query) {
      case 'stats': {
        if (access.note) {
          const sessions = await this.visibleSessions(access);
          return JSON.stringify({
            ...noteField,
            sessions: sessions.length,
            turns: sessions.reduce((n, s) => n + s.view.turns.length, 0),
          });
        }
        const stats = await this.graph.stats();
        return JSON.stringify(stats);
      }

      case 'list_sessions': {
        if (!access.note) {
          const all = await this.graph.listSessions();
          return JSON.stringify({ sessions: all.slice(0, args.limit) });
        }
        // Counts and dates from the VISIBLE turns: the stored summary would
        // tell how much was said before or without the people present.
        const sessions = (await this.visibleSessions(access)).map(({ summary, view }) => {
          const times = view.turns.map((t) => String(t.turn.props['time'] ?? '')).sort();
          return {
            ...summary,
            turnCount: view.turns.length,
            firstAt: times[0] ?? summary.firstAt,
            lastAt: times.at(-1) ?? summary.lastAt,
          };
        });
        return JSON.stringify({ sessions: sessions.slice(0, args.limit), ...noteField });
      }

      case 'find_entity': {
        if (!args.name_contains && !args.model) {
          return 'Error: find_entity requires at least one of `name_contains` or `model`.';
        }
        return JSON.stringify(
          await this.findEntity(args.name_contains, args.model, args.limit, access),
        );
      }

      case 'search_turns': {
        if (!args.text) {
          return 'Error: search_turns requires `text` (a keyword / phrase).';
        }
        if (access.none) {
          return JSON.stringify({ query: args.text, mode: 'fts', hits: [], ...noteField });
        }
        // Restricted: push the restriction down so the limit counts visible
        // turns, then re-check the scope (the prefix is a LIKE).
        const hits = (
          await this.graph.searchTurns({
            query: args.text,
            limit: Math.min(args.limit, 20),
            ...access.searchOptions,
          })
        ).filter((h) => access.scopeAllowed(h.scope));
        return JSON.stringify({
          query: args.text,
          mode: 'fts',
          hits: hits.map((h) => ({
            turnId: h.turnId,
            scope: h.scope,
            time: h.time,
            rank: Number(h.rank.toFixed(3)),
            userMessage: truncateForOutput(h.userMessage, 240),
            assistantAnswer: truncateForOutput(h.assistantAnswer, 480),
          })),
        });
      }

      case 'search_turns_semantic': {
        if (!args.text) {
          return 'Error: search_turns_semantic requires `text`.';
        }
        if (!this.embeddingClient) {
          return 'Error: embeddings not configured — use `search_turns` for keyword-based search instead.';
        }
        if (access.none) {
          return JSON.stringify({ query: args.text, mode: 'embedding', hits: [], ...noteField });
        }
        let vector: number[];
        try {
          vector = await this.embeddingClient.embed(args.text);
        } catch (err) {
          return `Error: embedding failed — ${err instanceof Error ? err.message : String(err)}. Retry with \`search_turns\` for FTS.`;
        }
        const hits = (
          await this.graph.searchTurnsByEmbedding({
            queryEmbedding: vector,
            limit: Math.min(args.limit, 20),
            minSimilarity: 0.25,
            ...access.searchOptions,
          })
        ).filter((h) => access.scopeAllowed(h.scope));
        return JSON.stringify({
          query: args.text,
          mode: 'embedding',
          hits: hits.map((h) => ({
            turnId: h.turnId,
            scope: h.scope,
            time: h.time,
            similarity: Number(h.rank.toFixed(3)),
            userMessage: truncateForOutput(h.userMessage, 240),
            assistantAnswer: truncateForOutput(h.assistantAnswer, 480),
          })),
        });
      }

      case 'session_summary': {
        if (!args.scope) {
          return 'Error: session_summary requires `scope`.';
        }
        // A scope the turn may not see answers exactly like a missing one, so
        // the reply does not confirm that it exists.
        const session = await access.readSession(args.scope);
        if (!session) {
          return JSON.stringify({ scope: args.scope, error: 'not_found' });
        }
        // Compact representation — the sub-agent doesn't need every prop.
        return JSON.stringify({
          scope: args.scope,
          turns: session.turns.map((t) => ({
            time: t.turn.props['time'],
            userMessage: t.turn.props['userMessage'],
            assistantAnswer: t.turn.props['assistantAnswer'],
            entities: t.entities.map((e) => ({
              type: e.type,
              id: e.id,
              model: e.props['model'],
              externalId: e.props['externalId'],
              displayName: e.props['displayName'],
            })),
          })),
        });
      }
    }
  }

  private async findEntity(
    nameContains: string | undefined,
    model: string | undefined,
    limit: number,
    access: ToolAccess,
  ): Promise<unknown> {
    // We don't have an index — walk the visible sessions, collect unique
    // entity nodes, then filter. Fine at the in-memory scale; a real backend
    // would push the predicate down to the store.
    const seen = new Map<string, { node: { id: string; type: string; props: Record<string, unknown> }; turns: string[] }>();
    for (const { view } of await this.visibleSessions(access)) {
      for (const t of view.turns) {
        for (const entity of t.entities) {
          const displayName = String(entity.props['displayName'] ?? '').toLowerCase();
          const entityModel = String(entity.props['model'] ?? '');
          if (nameContains && !displayName.includes(nameContains.toLowerCase())) continue;
          if (model && entityModel !== model) continue;
          const existing = seen.get(entity.id);
          if (existing) {
            existing.turns.push(String(t.turn.props['time'] ?? ''));
          } else {
            seen.set(entity.id, {
              node: {
                id: entity.id,
                type: entity.type,
                props: { ...entity.props },
              },
              turns: [String(t.turn.props['time'] ?? '')],
            });
          }
        }
      }
    }
    const entities = [...seen.values()]
      .sort((a, b) => b.turns.length - a.turns.length)
      .slice(0, limit)
      .map((hit) => ({
        id: hit.node.id,
        type: hit.node.type,
        model: hit.node.props['model'],
        externalId: hit.node.props['externalId'],
        displayName: hit.node.props['displayName'],
        mentionedInTurns: hit.turns.length,
        lastMentionedAt: hit.turns.sort().pop(),
      }));
    return { entities };
  }
}

function truncateForOutput(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}
