/**
 * Test helper — the fast path now asks a ROUTER and a PLANNER (forced tool
 * calls) instead of reading a plan out of the composer / triage JSON. Many
 * scenarios are written as that legacy combined fixture; this wrapper keeps
 * them readable: the inner fake still answers with the legacy text, and for a
 * `route_turn` / `plan_query` request the wrapper converts it into the tool
 * call a well-behaved router/planner would make.
 *
 *   - composer shape `{tree, dataRequirements:[{…, fetch}], summary, locale}`:
 *     deterministic when EVERY requirement has a fetch; the plan is the first
 *     requirement's fetch + containerId + summary/locale.
 *   - triage shape `{decision, fetch, labels, summary, locale, route}`.
 *   - anything unparseable: returned as text (router/planner invalid).
 */
import {
  extractFirstJsonObject,
  PLANNER_TOOL,
  ROUTER_TOOL,
  validatePlannedQuery,
  type PlannedQuery,
} from '../../packages/harness-plugin-fast-path/src/index.js';

interface LlmLike {
  complete(req: never): Promise<{ text: string; toolCalls?: ReadonlyArray<{ name: string; input: unknown }> }>;
}

type Legacy =
  | { kind: 'plan'; tool: string; plan: Record<string, unknown> }
  | { kind: 'agent'; route: 'simple' | 'complex' };

function parseLegacy(text: string): Legacy | undefined {
  let o: Record<string, unknown>;
  try {
    const start = text.indexOf('{');
    o = JSON.parse(text.slice(start, text.lastIndexOf('}') + 1)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (typeof o['decision'] === 'string') {
    if (o['decision'] !== 'deterministic') return { kind: 'agent', route: o['route'] === 'simple' ? 'simple' : 'complex' };
    const fetch = (o['fetch'] ?? {}) as Record<string, unknown>;
    const { decision: _d, fetch: _f, ...rest } = o;
    return { kind: 'plan', tool: String(fetch['tool']), plan: { ...fetch, ...rest } };
  }
  const reqs = Array.isArray(o['dataRequirements']) ? (o['dataRequirements'] as Array<Record<string, unknown>>) : [];
  const first = reqs[0];
  if (first === undefined || !reqs.every((r) => r['fetch'] !== undefined)) return { kind: 'agent', route: 'complex' };
  const fetch = first['fetch'] as Record<string, unknown>;
  return {
    kind: 'plan',
    tool: String(fetch['tool']),
    plan: {
      containerId: first['containerId'],
      ...fetch,
      ...(o['summary'] !== undefined ? { summary: o['summary'] } : {}),
      ...(o['locale'] !== undefined ? { locale: o['locale'] } : {}),
    },
  };
}

/** A router/planner request the wrapper answered. */
export interface ForcedCall {
  tool: string;
  system: string;
  user: string;
}

/** Wrap `inner` so router/planner requests get tool calls derived from the
 *  legacy text. With `opts.text` the legacy text comes from there and forced
 *  requests never reach `inner` (its recordings stay composer-only); they
 *  are recorded in `opts.forced`. Without it `inner` answers every request. */
export function withRouterPlanner<T extends LlmLike>(
  inner: T,
  opts: { text?: () => string; forced?: ForcedCall[] } = {},
): T {
  return {
    ...inner,
    complete: async (req: { toolChoice?: { name: string }; system?: string; messages?: Array<{ content: string }> }) => {
      const forced = req.toolChoice?.name;
      const isForced = forced === ROUTER_TOOL || forced === PLANNER_TOOL;
      if (isForced) opts.forced?.push({ tool: forced, system: req.system ?? '', user: req.messages?.[0]?.content ?? '' });
      const res = isForced && opts.text ? { text: opts.text() } : await inner.complete(req as never);
      if (!isForced) return res;
      const legacy = parseLegacy(res.text);
      if (legacy === undefined) return res;
      const input =
        forced === PLANNER_TOOL
          ? legacy.kind === 'plan'
            ? legacy.plan
            : {}
          : legacy.kind === 'plan'
            ? { decision: 'deterministic', tool: legacy.tool, confidence: 0.9 }
            : { decision: `agent_${legacy.route}`, confidence: 0.9 };
      return { text: '', toolCalls: [{ name: forced, input }] };
    },
  } as T;
}

/** The legacy one-call triage answer, validated by the shared plan whitelist
 *  (`validatePlannedQuery`) — keeps the whitelist tests readable. */
export type LegacyTriageDecision =
  | ({ decision: 'deterministic' } & PlannedQuery)
  | { decision: 'agent'; route?: 'simple' | 'complex' }
  | { decision: 'invalid'; reason: string };

export function parseTriage(
  raw: string,
  allowedTools: ReadonlySet<string>,
  opts: { question?: string } = {},
): LegacyTriageDecision {
  const extracted = extractFirstJsonObject(raw);
  if (!extracted.ok) return { decision: 'invalid', reason: 'unparseable' };
  const o = extracted.value;
  if (o['decision'] === 'agent') {
    const route = o['route'] === 'simple' || o['route'] === 'complex' ? o['route'] : undefined;
    return route ? { decision: 'agent', route } : { decision: 'agent' };
  }
  if (o['decision'] !== 'deterministic') return { decision: 'invalid', reason: 'unknown-decision' };
  const v = validatePlannedQuery(o, allowedTools, opts);
  return v.ok ? { decision: 'deterministic', ...v.plan } : { decision: 'invalid', reason: v.reason };
}
