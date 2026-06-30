// Conductor conversational builder agent (US7).
//
// Lets an operator co-design a Conductor workflow by chatting. A turn is STATELESS: the client
// sends the current draft `WorkflowGraph` + the user's message (+ prior turns for context); the
// agent proposes a set of structured `GraphPatch`es; we apply them, run `@omadia/conductor-core`
// `validate()` on the result, and return the patched draft + the assistant's prose + the
// validation verdict. The draft itself lives client-side (parity with the visual Designer — both
// surfaces serialize the same graph), so there is no server draft store: this is a pure transform
// from (graph, message) → (graph, reply).
//
// The agent runs via the SAME proven seam Conductor agent-steps use: it resolves an Agent
// (orchestrator instance) in the multi-orchestrator registry and runs a real `bundle.agent.chat`
// turn — NOT a bare model call. The orchestrator is instructed to answer with a single JSON
// object `{ reply, patches }`; we parse robustly (tolerating markdown fences / surrounding prose)
// and self-correct once if the JSON is unparseable or the resulting graph fails validation.
//
// Native tool-calling (one tool per patch op) would be cleaner than JSON-in-text, but the headless
// `bundle.agent.chat` entrypoint is single-shot text; JSON-in-text + a bounded retry is the
// pragmatic seam today. Native tool-calling is a documented follow-up.

import { randomUUID } from 'node:crypto';

import type { OrchestratorRegistry } from '@omadia/orchestrator';
import { validate } from '@omadia/conductor-core';
import type { KnownRefs, ValidationResult, WorkflowGraph } from '@omadia/conductor-core';

import { applyGraphPatches, emptyGraph, type GraphPatch } from './graphPatch.js';

// Bound the builder's LLM turn so a hung orchestrator can't hang the HTTP request (the retry would
// otherwise be two un-timed sequential calls). Mirrors realStepEffects' withTimeout — a 6th copy;
// the shared `withTimeout` util is a documented follow-up.
const DEFAULT_BUILDER_CHAT_TIMEOUT_MS = 180_000;

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  if (!(ms > 0)) return p;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded the ${String(ms)}ms timeout`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface BuilderChatMessage {
  role: 'user' | 'assistant';
  text: string;
}

export interface ConductorBuilderTurnInput {
  /** the current draft (may be the empty graph for a fresh build). */
  graph?: WorkflowGraph;
  /** the user's instruction for this turn. */
  message: string;
  /** prior turns, oldest first, for multi-turn co-design context. */
  history?: BuilderChatMessage[];
}

export interface ConductorBuilderTurnResult {
  graph: WorkflowGraph;
  patches: GraphPatch[];
  reply: string;
  validation: ValidationResult;
  /** structural problems from applying the patches (unknown ids etc.); empty on a clean apply. */
  applyErrors: string[];
}

/** Thrown when no Agent (orchestrator) is available to drive the builder — surfaced as 503. */
export class ConductorBuilderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConductorBuilderUnavailableError';
  }
}

export interface ConductorBuilderAgentDeps {
  /** the multi-orchestrator registry — resolves the Agent that drives the builder. */
  getRegistry: () => OrchestratorRegistry | undefined;
  /** slug of the Agent (orchestrator) used to drive the builder. Default 'fallback' (the standard one). */
  builderAgentSlug?: string;
  /** known references (event ids etc.) so validate() can flag unknown refs and the prompt can list them. */
  knownRefs?: () => KnownRefs | Promise<KnownRefs>;
  /** per-turn LLM call budget in ms (each of the ≤2 attempts). 0 disables. Default 180_000. */
  chatTimeoutMs?: number;
  log?: (msg: string) => void;
}

const DEFAULT_BUILDER_SLUG = 'fallback';

/** The minimal SemanticAnswer shape we depend on (the orchestrator chat result). */
interface ChatAnswerLike {
  text: string;
}

export class ConductorBuilderAgent {
  private readonly slug: string;
  private readonly chatTimeoutMs: number;

  constructor(private readonly deps: ConductorBuilderAgentDeps) {
    this.slug = deps.builderAgentSlug ?? DEFAULT_BUILDER_SLUG;
    this.chatTimeoutMs = deps.chatTimeoutMs ?? DEFAULT_BUILDER_CHAT_TIMEOUT_MS;
  }

  async runTurn(input: ConductorBuilderTurnInput): Promise<ConductorBuilderTurnResult> {
    const registry = this.deps.getRegistry();
    if (!registry) {
      throw new ConductorBuilderUnavailableError('orchestrator registry is unavailable (no graphPool / registry not built)');
    }
    const entry = registry.get(this.slug);
    if (!entry) {
      throw new ConductorBuilderUnavailableError(`builder Agent '${this.slug}' is not active in the orchestrator registry`);
    }

    const knownRefs = (await this.deps.knownRefs?.()) ?? {};
    const baseGraph = input.graph ?? emptyGraph();

    // Up to two attempts; the second is a self-correction. We keep the BEST attempt, not the latest:
    // a parseable-but-invalid graph (inspectable, useful) must outrank an unparseable retry that left
    // the base unchanged (which would otherwise "validate" vacuously). parse > validity > clean-apply.
    let best: { result: ConductorBuilderTurnResult; score: number } | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const correction = attempt === 0 ? null : (best?.result ?? null);
      const prompt = buildPrompt(baseGraph, input.message, input.history ?? [], knownRefs, correction);

      this.deps.log?.(`[conductor] builder turn → Agent '${this.slug}' (attempt ${String(attempt + 1)})`);
      // Unique per-turn session scope: the orchestrator qualifies sessionScope into its recall/memory
      // pipeline, so a constant scope would accumulate state and bleed across operators. A fresh id
      // keeps the turn genuinely stateless (history is passed explicitly, never recalled).
      const answer = (await withTimeout(
        entry.built.bundle.agent.chat({
          userMessage: prompt,
          sessionScope: `conductor-builder:${this.slug}:${randomUUID()}`,
        }),
        this.chatTimeoutMs,
        `conductor builder turn (Agent '${this.slug}')`,
      )) as ChatAnswerLike;

      const text = typeof answer?.text === 'string' ? answer.text : '';
      const parsed = parseTurnResponse(text);
      const applyRes = applyGraphPatches(baseGraph, parsed.patches);
      const validation = validate(applyRes.graph, knownRefs);

      const result: ConductorBuilderTurnResult = {
        graph: applyRes.graph,
        patches: parsed.patches,
        reply: parsed.reply || text.trim(),
        validation,
        applyErrors: applyRes.errors,
      };
      const score = (parsed.ok ? 4 : 0) + (validation.ok ? 2 : 0) + (applyRes.errors.length === 0 ? 1 : 0);
      if (!best || score > best.score) best = { result, score };

      if (score === 7) return result; // clean parse + valid graph + no apply errors → accept immediately
    }

    // The loop always runs attempt 0 and sets `best`, so this is non-null on exit.
    return (best as { result: ConductorBuilderTurnResult }).result;
  }
}

// ── response parsing ────────────────────────────────────────────────────────

interface ParsedResponse {
  ok: boolean; // true iff we extracted a well-formed {reply, patches} object
  reply: string;
  patches: GraphPatch[];
}

/**
 * Extract `{ reply, patches }` from an orchestrator's prose answer. Tolerates ```json fences and
 * leading/trailing commentary by scanning EVERY balanced top-level `{...}` block (not just the
 * first) and returning the first that JSON-parses into a well-formed response — so prose that
 * contains a stray `{` (e.g. "set the guard to {op:eq}. Here is the patch: {...}") before the real
 * object doesn't drop the patches. Never throws — no parseable object yields `ok:false` with the
 * raw text as the reply so the user still sees the agent's words and the turn can self-correct.
 */
export function parseTurnResponse(text: string): ParsedResponse {
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    const block = balancedObjectFrom(text, start);
    if (block === null) continue;
    try {
      const obj = JSON.parse(block) as unknown;
      if (typeof obj === 'object' && obj !== null && !Array.isArray(obj)) {
        const rec = obj as Record<string, unknown>;
        // A response with a reply and/or a patches array is well-formed even if patches is empty
        // (the agent may just be asking a clarifying question).
        if (typeof rec.reply === 'string' || Array.isArray(rec.patches)) {
          return {
            ok: true,
            reply: typeof rec.reply === 'string' ? rec.reply : '',
            patches: Array.isArray(rec.patches) ? (rec.patches as GraphPatch[]) : [],
          };
        }
      }
    } catch {
      /* not valid JSON from this start — try the next `{` */
    }
  }
  return { ok: false, reply: text.trim(), patches: [] };
}

/** The balanced `{...}` block starting at `start`, ignoring braces inside JSON strings; null if unbalanced. */
function balancedObjectFrom(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// ── prompt ──────────────────────────────────────────────────────────────────

function buildPrompt(
  graph: WorkflowGraph,
  message: string,
  history: BuilderChatMessage[],
  knownRefs: KnownRefs,
  correction: ConductorBuilderTurnResult | null,
): string {
  const historyBlock =
    history.length > 0
      ? history.map((m) => `${m.role === 'user' ? 'User' : 'Builder'}: ${m.text}`).join('\n')
      : '(no prior turns)';
  const eventIds = knownRefs.eventIds && knownRefs.eventIds.length > 0 ? knownRefs.eventIds.join(', ') : '(none declared)';

  const correctionBlock = correction
    ? `\nYOUR PREVIOUS RESPONSE NEEDS CORRECTION. ${correctionSummary(correction)}\nFix it and respond again with ONLY the JSON object.\n`
    : '';

  return [
    'You are the Conductor workflow builder. You help an operator design a deterministic workflow GRAPH by conversation.',
    'Each turn you propose structured PATCHES that edit a draft graph, and a short natural-language reply explaining what you did or asking a clarifying question.',
    '',
    'GRAPH SHAPE (JSON):',
    '  WorkflowGraph = { entryStepId: string, steps: Step[], transitions: Transition[], triggers: Trigger[] }',
    "  Step = { id: string, kind: 'agent'|'action'|'human', agentId?, actionId?, prompt?, input?, human?, postcondition?, fallbackTransitionId? }",
    "    - kind 'agent': set agentId (the slug of an Agent/orchestrator, e.g. 'fallback') and an optional prompt.",
    "    - kind 'action': set actionId (a connector/tool id) and an optional input object.",
    "    - kind 'human': set human = { principal: {kind:'user'|'role', ref}, channel, message, reminderInterval?, deadline?, quorum?:'any'|'all' }.",
    '  Transition = { id: string, source: stepId, target: stepId, guard? }',
    "  Trigger = { id: string, kind: 'manual'|'event'|'cron', eventId?, cron? }",
    '  Predicate (for guard/postcondition) is a JSON AST, e.g. {"op":"eq","path":"stepResult.approved","value":true}. NEVER write code; only this AST.',
    '',
    'PATCH OPS (emit an array of these):',
    '  { "op":"add_step", "step": Step }',
    '  { "op":"update_step", "id": stepId, "patch": Partial<Step> }',
    '  { "op":"remove_step", "id": stepId }',
    '  { "op":"add_transition", "transition": Transition }',
    '  { "op":"remove_transition", "id": transitionId }',
    '  { "op":"set_trigger", "trigger": Trigger }',
    '  { "op":"set_entry", "stepId": stepId }',
    '',
    `KNOWN EVENT IDS (for event triggers): ${eventIds}`,
    "If unsure of an Agent slug, use 'fallback' (the standard orchestrator).",
    '',
    'CURRENT DRAFT GRAPH:',
    '```json',
    JSON.stringify(graph, null, 2),
    '```',
    '',
    'CONVERSATION SO FAR:',
    historyBlock,
    '',
    `USER MESSAGE: ${message}`,
    correctionBlock,
    'Respond with ONLY a single JSON object, no markdown fences, of the form:',
    '{ "reply": "<short explanation or question>", "patches": [ <patch>, ... ] }',
    'If you only need to ask a question, return an empty patches array. Keep step and transition ids short and stable; reuse existing ids when editing.',
  ].join('\n');
}

function correctionSummary(prev: ConductorBuilderTurnResult): string {
  const parts: string[] = [];
  if (!prev.validation.ok) {
    parts.push(`The graph failed validation: ${prev.validation.errors.map((e) => `${e.code} (${e.message})`).join('; ')}.`);
  }
  if (prev.applyErrors.length > 0) {
    parts.push(`Some patches could not apply: ${prev.applyErrors.join('; ')}.`);
  }
  if (parts.length === 0) parts.push('The previous response was not valid JSON of the form { "reply", "patches" }.');
  return parts.join(' ');
}
