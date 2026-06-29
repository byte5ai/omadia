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
      // `v4_render_answer` now terminates the turn with a server-rendered
      // user-facing payload (`_pendingCanvasTree` for tables), so it is no
      // longer fed back into the model turn and must not count as LLM-bound.
      if (toolName !== 'v4_render_answer') {
        wire.push(r.resultText);
      }
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
    const text = answer.text;

    // SC-001 — real, complete names; no tokens / partials / invented labels.
    for (const name of REAL_NAMES) {
      assert.ok(text.includes(name), `answer is missing "${name}"`);
    }
    assert.ok(!text.includes('«'), 'answer carries a v2 token');
    assert.ok(!/Mitarbeiter \d|Platz \d/.test(text), 'answer carries an invented label');

    // SC-002 — correct ranking: Anna (32) > Marvin (24) > Thomas (16).
    assert.ok(text.indexOf('Anna Rüsche') < text.indexOf('Marvin Vomberg'));
    assert.ok(text.indexOf('Marvin Vomberg') < text.indexOf('Thomas Görres'));
    // no duplicated people
    for (const name of REAL_NAMES) {
      assert.equal(text.split(name).length - 1, 1, `"${name}" appears twice`);
    }

    // The masked employee names — what the LLM never saw — are surfaced so
    // the channel can highlight them for the asker.
    assert.deepEqual([...answer.maskedValues].sort(), [...REAL_NAMES].sort());

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

  it('sub-agent boundary — interned datasets bridge by reference, render yields real names', async () => {
    // The failure-of-record path: `query_odoo_hr` is a sub-agent whose own
    // LLM runs behind the SAME v4 boundary — it only ever sees `[masked]`,
    // so the prose it returns has `[masked]` baked in. Re-interning that
    // prose loses the real names for good. This proves the dataset-reference
    // bridge: the sub-agent's interned datasets are handed to the parent
    // agent by id, and a render on them surfaces the REAL names.
    const svc = createPrivacyGuardService();
    const turnId = 't-subagent';
    const ids = { sessionId: 's', turnId };

    // The sub-agent interns its two Odoo fetches — real rows, server-side.
    const leave = await svc.internToolResultV4({
      ...ids,
      toolName: 'hr.leave',
      rawResult: JSON.stringify(LEAVE_RECORDS),
    });
    const emps = await svc.internToolResultV4({
      ...ids,
      toolName: 'hr.employees',
      rawResult: JSON.stringify(EMPLOYEES),
    });

    // The sub-agent only ever saw `[masked]`; its prose answer carries the
    // placeholder plus an apologetic caveat — the live bug-of-record.
    const subAgentProse =
      'Top-Ranking: [masked] mit 32 Tagen — die Namen sind durch den ' +
      'Datenschutzfilter maskiert und können nicht angezeigt werden.';

    // Bridge: the orchestrator hands the parent agent the REAL datasets by
    // reference instead of re-interning the `[masked]`-poisoned prose.
    const bridged = await svc.subAgentResultV4({
      turnId,
      narration: subAgentProse,
      datasetIds: [leave.datasetId, emps.datasetId],
    });

    // The bridged tool_result is LLM-bound — it must carry zero identity
    // values, exactly like any digest (SC-003) …
    assertNoIdentityOnWire([bridged.resultText], REAL_NAMES);
    // … but it must reference the real datasets so the parent can render.
    assert.ok(bridged.resultText.includes(leave.datasetId));
    assert.ok(bridged.resultText.includes(emps.datasetId));

    // The parent agent composes the verb chain on the bridged datasetIds
    // and renders — the real names must surface (the bug: they did not).
    const run = async (toolName: string, input: unknown): Promise<string> => {
      return (await svc.runV4Tool({ ...ids, toolName, input })).resultText;
    };
    const agg = await run('v4_aggregate', {
      datasetId: leave.datasetId,
      groupBy: ['employee_id'],
      ops: [{ alias: 'total', fn: 'sum', field: 'days' }],
    });
    const joined = await run('v4_join', {
      leftDatasetId: datasetIdOf(agg),
      rightDatasetId: emps.datasetId,
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
    for (const name of REAL_NAMES) {
      assert.ok(answer.text.includes(name), `answer is missing "${name}"`);
    }
    assert.deepEqual([...answer.maskedValues].sort(), [...REAL_NAMES].sort());
  });
});
