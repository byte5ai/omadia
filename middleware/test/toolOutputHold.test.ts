/**
 * #2342 / ADR-0316 — the client-facing hold of streamed tool outputs.
 * End to end: `test/discretion/answerEgress.test.ts`, `recalledPlansCli.test.ts`.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { ChatStreamEvent } from '@omadia/channel-sdk';

import { ToolOutputHold } from '../packages/harness-orchestrator/src/toolOutputHold.js';

const result = (id: string, output: string): ChatStreamEvent => ({ type: 'tool_result', id, output, durationMs: 1 });
const sub = (parentId: string, id: string, output: string): ChatStreamEvent => ({
  type: 'sub_tool_result',
  parentId,
  id,
  output,
  durationMs: 1,
  isError: false,
});

async function run(hold: ToolOutputHold, events: readonly ChatStreamEvent[]): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for (const event of events) out.push(...(await hold.pass(event)));
  return out;
}

describe('#2342 · ToolOutputHold', () => {
  it('streams a result the check passes live, its inner results just before it', async () => {
    const hold = new ToolOutputHold(async () => false);
    const out = await run(hold, [{ type: 'tool_use', id: 'p', name: 'ask', input: {} }, sub('p', 's1', 'inner'), result('p', 'outer')]);
    assert.deepEqual(out.map((e) => e.type), ['tool_use', 'sub_tool_result', 'tool_result']);
    assert.deepEqual(hold.settle(false), []);
  });

  it('holds inner results until their parent returns: a label the parent adds then still counts', async () => {
    let refuses = false;
    const hold = new ToolOutputHold(async () => refuses);
    // The inner result arrives while the check still passes …
    assert.deepEqual(await hold.pass(sub('p', 's1', 'unmasked-inner')), []);
    // … the parent's return labels the turn, and the check now refuses.
    refuses = true;
    assert.deepEqual(await hold.pass(result('p', 'outer')), []);
    const settled = hold.settle(true);
    assert.deepEqual(settled, [{ type: 'tool_result', id: 'p', output: '', durationMs: 1 }], 'one output-less row, no inner output');
  });

  it('hands held events back in order when the answer goes out after all', async () => {
    const hold = new ToolOutputHold(async () => true);
    await run(hold, [sub('p', 's1', 'inner'), result('p', 'outer')]);
    assert.deepEqual(hold.settle(false).map((e) => e.type), ['sub_tool_result', 'tool_result']);
  });

  it('drops inner results whose parent never returned', async () => {
    const hold = new ToolOutputHold(async () => false);
    await hold.pass(sub('gone', 's1', 'inner'));
    assert.deepEqual(hold.settle(false), []);
  });
});
