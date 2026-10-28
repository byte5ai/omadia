/**
 * Orchestrator turn output (#1500, #1502), pinned on BOTH loops (buffered
 * `runTurn` — Teams — and streaming `chatStream` — web chat):
 *
 *   - #1500: text the model writes next to a data-gathering tool call before
 *     any data arrived ("I'll check my memory directory first.") is preamble,
 *     not answer. Text written once data arrived is joined as before; when no
 *     later text comes, the earlier text is delivered.
 *   - #1502: `onAfterToolCall` reports `toolFailed` for a sub-agent whose
 *     every inner call failed (its result is prose, not `Error:`), and
 *     `toolIsBookkeeping` for the turn's own tools.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { LlmProvider, LlmResponse, LlmStreamEvent } from '@omadia/llm-provider';
import {
  NativeToolRegistry,
  AnswerTextAccumulator,
  Orchestrator,
  type DomainTool,
  type TurnAnnotation,
  type TurnHookPayload,
  type TurnHookPoint,
} from '@omadia/orchestrator';
import {
  afterToolCallPayload,
  SubToolOutcomeTally,
} from '../../packages/harness-orchestrator/src/toolCallOutcome.js';

type Block =
  { type: 'text'; text: string } | { type: 'tool_call'; id: string; name: string; input: unknown };

function response(content: Block[], stopReason: 'tool_use' | 'end_turn'): LlmResponse {
  return {
    content,
    finishReason: stopReason === 'tool_use' ? 'tool_calls' : 'stop',
    providerFinishReason: stopReason,
    model: 'test',
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  } as LlmResponse;
}

function scriptedProvider(script: LlmResponse[]): LlmProvider {
  let i = 0;
  const next = (): LlmResponse => {
    const res = script[i++];
    if (!res) throw new Error(`no scripted response for call ${String(i)}`);
    return res;
  };
  return {
    id: 'anthropic',
    capabilities: {
      tools: true,
      vision: true,
      streaming: true,
      promptCaching: true,
      forcedToolChoice: true,
      parallelToolCalls: true,
    },
    complete: async (): Promise<LlmResponse> => next(),
    stream: (): AsyncIterable<LlmStreamEvent> => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'final', response: next() };
      },
    }),
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  } as unknown as LlmProvider;
}

const lookupSpec = {
  name: 'lookup',
  description: 'lookup for testing',
  input_schema: { type: 'object' as const, properties: {}, required: [] },
};

/** A sub-agent whose two inner calls both fail; it still answers in prose. */
const failingSubAgent: DomainTool = {
  name: 'query_confluence',
  domain: 'confluence',
  spec: {
    name: 'query_confluence',
    description: 'confluence sub-agent for testing',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  handle: async (_input, observer) => {
    for (const id of ['c1', 'c2']) {
      observer?.onSubToolUse?.({ id, name: 'confluence_search', input: {} });
      observer?.onSubToolResult?.({
        id,
        output: 'Error: confluence_upstream_403',
        durationMs: 1,
        isError: true,
      });
    }
    return 'I could not access the Confluence space.';
  },
};

function build(script: LlmResponse[], hookPayloads: TurnHookPayload[]): Orchestrator {
  const registry = new NativeToolRegistry();
  registry.register('lookup', {
    handler: async (): Promise<string> => 'found it',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    spec: lookupSpec as any,
  });
  return new Orchestrator({
    provider: scriptedProvider(script),
    model: 'test',
    maxTokens: 1024,
    maxToolIterations: 5,
    domainTools: [failingSubAgent],
    nativeToolRegistry: registry,
    turnHookRegistry: {
      run: async (
        point: TurnHookPoint,
        _ctx: unknown,
        payload: TurnHookPayload,
      ): Promise<TurnAnnotation[]> => {
        if (point === 'onAfterToolCall') hookPayloads.push(payload);
        return [];
      },
    },
  });
}

async function bufferedAnswer(
  script: LlmResponse[],
  hooks: TurnHookPayload[] = [],
): Promise<string> {
  const result = await build(script, hooks).runTurn({ userMessage: 'Wie ist der Stand?' });
  return result.answer;
}

async function streamedAnswer(
  script: LlmResponse[],
  hooks: TurnHookPayload[] = [],
): Promise<string> {
  let answer: string | undefined;
  for await (const ev of build(script, hooks).chatStream({ userMessage: 'Wie ist der Stand?' })) {
    if (ev.type === 'done') answer = ev.answer;
  }
  assert.ok(answer !== undefined, 'stream ended without a done event');
  return answer;
}

const PREAMBLE = "I'll check my memory directory first.";
const ANSWER = 'Der Login bei Odoo ist fehlgeschlagen.';

describe('#1500 — preamble before a tool call stays out of the answer', () => {
  for (const [label, run] of [
    ['buffered (runTurn)', bufferedAnswer],
    ['streaming (chatStream)', streamedAnswer],
  ] as const) {
    it(`${label}: drops the text written next to an earlier tool call`, async () => {
      const answer = await run([
        response(
          [
            { type: 'text', text: PREAMBLE },
            { type: 'tool_call', id: 't1', name: 'lookup', input: {} },
          ],
          'tool_use',
        ),
        response([{ type: 'text', text: ANSWER }], 'end_turn'),
      ]);
      assert.ok(answer.startsWith(ANSWER), answer);
      assert.equal(answer.includes(PREAMBLE), false, answer);
    });

    it(`${label}: keeps the answer written next to the last tool call when the final message is empty`, async () => {
      const answer = await run([
        response(
          [
            { type: 'text', text: ANSWER },
            { type: 'tool_call', id: 't1', name: 'lookup', input: {} },
          ],
          'tool_use',
        ),
        response([], 'end_turn'),
      ]);
      assert.ok(answer.startsWith(ANSWER), answer);
    });

    it(`${label}: keeps an answer written after the data arrived, plus a closing line`, async () => {
      const answer = await run([
        response([{ type: 'tool_call', id: 't1', name: 'lookup', input: {} }], 'tool_use'),
        response(
          [
            { type: 'text', text: ANSWER },
            { type: 'tool_call', id: 't2', name: 'lookup', input: {} },
          ],
          'tool_use',
        ),
        response([{ type: 'text', text: 'Die Datei ist angehängt.' }], 'end_turn'),
      ]);
      assert.ok(answer.startsWith(ANSWER), answer);
      assert.ok(answer.includes('Die Datei ist angehängt.'), answer);
    });
  }

  describe('AnswerTextAccumulator', () => {
    it('drops preamble before memory and before a work tool once data-backed text follows', () => {
      const acc = new AnswerTextAccumulator();
      acc.addIteration([PREAMBLE], ['memory']);
      acc.addIteration(['Ich frage Odoo ab.'], ['query_odoo_hr']);
      acc.addIteration([ANSWER], []);
      assert.deepEqual(acc.parts(), [ANSWER]);
    });

    it('never treats text next to an answer-attached tool as preamble', () => {
      const acc = new AnswerTextAccumulator();
      acc.addIteration([ANSWER], ['suggest_follow_ups']);
      acc.addIteration(['Viel Erfolg!'], []);
      assert.deepEqual(acc.parts(), [ANSWER, 'Viel Erfolg!']);
    });

    it('delivers the provisional text when nothing follows it', () => {
      const acc = new AnswerTextAccumulator();
      acc.addIteration(['Welche Firma meinst du?'], ['query_odoo_hr']);
      assert.deepEqual(acc.parts(), ['Welche Firma meinst du?']);
      acc.reset();
      assert.deepEqual(acc.parts(), []);
    });
  });

  it('asks the model not to announce tool calls', async () => {
    let system = '';
    const provider = scriptedProvider([response([{ type: 'text', text: ANSWER }], 'end_turn')]);
    const complete = provider.complete.bind(provider);
    provider.complete = async (req) => {
      system = JSON.stringify(req.system);
      return complete(req);
    };
    await new Orchestrator({
      provider,
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 3,
      domainTools: [],
      nativeToolRegistry: new NativeToolRegistry(),
    }).runTurn({ userMessage: 'Hallo' });
    assert.ok(system.includes('Kündige Tool-Aufrufe nicht mit Zwischentext an'), system);
  });
});

describe('#1502 — onAfterToolCall reports failure and bookkeeping', () => {
  const script = (): LlmResponse[] => [
    response(
      [
        { type: 'tool_call', id: 't1', name: 'lookup', input: {} },
        { type: 'tool_call', id: 't2', name: 'query_confluence', input: {} },
      ],
      'tool_use',
    ),
    response([{ type: 'text', text: ANSWER }], 'end_turn'),
  ];

  for (const [label, run] of [
    ['buffered (runTurn)', bufferedAnswer],
    ['streaming (chatStream)', streamedAnswer],
  ] as const) {
    it(`${label}: a sub-agent with only failed inner calls is a failed call`, async () => {
      const hooks: TurnHookPayload[] = [];
      await run(script(), hooks);
      const byName = new Map(hooks.map((p) => [p.toolName, p]));
      assert.equal(byName.get('lookup')?.toolFailed, false);
      assert.equal(byName.get('lookup')?.toolIsBookkeeping, false);
      assert.equal(byName.get('query_confluence')?.toolFailed, true);
      assert.equal(
        byName.get('query_confluence')?.toolResult,
        'I could not access the Confluence space.',
      );
    });
  }

  it('flags the turn-serving tools as bookkeeping', () => {
    for (const name of ['memory', 'v4_render_answer', 'suggest_follow_ups', 'ask_user_choice']) {
      const p = afterToolCallPayload({
        toolName: name,
        toolResult: 'x',
        isError: false,
        innerCallsAllFailed: false,
      });
      assert.equal(p.toolIsBookkeeping, true, name);
    }
    const work = afterToolCallPayload({
      toolName: 'query_dataset',
      toolResult: 'x',
      isError: true,
      innerCallsAllFailed: false,
    });
    assert.equal(work.toolIsBookkeeping, false);
    assert.equal(work.toolFailed, true);
  });

  it('SubToolOutcomeTally.observe forwards every event to the inner observer', () => {
    const seen: string[] = [];
    const tally = new SubToolOutcomeTally();
    const observer = tally.observe('p', {
      onIteration: () => seen.push('iteration'),
      onSubToolUse: () => seen.push('use'),
      onSubToolResult: () => seen.push('result'),
    });
    observer.onIteration?.({ iteration: 1 });
    observer.onSubToolUse?.({ id: 'c', name: 'x', input: {} });
    observer.onSubToolResult?.({ id: 'c', output: 'Error: x', durationMs: 1, isError: true });
    assert.deepEqual(seen, ['iteration', 'use', 'result']);
    assert.equal(tally.allFailed('p'), true);
  });

  it('SubToolOutcomeTally: one success among failures is not a failed call', () => {
    const tally = new SubToolOutcomeTally();
    tally.record('p', true);
    tally.record('p', false);
    assert.equal(tally.allFailed('p'), false);
    assert.equal(tally.allFailed('never-called'), false);
  });
});
