/**
 * #2085 — the side channel for data (spec 2042 §5.13, acceptance criterion
 * 25): a user asks an agent for the open invoices of a customer; the table
 * reaches the user under the agent's identity with AI disclosure, and the
 * model's trace holds the status (row count, columns) but none of the rows.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  InMemoryDisclosureSeenStore,
  renderDataText,
  toSemanticAnswer,
  withDataText,
  withoutDataText,
  type AiDisclosure,
} from '@omadia/channel-sdk';
import { MAX_DATA_PAYLOADS_PER_TURN, TurnDataCollector, turnContext } from '@omadia/orchestrator';
import type { TableData } from '@omadia/plugin-api';

import { createDataActionRunner } from '../src/triggers/dataActions.js';
import { createDeliverDataHandler } from '../src/triggers/deliverDataTool.js';

const INVOICES = [
  { number: 'RE-2026-0412', customer: 'Müller GmbH', amount: 1234.5, due: '2026-10-31' },
  { number: 'RE-2026-0433', customer: 'Müller GmbH', amount: 99.9, due: '2026-11-15' },
];

const runner = createDataActionRunner((slug) =>
  slug === 'erika'
    ? new Map([['odoo_open_invoices', async () => JSON.stringify({ records: INVOICES })]])
    : undefined,
);

function inTurn<T>(collector: TurnDataCollector | undefined, fn: () => Promise<T>): Promise<T> {
  return turnContext.run(
    { turnId: 't-1', turnDate: '2026-11-20', agentSlug: 'erika', ...(collector ? { dataSideChannel: collector } : {}) },
    fn,
  );
}

const disclosure: AiDisclosure = {
  level: 'standard',
  locale: 'de',
  source: 'operator',
  text: 'Diese Antwort wurde von Erika (KI) erstellt.',
};

describe('#2085 side channel — criterion 25', () => {
  it('the model gets the status, the answer gets the rows, under the disclosure', async () => {
    const collector = new TurnDataCollector();
    const handler = createDeliverDataHandler({ dataActions: runner });
    const status = await inTurn(collector, () =>
      handler({ tool: 'odoo_open_invoices', input: { customer: 'Müller' }, title: 'Offene Rechnungen' }),
    );

    // What the model sees: counts and columns, no row value.
    const parsed = JSON.parse(status) as Record<string, unknown>;
    assert.equal(parsed['status'], 'delivered');
    assert.equal(parsed['rows'], 2);
    assert.deepEqual(parsed['columns'], ['number', 'customer', 'amount', 'due']);
    for (const value of ['RE-2026-0412', 'RE-2026-0433', 'Müller GmbH', '1234.5', '99.9', '2026-10-31']) {
      assert.ok(!status.includes(value), `model status leaks ${value}`);
    }

    // What the user gets: the rows, after the prose, before the disclosure.
    const data = collector.list();
    assert.equal(data.length, 1);
    const answer = toSemanticAnswer(
      { answer: 'Hier sind die offenen Rechnungen.', toolCalls: 1, iterations: 1, data, aiDisclosure: disclosure },
      { scope: 'erika::conv-1', seen: new InMemoryDisclosureSeenStore() },
    );
    assert.deepEqual(answer.data, data);
    assert.ok(answer.text.startsWith('Hier sind die offenen Rechnungen.\n\n**Offene Rechnungen**'));
    assert.ok(answer.text.includes('| RE-2026-0412 | Müller GmbH | 1234.5 | 2026-10-31 |'));
    assert.ok(answer.text.endsWith(disclosure.text), 'the disclosure closes the message');
    assert.equal(
      answer.textWithoutData,
      `Hier sind die offenen Rechnungen.\n\n${disclosure.text}`,
      'textWithoutData keeps prose and disclosure, drops the table',
    );
  });

  it('refuses honestly outside a turn, for a foreign tool, and beyond the limit', async () => {
    const handler = createDeliverDataHandler({ dataActions: runner });
    assert.match(await inTurn(undefined, () => handler({ tool: 'odoo_open_invoices' })), /no_turn/);
    const collector = new TurnDataCollector();
    assert.match(
      await inTurn(collector, () => handler({ tool: 'hr_salaries' })),
      /not one of this agent's own read tools/,
    );
    assert.match(await inTurn(collector, () => handler({ tool: 'odoo_open_invoices', input: 'x' })), /invalid/);
    for (let i = 0; i < MAX_DATA_PAYLOADS_PER_TURN; i += 1) {
      await inTurn(collector, () => handler({ tool: 'odoo_open_invoices' }));
    }
    assert.match(await inTurn(collector, () => handler({ tool: 'odoo_open_invoices' })), /limit_reached/);
    assert.equal(collector.list().length, MAX_DATA_PAYLOADS_PER_TURN);
  });

  it('an answer without data is byte-identical', () => {
    const plain = toSemanticAnswer({ answer: 'Hallo', toolCalls: 0, iterations: 0 });
    assert.equal(plain.text, 'Hallo');
    assert.equal(plain.data, undefined);
    assert.equal(plain.textWithoutData, undefined);
  });

  it('removes exactly the rendering it added', () => {
    const table: TableData = { kind: 'table', columns: ['a'], rows: [[1]] };
    const text = `${withDataText('Prosa', [table])}\n\nHinweis`;
    assert.equal(withoutDataText(text, [table]), 'Prosa\n\nHinweis');
    assert.equal(withoutDataText(renderDataText([table]), [table]), '');
    assert.equal(withoutDataText('unrelated', [table]), 'unrelated');
  });
});
