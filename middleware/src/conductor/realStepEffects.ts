import type { OrchestratorRegistry } from '@omadia/orchestrator';
import type { JsonObject, JsonValue, Step } from '@omadia/conductor-core';

import type { ConductorSayOutcome, ConductorSayService } from './sayService.js';
import type { StepEffects, StepExecution, StepMeta } from './stepEffects.js';

/** Resolve a dot-path over a plain object root (for prompt interpolation). */
function resolve(root: JsonObject, path: string): JsonValue | undefined {
  let cur: JsonValue | undefined = root;
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, JsonValue>)[seg];
  }
  return cur;
}

/** Replace `{{ctx.path}}` / `{{steps.id.field}}` tokens in a prompt template. */
function renderTemplate(tpl: string, root: JsonObject): string {
  return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, path: string) => {
    const v = resolve(root, path);
    if (v === undefined || v === null) return '';
    return typeof v === 'string' ? v : JSON.stringify(v);
  });
}

function asObject(v: JsonValue | undefined): JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? v : {};
}

/** Thrown when a single step's I/O exceeds the per-step hard budget (`stepTimeoutMs`). */
export class StepTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} exceeded the ${ms}ms step timeout`);
    this.name = 'StepTimeoutError';
  }
}

/**
 * Bound a step's I/O so no single step runs unbounded. This is the resume-safety pair to the run
 * lease: with `stepTimeoutMs` < the resume worker's `staleMs`, a step always settles (or fails) before
 * a stalled run could be claimed and re-driven — closing the last at-least-once window (a still-running
 * step being re-executed). Best-effort: the underlying turn isn't force-killed, but the run stops
 * waiting and records the step `failed`, so it can take its fallback deterministically.
 *
 * NOTE: this Promise.race timeout shape is duplicated in toolPluginRuntime / dynamicAgentRuntime /
 * previewRuntime / migrationRunner. Follow-up: extract one shared `withTimeout` util. This copy adds
 * the typed StepTimeoutError + the `ms<=0` disable guard the others lack.
 */
async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  if (!(ms > 0)) return p;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    // Deliberately NOT unref'd: this timer MUST fire to enforce the budget (unlike the workers'
    // long-lived poll timers). It is always cleared in `finally` once the race settles.
    timer = setTimeout(() => reject(new StepTimeoutError(label, ms)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface RealStepEffectsDeps {
  /** the multi-orchestrator registry — resolves an Agent (orchestrator) by slug. */
  getRegistry: () => OrchestratorRegistry | undefined;
  /** invoke a deterministic-action / connector tool by id (dynamicAgentRuntime). */
  invokeAction?: (toolId: string, input: unknown) => Promise<string | undefined>;
  /** Per-step hard budget in ms. MUST be < the resume worker's staleMs (default 900_000). 0 disables. */
  stepTimeoutMs?: number;
  /** Publishes a `say` step's answer into the run's bound conversation. Absent
   *  (no database / no channel plugin) = agent dialogue degrades to silent
   *  turns: the run still works, nothing reaches the chat. */
  say?: ConductorSayService;
  log?: (msg: string) => void;
}

// 10 min — generous for an agent turn, and strictly < the resume worker's DEFAULT_RESUME_STALE_MS
// (15 min). That ordering is the resume-safety invariant; a test asserts it so a tweak can't break it.
export const DEFAULT_STEP_TIMEOUT_MS = 600_000;

/**
 * Real step execution — no stubs.
 *  - agent step: resolves `step.agentId` (an Agent / orchestrator-instance slug) in the
 *    multi-orchestrator registry and runs a genuine turn via `bundle.agent.chat(...)`,
 *    the same headless entrypoint the schedule worker uses. The Agent's prose answer
 *    becomes the step result (`{ text }`).
 *  - action step: invokes the named connector/deterministic tool and captures its output.
 *
 * This is the seam that distinguishes an *Agent* (an independent orchestrator instance that
 * runs a full tool/sub-agent/memory loop) from a sub-agent or a bare model call.
 */
export class RealStepEffects implements StepEffects {
  private readonly stepTimeoutMs: number;

  constructor(private readonly deps: RealStepEffectsDeps) {
    this.stepTimeoutMs = deps.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  }

  async runAgentStep(step: Step, context: JsonObject, meta: StepMeta): Promise<StepExecution> {
    // The agent may be named by the RUN rather than by the graph
    // (`agentId: "{{ctx.speaker}}"`). That is what lets a single step serve a
    // rotating cast: two participants, or five, without a step per voice and
    // without a slot per participant frozen into the pattern.
    const rawSlug = step.agentId;
    if (!rawSlug) throw new Error(`agent step '${step.id}' has no agentId (Agent slug)`);
    const slug = renderTemplate(rawSlug, { ctx: context, steps: asObject(context.steps) }).trim();
    if (!slug) {
      throw new Error(
        `agent step '${step.id}' resolved '${rawSlug}' to an empty agent slug — the run context does not name a speaker`,
      );
    }

    const registry = this.deps.getRegistry();
    if (!registry) throw new Error('orchestrator registry is unavailable (no graphPool / registry not built)');

    // WORK STARTED BY A MESSAGE TO A BOT RUNS AS THAT BOT'S AGENT. FULL STOP.
    //
    // A person addresses one bot in a group chat. If a workflow triggered by
    // that message runs as a DIFFERENT agent, the answer carries that agent's
    // permissions while wearing the addressed bot's name — and nobody in the
    // chat can see the substitution. Observed in production: a message to an
    // agent with no plugin grants at all produced live HR data, because the
    // workflow behind it was configured to run as the platform fallback, which
    // is granted every installed plugin.
    //
    // This is deliberately NOT a warning and NOT a capability intersection.
    // Both leave the outcome depending on how somebody configured a graph, and
    // the rule has to hold regardless of configuration: the addressed bot's
    // agent runs, or nothing runs.
    //
    // Scoped to CHANNEL triggers. A manual, scheduled or webhook run has no
    // addressed bot, no impersonation risk, and keeps behaving exactly as
    // before — which is why the rule keys on the trigger, not on the step.
    assertChannelOriginAllows(step, context, meta, registry, this.deps.log);

    const entry = registry.get(slug);
    if (!entry) {
      throw new Error(`Agent '${slug}' is not active in the orchestrator registry`);
    }

    const root: JsonObject = { ctx: context, steps: asObject(context.steps) };
    const userMessage = step.prompt
      ? renderTemplate(step.prompt, root)
      : `Conductor workflow step "${step.id}". Run your configured task. Run context: ${JSON.stringify(context)}`;

    this.deps.log?.(`[conductor] agent step '${step.id}' → Agent '${slug}' (run ${meta.runId})`);

    // A publishing step is one people are watching for. Show that this agent is
    // composing while it works — the turn regularly runs twenty seconds, and
    // silence in a chat reads as nothing happening. Stopped in `finally` so a
    // thrown turn never leaves the dots running.
    const stopTyping =
      step.say && this.deps.say
        ? this.deps.say.startTyping({
            agentSlug: slug,
            channelType: step.say.channel,
            conversationId: typeof context.conversationId === 'string' ? context.conversationId : '',
          })
        : () => undefined;

    let answer;
    try {
      answer = await withTimeout(
        entry.built.bundle.agent.chat({
          userMessage,
          sessionScope: `conductor:${meta.runId}:${step.id}`,
        }),
        this.stepTimeoutMs,
        `agent step '${step.id}'`,
      );
    } finally {
      stopTyping();
    }

    // #330 C3 — structured verdicts: mirror of the action-step's `data` field.
    // A fenced ```json block in the agent's answer becomes `result.data`, so
    // transition guards can branch on `stepResult.data.…` deterministically.
    // Tolerant by design: missing/broken JSON just means no `data` — a guard
    // like `ne stepResult.data.dodMet true` then keeps the bounded loop going.
    const data = extractFencedJson(answer.text);
    // The agent-dialogue seam: without `say` an agent step's prose never leaves
    // the run context (which is why two agent bots could not converse). With
    // it, the turn is published into the run's bound conversation — and the
    // OUTCOME is recorded on the step, so a silent failure can never read as a
    // delivered utterance.
    const said = step.say ? await this.publish(step, context, meta, slug, answer.text) : undefined;
    return {
      result: {
        text: answer.text,
        ...(data !== undefined ? { data } : {}),
        ...(said !== undefined ? { said: said.said, ...(said.said ? {} : { sayError: said.reason }) } : {}),
      },
      actor: { kind: 'agent', agentSlug: slug },
    };
  }

  /** Never throws — a chat we could not reach must not fail the run. */
  private async publish(
    step: Step,
    context: JsonObject,
    meta: StepMeta,
    slug: string,
    text: string,
  ): Promise<ConductorSayOutcome> {
    const say = step.say!;
    if (!this.deps.say) {
      return { said: false, reason: 'no_provider', message: 'no say service wired (no database / no channel plugin)' };
    }
    const conversationId = typeof context.conversationId === 'string' ? context.conversationId : '';
    return this.deps.say
      .say({
        workflowId: meta.workflowId ?? null,
        runId: meta.runId,
        agentSlug: slug,
        speaker: say.speaker ?? slug,
        channelType: say.channel,
        conversationId,
        text,
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.deps.log?.(`[conductor] say step '${step.id}' failed: ${message}`);
        return { said: false as const, reason: 'channel_error' as const, message };
      });
  }

  async runActionStep(step: Step, _context: JsonObject, meta: StepMeta): Promise<StepExecution> {
    const toolId = step.actionId;
    if (!toolId) throw new Error(`action step '${step.id}' has no actionId`);
    if (!this.deps.invokeAction) throw new Error('action execution is not wired (no deterministic-action invoker)');

    const input = step.input ?? {};
    this.deps.log?.(`[conductor] action step '${step.id}' → tool '${toolId}' (run ${meta.runId})`);
    const out = await withTimeout(this.deps.invokeAction(toolId, input), this.stepTimeoutMs, `action step '${step.id}'`);
    if (out === undefined) {
      throw new Error(`action '${toolId}' is not registered or returned nothing`);
    }

    let data: JsonValue;
    try {
      data = JSON.parse(out) as JsonValue;
    } catch {
      data = out;
    }
    return {
      result: { text: out, data },
      actor: { kind: 'action', actionId: toolId },
    };
  }
}

/** #330 C3 — the LAST fenced ```json block in an agent answer, parsed. Size-
 *  capped and tolerant: anything malformed or oversized yields undefined
 *  (guards then treat the verdict as absent — bounded loops, never a crash). */
export function extractFencedJson(text: string, maxBytes = 16_384): JsonValue | undefined {
  const matches = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)];
  const last = matches[matches.length - 1]?.[1];
  if (!last || Buffer.byteLength(last, 'utf8') > maxBytes) return undefined;
  try {
    return JSON.parse(last) as JsonValue;
  } catch {
    return undefined;
  }
}

/**
 * Channel events whose payload identifies the bot a person addressed.
 *
 * A prefix list rather than a wildcard: a channel that does NOT carry an
 * addressed bot must not be silently treated as if it did, because the rule
 * below would then refuse every run it starts. Adding a channel here is a
 * deliberate statement that its events name their bot.
 */
const CHANNEL_EVENT_PREFIXES: readonly string[] = ['teams.'];

/** The addressed bot's routing key, as the channel put it in the payload. */
function addressedBotKey(context: JsonObject): string | undefined {
  const raw = context['botId'];
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined;
}

/**
 * Refuse an agent step whose run began with a message to a DIFFERENT bot.
 *
 * Three outcomes, and the middle one is the point:
 *
 *  - not a channel trigger → allowed, unchanged (manual, schedule, webhook).
 *  - channel trigger, bot unknown → REFUSED. A channel run whose origin cannot
 *    be established is exactly the case that must not be guessed: the plugin
 *    builds that omit the bot id are the ones that produced the impersonation,
 *    so treating "unknown" as "fine" would keep the hole open for precisely
 *    the deployments that have it.
 *  - channel trigger, bot known → the step must BE that bot's agent.
 */
function assertChannelOriginAllows(
  step: Step,
  context: JsonObject,
  meta: StepMeta,
  registry: OrchestratorRegistry,
  log?: (msg: string) => void,
): void {
  const eventId = meta.triggerEventId;
  const isChannelTrigger =
    (meta.triggerKind === 'event' || meta.triggerKind === 'webhook') &&
    eventId !== undefined &&
    CHANNEL_EVENT_PREFIXES.some((p) => eventId.startsWith(p));
  if (!isChannelTrigger) return;

  const botKey = addressedBotKey(context);
  if (botKey === undefined) {
    log?.(
      `[conductor] agent step '${step.id}' refused — run started by '${String(eventId)}' ` +
        `but the payload names no addressed bot, so its permissions cannot be established`,
    );
    throw new Error(
      `agent step '${step.id}' cannot run: the channel event '${String(eventId)}' does not identify ` +
        `the bot it was addressed to, so the step's permissions cannot be bound to it`,
    );
  }

  const owner = registry.identityForChannel('teams', botKey);
  if (!owner) {
    log?.(
      `[conductor] agent step '${step.id}' refused — addressed bot '${botKey}' resolves to no active agent`,
    );
    throw new Error(
      `agent step '${step.id}' cannot run: the addressed bot '${botKey}' resolves to no active Agent`,
    );
  }

  if (owner.agent.slug !== step.agentId) {
    log?.(
      `[conductor] agent step '${step.id}' refused — addressed bot '${botKey}' belongs to Agent ` +
        `'${owner.agent.slug}' but the step is configured to run as '${String(step.agentId)}'`,
    );
    throw new Error(
      `agent step '${step.id}' cannot run as '${String(step.agentId)}': the message was addressed to ` +
        `Agent '${owner.agent.slug}'. Work started by a message to a bot runs with that bot's ` +
        `permissions only — configure this step for '${owner.agent.slug}', or trigger the workflow ` +
        `another way.`,
    );
  }
}
