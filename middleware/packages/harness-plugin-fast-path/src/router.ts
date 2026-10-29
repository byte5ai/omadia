import {
  FAST_MODEL_REASONING,
  forcedToolInput,
  toolPurpose,
  type FastLlm,
  type FastLlmTool,
  type FastPathToolSpec,
} from './fastPath.js';
import type { TriageRoute } from './triage.js';

/**
 * Fast-path ROUTER — one tiny classification call per turn, every channel
 * (canvas included). It only decides: deterministic (ONE read query with ONE
 * of the offered tools answers it) vs the agent, simple or complex. The query
 * itself is the planner's (planner.ts), called only after a confident
 * deterministic decision.
 *
 * The answer is a FORCED tool call (`route_turn`) — no prose path, unlike a
 * "JSON only" prompt the fast model answered in prose on attempt 1 (live
 * `shape=no-object`). A model that cannot force a tool may still answer in
 * text: its first JSON object is accepted, anything else is a miss.
 *
 * Prompt split (privacy latency): the fixed text — rules, tool catalog,
 * learned intents (stored literal-stripped/masked) — is the SYSTEM prompt and
 * never goes through the Privacy Shield; the user message is ONLY the
 * user-derived turn message (triageTurn.ts), masked once per turn and shared
 * with the planner.
 */

export const ROUTER_TOOL = 'route_turn';
/** Output is ~30 tokens; the cap only bounds a runaway answer. */
export const ROUTER_MAX_TOKENS = 200;
/** Below this a deterministic decision goes to the agent (no planner call). */
export const ROUTER_MIN_CONFIDENCE = 0.6;

export type RouterDecision = 'deterministic' | 'agent_simple' | 'agent_complex';
const DECISIONS: readonly RouterDecision[] = ['deterministic', 'agent_simple', 'agent_complex'];

export interface RouteResult {
  decision: RouterDecision;
  tool?: string;
  confidence: number;
}

/** A learned plan intent shown to the router: a stripped past question and
 *  the tool that answered it deterministically. */
export interface RouterIntent {
  question: string;
  tool: string;
}

export type RouteOutcome =
  | { kind: 'plan'; tool: string; confidence: number; ms: number }
  | { kind: 'agent'; route?: TriageRoute; reason: string; ms: number };

export const ROUTER_SYSTEM = `You are the Omadia fast-path router. Classify ONE user turn by calling ${ROUTER_TOOL} — never answer the turn itself.
- "deterministic": the answer IS the rows of exactly ONE read query with ONE of the TOOLS — a plain lookup or list, optionally counted, with a numeric column totalled, or the top N ROWS by one of their own columns ("Geburtstage im Januar", "offene Posten von Müller", "wie viele Kunden in Berlin", "die 5 größten offenen Rechnungen"). Set "tool".
- "agent_simple": greeting, chit-chat, a short confirmation, a one-step question that needs none of the TOOLS.
- "agent_complex": explanations, advice, opinions, writes or changes, several queries, joins, comparisons, analysis, planning, code — or when unsure. Also every total, count or ranking PER GROUP (per customer, per month, per department): "Kunden mit dem höchsten offenen Betrag" sums invoices per customer — that is not the rows of one query.
A follow-up of the PREVIOUS QUERY that only changes values ("und im Februar?", "and for Weber?") is deterministic with the same tool.
"confidence": the probability (0..1) that your decision is right. A wrong deterministic decision is worse than an agent turn.`;

/** The forced tool: its input IS the decision. Plain (non-strict) schema. */
export function routerTool(toolNames: readonly string[]): FastLlmTool {
  return {
    name: ROUTER_TOOL,
    description: 'Record the routing decision for the user turn.',
    inputSchema: {
      type: 'object',
      properties: {
        decision: { type: 'string', enum: [...DECISIONS] },
        tool: {
          type: 'string',
          ...(toolNames.length > 0 ? { enum: [...toolNames] } : {}),
          description: 'the ONE tool of a deterministic decision',
        },
        confidence: { type: 'number', description: 'probability 0..1 that the decision is right' },
      },
      required: ['decision', 'confidence'],
    },
  };
}

/** The router's system prompt: the fixed rules plus the tool catalog (one
 *  line each) and the learned intents — no user-derived text. */
export function buildRouterSystem(opts: { tools: readonly FastPathToolSpec[]; intents?: readonly RouterIntent[] }): string {
  const lines = [ROUTER_SYSTEM, `TOOLS:\n${opts.tools.map((t) => `- ${t.name}: ${toolPurpose(t)}`).join('\n')}`];
  const intents = opts.intents ?? [];
  if (intents.length > 0) {
    lines.push(
      `LEARNED INTENTS (answered deterministically before):\n${intents
        .map((i) => `- "${i.question}" → ${i.tool}`)
        .join('\n')}`,
    );
  }
  return lines.join('\n');
}

/** The decision of a router answer, or undefined when it has none. A
 *  deterministic decision without a tool takes the only offered one. */
export function parseRoute(value: Record<string, unknown>, toolNames: readonly string[]): RouteResult | undefined {
  const decision = value['decision'];
  if (typeof decision !== 'string' || !(DECISIONS as readonly string[]).includes(decision)) return undefined;
  const raw = value['confidence'];
  const confidence = typeof raw === 'number' && Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0;
  const named = typeof value['tool'] === 'string' && value['tool'].length > 0 ? value['tool'] : undefined;
  const tool = decision !== 'deterministic' ? named : (named ?? (toolNames.length === 1 ? toolNames[0] : undefined));
  return { decision: decision as RouterDecision, confidence, ...(tool !== undefined ? { tool } : {}) };
}

/** Route one turn. Never throws: every failure is an agent outcome with a
 *  reason (and no route hint — the model router then classifies itself). */
export async function routeTurn(opts: {
  llm: FastLlm;
  model: string;
  channel: string;
  /** the turn message (triageTurn.ts) — already masked when a shield runs */
  message: string;
  tools: readonly FastPathToolSpec[];
  intents?: readonly RouterIntent[];
  log: (message: string) => void;
}): Promise<RouteOutcome> {
  const t0 = Date.now();
  const agent = (reason: string, route?: TriageRoute): RouteOutcome => ({
    kind: 'agent',
    reason,
    ms: Date.now() - t0,
    ...(route ? { route } : {}),
  });
  const toolNames = opts.tools.map((t) => t.name);
  let res: Awaited<ReturnType<FastLlm['complete']>>;
  try {
    res = await opts.llm.complete({
      model: opts.model,
      system: buildRouterSystem(opts),
      messages: [{ role: 'user', content: opts.message }],
      maxTokens: ROUTER_MAX_TOKENS,
      ...FAST_MODEL_REASONING,
      tools: [routerTool(toolNames)],
      toolChoice: { name: ROUTER_TOOL },
    });
  } catch (err) {
    opts.log(`[fast-path] router failed channel=${opts.channel}: ${err instanceof Error ? err.message : String(err)}`);
    return agent('router-error');
  }
  const answer = forcedToolInput(res, ROUTER_TOOL);
  const route = answer ? parseRoute(answer.value, toolNames) : undefined;
  const ms = Date.now() - t0;
  if (!route) {
    opts.log(`[fast-path] router channel=${opts.channel} decision=invalid ms=${ms}`);
    return agent('router-invalid');
  }
  opts.log(
    `[fast-path] router channel=${opts.channel} decision=${route.decision} tool=${route.tool ?? '-'} ` +
      `conf=${route.confidence.toFixed(2)} ms=${ms}` + (answer?.via === 'text' ? ' via=text' : ''),
  );
  if (route.decision === 'agent_simple') return agent('agent:simple', 'simple');
  if (route.decision === 'agent_complex') return agent('agent:complex', 'complex');
  if (route.confidence < ROUTER_MIN_CONFIDENCE) return agent('router-low-confidence');
  if (route.tool === undefined || !toolNames.includes(route.tool)) return agent('router-tool-not-offered');
  return { kind: 'plan', tool: route.tool, confidence: route.confidence, ms };
}
