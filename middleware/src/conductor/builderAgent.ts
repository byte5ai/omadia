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
import { resolveLocalizedText, validate } from '@omadia/conductor-core';
import type {
  KnownRefs,
  TemplateManifest,
  TemplateSlotKind,
  TemplateSlotMapping,
  ValidationResult,
  WorkflowGraph,
} from '@omadia/conductor-core';

import { applyGraphPatches, emptyGraph, type GraphPatch } from './graphPatch.js';
import type { TemplateSummary } from './templateCatalog.js';

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
  /** viewer identity for the template-catalog digest (#478 B4) — same source as
   *  every other viewer-scoped template read (`req.session?.sub ?? 'operator'`). */
  viewer?: string;
}

/** A template the builder agent suggests for the current conversation (#478 B4).
 *  Chat only PROPOSES — instantiation stays on the deliberate form flow
 *  (`POST /templates/:id/resolve` + `instantiate`); nothing is auto-created. */
export interface TemplateProposal {
  templateId: string;
  /** the catalog-served version — authoritative over whatever the LLM echoed. */
  version: number;
  /** one user-facing sentence. */
  reason: string;
  /** best-effort slot guesses from the conversation; partial is fine. Entries are
   *  validated server-side (declared slots only; ref kinds against live KnownRefs)
   *  so the form shows a failed guess as empty rather than broken. */
  prefill: TemplateSlotMapping;
}

export interface ConductorBuilderTurnResult {
  graph: WorkflowGraph;
  patches: GraphPatch[];
  reply: string;
  validation: ValidationResult;
  /** structural problems from applying the patches (unknown ids etc.); empty on a clean apply. */
  applyErrors: string[];
  /** template suggestions for this turn (#478 B4) — ≤3, viewer-visible ids only,
   *  prefill filtered. ADDITIVE: absent (not empty) when there are none, so the
   *  v1 wire shape of `POST /builder/turn` is byte-identical without proposals. */
  templateProposals?: TemplateProposal[];
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
  /** viewer-scoped composite template catalog (#478 B4) — feeds the prompt digest and
   *  is the allowlist proposals are filtered against (the agent must never surface a
   *  template the viewer cannot see). Optional: absent on hosts without templates. */
  templateCatalog?: { list(viewer: string): Promise<TemplateSummary[]> };
  /** live known-reference sets (agents/actions/roles/events) for prefill validation —
   *  the same sets the template resolve/instantiate routes validate against. */
  templateKnownRefs?: () => KnownRefs | Promise<KnownRefs>;
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

    // Template awareness (#478 B4) — both reads are best-effort: a broken catalog or
    // KnownRefs source degrades to "no digest / no proposals", never a failed turn.
    const viewer = input.viewer ?? 'operator';
    let catalog: TemplateSummary[] = [];
    try {
      catalog = (await this.deps.templateCatalog?.list(viewer)) ?? [];
    } catch (err) {
      this.deps.log?.(`[conductor] builder: template catalog unavailable — turn continues without templates (${err instanceof Error ? err.message : String(err)})`);
    }
    let templateRefs: KnownRefs = {};
    try {
      templateRefs = (await this.deps.templateKnownRefs?.()) ?? {};
    } catch (err) {
      this.deps.log?.(`[conductor] builder: template KnownRefs unavailable — prefill ref guesses will be stripped (${err instanceof Error ? err.message : String(err)})`);
      catalog = []; // without live refs we cannot vet prefills; drop template awareness for this turn
    }
    const digest = templateDigest(catalog);

    // Up to two attempts; the second is a self-correction. We keep the BEST attempt, not the latest:
    // a parseable-but-invalid graph (inspectable, useful) must outrank an unparseable retry that left
    // the base unchanged (which would otherwise "validate" vacuously). parse > validity > clean-apply.
    let best: { result: ConductorBuilderTurnResult; score: number } | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const correction = attempt === 0 ? null : (best?.result ?? null);
      const prompt = buildPrompt(baseGraph, input.message, input.history ?? [], knownRefs, correction, digest);

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
      // Defensive server-side gate (#478 B4): unknown/invisible template ids dropped,
      // prefill vetted against declared slots + live KnownRefs, ≤3 survive.
      const proposals = filterTemplateProposals(parsed.templateProposals, catalog, templateRefs);

      const result: ConductorBuilderTurnResult = {
        graph: applyRes.graph,
        patches: parsed.patches,
        reply: parsed.reply || text.trim(),
        validation,
        applyErrors: applyRes.errors,
        ...(proposals.length > 0 ? { templateProposals: proposals } : {}),
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
  /** raw, UNTRUSTED `templateProposals` value from the block (#478 B4) — vetted by
   *  filterTemplateProposals before anything reaches the wire. */
  templateProposals: unknown;
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
            templateProposals: rec.templateProposals,
          };
        }
      }
    } catch {
      /* not valid JSON from this start — try the next `{` */
    }
  }
  return { ok: false, reply: text.trim(), patches: [], templateProposals: undefined };
}

// ── template proposals (#478 B4) ────────────────────────────────────────────

/** Digest + proposal caps: 30 templates bound the prompt, 3 proposals bound the
 *  response, 300 chars bound a runaway "one sentence" reason. */
const MAX_DIGEST_TEMPLATES = 30;
const MAX_TEMPLATE_PROPOSALS = 3;
const MAX_PROPOSAL_REASON_CHARS = 300;

/** Ref-slot kind → the KnownRefs set its prefill guesses must resolve against.
 *  `channels` has no KnownRefs set — like validate(), an absent set means the
 *  value is accepted structurally (the form's channel picker is the real gate). */
const PREFILL_REFS: Record<TemplateSlotKind, keyof KnownRefs | null> = {
  agents: 'agentIds',
  actions: 'actionIds',
  roles: 'roleKeys',
  events: 'eventIds',
  channels: null,
};

const REF_SLOT_KINDS = Object.keys(PREFILL_REFS) as TemplateSlotKind[];

/** Compact per-template catalog digest for the system prompt: id, resolved en
 *  name/useCase, version, and the declared slots (ref + text) the agent may
 *  prefill. Capped with a count note so a big catalog cannot blow up the prompt. */
function templateDigest(catalog: TemplateSummary[]): string {
  if (catalog.length === 0) return '';
  const shown = catalog.slice(0, MAX_DIGEST_TEMPLATES);
  const lines = shown.map((t) => {
    const slots: string[] = [];
    for (const kind of REF_SLOT_KINDS) {
      for (const slot of t.slots[kind] ?? []) slots.push(`${kind}.${slot.key} "${resolveLocalizedText(slot.label)}"`);
    }
    for (const slot of t.slots.text ?? []) slots.push(`text.${slot.key} "${resolveLocalizedText(slot.label)}"`);
    const useCase = t.useCase !== undefined ? ` Use case: ${resolveLocalizedText(t.useCase)}.` : '';
    return `- ${t.id} (v${String(t.version)}) — ${resolveLocalizedText(t.name)}.${useCase} Slots: ${slots.length > 0 ? slots.join('; ') : '(none)'}`;
  });
  if (catalog.length > shown.length) lines.push(`(+${String(catalog.length - shown.length)} more templates not shown)`);
  return lines.join('\n');
}

/**
 * Vet the agent's raw `templateProposals` block. Defensive by contract: a malformed
 * block (or element) is silently dropped, never thrown — a bad proposal must not
 * cost the user their patches. Unknown template ids are dropped against the
 * viewer-scoped catalog (the agent must not surface templates the viewer cannot
 * see); duplicates keep the first; the catalog-served version overrides the LLM's
 * claim; at most MAX_TEMPLATE_PROPOSALS survive.
 */
function filterTemplateProposals(raw: unknown, catalog: TemplateSummary[], knownRefs: KnownRefs): TemplateProposal[] {
  if (!Array.isArray(raw) || catalog.length === 0) return [];
  const byId = new Map(catalog.map((t) => [t.id, t]));
  const out: TemplateProposal[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (out.length >= MAX_TEMPLATE_PROPOSALS) break;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const templateId = typeof rec.templateId === 'string' ? rec.templateId : '';
    const summary = templateId.length > 0 ? byId.get(templateId) : undefined;
    if (!summary || seen.has(templateId)) continue;
    seen.add(templateId);
    out.push({
      templateId,
      version: summary.version,
      reason: typeof rec.reason === 'string' ? rec.reason.trim().slice(0, MAX_PROPOSAL_REASON_CHARS) : '',
      prefill: filterPrefill(rec.prefill, summary, knownRefs),
    });
  }
  return out;
}

/** Keep only prefill guesses that would survive the instantiate form: declared slot
 *  keys only; ref-kind values must resolve against the live KnownRefs set (when the
 *  kernel supplies one); text values are plain strings. A stripped guess simply
 *  renders as an empty form field — never a broken one. */
function filterPrefill(raw: unknown, manifest: TemplateManifest, knownRefs: KnownRefs): TemplateSlotMapping {
  const prefill: TemplateSlotMapping = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return prefill;
  const rec = raw as Record<string, unknown>;
  for (const kind of REF_SLOT_KINDS) {
    const values = rec[kind];
    if (typeof values !== 'object' || values === null || Array.isArray(values)) continue;
    const declared = new Set((manifest.slots[kind] ?? []).map((s) => s.key));
    const refsKey = PREFILL_REFS[kind];
    const known = refsKey ? knownRefs[refsKey] : undefined;
    const kept: Record<string, string> = {};
    for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
      if (!declared.has(key)) continue;
      if (typeof value !== 'string' || value.trim().length === 0) continue;
      if (known !== undefined && !known.includes(value)) continue;
      kept[key] = value;
    }
    if (Object.keys(kept).length > 0) prefill[kind] = kept;
  }
  const text = rec.text;
  if (typeof text === 'object' && text !== null && !Array.isArray(text)) {
    const declared = new Set((manifest.slots.text ?? []).map((s) => s.key));
    const kept: Record<string, string> = {};
    for (const [key, value] of Object.entries(text as Record<string, unknown>)) {
      if (!declared.has(key) || typeof value !== 'string') continue;
      kept[key] = value;
    }
    if (Object.keys(kept).length > 0) prefill.text = kept;
  }
  return prefill;
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
  templateDigestBlock: string,
): string {
  const historyBlock =
    history.length > 0
      ? history.map((m) => `${m.role === 'user' ? 'User' : 'Builder'}: ${m.text}`).join('\n')
      : '(no prior turns)';
  const eventIds = knownRefs.eventIds && knownRefs.eventIds.length > 0 ? knownRefs.eventIds.join(', ') : '(none declared)';

  const correctionBlock = correction
    ? `\nYOUR PREVIOUS RESPONSE NEEDS CORRECTION. ${correctionSummary(correction)}\nFix it and respond again with ONLY the JSON object.\n`
    : '';

  // Template awareness (#478 B4) — only rendered when the viewer-scoped catalog has
  // entries, so hosts without templates keep the exact v1 prompt.
  const templateBlock =
    templateDigestBlock.length > 0
      ? [
          'WORKFLOW TEMPLATE CATALOG (ready-made workflows the user instantiates via a separate form — NEVER via patches):',
          templateDigestBlock,
          'If one or more catalog templates clearly fit the request, ALSO include a "templateProposals" array (max 3) in your JSON object:',
          '  "templateProposals": [ { "templateId": "<id from the catalog above>", "version": <its catalog version>, "reason": "<one short user-facing sentence>", "prefill": { "<kind>": { "<slot key>": "<value>" }, "text": { "<text key>": "<string>" } } } ]',
          "  prefill kinds are 'agents'|'actions'|'roles'|'events'|'channels'|'text'; values are best-effort guesses from the conversation — partial or an empty {} is fine.",
          '  Never propose ids that are not in the catalog above, and do not rebuild a proposed template step-by-step with patches.',
          '',
        ]
      : [];

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
    ...templateBlock,
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
