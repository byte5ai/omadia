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
import type { ExecutionScopeStore, KillSwitch, ReservationRow, ScopeRow } from '../src/execution/scopeStore.js';
import type { RunningDiscussion, StopDiscussionResult } from '../src/conductor/discussionAdmin.js';
import { createOperatorExecutionRouter } from '../src/routes/operatorExecution.js';

const RESERVATION: ReservationRow = {
  id: '44444444-4444-4444-8444-444444444444',
  channelType: 'teams',
  conversationId: '19:stale@thread.v2',
  holderKind: 'agent_discussion',
  processId: 'discussion:17',
  role: 'home',
  reservedAt: '2026-11-19T06:00:00.000Z',
};

const DISCUSSION: RunningDiscussion = {
  workflowId: '33333333-3333-4333-8333-333333333333',
  slug: 'eph-discussion-ab12cd34',
  openedBy: 'hr',
  participants: ['hr', 'accounting'],
  topic: 'Budget 2027',
  conversation: { channelType: 'teams', conversationId: 'conv-1' },
  status: 'running',
  startedAt: '2026-11-19T07:00:00.000Z',
  stopRequestedAt: null,
  expiresAt: '2026-11-20T07:00:00.000Z',
  incomplete: false,
};

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
  let discussionsWired: boolean;
  let discussionListFails: boolean;
  let stopOutcome: StopDiscussionResult;
  let stops: string[];
  let reservations: ReservationRow[];
  let releaseReasons: string[];
  let accessChanges: number;

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
      listHeldReservations: () => Promise.resolve(reservations),
      releaseReservation: (id: string, reason: string) => {
        const found = reservations.find((r) => r.id === id);
        reservations = reservations.filter((r) => r.id !== id);
        if (found) releaseReasons.push(reason);
        return Promise.resolve(found);
      },
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
        discussions: () =>
          discussionsWired
            ? {
                list: () => (discussionListFails ? Promise.reject(new Error('conductor down')) : Promise.resolve([DISCUSSION])),
                stop: (workflowId, actor) => {
                  stops.push(`${workflowId} by ${actor}`);
                  return Promise.resolve(stopOutcome);
                },
              }
            : undefined,
        onAccessChanged: () => {
          accessChanges += 1;
        },
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
    discussionsWired = true;
    discussionListFails = false;
    stopOutcome = { outcome: 'stopped', slug: DISCUSSION.slug, cancelledRuns: 1 };
    stops = [];
    reservations = [RESERVATION];
    releaseReasons = [];
    accessChanges = 0;
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

  it('lists running agent discussions next to the scopes', async () => {
    const res = await call('GET', '/');
    assert.equal(res.json['discussions_failed'], false);
    assert.deepEqual(res.json['discussions'], [
      {
        workflow_id: DISCUSSION.workflowId,
        slug: DISCUSSION.slug,
        opened_by: 'hr',
        participants: ['hr', 'accounting'],
        topic: 'Budget 2027',
        conversation: { channel_type: 'teams', conversation_id: 'conv-1' },
        status: 'running',
        started_at: DISCUSSION.startedAt,
        stop_requested_at: null,
        expires_at: DISCUSSION.expiresAt,
        incomplete: false,
      },
    ]);
  });

  it('keeps scopes and switches when the discussion listing fails, and says so', async () => {
    discussionListFails = true;
    const res = await call('GET', '/');
    assert.equal(res.status, 200);
    assert.equal(res.json['scopes'].length, 2);
    assert.deepEqual(res.json['discussions'], []);
    assert.equal(res.json['discussions_failed'], true);
  });

  it('lists no discussions before the Conductor is wired, and its stop answers 503', async () => {
    discussionsWired = false;
    const list = await call('GET', '/');
    assert.deepEqual(list.json['discussions'], []);
    assert.equal(list.json['discussions_failed'], false);
    assert.equal((await call('POST', `/discussions/${DISCUSSION.workflowId}/stop`)).status, 503);
  });

  it('stops a discussion as the signed-in operator, with an audit entry', async () => {
    const res = await call('POST', `/discussions/${DISCUSSION.workflowId}/stop`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true, cancelled_runs: 1 });
    assert.deepEqual(stops, [`${DISCUSSION.workflowId} by op@example.test`]);
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.action, 'conductor.discussion_stop');
    assert.equal(audits[0]?.target, `conductor-workflow:${DISCUSSION.slug}`);
    assert.deepEqual(audits[0]?.after, { cancelledRuns: 1 });
  });

  it('answers 404 for an unknown discussion and 502 when a cancel failed, without an audit entry', async () => {
    assert.equal((await call('POST', '/discussions/not-a-uuid/stop')).status, 404);
    assert.deepEqual(stops, []);
    stopOutcome = { outcome: 'not_found' };
    assert.equal((await call('POST', `/discussions/${DISCUSSION.workflowId}/stop`)).status, 404);
    stopOutcome = { outcome: 'cancel_failed', cancelledRuns: 0, failedRuns: 1 };
    const failed = await call('POST', `/discussions/${DISCUSSION.workflowId}/stop`);
    assert.equal(failed.status, 502);
    assert.equal(failed.json['code'], 'execution.discussion_stop_failed');
    assert.deepEqual(audits, []);
  });

  it('lists every held conversation, also one no running discussion stands behind (D34)', async () => {
    reservations = [RESERVATION, { ...RESERVATION, id: '55555555-5555-4555-8555-555555555555', holderKind: 'archetype_process', agentId: 'id-mara', pluginId: '@omadia/agent-facilitator', processId: 'fac-7' }];
    const res = await call('GET', '/');
    assert.deepEqual(res.json['reservations'], [
      {
        id: RESERVATION.id,
        channel_type: 'teams',
        conversation_id: '19:stale@thread.v2',
        holder_kind: 'agent_discussion',
        agent_slug: null,
        plugin_id: null,
        process_id: 'discussion:17',
        role: 'home',
        reserved_at: RESERVATION.reservedAt,
      },
      {
        id: '55555555-5555-4555-8555-555555555555',
        channel_type: 'teams',
        conversation_id: '19:stale@thread.v2',
        holder_kind: 'archetype_process',
        agent_slug: 'mara',
        plugin_id: '@omadia/agent-facilitator',
        process_id: 'fac-7',
        role: 'home',
        reserved_at: RESERVATION.reservedAt,
      },
    ]);
  });

  it('releases a held conversation once, as the signed-in operator, with an audit entry', async () => {
    const res = await call('POST', `/reservations/${RESERVATION.id}/release`);
    assert.equal(res.status, 200);
    assert.deepEqual(releaseReasons, ['released by op@example.test']);
    assert.equal(accessChanges, 1);
    assert.equal(audits[0]?.action, 'execution.reservation_release');
    assert.deepEqual(audits[0]?.before, {
      channel_type: 'teams',
      conversation_id: '19:stale@thread.v2',
      holder_kind: 'agent_discussion',
      process_id: 'discussion:17',
    });
    assert.equal((await call('POST', `/reservations/${RESERVATION.id}/release`)).status, 404);
    assert.equal((await call('POST', '/reservations/not-a-uuid/release')).status, 404);
    assert.equal(audits.length, 1);
    assert.equal(accessChanges, 1);
  });
});
