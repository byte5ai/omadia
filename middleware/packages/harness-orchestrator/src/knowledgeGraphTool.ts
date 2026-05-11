import { z } from 'zod';
import type { EmbeddingClient } from '@omadia/embeddings';
import type { KnowledgeGraph } from '@omadia/plugin-api';

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
    'Read-only lookup against the middleware\'s local knowledge graph of past sessions, turns, and the Odoo/Confluence entities they touched. Use BEFORE delegating to a sub-agent when the user references prior work ("wie bei Müller letztens", "die Diskussion über Projekt X", "das gleiche wie gestern"). Queries:\n- `stats`: node/edge counts.\n- `list_sessions`: recent sessions with counts.\n- `find_entity`: entities by `name_contains` and/or `model`, plus turns that mentioned them. Use for "wer ist …" / "haben wir Kunde X" questions.\n- `session_summary`: turns in one scope with captured entities.\n- **`search_turns`**: full-text search across ALL past turn bodies (userMessage + assistantAnswer). Use for topical questions like "haben wir schon mal über Mahnwesen gesprochen?" — pass `text` with the keyword(s).\n- **`search_turns_semantic`**: embedding-based (cosine) search. Use for paraphrases / conceptual questions where exact keywords may not appear ("Rechnungsprobleme" ≈ "offene Posten", "Darlehen" ≈ "Kredit"). Pass `text`. More expensive than `search_turns`; prefer it when FTS returns nothing.',
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

export class KnowledgeGraphTool {
  constructor(
    private readonly graph: KnowledgeGraph,
    private readonly embeddingClient?: EmbeddingClient,
  ) {}

  async handle(input: unknown): Promise<string> {
    const parsed = KnowledgeGraphInputSchema.safeParse(input);
    if (!parsed.success) {
      return `Error: invalid knowledge-graph input — ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`;
    }
    const args = parsed.data;

    switch (args.query) {
      case 'stats': {
        const stats = await this.graph.stats();
        return JSON.stringify(stats);
      }

      case 'list_sessions': {
        const all = await this.graph.listSessions();
        return JSON.stringify({ sessions: all.slice(0, args.limit) });
      }

      case 'find_entity': {
        if (!args.name_contains && !args.model) {
          return 'Error: find_entity requires at least one of `name_contains` or `model`.';
        }
        return JSON.stringify(
          await this.findEntity(args.name_contains, args.model, args.limit),
        );
      }

      case 'search_turns': {
        if (!args.text) {
          return 'Error: search_turns requires `text` (a keyword / phrase).';
        }
        const hits = await this.graph.searchTurns({
          query: args.text,
          limit: Math.min(args.limit, 20),
        });
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
        let vector: number[];
        try {
          vector = await this.embeddingClient.embed(args.text);
        } catch (err) {
          return `Error: embedding failed — ${err instanceof Error ? err.message : String(err)}. Retry with \`search_turns\` for FTS.`;
        }
        const hits = await this.graph.searchTurnsByEmbedding({
          queryEmbedding: vector,
          limit: Math.min(args.limit, 20),
          minSimilarity: 0.25,
        });
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
        const view = await this.graph.getSession(args.scope);
        if (!view) {
          return JSON.stringify({ scope: args.scope, error: 'not_found' });
        }
        // Compact representation — the sub-agent doesn't need every prop.
        return JSON.stringify({
          scope: args.scope,
          turns: view.turns.map((t) => ({
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
  ): Promise<unknown> {
    // We don't have an index — walk the listSessions output, collect unique
    // entity nodes via getNeighbors, then filter. Fine at the in-memory scale;
    // a real backend would push the predicate down to the store.
    const sessions = await this.graph.listSessions();
    const seen = new Map<string, { node: { id: string; type: string; props: Record<string, unknown> }; turns: string[] }>();
    for (const summary of sessions) {
      const view = await this.graph.getSession(summary.scope);
      if (!view) continue;
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
