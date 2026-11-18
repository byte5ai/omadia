import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  ClaimExtractor,
  DeterministicChecker,
  EvidenceJudge,
  VerifierPipeline,
  toTurnRecords,
  type Claim,
  type ClaimVerdict,
  type SoftClaim,
  type HardClaim,
  type OdooReader,
  type TurnRecord,
} from '@omadia/verifier';

/**
 * #1574 / #1575 / #1579 — the deterministic checker anchors claims on the
 * records the turn's tools read, and compares totals only with the records
 * they are about.
 *
 * The stub Odoo below applies the domain and the ids it receives, so a check
 * that queries the wrong set of records gets the wrong rows — the way the
 * issues reproduced the bugs.
 */

type Row = Record<string, unknown> & { id: number };

interface Tables {
  readonly [model: string]: readonly Row[];
}

interface Call {
  model: string;
  method: string;
  positionalArgs: unknown[];
}

function odooOver(tables: Tables, calls: Call[] = []): OdooReader {
  return {
    execute(req) {
      calls.push({ model: req.model, method: req.method, positionalArgs: req.positionalArgs });
      const rows = tables[req.model] ?? [];
      if (req.method === 'read') {
        const ids = req.positionalArgs[0] as number[];
        return Promise.resolve(rows.filter((r) => ids.includes(r.id)));
      }
      if (req.method === 'search_read') {
        const domain = req.positionalArgs[0] as Array<[string, string, unknown]>;
        return Promise.resolve(
          rows.filter((row) =>
            domain.every(([field, , value]) => {
              const own = row[field];
              return (Array.isArray(own) ? own[0] : own) === value;
            }),
          ),
        );
      }
      return Promise.resolve([]);
    },
  };
}

// Employee 15 has 6 + 3 = 9 approved days and one request waiting for
// approval; two other employees have leave too (the #1575 reproduction).
const LEAVES: Row[] = [
  { id: 101, employee_id: [15, 'Anna Müller'], state: 'validate', number_of_days: 6, request_date_from: '2026-03-02', request_date_to: '2026-03-09' },
  { id: 102, employee_id: [15, 'Anna Müller'], state: 'validate', number_of_days: 3, request_date_from: '2026-05-11', request_date_to: '2026-05-13' },
  { id: 103, employee_id: [15, 'Anna Müller'], state: 'confirm', number_of_days: 2, request_date_from: '2026-08-03', request_date_to: '2026-08-04' },
  { id: 201, employee_id: [7, 'Ben Kurz'], state: 'validate', number_of_days: 20, request_date_from: '2026-01-05', request_date_to: '2026-01-30' },
  { id: 301, employee_id: [9, 'Cleo Lang'], state: 'refuse', number_of_days: 8, request_date_from: '2026-02-02', request_date_to: '2026-02-11' },
];
const EMPLOYEES: Row[] = [
  { id: 15, display_name: 'Anna Müller' },
  { id: 7, display_name: 'Ben Kurz' },
];

const TOTAL: HardClaim = {
  id: 'c_001',
  text: 'Insgesamt 9 genehmigte Urlaubstage',
  type: 'aggregate',
  expectedSource: 'odoo',
  value: 9,
  odooRecord: { model: 'hr.leave' },
  relatedEntities: [],
  aggregation: 'sum',
};

/** The records a turn read for employee 15: the employee and its leave rows. */
const TURN_15: TurnRecord[] = [
  { model: 'hr.employee', id: 15 },
  { model: 'hr.leave', id: 101 },
  { model: 'hr.leave', id: 102 },
];

function checker(tables: Tables = { 'hr.leave': LEAVES, 'hr.employee': EMPLOYEES }, calls?: Call[]): DeterministicChecker {
  return new DeterministicChecker({ odoo: odooOver(tables, calls), log: () => {} });
}

describe('#1575 — aggregate compared with the records it is about', () => {
  it('a total with no employee is not compared with every employee (unverified, not contradicted)', async () => {
    const verdict = await checker().check(TOTAL);
    assert.equal(verdict.status, 'unverified');
  });

  it('a correct approved total is verified although a request still waits for approval', async () => {
    const verdict = await checker().check({ ...TOTAL, relatedEntities: ['hr.employee:15'] });
    assert.equal(verdict.status, 'verified', JSON.stringify(verdict));
  });

  it('takes the employee from the turn records when the claim names none', async () => {
    const verdict = await checker().check(TOTAL, { turnRecords: TURN_15 });
    assert.equal(verdict.status, 'verified', JSON.stringify(verdict));
  });

  it('takes the employee from the turn\'s leave rows when the turn read no employee', async () => {
    const verdict = await checker().check(TOTAL, {
      turnRecords: [{ model: 'hr.leave', id: 101 }, { model: 'hr.leave', id: 102 }],
    });
    assert.equal(verdict.status, 'verified', JSON.stringify(verdict));
  });

  it('does not guess between two employees the turn read', async () => {
    const verdict = await checker().check(TOTAL, {
      turnRecords: [{ model: 'hr.employee', id: 15 }, { model: 'hr.employee', id: 7 }],
    });
    assert.equal(verdict.status, 'unverified');
  });

  it('accepts approved plus pending days as the other reading of a total', async () => {
    const verdict = await checker().check({ ...TOTAL, value: 11, relatedEntities: ['hr.employee:15'] });
    assert.equal(verdict.status, 'verified');
  });

  it('accepts a total that counts a refused request too (seen live: "Rechnet man ihn mit, sind es 58,35 Tage")', async () => {
    const verdict = await checker().check({
      ...TOTAL,
      value: 8,
      text: 'Rechnet man den abgelehnten Antrag mit, sind es 8 Tage',
      relatedEntities: ['hr.employee:9'],
    });
    assert.equal(verdict.status, 'verified', JSON.stringify(verdict));
  });

  it('contradicts a total no reading of the records supports', async () => {
    const verdict = await checker().check({
      ...TOTAL,
      value: 12,
      text: 'Insgesamt 12 Tage',
      relatedEntities: ['hr.employee:15'],
    });
    assert.equal(verdict.status, 'contradicted');
    if (verdict.status === 'contradicted') assert.equal(verdict.truth, 9, 'the approved total is the reported truth');
  });

  it('does not count a refused request the turn read', async () => {
    const leaves = [
      ...LEAVES,
      { id: 105, employee_id: [15, 'Anna Müller'], state: 'refuse', number_of_days: 4, request_date_from: '2026-09-01', request_date_to: '2026-09-04' },
      { id: 106, employee_id: [15, 'Anna Müller'], state: 'validate', number_of_days: 10, request_date_from: '2025-07-01', request_date_to: '2025-07-14' },
    ];
    const claim: HardClaim = { ...TOTAL, text: '9 genehmigte Tage im Jahr 2026' };
    const verdict = await checker({ 'hr.leave': leaves, 'hr.employee': EMPLOYEES }).check(claim, {
      turnRecords: [...TURN_15, { model: 'hr.leave', id: 105 }],
    });
    assert.equal(verdict.status, 'verified', JSON.stringify(verdict));
  });

  it('a total over a named period is checked against the turn\'s records, not all years', async () => {
    const leaves = [...LEAVES, { id: 104, employee_id: [15, 'Anna Müller'], state: 'validate', number_of_days: 10, request_date_from: '2025-07-01', request_date_to: '2025-07-14' }];
    const claim: HardClaim = { ...TOTAL, text: '9 Urlaubstage im Jahr 2026' };
    const withTurn = await checker({ 'hr.leave': leaves, 'hr.employee': EMPLOYEES }).check(claim, {
      turnRecords: TURN_15,
    });
    assert.equal(withTurn.status, 'verified', JSON.stringify(withTurn));
    // No turn records: the all-years total (19) cannot refute a 2026 claim.
    const without = await checker({ 'hr.leave': leaves, 'hr.employee': EMPLOYEES }).check({
      ...claim,
      value: 7,
      relatedEntities: ['hr.employee:15'],
    });
    assert.equal(without.status, 'unverified');
  });
});

describe('#1579 — a contradicted HR leave total is flagged', () => {
  // The case from the issue: one request raised from 6 to 11 days after the
  // tool returned, so Odoo holds 14 approved days; the answer says 9.
  const RAISED: Tables = {
    'hr.leave': LEAVES.map((r) => (r.id === 101 ? { ...r, number_of_days: 11 } : r)),
    'hr.employee': EMPLOYEES,
  };

  it('re-computes a total pinned on hr.employee from that employee\'s hr.leave rows', async () => {
    const calls: Call[] = [];
    const verdict = await checker(RAISED, calls).check(
      { ...TOTAL, text: 'Zusammen sind das 9 Tage', odooRecord: { model: 'hr.employee', id: 15 } },
      { turnRecords: TURN_15 },
    );
    assert.equal(verdict.status, 'contradicted', JSON.stringify(verdict));
    if (verdict.status === 'contradicted') assert.equal(verdict.truth, 14);
    const search = calls.find((c) => c.method === 'search_read');
    assert.equal(search?.model, 'hr.leave');
    assert.deepEqual(search?.positionalArgs[0], [['employee_id', '=', 15]]);
  });

  it('verifies the same claim when Odoo still holds 9 days', async () => {
    const verdict = await checker().check(
      { ...TOTAL, text: 'Zusammen sind das 9 Tage', odooRecord: { model: 'hr.employee', id: 15 } },
      { turnRecords: TURN_15 },
    );
    assert.equal(verdict.status, 'verified');
  });
});

describe('#1574 — claims without a record id are anchored on the turn\'s records', () => {
  it('confirms an amount one of the turn\'s records carries', async () => {
    const claim: HardClaim = {
      id: 'c_002',
      text: '6 Tage',
      type: 'amount',
      expectedSource: 'odoo',
      value: 6,
      odooRecord: { model: 'hr.leave' },
      relatedEntities: [],
    };
    assert.equal((await checker().check(claim, { turnRecords: TURN_15 })).status, 'verified');
    // A value no record the turn read carries stays unverified, not wrong.
    assert.equal(
      (await checker().check({ ...claim, value: 5 }, { turnRecords: TURN_15 })).status,
      'unverified',
    );
    // Without turn records nothing changes.
    assert.equal((await checker().check(claim)).status, 'unverified');
  });

  it('confirms the first and the last day of a leave the turn read', async () => {
    const from: HardClaim = {
      id: 'c_003',
      text: '02.03.2026',
      type: 'date',
      expectedSource: 'odoo',
      value: '2026-03-02',
      relatedEntities: [],
    };
    assert.equal((await checker().check(from, { turnRecords: TURN_15 })).status, 'verified');
    const to: HardClaim = { ...from, text: '09.03.2026', value: '2026-03-09' };
    assert.equal((await checker().check(to, { turnRecords: TURN_15 })).status, 'verified');
    const other: HardClaim = { ...from, text: '03.08.2026', value: '2026-08-03' };
    assert.equal(
      (await checker().check(other, { turnRecords: TURN_15 })).status,
      'unverified',
      'a leave the turn did not read is not looked up',
    );
  });

  it('confirms a name claim that is exactly a name the turn read', async () => {
    const name: Claim = {
      id: 'c_004',
      text: 'Frau Anna Müller',
      type: 'name',
      expectedSource: 'odoo',
      value: 'Anna Müller',
      relatedEntities: [],
    };
    const c = checker();
    assert.equal((await c.checkNameAgainstTurnRecords(name, { turnRecords: TURN_15 })).status, 'verified');
    // The extractor puts the bare name in `value`; the assertion is in the text.
    const more: Claim = { ...name, text: 'Anna Müller wechselte in die IT', value: 'Anna Müller' };
    assert.equal(
      (await c.checkNameAgainstTurnRecords(more, { turnRecords: TURN_15 })).status,
      'unverified',
      'a claim that says more than the name stays with the judge',
    );
    const stranger: Claim = { ...name, text: 'Dora Fink', value: 'Dora Fink' };
    assert.equal((await c.checkNameAgainstTurnRecords(stranger, { turnRecords: TURN_15 })).status, 'unverified');
  });
});

describe('toTurnRecords', () => {
  it('keeps Odoo records with a positive integer id, once each', () => {
    assert.deepEqual(
      toTurnRecords([
        { system: 'odoo', model: 'hr.employee', id: '15' },
        { system: 'odoo', model: 'hr.employee', id: 15 },
        { system: 'confluence', model: 'confluence.page', id: 4 },
        { system: 'odoo', model: 'hr.leave', id: 'x' },
      ]),
      [{ model: 'hr.employee', id: 15 }],
    );
  });
});

describe('#1574 — the pipeline confirms a correct HR answer from the turn\'s records', () => {
  const ANSWER = 'Anna Müller hat insgesamt 9 Urlaubstage.';
  const CLAIMS: Claim[] = [
    { id: 'c_001', text: 'Anna Müller', type: 'name', expectedSource: 'odoo', value: 'Anna Müller', relatedEntities: [] },
    { ...TOTAL, id: 'c_002', text: 'insgesamt 9 Urlaubstage' },
  ];

  function pipeline(judged: SoftClaim[]): VerifierPipeline {
    const extractor = {
      extract: () => Promise.resolve({ claims: CLAIMS, gaps: [] }),
    } as unknown as ClaimExtractor;
    const judge = {
      checkAll(claims: SoftClaim[]): Promise<ClaimVerdict[]> {
        judged.push(...claims);
        return Promise.resolve(claims.map((claim) => ({ status: 'unverified', claim, reason: 'no evidence' }) as ClaimVerdict));
      },
    } as unknown as EvidenceJudge;
    return new VerifierPipeline({ extractor, deterministic: checker(), judge, log: () => {} });
  }

  it('approves the answer with the turn records, without a judge call', async () => {
    const judged: SoftClaim[] = [];
    const verdict = await pipeline(judged).verify({
      runId: 'r1',
      userMessage: 'Wie viele Urlaubstage hat Anna Müller?',
      answer: ANSWER,
      domainToolsCalled: ['query_odoo_hr'],
      turnRecords: TURN_15,
    });
    assert.equal(verdict.status, 'approved', JSON.stringify(verdict));
    assert.deepEqual(judged, [], 'the name was confirmed deterministically');
  });

  it('stays unconfirmed without them, as before', async () => {
    const judged: SoftClaim[] = [];
    const verdict = await pipeline(judged).verify({
      runId: 'r2',
      userMessage: 'Wie viele Urlaubstage hat Anna Müller?',
      answer: ANSWER,
      domainToolsCalled: ['query_odoo_hr'],
    });
    assert.equal(verdict.status, 'approved_with_disclaimer');
    assert.equal(judged.length, 1, 'the name went to the judge');
  });
});

describe('a record reference on a model without known reference fields', () => {
  // Seen live after #1613: the extractor typed every leave period of a correct
  // HR answer as an `id` claim on hr.leave, and the name search refuted all 16.
  const period: HardClaim = {
    id: 'c_003',
    text: '15.09.2025–26.09.2025 (10 Tage)',
    type: 'id',
    expectedSource: 'odoo',
    odooRecord: { model: 'hr.leave', ref: '15.09.2025–26.09.2025' },
    relatedEntities: [],
  };

  it('stays unverified when the free-text name does not match', async () => {
    const verdict = await checker({ 'hr.leave': [] }).check(period);
    assert.equal(verdict.status, 'unverified', JSON.stringify(verdict));
  });

  it('is still verified when the name matches', async () => {
    const odoo: OdooReader = { execute: () => Promise.resolve([101]) };
    const verdict = await new DeterministicChecker({ odoo, log: () => {} }).check(period);
    assert.equal(verdict.status, 'verified');
  });

  it('a document number that does not exist is still contradicted', async () => {
    const odoo: OdooReader = { execute: () => Promise.resolve([]) };
    const verdict = await new DeterministicChecker({ odoo, log: () => {} }).check({
      ...period,
      text: 'INV/2026/9999',
      odooRecord: { model: 'account.move', ref: 'INV/2026/9999' },
    });
    assert.equal(verdict.status, 'contradicted');
  });
});
