/**
 * #2082 / #1035 (spec 2042 §5.12, §6 criterion 24) — the trigger tools as
 * wired in the kernel, end to end on a real Postgres (migrations 0093, 0094):
 * an agent sets a trigger in a person's conversation, it fires there and
 * nowhere else, never during the recipient's quiet hours, and within the
 * recipient's rate limit.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { SemanticAnswer } from '@omadia/channel-sdk';
import { Pool } from 'pg';

import { createDiscretionTurnState, readersOf, turnContext } from '@omadia/orchestrator';

import { probePgTest } from './_helpers/pgTestDb.js';

import { ConfigStore } from '../packages/harness-orchestrator/src/registry/configStore.js';
import { runMultiOrchestratorMigrations } from '../packages/harness-orchestrator/src/registry/migrator.js';
import { InMemoryProactiveSenderRegistry } from '../src/plugins/routines/proactiveSender.js';
import { routineTurnContext } from '../src/plugins/routines/routineTurnContext.js';
import { parseQuietHours } from '../src/triggers/proactiveGate.js';
import { DEFAULT_TRIGGER_LIMITS } from '../src/triggers/triggerPolicy.js';
import { wireTriggers, type TriggerWiring } from '../src/triggers/wiring.js';

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'proactiveTriggers',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const SCHEMA = `proactive_triggers_${String(process.pid)}`;
const MIN = 60_000;

describe('#2082 proactive triggers through the kernel wiring (pg, 0093 + 0094)', { skip: !pgAvailable }, () => {
  let pool: Pool;
  let wiring: TriggerWiring;
  const tools = new Map<string, (input: unknown) => Promise<string>>();
  const sent: Array<{ channel: string; ref: unknown; text: string }> = [];
  let agentId = '';
  let clock = new Date('2026-11-23T09:00:00Z');
  const inMin = (m: number): string => new Date(clock.getTime() + m * MIN).toISOString();

  const hrChat = { conversationId: '19:hr-team@thread.v2' };
  const salesChat = { conversationId: '19:sales@thread.v2' };

  /** Call a trigger tool inside a person's turn in `ref`. */
  const call = (name: string, input: unknown, ref: unknown = hrChat): Promise<string> =>
    routineTurnContext.run({ tenant: 't', userId: 'anna', channel: 'teams', conversationRef: ref, agentSlug: 'erika' }, () =>
      (tools.get(name) as (i: unknown) => Promise<string>)(input),
    );

  before(async () => {
    const bootstrap = new Pool({ connectionString: PG_URL, max: 1 });
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();
    pool = new Pool({ connectionString: PG_URL, max: 6, options: `-c search_path=${SCHEMA},public` });
    await runMultiOrchestratorMigrations(pool, () => undefined, MIGRATIONS_DIR);
    await pool.query(await readFile(resolve(MIGRATIONS_DIR, '0094_proactive_recipient_profiles.sql'), 'utf8'));
    agentId = (await new ConfigStore(pool).createAgent({ slug: 'erika', name: 'Erika' })).id;

    const senders = new InMemoryProactiveSenderRegistry();
    senders.register({
      channel: 'teams',
      send: async ({ conversationRef, message }: { conversationRef: unknown; message: SemanticAnswer }) => {
        sent.push({ channel: 'teams', ref: conversationRef, text: message.text });
      },
    });
    wiring = wireTriggers({
      pool,
      limits: DEFAULT_TRIGGER_LIMITS,
      recipientDefaults: { timezone: 'Europe/Berlin', quiet: parseQuietHours('22:00-07:00'), maxPerHour: 2 },
      enabled: true,
      tickMs: 60_000,
      leaseMs: 10 * MIN,
      agentBySlug: (slug) => (slug === 'erika' ? { id: agentId, slug, enabled: true } : undefined),
      agentChat: () => ({ chat: async () => ({ text: 'unused' }) }),
      ownChannelKey: (slug, channel) => (slug === 'erika' && channel === 'teams' ? '28:erika-bot' : undefined),
      readToolsOf: () => new Map(),
      grantedPluginIds: () => ['de.byte5.integration.expenses'],
      eventCatalog: () => ({ 'de.byte5.integration.expenses': ['expenses.report.submitted'], 'de.byte5.integration.hr': ['hr.leave.requested'] }),
      channelPluginIds: () => [],
      senders: () => senders,
      registerNativeTool: (name, handler) => {
        tools.set(name, handler);
        return () => tools.delete(name);
      },
      now: () => clock,
      log: () => undefined,
    });
  });

  after(async () => {
    wiring?.stop();
    await pool?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined);
    await pool?.end();
  });

  beforeEach(async () => {
    sent.length = 0;
    clock = new Date('2026-11-23T09:00:00Z');
    await pool.query('DELETE FROM agent_triggers');
    await pool.query('DELETE FROM proactive_deliveries');
    await pool.query('DELETE FROM proactive_recipient_profiles');
  });

  /** Move the clock to `at` and run one worker tick. */
  async function fireAllAt(at: Date): Promise<void> {
    clock = at;
    await wiring.worker.tick();
  }

  it('outside a person\'s conversation the tools refuse', async () => {
    const out = await (tools.get('wake_at') as (i: unknown) => Promise<string>)({});
    assert.match(out, /no_context/);
  });

  it('criterion 24: a trigger born in the HR chat posts there, never to the sales chat', async () => {
    const refused = await call('wake_at', {
      purpose: 'Erinnerung an die Austrittsunterlagen',
      time: inMin(10),
      until: inMin(60),
      target: { kind: 'conversation', channel: 'teams', ref: salesChat },
      actions: [{ type: 'post', template: 'Bitte an {{purpose}} denken' }],
    });
    assert.match(refused, /target_not_allowed/);

    const created = await call('wake_at', {
      purpose: 'Erinnerung an die Austrittsunterlagen',
      time: inMin(10),
      until: inMin(60),
      actions: [{ type: 'post', template: 'Bitte an {{purpose}} denken' }],
    });
    assert.match(created, /"created"/);
    await fireAllAt(new Date('2026-11-23T09:20:00Z'));
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0]?.ref, hrChat);
    assert.ok(sent.every((m) => JSON.stringify(m.ref) !== JSON.stringify(salesChat)));
  });

  it('INV-9: the trigger keeps its conversation\'s discretion; a post the room may not know is refused when set', async () => {
    const hrKey = 'teams:19:hr';
    const turnIn = (initial: { labels: { kind: 'context'; key: string; readers: ReturnType<typeof readersOf> }[] }) =>
      createDiscretionTurnState({ contextKey: hrKey, resolveReaders: async () => readersOf(['anna', 'ben']), initial });
    const setIn = (discretion: ReturnType<typeof turnIn>, actions: unknown[]) =>
      turnContext.run({ turnId: 'turn-hr', turnDate: '2026-11-23', discretion }, () =>
        call('wake_at', { purpose: 'Erinnerung', time: inMin(10), until: inMin(60), actions }),
      );
    // The creating turn had read what only anna and carl may know.
    const narrow = { labels: [{ kind: 'context' as const, key: 'teams:dm-anna-carl', readers: readersOf(['anna', 'carl']) }] };
    const refused = await setIn(turnIn(narrow), [{ type: 'post', template: 'Bitte an {{purpose}} denken' }]);
    assert.match(refused, /Error \(discretion\)/);

    // A turn step is set; its firing runs as a labelled turn of the HR chat.
    assert.match(await setIn(turnIn(narrow), [{ type: 'turn', instruction: 'Erinnere' }]), /"created"/);
    const [t] = await wiring.service.listForContext('conversation', 'teams:19:hr-team@thread.v2');
    assert.equal(t?.discretion?.contextKey, hrKey);
    assert.deepEqual(t?.discretion?.readers, readersOf(['anna', 'ben']), 'the roster, stored on its own');
    assert.ok(t?.discretion?.labels.labels.some((l) => l.kind === 'context' && l.key === 'teams:dm-anna-carl'));

    // What the room may know: set, fired, sent.
    await pool.query('DELETE FROM agent_triggers');
    assert.match(await setIn(turnIn({ labels: [] }), [{ type: 'post', template: 'Bitte an {{purpose}} denken' }]), /"created"/);
    await fireAllAt(new Date('2026-11-23T09:20:00Z'));
    assert.equal(sent.length, 1);
  });

  it('criterion 24: nothing goes out during the recipient\'s quiet hours; it is deferred', async () => {
    clock = new Date('2026-11-23T22:00:00Z');
    await call('wake_at', {
      purpose: 'x',
      time: inMin(10),
      until: inMin(2 * 24 * 60),
      actions: [{ type: 'post', template: 'Guten Morgen' }],
    });
    // 23:30 in Berlin
    await fireAllAt(new Date('2026-11-23T22:30:00Z'));
    assert.equal(sent.length, 0);
    const due = (await pool.query<{ due_at: Date }>(`SELECT due_at FROM agent_trigger_occurrences WHERE state = 'pending'`)).rows[0];
    assert.equal(due?.due_at.toISOString(), '2026-11-24T06:00:00.000Z', 'deferred to 07:00 Berlin');
  });

  it('a recipient profile turns quiet hours off; the rate limit still holds', async () => {
    await wiring.profiles.set('teams:19:hr-team@thread.v2', { timezone: 'UTC', maxPerHour: 1 }, 'op');
    // profile without quiet hours falls back to the default quiet hours; set an explicit empty window
    await pool.query(`UPDATE proactive_recipient_profiles SET quiet_from = '03:00', quiet_to = '03:01'`);
    clock = new Date('2026-11-23T22:00:00Z');
    for (let i = 0; i < 2; i += 1) {
      await call('wake_at', {
        purpose: `p${String(i)}`,
        time: inMin(10),
        until: inMin(24 * 60),
        actions: [{ type: 'post', template: 'Nachricht {{purpose}}' }],
      });
    }
    await fireAllAt(new Date('2026-11-23T22:30:00Z'));
    assert.equal(sent.length, 1, 'one per hour for this recipient');
  });

  it('list_triggers shows what the agent watches and which events it could hook', async () => {
    await call('on_event', {
      purpose: 'Neue Spesenberichte',
      event: 'expenses.report.submitted',
      until: inMin(24 * 60),
      max_fires: 5,
      actions: [{ type: 'post', template: 'Neuer Bericht' }],
    });
    const hr = await call('on_event', {
      purpose: 'x',
      event: 'hr.leave.requested',
      until: inMin(24 * 60),
      max_fires: 5,
      actions: [{ type: 'post', template: 'x' }],
    });
    assert.match(hr, /unknown_event/, 'an event of a plugin the agent was not granted');
    const listed = JSON.parse(await call('list_triggers', {})) as { triggers: Array<{ purpose: string }>; eventSources: Array<{ eventId: string }> };
    assert.deepEqual(listed.triggers.map((t) => t.purpose), ['Neue Spesenberichte']);
    const ids = listed.eventSources.map((s) => s.eventId);
    assert.ok(ids.includes('expenses.report.submitted'));
    assert.ok(ids.includes('conversation.message.created'));
    assert.ok(!ids.includes('hr.leave.requested'));
  });

  it('a hook never hears the agent\'s own messages', async () => {
    await call('on_event', {
      purpose: 'Auf neue Nachrichten reagieren',
      event: 'conversation.message.created',
      until: inMin(24 * 60),
      max_fires: 5,
      actions: [{ type: 'post', template: 'Gesehen' }],
    });
    const base = { channelType: 'teams', conversationId: hrChat.conversationId, authorKind: 'teams' };
    assert.equal(await wiring.service.onEvent('conversation.message.created', { ...base, messageId: 'm1', authorId: '28:erika-bot' }, 'k1'), 0);
    assert.equal(await wiring.service.onEvent('conversation.message.created', { ...base, messageId: 'm2', authorId: '29:anna' }, 'k2'), 1);
  });

  it('cancel_trigger ends only the agent\'s own trigger', async () => {
    const created = JSON.parse(
      await call('wake_at', {
        purpose: 'x',
        time: inMin(10),
        until: inMin(60),
        actions: [{ type: 'post', template: 'x' }],
      }),
    ) as { created: { id: string } };
    assert.match(await call('cancel_trigger', { id: '00000000-0000-0000-0000-000000000000' }), /no such trigger/);
    // From another conversation the trigger is neither listed nor cancellable.
    const elsewhere = JSON.parse(await call('list_triggers', {}, salesChat)) as { triggers: unknown[] };
    assert.deepEqual(elsewhere.triggers, []);
    assert.match(await call('cancel_trigger', { id: created.created.id }, salesChat), /no such trigger/);
    assert.deepEqual(JSON.parse(await call('cancel_trigger', { id: created.created.id })), { cancelled: created.created.id });
    assert.equal(await wiring.service.get(created.created.id), undefined);
  });
});
