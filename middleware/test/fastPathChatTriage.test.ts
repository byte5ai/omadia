/**
 * Fast path for every non-canvas channel (`@omadia/fast-path`).
 *
 *   - service: ONE fast-model triage per turn; a deterministic decision runs
 *     the ONE query and renders summary + markdown table (rows capped, never
 *     sent to a model); an agent decision carries the simple/complex route;
 *     misses are reasoned; the prompt is masked through the privacy guard's
 *     stored-text scope and skipped under the force-guarded policy; the
 *     channel filter; the shared learned store feeds the triage and books
 *     executions; the previous query of a conversation rides along;
 *   - wrapper (harness-orchestrator): a hit streams text_delta + done, is
 *     recorded through the session logger and never calls the inner agent;
 *     an agent decision passes the route as `routeHint`; commands,
 *     attachments, canvas/system turns pass through untriaged;
 *   - orchestrator: a `routeHint` replaces the router's own classifier call.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { InMemoryNudgeRegistry } from '@omadia/plugin-api';
import type {
  EntityRefBus,
  KnowledgeGraph,
  MemoryStore,
  PrivacyGuardService,
  PrivacyPromptMaskResult,
} from '@omadia/plugin-api';

import type { ChatAgent, ChatStreamEvent, ChatTurnInput } from '../packages/harness-channel-sdk/src/index.js';
import { parseFastPathChannels, renderChatAnswer } from '../packages/harness-plugin-fast-path/src/chatAnswer.js';
import { createLearnedPlanStore, type LearnedPlanStore } from '../packages/harness-plugin-fast-path/src/learnedPlanStore.js';
import { createFastPathService, type ChatTriageOutcome } from '../packages/harness-plugin-fast-path/src/service.js';
import { parseTriage, withRouterPlanner } from './_helpers/fastPathRouterPlanner.js';
import type { OrchestratorDeps } from '../packages/harness-orchestrator/src/buildOrchestrator.js';
import {
  channelOfTurn,
  passThroughReason,
  wrapChatAgentWithFastPath,
  type FastPathTriagePort,
} from '../packages/harness-orchestrator/src/fastPathAgent.js';
import type { NativeToolRegistry } from '../packages/harness-orchestrator/src/nativeToolRegistry.js';
import type { SessionLogEntry } from '../packages/harness-orchestrator/src/sessionLogger.js';
import type { AgentRow } from '../packages/harness-orchestrator/src/registry/configStore.js';
import { buildForAgent } from '../packages/harness-orchestrator/src/registry/applyDiff.js';

// ── fixtures ──────────────────────────────────────────────────────────────

const EMPLOYEES = [
  { id: 1, name: 'Anna Schmidt', department_id: [3, 'Sales'], birthday: '1990-01-12' },
  { id: 2, name: 'Peter Wagner', department_id: [4, 'R&D'], birthday: '1985-01-30' },
  { id: 3, name: 'Klaus Meier', department_id: [3, 'Sales'], birthday: '1979-02-02' },
];
const odooOutput = (records: unknown[], truncated = false): string =>
  JSON.stringify({ model: 'hr.employee', scope: 'hr', count: records.length, truncated, records });

const BIRTHDAY_FETCH = {
  tool: 'odoo_query',
  input: { model: 'hr.employee', fields: ['name', 'department_id', 'birthday'], limit: 100 },
  map: { name: 'name', department: 'department_id.1', birthday: 'birthday' },
  rowKey: 'id',
  filter: [{ field: 'birthday', datePart: 'month', eq: 1 }],
};
const deterministic = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    decision: 'deterministic',
    fetch: BIRTHDAY_FETCH,
    labels: { name: 'Name', department: 'Abteilung', birthday: 'Geburtstag' },
    summary: '{count} Mitarbeitende haben im Januar Geburtstag.',
    locale: 'de-DE',
    ...over,
  });

interface ServiceHarness {
  triage: (msg: string, over?: { channel?: string; sessionKey?: string }) => Promise<ChatTriageOutcome>;
  logs: string[];
  prompts: Array<{ system?: string; content: string }>;
  invokes: Array<{ name: string; input: unknown }>;
  s: { reply: string };
  plans: LearnedPlanStore;
}

function fakeGuard(opts: { refuse?: boolean } = {}): PrivacyGuardService {
  return {
    openStoredTextScope: () => ({
      maskStoredText: (text: string): Promise<PrivacyPromptMaskResult> =>
        Promise.resolve(
          opts.refuse
            ? { outcome: 'blocked', reason: 'residual span' }
            : { outcome: 'masked', maskedText: text.split('Anna Schmidt').join('Lukas Becker'), spans: [], degraded: false },
        ),
      restoreStoredText: (text: string) => text.split('Lukas Becker').join('Anna Schmidt'),
    }),
  } as unknown as PrivacyGuardService;
}

function serviceHarness(opts: {
  config?: Record<string, string>;
  invoke?: (name: string, input: unknown) => Promise<string>;
  guard?: PrivacyGuardService;
  forced?: boolean;
  plans?: LearnedPlanStore;
  /** the answering agent's own tools (default: odoo_query) */
  permitted?: string[];
} = {}): ServiceHarness {
  const logs: string[] = [];
  const prompts: Array<{ system?: string; content: string }> = [];
  const invokes: Array<{ name: string; input: unknown }> = [];
  const s = { reply: deterministic() };
  const plans = opts.plans ?? createLearnedPlanStore({ log: (m) => logs.push(m) });
  const service = createFastPathService({
    config: { get: <T>(k: string): T | undefined => opts.config?.[k] as T | undefined },
    llm: withRouterPlanner({
      complete: (req: { system?: string; messages: ReadonlyArray<{ content: string }> }) => {
        prompts.push({ ...(req.system !== undefined ? { system: req.system } : {}), content: req.messages[0]?.content ?? '' });
        return Promise.resolve({ text: s.reply });
      },
    }),
    model: 'class:fast',
    invoke: (name, input) => {
      invokes.push({ name, input });
      return opts.invoke ? opts.invoke(name, input) : Promise.resolve(odooOutput(EMPLOYEES));
    },
    privacyGuard: () => opts.guard,
    privacyForced: () => opts.forced === true,
    log: (m) => logs.push(m),
    plans,
  });
  return {
    triage: (msg, over) =>
      service.triageChatTurn({
        channel: over?.channel ?? 'web',
        userMessage: msg,
        permittedTools: new Set(opts.permitted ?? ['odoo_query']),
        ...(over?.sessionKey ? { sessionKey: over.sessionKey } : {}),
      }),
    logs,
    prompts,
    invokes,
    s,
    plans,
  };
}

// ── service ───────────────────────────────────────────────────────────────

describe('fast-path chat triage — service', () => {
  it('deterministic hit: runs the ONE query, renders summary + markdown table', async () => {
    const h = serviceHarness();
    const out = await h.triage('Wer hat im Januar Geburtstag?');
    assert.equal(out.kind, 'answer');
    if (out.kind !== 'answer') return;
    assert.equal(out.rows, 2);
    assert.equal(out.tool, 'odoo_query');
    assert.equal(h.invokes.length, 1);
    assert.equal(
      out.text,
      [
        '2 Mitarbeitende haben im Januar Geburtstag.',
        '',
        '| Name | Abteilung | Geburtstag |',
        '| --- | --- | --- |',
        '| Anna Schmidt | Sales | 1990-01-12 |',
        '| Peter Wagner | R&D | 1985-01-30 |',
      ].join('\n'),
    );
    assert.ok(
      h.logs.some((m) => /^\[fast-path\] router channel=web decision=deterministic tool=odoo_query conf=0\.90 ms=\d+$/.test(m)),
      h.logs.join(' | '),
    );
    assert.ok(h.logs.some((m) => /^\[fast-path\] planner channel=web tool=odoo_query ok ms=\d+$/.test(m)));
    assert.equal(h.prompts.length, 2, 'one router call + one planner call');
    // timing order: the speculative planner is started first, the router right after — same user message
    assert.match(h.prompts[0]?.system ?? '', /fast-path planner/);
    assert.match(h.prompts[1]?.system ?? '', /fast-path router/);
    assert.equal(h.prompts[0]?.content, 'USER TURN: Wer hat im Januar Geburtstag?');
    assert.equal(h.prompts[1]?.content, h.prompts[0]?.content);
    assert.ok(h.logs.some((m) => /^\[fast-path\] hit channel=web tool=odoo_query rows=2 ms=\d+$/.test(m)));
    // the triage model got the message, never a row
    assert.ok(!h.prompts.some((p) => p.content.includes('1985-01-30')));
  });

  it('agent decision carries the route; no query runs', async () => {
    const h = serviceHarness();
    h.s.reply = '{"decision":"agent","route":"complex"}';
    const out = await h.triage('Analysiere die Umsatzentwicklung und schlage Maßnahmen vor');
    assert.deepEqual({ kind: out.kind, route: out.kind === 'agent' ? out.route : undefined }, { kind: 'agent', route: 'complex' });
    assert.equal(h.invokes.length, 0);
    assert.ok(h.logs.some((m) => /^\[fast-path\] router channel=web decision=agent_complex tool=- conf=0\.90 ms=\d+$/.test(m)));
    assert.equal(h.prompts.length, 2, 'router + the speculative planner');
    assert.ok(h.logs.includes('[fast-path] planner discarded (route=agent:complex)'));
  });

  it('misses are reasoned and route-less: router/planner invalid, tool error, truncated, unknown tool', async () => {
    const wide = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, 'name']));
    const cases: Array<[string, Partial<Parameters<typeof serviceHarness>[0]>, string]> = [
      [deterministic({ fetch: { ...BIRTHDAY_FETCH, tool: 'odoo_execute' } }), {}, 'router-tool-not-offered'],
      ['nonsense', {}, 'router-invalid'],
      [deterministic({ fetch: { ...BIRTHDAY_FETCH, map: wide } }), {}, 'planner-invalid:too-many-columns'],
      [deterministic(), { invoke: () => Promise.resolve('Error: odoo down') }, 'tool-error'],
      [deterministic(), { invoke: () => Promise.resolve(odooOutput(EMPLOYEES, true)) }, 'truncated'],
    ];
    for (const [reply, opts, reason] of cases) {
      const h = serviceHarness(opts);
      h.s.reply = reply;
      const out = await h.triage('Geburtstage im Januar');
      assert.equal(out.kind, 'agent', reason);
      assert.equal(out.kind === 'agent' ? out.reason : '', reason);
      assert.equal(out.kind === 'agent' ? out.route : 'x', undefined);
      assert.ok(h.logs.includes(`[fast-path] miss channel=web reason=${reason}`), `${reason}: ${h.logs.join(' | ')}`);
    }
  });

  it('privacy: the prompt goes through the stored-text scope and the plan is restored', async () => {
    const h = serviceHarness({ guard: fakeGuard() });
    h.s.reply = deterministic({
      fetch: { ...BIRTHDAY_FETCH, input: { ...BIRTHDAY_FETCH.input, domain: [['name', 'ilike', 'Lukas Becker']] }, filter: undefined },
      summary: '{count} Treffer.',
    });
    const out = await h.triage('Geburtstag von Anna Schmidt?');
    assert.equal(out.kind, 'answer');
    assert.ok(h.prompts[0]?.content.includes('Lukas Becker'));
    assert.ok(!h.prompts[0]?.content.includes('Anna Schmidt'), 'the real name never reaches the model');
    const domain = (h.invokes[0]?.input as { domain: unknown[] }).domain;
    assert.deepEqual(domain, [['name', 'ilike', 'Anna Schmidt']], 'the query runs with the restored value');
  });

  it('privacy: a refused mask and the force-guarded policy skip the model call', async () => {
    const refused = serviceHarness({ guard: fakeGuard({ refuse: true }) });
    const a = await refused.triage('Geburtstage im Januar');
    assert.equal(a.kind === 'agent' ? a.reason : '', 'privacy-refused');
    assert.equal(refused.prompts.length, 0);
    const forced = serviceHarness({ forced: true });
    const b = await forced.triage('Geburtstage im Januar');
    assert.equal(b.kind === 'agent' ? b.reason : '', 'privacy-forced');
    assert.equal(forced.prompts.length, 0);
  });

  it('channel filter and kill switch: no model call at all', async () => {
    const off = serviceHarness({ config: { fast_path_channels: 'web,canvas' } });
    const out = await off.triage('Geburtstage im Januar', { channel: 'teams' });
    assert.equal(out.kind === 'agent' ? out.reason : '', 'disabled');
    assert.equal(off.prompts.length, 0);
    const killed = serviceHarness({ config: { fast_path_tools: '' } });
    assert.equal((await killed.triage('Geburtstage im Januar')).kind, 'agent');
    assert.equal(killed.prompts.length, 0);
    assert.equal(parseFastPathChannels('none')('web'), false);
    assert.equal(parseFastPathChannels(undefined)('telegram'), true);
    assert.equal(parseFastPathChannels(' Teams , web ')('teams'), true);
  });

  it('follow-up: the previous query of the conversation rides in the next prompt', async () => {
    const h = serviceHarness();
    await h.triage('Geburtstage im Januar', { sessionKey: 'sess-1' });
    await h.triage('und im Februar?', { sessionKey: 'sess-1' });
    await h.triage('und im März?', { sessionKey: 'other' });
    // per turn: [planner, router] — the planner starts first (speculative)
    // and both get the SAME user-derived turn message
    assert.equal(h.prompts.length, 6);
    assert.ok(!h.prompts[0]?.content.includes('PREVIOUS QUERY'));
    assert.ok(h.prompts[2]?.content.startsWith('PREVIOUS QUERY: user asked "Geburtstage im Januar" → {"tool":"odoo_query"'));
    assert.equal(h.prompts[3]?.content, h.prompts[2]?.content, 'router and planner share the message');
    assert.ok(!h.prompts[4]?.content.includes('PREVIOUS QUERY'), 'never across conversations');
  });

  it('shared store: active learned plans are offered and their executions booked', async () => {
    const logs: string[] = [];
    const plans = createLearnedPlanStore({ log: (m) => logs.push(m) });
    const candidate = {
      tool: 'odoo_query',
      inputTemplate: BIRTHDAY_FETCH.input,
      map: BIRTHDAY_FETCH.map,
      filter: [{ field: 'birthday', datePart: 'month' as const, eq: 1 }],
      rowKey: 'id',
      example: 'geburtstage im januar',
    };
    await plans.recordSuccess(candidate);
    const { plan } = await plans.recordSuccess(candidate);
    assert.equal(plan.active, true);
    const h = serviceHarness({ plans });
    await h.triage('Geburtstage im Januar');
    assert.ok(h.prompts.some((p) => p.system?.includes('LEARNED INTENTS')), 'the router sees the intent');
    assert.ok(h.prompts.some((p) => p.system?.includes('VALIDATED EXAMPLES')), 'the planner sees the template');
    assert.ok(!h.prompts.some((p) => /LEARNED INTENTS|VALIDATED EXAMPLES/.test(p.content)), 'fixed text never in the user message');
    assert.ok(h.logs.some((m) => m.includes(`plan=${plan.id}`)), 'the hit is attributed to the learned plan');
    // a failing execution of the same plan counts against it
    const failing = serviceHarness({ plans, invoke: () => Promise.resolve('Error: down') });
    await failing.triage('Geburtstage im Januar');
    await failing.triage('Geburtstage im Januar');
    assert.equal(plans.get(plan.id)?.active, false, 'two consecutive failures deactivate it');
  });

  it('an agent WITHOUT odoo_query: never offered, a plan naming it is rejected (tool-not-permitted)', async () => {
    // the agent has a learned read tool, so the triage runs — but odoo_query
    // is not among its tools
    const plans = createLearnedPlanStore({ log: () => {} });
    const contracts = {
      tool: 'search_contracts',
      inputTemplate: { query: '{{text_1}}', limit: 50 },
      map: { number: 'ref' },
      itemsPath: 'items',
      example: 'vertraege von {{text_1}} geburtstage im januar',
    };
    await plans.recordSuccess(contracts);
    await plans.recordSuccess(contracts);
    const h = serviceHarness({ plans, permitted: ['search_contracts'] });
    const out = await h.triage('Geburtstage im Januar');
    assert.equal(h.prompts.length, 2, 'router + speculative planner');
    assert.ok(!h.prompts.some((p) => (p.system ?? '').includes('odoo_query —')), 'odoo_query spec never offered');
    assert.ok(h.prompts.every((p) => (p.system ?? '').includes('search_contracts')), 'both see only the permitted tool');
    assert.equal(out.kind === 'agent' ? out.reason : '', 'router-tool-not-offered');
    assert.equal(h.invokes.length, 0, 'nothing ran');
    // no plannable tool of its own at all → not even a model call
    const bare = serviceHarness({ permitted: ['memory'] });
    const r = await bare.triage('Geburtstage im Januar');
    assert.equal(r.kind === 'agent' ? r.reason : '', 'no-tools');
    assert.equal(bare.prompts.length, 0);
    // the same agent WITH odoo_query → hit
    const full = serviceHarness({ permitted: ['odoo_query', 'search_contracts'] });
    assert.equal((await full.triage('Geburtstage im Januar')).kind, 'answer');
  });

  it('table rendering: capped rows with a localized truncation note, cells escaped', () => {
    const rows = Array.from({ length: 53 }, (_, i) => ({ a: `x|${i}`, b: 'line1\nline2' }));
    const text = renderChatAnswer({ summary: 'S', rows, columns: ['a', 'b'], labels: { a: 'A' }, locale: 'de-DE' });
    const lines = text.split('\n');
    assert.equal(lines.filter((l) => l.startsWith('| x')).length, 50);
    assert.ok(text.includes('| x\\|0 | line1 line2 |'));
    assert.ok(text.endsWith('_3 weitere Zeilen nicht angezeigt (erste 50)._'));
    assert.equal(renderChatAnswer({ summary: 'Keine.', rows: [], columns: ['a'], labels: {} }), 'Keine.');
  });

  it('parseTriage refuses unfilled placeholders and too many columns', () => {
    const allowed = new Set(['odoo_query']);
    const ph = parseTriage(deterministic({ fetch: { ...BIRTHDAY_FETCH, input: { model: 'x', domain: [['name', 'ilike', '{{text_1}}']] } } }), allowed);
    assert.deepEqual(ph, { decision: 'invalid', reason: 'unfilled-placeholder' });
    const map = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, `f${i}`]));
    assert.deepEqual(parseTriage(deterministic({ fetch: { ...BIRTHDAY_FETCH, map } }), allowed), {
      decision: 'invalid',
      reason: 'too-many-columns',
    });
    assert.deepEqual(parseTriage('{"decision":"agent"}', allowed), { decision: 'agent' });
  });
});

// ── wrapper ───────────────────────────────────────────────────────────────

function innerAgent(): ChatAgent & { inputs: ChatTurnInput[] } {
  const inputs: ChatTurnInput[] = [];
  return {
    inputs,
    chat: (input) => {
      inputs.push(input);
      return Promise.resolve({ text: 'agent', attachments: [] } as never);
    },
    async *chatStream(input) {
      inputs.push(input);
      await Promise.resolve();
      yield { type: 'text_delta', text: 'agent' };
      yield { type: 'done', answer: 'agent', toolCalls: 0, iterations: 1 };
    },
    holdsContentUntilVerdict: true,
  };
}

function port(outcome: ChatTriageOutcome, calls: string[] = []): FastPathTriagePort {
  return {
    channelEnabled: () => true,
    triageChatTurn: (req) => {
      calls.push(`${req.channel}:${req.userMessage}`);
      return Promise.resolve(outcome);
    },
  };
}

const HIT: ChatTriageOutcome = { kind: 'answer', text: '2 Treffer.\n\n| A |\n| --- |\n| x |', tool: 'odoo_query', rows: 1, toolCalls: 1, ms: 5 };

async function collect(it: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('fast-path chat triage — wrapper', () => {
  it('hit: streams text_delta + done, records the turn, never calls the inner agent', async () => {
    const inner = innerAgent();
    const logged: SessionLogEntry[] = [];
    const agent = wrapChatAgentWithFastPath(inner, {
      fastPath: () => port(HIT),
      logSession: (e) => {
        logged.push(e);
        return Promise.resolve({ turnExternalId: 'turn:sess-1:t' });
      },
      privacyGuarded: () => true,
      permittedTools: () => new Set(['odoo_query']),
      log: () => {},
    });
    const events = await collect(agent.chatStream({ userMessage: 'Geburtstage?', sessionScope: 'sess-1', userId: 'u1' }));
    assert.equal(inner.inputs.length, 0);
    assert.deepEqual(events, [
      { type: 'text_delta', text: HIT.kind === 'answer' ? HIT.text : '' },
      { type: 'done', answer: HIT.kind === 'answer' ? HIT.text : '', toolCalls: 1, iterations: 0, turnId: 'turn:sess-1:t' },
    ]);
    assert.equal(logged.length, 1);
    assert.equal(logged[0]?.scope, 'sess-1');
    assert.equal(logged[0]?.userMessage, 'Geburtstage?');
    assert.equal(logged[0]?.userId, 'u1');
    assert.deepEqual(logged[0]?.maskedView, { userMessage: '', assistantAnswer: '' }, 'no capture model sees the rows');
    assert.equal(logged[0]?.unprotected, false);
    assert.equal(agent.holdsContentUntilVerdict, true, 'forwarded unchanged');
    // non-streaming channels (Teams/Telegram) get the same answer
    const semantic = await agent.chat({ userMessage: 'Geburtstage?', sessionScope: 'sess-1' });
    assert.equal(semantic.text, HIT.kind === 'answer' ? HIT.text : '');
    assert.equal(inner.inputs.length, 0);
  });

  it('agent decision: inner runs with the route hint; a miss passes the input unchanged', async () => {
    const inner = innerAgent();
    const routed = wrapChatAgentWithFastPath(inner, {
      fastPath: () => port({ kind: 'agent', route: 'simple', reason: 'agent:simple', ms: 1 }),
      privacyGuarded: () => false,
      permittedTools: () => new Set(['odoo_query']),
      log: () => {},
    });
    await collect(routed.chatStream({ userMessage: 'Hallo!', sessionScope: 'sess-1' }));
    assert.equal(inner.inputs[0]?.routeHint, 'simple');
    const input: ChatTurnInput = { userMessage: 'Erkläre X', sessionScope: 'sess-1' };
    const missed = wrapChatAgentWithFastPath(inner, {
      fastPath: () => port({ kind: 'agent', reason: 'tool-error', ms: 1 }),
      privacyGuarded: () => false,
      permittedTools: () => new Set(['odoo_query']),
      log: () => {},
    });
    const events = await collect(missed.chatStream(input));
    assert.equal(inner.inputs[1], input, 'the very same input object');
    assert.equal(events.at(-1)?.type, 'done');
    // no service at all → inner unchanged
    const none = wrapChatAgentWithFastPath(inner, { fastPath: () => undefined, privacyGuarded: () => false,
      permittedTools: () => new Set(['odoo_query']), log: () => {} });
    await none.chat(input);
    assert.equal(inner.inputs[2], input);
  });

  it('an agent whose tool set is unknown gets no fast path (fail closed)', async () => {
    const calls: string[] = [];
    const logs: string[] = [];
    const inner = innerAgent();
    const agent = wrapChatAgentWithFastPath(inner, {
      fastPath: () => port(HIT, calls),
      permittedTools: () => undefined,
      privacyGuarded: () => false,
      log: (m) => logs.push(m),
    });
    await collect(agent.chatStream({ userMessage: 'Geburtstage?', sessionScope: 'tab_1' }));
    assert.deepEqual(calls, []);
    assert.equal(inner.inputs.length, 1, 'the inner agent answers');
    assert.ok(logs.includes('[fast-path] miss channel=web reason=tool-set-unknown'));
  });

  it('commands, attachments, canvas, actions, system and empty turns are never triaged', async () => {
    const calls: string[] = [];
    const inner = innerAgent();
    const agent = wrapChatAgentWithFastPath(inner, { fastPath: () => port(HIT, calls), privacyGuarded: () => false,
      permittedTools: () => new Set(['odoo_query']), log: () => {} });
    const skipped: ChatTurnInput[] = [
      { userMessage: '/help', sessionScope: 's' },
      { userMessage: 'Was zeigt das Bild?', sessionScope: 's', attachments: [{ kind: 'image', url: 'u', mediaType: 'image/png' }] },
      { userMessage: 'Geburtstage', sessionScope: 's', canvasSessionId: 'cs' },
      { userMessage: 'Details', sessionScope: 's', action: { type: 'row' } },
      { userMessage: 'Geburtstage', sessionScope: 'schedule:abc' },
      { userMessage: 'Geburtstage', sessionScope: 'conductor:run:step' },
      { userMessage: 'Geburtstage' },
      { userMessage: '   ', sessionScope: 's' },
      { userMessage: 'Geburtstage', sessionScope: 's', extraSystemHint: 'retry' },
      { userMessage: 'Geburtstage', sessionScope: 's', freshCheck: true },
    ];
    for (const input of skipped) await collect(agent.chatStream(input));
    assert.deepEqual(calls, []);
    assert.equal(inner.inputs.length, skipped.length);
    assert.equal(passThroughReason({ userMessage: 'Geburtstage', sessionScope: 's' }), undefined);
  });

  it('channel of a turn: origin, channel identity, scope shape', () => {
    assert.equal(channelOfTurn({ userMessage: 'x', sessionScope: 'abc', origin: { channelType: 'Telegram' } as never }), 'telegram');
    assert.equal(channelOfTurn({ userMessage: 'x', channelIdentity: { channelKind: 'teams', channelUserId: 'u' } }), 'teams');
    assert.equal(channelOfTurn({ userMessage: 'x', sessionScope: 'http-cli' }), 'http');
    assert.equal(channelOfTurn({ userMessage: 'x', sessionScope: 'tab_123' }), 'web');
  });
});

// ── orchestrator wiring ───────────────────────────────────────────────────

const ODOO_QUERY_ENTRY = {
  name: 'odoo_query',
  spec: { name: 'odoo_query', description: 'Odoo read', input_schema: { type: 'object' } },
  handler: () => Promise.resolve('{}'),
};

function orchestratorDeps(
  fastPath?: () => FastPathTriagePort | undefined,
  nativeEntries: ReadonlyArray<typeof ODOO_QUERY_ENTRY> = [],
): OrchestratorDeps {
  const names = new Set<string>();
  return {
    // never called: the classifier would be the only provider use, and the
    // tests below either hit the fast path or short-circuit routing
    provider: {
      id: 'fake',
      complete: () => Promise.reject(new Error('no network in tests')),
    } as unknown as OrchestratorDeps['provider'],
    knowledgeGraph: {} as KnowledgeGraph,
    memoryStore: {} as MemoryStore,
    entityRefBus: {} as EntityRefBus,
    nativeToolRegistry: {
      get: (n: string) => nativeEntries.find((e) => e.name === n),
      listWithHandler: () => nativeEntries,
      has: (n: string) => names.has(n),
      register: (n: string) => {
        names.add(n);
        return () => names.delete(n);
      },
    } as unknown as NativeToolRegistry,
    nudgeRegistry: new InMemoryNudgeRegistry(),
    responseGuard: () => undefined,
    privacyGuard: () => undefined,
    ...(fastPath ? { fastPath } : {}),
  };
}

const AGENT_ROW: AgentRow = {
  id: '00000000-0000-0000-0000-000000000001',
  slug: 'accounting',
  name: 'accounting',
  description: null,
  privacyProfile: 'default',
  status: 'enabled',
  createdAt: new Date(0),
  updatedAt: new Date(0),
};
const RUNTIME = {
  model: 'm',
  maxTokens: 100,
  maxToolIterations: 4,
  modelRouting: { classifierModel: 'haiku', simpleModel: 'sonnet', complexModel: 'opus' },
};

describe('fast-path chat triage — orchestrator wiring', () => {
  it("the triage gets exactly the Agent's own tool list", async () => {
    const seen: Array<ReadonlySet<string>> = [];
    const recording: FastPathTriagePort = {
      channelEnabled: () => true,
      triageChatTurn: (req) => {
        seen.push(req.permittedTools);
        return Promise.resolve(HIT);
      },
    };
    const withOdoo = buildForAgent(AGENT_ROW, orchestratorDeps(() => recording, [ODOO_QUERY_ENTRY]), RUNTIME);
    const without = buildForAgent(AGENT_ROW, orchestratorDeps(() => recording, []), RUNTIME);
    await collect(withOdoo.bundle.agent.chatStream({ userMessage: 'Geburtstage?', sessionScope: 'tab_1' }));
    await collect(without.bundle.agent.chatStream({ userMessage: 'Geburtstage?', sessionScope: 'tab_1' }));
    assert.equal(seen[0]?.has('odoo_query'), true);
    assert.equal(seen[1]?.has('odoo_query'), false);
    assert.equal(without.bundle.agent.offeredToolNames?.().has('odoo_query'), false);
  });

  it('every built bundle agent answers a hit itself (outside the verifier)', async () => {
    const built = buildForAgent(AGENT_ROW, orchestratorDeps(() => port(HIT)), RUNTIME);
    const events = await collect(built.bundle.agent.chatStream({ userMessage: 'Geburtstage?', sessionScope: 'tab_1' }));
    assert.deepEqual(
      events.map((e) => e.type),
      ['text_delta', 'done'],
    );
    const bare = buildForAgent(AGENT_ROW, orchestratorDeps(), RUNTIME);
    assert.equal(bare.bundle.agent, bare.orchestrator, 'no fast path dep → no wrapper');
  });

  it('a routeHint replaces the router classifier call', async () => {
    const built = buildForAgent(AGENT_ROW, orchestratorDeps(), RUNTIME);
    const resolve = (
      built.orchestrator as unknown as {
        resolveTurnModel(m: string, h?: 'simple' | 'complex'): Promise<{ model: string; routing?: { bucket: string } }>;
      }
    ).resolveTurnModel.bind(built.orchestrator);
    // the classifier would need the network — the hint must short-circuit it
    assert.deepEqual(await resolve('Hallo', 'simple'), {
      model: 'sonnet',
      routing: { bucket: 'simple', classifierModel: 'haiku', model: 'sonnet' },
    });
    assert.equal((await resolve('Plane X', 'complex')).model, 'opus');
    const unrouted = buildForAgent(AGENT_ROW, orchestratorDeps(), { ...RUNTIME, modelRouting: undefined });
    const r = await (
      unrouted.orchestrator as unknown as { resolveTurnModel(m: string, h?: string): Promise<{ model: string }> }
    ).resolveTurnModel('Hallo', 'simple');
    assert.equal(r.model, 'm', 'routing off → the hint is ignored');
  });
});
