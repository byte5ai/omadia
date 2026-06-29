import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { LlmProvider } from '@omadia/llm-provider';
import {
  LocalSubAgent,
  type AskObserver,
  type LocalSubAgentTool,
} from '@omadia/orchestrator';

import {
  inferFamilyFromModel,
  warnIfEmptyInputSchema,
} from '../dynamicAgentRuntime.js';
import { composePersonaSection } from '../personaCompose.js';
import { compileSycophancyGuard } from '../sycophancyGuard.js';
import { zodToJsonSchema } from '../zodToJsonSchema.js';
import { compileBoundariesSection } from './boundaryPresets.js';
import {
  composeContextualMessage,
  type BuilderProviderResolution,
  type BuilderProviderResolver,
} from './builderAgent.js';
import type { DraftStore } from './draftStore.js';
import type { PreviewHandle, PreviewToolDescriptor } from './previewRuntime.js';
import type { AgentSpecSkeleton, TranscriptEntry } from './types.js';

/**
 * PreviewChatService — builder chat surface against an active preview agent.
 *
 * Exposes two entry points:
 *   - `runTurn(...)`: chat-style turn — bridges the preview tools (Zod) onto
 *      `LocalSubAgentTool`s, builds an ephemeral `LocalSubAgent` with a
 *      system prompt from `<previewDir>/skills/*.md`, drives a tool loop and
 *      streams `PreviewChatEvent`s as an AsyncIterable for SSE.
 *   - `runDirectTool(...)`: bypass — invokes a tool from the preview toolkit
 *      directly with Zod-validated input, without Anthropic.
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
  provider: LlmProvider;
  model: string;
  maxTokens: number;
  maxIterations: number;
  systemPrompt: string;
  tools: LocalSubAgentTool[];
}

export interface PreviewChatServiceDeps {
  resolveProvider: BuilderProviderResolver;
  draftStore: DraftStore;
  /**
   * Custom system-prompt-loader. Default: read `<previewDir>/skills/*.md`,
   * strip frontmatter, concat with a header derived from the draft spec
   * AND the live persona / boundaries / sycophancy from the spec — so
   * the operator's slider/checkbox edits feed back into the preview
   * chat **immediately**, without an Install round-trip.
   */
  systemPromptFor?: (
    handle: PreviewHandle,
    spec: AgentSpecSkeleton,
    modelId: string,
  ) => Promise<string>;
  /**
   * Override sub-agent construction (test-only fake). Default:
   * `new LocalSubAgent(opts)`.
   */
  buildSubAgent?: (opts: SubAgentBuildOptions) => Askable;
  subAgentMaxTokens?: number;
  subAgentMaxIterations?: number;
  logger?: (...args: unknown[]) => void;
}

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

  constructor(deps: PreviewChatServiceDeps) {
    this.resolveProvider = deps.resolveProvider;
    this.draftStore = deps.draftStore;
    this.systemPromptFor = deps.systemPromptFor ?? loadPreviewSystemPrompt;
    this.buildSubAgent = deps.buildSubAgent ?? defaultBuildSubAgent;
    this.maxTokens = deps.subAgentMaxTokens ?? DEFAULT_MAX_TOKENS;
    this.maxIterations = deps.subAgentMaxIterations ?? DEFAULT_MAX_ITERATIONS;
    this.log = deps.logger ?? (() => {});
  }

  async *runTurn(opts: RunTurnOptions): AsyncIterable<PreviewChatEvent> {
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
        code: 'builder.model_unavailable',
        message: err instanceof Error ? err.message : String(err),
      };
      return;
    }

    const tools = opts.handle.toolkit.tools.map(bridgePreviewTool);
    const systemPrompt = await this.systemPromptFor(
      opts.handle,
      draft.spec,
      resolved.modelId,
    );

    const subAgent = this.buildSubAgent({
      name: `preview-${opts.handle.agentId}`,
      provider: resolved.provider,
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
      const parsed = tool.input.parse(opts.input);
      const result = await tool.run(parsed);
      return { result, isError: false };
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
  const schema = zodToJsonSchema(td.input);
  const properties =
    schema.properties && typeof schema.properties === 'object'
      ? schema.properties
      : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  warnIfEmptyInputSchema(td.id, td.input, properties);
  return {
    spec: {
      name: td.id,
      description: td.description,
      input_schema: {
        type: 'object',
        properties,
        required,
      },
    },
    async handle(input: unknown): Promise<string> {
      try {
        const parsed = td.input.parse(input);
        const result = await td.run(parsed);
        return typeof result === 'string'
          ? result
          : JSON.stringify(result, null, 2);
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

function defaultBuildSubAgent(opts: SubAgentBuildOptions): Askable {
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
 * Default system-prompt loader. Reads `<previewDir>/skills/*.md`, strips
 * leading frontmatter blocks (matching the boilerplate convention in
 * dynamicAgentRuntime.loadSystemPrompt), and concatenates with:
 *
 *   1. a header derived from the draft spec
 *   2. **the live persona section** from `spec.persona` (no AGENT.md
 *      round-trip — the operator's sliders feed into the preview chat
 *      directly)
 *   3. **the live boundaries section** from `spec.quality.boundaries`
 *   4. **the live sycophancy guard** from `spec.quality.sycophancy`
 *   5. the skill bodies from `<previewDir>/skills/*.md`
 *
 * Compose order matches the runtime path in
 * `dynamicAgentRuntime.loadSystemPrompt` so the preview behaves
 * byte-identically to what the installed agent would receive.
 *
 * Missing skills/ dir is non-fatal — the agent runs with header-only
 * guidance.
 */
export async function loadPreviewSystemPrompt(
  handle: PreviewHandle,
  spec: AgentSpecSkeleton,
  modelId: string,
): Promise<string> {
  const skillsDir = path.join(handle.previewDir, 'skills');
  let entries: string[] = [];
  try {
    entries = await fs.readdir(skillsDir);
  } catch {
    // skills dir absent — fall through to header-only prompt.
  }
  entries.sort();
  const skillBodies: string[] = [];
  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    const abs = path.join(skillsDir, name);
    if (!abs.startsWith(skillsDir + path.sep)) continue;
    try {
      const raw = await fs.readFile(abs, 'utf-8');
      skillBodies.push(stripFrontmatter(raw).trim());
    } catch {
      // unreadable file — skip silently.
    }
  }

  // Live compose — same inner-layer helpers the runtime uses (and the
  // preview-prompt route from #55). Operator slider/checkbox edits land
  // here on the very next preview turn, no Install needed.
  const personaSection = spec.persona
    ? composePersonaSection({
        persona: spec.persona,
        family: inferFamilyFromModel(modelId),
      })
    : '';

  const boundaries = spec.quality?.boundaries;
  const boundariesSection = boundaries
    ? compileBoundariesSection(boundaries.presets ?? [], boundaries.custom ?? [])
        .text
    : '';

  const sycophancySection = compileSycophancyGuard(spec.quality?.sycophancy);

  const parts: string[] = [buildPreviewHeader(handle, spec)];
  if (personaSection.length > 0) parts.push(personaSection);
  if (
    typeof spec.persona?.custom_notes === 'string' &&
    spec.persona.custom_notes.length > 0
  ) {
    parts.push(spec.persona.custom_notes);
  }
  if (boundariesSection.length > 0) parts.push(boundariesSection);
  if (sycophancySection.length > 0) parts.push(sycophancySection);
  if (skillBodies.length > 0) parts.push(skillBodies.join('\n\n---\n\n'));

  return parts.join('\n\n---\n\n');
}

function buildPreviewHeader(
  handle: PreviewHandle,
  spec: AgentSpecSkeleton,
): string {
  const name = (spec.name || handle.agentId).trim();
  const id = (spec.id || handle.agentId).trim();
  const version = (spec.version || '0.1.0').trim();
  const desc = (spec.description || '').trim();
  const whenToUse = (spec.playbook?.when_to_use || '').trim();
  const out: string[] = [`# ${name} (${id} v${version}) — preview`];
  if (desc) out.push(desc);
  if (whenToUse) out.push(`## Wann nutzen\n\n${whenToUse}`);
  return out.filter(Boolean).join('\n\n');
}

function stripFrontmatter(md: string): string {
  return md.replace(/^---\n[\s\S]*?\n---\n?/, '');
}
