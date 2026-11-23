/**
 * Spec 2042 §6 criteria 21–24, 26 and 35 (triggers part) through the kernel
 * wiring (`wireTriggers`) on a real Postgres: the real kernel executors, the
 * proactive gate, the data-action runner and the trigger tools. The model is
 * an agent chat that passes the model gateway (`admitModelCall`), so the LLM
 * usage of every firing is what the gateway's meter counts — not what a
 * scripted turn step reports about itself.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { ChannelReadinessProvider, ChatTurnInput, MeetingSourceProvider, SemanticAnswer } from '@omadia/channel-sdk';
import { admitModelCall } from '@omadia/llm-provider';
import { createDataPlanGuard, readersOf, unionLabels } from '@omadia/orchestrator';
import type { AgentSpeaker, DataPlanGuard } from '@omadia/plugin-api';
import { meterModelCalls } from '@omadia/usage-telemetry';
import { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';

import { ConfigStore } from '../packages/harness-orchestrator/src/registry/configStore.js';
import { runMultiOrchestratorMigrations } from '../packages/harness-orchestrator/src/registry/migrator.js';
import { SessionCapabilityHub } from '../src/channels/sessionCapabilities/hub.js';
import { ChannelProviderRegistry } from '../src/channels/sessionCapabilities/providerRegistry.js';
import { InMemoryProactiveSenderRegistry } from '../src/plugins/routines/proactiveSender.js';
import { routineTurnContext } from '../src/plugins/routines/routineTurnContext.js';
import { DEFAULT_TRIGGER_LIMITS, type TriggerEnvelope } from '../src/triggers/triggerPolicy.js';
import { TriggerService } from '../src/triggers/triggerService.js';
import { wireTriggers, type TriggerWiring } from '../src/triggers/wiring.js';

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'triggerAcceptance',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const SCHEMA = `trigger_acceptance_${String(process.pid)}`;
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const MEETING = { conversationId: '19:meeting_abc@thread.v2' };
const OLGA_DM = { conversationId: 'a:olga-expenses-dm' };
const HR_CHAT = { conversationId: '19:hr-team@thread.v2' };
const SALES_CHAT = { conversationId: '19:sales@thread.v2' };

const TOP_CUSTOMERS = { model: 'res.partner', fields: ['name', 'total_invoiced'], order: 'total_invoiced desc', limit: 10 };

interface Sent {
  readonly ref: unknown;
  readonly message: SemanticAnswer;
}

describe('spec 2042 triggers through the kernel wiring (pg)', { skip: !pgAvailable }, () => {
  let pool: Pool;
  const agents = new Map<string, { id: string; slug: string; enabled: boolean; displayName: string }>();
  const sent: Sent[] = [];
  /** Every instruction a trigger turn handed to the agent's model. */
  const modelTurns: string[] = [];
  const toolRuns: string[] = [];
  let guard: DataPlanGuard | undefined;
  let clock = new Date('2026-11-23T09:00:00Z');
  const inMin = (m: number): string => new Date(clock.getTime() + m * MIN).toISOString();
  const wirings: TriggerWiring[] = [];

  const speakerOf = (slug: string): AgentSpeaker | undefined => {
    const a = agents.get(slug);
    return a ? { kind: 'agent', agentId: a.id, slug, displayName: a.displayName } : undefined;
  };

  function wire(): { wiring: TriggerWiring; tools: Map<string, (input: unknown) => Promise<string>> } {
    const tools = new Map<string, (input: unknown) => Promise<string>>();
    const senders = new InMemoryProactiveSenderRegistry();
    senders.register({
      channel: 'teams',
      send: async ({ conversationRef, message }: { conversationRef: unknown; message: SemanticAnswer }) => {
        sent.push({ ref: conversationRef, message });
      },
    });
    const wiring = wireTriggers({
      pool,
      limits: DEFAULT_TRIGGER_LIMITS,
      recipientDefaults: { timezone: 'Europe/Berlin', quiet: null, maxPerHour: 100 },
      enabled: true,
      tickMs: 60_000,
      leaseMs: 10 * MIN,
      agentBySlug: (slug) => agents.get(slug),
      // The agent's model: one gateway-admitted call per turn.
      agentChat: () => ({
        chat: async (input: ChatTurnInput): Promise<SemanticAnswer> => {
          admitModelCall('complete');
          modelTurns.push(input.userMessage);
          return { text: `Antwort auf: ${input.userMessage}` };
        },
      }),
      speakerOf,
      readToolsOf: () =>
        new Map([
          ['expenses_open', async () => (toolRuns.push('expenses_open'), JSON.stringify([{ report: 'SP-7', amount: 120 }, { report: 'SP-9', amount: 80 }]))],
          ['odoo_query', async () => (toolRuns.push('odoo_query'), JSON.stringify([{ name: 'Müller GmbH', total_invoiced: 99 }]))],
        ]),
      dataPlanGuardOf: () => guard,
      grantedPluginIds: () => [],
      eventCatalog: () => ({}),
      channelPluginIds: () => [],
      senders: () => senders,
      registerNativeTool: (name, handler) => {
        tools.set(name, handler);
        return () => tools.delete(name);
      },
      now: () => clock,
      log: () => undefined,
    });
    wirings.push(wiring);
    return { wiring, tools };
  }

  /** A trigger tool, called inside a person's turn in `ref`. */
  const call = (
    tools: Map<string, (input: unknown) => Promise<string>>,
    agentSlug: string,
    name: string,
    input: unknown,
    ref: unknown,
    userId = 'anna',
  ): Promise<string> =>
    routineTurnContext.run({ tenant: 't', userId, channel: 'teams', conversationRef: ref, agentSlug }, () =>
      (tools.get(name) as (i: unknown) => Promise<string>)(input),
    );

  /** One worker tick; the model calls the gateway admitted during it. */
  const tick = async (wiring: TriggerWiring): Promise<number> => (await meterModelCalls(() => wiring.worker.tick())).modelCalls;

  before(async () => {
    const bootstrap = new Pool({ connectionString: PG_URL, max: 1 });
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();
    pool = new Pool({ connectionString: PG_URL, max: 8, options: `-c search_path=${SCHEMA},public` });
    await runMultiOrchestratorMigrations(pool, () => undefined, MIGRATIONS_DIR);
    await pool.query(await readFile(resolve(MIGRATIONS_DIR, '0094_proactive_recipient_profiles.sql'), 'utf8'));
    const config = new ConfigStore(pool);
    for (const [slug, displayName] of [['moderator', 'Mia'], ['expenses', 'Erik'], ['hr', 'Hanna'], ['sales', 'Sam']] as const) {
      const agent = await config.createAgent({ slug, name: displayName });
      agents.set(slug, { id: agent.id, slug, enabled: true, displayName });
    }
  });

  after(async () => {
    for (const w of wirings) w.stop();
    await pool?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined);
    await pool?.end();
  });

  beforeEach(async () => {
    sent.length = 0;
    modelTurns.length = 0;
    toolRuns.length = 0;
    // An agent without boundaries: every plan passes.
    guard = createDataPlanGuard({ boundaries: undefined });
    clock = new Date('2026-11-23T09:00:00Z');
    await pool.query('DELETE FROM agent_triggers');
    await pool.query('DELETE FROM agent_trigger_context_activity');
    await pool.query('DELETE FROM proactive_deliveries');
  });

  it('criterion 21: a timer firing with nothing new makes no model call — the gateway admits none', async () => {
    const { wiring, tools } = wire();
    assert.match(
      await call(tools, 'moderator', 'wake_every', {
        purpose: 'Diskussion im Blick',
        interval: '15m',
        until: inMin(24 * 60),
        max_runs: 50,
        actions: [{ type: 'turn', instruction: 'Fasse zusammen, was neu ist' }],
      }, HR_CHAT),
      /"created"/,
    );
    clock = new Date(clock.getTime() + 16 * MIN);
    assert.equal(await tick(wiring), 0, 'the LLM usage of the empty firing is empty');
    assert.deepEqual(modelTurns, []);
    const [t] = await wiring.service.listForContext('conversation', `teams:${HR_CHAT.conversationId}`);
    assert.equal(t?.lastOutcome, 'nothing');
    assert.equal(t?.runs, 1, 'it did fire');
    // Something new: the next firing reaches the model, once.
    await wiring.service.onEvent('conversation.message.created', { channelType: 'teams', conversationId: HR_CHAT.conversationId }, 'm1');
    clock = new Date(clock.getTime() + 15 * MIN);
    assert.equal(await tick(wiring), 1);
    assert.equal(modelTurns.length, 1);
  });

  it('criterion 22: a meeting that ends (channel session event) ends its hook and timer in one transaction', async () => {
    const { wiring, tools } = wire();
    // The kernel's own path: a channel's session event → the hub → the triggers.
    const hub = new SessionCapabilityHub({
      readiness: new ChannelProviderRegistry<ChannelReadinessProvider>('readiness', () => undefined),
      meetingSources: new ChannelProviderRegistry<MeetingSourceProvider>('meetingSource', () => undefined),
      identityFor: () => undefined,
      subscriptionsIn: () => [],
      principalOf: () => undefined,
    });
    const pending: Promise<void>[] = [];
    hub.observeLifecycle((event) => {
      pending.push(wiring.onSessionEvent(event));
    });
    const emit = async (kind: 'session_started' | 'session_ended', conversationId: string): Promise<void> => {
      hub.emitSessionEvent({
        channelId: 'de.byte5.channel.teams',
        channelType: 'teams',
        conversationId,
        sessionRef: `meeting-of-${conversationId}`,
        kind,
        occurredAt: clock.toISOString(),
      });
      await Promise.all(pending.splice(0));
    };

    const set = async (name: string, input: Record<string, unknown>, ref: unknown = MEETING): Promise<string> => {
      const out = JSON.parse(await call(tools, 'moderator', name, { context: 'meeting', until: inMin(120), ...input }, ref)) as { created: { id: string } };
      return out.created.id;
    };
    const hook = await set('on_event', { purpose: 'Neue Beiträge', event: 'conversation.message.created', max_fires: 100, actions: [{ type: 'post', template: 'Danke' }] });
    const timer = await set('wake_every', { purpose: 'Zeitwächter', interval: '5m', max_runs: 24, actions: [{ type: 'post', template: 'Noch Zeit' }] });
    const otherMeeting = { conversationId: '19:meeting_other@thread.v2' };
    const other = await set('wake_every', { purpose: 'Anderes Meeting', interval: '5m', max_runs: 24, actions: [{ type: 'post', template: 'x' }] }, otherMeeting);

    await emit('session_ended', MEETING.conversationId);

    assert.equal(await wiring.service.get(hook), undefined, 'the hook ended');
    assert.equal(await wiring.service.get(timer), undefined, 'the timer ended');
    assert.ok(await wiring.service.get(other), 'another meeting keeps its triggers');
    const ended = (await pool.query<{ trigger_id: string; xmin: string; detail: { reason: string } }>(
      `SELECT trigger_id, xmin::text AS xmin, detail FROM agent_trigger_audit WHERE trigger_id = ANY($1) AND event = 'ended'`,
      [[hook, timer]],
    )).rows;
    assert.equal(ended.length, 2);
    assert.ok(ended.every((r) => r.detail.reason === 'context_ended'));
    assert.equal(ended[0]?.xmin, ended[1]?.xmin, 'written by one transaction');
    // Nothing of it fires any more.
    clock = new Date(clock.getTime() + 6 * MIN);
    assert.equal(await wiring.service.onEvent('conversation.message.created', { channelType: 'teams', conversationId: MEETING.conversationId }, 'late'), 0);
    await tick(wiring);
    assert.equal(sent.filter((s) => JSON.stringify(s.ref) === JSON.stringify(MEETING)).length, 0);

    // The next meeting in the same chat starts: its timer runs again.
    await emit('session_started', MEETING.conversationId);
    sent.length = 0;
    await set('wake_every', { purpose: 'Zeitwächter 2', interval: '5m', max_runs: 24, actions: [{ type: 'turn', instruction: 'Fasse zusammen' }] });
    await wiring.service.onEvent('conversation.message.created', { channelType: 'teams', conversationId: MEETING.conversationId }, 'new');
    clock = new Date(clock.getTime() + 6 * MIN);
    await tick(wiring);
    assert.deepEqual(modelTurns, ['Fasse zusammen'], 'a reopened meeting is live again');
  });

  it('criterion 23: the month-end wakeup sends its owner the overview once and is gone, across a restart', async () => {
    const first = wire();
    const out = await call(first.tools, 'expenses', 'wake_at', {
      purpose: 'Offene Spesenberichte vor Monatsende',
      time: '2026-11-27T08:00:00.000Z',
      until: '2026-11-28T08:00:00.000Z',
      actions: [
        { type: 'check', check: 'data', action: { tool: 'expenses_open', input: {} }, condition: 'rows' },
        { type: 'deliver', action: { tool: 'expenses_open', input: {} }, title: 'Offene Spesenberichte' },
      ],
    }, OLGA_DM, 'olga');
    const id = (JSON.parse(out) as { created: { id: string } }).created.id;
    assert.equal(await tick(first.wiring), 0);
    assert.equal(sent.length, 0, 'nothing before it is due');

    // Restart: two fresh wirings on the same database tick at once.
    const a = wire();
    const b = wire();
    clock = new Date('2026-11-27T08:01:00Z');
    const calls = await Promise.all([tick(a.wiring), tick(b.wiring), tick(first.wiring)]);
    assert.deepEqual(calls, [0, 0, 0], 'the overview needs no model');
    assert.equal(sent.length, 1, 'fired exactly once');
    assert.deepEqual(sent[0]?.ref, OLGA_DM, 'to its owner, in the conversation she set it in');
    assert.deepEqual(sent[0]?.message.speaker, speakerOf('expenses'), 'from the expense agent');
    const table = sent[0]?.message.data?.[0];
    assert.equal(table?.kind, 'table');
    assert.equal(table?.kind === 'table' && table.rows.length, 2, 'the overview carries the open reports');
    assert.equal(await a.wiring.service.get(id), undefined, 'and is gone');
    clock = new Date('2026-11-27T09:00:00Z');
    await tick(a.wiring);
    assert.equal(sent.length, 1);
  });

  describe('proactive discretion (HR → sales)', () => {
    const hrLabels = unionLabels([{ kind: 'context', key: 'teams:19:hr-team', readers: readersOf(['anna', 'ben']) }]);
    const granted = (wiring: TriggerWiring): TriggerService =>
      new TriggerService({
        store: wiring.store,
        limits: DEFAULT_TRIGGER_LIMITS,
        eventSources: () => [],
        checkDataAction: () => undefined,
        // The recipient grant allows the sales chat as a target.
        targetAllowed: () => true,
        now: () => clock,
      });
    const envIn = (ref: { conversationId: string }, readers: readonly string[], contextKey: string): TriggerEnvelope => ({
      agentId: (agents.get('hr') as { id: string }).id,
      agentSlug: 'hr',
      origin: 'agent',
      ownerKey: null,
      contextKind: 'conversation',
      contextId: `teams:${ref.conversationId}`,
      liveContext: false,
      deliveryChannel: 'teams',
      deliveryRef: ref,
      // What the creating turn read: an HR record only anna and ben may know.
      discretion: { contextKey, readers: readersOf(readers), labels: hrLabels },
      createdBy: 'agent:hr',
    });

    it('criterion 24: with the sales chat granted as target, nothing reaches the sales chat', async () => {
      const { wiring } = wire();
      const res = await granted(wiring).create(
        'wake_at',
        {
          purpose: 'Austritt vorbereiten',
          time: inMin(10),
          until: inMin(60),
          target: { kind: 'conversation', channel: 'teams', ref: SALES_CHAT },
          actions: [{ type: 'post', template: 'Bitte die Austrittsunterlagen vorbereiten' }],
        },
        envIn(HR_CHAT, ['anna', 'ben'], 'teams:19:hr-team'),
      );
      assert.ok(res.ok, JSON.stringify(res));
      clock = new Date(clock.getTime() + 20 * MIN);
      await tick(wiring);
      assert.equal(sent.filter((s) => JSON.stringify(s.ref) === JSON.stringify(SALES_CHAT)).length, 0);
    });

    it('criterion 24: an HR-labelled trigger delivering into the sales chat is withheld at send time', async () => {
      const { wiring } = wire();
      // The HR read happened in a turn of the sales chat; the trigger was
      // granted at creation (no creation-time refusal to lean on).
      const res = await granted(wiring).create(
        'wake_at',
        {
          purpose: 'Austritt vorbereiten',
          time: inMin(10),
          until: inMin(60),
          target: { kind: 'conversation', channel: 'teams', ref: SALES_CHAT },
          actions: [{ type: 'post', template: 'Ben verlässt uns zum Monatsende' }],
        },
        envIn(SALES_CHAT, ['anna', 'ben', 'sam', 'tom'], 'teams:19:sales'),
      );
      assert.ok(res.ok, JSON.stringify(res));
      clock = new Date(clock.getTime() + 20 * MIN);
      await tick(wiring);
      assert.deepEqual(sent, [], 'withheld as a whole');
      const audit = (await pool.query<{ detail: Record<string, unknown> }>(
        `SELECT detail FROM agent_trigger_audit WHERE trigger_id = $1 AND event = 'fired'`,
        [res.trigger.id],
      )).rows;
      assert.match(JSON.stringify(audit), /withheld by discretion/);
    });
  });

  it('criterion 26: a 60-minute meeting with a 5-minute timer and a message hook: model calls only for the summary and moderation', async () => {
    const { wiring, tools } = wire();
    const set = async (name: string, input: Record<string, unknown>): Promise<void> => {
      assert.match(await call(tools, 'moderator', name, { context: 'meeting', ...input }, MEETING), /"created"/);
    };
    const end = new Date(clock.getTime() + 60 * MIN + 30_000).toISOString();
    await set('wake_every', { until: end, purpose: 'Zeitwächter', interval: '5m', max_runs: 12, actions: [{ type: 'post', template: 'Noch Zeit für diesen Schritt' }] });
    await set('on_event', {
      until: end,
      purpose: 'Fragen festhalten',
      event: 'conversation.message.created',
      max_fires: 50,
      filter: { op: 'eq', path: 'ctx.kind', value: 'question' },
      actions: [{ type: 'post', template: 'Notiert: Frage' }],
    });
    await set('on_event', {
      until: end,
      purpose: 'Moderation bei Abschweifen',
      event: 'conversation.message.created',
      max_fires: 10,
      filter: { op: 'eq', path: 'ctx.kind', value: 'off_topic' },
      actions: [{ type: 'turn', instruction: 'Hole die Runde freundlich zum Thema zurück' }],
    });
    await set('wake_at', { until: end, purpose: 'Zusammenfassung', time: new Date(clock.getTime() + 59 * MIN).toISOString(), actions: [{ type: 'turn', instruction: 'Fasse das Meeting zusammen' }] });

    let modelCalls = 0;
    const event = (kind: string, minute: number): Promise<number> =>
      wiring.service.onEvent(
        'conversation.message.created',
        { channelType: 'teams', conversationId: MEETING.conversationId, kind, authorId: `p${String(minute)}` },
        `${kind}-${String(minute)}`,
      );
    for (let minute = 1; minute <= 60; minute += 1) {
      clock = new Date(clock.getTime() + MIN);
      if (minute % 7 === 0) await event('question', minute);
      if (minute % 7 === 0) await event('chat', minute);
      if (minute === 20 || minute === 41) await event('off_topic', minute);
      modelCalls += await tick(wiring);
    }
    const texts = sent.map((s) => s.message.text);
    assert.equal(texts.filter((t) => t === 'Noch Zeit für diesen Schritt').length, 12);
    assert.equal(texts.filter((t) => t === 'Notiert: Frage').length, 8);
    assert.deepEqual(
      [...modelTurns].sort(),
      ['Fasse das Meeting zusammen', 'Hole die Runde freundlich zum Thema zurück', 'Hole die Runde freundlich zum Thema zurück'].sort(),
      'the model wrote only the summary and the two moderations',
    );
    assert.equal(modelCalls, 3, 'the gateway admitted exactly those three calls');
    assert.ok(sent.every((s) => s.message.speaker?.kind === 'agent' && s.message.speaker.agentId === agents.get('moderator')?.id));
  });

  it('criterion 35: a saved data action re-run after a no-rankings boundary is refused without running the tool', async () => {
    const { wiring, tools } = wire();
    // Set while the agent had no boundaries.
    const out = await call(tools, 'sales', 'wake_every', {
      purpose: 'Top-Kunden jeden Morgen',
      interval: '1d',
      until: inMin(10 * 24 * 60),
      max_runs: 10,
      actions: [{ type: 'deliver', action: { tool: 'odoo_query', input: TOP_CUSTOMERS }, title: 'Top-Kunden' }],
    }, SALES_CHAT);
    assert.match(out, /"created"/);
    clock = new Date(clock.getTime() + DAY + MIN);
    await tick(wiring);
    assert.deepEqual(toolRuns, ['odoo_query'], 'allowed before the boundary');
    assert.equal(sent.length, 1);

    // The operator forbids rankings of individual customers: the rebuilt
    // agent's guard is what the stored action meets on its next run.
    guard = createDataPlanGuard({ boundaries: { presets: ['no-individual-rankings'] } });
    clock = new Date(clock.getTime() + DAY + MIN);
    await tick(wiring);
    assert.deepEqual(toolRuns, ['odoo_query'], 'the tool did not run again');
    assert.equal(sent.length, 1, 'nothing was delivered');
    const [t] = await wiring.service.listForContext('conversation', `teams:${SALES_CHAT.conversationId}`);
    assert.match(t?.lastError ?? '', /refused by the agent's boundaries/);
  });
});
