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
      createdBy: null,
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
    const created = await store.create({ kind: 'hr_report', input: { month: '2026-09' }, createdBy: null });
    assert.equal(await handle.resumeOne(), true);
    assert.equal(seen[0]?.context, undefined);
    const row = await store.get(created.id);
    assert.equal(row?.status, 'failed');
  });

  it('splitTaskContext ignores a malformed stored context', () => {
    assert.deepEqual(splitTaskContext({ a: 1, __omadia_execution_context: { kind: 3 } }), {
      input: { a: 1 },
      context: undefined,
    });
    assert.deepEqual(splitTaskContext('plain'), { input: 'plain', context: undefined });
  });
});
