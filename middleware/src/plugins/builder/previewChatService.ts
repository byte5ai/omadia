import { randomUUID } from 'node:crypto';

import type { LlmProvider } from '@omadia/llm-provider';
import { resolveClaudeCliBin } from '../../platform/cliBinary.js';
import {
  LocalSubAgent,
  createCliSubAgent,
  type AskObserver,
  type LocalSubAgentTool,
} from '@omadia/orchestrator';

import { recordForeignToolCall } from '../../platform/foreignToolMetrics.js';
import { isForceGuarded } from '../privacyPosture.js';
import { bridgedToolError, type BridgeStage } from '../bridgedToolError.js';
import { effectivePluginKind } from './agentSpec.js';
import {
  composeContextualMessage,
  type BuilderProviderResolution,
  type BuilderProviderResolver,
} from './builderAgent.js';
import { BuilderLlmAccessError, builderResolverErrorCode } from './builderLlmAccess.js';
import type { DraftStore } from './draftStore.js';
import type { PreviewHandle, PreviewToolDescriptor } from './previewRuntime.js';
import type { AgentSpecSkeleton, TranscriptEntry } from './types.js';

/**
 * PreviewChatService — the Plugin Builder's preview chat against an active
 * preview of the draft plugin.
 *
 * Spec 2042 §5.10 — a preview turn is a turn of a NEUTRAL DRAFT AGENT: it has
 * no persona, no role text and no grants of its own; it holds exactly the
 * tools the draft plugin registered via `ctx.tools.register` (captured on the
 * preview handle, never in the kernel's tool registry) and speaks as itself,
 * marked "preview". Its output goes only to the operator's admin UI (the
 * builder SSE route behind the admin session).
 *
 * The draft agent lives in memory for the turn (an ephemeral `LocalSubAgent`)
 * rather than as an `agents` row with status `draft`: nothing outside this
 * service can reach it, it is offered no tool but the draft plugin's, and it
 * carries no identity a row would hold — a row would add a lifecycle to clean
 * up without adding a boundary.
 *
 * Exposes two entry points:
 *   - `runTurn(...)`: chat-style turn — hands the captured tools to the
 *      neutral draft agent, drives its tool loop and streams
 *      `PreviewChatEvent`s as an AsyncIterable for SSE.
 *   - `runDirectTool(...)`: bypass — invokes one captured tool directly,
 *      without a model.
 *
 * Statelessness caveat: `LocalSubAgent.ask(question, observer?)` is currently
 * a single-turn API (matching the old ManagedAgent profile). The service
 * persists each turn into `draft.preview_transcript_json` for UI replay; the
 * preview agent does not need more turn-to-turn memory to validate the tool
 * implementation for now. Multi-turn LLM-memory injection (replay of earlier
 * turns as context) is planned for B.5.
 */

export type PreviewChatEvent =
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
  | { type: 'turn_done'; turnId: string }
  | { type: 'error'; code: string; message: string };

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_MAX_ITERATIONS = 8;

interface Askable {
  ask(question: string, observer?: AskObserver): Promise<string>;
}

export interface SubAgentBuildOptions {
  name: string;
  /** OM-101 — absent on the subscription path; the CLI owns the loop there. */
  provider?: LlmProvider;
  /** OM-101 — CLI alias (`opus` / `sonnet` / `haiku`) on the subscription path. */
  cliModel?: string;
  model: string;
  maxTokens: number;
  maxIterations: number;
  systemPrompt: string;
  tools: LocalSubAgentTool[];
}

export interface PreviewChatServiceDeps {
  resolveProvider: BuilderProviderResolver;
  draftStore: DraftStore;
  /** Override of the neutral draft agent's system prompt (test seam).
   *  Default: `previewDraftAgentPrompt`. */
  systemPromptFor?: (handle: PreviewHandle, spec: AgentSpecSkeleton) => string;
  /**
   * Override sub-agent construction (test-only fake). Default:
   * `new LocalSubAgent(opts)`.
   */
  buildSubAgent?: (opts: SubAgentBuildOptions) => Askable;
  subAgentMaxTokens?: number;
  subAgentMaxIterations?: number;
  logger?: (...args: unknown[]) => void;
  /** #1540 — read for `OMADIA_PRIVACY_FORCE_GUARDED`; a seam for tests. */
  policyEnv?: NodeJS.ProcessEnv;
}

/**
 * #1540 — the error code of a preview turn refused by the org privacy policy.
 * The preview agent runs its own model loop with no Privacy Shield: the tool
 * results of the draft's toolkit reach the model as they come back.
 */
export const PREVIEW_PRIVACY_REFUSED_CODE = 'builder.privacy_shield_required';

export interface RunTurnOptions {
  handle: PreviewHandle;
  userEmail: string;
  userMessage: string;
  modelChoice: string;
}

export interface RunDirectToolOptions {
  handle: PreviewHandle;
  toolId: string;
  input: unknown;
}

export interface DirectToolResult {
  result: unknown;
  isError: boolean;
}

export class PreviewChatService {
  private readonly resolveProvider: BuilderProviderResolver;
  private readonly draftStore: DraftStore;
  private readonly systemPromptFor: NonNullable<
    PreviewChatServiceDeps['systemPromptFor']
  >;
  private readonly buildSubAgent: NonNullable<
    PreviewChatServiceDeps['buildSubAgent']
  >;
  private readonly maxTokens: number;
  private readonly maxIterations: number;
  private readonly log: (...args: unknown[]) => void;
  private readonly policyEnv: NodeJS.ProcessEnv;

  constructor(deps: PreviewChatServiceDeps) {
    this.resolveProvider = deps.resolveProvider;
    this.draftStore = deps.draftStore;
    this.systemPromptFor = deps.systemPromptFor ?? previewDraftAgentPrompt;
    this.buildSubAgent = deps.buildSubAgent ?? defaultBuildSubAgent;
    this.maxTokens = deps.subAgentMaxTokens ?? DEFAULT_MAX_TOKENS;
    this.maxIterations = deps.subAgentMaxIterations ?? DEFAULT_MAX_ITERATIONS;
    this.log = deps.logger ?? (() => {});
    this.policyEnv = deps.policyEnv ?? process.env;
  }

  async *runTurn(opts: RunTurnOptions): AsyncIterable<PreviewChatEvent> {
    // #1540 — the preview's model loop has no Privacy Shield (no turn handle,
    // no interning), even while a privacy guard runs. Under the org policy it
    // is refused before anything is stored or sent, like a CLI turn
    // (`CliChatAgent.refusedByPolicy`). Read per turn: the policy can change
    // without a restart of this service.
    if (isForceGuarded(this.policyEnv)) {
      yield {
        type: 'error',
        code: PREVIEW_PRIVACY_REFUSED_CODE,
        message:
          'OMADIA_PRIVACY_FORCE_GUARDED=true: the preview chat runs without the Privacy Shield and is disabled.',
      };
      return;
    }
    const draftId = opts.handle.draftId;
    const draft = await this.draftStore.load(opts.userEmail, draftId);
    if (!draft) {
      throw new Error(
        `PreviewChatService: draft not found '${draftId}' for user '${opts.userEmail}'`,
      );
    }

    const turnId = randomUUID();

    yield { type: 'chat_message', role: 'user', text: opts.userMessage };

    const userTurn: TranscriptEntry = {
      role: 'user',
      content: opts.userMessage,
      timestamp: Date.now(),
    };
    const transcriptWithUser = [...draft.previewTranscript, userTurn];
    await this.draftStore.update(opts.userEmail, draftId, {
      previewTranscript: transcriptWithUser,
    });

    let resolved: BuilderProviderResolution;
    try {
      resolved = await this.resolveProvider(opts.modelChoice);
    } catch (err) {
      yield {
        type: 'error',
        // OM-101 — see builderAgent: missing access is its own failure class.
        code: builderResolverErrorCode(err),
        message: err instanceof Error ? err.message : String(err),
      };
      return;
    }

    // Exactly the draft plugin's tools — nothing else is offered.
    const tools = opts.handle.toolkit.tools.map(bridgePreviewTool);
    const systemPrompt = this.systemPromptFor(opts.handle, draft.spec);

    const subAgent = this.buildSubAgent({
      name: `preview-draft-${opts.handle.agentId}`,
      ...(resolved.provider ? { provider: resolved.provider } : {}),
      ...(resolved.cliModel ? { cliModel: resolved.cliModel } : {}),
      model: resolved.modelId,
      maxTokens: this.maxTokens,
      maxIterations: this.maxIterations,
      systemPrompt,
      tools,
    });

    const queue: PreviewChatEvent[] = [];
    let pendingResolver: (() => void) | null = null;
    let askDone = false;
    let askError: unknown = null;
    let assistantText = '';

    const wake = (): void => {
      const resolve = pendingResolver;
      pendingResolver = null;
      resolve?.();
    };
    const push = (ev: PreviewChatEvent): void => {
      queue.push(ev);
      wake();
    };

    const useToToolId = new Map<string, string>();
    const observer: AskObserver = {
      onSubToolUse: (e) => {
        useToToolId.set(e.id, e.name);
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
    };

    // LocalSubAgent.ask is single-turn — no native message-array API.
    // Inline the prior preview transcript so the model remembers what the
    // user already said when probing the preview agent (same fix as
    // composeContextualMessage in builderAgent.ts).
    const contextualMessage = composeContextualMessage(
      draft.previewTranscript,
      opts.userMessage,
    );

    const askPromise = subAgent
      .ask(contextualMessage, observer)
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
      throw askError;
    }

    yield { type: 'chat_message', role: 'assistant', text: assistantText };

    const assistantTurn: TranscriptEntry = {
      role: 'assistant',
      content: assistantText,
      timestamp: Date.now(),
    };
    await this.draftStore.update(opts.userEmail, draftId, {
      previewTranscript: [...transcriptWithUser, assistantTurn],
    });

    yield { type: 'turn_done', turnId };

    this.log(
      `[preview-chat] draft=${draftId} agent=${opts.handle.agentId} model=${opts.modelChoice} turn=${turnId} chars=${String(assistantText.length)}`,
    );
  }

  async runDirectTool(opts: RunDirectToolOptions): Promise<DirectToolResult> {
    const tool = opts.handle.toolkit.tools.find((t) => t.id === opts.toolId);
    if (!tool) {
      return {
        result: { error: `unknown tool: ${opts.toolId}` },
        isError: true,
      };
    }
    try {
      const text = await tool.run(opts.input);
      return { result: parseToolText(text), isError: false };
    } catch (err) {
      return {
        result: { error: err instanceof Error ? err.message : String(err) },
        isError: true,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bridgePreviewTool(td: PreviewToolDescriptor): LocalSubAgentTool {
  return {
    spec: {
      name: td.id,
      description: td.description,
      input_schema: {
        type: 'object',
        properties: td.inputSchema.properties,
        required: [...(td.inputSchema.required ?? [])],
      },
    },
    async handle(input: unknown): Promise<string> {
      try {
        return await td.run(input);
      } catch (err) {
        // The plugin's handler validates its own input (registerTools.ts):
        // a ZodError is an input error the model can correct.
        const stage: BridgeStage =
          err instanceof Error && err.name === 'ZodError' ? 'input' : 'run';
        return bridgedToolError(td.id, err, stage, 'preview-chat');
      }
    },
  };
}

/** A tool returns text; a JSON result (the boilerplate stringifies
 *  non-string results) is shown as the value it encodes. */
function parseToolText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * OM-101 — mirrors `builderAgent.defaultBuildSubAgent`. The preview chat is a
 * tool-loop agent too (it drives the drafted agent's own toolkit), so on the
 * subscription provider it has to run through the CLI for the same reason.
 */
function defaultBuildSubAgent(opts: SubAgentBuildOptions): Askable {
  if (opts.cliModel) {
    return createCliSubAgent({
      name: opts.name,
      systemPrompt: opts.systemPrompt,
      model: opts.cliModel,
      tools: opts.tools,
      // #1085 — the binary an operator installed through the UI, not PATH.
      resolveCliBinary: resolveClaudeCliBin,
      // #1072 — see `builderAgent.defaultBuildSubAgent`.
      onForeignToolUse: (toolName) => recordForeignToolCall(toolName, 'builder-preview'),
    });
  }
  if (!opts.provider) {
    throw new BuilderLlmAccessError(
      'preview sub-agent: neither an LLM provider nor a subscription CLI model was resolved',
    );
  }
  return new LocalSubAgent({
    name: opts.name,
    provider: opts.provider,
    model: opts.model,
    maxTokens: opts.maxTokens,
    maxIterations: opts.maxIterations,
    systemPrompt: opts.systemPrompt,
    tools: opts.tools,
  });
}

/**
 * System prompt of the neutral draft agent (spec 2042 §5.10). Built only from
 * the plugin's identity, kind and playbook — "when to use this capability",
 * which a calling agent also reads. It never carries a persona, role text,
 * quality settings or skill files: a plugin has none, and fields an old draft
 * still stores (`persona`, `quality`, `skill`) are ignored.
 */
export function previewDraftAgentPrompt(
  handle: PreviewHandle,
  spec: AgentSpecSkeleton,
): string {
  const name = (spec.name || handle.agentId).trim();
  const id = (spec.id || handle.agentId).trim();
  const version = (spec.version || '0.1.0').trim();
  const kind = effectivePluginKind(spec);
  const toolNames = handle.toolkit.tools.map((t) => t.id);
  const parts: string[] = [
    '# Preview',
    'You are a neutral draft agent in the Plugin Builder preview. You have no ' +
      'persona and no role of your own. You test the capabilities of the draft ' +
      `plugin "${name}" (${id} v${version}, kind ${kind}) for the operator who ` +
      'is building it.',
    toolNames.length > 0
      ? `Your only tools are the ones this plugin registers: ${toolNames.join(', ')}. ` +
        'Use them when the request needs them. Say plainly when a request is ' +
        'outside them. Report tool errors as they come back.'
      : 'This plugin registers no tools yet, so you cannot call anything. Say so.',
    'Answer briefly and factually.',
  ];
  const desc = (spec.description || '').trim();
  if (desc) parts.push(`## The plugin\n\n${desc}`);
  const whenToUse = (spec.playbook?.when_to_use || '').trim();
  if (whenToUse) parts.push(`## When to use this capability\n\n${whenToUse}`);
  const notFor = (spec.playbook?.not_for ?? []).map((l) => l.trim()).filter(Boolean);
  if (notFor.length > 0) parts.push(`## Not for\n\n${notFor.map((l) => `- ${l}`).join('\n')}`);
  return parts.join('\n\n');
}
