import { strict as assert } from 'node:assert';
import { describe, it, mock } from 'node:test';

import { JobValidationError } from '@omadia/plugin-api';

import {
  ManageRoutineTool,
  type ManageRoutineContext,
} from '../src/plugins/routines/manageRoutineTool.js';
import { RoutineRunInProgressError } from '../src/plugins/routines/routineRunControl.js';
import {
  RoutineBudgetRefusedError,
  RoutineNotActiveError,
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
  runNowImpl?: (id: string) => Promise<Routine>;
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
    async startManualRun(id: string, scope: unknown) {
      calls.push({ method: 'startManualRun', args: [id, scope] });
      if (opts.runNowImpl) return opts.runNowImpl(id);
      return fakeRoutine({ id });
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
    // OM-82 (#993) — the message no longer blames the caller ("outside a
    // channel turn"). #1086 — nor does it claim a runtime fault an operator
    // could fix: a missing context now means a channel no producer covers.
    assert.match(result, /^Error: routines are not available in this conversation/);
    assert.doesNotMatch(result, /outside a channel/);
    assert.doesNotMatch(result, /wiring|operator/i);
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

describe('#1598 — a routine records the orchestrator that runs it', () => {
  const args = { action: 'create' as const, name: 'demo', cron: '0 9 * * 1', prompt: 'ping' };

  it('stores the turn\'s orchestrator slug on the routine', async () => {
    const { runner, calls } = stubRunner();
    const tool = new ManageRoutineTool({
      runner,
      resolveContext: () => ({ ...ctx, agentSlug: 'hr' }),
      requiresAgentSlug: () => true,
    });
    await tool.handle(args);
    assert.equal((calls[0]!.args[0] as { agentSlug?: string }).agentSlug, 'hr');
  });

  it("#1907 — stores the creating turn's MCP identity on the routine", async () => {
    const { runner, calls } = stubRunner();
    const tool = new ManageRoutineTool({
      runner,
      resolveContext: () => ({ ...ctx, agentSlug: 'hr', mcpUserKey: 'owner-sub' }),
    });
    await tool.handle(args);
    assert.equal((calls[0]!.args[0] as { mcpUserKey?: string }).mcpUserKey, 'owner-sub');
  });

  it('refuses a create whose orchestrator is unknown when one is required', async () => {
    const { runner, calls } = stubRunner();
    const tool = new ManageRoutineTool({
      runner,
      resolveContext: () => ctx,
      requiresAgentSlug: () => true,
    });
    const result = await tool.handle(args);
    assert.match(result, /orchestrator that would run it is unknown/);
    assert.equal(calls.length, 0);
  });
});

describe('ManageRoutineTool — create with targetEmail (cold-start outreach)', () => {
  const baseArgs = {
    action: 'create' as const,
    name: 'hr-review',
    cron: '0 9 * * 1',
    prompt: 'remind about the review',
  };

  it('rejects targetEmail when the caller is not authorized', async () => {
    const { runner, calls } = stubRunner();
    // Default ctx has no canTargetOthers → unauthorized.
    const tool = new ManageRoutineTool({ runner, resolveContext: () => ctx });
    const result = await tool.handle({
      ...baseArgs,
      targetEmail: 'someone@byte5.de',
    });
    // #1751 — no operator can grant this; the error says so instead of
    // sending the user to ask for it.
    assert.match(result, /^Error: this deployment cannot send routine messages to other people/);
    assert.doesNotMatch(result, /operator/);
    assert.equal(calls.length, 0);
  });

  it('rejects an invalid targetEmail even when authorized', async () => {
    const { runner, calls } = stubRunner();
    const authedCtx: ManageRoutineContext = { ...ctx, canTargetOthers: true };
    const tool = new ManageRoutineTool({
      runner,
      resolveContext: () => authedCtx,
    });
    const result = await tool.handle({
      ...baseArgs,
      targetEmail: 'not-an-email',
    });
    assert.match(result, /^Error: `targetEmail` is not a valid email/);
    assert.equal(calls.length, 0);
  });

  it('builds a cold-start conversationRef when authorized', async () => {
    const { runner, calls } = stubRunner();
    const authedCtx: ManageRoutineContext = { ...ctx, canTargetOthers: true };
    const tool = new ManageRoutineTool({
      runner,
      resolveContext: () => authedCtx,
    });
    const result = await tool.handle({
      ...baseArgs,
      targetEmail: '  Recipient@Byte5.DE ',
    });
    const payload = JSON.parse(result);
    assert.equal(payload.action, 'created');
    assert.equal(calls.length, 1);
    const input = calls[0]!.args[0] as { conversationRef: Record<string, unknown> };
    assert.equal(input.conversationRef.kind, 'coldStart');
    assert.equal(input.conversationRef.channel, 'teams');
    assert.deepEqual(input.conversationRef.recipient, {
      by: 'email',
      email: 'recipient@byte5.de',
    });
    assert.equal(input.conversationRef.orchestratorProfile, 'bare');
    assert.deepEqual(input.conversationRef.createdBy, {
      tenant: TENANT,
      userId: USER,
    });
  });

  it('falls back to the caller conversationRef when targetEmail is absent', async () => {
    const { runner, calls } = stubRunner();
    const authedCtx: ManageRoutineContext = { ...ctx, canTargetOthers: true };
    const tool = new ManageRoutineTool({
      runner,
      resolveContext: () => authedCtx,
    });
    await tool.handle(baseArgs);
    const input = calls[0]!.args[0] as { conversationRef: unknown };
    assert.deepEqual(input.conversationRef, CONV_REF);
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

  it('returns Error: <message> for a JobValidationError (the cron hint about the model input)', async () => {
    const { runner } = stubRunner({
      createImpl: async () => {
        throw new JobValidationError('cron expression is invalid: foo');
      },
    });
    const tool = new ManageRoutineTool({ runner, resolveContext: () => ctx });
    const result = await tool.handle(baseArgs);
    assert.match(result, /^Error: cron expression is invalid/);
  });

  it('withholds the text of any other exception (a store failure quoting a row)', async () => {
    const EMAIL = 'erika.mustermann@example.com';
    const { runner } = stubRunner({
      createImpl: async () => {
        throw Object.assign(
          new Error(`duplicate key value: Key (target_email)=(${EMAIL}) already exists`),
          { code: '23505' },
        );
      },
    });
    const tool = new ManageRoutineTool({ runner, resolveContext: () => ctx });
    const errorLog = mock.method(console, 'error', () => {});
    let result: string;
    try {
      result = await tool.handle(baseArgs);
    } finally {
      errorLog.mock.restore();
    }
    assert.equal(result.includes(EMAIL), false, `the store's text reached the model: ${result}`);
    assert.match(result, /^Error: tool `manage_routine` failed with Error \(code 23505\) \[ref /);
    assert.equal(errorLog.mock.callCount(), 1, 'the full error goes to the server log');
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
    const id = '11111111-1111-4111-a111-111111111111';
    const { runner, calls } = stubRunner();
    const tool = new ManageRoutineTool({ runner, resolveContext: () => ctx });
    const result = await tool.handle({ action: 'pause', id });
    const payload = JSON.parse(result);
    assert.equal(payload.action, 'paused');
    assert.equal(calls[0]!.method, 'pauseRoutine');
    assert.deepEqual(calls[0]!.args, [id]);
  });

  it('delete reports not_found when the runner returns false', async () => {
    const id = '22222222-2222-4222-a222-222222222222';
    const { runner } = stubRunner({ deleteImpl: async () => false });
    const tool = new ManageRoutineTool({ runner, resolveContext: () => ctx });
    const result = await tool.handle({ action: 'delete', id });
    const payload = JSON.parse(result);
    assert.equal(payload.action, 'not_found');
    assert.equal(payload.id, id);
  });
});


describe('ManageRoutineTool — wave 5 contract (#1743 #1750 #1751 #1767)', () => {
  const NOW = new Date('2026-11-26T10:00:00Z');
  const args = { action: 'create', name: 'morning', cron: '0 9 * * 1-5', prompt: 'summary' };

  it('stores the creator zone, else the instance zone, and names the next run in it', async () => {
    const seen: CreateRoutineInput[] = [];
    const { runner } = stubRunner({
      createImpl: async (input) => {
        seen.push(input);
        return fakeRoutine({ cron: input.cron, timezone: input.timezone ?? null });
      },
    });
    const withUserZone = new ManageRoutineTool({
      runner,
      resolveContext: () => ({ ...ctx, timeZone: 'America/New_York' }),
      defaultTimeZone: 'Europe/Berlin',
      now: () => NOW,
    });
    const created = JSON.parse(await withUserZone.handle(args)) as { routine: { timeZone: string; nextRun: string } };
    assert.equal(seen[0]!.timezone, 'America/New_York');
    assert.equal(created.routine.timeZone, 'America/New_York');
    assert.equal(created.routine.nextRun, '2026-11-26 09:00 (America/New_York)');

    const instanceZone = new ManageRoutineTool({
      runner,
      resolveContext: () => ctx,
      defaultTimeZone: 'Europe/Berlin',
      now: () => NOW,
    });
    await instanceZone.handle(args);
    assert.equal(seen[1]!.timezone, 'Europe/Berlin');
  });

  it('passes a refusal written for the model through (schedule refused, no saved chat)', async () => {
    const { ToolRefusalError } = await import('@omadia/plugin-api');
    const { runner } = stubRunner({
      createImpl: () => Promise.reject(new ToolRefusalError("cron pattern '0 9 31 2 *' fires never from now on; a routine must recur")),
    });
    const tool = new ManageRoutineTool({ runner, resolveContext: () => ctx });
    const result = await tool.handle({ ...args, cron: '0 9 31 2 *' });
    assert.equal(result, "Error: cron pattern '0 9 31 2 *' fires never from now on; a routine must recur");
  });

  it('describes invalid input briefly instead of dumping zod JSON', async () => {
    const { runner } = stubRunner();
    const tool = new ManageRoutineTool({ runner, resolveContext: () => ctx });
    const result = await tool.handle({ action: 'create', name: 'x', cron: '0 9 * * *', prompt: 'p', timeoutMs: 5 });
    assert.match(result, /^Error: invalid manage_routine input — timeoutMs: /);
    assert.doesNotMatch(result, /[[{]/);
  });

  it('does not advertise targetEmail to the model', async () => {
    const { manageRoutineToolSpec } = await import('../src/plugins/routines/manageRoutineTool.js');
    assert.equal('targetEmail' in manageRoutineToolSpec.input_schema.properties, false);
    assert.doesNotMatch(manageRoutineToolSpec.description, /targetEmail/);
  });
});

describe('#2339 — manage_routine run_now', () => {
  const ID = '11111111-1111-4111-8111-111111111111';

  it('starts the routine under the caller\'s scope and confirms the start', async () => {
    const { runner, calls } = stubRunner();
    const tool = new ManageRoutineTool({ runner, resolveContext: () => ctx });
    const out = await tool.handle({ action: 'run_now', id: ID });
    assert.deepEqual(calls, [{ method: 'startManualRun', args: [ID, { kind: 'channel-user', tenant: TENANT, userId: USER }] }]);
    const parsed = JSON.parse(out) as { action: string; routine: { id: string } };
    assert.equal(parsed.action, 'run_started');
    assert.equal(parsed.routine.id, ID);
  });

  it('needs an id and a conversation', async () => {
    const { runner, calls } = stubRunner();
    assert.match(await new ManageRoutineTool({ runner, resolveContext: () => ctx }).handle({ action: 'run_now' }), /^Error: `run_now` requires `id`/);
    assert.match(await new ManageRoutineTool({ runner, resolveContext: () => undefined }).handle({ action: 'run_now', id: ID }), /^Error/);
    assert.equal(calls.length, 0);
  });

  it('says why a run is refused: already running, paused, unknown', async () => {
    const refusals: Array<[Error, RegExp]> = [
      [new RoutineRunInProgressError(ID), /already running/],
      [new RoutineNotActiveError(ID, 'demo', 'paused'), /is paused; resume it/],
      [new RoutineNotFoundError(ID), /not found/],
      [new RoutineBudgetRefusedError(ID, 'the routine\'s total budget would be exceeded by one more run'), /total budget/],
    ];
    for (const [err, pattern] of refusals) {
      const { runner } = stubRunner({ runNowImpl: () => Promise.reject(err) });
      const out = await new ManageRoutineTool({ runner, resolveContext: () => ctx }).handle({ action: 'run_now', id: ID });
      assert.match(out, /^Error: /);
      assert.match(out, pattern);
    }
  });
});
