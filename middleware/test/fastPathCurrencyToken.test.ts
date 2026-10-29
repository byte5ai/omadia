/**
 * `{currency}` in a fast-path summary template: rendered from the ONE shared
 * `currency_id` display value behind a currency-checked money `{sum:…}` —
 * never guessed. Both planner prompts (triage example, canvas composer)
 * show it next to the money total.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { renderSummary } from '../packages/harness-plugin-fast-path/src/fastPath.js';
import { parseTriage, TRIAGE_OUTPUT_EXAMPLE, TRIAGE_SYSTEM } from '../packages/harness-plugin-fast-path/src/triage.js';
import { fastPathPromptSection } from '../packages/omadia-ui-orchestrator/src/composition.js';

const MAP = { number: 'name', open_amount: 'amount_residual', ranks: 'customer_rank' };
const rec = (amount: number, currency: unknown): Record<string, unknown> => ({
  name: 'X',
  amount_residual: amount,
  customer_rank: 1,
  currency_id: currency,
});
const rowsOf = (records: Array<Record<string, unknown>>): Array<Record<string, unknown>> =>
  records.map((r) => ({ number: r['name'], open_amount: r['amount_residual'], ranks: r['customer_rank'] }));

describe('{currency} token', () => {
  it('renders the shared currency display name next to a money sum', () => {
    const records = [rec(1200.5, [1, 'EUR']), rec(50000, [1, 'EUR'])];
    const r = renderSummary('{count} offene Posten, gesamt {sum:open_amount} {currency}.', {
      rows: rowsOf(records),
      records,
      map: MAP,
      locale: 'de-DE',
    });
    assert.deepEqual(r, { ok: true, text: '2 offene Posten, gesamt 51.200,50 EUR.' });
  });

  it('a plain-string currency value is used as-is', () => {
    const records = [rec(10, 'USD')];
    const r = renderSummary('{sum:open_amount} {currency}', { rows: rowsOf(records), records, map: MAP, locale: 'en-US' });
    assert.deepEqual(r, { ok: true, text: '10.00 USD' });
  });

  it('mixed currencies still miss (no total, no currency)', () => {
    const records = [rec(1, [1, 'EUR']), rec(2, [2, 'USD'])];
    const r = renderSummary('{sum:open_amount} {currency}', { rows: rowsOf(records), records, map: MAP, locale: 'de-DE' });
    assert.equal(r.ok, false);
  });

  it('without a money sum the token cannot be resolved → miss', () => {
    const records = [rec(1, [1, 'EUR'])];
    const r1 = renderSummary('{count} Posten in {currency}.', { rows: rowsOf(records), records, map: MAP, locale: 'de-DE' });
    assert.equal(r1.ok, false);
    const r2 = renderSummary('{sum:ranks} {currency}', { rows: rowsOf(records), records, map: MAP, locale: 'de-DE' });
    assert.equal(r2.ok, false, 'a non-money sum is not currency-checked');
  });

  it('zero rows: the token (and its leading space) is dropped', () => {
    const r = renderSummary('{count} offene Posten, gesamt {sum:open_amount} {currency}.', {
      rows: [],
      records: [],
      map: MAP,
      locale: 'de-DE',
    });
    assert.deepEqual(r, { ok: true, text: '0 offene Posten, gesamt 0,00.' });
  });

  it('templates without the token render exactly as before', () => {
    const records = [rec(3, [1, 'EUR'])];
    const r = renderSummary('{count} Posten über {sum:open_amount} €.', { rows: rowsOf(records), records, map: MAP, locale: 'de-DE' });
    assert.deepEqual(r, { ok: true, text: '1 Posten über 3,00 €.' });
  });
});

describe('planner prompts show the currency with the money total', () => {
  it('the triage output example sums with {currency} and still parses', () => {
    assert.match(TRIAGE_OUTPUT_EXAMPLE, /\{sum:open_amount\} \{currency\}/);
    assert.ok(TRIAGE_SYSTEM.includes('{currency}'));
    const d = parseTriage(TRIAGE_OUTPUT_EXAMPLE, new Set(['odoo_query']));
    assert.equal(d.decision, 'deterministic');
  });

  it('the canvas composer example uses {currency} instead of a hard-coded symbol', () => {
    const section = fastPathPromptSection([{ name: 'odoo_query', spec: 's' }]);
    assert.match(section, /\{sum:amount\} \{currency\}/);
    assert.doesNotMatch(section, /\{sum:amount\} €/);
  });
});
