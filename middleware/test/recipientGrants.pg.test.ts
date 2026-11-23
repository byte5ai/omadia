/**
 * Spec 2042 §5.12 "Same rules as any turn", §6 criterion 24 — delivery to an
 * explicit target through the kernel wiring on a real Postgres (migrations
 * 0093, 0094, 0125): an operator grants an agent a target conversation
 * through the admin API, the agent names it by grant id, the message goes
 * only there and through the grant's reference, the target's readers are
 * read when the message goes out (not when the trigger was set), a revoked
 * grant delivers nothing, and the recipient's quiet hours hold.
 */

import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { SemanticAnswer } from '@omadia/channel-sdk';
import { createDiscretionTurnState, readersOf, turnContext, UNKNOWN_READERS, type Readers } from '@omadia/orchestrator';
import express from 'express';
import { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';

import { ConfigStore } from '../packages/harness-orchestrator/src/registry/configStore.js';
import { runMultiOrchestratorMigrations } from '../packages/harness-orchestrator/src/registry/migrator.js';
import type { AuditEntryInput } from '../src/auth/adminAuditLog.js';
import { InMemoryProactiveSenderRegistry } from '../src/plugins/routines/proactiveSender.js';
import { routineTurnContext } from '../src/plugins/routines/routineTurnContext.js';
import { createOperatorTriggersRouter } from '../src/routes/operatorTriggers.js';
import { parseQuietHours } from '../src/triggers/proactiveGate.js';
import { DEFAULT_TRIGGER_LIMITS } from '../src/triggers/triggerPolicy.js';
import { wireTriggers, type TriggerWiring } from '../src/triggers/wiring.js';

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'recipientGrants',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const SCHEMA = `recipient_grants_${String(process.pid)}`;
const MIN = 60_000;

const HR_ID = '19:hr-team@thread.v2';
/** The HR chat as the Teams plugin captures it (a Bot Framework reference). */
const HR_CHAT = { channelId: 'msteams', serviceUrl: 'https://smba.example/emea/', conversation: { id: HR_ID, conversationType: 'groupChat' }, bot: { id: '28:shared' } };
const LEADS_CHAT = '19:hr-leads@thread.v2';
const SALES_CHAT = '19:sales@thread.v2';

describe('criterion 24: delivery to an explicit target (pg, 0125)', { skip: !pgAvailable }, () => {
  let pool: Pool;
  let wiring: TriggerWiring;
  let base = '';
  let server: ReturnType<ReturnType<typeof express>['listen']> | undefined;
  const tools = new Map<string, (input: unknown) => Promise<string>>();
  const sent: Array<{ ref: unknown; text: string }> = [];
  const audits: AuditEntryInput[] = [];
  /** The rosters the channel reports, by conversation id, as of now. */
  const rooms = new Map<string, Readers>();
  let agentId = '';
  let clock = new Date('2026-11-23T09:00:00Z');
  const inMin = (m: number): string => new Date(clock.getTime() + m * MIN).toISOString();

  /** The HR chat's turn: it read an HR record anna and ben may know. */
  const hrTurn = () =>
    createDiscretionTurnState({
      contextKey: `teams:${HR_ID}`,
      resolveReaders: async () => readersOf(['anna', 'ben']),
      initial: { labels: [{ kind: 'context', key: 'odoo:hr.employee:ben', readers: readersOf(['anna', 'ben']) }] },
    });

  /** A trigger tool, called inside anna's turn in the HR chat. */
  const call = (name: string, input: unknown, discretion = hrTurn()): Promise<string> =>
    turnContext.run({ turnId: 'turn-hr', turnDate: '2026-11-23', discretion }, () =>
      routineTurnContext.run({ tenant: 't', userId: 'anna', channel: 'teams', conversationRef: HR_CHAT, agentSlug: 'hanna' }, () =>
        (tools.get(name) as (i: unknown) => Promise<string>)(input),
      ),
    );

  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
    const res = await fetch(`${base}/api/v1/operator/triggers${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
  };

  const grant = async (conversationId: string, label: string): Promise<string> => {
    const res = await api('PUT', '/recipient-grants', { agent_id: agentId, channel: 'teams', conversation_id: conversationId, label });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    return (res.json['grant'] as { id: string }).id;
  };

  const setTargeted = async (targetId: string, template = 'Bitte die Austrittsunterlagen vorbereiten'): Promise<string> =>
    call('wake_at', {
      purpose: 'Austritt vorbereiten',
      time: inMin(10),
      until: inMin(24 * 60),
      target: targetId,
      actions: [{ type: 'post', template }],
    });

  const fireAt = async (at: Date): Promise<void> => {
    clock = at;
    await wiring.worker.tick();
  };

  const firedDetail = async (): Promise<string> =>
    JSON.stringify((await pool.query(`SELECT event, detail FROM agent_trigger_audit ORDER BY id`)).rows);

  before(async () => {
    const bootstrap = new Pool({ connectionString: PG_URL, max: 1 });
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();
    pool = new Pool({ connectionString: PG_URL, max: 6, options: `-c search_path=${SCHEMA},public` });
    await runMultiOrchestratorMigrations(pool, () => undefined, MIGRATIONS_DIR);
    agentId = (await new ConfigStore(pool).createAgent({ slug: 'hanna', name: 'Hanna' })).id;

    const senders = new InMemoryProactiveSenderRegistry();
    senders.register({
      channel: 'teams',
      send: async ({ conversationRef, message }: { conversationRef: unknown; message: SemanticAnswer }) => {
        sent.push({ ref: conversationRef, text: message.text });
      },
    });
    wiring = wireTriggers({
      pool,
      limits: DEFAULT_TRIGGER_LIMITS,
      recipientDefaults: { timezone: 'Europe/Berlin', quiet: null, maxPerHour: 10 },
      enabled: true,
      tickMs: 60_000,
      leaseMs: 10 * MIN,
      agentBySlug: (slug) => (slug === 'hanna' ? { id: agentId, slug, enabled: true } : undefined),
      agentChat: () => ({ chat: async () => ({ text: 'unused' }) }),
      readToolsOf: () => new Map(),
      grantedPluginIds: () => [],
      eventCatalog: () => ({}),
      channelPluginIds: () => [],
      senders: () => senders,
      registerNativeTool: (name, handler) => {
        tools.set(name, handler);
        return () => tools.delete(name);
      },
      conversationReaders: async (_channel, conversationId) => rooms.get(conversationId) ?? UNKNOWN_READERS,
      now: () => clock,
      log: () => undefined,
    });

    const app = express();
    app.use(express.json());
    app.use(
      '/api/v1/operator/triggers',
      createOperatorTriggersRouter({
        triggers: () => wiring,
        knownConversationRef: async (_channel, conversationId) =>
          conversationId === LEADS_CHAT || conversationId === SALES_CHAT
            ? { channelId: 'msteams', serviceUrl: 'https://smba.example/emea/', conversation: { id: conversationId, conversationType: 'groupChat' }, bot: { id: '28:shared' } }
            : undefined,
        audit: async (entry) => {
          audits.push(entry);
        },
      }),
    );
    server = app.listen(0);
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  after(async () => {
    wiring?.stop();
    server?.close();
    await pool?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined);
    await pool?.end();
  });

  beforeEach(async () => {
    sent.length = 0;
    audits.length = 0;
    clock = new Date('2026-11-23T09:00:00Z');
    rooms.clear();
    rooms.set(HR_ID, readersOf(['anna', 'ben']));
    rooms.set(LEADS_CHAT, readersOf(['anna', 'ben']));
    rooms.set(SALES_CHAT, readersOf(['anna', 'ben', 'sam', 'tom']));
    await pool.query('DELETE FROM agent_triggers');
    await pool.query('DELETE FROM agent_trigger_audit');
    await pool.query('DELETE FROM agent_recipient_grants');
    await pool.query('DELETE FROM proactive_deliveries');
    await pool.query('DELETE FROM proactive_recipient_profiles');
  });

  it('the operator grants, lists and revokes a target through the admin API; every change is audited', async () => {
    const id = await grant(LEADS_CHAT, 'HR-Leitung');
    const listed = await api('GET', `/recipient-grants?agent_id=${agentId}`);
    assert.deepEqual(
      (listed.json['grants'] as Array<Record<string, unknown>>).map((g) => [g['id'], g['channel'], g['conversationId'], g['label']]),
      [[id, 'teams', LEADS_CHAT, 'HR-Leitung']],
    );
    assert.equal(JSON.stringify(listed.json).includes('serviceUrl'), false, 'the channel reference stays in the kernel');
    // A Teams conversation the instance never saw has no reference: refused.
    const unknown = await api('PUT', '/recipient-grants', { agent_id: agentId, channel: 'teams', conversation_id: '19:never@thread.v2' });
    assert.equal(unknown.status, 422);
    const mismatch = await api('PUT', '/recipient-grants', {
      agent_id: agentId,
      channel: 'teams',
      conversation_id: SALES_CHAT,
      delivery_ref: { conversationId: LEADS_CHAT },
    });
    assert.equal(mismatch.status, 400, 'a reference must name the granted conversation');
    const noAgent = await api('PUT', '/recipient-grants', {
      agent_id: '00000000-0000-4000-8000-000000000000',
      channel: 'slack',
      conversation_id: 'C123',
    });
    assert.equal(noAgent.status, 404);
    assert.equal((await api('DELETE', `/recipient-grants/${id}`)).status, 204);
    assert.equal((await api('DELETE', `/recipient-grants/${id}`)).status, 404);
    assert.deepEqual(audits.map((a) => a.action), ['trigger.recipient_grant', 'trigger.recipient_grant_revoke']);
  });

  it('without a grant the agent cannot name a target; list_triggers shows only its granted ones', async () => {
    assert.match(await setTargeted('00000000-0000-4000-8000-000000000000'), /target_not_allowed/);
    assert.match(
      await call('wake_at', {
        purpose: 'x',
        time: inMin(10),
        until: inMin(60),
        target: { kind: 'conversation', channel: 'teams', ref: { conversationId: SALES_CHAT } },
        actions: [{ type: 'post', template: 'x' }],
      }),
      /target_not_allowed/,
      'a model-made reference is never a target',
    );
    const id = await grant(LEADS_CHAT, 'HR-Leitung');
    const listed = JSON.parse(await call('list_triggers', {})) as { targets: Array<Record<string, unknown>> };
    assert.deepEqual(listed.targets, [{ id, channel: 'teams', label: 'HR-Leitung' }]);
  });

  it('a granted target whose readers may know it gets the message, through the grant\'s reference, and the origin gets nothing', async () => {
    const id = await grant(LEADS_CHAT, 'HR-Leitung');
    assert.match(await setTargeted(id), /"created"/);
    await fireAt(new Date('2026-11-23T09:20:00Z'));
    assert.deepEqual(sent, [
      {
        ref: { channelId: 'msteams', serviceUrl: 'https://smba.example/emea/', conversation: { id: LEADS_CHAT, conversationType: 'groupChat' }, bot: { id: '28:shared' } },
        text: 'Bitte die Austrittsunterlagen vorbereiten',
      },
    ]);
  });

  it('criterion 24: an HR message granted into the sales chat is withheld at send time, as a whole', async () => {
    const id = await grant(SALES_CHAT, 'Vertrieb');
    assert.match(await setTargeted(id, 'Ben verlässt uns zum Monatsende'), /"created"/);
    await fireAt(new Date('2026-11-23T09:20:00Z'));
    assert.deepEqual(sent, []);
    assert.match(await firedDetail(), /withheld by discretion/);
  });

  it('the target\'s readers are read when the message goes out, not when the trigger was set', async () => {
    const id = await grant(LEADS_CHAT, 'HR-Leitung');
    assert.match(await setTargeted(id), /"created"/);
    // carl joins the HR leads chat after the trigger was set.
    rooms.set(LEADS_CHAT, readersOf(['anna', 'ben', 'carl']));
    await fireAt(new Date('2026-11-23T09:20:00Z'));
    assert.deepEqual(sent, [], 'carl may not know the HR record');
    assert.match(await firedDetail(), /withheld by discretion/);
  });

  it('a room whose members cannot be read is closed', async () => {
    const id = await grant(LEADS_CHAT, 'HR-Leitung');
    assert.match(await setTargeted(id), /"created"/);
    rooms.delete(LEADS_CHAT);
    await fireAt(new Date('2026-11-23T09:20:00Z'));
    assert.deepEqual(sent, []);
  });

  it('a revoked grant delivers nothing, even for a trigger set while it held', async () => {
    const id = await grant(LEADS_CHAT, 'HR-Leitung');
    assert.match(await setTargeted(id), /"created"/);
    assert.equal((await api('DELETE', `/recipient-grants/${id}`)).status, 204);
    await fireAt(new Date('2026-11-23T09:20:00Z'));
    assert.deepEqual(sent, []);
    assert.match(await firedDetail(), /target_not_granted/);
  });

  it('criterion 24: nothing goes out during the target recipient\'s quiet hours; it is deferred', async () => {
    const id = await grant(LEADS_CHAT, 'HR-Leitung');
    await wiring.profiles.set(`teams:${LEADS_CHAT}`, { timezone: 'Europe/Berlin', quiet: parseQuietHours('09:00-12:00') ?? undefined }, 'op');
    assert.match(await setTargeted(id), /"created"/);
    await fireAt(new Date('2026-11-23T09:20:00Z'));
    assert.deepEqual(sent, [], '10:20 in Berlin is in the leads\' quiet hours (the HR chat has none)');
    const due = (await pool.query<{ due_at: Date }>(`SELECT due_at FROM agent_trigger_occurrences WHERE state = 'pending'`)).rows[0];
    assert.equal(due?.due_at.toISOString(), '2026-11-23T11:00:00.000Z', 'deferred to 12:00 Berlin');
    await fireAt(new Date('2026-11-23T11:01:00Z'));
    assert.equal(sent.length, 1);
  });

  it('a target needs the discretion record of the turn that set it', async () => {
    const id = await grant(LEADS_CHAT, 'HR-Leitung');
    // The claude-cli runtime labels nothing: no discretion state on the turn.
    const out = await routineTurnContext.run(
      { tenant: 't', userId: 'anna', channel: 'teams', conversationRef: HR_CHAT, agentSlug: 'hanna' },
      () => (tools.get('wake_at') as (i: unknown) => Promise<string>)({
        purpose: 'x',
        time: inMin(10),
        until: inMin(60),
        target: id,
        actions: [{ type: 'post', template: 'x' }],
      }),
    );
    assert.match(out, /"created"/);
    await fireAt(new Date('2026-11-23T09:20:00Z'));
    assert.deepEqual(sent, []);
    assert.match(await firedDetail(), /needs the discretion record/);
  });
});
