/**
 * Privacy Shield v4 — HR-Urlaubsranking acceptance scaffold.
 *
 * Drives the full v4 service path the way the orchestrator would for the
 * failure-of-record case — "Wer hat dieses Jahr den meisten Urlaub?" — and
 * asserts the spec §Success-Criteria at the engine level:
 *
 *   SC-001  the answer shows real, complete names — no tokens/partials
 *   SC-002  ranks correct, no duplicated / no invented people
 *   SC-003  zero identity values in any LLM-bound payload
 *   SC-004  a fresh, un-annotated tool shape is interned + classified
 *   SC-006  no digest carries an identity value
 *
 * The live run with a real LLM driving the verb calls is the operator's
 * acceptance step; this scaffold proves the engine produces the right
 * answer and never leaks on the wire.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createPrivacyGuardService } from '@omadia/plugin-privacy-guard/dist/index.js';
import { assertNoIdentityOnWire } from '@omadia/plugin-privacy-guard/dist/v4/onTheWire.js';

// --- the HR-Urlaubsranking fixture -----------------------------------------

const EMPLOYEES = [
  { employee: 'Marvin Vomberg', employee_id: '4471' },
  { employee: 'Anna Rüsche', employee_id: '5582' },
  { employee: 'Thomas Görres', employee_id: '6693' },
];
const REAL_NAMES = EMPLOYEES.map((e) => e.employee);

// 24 leave records, 8 per employee. Per-record days: Marvin 3, Anna 4,
// Thomas 2 → yearly totals 24 / 32 / 16. Expected ranking: Anna > Marvin > Thomas.
const PER_RECORD_DAYS = [3, 4, 2];
const LEAVE_RECORDS = Array.from({ length: 24 }, (_, i) => {
  const e = i % 3;
  return {
    employee: EMPLOYEES[e]!.employee,
    employee_id: EMPLOYEES[e]!.employee_id,
    days: PER_RECORD_DAYS[e]!,
  };
});

function datasetIdOf(text: string): string {
  return (JSON.parse(text.slice(text.indexOf('{'))) as { datasetId: string })
    .datasetId;
}

describe('Privacy Shield v4 — HR-Urlaubsranking acceptance', () => {
  it('produces a real, correct answer with zero identity values on the wire', async () => {
    const svc = createPrivacyGuardService();
    const turnId = 't-acceptance';
    const ids = { sessionId: 's', turnId };

    // Everything the LLM would ever see this turn is collected here.
    const wire: unknown[] = [
      'You are the HR assistant. Answer the user precisely.',
      'Wer hat dieses Jahr den meisten Urlaub?',
    ];

    // Tool 1: the leave records → digest.
    const leave = await svc.internToolResultV4({
      ...ids,
      toolName: 'hr.leave',
      rawResult: JSON.stringify(LEAVE_RECORDS),
    });
    wire.push(leave.digestText);

    // Tool 2: the employee directory → digest.
    const emps = await svc.internToolResultV4({
      ...ids,
      toolName: 'hr.employees',
      rawResult: JSON.stringify(EMPLOYEES),
    });
    wire.push(emps.digestText);

    // Verb chain the LLM composes: aggregate → join → sort.
    const run = async (toolName: string, input: unknown): Promise<string> => {
      const r = await svc.runV4Tool({ ...ids, toolName, input });
      wire.push(r.resultText);
      return r.resultText;
    };

    const agg = await run('v4_aggregate', {
      datasetId: datasetIdOf(leave.digestText),
      groupBy: ['employee_id'],
      ops: [{ alias: 'total', fn: 'sum', field: 'days' }],
    });
    const joined = await run('v4_join', {
      leftDatasetId: datasetIdOf(agg),
      rightDatasetId: datasetIdOf(emps.digestText),
      leftKey: 'employee_id',
      rightKey: 'employee_id',
    });
    const sorted = await run('v4_sort', {
      datasetId: datasetIdOf(joined),
      by: 'total',
      direction: 'desc',
    });
    await run('v4_render_answer', {
      datasetId: datasetIdOf(sorted),
      columns: ['employee', 'total'],
      format: 'table',
    });

    const answer = await svc.takeRenderedAnswerV4(turnId);
    assert.ok(answer, 'a final answer was rendered');

    // SC-001 — real, complete names; no tokens / partials / invented labels.
    for (const name of REAL_NAMES) {
      assert.ok(answer.includes(name), `answer is missing "${name}"`);
    }
    assert.ok(!answer.includes('«'), 'answer carries a v2 token');
    assert.ok(!/Mitarbeiter \d|Platz \d/.test(answer), 'answer carries an invented label');

    // SC-002 — correct ranking: Anna (32) > Marvin (24) > Thomas (16).
    assert.ok(answer.indexOf('Anna Rüsche') < answer.indexOf('Marvin Vomberg'));
    assert.ok(
      answer.indexOf('Marvin Vomberg') < answer.indexOf('Thomas Görres'),
    );
    // no duplicated people
    for (const name of REAL_NAMES) {
      assert.equal(answer.split(name).length - 1, 1, `"${name}" appears twice`);
    }

    // SC-003 / SC-006 — zero identity values in any LLM-bound payload.
    assertNoIdentityOnWire(wire, REAL_NAMES);
  });

  it('SC-004 — a fresh, un-annotated tool shape is interned and classified', async () => {
    const svc = createPrivacyGuardService();
    const fresh = [
      { ticket_id: 'T-1001', reporter: 'Brigitte Kaltenbach', priority: 'high' },
      { ticket_id: 'T-1002', reporter: 'Hans-Peter Donnerwetter', priority: 'low' },
    ];
    const r = await svc.internToolResultV4({
      sessionId: 's',
      turnId: 't-fresh',
      toolName: 'never.seen.before',
      rawResult: JSON.stringify(fresh),
    });
    // No annotation, never-seen shape — the reporter names must not leak.
    assert.ok(!r.digestText.includes('Brigitte Kaltenbach'));
    assert.ok(!r.digestText.includes('Hans-Peter Donnerwetter'));
  });
});
