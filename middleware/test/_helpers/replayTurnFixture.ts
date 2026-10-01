/**
 * A REAL `Orchestrator` wrapped by a REAL `VerifierService`, for the tests that
 * prove a verifier re-entry (borderline resample, correction retry, stream
 * retry) never runs a tool handler twice for one user request.
 *
 * Only the model (a scripted provider), the verifier pipeline and the verdict
 * store are stubbed. Every runtime symbol comes from `packages/.../src`, never
 * from a built entry point: the replay ledger travels through `turnContext`'s
 * AsyncLocalStorage, and a `dist/` Orchestrator next to a `src/`
 * VerifierService would be two module graphs with two ALS instances — a test
 * that looks green and proves nothing (see `mcpWriteIdempotency.test.ts`).
 *
 * All values are synthetic.
 */

import type { LlmProvider, LlmRequest, LlmResponse } from '@omadia/llm-provider';
import type {
  BypassedToolEntry,
  PrivacyBypassedToolRequest,
  PrivacyGuardService,
  PrivacyReceipt,
  PrivacyToolErrorRequest,
  ToolErrorEntry,
} from '@omadia/plugin-api';
import type {
  VerifierInput,
  VerifierPipeline,
  VerifierStore,
  VerifierVerdict,
} from '@omadia/verifier';

import type {
  ChatStreamEvent,
  ChatTurnInput,
} from '../../packages/harness-channel-sdk/src/chatAgent.js';
import { NativeToolRegistry } from '../../packages/harness-orchestrator/src/nativeToolRegistry.js';
import {
  Orchestrator,
  type OrchestratorOptions,
} from '../../packages/harness-orchestrator/src/orchestrator.js';
import { VerifierService } from '../../packages/harness-orchestrator/src/verifierService.js';
import type { WriteCapability } from '../../packages/plugin-api/src/writeCapabilities.js';

export const usage = {
  inputTokens: 10,
  outputTokens: 2,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
} as const;

const capabilities = {
  tools: true,
  vision: true,
  streaming: true,
  promptCaching: true,
  forcedToolChoice: true,
  parallelToolCalls: true,
} as const;

/** The user request every test sends. */
export const REQUEST: ChatTurnInput = {
  userMessage: 'Lege die Rechnung für den Kunden an.',
  sessionScope: 'scope-c07',
};

/** One tool call the scripted model makes: `[toolName, input]`. */
export type Call = readonly [name: string, input: unknown];

let callSeq = 0;

/** A model response that calls the given tools (one block each). */
export function toolCalls(...calls: Call[]): LlmResponse {
  return {
    content: calls.map(([name, input]) => {
      callSeq += 1;
      return { type: 'tool_call', id: `use-${String(callSeq)}`, name, input };
    }),
    finishReason: 'tool_calls',
    providerFinishReason: 'tool_use',
    model: 'test',
    usage,
  } as unknown as LlmResponse;
}

/** A model response that ends the turn with `answer`. */
export function text(answer: string): LlmResponse {
  return {
    content: [{ type: 'text', text: answer }],
    finishReason: 'stop',
    providerFinishReason: 'end_turn',
    model: 'test',
    usage,
  } as unknown as LlmResponse;
}

export interface ScriptedModel {
  readonly provider: LlmProvider;
  /** Every request the orchestrator sent, in order (buffered and streamed). */
  readonly requests: LlmRequest[];
}

/** A model that answers each request with the next scripted response, on
 *  both the buffered (`complete`) and the streaming (`stream`) path. */
export function scriptedModel(responses: readonly LlmResponse[]): ScriptedModel {
  const requests: LlmRequest[] = [];
  let idx = 0;
  const next = (request: LlmRequest): LlmResponse => {
    requests.push(request);
    const response = responses[idx];
    idx += 1;
    if (!response) throw new Error('scriptedModel: no scripted response left');
    return response;
  };
  const provider = {
    id: 'anthropic',
    capabilities,
    complete: (request: LlmRequest) => Promise.resolve(next(request)),
    stream: (request: LlmRequest) => {
      const response = next(request);
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'final', response };
        },
      };
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  };
  return { provider: provider as unknown as LlmProvider, requests };
}

/** The write capability every write tool in these tests declares. */
export const CREATE_INVOICE: readonly WriteCapability[] = [
  { dataClass: 'test.invoice', operation: 'create' },
];

/** A registered tool that records every input its handler ran with. */
export interface CountingTool {
  readonly name: string;
  /** One entry per handler EXECUTION — the mutation check reads this. */
  readonly inputs: unknown[];
}

/**
 * Registers a declared write tool. `behaviour` runs on every execution and
 * returns the handler's result (or throws).
 */
export function registerWriteTool(
  registry: NativeToolRegistry,
  name: string,
  behaviour: (input: unknown, execution: number) => Promise<string>,
): CountingTool {
  const inputs: unknown[] = [];
  registry.register(name, {
    handler: (input: unknown) => {
      inputs.push(input);
      return behaviour(input, inputs.length);
    },
    spec: {
      name,
      description: `${name} (test write tool)`,
      input_schema: { type: 'object' as const, properties: {}, required: [] },
    } as never,
    domain: 'test.invoice',
    writeCapabilities: CREATE_INVOICE,
  });
  return { name, inputs };
}

/** Every `tool_result` content string in one provider request. */
export function toolResultContents(request: LlmRequest | undefined): string[] {
  const out: string[] = [];
  const messages = (request as { messages?: unknown[] } | undefined)?.messages ?? [];
  for (const message of messages) {
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const b = block as { type?: string; content?: unknown };
      if (b.type === 'tool_result' && typeof b.content === 'string') out.push(b.content);
    }
  }
  return out;
}

/** A verifier pipeline that answers with the scripted verdicts in order
 *  (the last one repeats). */
export function scriptedPipeline(verdicts: readonly VerifierVerdict[]): {
  pipeline: VerifierPipeline;
  inputs: VerifierInput[];
} {
  const inputs: VerifierInput[] = [];
  const pipeline = {
    verify(input: VerifierInput): Promise<VerifierVerdict> {
      const verdict = verdicts[Math.min(inputs.length, verdicts.length - 1)];
      inputs.push(input);
      if (!verdict) return Promise.reject(new Error('scriptedPipeline: no verdict'));
      return Promise.resolve(verdict);
    },
  } as unknown as VerifierPipeline;
  return { pipeline, inputs };
}

export interface PersistedVerdict {
  readonly status: VerifierVerdict['status'];
  readonly retryCount: number;
}

export interface VerifiedTurnOptions {
  readonly responses: readonly LlmResponse[];
  readonly verdicts: readonly VerifierVerdict[];
  readonly registry?: NativeToolRegistry;
  readonly mode?: 'shadow' | 'enforce';
  readonly maxRetries?: number;
  readonly resampleOnBorderline?: boolean;
  /** Extra orchestrator options (privacy guard, hooks, session logger, …). */
  readonly orchestrator?: Partial<OrchestratorOptions>;
}

export interface VerifiedTurn {
  readonly orchestrator: Orchestrator;
  readonly service: VerifierService;
  readonly model: ScriptedModel;
  readonly verifyInputs: VerifierInput[];
  readonly persisted: PersistedVerdict[];
  /** Every line the verifier service logged. */
  readonly logs: string[];
}

/** Builds the real orchestrator + verifier wrapper over a scripted model. */
export function verifiedTurn(options: VerifiedTurnOptions): VerifiedTurn {
  const model = scriptedModel(options.responses);
  const orchestrator = new Orchestrator({
    provider: model.provider,
    model: 'test',
    maxTokens: 1024,
    maxToolIterations: 4,
    domainTools: [],
    nativeToolRegistry: options.registry ?? new NativeToolRegistry(),
    ...options.orchestrator,
  } as OrchestratorOptions);
  const { pipeline, inputs } = scriptedPipeline(options.verdicts);
  const persisted: PersistedVerdict[] = [];
  const store = {
    persist(row: { verdict: VerifierVerdict; retryCount: number }) {
      persisted.push({ status: row.verdict.status, retryCount: row.retryCount });
      return Promise.resolve();
    },
  } as unknown as VerifierStore;
  const logs: string[] = [];
  const service = new VerifierService({
    orchestrator,
    pipeline,
    store,
    enabled: true,
    mode: options.mode ?? 'enforce',
    maxRetries: options.maxRetries ?? 1,
    ...(options.resampleOnBorderline !== undefined
      ? { resampleOnBorderline: options.resampleOnBorderline }
      : {}),
    log: (line: string) => {
      logs.push(line);
    },
  });
  return { orchestrator, service, model, verifyInputs: inputs, persisted, logs };
}

/** A personal value tool data and errors in these tests carry. */
export const EMAIL = 'erika.mustermann@example.com';

export interface MaskingPrivacy {
  readonly service: PrivacyGuardService;
  /** Turn ids `finalizeTurn` was called for, in order. */
  readonly finalized: string[];
}

/**
 * The REAL `privacyGuard` seam the orchestrator builds its per-turn handle
 * from. Interns for real (the digest masks {@link EMAIL}), redacts returned
 * `Error:` text, and emits a per-turn receipt from what it saw in that turn:
 * the datasets it interned, the bypasses and the tool errors recorded.
 */
export function maskingPrivacy(): MaskingPrivacy {
  const turns = new Map<string, { interned: number; bypassed: BypassedToolEntry[]; errors: ToolErrorEntry[] }>();
  const turn = (turnId: string) => {
    let t = turns.get(turnId);
    if (!t) {
      t = { interned: 0, bypassed: [], errors: [] };
      turns.set(turnId, t);
    }
    return t;
  };
  const finalized: string[] = [];
  const service = {
    async internToolResultV4(request: { turnId: string; toolName: string; rawResult: string }) {
      turn(request.turnId).interned += 1;
      return {
        digestText: `«dataset:${request.toolName}» ${request.rawResult.replaceAll(EMAIL, '[masked:email]')}`,
        datasetId: `ds-${request.toolName}`,
      };
    },
    async recordBypassedTool(request: PrivacyBypassedToolRequest) {
      const { turnId, ...entry } = request;
      turn(turnId).bypassed.push(entry);
    },
    async recordToolError(request: PrivacyToolErrorRequest) {
      const { turnId, ...entry } = request;
      turn(turnId).errors.push(entry);
    },
    async redactToolErrorText({ text: body }: { text: string }) {
      return {
        outcome: 'redacted' as const,
        text: body.replaceAll(EMAIL, '[masked:email]'),
        spans: [],
        degraded: false,
      };
    },
    async runV4Tool() {
      return { resultText: '' };
    },
    async subAgentResultV4(request: { narration: string }) {
      return { resultText: `«bridged» ${request.narration}` };
    },
    async takeRenderedAnswerV4() {
      return undefined;
    },
    v4ToolSpecs() {
      return [];
    },
    async finalizeTurn(turnId: string): Promise<PrivacyReceipt | undefined> {
      finalized.push(turnId);
      const t = turns.get(turnId);
      turns.delete(turnId);
      if (!t) return undefined;
      return {
        datasetsInterned: t.interned,
        fieldsMasked: 0,
        fieldsCleartext: 0,
        verbsExecuted: [],
        pseudonymProjectionUsed: false,
        ...(t.bypassed.length > 0 ? { bypassedTools: t.bypassed } : {}),
        ...(t.errors.length > 0 ? { toolErrors: t.errors } : {}),
      };
    },
  } as unknown as PrivacyGuardService;
  return { service, finalized };
}

/** Drains a stream into an array. */
export async function drain(stream: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const events: ChatStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

/** The terminal `done` event of a drained stream. */
export function doneOf(
  events: readonly ChatStreamEvent[],
): Extract<ChatStreamEvent, { type: 'done' }> | undefined {
  return events.find(
    (e): e is Extract<ChatStreamEvent, { type: 'done' }> => e.type === 'done',
  );
}
