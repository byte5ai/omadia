import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type Anthropic from '@anthropic-ai/sdk';
import {
  LocalSubAgent,
  type AskObserver,
  type LocalSubAgentTool,
} from '@omadia/orchestrator';

import { zodToJsonSchema } from '../zodToJsonSchema.js';
import { composeContextualMessage } from './builderAgent.js';
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
  | { type: 'turn_done'; turnId: string };

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_MAX_ITERATIONS = 8;

interface Askable {
  ask(question: string, observer?: AskObserver): Promise<string>;
}

export interface SubAgentBuildOptions {
  name: string;
  client: Anthropic;
  model: string;
  maxTokens: number;
  maxIterations: number;
  systemPrompt: string;
  tools: LocalSubAgentTool[];
}

export interface PreviewChatServiceDeps {
  anthropic: Anthropic;
  draftStore: DraftStore;
  /**
   * Custom system-prompt-loader. Default: read `<previewDir>/skills/*.md`,
   * strip frontmatter, concat with a header derived from the draft spec.
   */
  systemPromptFor?: (
    handle: PreviewHandle,
    spec: AgentSpecSkeleton,
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
  /** Anthropic model id — e.g. `claude-haiku-4-5-20251001`. */
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
  private readonly anthropic: Anthropic;
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
    this.anthropic = deps.anthropic;
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

    const tools = opts.handle.toolkit.tools.map(bridgePreviewTool);
    const systemPrompt = await this.systemPromptFor(opts.handle, draft.spec);

    const subAgent = this.buildSubAgent({
      name: `preview-${opts.handle.agentId}`,
      client: this.anthropic,
      model: opts.modelChoice,
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
    client: opts.client,
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
 * dynamicAgentRuntime.loadSystemPrompt), and concatenates with a header
 * derived from the draft spec. Missing skills/ dir is non-fatal — the agent
 * runs with header-only guidance.
 */
export async function loadPreviewSystemPrompt(
  handle: PreviewHandle,
  spec: AgentSpecSkeleton,
): Promise<string> {
  const skillsDir = path.join(handle.previewDir, 'skills');
  let entries: string[] = [];
  try {
    entries = await fs.readdir(skillsDir);
  } catch {
    // skills dir absent — fall through to header-only prompt.
  }
  entries.sort();
  const parts: string[] = [];
  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    const abs = path.join(skillsDir, name);
    if (!abs.startsWith(skillsDir + path.sep)) continue;
    try {
      const raw = await fs.readFile(abs, 'utf-8');
      parts.push(stripFrontmatter(raw).trim());
    } catch {
      // unreadable file — skip silently.
    }
  }

  const header = buildPreviewHeader(handle, spec);
  if (parts.length === 0) return header;
  return `${header}\n\n---\n\n${parts.join('\n\n---\n\n')}`;
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
