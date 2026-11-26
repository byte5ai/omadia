/**
 * #1769 — a turn that calls `v4_render_answer` twice shows BOTH renders, in
 * call order, driven through the REAL `Orchestrator` with the REAL
 * privacy-guard service — on the buffered (`runTurn`) and the streaming
 * (`chatStream`) path. Before, the second render overwrote the first while
 * the model was told each one was shown.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { ChatStreamEvent } from '@omadia/channel-sdk';
import type {
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStreamEvent,
} from '@omadia/llm-provider';
import type { PrivacyGuardService } from '@omadia/plugin-api';
import { NativeToolRegistry, Orchestrator, today, turnContext } from '@omadia/orchestrator';
import { createPrivacyGuardService } from '@omadia/plugin-privacy-guard/dist/index.js';

const usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } as const;

const DIAGRAM_A = [{ title: 'A nach B', format: 'mermaid' }];
const DIAGRAM_B = [{ title: 'X nach Y', format: 'graphviz' }];

function toolCall(id: string, name: string, input: unknown): LlmResponse {
  return {
    content: [{ type: 'tool_call', id, name, input }],
    finishReason: 'tool_calls',
    providerFinishReason: 'tool_use',
    model: 'test',
    usage,
  } as unknown as LlmResponse;
}

function text(t: string): LlmResponse {
  return {
    content: [{ type: 'text', text: t }],
    finishReason: 'stop',
    providerFinishReason: 'end_turn',
    model: 'test',
    usage,
  } as unknown as LlmResponse;
}

function lastDatasetId(messages: unknown): string {
  const ids = JSON.stringify(messages).match(/ds_[0-9a-f-]{36}/g) ?? [];
  const id = ids[ids.length - 1];
  assert.ok(id, 'the model was handed a datasetId');
  return id;
}

/** diagram_a → render (prose 1) → diagram_b → render (prose 2) → stop. */
function nextResponse(step: number, messages: unknown): LlmResponse {
  const render = (id: string, prose: string): LlmResponse =>
    toolCall(id, 'v4_render_answer', {
      datasetId: lastDatasetId(messages),
      columns: [{ field: 'title', label: 'Titel' }, { field: 'format', label: 'Format' }],
      format: 'table',
      prose,
    });
  switch (step) {
    case 1:
      return toolCall('use-1', 'diagram_a', {});
    case 2:
      return render('use-2', 'Diagramm 1: A → B als Mermaid.');
    case 3:
      return toolCall('use-3', 'diagram_b', {});
    case 4:
      return render('use-4', 'Diagramm 2: X → Y als Graphviz.');
    default:
      return text('Fertig.');
  }
}

function streamOf(response: LlmResponse): LlmStreamEvent[] {
  const events: LlmStreamEvent[] = [];
  for (const block of response.content as Array<{ type: string; text?: string; input?: unknown }>) {
    if (block.type === 'text') events.push({ type: 'text_delta', text: block.text ?? '' });
    if (block.type === 'tool_call') {
      events.push(
        { type: 'tool_use_start' },
        { type: 'tool_input_delta', text: JSON.stringify(block.input) },
      );
    }
  }
  events.push({ type: 'final', response } as LlmStreamEvent);
  return events;
}

function scriptedProvider(): LlmProvider {
  let step = 0;
  const provider = {
    id: 'anthropic',
    capabilities: {
      tools: true,
      vision: true,
      streaming: true,
      promptCaching: true,
      forcedToolChoice: true,
      parallelToolCalls: true,
    },
    complete: (request: LlmRequest): Promise<LlmResponse> => {
      step += 1;
      return Promise.resolve(nextResponse(step, request.messages));
    },
    stream: (request: LlmRequest): AsyncIterable<LlmStreamEvent> => {
      step += 1;
      const events = streamOf(nextResponse(step, request.messages));
      return {
        async *[Symbol.asyncIterator]() {
          for (const ev of events) yield ev;
        },
      };
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  };
  return provider as unknown as LlmProvider;
}

function registry(): NativeToolRegistry {
  const r = new NativeToolRegistry();
  const register = (name: string, rows: unknown): void => {
    r.register(name, {
      handler: () => Promise.resolve(JSON.stringify(rows)),
      spec: {
        name,
        description: name,
        input_schema: { type: 'object' as const, properties: {}, required: [] },
      } as never,
    });
  };
  register('diagram_a', DIAGRAM_A);
  register('diagram_b', DIAGRAM_B);
  return r;
}

function buildOrchestrator(): Orchestrator {
  const service: PrivacyGuardService = createPrivacyGuardService();
  return new Orchestrator({
    provider: scriptedProvider(),
    model: 'test',
    maxTokens: 1024,
    maxToolIterations: 8,
    domainTools: [],
    nativeToolRegistry: registry(),
    privacyGuard: () => service,
  } as unknown as ConstructorParameters<typeof Orchestrator>[0]);
}

function assertBothRenders(answer: string): void {
  const first = answer.indexOf('Diagramm 1: A → B als Mermaid.');
  const second = answer.indexOf('Diagramm 2: X → Y als Graphviz.');
  assert.ok(first >= 0, `first render missing: ${answer}`);
  assert.ok(second > first, `second render missing or out of order: ${answer}`);
  assert.ok(answer.includes('A nach B'), answer);
  assert.ok(answer.includes('X nach Y'), answer);
}

describe('#1769 — every v4_render_answer of a turn reaches the user', () => {
  it('buffered path (runTurn)', async () => {
    const orchestrator = buildOrchestrator();
    const result = await turnContext.run(
      { turnId: '', turnDate: today(), canvasSentinelSink: () => undefined },
      () => orchestrator.runTurn({ userMessage: 'Zeichne zwei Diagramme', sessionScope: 's1769' }),
    );
    assertBothRenders(result.answer);
  });

  it('streaming path (chatStream)', async () => {
    const orchestrator = buildOrchestrator();
    const events: ChatStreamEvent[] = [];
    await turnContext.run(
      { turnId: '', turnDate: today(), canvasSentinelSink: () => undefined },
      async () => {
        for await (const ev of orchestrator.chatStream({
          userMessage: 'Zeichne zwei Diagramme',
          sessionScope: 's1769-stream',
        })) {
          events.push(ev);
        }
      },
    );
    const done = events.find((e) => e.type === 'done') as
      | (ChatStreamEvent & { answer: string })
      | undefined;
    assert.ok(done, `no done event: ${events.map((e) => e.type).join(',')}`);
    assertBothRenders(done.answer);
  });
});
