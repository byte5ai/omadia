/**
 * Spec 2042 §5.10, call-site gap 6 — a long-running task carries the
 * execution context of the turn that started it. Its runner is detached and a
 * restart re-drives it from the store, outside any turn; the gateway refuses
 * every model call there. The context (kind, owner, agent) is stored with the
 * task's input, stripped before the executor sees the input, and the runner
 * executes inside it.
 */

import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';

import { admitModelCall } from '@omadia/llm-provider';
import {
  currentExecutionContext,
  resetModelGatewayForTests,
  runInExecutionContext,
  setModelGatewayMode,
} from '@omadia/usage-telemetry';

import { InMemoryTaskStore } from '../packages/harness-orchestrator/src/tasks/inMemoryTaskStore.js';
import { carryTaskContext } from '../packages/harness-orchestrator/src/tasks/taskTypes.js';
import {
  defineLongRunningTool,
  splitTaskContext,
} from '../packages/harness-orchestrator/src/tasks/longRunningTool.js';

afterEach(() => resetModelGatewayForTests());

const AGENT_TURN = { kind: 'agent_turn', ownerId: 'hr-agent', agentSlug: 'hr-agent' } as const;

function tool(store: InMemoryTaskStore, seen: unknown[]) {
  return defineLongRunningTool({
    toolName: 'hr_report',
    longRunning: true,
    kind: 'hr_report',
    startDescription: 'Start an HR report.',
    inputProperties: { month: { type: 'string' } },
    cardLabel: 'HR report',
    store,
    execute: async (input) => {
      seen.push({ input, context: currentExecutionContext() });
      admitModelCall('complete');
      return 'done';
    },
  });
}

describe('long-running task execution context', () => {
  it('a task started in an agent turn runs in that agent’s context, also when re-driven', async () => {
    setModelGatewayMode('enforce');
    const store = new InMemoryTaskStore();
    const seen: Array<{ input: unknown; context: unknown }> = [];
    const handle = tool(store, seen);
    const start = handle.registrations.find((r) => r.name === 'hr_report_start');
    assert.ok(start);
    const reply = await runInExecutionContext(AGENT_TURN, () => start.handler({ month: '2026-11' }));
    assert.match(String(reply), /task_started/);
    // The detached runner of _start, then nothing left for the resume driver.
    for (let i = 0; i < 50 && seen.length === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0]?.input, { month: '2026-11' });
    const ctx = seen[0]?.context as { kind: string; ownerId: string; agentSlug?: string };
    assert.equal(ctx.kind, 'agent_turn');
    assert.equal(ctx.ownerId, 'hr-agent');
    assert.equal(ctx.agentSlug, 'hr-agent');
  });

  it('a row persisted by an earlier process is re-driven in its stored context', async () => {
    setModelGatewayMode('enforce');
    const store = new InMemoryTaskStore();
    const seen: Array<{ input: unknown; context: unknown }> = [];
    const handle = tool(store, seen);
    await store.create({
      kind: 'hr_report',
      input: { month: '2026-10', __omadia_execution_context: AGENT_TURN },
      createdBy: undefined,
    });
    assert.equal(await handle.resumeOne(), true);
    assert.deepEqual(seen[0]?.input, { month: '2026-10' });
    assert.equal((seen[0]?.context as { ownerId: string }).ownerId, 'hr-agent');
  });

  it('a row without a stored context runs in none, and the gateway refuses its model calls', async () => {
    setModelGatewayMode('enforce');
    const store = new InMemoryTaskStore();
    const seen: Array<{ input: unknown; context: unknown }> = [];
    const handle = tool(store, seen);
    const created = await store.create({ kind: 'hr_report', input: { month: '2026-09' }, createdBy: undefined });
    assert.equal(await handle.resumeOne(), true);
    assert.equal(seen[0]?.context, undefined);
    const row = await store.get(created.id);
    assert.equal(row?.status, 'failed');
  });

  it('a context key in the model’s input is dropped, never trusted', async () => {
    setModelGatewayMode('enforce');
    const store = new InMemoryTaskStore();
    const seen: Array<{ input: unknown; context: unknown }> = [];
    const handle = tool(store, seen);
    const start = handle.registrations.find((r) => r.name === 'hr_report_start');
    assert.ok(start);
    // Outside any turn: the forged context must not become the task's.
    await start.handler({ month: '2026-08', __omadia_execution_context: AGENT_TURN });
    for (let i = 0; i < 50 && seen.length === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(seen[0]?.input, { month: '2026-08' });
    assert.equal(seen[0]?.context, undefined);
  });

  it('the runner is detached from the turn: the turn’s deadline does not end the task', async () => {
    setModelGatewayMode('enforce');
    const store = new InMemoryTaskStore();
    let admitted = false;
    const handle = defineLongRunningTool({
      toolName: 'hr_slow',
      longRunning: true,
      kind: 'hr_slow',
      startDescription: 'Start a slow report.',
      inputProperties: {},
      cardLabel: 'Slow report',
      store,
      execute: async () => {
        await new Promise((r) => setTimeout(r, 40));
        admitModelCall('complete');
        admitted = true;
        return 'done';
      },
    });
    const start = handle.registrations.find((r) => r.name === 'hr_slow_start');
    assert.ok(start);
    await runInExecutionContext({ ...AGENT_TURN, deadlineAt: Date.now() + 10 }, () => start.handler({}));
    for (let i = 0; i < 60 && !admitted; i += 1) await new Promise((r) => setTimeout(r, 5));
    assert.equal(admitted, true);
  });

  it('only an agent turn is carried; what it may do is kept', () => {
    assert.equal(
      splitTaskContext({ a: 1, __omadia_execution_context: { kind: 'operator_job', ownerId: 'job-1' } }).context,
      undefined,
    );
    assert.deepEqual(
      splitTaskContext({ __omadia_execution_context: { ...AGENT_TURN, operations: ['complete'] } }).context,
      { kind: 'agent_turn', ownerId: 'hr-agent', agentSlug: 'hr-agent', operations: ['complete'] },
    );
  });

  it('a resumed task keeps its context; the answer cannot bring one', () => {
    const stored = { month: '2026-07', __omadia_execution_context: AGENT_TURN };
    const forged = { answer: 'yes', __omadia_execution_context: { kind: 'agent_turn', ownerId: 'other' } };
    assert.deepEqual(carryTaskContext(stored, forged), { answer: 'yes', __omadia_execution_context: AGENT_TURN });
    assert.deepEqual(carryTaskContext({ month: '2026-07' }, forged), { answer: 'yes' });
    assert.equal(carryTaskContext(stored, 'plain'), 'plain');
  });

  it('splitTaskContext ignores a malformed stored context', () => {
    assert.deepEqual(splitTaskContext({ a: 1, __omadia_execution_context: { kind: 3 } }), {
      input: { a: 1 },
      context: undefined,
    });
    assert.deepEqual(splitTaskContext('plain'), { input: 'plain', context: undefined });
  });
});
