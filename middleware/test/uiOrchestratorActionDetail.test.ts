/**
 * Canvas ACTION turns through the fast path: a row action ("Details") on a
 * table whose rows came from a recipe carries the target row's identity
 * (record id + model from the table's current recipe) to the composer, which
 * plans ONE deterministic detail query — rendered into a new canvas, no agent
 * turn. A plan that does not query exactly that record, or a target without a
 * recipe, falls back to the agent unchanged.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { withRouterPlanner, type ForcedCall } from './_helpers/fastPathRouterPlanner.js';

import {
  CHAT_AGENT_SERVICE,
  type ChatAgentBundle,
  type ChatStreamEvent,
  type ChatTurnInput,
} from '../packages/harness-channel-sdk/src/index.js';
import type { PluginContext } from '../packages/plugin-api/src/index.js';
import { createFastPathService, FAST_PATH_SERVICE } from '../packages/harness-plugin-fast-path/src/service.js';
import { activate } from '../packages/omadia-ui-orchestrator/src/plugin.js';

const INVOICES = [
  { id: 11, name: 'RE/2026/0001', partner_id: [7, 'Müller GmbH'], amount_residual: 100, currency_id: [1, 'EUR'] },
  { id: 12, name: 'RE/2026/0002', partner_id: [8, 'Weber KG'], amount_residual: 50, currency_id: [1, 'EUR'] },
];
const DETAIL = [
  { id: 11, name: 'RE/2026/0001', partner_id: [7, 'Müller GmbH'], invoice_date: '2026-01-10', invoice_date_due: '2026-02-10', amount_total: 119, amount_residual: 100, state: 'posted' },
];
const out = (records: unknown[]): string => JSON.stringify({ model: 'account.move', count: records.length, truncated: false, records });

const LIST_FETCH = {
  tool: 'odoo_query',
  input: { model: 'account.move', domain: [['move_type', '=', 'out_invoice']], fields: ['name', 'partner_id', 'amount_residual', 'currency_id'], limit: 100 },
  map: { number: 'name', partner: 'partner_id.1', open: 'amount_residual' },
  rowKey: 'id',
};
const listComposer = JSON.stringify({
  tree: {
    type: 'container', id: 'root', layout: 'stack',
    children: [{ type: 'table', id: 'invoices', loading: 'skeleton', columns: [{ fieldKey: 'number', label: 'Nr' }, { fieldKey: 'partner', label: 'Kunde' }, { fieldKey: 'open', label: 'Offen' }], rows: [] }],
  },
  dataRequirements: [{ containerId: 'invoices', description: 'Rechnungen', fields: [{ fieldKey: 'number', label: 'Nr' }, { fieldKey: 'partner', label: 'Kunde' }, { fieldKey: 'open', label: 'Offen' }], fetch: LIST_FETCH }],
  summary: '{count} Rechnungen.',
});
const detailComposer = (id: number): string =>
  JSON.stringify({
    tree: {
      type: 'container', id: 'root', layout: 'stack',
      children: [{ type: 'table', id: 'detail', loading: 'skeleton', columns: [{ fieldKey: 'number', label: 'Nr' }, { fieldKey: 'due', label: 'Fällig' }, { fieldKey: 'total', label: 'Gesamt' }], rows: [] }],
    },
    dataRequirements: [{
      containerId: 'detail', description: 'Rechnungsdetails',
      fields: [{ fieldKey: 'number', label: 'Nr' }, { fieldKey: 'due', label: 'Fällig' }, { fieldKey: 'total', label: 'Gesamt' }],
      fetch: {
        tool: 'odoo_query',
        input: { model: 'account.move', domain: [['id', '=', id]], fields: ['name', 'invoice_date_due', 'amount_total'], limit: 100 },
        map: { number: 'name', due: 'invoice_date_due', total: 'amount_total' },
        rowKey: 'id',
      },
    }],
    summary: 'Details zur Rechnung ({count} Datensatz).',
  });

async function harness(): Promise<{
  agent: ChatAgentBundle['agent'];
  logs: string[];
  composerUsers: string[];
  forced: ForcedCall[];
  invokes: Array<{ name: string; input: unknown }>;
  baseInputs: ChatTurnInput[];
  s: { composer: string };
  logged: Array<Record<string, unknown>>;
}> {
  const logged: Array<Record<string, unknown>> = [];
  const reg = new Map<string, unknown>();
  const logs: string[] = [];
  const composerUsers: string[] = [];
  const forced: ForcedCall[] = [];
  const invokes: Array<{ name: string; input: unknown }> = [];
  const baseInputs: ChatTurnInput[] = [];
  const s = { composer: listComposer };
  const ctx = {
    log: (m: string) => logs.push(m),
    services: {
      get: <T>(name: string): T | undefined => reg.get(name) as T | undefined,
      provide: (name: string, impl: unknown) => {
        reg.set(name, impl);
        return () => reg.delete(name);
      },
    },
    llm: withRouterPlanner({
      complete: (req: { messages: Array<{ content: string }> }) => {
        composerUsers.push(req.messages[0]?.content ?? '');
        return Promise.resolve({ text: s.composer });
      },
    }, { text: () => s.composer, forced }),
    config: { get: <T>(): T | undefined => undefined },
    tools: {
      register: () => () => {},
      invoke: (name: string, input: unknown): Promise<string> => {
        invokes.push({ name, input });
        const domain = (input as { domain?: unknown[] }).domain ?? [];
        return Promise.resolve(JSON.stringify(domain).includes('"id"') ? out(DETAIL) : out(INVOICES));
      },
    },
  } as unknown as PluginContext;
  reg.set(FAST_PATH_SERVICE, createFastPathService({
    config: ctx.config,
    model: 'class:fast',
    privacyGuard: () => undefined,
    privacyForced: () => false,
    log: (m) => logs.push(m),
  }));
  reg.set(CHAT_AGENT_SERVICE, {
    sessionLogger: {
      log: (e: Record<string, unknown>) => {
        logged.push(e);
        return Promise.resolve({ turnExternalId: `turn:${String(e['scope'])}:t` });
      },
    },
    agent: {
      // the base agent's own tool list — the fast path stays within it
      offeredToolNames: () => new Set(['odoo_query']),
      chat: () => Promise.reject(new Error('unused')),
      async *chatStream(input: ChatTurnInput) {
        baseInputs.push(input);
        await Promise.resolve();
        yield { type: 'done', answer: 'agent', toolCalls: 0, iterations: 1 } as ChatStreamEvent;
      },
    },
  } as unknown as ChatAgentBundle);
  await activate(ctx);
  return { agent: (reg.get('canvasChatAgent') as ChatAgentBundle).agent, logs, composerUsers, forced, invokes, baseInputs, s, logged };
}

async function collect(it: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const evs: ChatStreamEvent[] = [];
  for await (const e of it) evs.push(e);
  return evs;
}

const rowTarget = (containerId: string, rowKey: string): Partial<ChatTurnInput> => ({
  target: { kind: 'rowField', containerId, rowKey, fieldKey: 'number' },
});

describe('canvas action turn — deterministic detail via the fast path', () => {
  it('a row action on a recipe-filled table plans ONE detail query for exactly that record', async () => {
    const h = await harness();
    await collect(h.agent.chatStream({ userMessage: 'Offene Rechnungen', canvasSessionId: 'cs-1' }));
    assert.equal(h.baseInputs.length, 0, 'the list itself was a fast-path hit');
    h.s.composer = detailComposer(11);
    const events = await collect(
      h.agent.chatStream({ userMessage: 'Details', canvasSessionId: 'cs-1', ...rowTarget('invoices', '11') } as ChatTurnInput),
    );
    assert.equal(h.baseInputs.length, 0, 'no agent turn for the detail');
    const composerText = h.composerUsers[1] ?? '';
    assert.match(composerText, /TARGET RECORD/);
    assert.match(composerText, /model "account\.move"/);
    assert.match(composerText, /\["id","=",11\]/);
    assert.deepEqual((h.invokes[1]?.input as { domain: unknown }).domain, [['id', '=', 11]]);
    assert.equal(events[0]?.type, 'surface_snapshot', 'a new view');
    assert.ok(events.some((e) => e.type === 'surface_patch'));
    const done = events.find((e) => e.type === 'done') as { answer?: string } | undefined;
    assert.equal(done?.answer, 'Details zur Rechnung (1 Datensatz).');
    assert.ok(h.logs.some((m) => /^\[fast-path\] hit channel=canvas tool=odoo_query rows=1 ms=\d+$/.test(m)));
  });

  it('a plan that does not query the target record misses to the agent', async () => {
    const h = await harness();
    await collect(h.agent.chatStream({ userMessage: 'Offene Rechnungen', canvasSessionId: 'cs-2' }));
    h.s.composer = detailComposer(12);
    await collect(h.agent.chatStream({ userMessage: 'Details', canvasSessionId: 'cs-2', ...rowTarget('invoices', '11') } as ChatTurnInput));
    assert.equal(h.baseInputs.length, 1);
    assert.ok(h.logs.includes('[ui-orchestrator] fast-path miss reason=target-not-queried'));
  });

  it('a target without a recipe (unknown container) keeps the agent path', async () => {
    const h = await harness();
    h.s.composer = detailComposer(11);
    await collect(h.agent.chatStream({ userMessage: 'Details', canvasSessionId: 'cs-3', ...rowTarget('invoices', '11') } as ChatTurnInput));
    assert.equal(h.baseInputs.length, 1);
    assert.ok(h.logs.includes('[ui-orchestrator] fast-path miss reason=action-turn'));
    assert.doesNotMatch(h.composerUsers[0] ?? '', /TARGET RECORD/);
  });
});

describe('canvas fast-path turns are recorded as normal turns', () => {
  it('a hit goes through the base orchestrator session logger (user text + answer)', async () => {
    const h = await harness();
    const events = await collect(
      h.agent.chatStream({ userMessage: 'Offene Rechnungen', canvasSessionId: 'cs-r', sessionScope: 'tab_1', userId: 'u1' }),
    );
    assert.equal(h.baseInputs.length, 0);
    assert.equal(h.logged.length, 1);
    assert.deepEqual(
      { scope: h.logged[0]?.['scope'], user: h.logged[0]?.['userMessage'], answer: h.logged[0]?.['assistantAnswer'], userId: h.logged[0]?.['userId'] },
      { scope: 'tab_1', user: 'Offene Rechnungen', answer: '2 Rechnungen.', userId: 'u1' },
    );
    const done = events.find((e) => e.type === 'done') as { turnId?: string } | undefined;
    assert.equal(done?.turnId, 'turn:tab_1:t');
  });
});
