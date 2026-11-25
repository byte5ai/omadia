// A scripted model at the provider seam: records every request the
// orchestrator sends and answers from a queue (text, or one tool call).

import { admitModelCall, type LlmProvider, type LlmRequest, type LlmResponse } from '@omadia/llm-provider';

export type ModelStep =
  | { readonly text: string }
  | { readonly tool: string; readonly input?: unknown }
  /** Several tool calls in one answer. */
  | { readonly tools: readonly { readonly tool: string; readonly input?: unknown }[] };

export interface ScriptedModel {
  readonly provider: LlmProvider;
  readonly requests: LlmRequest[];
  /** Queue the model's next answers, in order. */
  script(...steps: ModelStep[]): void;
}

export function systemText(request: LlmRequest): string {
  const system = request.system;
  if (system === undefined) return '';
  return typeof system === 'string' ? system : system.map((block) => block.text).join('\n\n');
}

/**
 * `respond`, when given, answers a request the queue has no step for, from
 * the request itself (a model that reacts to what its tools returned).
 */
export function scriptedModel(respond?: (request: LlmRequest) => ModelStep | undefined): ScriptedModel {
  const requests: LlmRequest[] = [];
  const queue: ModelStep[] = [];
  let callId = 0;
  const next = (request: LlmRequest): LlmResponse => {
    requests.push(request);
    const step = queue.shift() ?? respond?.(request);
    if (!step) throw new Error(`scripted model: no answer scripted for request ${String(requests.length)}`);
    const usage = { inputTokens: 1, outputTokens: 1 };
    if ('text' in step) {
      return { content: [{ type: 'text', text: step.text }], finishReason: 'stop', model: 'm', usage };
    }
    const calls = 'tools' in step ? step.tools : [step];
    return {
      content: calls.map((call) => {
        callId += 1;
        return { type: 'tool_call', id: `call-${String(callId)}`, name: call.tool, input: call.input ?? {} };
      }),
      finishReason: 'tool_calls',
      model: 'm',
      usage,
    };
  };
  const provider = {
    id: 'anthropic',
    capabilities: {
      tools: true,
      vision: false,
      streaming: true,
      promptCaching: false,
      forcedToolChoice: true,
      parallelToolCalls: false,
    },
    complete: (request: LlmRequest): Promise<LlmResponse> => {
      // What every provider does before it reaches its backend: a call the
      // turn's reservation does not cover is refused here. A no-op where no
      // host installed the gate.
      admitModelCall();
      return Promise.resolve(next(request));
    },
    // The streaming path gets the same answers, as a delta plus the final.
    stream: (request: LlmRequest) => {
      admitModelCall();
      const response = next(request);
      const text = response.content.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('');
      return {
        async *[Symbol.asyncIterator]() {
          if (text) yield { type: 'text_delta', text };
          yield { type: 'final', response };
        },
      };
    },
  } as unknown as LlmProvider;
  return { provider, requests, script: (...steps) => void queue.push(...steps) };
}
