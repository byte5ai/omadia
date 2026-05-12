import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import type Anthropic from '@anthropic-ai/sdk';
import {
  LocalSubAgent,
  type AskObserver,
  type AskOptions,
  type LocalSubAgentTool,
} from '@omadia/orchestrator';

import { ASSETS } from '../../platform/assets.js';
import { zodToJsonSchema } from '../zodToJsonSchema.js';
import { loadBoilerplate, type SlotDef } from './boilerplateSource.js';
import type { DraftStore } from './draftStore.js';
import type { SlotTypecheckService } from './slotTypecheckPipeline.js';
import type { SpecEventBus } from './specEventBus.js';
import type { JsonPatch } from './specPatcher.js';
import type {
  AgentSpecSkeleton,
  TranscriptEntry,
} from './types.js';
import { builderTools } from './tools/index.js';
import type {
  BuilderTool,
  BuilderToolContext,
  BuildFailureBudget,
  CatalogToolNamesProvider,
  KnownPluginIdsProvider,
  RebuildScheduler,
  SlotRetryTracker,
} from './tools/index.js';

/**
 * BuilderAgent — builder chat surface that negotiates the `AgentSpec` and
 * its slots with the admin user.
 *
 * Pattern clone of `PreviewChatService.runTurn` (B.3-3): observer→AsyncIterable
 * bridge with queue + resolver, `buildSubAgent` override hook for tests,
 * `useId→toolId` map. Each turn constructs a fresh `LocalSubAgent` with the
 * draft's current model (hot-switch between Haiku/Sonnet/Opus).
 *
 * Differences from PreviewChatService:
 *   - persists into `draft.transcript[]` (not `previewTranscript[]`)
 *   - the executed tools are the builder tools (B.4-2), not the
 *     preview-toolkit tools of an activated agent
 *   - tool calls emit structured events (`spec_patch`,
 *     `slot_patch`, `lint_result`) in addition to the generic
 *     `tool_use`/`tool_result`
 */

export type BuilderEvent =
  | { type: 'turn_started'; turnId: string }
  | { type: 'chat_message'; role: 'user' | 'assistant'; text: string }
  | {
      type: 'tool_use';
      useId: string;
      toolId: string;
      input: unknown;
    }
  | {
      type: 'tool_result';
      useId: string;
      toolId: string;
      output: string;
      isError: boolean;
      durationMs: number;
    }
  | { type: 'spec_patch'; patches: JsonPatch[]; cause: 'agent' | 'user' }
  | {
      type: 'slot_patch';
      slotKey: string;
      source: string;
      cause: 'agent' | 'user';
    }
  | { type: 'lint_result'; issues: ReadonlyArray<unknown>; cause: 'agent' | 'user' }
  | {
      /**
       * Theme E0: liveness pulse for the in-flight Builder turn. Emitted by
       * runTurn on a 2s wall-clock interval whenever the LLM stream is
       * silent (no `tool_use`/`tool_result`/`chat_message`/iteration tick
       * since the last event). The UI uses this to distinguish "Sonnet is
       * streaming a long answer" from "the API call is hung", and to surface
       * the iteration counter while the spinner is up. No emission happens
       * on fast turns (< 2s) — see builderAgentHeartbeat.test.ts.
       *
       * Theme E1: `phase` and `tokensStreamedThisIter` are populated once the
       * LocalSubAgent observer fires its first onIterationPhase/onTokenChunk
       * callback. They stay optional so existing E0 fixtures and any
       * pre-E1 ring-buffer replays remain valid.
       */
      type: 'heartbeat';
      sinceLastActivityMs: number;
      currentIteration: number;
      toolCallsThisIter: number;
      phase?: 'thinking' | 'streaming' | 'tool_running' | 'idle';
      tokensStreamedThisIter?: number;
    }
  | {
      /**
       * Theme E1: live token-stream pulse. One per text/tool-input delta
       * the model emits, throttled at the LocalSubAgent level via the
       * approximated chunk count. `tokensPerSec` updates on the trailing
       * 500ms window — see streamMessageWithObserver in localSubAgent.ts.
       */
      type: 'stream_token_chunk';
      iteration: number;
      deltaTokens: number;
      cumulativeOutputTokens: number;
      tokensPerSec: number;
    }
  | {
      /**
       * Theme E1: authoritative usage block read off `stream.finalMessage()`
       * at iteration end. Carries cache-read/creation input tokens so the
       * UI can render a 🟢 cache-hit indicator separately from the live
       * token-stream chunks (which only see approximated output counts).
       */
      type: 'iteration_usage';
      iteration: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
    }
  | {
      /**
       * OB-31: per-iteration stop diagnostics. Emitted by the LocalSubAgent
       * observer hook `onIterationEnd` after the model response is in, before
       * the loop dispatches tools or returns. `stopReason: 'end_turn' &&
       * toolUseCount === 0` after a build announcement is the smoking gun for
       * the "promise without delivery" pathology. The Frontend can use this
       * to surface a banner; the persistence layer can log it for postmortem.
       */
      type: 'iteration_finished';
      iteration: number;
      stopReason: string;
      toolUseCount: number;
      textLength: number;
    }
  | { type: 'turn_done'; turnId: string }
  | { type: 'error'; code: string; message: string };

/** 2-second heartbeat cadence — fix value, see Theme E0 hand-off. */
export const BUILDER_HEARTBEAT_INTERVAL_MS = 2000;

const DEFAULT_MAX_TOKENS = 4096;
// Bumped 12 → 20 (Step #3): a complete first-turn-from-empty needs
// patch_spec for identity + skill + tools, plus N fill_slot per template
// slot, plus 1-3 retries on tsc errors. The 12-cap was killing turns
// before all required slots were filled even with the new slot manifest
// (Step #1) and turn-end gate (Step #2). 20 gives enough headroom for
// agent-integration's 4-5 required slots without inviting runaway loops
// (the 3-retry-per-slot cap + agent_stuck path still bound retries).
const DEFAULT_MAX_ITERATIONS = 20;

/**
 * Default cap on *consecutive* slot-typecheck failures across all slots
 * within a single turn. A successful slot-typecheck resets the counter
 * to 0. When the cap is hit, `fill_slot` returns an Error: result that
 * stops the LocalSubAgent loop with a user-facing message.
 *
 * Sized at 8: empirically, the runaway loop on draft 6fe00ba1 hit
 * buildN=11 before maxIterations stopped it — 8 catches that pattern
 * with headroom for legit "agent struggles for 5-6 attempts then
 * recovers" cases. Tuneable via `BuilderAgentDeps.maxConsecutiveBuildFailures`.
 */
const DEFAULT_MAX_CONSECUTIVE_BUILD_FAILURES = 8;

interface Askable {
  ask(
    question: string,
    observer?: AskObserver,
    options?: AskOptions,
  ): Promise<string>;
}

export interface BuilderSubAgentBuildOptions {
  name: string;
  client: Anthropic;
  model: string;
  maxTokens: number;
  maxIterations: number;
  systemPrompt: string;
  tools: LocalSubAgentTool[];
}

export interface BuilderAgentDeps {
  anthropic: Anthropic;
  draftStore: DraftStore;
  bus: SpecEventBus;
  rebuildScheduler: RebuildScheduler;
  catalogToolNames: CatalogToolNamesProvider;
  /** Provider for installed/built-in plugin ids — feeds the B.8
   *  manifestLinter via BuilderToolContext.knownPluginIds. */
  knownPluginIds: KnownPluginIdsProvider;
  /**
   * tsc-gate for `fill_slot` (B.7-2). After a slot write, the tool runs
   * codegen → staging → tsc and surfaces errors so the agent can self-
   * correct in-turn. Threaded through to BuilderToolContext.
   */
  slotTypechecker: SlotTypecheckService;
  /**
   * Reference-implementation catalog: name → { root, description }.
   * Threads through to BuilderToolContext so `read_reference` and
   * `list_references` can serve multiple agents (SEO-analyst,
   * integration-confluence, integration-odoo, …) plus the boilerplate
   * template, instead of a single hard-coded path.
   */
  referenceCatalog: Readonly<Record<string, { root: string; description: string }>>;
  /**
   * Override the system-prompt seed (test-only). Default reads
   * `prompts/builder-system.md` next to this file plus the boilerplate
   * `CLAUDE.md` and concatenates them once at first turn.
   */
  systemPromptSeed?: () => Promise<string>;
  /**
   * Override sub-agent construction (test-only fake). Default:
   * `new LocalSubAgent(opts)`.
   */
  buildSubAgent?: (opts: BuilderSubAgentBuildOptions) => Askable;
  /** Override tool list (test-only). Default: built-in `builderTools()`. */
  tools?: ReadonlyArray<BuilderTool<unknown, unknown>>;
  subAgentMaxTokens?: number;
  subAgentMaxIterations?: number;
  /**
   * Cap on consecutive slot-typecheck failures per turn. When hit,
   * `fill_slot` surfaces an Error: result that stops the LocalSubAgent.
   * Default `DEFAULT_MAX_CONSECUTIVE_BUILD_FAILURES`.
   */
  maxConsecutiveBuildFailures?: number;
  /**
   * Absolute path to the build template root. Threaded through to
   * `BuilderToolContext.templateRoot` so the new `list_package_types` /
   * `read_package_types` tools can resolve packages from the shared
   * `<templateRoot>/node_modules`. Required.
   */
  templateRoot: string;
  logger?: (...args: unknown[]) => void;
}

export interface RunBuilderTurnOptions {
  draftId: string;
  userEmail: string;
  userMessage: string;
  /** Anthropic model id — e.g. `claude-haiku-4-5-20251001`. */
  modelChoice: string;
  /**
   * Optional pre-generated turn id. The route layer generates one so it can
   * register the ring buffer (B.5-3) before iteration begins; if omitted,
   * runTurn falls back to a fresh `randomUUID()` so it stays usable from
   * tests and ad-hoc consumers that do not need replay.
   */
  turnId?: string;
}

export class BuilderAgent {
  private readonly anthropic: Anthropic;
  private readonly draftStore: DraftStore;
  private readonly bus: SpecEventBus;
  private readonly rebuildScheduler: RebuildScheduler;
  private readonly catalogToolNames: CatalogToolNamesProvider;
  private readonly knownPluginIds: KnownPluginIdsProvider;
  private readonly slotTypechecker: SlotTypecheckService;
  private readonly referenceCatalog: Readonly<
    Record<string, { root: string; description: string }>
  >;
  private readonly systemPromptSeed: () => Promise<string>;
  private readonly buildSubAgent: (opts: BuilderSubAgentBuildOptions) => Askable;
  private readonly tools: ReadonlyArray<BuilderTool<unknown, unknown>>;
  private readonly maxTokens: number;
  private readonly maxIterations: number;
  private readonly maxConsecutiveBuildFailures: number;
  private readonly templateRoot: string;
  private readonly log: (...args: unknown[]) => void;

  private cachedSystemPromptSeed: string | null = null;

  constructor(deps: BuilderAgentDeps) {
    this.anthropic = deps.anthropic;
    this.draftStore = deps.draftStore;
    this.bus = deps.bus;
    this.rebuildScheduler = deps.rebuildScheduler;
    this.catalogToolNames = deps.catalogToolNames;
    this.knownPluginIds = deps.knownPluginIds;
    this.slotTypechecker = deps.slotTypechecker;
    this.referenceCatalog = deps.referenceCatalog;
    this.systemPromptSeed = deps.systemPromptSeed ?? defaultSystemPromptSeed;
    this.buildSubAgent = deps.buildSubAgent ?? defaultBuildSubAgent;
    this.tools = deps.tools ?? builderTools();
    this.maxTokens = deps.subAgentMaxTokens ?? DEFAULT_MAX_TOKENS;
    this.maxIterations = deps.subAgentMaxIterations ?? DEFAULT_MAX_ITERATIONS;
    this.maxConsecutiveBuildFailures =
      deps.maxConsecutiveBuildFailures ?? DEFAULT_MAX_CONSECUTIVE_BUILD_FAILURES;
    this.templateRoot = deps.templateRoot;
    this.log = deps.logger ?? (() => {});
  }

  async *runTurn(opts: RunBuilderTurnOptions): AsyncIterable<BuilderEvent> {
    const turnId = opts.turnId ?? randomUUID();
    yield { type: 'turn_started', turnId };

    const draft = await this.draftStore.load(opts.userEmail, opts.draftId);
    if (!draft) {
      yield {
        type: 'error',
        code: 'builder.draft_not_found',
        message: `draft '${opts.draftId}' not found for user '${opts.userEmail}'`,
      };
      return;
    }

    yield { type: 'chat_message', role: 'user', text: opts.userMessage };

    const userTurn: TranscriptEntry = {
      role: 'user',
      content: opts.userMessage,
      timestamp: Date.now(),
    };
    const transcriptWithUser = [...draft.transcript, userTurn];
    await this.draftStore.update(opts.userEmail, opts.draftId, {
      transcript: transcriptWithUser,
    });

    // Per-turn slot-retry tracker (B.7-4). Map<slotKey, attemptCount>
    // resets at turn boundary so the agent gets a fresh retry budget per
    // user message. fill_slot consults this to decide whether to emit
    // the `agent_stuck` event after the configured ceiling.
    const slotRetries = new Map<string, number>();
    const slotRetryTracker: SlotRetryTracker = {
      recordFail(slotKey: string): number {
        const next = (slotRetries.get(slotKey) ?? 0) + 1;
        slotRetries.set(slotKey, next);
        return next;
      },
      reset(slotKey: string): void {
        slotRetries.delete(slotKey);
      },
    };

    // Per-turn cap on *consecutive* slot-typecheck failures across all
    // slots — orthogonal to slotRetryTracker (which counts per slotKey).
    // Stops the runaway loop where the agent churns through different
    // slots without any of them ever turning green.
    let consecutiveBuildFails = 0;
    const buildFailureBudget: BuildFailureBudget = {
      recordFail(): number {
        consecutiveBuildFails += 1;
        return consecutiveBuildFails;
      },
      reset(): void {
        consecutiveBuildFails = 0;
      },
      limit: this.maxConsecutiveBuildFailures,
    };

    // Per-turn tool context (pinned to this draft + user).
    const toolCtx: BuilderToolContext = {
      userEmail: opts.userEmail,
      draftId: opts.draftId,
      draftStore: this.draftStore,
      bus: this.bus,
      rebuildScheduler: this.rebuildScheduler,
      catalogToolNames: this.catalogToolNames,
      knownPluginIds: this.knownPluginIds,
      referenceCatalog: this.referenceCatalog,
      slotTypechecker: this.slotTypechecker,
      slotRetryTracker,
      buildFailureBudget,
      templateRoot: this.templateRoot,
      userMessage: opts.userMessage,
    };

    const subAgentTools = this.tools.map((tool) => bridgeBuilderTool(tool, toolCtx));
    const systemPrompt = await this.composedSystemPrompt(draft.spec);

    const subAgent = this.buildSubAgent({
      name: `builder-${opts.draftId}`,
      client: this.anthropic,
      model: opts.modelChoice,
      maxTokens: this.maxTokens,
      maxIterations: this.maxIterations,
      systemPrompt,
      tools: subAgentTools,
    });

    const queue: BuilderEvent[] = [];
    let pendingResolver: (() => void) | null = null;
    let askDone = false;
    let askError: unknown = null;
    let assistantText = '';

    // Theme E0 — liveness counters. Updated by `push()` (every emitted
    // BuilderEvent counts as activity) and by the AskObserver hooks
    // below. The heartbeat interval reads these to compose a stream
    // event when the LLM goes silent.
    //
    // Theme E1 — extra counters (`currentPhase`, `tokensStreamedThisIter`)
    // surface the live LLM phase and per-iteration token count to the UI.
    // Both are read by the heartbeat tick and reset by `onIteration` so a
    // fresh iteration starts from a clean slate.
    let lastActivityAt = Date.now();
    let currentIteration = 0;
    let toolCallsThisIter = 0;
    let currentPhase: 'thinking' | 'streaming' | 'tool_running' | 'idle' =
      'idle';
    let tokensStreamedThisIter = 0;

    const wake = (): void => {
      const resolve = pendingResolver;
      pendingResolver = null;
      resolve?.();
    };
    const push = (ev: BuilderEvent): void => {
      queue.push(ev);
      // Heartbeat-events are themselves the "no activity" signal — do not
      // bump the timer when emitting one, otherwise the next tick would
      // always think we just had activity.
      if (ev.type !== 'heartbeat') {
        lastActivityAt = Date.now();
      }
      wake();
    };

    // Bridge from SpecEventBus → AsyncIterable. Subscribe for the lifetime
    // of the turn so spec/slot/lint events the tools emit reach the stream.
    const unsubscribeBus = this.bus.subscribe(opts.draftId, (ev) => {
      // We only forward 'agent'-cause events through the turn stream — user
      // edits go via the PATCH endpoints (B.4-4) and the UI already has them.
      if (ev.type === 'spec_patch' && ev.cause === 'agent') {
        push({ type: 'spec_patch', patches: ev.patches, cause: ev.cause });
      } else if (ev.type === 'slot_patch' && ev.cause === 'agent') {
        push({
          type: 'slot_patch',
          slotKey: ev.slotKey,
          source: ev.source,
          cause: ev.cause,
        });
      } else if (ev.type === 'lint_result' && ev.cause === 'agent') {
        push({ type: 'lint_result', issues: ev.issues, cause: ev.cause });
      }
    });

    const useToToolId = new Map<string, string>();
    const observer: AskObserver = {
      onIteration: (e) => {
        currentIteration = e.iteration;
        toolCallsThisIter = 0;
        // Reset Theme E1 per-iteration counters so the heartbeat reflects
        // the current iteration only and the UI ticker restarts at zero.
        tokensStreamedThisIter = 0;
        currentPhase = 'thinking';
        lastActivityAt = Date.now();
      },
      onSubToolUse: (e) => {
        useToToolId.set(e.id, e.name);
        toolCallsThisIter += 1;
        push({
          type: 'tool_use',
          useId: e.id,
          toolId: e.name,
          input: e.input,
        });
      },
      onSubToolResult: (e) => {
        const toolId = useToToolId.get(e.id) ?? 'unknown';
        push({
          type: 'tool_result',
          useId: e.id,
          toolId,
          output: e.output,
          isError: e.isError,
          durationMs: e.durationMs,
        });
      },
      onIterationPhase: (e) => {
        currentPhase = e.phase;
        // Phase transitions count as activity — without this the heartbeat
        // would tick "API hung" while Sonnet is happily flipping
        // streaming → tool_running on a long answer.
        lastActivityAt = Date.now();
      },
      onTokenChunk: (e) => {
        tokensStreamedThisIter = e.cumulativeOutputTokens;
        push({
          type: 'stream_token_chunk',
          iteration: e.iteration,
          deltaTokens: e.deltaTokens,
          cumulativeOutputTokens: e.cumulativeOutputTokens,
          tokensPerSec: e.tokensPerSec,
        });
      },
      onIterationUsage: (e) => {
        push({
          type: 'iteration_usage',
          iteration: e.iteration,
          inputTokens: e.inputTokens,
          outputTokens: e.outputTokens,
          cacheReadInputTokens: e.cacheReadInputTokens,
          cacheCreationInputTokens: e.cacheCreationInputTokens,
        });
      },
      onIterationEnd: (e) => {
        push({
          type: 'iteration_finished',
          iteration: e.iteration,
          stopReason: e.stopReason,
          toolUseCount: e.toolUseCount,
          textLength: e.textLength,
        });
      },
    };

    // Theme E0 — heartbeat timer. Emits a `heartbeat` event every 2s while
    // the turn is in flight so the UI can show a live counter ("Iter 3,
    // last activity 0.4s ago") instead of an opaque spinner. Cleaned up in
    // the `finally` below regardless of how the turn ends.
    const heartbeatTimer = setInterval(() => {
      push({
        type: 'heartbeat',
        sinceLastActivityMs: Date.now() - lastActivityAt,
        currentIteration,
        toolCallsThisIter,
        phase: currentPhase,
        tokensStreamedThisIter,
      });
    }, BUILDER_HEARTBEAT_INTERVAL_MS);
    // Don't keep the event loop alive just for the heartbeat — the
    // `finally` clears it deterministically, but unref-ing is cheap
    // insurance against orphaned timers in error paths.
    heartbeatTimer.unref?.();

    // LocalSubAgent.ask is single-turn — no native message-array API yet.
    // Inject the prior transcript as an XML-tagged context block so the
    // model can read what was said before. Without this the BuilderAgent
    // would forget the answer to its own architecture-fork questions on
    // the very next turn (visible bug from the workspace review).
    const contextualMessage = composeContextualMessage(
      draft.transcript,
      opts.userMessage,
    );

    // OB-31 phase-detection: if the user's message reads like a Build-
    // command, declare a per-turn obligation that `fill_slot` must be
    // invoked at least once. The LocalSubAgent enforces it by re-iterating
    // with tool_choice when the model would naturally exit without ever
    // having called fill_slot. Detection runs against the raw user
    // message — composeContextualMessage wraps it in XML for the model
    // but the heuristic ignores the surrounding history (the user's
    // *current* intent is what matters).
    const askOptions: AskOptions | undefined = detectBuildIntent(
      opts.userMessage,
    )
      ? { expectedTurnToolUse: 'fill_slot' }
      : undefined;

    const askPromise = subAgent
      .ask(contextualMessage, observer, askOptions)
      .then((text) => {
        assistantText = text;
      })
      .catch((err: unknown) => {
        askError = err;
      })
      .finally(() => {
        askDone = true;
        wake();
      });

    try {
      while (true) {
        if (queue.length > 0) {
          const ev = queue.shift();
          if (ev) yield ev;
          continue;
        }
        if (askDone) break;
        await new Promise<void>((resolve) => {
          pendingResolver = resolve;
        });
      }

      await askPromise;

      if (askError) {
        const message = askError instanceof Error ? askError.message : String(askError);
        this.log(`[builder] turn ${turnId} ask failed: ${message}`);
        yield {
          type: 'error',
          code: 'builder.ask_failed',
          message,
        };
        return;
      }

      yield { type: 'chat_message', role: 'assistant', text: assistantText };

      const assistantTurn: TranscriptEntry = {
        role: 'assistant',
        content: assistantText,
        timestamp: Date.now(),
      };
      await this.draftStore.update(opts.userEmail, opts.draftId, {
        transcript: [...transcriptWithUser, assistantTurn],
      });

      yield { type: 'turn_done', turnId };
    } finally {
      clearInterval(heartbeatTimer);
      unsubscribeBus();
    }
  }

  private async composedSystemPrompt(spec: AgentSpecSkeleton): Promise<string> {
    if (this.cachedSystemPromptSeed === null) {
      this.cachedSystemPromptSeed = await this.systemPromptSeed();
    }
    // Load the active template's slot manifest so the header can list
    // required-vs-filled slots explicitly. Without this the agent has to
    // discover the slot keys via `read_reference` or trial-and-error,
    // burning iterations on something we already know server-side.
    // Defensive: a malformed/empty `spec.template` (mid-construction
    // draft) or a missing template directory falls back to a header
    // without the slot block — the agent still works, it just doesn't
    // get the hint.
    let slotManifest: ReadonlyArray<SlotDef> | null = null;
    const templateId = typeof spec.template === 'string' ? spec.template : '';
    if (templateId.length > 0) {
      try {
        const bundle = await loadBoilerplate(templateId);
        slotManifest = bundle.manifest.slots;
      } catch {
        slotManifest = null;
      }
    }
    const header = buildSpecHeader(spec, slotManifest);
    return `${header}\n\n---\n\n${this.cachedSystemPromptSeed}`;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bridgeBuilderTool(
  tool: BuilderTool<unknown, unknown>,
  ctx: BuilderToolContext,
): LocalSubAgentTool {
  const schema = zodToJsonSchema(tool.input);
  const properties =
    schema.properties && typeof schema.properties === 'object'
      ? schema.properties
      : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  return {
    spec: {
      name: tool.id,
      description: tool.description,
      input_schema: {
        type: 'object',
        properties,
        required,
      },
    },
    async handle(input: unknown): Promise<string> {
      try {
        let parsed;
        try {
          parsed = tool.input.parse(input);
        } catch (parseErr) {
          // OB-31 follow-up debugging: log raw input shape when zod parse
          // fails so we can tell apart "model sent garbage" vs "max_tokens
          // truncated the JSON mid-stream" vs "schema/aggregator mismatch".
          const inputKeys =
            input && typeof input === 'object'
              ? Object.keys(input as Record<string, unknown>).join(',')
              : typeof input;
          const inputPreview = JSON.stringify(input).slice(0, 200);
          console.warn(
            `[builder/tool ${tool.id}] zod parse failed — keys=[${inputKeys}], input(<=200chars)=${inputPreview}`,
          );
          throw parseErr;
        }
        const result = await tool.run(parsed, ctx);
        if (typeof result === 'string') return result;
        // Builder tools (read_reference, lint_spec, …) return structured
        // `{ ok: false, error }` ErrResults instead of throwing. The
        // LocalSubAgent labels a tool result as an error iff the string
        // starts with `Error:` — without that prefix the LLM sees a happy
        // `is_error: false` tool_result, treats the failed call as
        // "interesting output", and retries with a fresh path. Observed
        // shape: 11 read_reference loops in one turn before the agent
        // gives up. Prefix the message so isError detection downstream
        // works AND the model gets a clear "stop trying that approach"
        // signal in the next iteration.
        if (
          result !== null &&
          typeof result === 'object' &&
          (result as { ok?: unknown }).ok === false
        ) {
          const errVal = (result as { error?: unknown }).error;
          const errText =
            typeof errVal === 'string' && errVal.length > 0
              ? errVal
              : JSON.stringify(result);
          return `Error: ${errText}`;
        }
        return JSON.stringify(result, null, 2);
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

function defaultBuildSubAgent(opts: BuilderSubAgentBuildOptions): Askable {
  return new LocalSubAgent({
    name: opts.name,
    client: opts.client,
    model: opts.model,
    maxTokens: opts.maxTokens,
    maxIterations: opts.maxIterations,
    systemPrompt: opts.systemPrompt,
    tools: opts.tools,
  });
}

export function buildSpecHeader(
  spec: AgentSpecSkeleton,
  slotManifest: ReadonlyArray<SlotDef> | null = null,
): string {
  const out: string[] = ['# Aktueller Draft-Stand'];
  out.push('```json');
  out.push(JSON.stringify(spec, null, 2));
  out.push('```');
  out.push(
    'Dies ist der aktuelle Stand der `AgentSpec`. Mutiere ihn inkrementell ' +
      'mit `patch_spec`. Slots werden separat über `fill_slot` gesetzt.',
  );

  if (slotManifest && slotManifest.length > 0) {
    out.push('');
    out.push(renderSlotManifest(spec, slotManifest));
  }

  return out.join('\n');
}

/**
 * Renders the active template's slot contract as a checklist the agent
 * can read before deciding which `fill_slot` calls to make. Lists every
 * declared slot with target_file, required-flag, and current fill state
 * (✓ filled / ✗ missing). The "Missing required" line at the bottom is
 * the explicit work-list — when that line says `none`, lint_spec /
 * codegen will not block on `missing_required_slot`.
 *
 * Without this hint the builder agent has to discover slot keys via
 * `read_reference name=boilerplate` (costs iterations + tokens) or by
 * trial-and-error — and on a 12-iteration cap a first turn often fills
 * 1-2 slots with stubs and ends without addressing the rest.
 */
function renderSlotManifest(
  spec: AgentSpecSkeleton,
  slotManifest: ReadonlyArray<SlotDef>,
): string {
  const filled = new Set(
    Object.entries(spec.slots ?? {})
      .filter(([, v]) => typeof v === 'string' && v.trim().length > 0)
      .map(([k]) => k),
  );

  const lines: string[] = [];
  lines.push('## Template-Slots — Checkliste');
  lines.push(
    `Template **\`${spec.template ?? 'unknown'}\`** declares the following slot keys. ` +
      'Use `fill_slot { slotKey, source }` for each. The agent is **not done** ' +
      'until every required slot has been filled with real implementation code ' +
      '(no stubs, no `// TODO`).',
  );
  lines.push('');
  for (const slot of slotManifest) {
    const isFilled = filled.has(slot.key);
    const flag = slot.required ? '**required**' : 'optional';
    const state = isFilled ? '✓ filled' : '✗ missing';
    const desc = slot.description ? ` — ${slot.description}` : '';
    lines.push(
      `- \`${slot.key}\` → \`${slot.target_file}\` (${flag}) — **${state}**${desc}`,
    );
  }

  const missingRequired = slotManifest
    .filter((s) => s.required && !filled.has(s.key))
    .map((s) => `\`${s.key}\``);
  lines.push('');
  lines.push(
    missingRequired.length > 0
      ? `**Missing required:** ${missingRequired.join(', ')}.`
      : '**Missing required:** none. ✓',
  );

  return lines.join('\n');
}

const PROMPT_FILE = 'builder-system.md';
const PROMPT_DIR = 'prompts';
const BOILERPLATE_CLAUDE_PATH = path.join(
  ASSETS.boilerplate.root,
  'agent-integration',
  'CLAUDE.md',
);
const BUILDER_PROMPT_PATH = path.resolve(
  fileURLToPath(import.meta.url),
  '..',
  PROMPT_DIR,
  PROMPT_FILE,
);

/**
 * Default loader: reads the builder-system.md instructions and the boilerplate
 * CLAUDE.md, returns them concatenated. Both files are read once and cached
 * by the BuilderAgent; restarts pick up edits.
 *
 * Fail-loud: missing files surface as a thrown Error so the boot flow doesn't
 * silently degrade to a contract-less prompt.
 */
async function defaultSystemPromptSeed(): Promise<string> {
  const [builder, boilerplate] = await Promise.all([
    fs.readFile(BUILDER_PROMPT_PATH, 'utf8'),
    fs.readFile(BOILERPLATE_CLAUDE_PATH, 'utf8'),
  ]);
  return `${builder.trim()}\n\n<boilerplate-contract>\n${boilerplate.trim()}\n</boilerplate-contract>`;
}

export {
  BUILDER_PROMPT_PATH as BUILDER_SYSTEM_PROMPT_PATH,
  BOILERPLATE_CLAUDE_PATH,
  defaultSystemPromptSeed,
};

// ---------------------------------------------------------------------------

/**
 * Build a single-string user message that carries the prior transcript
 * along with the current question. `LocalSubAgent.ask` is single-turn —
 * the only way to keep the model aware of what was said before is to
 * inline the history into the message.
 *
 * The format is XML-ish so the model has a clean delimiter between the
 * archived turns and the current ask. Empty transcripts return the bare
 * message, untouched, so first turns stay cheap.
 */
/**
 * OB-31: heuristic build-intent detector. Returns true when the user's
 * message reads like an imperative "fill the slots / build the plugin"
 * command. The match is conservative — favors false-negative over
 * false-positive, because a true positive locks the next turn into a
 * forced `fill_slot` API call (via LocalSubAgent's expectedTurnToolUse
 * escalation), which is bad UX if the user was actually asking a
 * question. Patterns:
 *
 *   - imperative build verb adjacent to slot/plugin/all object:
 *     `baue alle slots`, `fill all slots`, `schreibe slot client-impl`,
 *     `implementiere das plugin`, `build the spec`
 *   - compact build directives: `durchbauen`, `losbauen`, `jetzt bauen`
 *
 * Mismatched questions like "was macht fill_slot?" or "soll ich das
 * builden?" stay below the threshold (no adjacent slot/plugin/all term).
 */
export function detectBuildIntent(userMessage: string): boolean {
  const text = userMessage.toLowerCase();
  const verbObjectPattern =
    /\b(baue|fülle|fill|schreibe|implementiere|implement|build)\b[\s\S]{0,80}\b(slot|alle|all|durch|plugin|spec)\b/i;
  if (verbObjectPattern.test(text)) return true;
  const directBuildPattern = /\b(durchbauen|losbauen|jetzt bauen)\b/i;
  if (directBuildPattern.test(text)) return true;
  return false;
}

export function composeContextualMessage(
  transcript: ReadonlyArray<TranscriptEntry>,
  currentMessage: string,
): string {
  if (transcript.length === 0) return currentMessage;
  const rendered = transcript
    .map((entry, idx) => {
      const role = entry.role === 'user' ? 'user' : 'assistant';
      return `<turn n="${String(idx + 1)}" role="${role}">\n${entry.content}\n</turn>`;
    })
    .join('\n');
  return `<conversation-history>\n${rendered}\n</conversation-history>\n\n<current-user-message>\n${currentMessage}\n</current-user-message>`;
}
