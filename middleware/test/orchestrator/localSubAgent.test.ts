import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type {
  ContentPart,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStreamEvent,
} from '@omadia/llm-provider';
import { LocalSubAgent } from '@omadia/orchestrator';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyContent = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMessage = any;

interface StubResponse {
  content: AnyContent[];
  stop_reason: 'tool_use' | 'end_turn' | 'stop_sequence' | 'max_tokens';
  model?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

interface StubClientCapture {
  calls: LlmRequest[];
  provider: LlmProvider;
}

const providerCapabilities = {
  tools: true,
  vision: true,
  streaming: true,
  promptCaching: true,
  forcedToolChoice: true,
  parallelToolCalls: true,
} as const;

function toLlmResponse(response: StubResponse): LlmResponse {
  const content: ContentPart[] = response.content.map((block) => {
    if (block.type === 'text') {
      return { type: 'text', text: block.text as string };
    }
    if (block.type === 'tool_use') {
      return {
        type: 'tool_call',
        id: block.id as string,
        name: block.name as string,
        input: block.input,
      };
    }
    throw new Error(`Unsupported stub block type: ${String(block.type)}`);
  });
  return {
    content,
    finishReason:
      response.stop_reason === 'tool_use'
        ? 'tool_calls'
        : response.stop_reason === 'max_tokens'
          ? 'max_tokens'
          : 'stop',
    providerFinishReason: response.stop_reason,
    model: response.model ?? 'claude-haiku',
    usage: {
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
      cacheReadTokens: response.usage?.cache_read_input_tokens ?? 0,
      cacheWriteTokens: response.usage?.cache_creation_input_tokens ?? 0,
    },
  };
}

function stubProvider(responses: StubResponse[]): StubClientCapture {
  const calls: LlmRequest[] = [];
  let idx = 0;
  const nextResponse = (): StubResponse => {
    if (idx >= responses.length) {
      throw new Error(
        `stubProvider: no scripted response for call ${String(idx + 1)} (only ${String(responses.length)} provided)`,
      );
    }
    const response = responses[idx]!;
    idx += 1;
    return response;
  };
  const provider = {
    id: 'anthropic',
    capabilities: providerCapabilities,
    complete: async (req: LlmRequest): Promise<LlmResponse> => {
      calls.push(req);
      return toLlmResponse(nextResponse());
    },
    stream: (req: LlmRequest): AsyncIterable<LlmStreamEvent> => {
      calls.push(req);
      return makeFakeStream(nextResponse());
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  } as unknown as LlmProvider;
  return { calls, provider };
}

/** The trailing content part of the newest message of a captured request. */
function lastUserPart(
  req: LlmRequest | undefined,
): { type: string; text?: string } | undefined {
  const last = req?.messages.at(-1);
  assert.equal(last?.role, 'user');
  const content = last?.content as AnyContent;
  return Array.isArray(content) ? content.at(-1) : undefined;
}

/** How often `pattern` occurs in a captured request's messages. */
function countMatches(req: LlmRequest | undefined, pattern: RegExp): number {
  return (JSON.stringify(req?.messages ?? []).match(pattern) ?? []).length;
}

function makeFakeStream(response: StubResponse): AsyncIterable<LlmStreamEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const block of response.content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          yield { type: 'text_delta', text: block.text };
          continue;
        }
        if (block.type === 'tool_use') {
          yield { type: 'tool_use_start' };
          yield {
            type: 'tool_input_delta',
            text: JSON.stringify(block.input),
          };
        }
      }
      yield { type: 'final', response: toLlmResponse(response) };
    },
  };
}

function toolUse(id: string, name: string, input: unknown): AnyContent {
  return { type: 'tool_use', id, name, input };
}

function textBlock(text: string): AnyContent {
  return { type: 'text', text };
}

const baseToolSpec = {
  name: 'patch_spec',
  description: 'apply a JSON patch to the agent spec',
  input_schema: {
    type: 'object' as const,
    properties: { patches: { type: 'array' } },
    required: ['patches'],
  },
};

describe('LocalSubAgent.ask', () => {
  it('returns immediately when the model emits text on the first iteration', async () => {
    const { provider, calls } = stubProvider([
      {
        content: [textBlock('all done, here is the answer')],
        stop_reason: 'end_turn',
      },
    ]);
    const agent = new LocalSubAgent({
      name: 'test',
      provider,
      model: 'claude-haiku',
      maxTokens: 1024,
      maxIterations: 5,
      systemPrompt: 'you are a test',
      tools: [
        {
          spec: baseToolSpec,
          handle: async () => 'should-not-be-called',
        },
      ],
    });
    const answer = await agent.ask('hi');
    assert.equal(answer, 'all done, here is the answer');
    assert.equal(calls.length, 1);
    // Happy-path call must NOT carry tool_choice:none
    assert.equal(calls[0]?.toolChoice, undefined);
  });

  it('forces tool_choice:none after 3 identical-and-failing tool calls', async () => {
    // Iterations 0..2 (= 3 tool_use returns with the SAME input that the
    // dispatch errors on) → on iteration 3 the agent must request
    // tool_choice:none and the model can finalize. Detection threshold
    // is 3, so termination triggers at iteration 3 (the 4th call).
    const dupInput = { patches: [{ op: 'add', path: '/x', value: 1 }] };
    const { provider, calls } = stubProvider([
      { content: [toolUse('t1', 'patch_spec', dupInput)], stop_reason: 'tool_use' },
      { content: [toolUse('t2', 'patch_spec', dupInput)], stop_reason: 'tool_use' },
      { content: [toolUse('t3', 'patch_spec', dupInput)], stop_reason: 'tool_use' },
      {
        content: [textBlock('I keep getting the same error — bailing out')],
        stop_reason: 'end_turn',
      },
    ]);
    const agent = new LocalSubAgent({
      name: 'test',
      provider,
      model: 'claude-haiku',
      maxTokens: 1024,
      maxIterations: 20,
      systemPrompt: 'you are a test',
      tools: [
        {
          spec: baseToolSpec,
          handle: async () => 'Error: schema rejected',
        },
      ],
    });
    const answer = await agent.ask('do the thing');
    assert.equal(answer, 'I keep getting the same error — bailing out');
    assert.equal(calls.length, 4);
    // First 3 calls: no tool_choice constraint.
    for (let i = 0; i < 3; i++) {
      assert.equal(
        calls[i]?.tool_choice,
        calls[i]?.toolChoice,
        undefined,
        `iteration ${String(i)} should not carry tool_choice`,
      );
    }
    // 4th call: forced text-only.
    assert.deepEqual(calls[3]?.toolChoice, { type: 'none' });
    // #1212 — the repeat-failure note (in German — the agent operates in
    // German) rides as a trailing text block on the newest user turn, after
    // its tool_result blocks. The system prompt stays unchanged for the run,
    // so the prefix (cache, thinking-block binding) stays valid.
    const lastPart = lastUserPart(calls[3]);
    assert.equal(lastPart?.type, 'text');
    assert.match(lastPart?.text ?? '', /Tool-Call.*identischem Input.*mehrfach/i);
    assert.doesNotMatch(lastPart?.text ?? '', /IMPORTANT|NICHT/);
    assert.equal(countMatches(calls[3], /identischem Input/g), 1);
    assert.deepEqual(calls[3]?.system, calls[0]?.system);
  });

  it('adds each wrap-up note once when a provider ignores tool_choice:none (#1212)', async () => {
    // A provider that keeps returning tool_use under `tool_choice: none`
    // keeps the loop running after the repeat-failure iteration. The note
    // must not stack onto every following tool_result turn.
    const dupInput = { patches: [{ op: 'add', path: '/x', value: 1 }] };
    const responses = Array.from({ length: 5 }, (_, i) => ({
      content: [toolUse(`t${String(i)}`, 'patch_spec', dupInput)],
      stop_reason: 'tool_use' as const,
    }));
    const { provider, calls } = stubProvider([
      ...responses,
      { content: [textBlock('giving up')], stop_reason: 'end_turn' },
    ]);
    const agent = new LocalSubAgent({
      name: 'test',
      provider,
      model: 'claude-haiku',
      maxTokens: 1024,
      maxIterations: 6,
      systemPrompt: 'you are a test',
      tools: [{ spec: baseToolSpec, handle: async () => 'Error: schema rejected' }],
    });
    assert.equal(await agent.ask('do the thing'), 'giving up');
    const final = calls.at(-1);
    assert.equal(countMatches(final, /identischem Input/g), 1);
    assert.equal(countMatches(final, /letzte Iteration/g), 1);
    assert.deepEqual(final?.system, calls[0]?.system);
  });

  it('puts the last-iteration note into the newest user turn, not the system prompt (#1212)', async () => {
    const { provider, calls } = stubProvider([
      { content: [toolUse('t1', 'patch_spec', { patches: [] })], stop_reason: 'tool_use' },
      { content: [textBlock('partial answer')], stop_reason: 'end_turn' },
    ]);
    const agent = new LocalSubAgent({
      name: 'test',
      provider,
      model: 'claude-haiku',
      maxTokens: 1024,
      maxIterations: 2,
      systemPrompt: 'you are a test',
      tools: [{ spec: baseToolSpec, handle: async () => 'ok' }],
    });
    assert.equal(await agent.ask('do the thing'), 'partial answer');
    assert.deepEqual(calls[1]?.toolChoice, { type: 'none' });
    const lastPart = lastUserPart(calls[1]);
    assert.equal(lastPart?.type, 'text');
    assert.match(lastPart?.text ?? '', /letzte Iteration/);
    assert.deepEqual(calls[1]?.system, calls[0]?.system);
    // Earlier turns are untouched: the first call carried no note.
    assert.doesNotMatch(JSON.stringify(calls[0]?.messages), /letzte Iteration/);
  });

  it('appends the last-iteration note to a plain-string question (#1212)', async () => {
    const { provider, calls } = stubProvider([
      { content: [textBlock('only answer')], stop_reason: 'end_turn' },
    ]);
    const agent = new LocalSubAgent({
      name: 'test',
      provider,
      model: 'claude-haiku',
      maxTokens: 1024,
      maxIterations: 1,
      systemPrompt: 'you are a test',
      tools: [{ spec: baseToolSpec, handle: async () => 'ok' }],
    });
    assert.equal(await agent.ask('the question'), 'only answer');
    const content = calls[0]?.messages.at(-1)?.content as AnyContent[];
    assert.equal(content[0]?.text, 'the question');
    assert.match(content.at(-1)?.text ?? '', /letzte Iteration/);
  });

  it('does NOT trigger early termination when inputs vary across calls', async () => {
    // 3 tool_uses that all error, BUT each with a different input. The
    // agent might be exploring — we shouldn't shut it down.
    const { provider, calls } = stubProvider([
      { content: [toolUse('t1', 'patch_spec', { patches: [{ op: 'a', path: '/x' }] })], stop_reason: 'tool_use' },
      { content: [toolUse('t2', 'patch_spec', { patches: [{ op: 'a', path: '/y' }] })], stop_reason: 'tool_use' },
      { content: [toolUse('t3', 'patch_spec', { patches: [{ op: 'a', path: '/z' }] })], stop_reason: 'tool_use' },
      { content: [textBlock('still exploring, here is what I have')], stop_reason: 'end_turn' },
    ]);
    const agent = new LocalSubAgent({
      name: 'test',
      provider,
      model: 'claude-haiku',
      maxTokens: 1024,
      maxIterations: 20,
      systemPrompt: 'you are a test',
      tools: [
        { spec: baseToolSpec, handle: async () => 'Error: invalid' },
      ],
    });
    const answer = await agent.ask('explore');
    assert.equal(answer, 'still exploring, here is what I have');
    // 4th call is the one we'd inspect for tool_choice — it must be
    // unconstrained because the 3 prior calls had DIFFERENT inputs.
    assert.equal(calls[3]?.toolChoice, undefined);
  });

  it('does NOT trigger when an intermediate call succeeds', async () => {
    // Two failing calls, then ONE success, then another failing call.
    // The tail of 3 (fail, success, fail) is not all-error, so the
    // termination guard should NOT fire on iteration 4.
    const failInput = { patches: [{ op: 'a', path: '/x' }] };
    let failCount = 0;
    const { provider, calls } = stubProvider([
      { content: [toolUse('t1', 'patch_spec', failInput)], stop_reason: 'tool_use' },
      { content: [toolUse('t2', 'patch_spec', failInput)], stop_reason: 'tool_use' },
      { content: [toolUse('t3', 'patch_spec', failInput)], stop_reason: 'tool_use' },
      { content: [toolUse('t4', 'patch_spec', failInput)], stop_reason: 'tool_use' },
      { content: [textBlock('handled it, here is the result')], stop_reason: 'end_turn' },
    ]);
    const agent = new LocalSubAgent({
      name: 'test',
      provider,
      model: 'claude-haiku',
      maxTokens: 1024,
      maxIterations: 20,
      systemPrompt: 'you are a test',
      tools: [
        {
          spec: baseToolSpec,
          handle: async () => {
            failCount += 1;
            // Fail twice, then succeed, then fail (the success is at
            // call #3 — index 2 — so the streak is broken in the middle).
            if (failCount === 3) return 'patch applied successfully';
            return 'Error: schema rejected';
          },
        },
      ],
    });
    const answer = await agent.ask('try it');
    assert.equal(answer, 'handled it, here is the result');
    // 5th call (index 4) is the text-only final emitted naturally; the
    // 4th call (index 3) — where termination would have struck if the
    // streak had been unbroken — must remain unconstrained.
    assert.equal(calls[3]?.toolChoice, undefined);
  });

  it('uses canonical key-order so reordered inputs are recognised as identical', async () => {
    // Same logical payload, different JSON key order. The detector
    // should see all three calls as identical and trigger.
    const { provider, calls } = stubProvider([
      { content: [toolUse('t1', 'patch_spec', { a: 1, b: 2 })], stop_reason: 'tool_use' },
      { content: [toolUse('t2', 'patch_spec', { b: 2, a: 1 })], stop_reason: 'tool_use' },
      { content: [toolUse('t3', 'patch_spec', { a: 1, b: 2 })], stop_reason: 'tool_use' },
      { content: [textBlock('giving up')], stop_reason: 'end_turn' },
    ]);
    const agent = new LocalSubAgent({
      name: 'test',
      provider,
      model: 'claude-haiku',
      maxTokens: 1024,
      maxIterations: 20,
      systemPrompt: 'you are a test',
      tools: [
        { spec: baseToolSpec, handle: async () => 'Error: nope' },
      ],
    });
    await agent.ask('try');
    assert.deepEqual(calls[3]?.toolChoice, { type: 'none' });
  });
});

// ---------------------------------------------------------------------------
// OB-31: per-turn tool obligation (`expectedTurnToolUse` + escalation).
// ---------------------------------------------------------------------------

const fillSlotSpec = {
  name: 'fill_slot',
  description: 'fill a template slot with a code source',
  input_schema: {
    type: 'object' as const,
    properties: {
      slotKey: { type: 'string' },
      source: { type: 'string' },
    },
    required: ['slotKey', 'source'],
  },
};

describe('LocalSubAgent.ask — OB-31 expectedTurnToolUse escalation', () => {
  it('does not escalate when the next iteration is the last, text-only one (#1212)', async () => {
    // An escalation into the last iteration could not force the tool (it
    // runs with tool_choice:none) and would put the "call it now" reminder
    // next to the last-iteration note. The turn ends instead.
    const { provider, calls } = stubProvider([
      { content: [textBlock('kein Slot nötig')], stop_reason: 'end_turn' },
    ]);
    const agent = new LocalSubAgent({
      name: 'test',
      provider,
      model: 'claude-haiku',
      maxTokens: 1024,
      maxIterations: 2,
      systemPrompt: 'you are a test',
      tools: [{ spec: fillSlotSpec, handle: async () => 'ok' }],
    });
    const answer = await agent.ask('baue', undefined, { expectedTurnToolUse: 'fill_slot' });
    assert.equal(answer, 'kein Slot nötig');
    assert.equal(calls.length, 1);
  });

  it('escalates with tool_choice when the model exits without ever calling the obligation tool', async () => {
    // Iter 0: model emits a build-announcement text + 0 tool_use blocks
    //         and stop_reason=end_turn. Without the OB-31 guard the loop
    //         would return that text immediately. With the guard the
    //         loop pushes a synthetic user reminder and re-iterates with
    //         tool_choice forcing fill_slot.
    // Iter 1: model finally calls fill_slot (because tool_choice forces).
    // Iter 2: model wraps up with text.
    const { provider, calls } = stubProvider([
      {
        content: [textBlock('Jetzt baue ich durch ohne Unterbrechung.')],
        stop_reason: 'end_turn',
      },
      {
        content: [
          toolUse('t1', 'fill_slot', { slotKey: 'a', source: 'export const x = 1;' }),
        ],
        stop_reason: 'tool_use',
      },
      { content: [textBlock('done')], stop_reason: 'end_turn' },
    ]);
    const agent = new LocalSubAgent({
      name: 'test',
      provider,
      model: 'claude-haiku',
      maxTokens: 1024,
      maxIterations: 20,
      systemPrompt: 'you are a test',
      tools: [{ spec: fillSlotSpec, handle: async () => 'ok' }],
    });
    const answer = await agent.ask('baue alle slots durch', undefined, {
      expectedTurnToolUse: 'fill_slot',
    });
    // The loop concatenates text from every iteration. The final answer
    // therefore contains both the (now-superseded) build-announcement from
    // iter 0 AND the closing text from iter 2 — what matters for OB-31 is
    // that fill_slot got called at all, which the call-count + tool_choice
    // assertions below verify.
    assert.match(answer, /Jetzt baue ich durch/);
    assert.match(answer, /done/);
    assert.equal(calls.length, 3);
    // Iter 0: no tool_choice (auto).
    assert.equal(calls[0]?.toolChoice, undefined);
    // Iter 1: forced fill_slot — this is the OB-31 escalation.
    assert.deepEqual(calls[1]?.toolChoice, { type: 'tool', name: 'fill_slot' });
    // Iter 2: tool_choice released back to auto (escalation was one-shot).
    assert.equal(calls[2]?.toolChoice, undefined);
    // The synthetic user reminder must be present in the messages array
    // sent on iter 1 so the model knows why it was poked.
    const iter1Messages = calls[1]?.messages as Array<{
      role: string;
      content: ContentPart[];
    }>;
    assert.ok(Array.isArray(iter1Messages));
    const reminderMsg = iter1Messages.find(
      (m) =>
        m.role === 'user' &&
        m.content.some(
          (part) => part.type === 'text' && part.text.includes('fill_slot'),
        ),
    );
    assert.ok(
      reminderMsg,
      'iter 1 messages must contain a synthetic user reminder mentioning fill_slot',
    );
  });

  it('does NOT escalate when the obligation tool was already called', async () => {
    // Happy build path: model calls fill_slot in iter 0, then exits with
    // text in iter 1. The obligation is fulfilled — no synthetic reminder,
    // no forced tool_choice on the exit iteration.
    const { provider, calls } = stubProvider([
      {
        content: [
          toolUse('t1', 'fill_slot', { slotKey: 'a', source: 'export const x = 1;' }),
        ],
        stop_reason: 'tool_use',
      },
      { content: [textBlock('all slots filled, done')], stop_reason: 'end_turn' },
    ]);
    const agent = new LocalSubAgent({
      name: 'test',
      provider,
      model: 'claude-haiku',
      maxTokens: 1024,
      maxIterations: 20,
      systemPrompt: 'you are a test',
      tools: [{ spec: fillSlotSpec, handle: async () => 'ok' }],
    });
    const answer = await agent.ask('baue alle slots', undefined, {
      expectedTurnToolUse: 'fill_slot',
    });
    assert.equal(answer, 'all slots filled, done');
    assert.equal(calls.length, 2);
    // Both iterations must remain unconstrained.
    assert.equal(calls[0]?.toolChoice, undefined);
    assert.equal(calls[1]?.toolChoice, undefined);
    // No synthetic reminder appended by the loop. Messages on iter 1 are
    // [user-question, assistant-iter0-content, tool_results]. No extra
    // user-string reminder.
    const iter1Messages = calls[1]?.messages as Array<{
      role: string;
      content: ContentPart[];
    }>;
    const reminders = iter1Messages.filter(
      (m) =>
        m.role === 'user' &&
        m.content.some(
          (part) =>
            part.type === 'text' &&
            part.text.includes('fill_slot') &&
            part.text.includes('Du hast den Turn beendet'),
        ),
    );
    assert.equal(reminders.length, 0);
  });

  it('honors the stop_reason after the escalation budget is spent', async () => {
    // Worst case: model refuses fill_slot even after the forced tool_choice
    // (in practice, tool_choice:tool makes this impossible, but we
    // simulate it for safety — the escalation budget defaults to 1, so
    // after one escalation the loop must accept the stop_reason and
    // return whatever text is on the table).
    const { provider, calls } = stubProvider([
      {
        content: [textBlock('ich werde gleich bauen')],
        stop_reason: 'end_turn',
      },
      // After the escalation, the (broken) model still emits text only.
      {
        content: [textBlock('immer noch nicht — bitte selbst bauen')],
        stop_reason: 'end_turn',
      },
    ]);
    const agent = new LocalSubAgent({
      name: 'test',
      provider,
      model: 'claude-haiku',
      maxTokens: 1024,
      maxIterations: 20,
      systemPrompt: 'you are a test',
      tools: [{ spec: fillSlotSpec, handle: async () => 'ok' }],
    });
    const answer = await agent.ask('baue alle slots', undefined, {
      expectedTurnToolUse: 'fill_slot',
      maxEscalations: 1,
    });
    // The text from BOTH iterations is concatenated, then returned.
    assert.match(answer, /immer noch nicht/);
    // Only ONE escalation iteration happened — no third call.
    assert.equal(calls.length, 2);
    // Iter 1 carried the forced tool_choice (the one-shot escalation).
    assert.deepEqual(calls[1]?.toolChoice, { type: 'tool', name: 'fill_slot' });
  });

  it('does NOT escalate when stop_reason is non-tool_use but content has tool_use blocks (max_tokens mid-call edge case)', async () => {
    // Anthropic edge case: stop_reason can be `max_tokens` (or `pause_turn`,
    // `stop_sequence`) WHILE response.content carries one or more tool_use
    // blocks — the model started a tool call but the API stopped
    // generation early. Pushing the OB-31 user-reminder right after this
    // assistant message would leave the tool_use unanswered and the next
    // request would fail with `messages.N: tool_use ids were found
    // without tool_result blocks immediately after`. The defensive
    // hasPendingToolUse check must keep the loop on the dispatch path
    // so tool_results land in messages.
    const { provider, calls } = stubProvider([
      // Iter 0: tool_use block but stop_reason='max_tokens' (the bug-trigger).
      {
        content: [
          textBlock('starte build'),
          toolUse('t-edge', 'fill_slot', { slotKey: 'a', source: 'export const x=1;' }),
        ],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        stop_reason: 'max_tokens' as any,
      },
      // Iter 1: model wraps up cleanly after tool_result is in messages.
      { content: [textBlock('done')], stop_reason: 'end_turn' },
    ]);
    const agent = new LocalSubAgent({
      name: 'test',
      provider,
      model: 'claude-haiku',
      maxTokens: 1024,
      maxIterations: 20,
      systemPrompt: 'you are a test',
      tools: [{ spec: fillSlotSpec, handle: async () => 'ok' }],
    });
    const answer = await agent.ask('baue alle slots', undefined, {
      expectedTurnToolUse: 'fill_slot',
    });
    assert.match(answer, /done/);
    assert.equal(calls.length, 2);
    // Critical assertion: the message that immediately follows iter 0's
    // assistant-with-tool_use must be a user-tool_result message, NOT a
    // synthetic OB-31 user reminder. Note: calls[1].messages is a live
    // reference to the loop's messages array, so by inspect-time it
    // already carries iter-1's appended assistant block — assert on
    // the specific index, not the array tail.
    //
    // Expected layout:
    //   [0] user (the question)
    //   [1] assistant ([text, tool_use])  ← iter-0 response
    //   [2] user (tool_result blocks)     ← MUST be tool_result, not reminder
    //   [3+] anything appended after iter 1 returned (out of scope here)
    const iter1Messages = calls[1]?.messages as Array<{
      role: string;
      content: unknown;
    }>;
    const followUp = iter1Messages[2];
    assert.equal(
      followUp?.role,
      'user',
      'message after iter 0 assistant-with-tool_use must be a user message',
    );
    assert.ok(
      Array.isArray(followUp?.content),
      'follow-up to a tool_use must carry tool_result blocks (array), not a string reminder',
    );
    const toolResults = (followUp?.content as Array<{ type: string }>).filter(
      (b) => b.type === 'tool_result',
    );
    assert.equal(toolResults.length, 1);
    // No escalation reminder anywhere in the message array.
    const reminderCount = iter1Messages.filter(
      (m) =>
        m.role === 'user' &&
        Array.isArray(m.content) &&
        m.content.some(
          (part) =>
            part.type === 'text' &&
            part.text.includes('Du hast den Turn beendet'),
        ),
    ).length;
    assert.equal(reminderCount, 0);
  });

  it('does NOT escalate into a text-only turn after a repeat-failure stop (found in #1300)', async () => {
    // Iter 0..2: the model calls a DIFFERENT tool (patch_spec) three times
    // with identical input and gets the same error each time → repeat-failure
    // detection withdraws the tools (tool_choice:none) from iter 3 on.
    // Iter 3: the model answers text-only. The obligation tool fill_slot was
    // never called, but escalating now would tell the model to call it while
    // every following request forbids tools — a contradictory, wasted
    // round-trip. The loop must return the answer instead (4 calls, not 5;
    // a 5th call would also exhaust the stub script and throw).
    const dupInput = { patches: [{ op: 'add', path: '/x', value: 1 }] };
    const { provider, calls } = stubProvider([
      { content: [toolUse('t1', 'patch_spec', dupInput)], stop_reason: 'tool_use' },
      { content: [toolUse('t2', 'patch_spec', dupInput)], stop_reason: 'tool_use' },
      { content: [toolUse('t3', 'patch_spec', dupInput)], stop_reason: 'tool_use' },
      { content: [textBlock('Ich komme nicht weiter — Schema-Fehler.')], stop_reason: 'end_turn' },
    ]);
    const agent = new LocalSubAgent({
      name: 'test',
      provider,
      model: 'claude-haiku',
      maxTokens: 1024,
      maxIterations: 20,
      systemPrompt: 'you are a test',
      tools: [
        { spec: baseToolSpec, handle: async () => 'Error: schema rejected' },
        { spec: fillSlotSpec, handle: async () => 'ok' },
      ],
    });
    const answer = await agent.ask('baue alle slots', undefined, {
      expectedTurnToolUse: 'fill_slot',
    });
    assert.equal(answer, 'Ich komme nicht weiter — Schema-Fehler.');
    assert.equal(calls.length, 4);
    assert.deepEqual(calls[3]?.toolChoice, { type: 'none' });
    // No request ever carried an escalation reminder naming the tool.
    for (const call of calls) {
      const msgs = call.messages as Array<{ role: string; content: ContentPart[] | string }>;
      const escalations = msgs.filter(
        (m) =>
          m.role === 'user' &&
          (typeof m.content === 'string'
            ? m.content.includes('Rufe `fill_slot` jetzt auf')
            : m.content.some(
                (part) =>
                  part.type === 'text' && part.text.includes('Rufe `fill_slot` jetzt auf'),
              )),
      );
      assert.equal(escalations.length, 0);
    }
  });

  it('does nothing special when expectedTurnToolUse is unset', async () => {
    // Spec-Phase scenario: BuilderAgent did NOT pass expectedTurnToolUse
    // because the user message was a question, not a build command.
    // Loop must behave identically to the legacy path.
    const { provider, calls } = stubProvider([
      { content: [textBlock('hier ist die antwort')], stop_reason: 'end_turn' },
    ]);
    const agent = new LocalSubAgent({
      name: 'test',
      provider,
      model: 'claude-haiku',
      maxTokens: 1024,
      maxIterations: 5,
      systemPrompt: 'you are a test',
      tools: [{ spec: fillSlotSpec, handle: async () => 'ok' }],
    });
    const answer = await agent.ask('was macht fill_slot eigentlich?');
    assert.equal(answer, 'hier ist die antwort');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.toolChoice, undefined);
  });
});
