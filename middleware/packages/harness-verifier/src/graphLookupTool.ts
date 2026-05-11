import { z } from 'zod';
import type { KnowledgeGraph } from '@omadia/plugin-api';
import type { LocalSubAgentTool } from '@omadia/plugin-api';

// Phase 5B: `OdooScope` mirror — kept verbatim from
// `@omadia/integration-odoo` (now removed from this repo). The
// graphLookupTool is generic over scope so a future first-party Odoo
// integration shipped from a different repo can pass either literal.
type OdooScope = 'accounting' | 'hr';

/**
 * Sub-agent tool that reads stable master-data straight from the graph,
 * without round-tripping to Odoo. Scope-locked at construction time so an
 * HR sub-agent can never query res.partner through it, even if the LLM
 * tries.
 *
 * Why this is NOT the same as `query_knowledge_graph` (the orchestrator
 * tool): the orchestrator's variant has no scope — it can see the whole
 * graph including other users' sessions. The sub-agent version is locked
 * to its domain-relevant models only, to preserve the existing HR red-line
 * / accounting-scope boundaries.
 *
 * Freshness rule (baked into the tool description): slow-changing master
 * data only. Anything transactional (account.move, account.move.line, hr.leave,
 * hr.contract-data) must still come from Odoo via `odoo_execute`.
 */

const GRAPH_LOOKUP_MODELS: Record<OdooScope, ReadonlySet<string>> = {
  accounting: new Set([
    'res.partner',
    'account.journal',
    'account.account',
    'res.currency',
    'hr.department',
  ]),
  hr: new Set(['hr.employee', 'hr.department']),
};

const GraphLookupInputSchema = z.object({
  model: z.string().min(1).max(120),
  name_contains: z.string().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(200).default(25),
});

export function createGraphLookupTool(
  scope: OdooScope,
  deps: { graph: KnowledgeGraph },
): LocalSubAgentTool {
  const allowed = [...GRAPH_LOOKUP_MODELS[scope]].sort();
  return {
    spec: {
      name: 'query_graph',
      description: [
        'Read-only lookup of pre-synced business master-data from the local knowledge graph.',
        `Allowed models in the ${scope} scope: ${allowed.join(', ')}.`,
        'Use this BEFORE `odoo_execute` whenever the question is about stable master data — names of journals, departments, partners, accounts — because the graph answers in <10 ms instead of an Odoo round-trip.',
        'Data is synced from Odoo every 6h. Transactional state (open invoices, payments, leaves, contract amounts) is NOT in the graph and MUST come from `odoo_execute`.',
        'Input: `model` (required) + optional `name_contains` for case-insensitive substring on displayName/id + optional `limit` (default 25, max 200).',
        scope === 'hr'
          ? 'HR entities in the graph are already red-line-scrubbed (no wage, no private contact, no bank).'
          : '',
      ]
        .filter((s) => s.length > 0)
        .join(' '),
      input_schema: {
        type: 'object',
        properties: {
          model: {
            type: 'string',
            description: `Exact Odoo model name. One of: ${allowed.join(', ')}.`,
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
      if (!GRAPH_LOOKUP_MODELS[scope].has(model)) {
        return `Error: model_not_allowed — ${model} is not in the ${scope}-scope graph whitelist (${allowed.join(', ')}). Use \`odoo_execute\` for other models.`;
      }
      try {
        const entities = await deps.graph.findEntities({
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
