import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  ManageRoutineTool,
  type ManageRoutineContext,
} from '../src/plugins/routines/manageRoutineTool.js';
import {
  RoutineNotFoundError,
  RoutineQuotaExceededError,
  UnknownChannelError,
  type RoutineRunner,
} from '../src/plugins/routines/routineRunner.js';
import {
  RoutineNameConflictError,
  type CreateRoutineInput,
  type Routine,
} from '../src/plugins/routines/routineStore.js';

/**
 * Tool tests focus on:
 *   - input-schema validation (zod surface)
 *   - action routing and required-field gating per action
 *   - error formatting (every domain error class becomes "Error: …")
 *   - happy-path payload shape (model-friendly JSON)
 *
 * The runner is stubbed — its behaviour is covered separately in
 * routineRunner.test.ts.
 */

const TENANT = 'tenant-A';
const USER = 'user-1';
const CONV_REF = { conversation: { id: 'conv-1' } };

const ctx: ManageRoutineContext = {
  tenant: TENANT,
  userId: USER,
  channel: 'teams',
  conversationRef: CONV_REF,
};

function fakeRoutine(overrides: Partial<Routine> = {}): Routine {
  const now = new Date('2026-05-06T10:00:00Z');
  return {
    id: 'routine-1',
    tenant: TENANT,
    userId: USER,
    name: 'demo',
    cron: '0 9 * * 1',
    prompt: 'morning ping',
    channel: 'teams',
    conversationRef: CONV_REF,
    status: 'active',
    timeoutMs: 600_000,
    createdAt: now,
    updatedAt: now,
    lastRunAt: null,
    lastRunStatus: null,
    lastRunError: null,
    ...overrides,
  };
}

interface RecordedCall {
  method: string;
  args: unknown[];
}

interface StubRunnerOptions {
  createImpl?: (input: CreateRoutineInput) => Promise<Routine>;
  listImpl?: (tenant: string, userId: string) => Promise<Routine[]>;
  pauseImpl?: (id: string) => Promise<Routine>;
  resumeImpl?: (id: string) => Promise<Routine>;
  deleteImpl?: (id: string) => Promise<boolean>;
}

function stubRunner(opts: StubRunnerOptions = {}): {
  runner: RoutineRunner;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const runner = {
    async createRoutine(input: CreateRoutineInput) {
      calls.push({ method: 'createRoutine', args: [input] });
      if (opts.createImpl) return opts.createImpl(input);
      return fakeRoutine({ name: input.name, cron: input.cron, prompt: input.prompt });
    },
    async listRoutines(tenant: string, userId: string) {
      calls.push({ method: 'listRoutines', args: [tenant, userId] });
      if (opts.listImpl) return opts.listImpl(tenant, userId);
      return [];
    },
    async pauseRoutine(id: string) {
      calls.push({ method: 'pauseRoutine', args: [id] });
      if (opts.pauseImpl) return opts.pauseImpl(id);
      return fakeRoutine({ id, status: 'paused' });
    },
    async resumeRoutine(id: string) {
      calls.push({ method: 'resumeRoutine', args: [id] });
      if (opts.resumeImpl) return opts.resumeImpl(id);
      return fakeRoutine({ id, status: 'active' });
    },
    async deleteRoutine(id: string) {
      calls.push({ method: 'deleteRoutine', args: [id] });
      if (opts.deleteImpl) return opts.deleteImpl(id);
      return true;
    },
  } as unknown as RoutineRunner;
  return { runner, calls };
}

describe('ManageRoutineTool — input validation', () => {
  it('rejects missing action', async () => {
    const tool = new ManageRoutineTool({
      runner: stubRunner().runner,
      resolveContext: () => ctx,
    });
    const result = await tool.handle({});
    assert.match(result, /^Error:/);
  });

  it('rejects unknown action', async () => {
    const tool = new ManageRoutineTool({
      runner: stubRunner().runner,
      resolveContext: () => ctx,
    });
    const result = await tool.handle({ action: 'destroy' });
    assert.match(result, /^Error:/);
  });

  it('rejects malformed UUID for pause/resume/delete', async () => {
    const tool = new ManageRoutineTool({
      runner: stubRunner().runner,
      resolveContext: () => ctx,
    });
    const result = await tool.handle({ action: 'pause', id: 'not-a-uuid' });
    assert.match(result, /^Error:/);
  });
});

describe('ManageRoutineTool — create', () => {
  it('requires name + cron + prompt', async () => {
    const { runner, calls } = stubRunner();
    const tool = new ManageRoutineTool({ runner, resolveContext: () => ctx });
    const result = await tool.handle({ action: 'create' });
    assert.match(result, /^Error: `create` requires/);
    assert.equal(calls.length, 0);
  });

  it('returns Error when no channel context (resolveContext → undefined)', async () => {
    const { runner, calls } = stubRunner();
    const tool = new ManageRoutineTool({
      runner,
      resolveContext: () => undefined,
    });
    const result = await tool.handle({
      action: 'create',
      name: 'demo',
      cron: '0 9 * * 1',
      prompt: 'p',
    });
    assert.match(result, /^Error: cannot create routine outside a channel/);
    assert.equal(calls.length, 0);
  });

  it('forwards inputs to runner.createRoutine and returns model-friendly JSON', async () => {
    const { runner, calls } = stubRunner();
    const tool = new ManageRoutineTool({ runner, resolveContext: () => ctx });
    const result = await tool.handle({
      action: 'create',
      name: 'demo',
      cron: '0 9 * * 1',
      prompt: 'morning ping',
      timeoutMs: 30_000,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.method, 'createRoutine');
    const payload = JSON.parse(result);
    assert.equal(payload.action, 'created');
    assert.equal(payload.routine.name, 'demo');
    assert.equal(payload.routine.cron, '0 9 * * 1');
    assert.equal(typeof payload.routine.id, 'string');
    assert.equal(typeof payload.routine.createdAt, 'string'); // ISO
  });
});

describe('ManageRoutineTool — error mapping', () => {
  const baseArgs = {
    action: 'create' as const,
    name: 'demo',
    cron: '0 9 * * 1',
    prompt: 'p',
  };

  it('formats RoutineNameConflictError', async () => {
    const { runner } = stubRunner({
      createImpl: async () => {
        throw new RoutineNameConflictError('demo');
      },
    });
    const tool = new ManageRoutineTool({ runner, resolveContext: () => ctx });
    const result = await tool.handle(baseArgs);
    assert.match(result, /^Error: routine name 'demo' already exists/);
  });

  it('formats RoutineQuotaExceededError', async () => {
    const { runner } = stubRunner({
      createImpl: async () => {
        throw new RoutineQuotaExceededError(50);
      },
    });
    const tool = new ManageRoutineTool({ runner, resolveContext: () => ctx });
    const result = await tool.handle(baseArgs);
    assert.match(result, /^Error: maximum of 50 active routines/);
  });

  it('formats UnknownChannelError', async () => {
    const { runner } = stubRunner({
      createImpl: async () => {
        throw new UnknownChannelError('discord');
      },
    });
    const tool = new ManageRoutineTool({ runner, resolveContext: () => ctx });
    const result = await tool.handle(baseArgs);
    assert.match(result, /^Error: no proactive sender registered/);
  });

  it('formats RoutineNotFoundError on pause/resume/delete', async () => {
    const { runner } = stubRunner({
      pauseImpl: async () => {
        throw new RoutineNotFoundError('00000000-0000-0000-0000-000000000000');
      },
    });
    const tool = new ManageRoutineTool({ runner, resolveContext: () => ctx });
    const result = await tool.handle({
      action: 'pause',
      id: '00000000-0000-0000-0000-000000000000',
    });
    assert.match(result, /^Error: routine '00000000-0000-0000-0000-000000000000' not found/);
  });

  it('returns Error: <message> for unexpected Error instances (e.g. JobValidationError)', async () => {
    const { runner } = stubRunner({
      createImpl: async () => {
        throw new Error('cron expression is invalid: foo');
      },
    });
    const tool = new ManageRoutineTool({ runner, resolveContext: () => ctx });
    const result = await tool.handle(baseArgs);
    assert.match(result, /^Error: cron expression is invalid/);
  });
});

describe('ManageRoutineTool — list / pause / resume / delete', () => {
  it('list returns count + routines summary', async () => {
    const r1 = fakeRoutine({ id: 'aaa', name: 'a' });
    const r2 = fakeRoutine({ id: 'bbb', name: 'b', status: 'paused' });
    const { runner, calls } = stubRunner({
      listImpl: async () => [r1, r2],
    });
    const tool = new ManageRoutineTool({ runner, resolveContext: () => ctx });
    const result = await tool.handle({ action: 'list' });
    const payload = JSON.parse(result);
    assert.equal(payload.action, 'list');
    assert.equal(payload.count, 2);
    assert.equal(payload.routines.length, 2);
    assert.equal(payload.routines[0].name, 'a');
    assert.equal(payload.routines[1].status, 'paused');
    assert.equal(calls[0]!.method, 'listRoutines');
    assert.deepEqual(calls[0]!.args, [TENANT, USER]);
  });

  it('pause requires id and forwards it', async () => {
    const id = '11111111-1111-1111-1111-111111111111';
    const { runner, calls } = stubRunner();
    const tool = new ManageRoutineTool({ runner, resolveContext: () => ctx });
    const result = await tool.handle({ action: 'pause', id });
    const payload = JSON.parse(result);
    assert.equal(payload.action, 'paused');
    assert.equal(calls[0]!.method, 'pauseRoutine');
    assert.deepEqual(calls[0]!.args, [id]);
  });

  it('delete reports not_found when the runner returns false', async () => {
    const id = '22222222-2222-2222-2222-222222222222';
    const { runner } = stubRunner({ deleteImpl: async () => false });
    const tool = new ManageRoutineTool({ runner, resolveContext: () => ctx });
    const result = await tool.handle({ action: 'delete', id });
    const payload = JSON.parse(result);
    assert.equal(payload.action, 'not_found');
    assert.equal(payload.id, id);
  });
});
