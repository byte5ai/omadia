import { z } from 'zod';
import type { KnowledgeGraph } from '@omadia/plugin-api';
import type { LocalSubAgentTool } from '@omadia/plugin-api';

/**
 * Sub-agent tool that reads stable master-data straight from the graph,
 * scope-locked at construction time. Pass `scope` (a free-form label for
 * the tool description / error messages) and `allowedModels` (a whitelist
 * of model names the tool will accept). Domain plugins build their own
 * scope+model bundle and hand it in; the tool itself stays domain-agnostic.
 *
 * Why this is NOT the same as `query_knowledge_graph` (the orchestrator
 * tool): the orchestrator's variant has no scope — it can see the whole
 * graph including other users' sessions. The sub-agent version is locked
 * to its domain-relevant models only, to preserve the existing
 * domain-scope boundaries.
 *
 * Freshness rule (baked into the tool description): slow-changing master
 * data only. Transactional state belongs in the source-of-truth integration's
 * own tool surface.
 */

const GraphLookupInputSchema = z.object({
  model: z.string().min(1).max(120),
  name_contains: z.string().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(200).default(25),
});

export interface GraphLookupToolOptions {
  /** Free-form scope label, used in tool description + error messages. */
  scope: string;
  /** Whitelist of model names the tool will accept. */
  allowedModels: readonly string[];
  /** Live KnowledgeGraph handle. */
  graph: KnowledgeGraph;
  /**
   * Optional sub-agent-specific note appended to the tool description —
   * e.g. red-line caveats for an HR-scoped lookup.
   */
  scopeNote?: string;
}

export function createGraphLookupTool(
  opts: GraphLookupToolOptions,
): LocalSubAgentTool {
  const allowed = [...opts.allowedModels].sort();
  const allowedSet = new Set(allowed);
  const description = [
    'Read-only lookup of pre-synced business master-data from the local knowledge graph.',
    `Allowed models in the ${opts.scope} scope: ${allowed.join(', ')}.`,
    'Use this for questions about stable master data — names, departments, partners, accounts — because the graph answers in <10 ms instead of a live source round-trip.',
    'Data is synced from the source-of-truth integration on a schedule. Transactional state (open records, in-flight transactions) is NOT in the graph and MUST come from the integration\'s own live tools.',
    'Input: `model` (required) + optional `name_contains` for case-insensitive substring match on displayName/id + optional `limit` (default 25, max 200).',
    opts.scopeNote ?? '',
  ]
    .filter((s) => s.length > 0)
    .join(' ');

  return {
    spec: {
      name: 'query_graph',
      description,
      input_schema: {
        type: 'object',
        properties: {
          model: {
            type: 'string',
            description: `Exact model name. One of: ${allowed.join(', ')}.`,
          },
          name_contains: {
            type: 'string',
            description: 'Case-insensitive substring match on displayName or id.',
          },
          limit: { type: 'integer' },
        },
        required: ['model'],
      },
    },
    async handle(input: unknown): Promise<string> {
      const parsed = GraphLookupInputSchema.safeParse(input);
      if (!parsed.success) {
        return `Error: invalid query_graph input — ${parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`;
      }
      const { model, name_contains, limit } = parsed.data;
      if (!allowedSet.has(model)) {
        return `Error: model_not_allowed — ${model} is not in the ${opts.scope}-scope graph whitelist (${allowed.join(', ')}). Use the integration's live tool for other models.`;
      }
      try {
        const entities = await opts.graph.findEntities({
          model,
          ...(name_contains ? { nameContains: name_contains } : {}),
          limit,
        });
        return JSON.stringify({
          model,
          count: entities.length,
          entities: entities.map((e) => ({
            id: e.props['id'],
            displayName: e.props['displayName'],
            extras: collectExtras(e.props),
          })),
        });
      } catch (err) {
        return `Error: graph lookup failed — ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

/**
 * Pull the useful extra fields off a node. We skip the `system`, `model`,
 * `id`, `displayName` keys (already returned at the top level) and every
 * internal-bookkeeping key so the sub-agent doesn't waste tokens.
 */
function collectExtras(props: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const skip = new Set(['system', 'model', 'id', 'displayName']);
  for (const [k, v] of Object.entries(props)) {
    if (skip.has(k)) continue;
    if (v === undefined || v === null || v === '') continue;
    out[k] = v;
  }
  return out;
}
