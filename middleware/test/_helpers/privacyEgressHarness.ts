/**
 * Shared harness for the verifier's privacy hand-over tests against the REAL
 * Orchestrator and the REAL privacy-guard service: a recording provider for
 * the turn's own model, a finalize-counting privacy service and a turn
 * receipt store that records what it persists.
 */

import type {
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStreamEvent,
} from '@omadia/llm-provider';
import {
  NativeToolRegistry,
  Orchestrator,
  type ChatStreamEvent,
} from '@omadia/orchestrator';
import type {
  PrivacyGuardService,
  TurnReceiptRecordInput,
} from '@omadia/plugin-api';
import { createPrivacyGuardService } from '@omadia/plugin-privacy-guard/dist/index.js';

const providerCapabilities = {
  tools: true,
  vision: true,
  streaming: true,
  promptCaching: true,
  forcedToolChoice: true,
  parallelToolCalls: true,
} as const;

/** Synthetic identity; never followed directly by a period (word-boundary
 *  widening would fold the period into the masked value). */
export const RAW_EMAIL = 'jana.beispiel@firma.example';
/** Shape of the e-mail surrogates the prompt mask mints. */
export const SURROGATE_EMAIL = /[a-z]+\.[a-z]+@example\.net/;
/** Any e-mail address in a serialized request. */
const ANY_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/** The real privacy-guard service with `finalizeTurn` counted. */
export function countingService(
  maskUserPrompt = true,
  overrides: Partial<PrivacyGuardService> = {},
): {
  service: PrivacyGuardService;
  finalizeCalls: () => number;
} {
  const inner = createPrivacyGuardService({
    readConfig: (key: string) =>
      key === 'mask_user_prompt' && maskUserPrompt ? 'on' : undefined,
  });
  let calls = 0;
  const service: PrivacyGuardService = {
    ...inner,
    ...overrides,
    finalizeTurn: async (turnId, turnInput) => {
      calls += 1;
      return inner.finalizeTurn(turnId, turnInput);
    },
  };
  return { service, finalizeCalls: () => calls };
}

export function textResponse(text: string): LlmResponse {
  return {
    content: [{ type: 'text', text }],
    finishReason: 'stop',
    providerFinishReason: 'end_turn',
    model: 'test',
    usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  };
}

/**
 * The turn's model: answers with `reply(email)` for the first e-mail it
 * finds in its own request — i.e. the surrogate when the orchestrator masked
 * the prompt. `find` picks another value to echo instead. Every serialized
 * request is pushed to `requests` before `reply` runs.
 */
export function echoingProvider(
  requests: string[] = [],
  reply: (email: string) => string = (email) => `Notiert, ich schreibe an ${email} heute`,
  find: RegExp = ANY_EMAIL,
): LlmProvider {
  const answerFor = (req: LlmRequest): string => {
    const serialized = JSON.stringify(req);
    requests.push(serialized);
    return reply(find.exec(serialized)?.[0] ?? 'niemanden');
  };
  const provider = {
    id: 'anthropic',
    capabilities: providerCapabilities,
    complete: async (req: LlmRequest): Promise<LlmResponse> => textResponse(answerFor(req)),
    stream: (req: LlmRequest): AsyncIterable<LlmStreamEvent> => {
      const text = answerFor(req);
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'text_delta', text } as LlmStreamEvent;
          yield { type: 'final', response: textResponse(text) } as LlmStreamEvent;
        },
      };
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  };
  return provider as unknown as LlmProvider;
}

type OrchestratorOptions = ConstructorParameters<typeof Orchestrator>[0];

const sessionLogger = {
  log: async (): Promise<{ turnExternalId: string }> => ({ turnExternalId: 'turn:s:t1' }),
} as unknown as OrchestratorOptions['sessionLogger'];

export function buildOrch(opts: {
  readonly service: PrivacyGuardService;
  readonly provider: LlmProvider;
  readonly recorded?: TurnReceiptRecordInput[];
  readonly domainTools?: OrchestratorOptions['domainTools'];
}): Orchestrator {
  return new Orchestrator({
    provider: opts.provider,
    model: 'test-model',
    maxTokens: 1024,
    maxToolIterations: 3,
    domainTools: opts.domainTools ?? [],
    nativeToolRegistry: new NativeToolRegistry(),
    sessionLogger,
    privacyGuard: () => opts.service,
    turnReceiptStore: () => ({
      record: async (entry: TurnReceiptRecordInput) => {
        opts.recorded?.push(entry);
      },
    }),
  });
}

export async function drain(
  stream: AsyncGenerator<ChatStreamEvent>,
): Promise<ChatStreamEvent[]> {
  const events: ChatStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

export function doneOf(
  events: readonly ChatStreamEvent[],
): Extract<ChatStreamEvent, { type: 'done' }> | undefined {
  return events.find((e) => e.type === 'done') as
    | Extract<ChatStreamEvent, { type: 'done' }>
    | undefined;
}
