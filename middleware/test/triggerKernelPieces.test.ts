/**
 * #2082 / #2085 — the kernel pieces around the trigger engine, without a
 * database: quiet hours, data actions (only the agent's own read tools; rows
 * stay in the harness), the trigger turn (status in, no rows; nothing to say
 * sends nothing; cost settled from actual usage) and the Conductor bus
 * observer that feeds the hooks.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { ChatTurnInput, SemanticAnswer } from '@omadia/channel-sdk';

import { recordUsage } from '../packages/harness-usage-telemetry/src/index.js';
import { ConductorEventRouter } from '../src/conductor/eventRouter.js';
import { columnsOf, createDataActionRunner, extractRows } from '../src/triggers/dataActions.js';
import { createKernelExecutors, NOTHING_TO_SAY, triggerTurnHint } from '../src/triggers/kernelExecutors.js';
import { parseQuietHours, quietUntil, recipientKey, renderDataTable } from '../src/triggers/proactiveGate.js';
import type { TriggerStore } from '../src/triggers/triggerStore.js';
import { conversationIdOf } from '../src/triggers/triggerTools.js';
import type { Trigger } from '../src/triggers/types.js';

const trigger = (over: Partial<Trigger> = {}): Trigger => ({
  id: '11111111-1111-1111-1111-111111111111',
  agentId: 'a',
  agentSlug: 'erika',
  kind: 'wake_every',
  origin: 'agent',
  ownerKey: null,
  purpose: 'Überfällige Rechnungen',
  contextKind: 'conversation',
  contextId: 'teams:19:abc',
  deliveryChannel: 'teams',
  deliveryRef: { conversationId: '19:abc' },
  target: null,
  labels: [],
  eventId: null,
  eventFilter: null,
  fireAt: null,
  intervalSeconds: 3600,
  cron: null,
  timezone: null,
  liveContext: false,
  actions: [],
  deliveryClass: 'droppable',
  until: new Date('2026-12-01T00:00:00Z'),
  maxRuns: 10,
  runs: 0,
  state: 'active',
  pauseReason: null,
  consecutiveFailures: 0,
  consecutiveIneffective: 0,
  budgetPerFiringUsd: 0.1,
  budgetTotalUsd: 2,
  modelCallsPerFiring: 4,
  spentUsd: 0,
  reservedUsd: 0,
  lastFiredAt: null,
  lastOutcome: null,
  lastError: null,
  lastFingerprint: null,
  createdBy: 'agent:erika',
  createdAt: new Date('2026-11-20T00:00:00Z'),
  ...over,
});

describe('#2082 quiet hours', () => {
  it('defers inside an overnight window to its end, in the recipient time zone', () => {
    const quiet = parseQuietHours('22:00-07:00');
    // 23:30 Berlin (CET, UTC+1) = 22:30 UTC
    const end = quietUntil(new Date('2026-11-20T22:30:00Z'), 'Europe/Berlin', quiet);
    assert.equal(end?.toISOString(), '2026-11-21T06:00:00.000Z');
    assert.equal(quietUntil(new Date('2026-11-20T12:00:00Z'), 'Europe/Berlin', quiet), undefined);
    assert.equal(quietUntil(new Date('2026-11-20T22:30:00Z'), 'Europe/Berlin', null), undefined);
  });

  it('parses and refuses quiet-hour specs', () => {
    assert.equal(parseQuietHours('off'), null);
    assert.throws(() => parseQuietHours('22-7'));
  });

  it('keys a conversation recipient by its context', () => {
    assert.equal(recipientKey(trigger()), 'teams:19:abc');
    assert.match(recipientKey(trigger({ contextKind: 'routine', contextId: 'r1' })), /^teams:ref:/);
  });
});

describe('#2085 data actions', () => {
  const tools = new Map<string, (input: unknown) => Promise<string>>([
    ['invoices_overdue', async () => JSON.stringify({ rows: [{ id: 'R-1', customer: 'ACME', amount: 10 }] })],
    ['broken', async () => 'Error: upstream down'],
  ]);
  const runner = createDataActionRunner((slug) => (slug === 'erika' ? tools : undefined));

  it('runs only the agent\'s own read tools', async () => {
    assert.equal(runner.check('erika', { tool: 'invoices_overdue', input: {} }), undefined);
    assert.match(runner.check('erika', { tool: 'hr_salaries', input: {} }) ?? '', /not one of this agent's own read tools/);
    assert.match(runner.check('ghost', { tool: 'invoices_overdue', input: {} }) ?? '', /not in service/);
    const res = await runner.run('erika', { tool: 'invoices_overdue', input: {} });
    assert.ok(res.ok);
    assert.equal(res.rows.length, 1);
    assert.deepEqual(res.columns, ['id', 'customer', 'amount']);
    const broken = await runner.run('erika', { tool: 'broken', input: {} });
    assert.equal(broken.ok, false);
  });

  it('extracts rows from common result shapes', () => {
    assert.equal(extractRows('[1,2]')?.rows.length, 2);
    assert.equal(extractRows('{"items":[{"a":1}]}')?.rows.length, 1);
    assert.equal(extractRows('{"a":1}')?.rows.length, 1);
    assert.equal(extractRows('not json'), undefined);
    assert.deepEqual(columnsOf([{ a: 1 }, { b: 2, a: 3 }]), ['a', 'b']);
  });

  it('renders a table for the side channel without a model', () => {
    const md = renderDataTable([{ id: 'R|1', note: 'a\nb' }], ['id', 'note'], 'Offen');
    assert.equal(md, '**Offen**\n\n| id | note |\n| --- | --- |\n| R\\|1 | a b |');
  });
});

describe('#2082 trigger turn', () => {
  const store = {} as TriggerStore;
  const sent: SemanticAnswer[] = [];
  const gate = {
    sendWindow: async () => ({ ok: true as const }),
    send: async (_t: Trigger, m: SemanticAnswer) => {
      sent.push(m);
      return { delivered: true as const };
    },
  };
  const status = {
    purpose: 'Überfällige Rechnungen',
    occurrence: { dueAt: '2026-11-20T10:00:00.000Z' },
    checks: [{ check: 'data:rows', rows: 3, columns: ['id', 'customer'] }],
    delivered: ['deliver:invoices_overdue'],
  };

  it('gives the model a status, never rows, and settles the actual cost', async () => {
    let seen: ChatTurnInput | undefined;
    const exec = createKernelExecutors({
      store,
      dataActions: createDataActionRunner(() => new Map()),
      gate,
      agentChat: () => ({
        chat: async (input) => {
          seen = input;
          recordUsage({ source: 'test', model: 'scripted', inputTokens: 1, outputTokens: 1, costUsd: 0.03 });
          recordUsage({ source: 'test', model: 'scripted', inputTokens: 1, outputTokens: 1, costUsd: 0.02 });
          return { text: 'Drei Rechnungen sind überfällig, ACME am längsten.' };
        },
      }),
    });
    const out = await exec.turn(trigger(), 'Fasse kurz zusammen', status);
    assert.equal(out.delivered, true);
    assert.ok(Math.abs(out.costUsd - 0.05) < 1e-9, String(out.costUsd));
    assert.match(seen?.extraSystemHint ?? '', /data:rows → 3 row\(s\) \[id, customer\]/);
    assert.doesNotMatch(seen?.extraSystemHint ?? '', /ACME/);
    assert.equal(sent.at(-1)?.text, 'Drei Rechnungen sind überfällig, ACME am längsten.');
  });

  it('sends nothing when the agent has nothing to say (an ineffective turn)', async () => {
    const before = sent.length;
    const exec = createKernelExecutors({
      store,
      dataActions: createDataActionRunner(() => new Map()),
      gate,
      agentChat: () => ({ chat: async () => ({ text: NOTHING_TO_SAY }) }),
    });
    const out = await exec.turn(trigger(), 'go', status);
    assert.equal(out.delivered, false);
    assert.equal(out.error, undefined);
    assert.equal(sent.length, before);
  });

  it('a throwing turn is a failure that still reports what it spent', async () => {
    const exec = createKernelExecutors({
      store,
      dataActions: createDataActionRunner(() => new Map()),
      gate,
      agentChat: () => ({
        chat: async () => {
          recordUsage({ source: 'test', model: 'scripted', inputTokens: 1, outputTokens: 1, costUsd: 0.01 });
          throw new Error('provider down');
        },
      }),
    });
    const out = await exec.turn(trigger(), 'go', status);
    assert.equal(out.error, 'provider down');
    assert.ok(Math.abs(out.costUsd - 0.01) < 1e-9);
  });

  it('names purpose, deadline and the nothing-to-say answer in the hint', () => {
    const hint = triggerTurnHint(trigger(), status);
    assert.match(hint, /Purpose: Überfällige Rechnungen/);
    assert.match(hint, /\[\[nothing\]\]/);
  });
});

describe('#2082 event intake', () => {
  it('the Conductor bus tells its observers of every event, with a key', async () => {
    const seen: Array<[string, string]> = [];
    const router = new ConductorEventRouter({
      workflowStore: { list: async () => [] } as never,
      executor: {} as never,
    });
    router.addObserver((id, _payload, key) => seen.push([id, key]));
    router.addObserver(() => {
      throw new Error('observer bug');
    });
    await router.emit('expenses.report.submitted', { eventKey: 'exp-17', conversationId: 'c' });
    await router.emit('expenses.report.submitted', { conversationId: 'c' });
    assert.equal(seen.length, 2);
    assert.deepEqual(seen[0], ['expenses.report.submitted', 'exp-17']);
    assert.match(seen[1]?.[1] ?? '', /^[0-9a-f-]{36}$/);
  });

  it('reads a conversation id from channel references', () => {
    assert.equal(conversationIdOf({ conversation: { id: '19:x@thread.v2' } }), '19:x@thread.v2');
    assert.equal(conversationIdOf({ sessionId: 's1' }), 's1');
    assert.match(conversationIdOf('opaque'), /^ref-/);
  });
});
