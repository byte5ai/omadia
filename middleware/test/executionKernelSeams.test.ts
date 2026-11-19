/**
 * #2090 — where execution scopes meet the rest of the kernel: agent
 * discussions take the shared conversation reservation (spec 2043 §5.3), and
 * the operator sees open scopes and sets the kill switch.
 */

import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';

import express from 'express';

import { listenLoopback } from './_helpers/listenLoopback.js';

import type { AuditEntryInput } from '../src/auth/adminAuditLog.js';
import {
  ConductorDiscussionService,
  DiscussionConversationBusyError,
  type DiscussionReservations,
} from '../src/conductor/discussionService.js';
import type { ExecutionScopeStore, KillSwitch, ScopeRow } from '../src/execution/scopeStore.js';
import { createOperatorExecutionRouter } from '../src/routes/operatorExecution.js';

const START = { channelType: 'teams', conversationId: 'conv-1', participants: ['hr', 'accounting'], topic: 'Budget' };

function discussion(opts: { reserve: boolean; runFails?: boolean }) {
  const calls: string[] = [];
  const reservations: DiscussionReservations = {
    reserve: (channelType, conversationId) => {
      calls.push(`reserve(${channelType}, ${conversationId})`);
      return Promise.resolve(opts.reserve);
    },
    release: (channelType, conversationId, reason) => {
      calls.push(`release(${channelType}, ${conversationId}, ${reason})`);
      return Promise.resolve();
    },
  };
  const service = new ConductorDiscussionService({
    identityFor: () => ({ channelKey: 'bot' }),
    reservations,
    ephemeralRuns: {
      createEphemeralRun: () => {
        calls.push('createEphemeralRun');
        return opts.runFails
          ? Promise.reject(new Error('pattern missing'))
          : Promise.resolve({ runId: 'run-1', workflowId: 'wf-1', workflowSlug: 'eph', expiresAt: new Date(Date.now() + 60_000).toISOString() });
      },
    },
    attachments: {
      getByConversation: () => Promise.resolve(undefined),
      upsertPending: () => {
        calls.push('upsertPending');
        return Promise.resolve({});
      },
      attachToWorkflow: () => Promise.resolve(undefined),
    } as never,
  });
  return { service, calls };
}

describe('#2090 agent discussions share the conversation reservation', () => {
  it('takes the reservation before it claims the floor', async () => {
    const { service, calls } = discussion({ reserve: true });
    await service.start(START);
    assert.deepEqual(calls, ['reserve(teams, conv-1)', 'upsertPending', 'createEphemeralRun']);
  });

  it('is refused while a facilitation holds the conversation, and claims nothing', async () => {
    const { service, calls } = discussion({ reserve: false });
    await assert.rejects(
      () => service.start(START),
      (err: unknown) => err instanceof DiscussionConversationBusyError && /a facilitation is running/.test(err.message),
    );
    assert.deepEqual(calls, ['reserve(teams, conv-1)']);
  });

  it('gives the reservation back when the discussion does not start', async () => {
    const { service, calls } = discussion({ reserve: true, runFails: true });
    await assert.rejects(() => service.start(START), /pattern missing/);
    assert.equal(calls.at(-1), 'release(teams, conv-1, discussion did not start)');
  });
});

const SCOPE: ScopeRow = {
  id: '11111111-1111-4111-8111-111111111111',
  agentId: 'id-mara',
  agentSlug: 'mara',
  pluginId: '@omadia/agent-facilitator',
  processId: 'fac-7',
  kind: 'active',
  eventId: '',
  state: 'open',
  deadline: '2026-12-01T10:00:00.000Z',
  absoluteLimit: '2027-11-19T10:00:00.000Z',
  deadlineWait: false,
  budget: { actions: 100, modelCalls: 40 },
  used: { actions: 12, modelCalls: 5 },
  targets: [
    { kind: 'conversation', channelType: 'teams', conversationId: '19:offsite@thread.v2' },
    { kind: 'person', channelType: 'teams', principalId: 'aad:anna' },
  ],
  openedAt: '2026-11-19T10:00:00.000Z',
};

describe('#2090 operator routes: open scopes and the kill switch', () => {
  let server: Server;
  let base: string;
  let switches: KillSwitch[];
  let audits: AuditEntryInput[];
  let hasStore: boolean;

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };

  before(async () => {
    const store = {
      listKillSwitches: () => Promise.resolve(switches),
      listOpenScopes: () => Promise.resolve([SCOPE, { ...SCOPE, id: '2', agentId: 'id-finn', agentSlug: 'finn', processId: 'fac-9' }]),
      setKillSwitch: (input: { level: KillSwitch['level']; agentId?: string; processId?: string; reason: string; setBy: string }) => {
        const made: KillSwitch = {
          id: `22222222-2222-4222-8222-22222222222${String(switches.length)}`,
          level: input.level,
          reason: input.reason,
          setBy: input.setBy,
          setAt: '2026-11-19T12:00:00.000Z',
          ...(input.agentId ? { agentId: input.agentId } : {}),
          ...(input.processId ? { processId: input.processId } : {}),
        };
        switches.push(made);
        return Promise.resolve(made);
      },
      clearKillSwitch: (id: string) => {
        const found = switches.find((k) => k.id === id);
        switches = switches.filter((k) => k.id !== id);
        return Promise.resolve(found);
      },
    } as unknown as ExecutionScopeStore;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { session: unknown }).session = { email: 'op@example.test' };
      next();
    });
    app.use(
      '/execution',
      createOperatorExecutionRouter({
        store: () => (hasStore ? store : undefined),
        agentBySlug: (slug) => Promise.resolve(slug === 'mara' ? { id: 'id-mara', slug } : undefined),
        agentSlugs: () => Promise.resolve(new Map([['id-mara', 'mara'], ['id-finn', 'finn']])),
        audit: (entry) => {
          audits.push(entry);
          return Promise.resolve();
        },
      }),
    );
    server = await listenLoopback(app);
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/execution`;
  });

  after(async () => {
    await new Promise<void>((done) => server.close(() => done()));
  });

  beforeEach(() => {
    switches = [];
    audits = [];
    hasStore = true;
  });

  it('lists open scopes with their budgets and no participant ids', async () => {
    const res = await call('GET', '/');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json['scopes'][0], {
      id: SCOPE.id,
      agent_slug: 'mara',
      plugin_id: '@omadia/agent-facilitator',
      process_id: 'fac-7',
      kind: 'active',
      event_id: null,
      deadline: SCOPE.deadline,
      absolute_limit: SCOPE.absoluteLimit,
      deadline_wait: false,
      budget: { actions: 100, model_calls: 40 },
      used: { actions: 12, model_calls: 5 },
      conversations: 1,
      people: 1,
      opened_at: SCOPE.openedAt,
      stopped: false,
    });
    assert.ok(!JSON.stringify(res.json).includes('aad:anna'));
  });

  it('a process switch marks exactly its scope as stopped; an instance switch marks all', async () => {
    const set = await call('POST', '/kill-switches', { level: 'process', agent_slug: 'mara', process_id: 'fac-7', reason: ' runaway ' });
    assert.equal(set.status, 201);
    assert.deepEqual(set.json['kill_switch'], {
      id: set.json['kill_switch'].id,
      level: 'process',
      agent_slug: 'mara',
      process_id: 'fac-7',
      reason: 'runaway',
      set_by: 'op@example.test',
      set_at: '2026-11-19T12:00:00.000Z',
    });
    let list = await call('GET', '/');
    assert.deepEqual(list.json['scopes'].map((s: { stopped: boolean }) => s.stopped), [true, false]);
    await call('POST', '/kill-switches', { level: 'instance' });
    list = await call('GET', '/');
    assert.deepEqual(list.json['scopes'].map((s: { stopped: boolean }) => s.stopped), [true, true]);
    assert.equal(list.json['kill_switches'].length, 2);
    assert.deepEqual(audits.map((a) => a.action), ['execution.kill_switch_set', 'execution.kill_switch_set']);
    assert.deepEqual(audits[0]?.after, { level: 'process', agent: 'mara', process_id: 'fac-7', reason: 'runaway' });
    assert.deepEqual(audits[0]?.actor, { email: 'op@example.test' });
  });

  it('refuses a malformed switch and an unknown agent', async () => {
    assert.equal((await call('POST', '/kill-switches', { level: 'everything' })).status, 400);
    assert.equal((await call('POST', '/kill-switches', { level: 'agent', agent_slug: 'nobody' })).status, 404);
    assert.equal((await call('POST', '/kill-switches', { level: 'agent' })).status, 404);
    assert.equal((await call('POST', '/kill-switches', { level: 'process', agent_slug: 'mara' })).status, 400);
    assert.deepEqual(switches, []);
    assert.deepEqual(audits, []);
  });

  it('clears a switch once, with an audit entry', async () => {
    const set = await call('POST', '/kill-switches', { level: 'agent', agent_slug: 'mara' });
    const id = set.json['kill_switch'].id as string;
    assert.equal((await call('DELETE', `/kill-switches/${id}`)).status, 200);
    assert.equal((await call('DELETE', `/kill-switches/${id}`)).status, 404);
    assert.equal((await call('DELETE', '/kill-switches/not-a-uuid')).status, 404);
    assert.deepEqual(audits.map((a) => a.action), ['execution.kill_switch_set', 'execution.kill_switch_clear']);
  });

  it('answers 503 without a database', async () => {
    hasStore = false;
    for (const [method, path] of [['GET', '/'], ['POST', '/kill-switches'], ['DELETE', '/kill-switches/x']] as const) {
      const res = await call(method, path, method === 'POST' ? { level: 'instance' } : undefined);
      assert.equal(res.status, 503);
      assert.equal(res.json['code'], 'execution.unavailable');
    }
  });
});
