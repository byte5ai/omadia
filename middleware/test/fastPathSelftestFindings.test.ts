/**
 * Live self-test findings on the fast path (v411):
 *   1. the canvas composer's FIRST request already carries the output-format
 *      instruction (attempt 1 returned prose, only the retry asked for JSON);
 *   2. an odoo_query plan with `limit: 1` (single-record "Details anzeigen")
 *      is executed with limit 100 — `truncated` (1 of 1) no longer misses;
 *   3. a triage plan without labels gets human column headers (catalog field
 *      labels in the user's language, else a humanised key);
 *   4. the triage prompt carries an explicit required output shape with a
 *      summary ({count}, {sum:<key>} + currency_id) — and the parser accepts it.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  composeSkeleton,
  type CompositionLlm,
} from '../packages/omadia-ui-orchestrator/src/composition.js';
import {
  FAST_PATH_TOOL_SPECS,
  OUTPUT_FORMAT_INSTRUCTION,
  fetchRecipeRows,
} from '../packages/harness-plugin-fast-path/src/fastPath.js';
import { buildPlannerPrompt, parsePlan, PLAN_EXAMPLE, PLANNER_SYSTEM, plannerTool } from '../packages/harness-plugin-fast-path/src/planner.js';
import { parseTriage } from './_helpers/fastPathRouterPlanner.js';
import type { RefreshSource } from '../packages/harness-plugin-fast-path/src/refreshRecipes.js';

const ODOO = new Set(['odoo_query']);

describe('finding 1 — composer output-format instruction on the first attempt', () => {
  it('the first request already says "Output ONLY the JSON object"', async () => {
    const calls: string[] = [];
    const llm: CompositionLlm = {
      complete: ({ messages }) => {
        calls.push(messages[0]?.content ?? '');
        return Promise.resolve({ text: 'Here is your dashboard: …' });
      },
    };
    await composeSkeleton({ llm, model: 'm', userText: 'Geburtstage im Januar' });
    assert.ok(calls.length >= 1);
    assert.ok(calls[0]?.includes('User request: Geburtstage im Januar'));
    assert.ok(calls[0]?.includes(OUTPUT_FORMAT_INSTRUCTION), calls[0] ?? '(no call)');
  });
});

describe('finding 2 — odoo_query limit normalised to 100 on the fast path', () => {
  const detail: RefreshSource = {
    tool: 'odoo_query',
    input: { model: 'res.partner', domain: [['id', '=', 7]], fields: ['name'], limit: 1 },
    map: { name: 'name' },
    rowKey: 'id',
    itemsPath: 'records',
  };

  it('a detail plan with limit 1 runs with limit 100 → hit', async () => {
    const seen: unknown[] = [];
    const invoke = (_name: string, input: unknown): Promise<string> => {
      seen.push(input);
      const limit = (input as { limit?: number }).limit ?? 0;
      return Promise.resolve(
        JSON.stringify({ records: [{ id: 7, name: 'Müller GmbH' }], truncated: limit <= 1 }),
      );
    };
    const fetched = await fetchRecipeRows(invoke, detail, { rejectTruncated: true });
    assert.equal(fetched.ok, true);
    assert.equal((seen[0] as { limit: number }).limit, 100);
    // the plan itself is not mutated
    assert.equal((detail.input as { limit: number }).limit, 1);
  });

  it('a limit above the tool max is capped at 100; a missing limit becomes 100', async () => {
    const seen: Array<{ limit?: number }> = [];
    const invoke = (_n: string, input: unknown): Promise<string> => {
      seen.push(input as { limit?: number });
      return Promise.resolve(JSON.stringify({ records: [], truncated: false }));
    };
    await fetchRecipeRows(invoke, { ...detail, input: { model: 'res.partner', limit: 500 } }, { rejectTruncated: true });
    await fetchRecipeRows(invoke, { ...detail, input: { model: 'res.partner' } }, { rejectTruncated: true });
    assert.deepEqual(
      seen.map((s) => s.limit),
      [100, 100],
    );
  });

  it('a genuinely large result (truncated at 100) is still a miss', async () => {
    const invoke = (): Promise<string> =>
      Promise.resolve(JSON.stringify({ records: [{ id: 1, name: 'a' }], truncated: true }));
    const fetched = await fetchRecipeRows(invoke, detail, { rejectTruncated: true });
    assert.deepEqual(fetched, { ok: false, reason: 'truncated' });
  });

  it('other tools and non-fast-path refreshes keep their input untouched', async () => {
    const seen: unknown[] = [];
    const invoke = (_n: string, input: unknown): Promise<string> => {
      seen.push(input);
      return Promise.resolve(JSON.stringify({ records: [] }));
    };
    await fetchRecipeRows(invoke, { ...detail, tool: 'other_tool' }, { rejectTruncated: true });
    await fetchRecipeRows(invoke, detail, {});
    assert.equal((seen[0] as { limit: number }).limit, 1);
    assert.equal((seen[1] as { limit: number }).limit, 1);
  });

  it('the tool spec tells the planner the limit is always 100', () => {
    assert.match(FAST_PATH_TOOL_SPECS['odoo_query'] ?? '', /limit is always 100/);
  });
});

describe('finding 3 — human column labels in the chat answer', () => {
  const plan = (labels: unknown, locale: string): string =>
    JSON.stringify({
      decision: 'deterministic',
      fetch: {
        tool: 'odoo_query',
        input: { model: 'account.move', fields: ['name', 'partner_id', 'invoice_date_due', 'amount_residual', 'currency_id'], limit: 100 },
        map: {
          number: 'name',
          partner: 'partner_id.1',
          due_date: 'invoice_date_due',
          open_amount: 'amount_residual',
          currency: 'currency_id.1',
          extra_note: 'x_note',
        },
        itemsPath: 'records',
        rowKey: 'id',
      },
      ...(labels !== undefined ? { labels } : {}),
      summary: '{count} offene Posten.',
      locale,
    });

  it('missing labels fall back to German catalog labels, then a humanised key', () => {
    const d = parseTriage(plan(undefined, 'de-DE'), ODOO);
    assert.equal(d.decision, 'deterministic');
    if (d.decision !== 'deterministic') return;
    assert.deepEqual(d.labels, {
      number: 'Nummer',
      partner: 'Partner',
      due_date: 'Fällig am',
      open_amount: 'Offener Betrag',
      currency: 'Währung',
      extra_note: 'Extra note',
    });
  });

  it('English locale → English catalog labels', () => {
    const d = parseTriage(plan(undefined, 'en-US'), ODOO);
    if (d.decision !== 'deterministic') return assert.fail(d.decision);
    assert.equal(d.labels['number'], 'Number');
    assert.equal(d.labels['due_date'], 'Due date');
    assert.equal(d.labels['open_amount'], 'Open amount');
  });

  it("the plan's own labels win; `columns: [{key,label}]` is accepted too", () => {
    const own = parseTriage(plan({ number: 'Rechnungsnr.' }, 'de-DE'), ODOO);
    if (own.decision !== 'deterministic') return assert.fail(own.decision);
    assert.equal(own.labels['number'], 'Rechnungsnr.');
    assert.equal(own.labels['partner'], 'Partner');
    const cols = JSON.parse(plan(undefined, 'de-DE')) as Record<string, unknown>;
    cols['columns'] = [{ key: 'partner', label: 'Kunde' }];
    const viaColumns = parseTriage(JSON.stringify(cols), ODOO);
    if (viaColumns.decision !== 'deterministic') return assert.fail(viaColumns.decision);
    assert.equal(viaColumns.labels['partner'], 'Kunde');
  });
});

describe('finding 4 — planner required output shape incl. summary', () => {
  it('the system prompt carries the example shape with {count}, {sum:…} and currency_id', () => {
    const example = JSON.stringify(PLAN_EXAMPLE);
    assert.ok(PLANNER_SYSTEM.includes(example));
    assert.match(example, /\{count\}/);
    assert.match(example, /\{sum:open_amount\}/);
    assert.match(example, /"currency_id"/);
    assert.match(example, /"labels"/);
  });

  it('the parser accepts the example as a deterministic plan with its own summary', () => {
    const d = parsePlan({ ...PLAN_EXAMPLE }, { allowedTools: ODOO });
    assert.ok(d.ok);
    assert.equal(d.plan.summaryDefaulted, undefined);
    assert.match(d.plan.summary, /\{sum:open_amount\}/);
    assert.equal(d.plan.locale, 'de-DE');
  });

  it('summary and locale are required fields of the forced plan_query tool; the prompt carries the turn', () => {
    const schema = plannerTool('odoo_query').inputSchema as { required: string[] };
    assert.ok(schema.required.includes('summary') && schema.required.includes('locale'));
    const prompt = buildPlannerPrompt({ question: 'offene Posten', tool: { name: 'odoo_query', spec: 's' } });
    assert.match(prompt, /USER TURN: offene Posten/);
  });
});
