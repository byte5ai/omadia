// A scripted model at the provider seam: records every request the
// orchestrator sends and answers from a queue (text, or one tool call).

import type { LlmProvider, LlmRequest, LlmResponse } from '@omadia/llm-provider';

export type ModelStep =
  | { readonly text: string }
  | { readonly tool: string; readonly input?: unknown };

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

export function scriptedModel(): ScriptedModel {
  const requests: LlmRequest[] = [];
  const queue: ModelStep[] = [];
  let callId = 0;
  const next = (request: LlmRequest): LlmResponse => {
    requests.push(request);
    const step = queue.shift();
    if (!step) throw new Error(`scripted model: no answer scripted for request ${String(requests.length)}`);
    callId += 1;
    const usage = { inputTokens: 1, outputTokens: 1 };
    return 'text' in step
      ? { content: [{ type: 'text', text: step.text }], finishReason: 'stop', model: 'm', usage }
      : {
          content: [{ type: 'tool_call', id: `call-${String(callId)}`, name: step.tool, input: step.input ?? {} }],
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
    complete: (request: LlmRequest): Promise<LlmResponse> => Promise.resolve(next(request)),
    stream: (): never => {
      throw new Error('scripted model: stream() is not scripted');
    },
  } as unknown as LlmProvider;
  return { provider, requests, script: (...steps) => void queue.push(...steps) };
}
