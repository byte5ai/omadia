/**
 * #129 — unit tests for the golden-set harness LOGIC (corpus parsing, majority
 * voting, flake-tolerant runEntry, regression detection). No Anthropic key: the
 * stochastic model call is replaced by a scripted `RunOnce`, so this suite runs
 * in the default `npm test` glob and stays green key-free.
 *
 * Every assertion here is mutation-checked in review: flip the comparator in
 * runEntry, the tie rule in majority, or the re-run guard, and a case below goes
 * red. A green harness that catches nothing would make the whole eval decorative.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';

import {
  formatSummary,
  hasRegression,
  loadCorpusFromText,
  majority,
  parseCorpusLine,
  runEntry,
  type EntryRun,
  type GoldenEntry,
  type RunOnce,
  type StatusName,
  type VerdictTag,
  type ViaTag,
} from './golden/goldenRunner.js';
import { FixtureOdooReader } from './golden/fixtureOdooReader.js';

function entry(expected: StatusName, id = 'e'): GoldenEntry {
  return { id, userMessage: 'u', answer: 'a', expected: { status: expected } };
}

function entryVia(status: StatusName, via: ViaTag, id = 'e'): GoldenEntry {
  return { id, userMessage: 'u', answer: 'a', expected: { status, via } };
}

/** A RunOnce that yields scripted EntryRuns (status + verdict tags), then
 *  repeats the last — for exercising the `via` path assertion. */
function scriptedRuns(seq: EntryRun[]): RunOnce & { calls: () => number } {
  let i = 0;
  let calls = 0;
  const fn = ((): Promise<EntryRun> => {
    calls++;
    const run = seq[Math.min(i, seq.length - 1)] ?? seq[seq.length - 1]!;
    i++;
    return Promise.resolve(run);
  }) as unknown as RunOnce & { calls: () => number };
  fn.calls = (): number => calls;
  return fn;
}

function run(status: StatusName, verdicts?: VerdictTag[]): EntryRun {
  return { status, tokens: 10, ...(verdicts ? { verdicts } : {}) };
}

/** A RunOnce that yields a scripted sequence of statuses, then repeats the last.
 *  Records how many times it was called so the cost-aware path is observable. */
function scriptedRunOnce(seq: StatusName[]): RunOnce & { calls: () => number } {
  let i = 0;
  let calls = 0;
  const fn = ((): Promise<EntryRun> => {
    calls++;
    const status = seq[Math.min(i, seq.length - 1)] ?? seq[seq.length - 1]!;
    i++;
    return Promise.resolve({ status, tokens: 10 });
  }) as unknown as RunOnce & { calls: () => number };
  fn.calls = (): number => calls;
  return fn;
}

describe('goldenRunner/parseCorpusLine', () => {
  it('parses a valid entry with trace + evidence', () => {
    const e = parseCorpusLine(
      JSON.stringify({
        id: 'x',
        userMessage: 'q',
        answer: 'a [ref:n1]',
        trace: { knowledgeGraphToolsCalled: true },
        evidence: [{ nodeId: 'n1', source: 'graph', content: 'c' }],
        expected: { status: 'blocked' },
      }),
      'f.jsonl',
      3,
    );
    assert.equal(e.id, 'x');
    assert.equal(e.expected.status, 'blocked');
    assert.equal(e.trace?.knowledgeGraphToolsCalled, true);
    assert.equal(e.evidence?.[0]?.nodeId, 'n1');
  });

  it('throws with file:line on a missing required field', () => {
    assert.throws(
      () => parseCorpusLine(JSON.stringify({ id: 'x', answer: 'a', expected: { status: 'approved' } }), 'f.jsonl', 7),
      /f\.jsonl:7: missing\/empty string field "userMessage"/,
    );
  });

  it('throws on an unknown verdict status', () => {
    assert.throws(
      () => parseCorpusLine(JSON.stringify({ id: 'x', userMessage: 'q', answer: 'a', expected: { status: 'corrected' } }), 'f.jsonl', 1),
      /expected\.status.*approved.*approved_with_disclaimer.*blocked/,
    );
  });

  it('throws on malformed JSON', () => {
    assert.throws(() => parseCorpusLine('{not json', 'f.jsonl', 2), /f\.jsonl:2: invalid JSON/);
  });

  it('parses a v2 entry with expected.via and an odoo fixture (#639)', () => {
    const e = parseCorpusLine(
      JSON.stringify({
        id: 'v2',
        userMessage: 'q',
        answer: 'INV/2026/0042',
        trace: { domainToolsCalled: ['query_odoo_accounting'] },
        odoo: { records: [{ model: 'account.move', id: 42, fields: { name: 'INV/2026/0042' } }] },
        expected: { status: 'approved', via: 'deterministic-verified' },
      }),
      'f.jsonl',
      1,
    );
    assert.equal(e.expected.via, 'deterministic-verified');
    assert.equal(e.odoo?.records[0]?.id, 42);
  });

  it('throws on an unknown expected.via', () => {
    assert.throws(
      () =>
        parseCorpusLine(
          JSON.stringify({ id: 'x', userMessage: 'q', answer: 'a', expected: { status: 'approved', via: 'judge-verified' } }),
          'f.jsonl',
          4,
        ),
      /f\.jsonl:4: "expected\.via" must be one of/,
    );
  });

  it('throws when odoo.records is not an array', () => {
    assert.throws(
      () =>
        parseCorpusLine(
          JSON.stringify({ id: 'x', userMessage: 'q', answer: 'a', odoo: { records: 'nope' }, expected: { status: 'approved' } }),
          'f.jsonl',
          9,
        ),
      /f\.jsonl:9: "odoo\.records" must be an array/,
    );
  });
});

describe('goldenRunner/loadCorpusFromText', () => {
  it('skips blank lines and # comments', () => {
    const text = [
      '# a header comment',
      '',
      JSON.stringify({ id: 'a', userMessage: 'u', answer: 'a', expected: { status: 'approved' } }),
      '   ',
      JSON.stringify({ id: 'b', userMessage: 'u', answer: 'a', expected: { status: 'blocked' } }),
    ].join('\n');
    const entries = loadCorpusFromText(text, 'c.jsonl');
    assert.equal(entries.length, 2);
    assert.deepEqual(entries.map((e) => e.id), ['a', 'b']);
  });
});

describe('goldenRunner/majority', () => {
  it('returns the mode', () => {
    assert.deepEqual(majority(['blocked', 'approved', 'blocked']), { winner: 'blocked', count: 2 });
  });
  it('breaks a 3-way tie toward the earliest sample', () => {
    assert.equal(majority(['approved', 'blocked', 'approved_with_disclaimer']).winner, 'approved');
  });
  it('throws on an empty sample list', () => {
    assert.throws(() => majority([]), /empty sample list/);
  });
});

describe('goldenRunner/runEntry', () => {
  it('passes on the first sample and pays exactly ONE model call', async () => {
    const run = scriptedRunOnce(['approved']);
    const r = await runEntry(entry('approved'), run);
    assert.equal(r.pass, true);
    assert.equal(r.runs.length, 1);
    assert.equal(run.calls(), 1); // cost-aware: no re-runs on a green first try
    assert.equal(r.tokens, 10);
  });

  it('re-runs up to 3× on a first-sample miss and corrects a lone flake by majority', async () => {
    // first sample wrong, next two right -> majority approved -> pass
    const run = scriptedRunOnce(['blocked', 'approved', 'approved']);
    const r = await runEntry(entry('approved'), run);
    assert.equal(run.calls(), 3);
    assert.deepEqual(r.runs, ['blocked', 'approved', 'approved']);
    assert.equal(r.decided, 'approved');
    assert.equal(r.pass, true);
    assert.equal(r.tokens, 30);
  });

  it('fails when the majority genuinely disagrees with expected (real regression)', async () => {
    const run = scriptedRunOnce(['blocked', 'blocked', 'approved']);
    const r = await runEntry(entry('approved'), run);
    assert.equal(r.decided, 'blocked');
    assert.equal(r.pass, false);
  });

  it('honours a custom maxRuns', async () => {
    const run = scriptedRunOnce(['blocked', 'approved']);
    const r = await runEntry(entry('approved'), run, 2);
    assert.equal(run.calls(), 2);
    assert.deepEqual(r.runs, ['blocked', 'approved']);
  });
});

describe('goldenRunner/runEntry via path assertion (#639 v2)', () => {
  const VERIFIED_HARD: VerdictTag[] = [{ status: 'verified', claimType: 'id' }];
  const CONTRA_HARD: VerdictTag[] = [{ status: 'contradicted', claimType: 'amount' }];

  it('passes when the decided class AND the via path are both met', async () => {
    const r = await runEntry(
      entryVia('approved', 'deterministic-verified'),
      scriptedRuns([run('approved', VERIFIED_HARD)]),
    );
    assert.equal(r.pass, true);
    assert.equal(r.viaPass, true);
    assert.equal(r.via, 'deterministic-verified');
  });

  it('FAILS an approved reached with no verified hard claim — the empty-extraction trap', async () => {
    // Status matches but the path does not: an `approved` carrying no verified
    // hard verdict (e.g. the extractor returned zero claims) must NOT pass. This
    // is exactly the v1 blind spot #639 exists to close. The via-miss also
    // drives the re-runs, so we pay the full flake budget before failing.
    const runner = scriptedRuns([run('approved'), run('approved'), run('approved')]);
    const r = await runEntry(entryVia('approved', 'deterministic-verified'), runner);
    assert.equal(r.decided, 'approved');
    assert.equal(r.viaPass, false);
    assert.equal(r.pass, false);
    assert.equal(runner.calls(), 3);
  });

  it('is flake-tolerant on the path: a lone via-miss is corrected by majority', async () => {
    const r = await runEntry(
      entryVia('approved', 'deterministic-verified'),
      scriptedRuns([run('approved'), run('approved', VERIFIED_HARD), run('approved', VERIFIED_HARD)]),
    );
    assert.equal(r.pass, true);
    assert.equal(r.viaPass, true);
  });

  it('deterministic-contradicted is satisfied by a contradicted HARD claim', async () => {
    const r = await runEntry(
      entryVia('blocked', 'deterministic-contradicted'),
      scriptedRuns([run('blocked', CONTRA_HARD)]),
    );
    assert.equal(r.pass, true);
    assert.equal(r.viaPass, true);
  });

  it('a SOFT (judge) contradiction does NOT satisfy deterministic-contradicted', async () => {
    // Same blocked class, but the contradiction is on a qualitative claim — the
    // judge path, not the deterministic checker. Keeps the two block-via-
    // contradiction paths from being conflated.
    const soft: VerdictTag[] = [{ status: 'contradicted', claimType: 'qualitative' }];
    const runner = scriptedRuns([run('blocked', soft), run('blocked', soft), run('blocked', soft)]);
    const r = await runEntry(entryVia('blocked', 'deterministic-contradicted'), runner);
    assert.equal(r.decided, 'blocked');
    assert.equal(r.viaPass, false);
    assert.equal(r.pass, false);
  });

  it('a green first sample on both class and path costs exactly one call', async () => {
    const runner = scriptedRuns([run('approved', VERIFIED_HARD)]);
    await runEntry(entryVia('approved', 'deterministic-verified'), runner);
    assert.equal(runner.calls(), 1);
  });
});

describe('golden/FixtureOdooReader (#639 v2)', () => {
  const reader = new FixtureOdooReader({
    records: [
      { model: 'account.move', id: 42, fields: { name: 'INV/2026/0042', amount_total: 1234.56 } },
      { model: 'account.move', id: 7, fields: { name: 'INV/2026/0007', amount_total: 99 } },
      { model: 'hr.leave', id: 3, fields: { number_of_days: 2, employee_id: 7 } },
      { model: 'hr.leave', id: 4, fields: { number_of_days: 5, employee_id: 7 } },
    ],
  });

  it('read([id],[field]) returns the row with id + selected fields', async () => {
    const rows = (await reader.execute({
      model: 'account.move',
      method: 'read',
      positionalArgs: [[42], ['amount_total']],
      kwargs: {},
    })) as Array<Record<string, unknown>>;
    assert.deepEqual(rows, [{ id: 42, amount_total: 1234.56 }]);
  });

  it('read of a missing id returns [] (checker reads that as "not found")', async () => {
    const rows = (await reader.execute({
      model: 'account.move',
      method: 'read',
      positionalArgs: [[999], ['amount_total']],
      kwargs: {},
    })) as unknown[];
    assert.deepEqual(rows, []);
  });

  it('search on name = present ref returns the id; absent ref returns []', async () => {
    const hit = (await reader.execute({
      model: 'account.move',
      method: 'search',
      positionalArgs: [[['name', '=', 'INV/2026/0042']]],
      kwargs: { limit: 1 },
    })) as number[];
    assert.deepEqual(hit, [42]);
    const miss = (await reader.execute({
      model: 'account.move',
      method: 'search',
      positionalArgs: [[['name', '=', 'INV/2026/0099']]],
      kwargs: { limit: 1 },
    })) as number[];
    assert.deepEqual(miss, []);
  });

  it('search_read filters by an employee_id domain and projects the field', async () => {
    const rows = (await reader.execute({
      model: 'hr.leave',
      method: 'search_read',
      positionalArgs: [[['employee_id', '=', 7]], ['number_of_days']],
      kwargs: { limit: 1000 },
    })) as Array<Record<string, unknown>>;
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.number_of_days).sort(), [2, 5]);
  });

  it('does not leak rows across models', async () => {
    const rows = (await reader.execute({
      model: 'account.move',
      method: 'search_read',
      positionalArgs: [[], ['amount_total']],
      kwargs: {},
    })) as unknown[];
    assert.equal(rows.length, 2); // the two account.move rows, not hr.leave
  });
});

describe('goldenRunner/corpus integrity (#129 acceptance, key-free)', () => {
  const dir = new URL('./golden/corpus/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  const entries = files.flatMap((f) =>
    loadCorpusFromText(readFileSync(new URL(f, dir), 'utf8'), f),
  );

  it('every corpus line parses and there are at least 14 entries', () => {
    assert.ok(files.length > 0, 'corpus dir must contain .jsonl files');
    assert.ok(entries.length >= 14, `expected >= 14 entries, got ${entries.length}`);
  });

  it('entry ids are unique', () => {
    const ids = entries.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it('covers all three VerifierVerdict statuses', () => {
    const statuses = new Set(entries.map((e) => e.expected.status));
    assert.ok(statuses.has('approved'));
    assert.ok(statuses.has('approved_with_disclaimer'));
    assert.ok(statuses.has('blocked'));
  });

  it('covers the tool_postcondition and citation_missing claim paths', () => {
    const hasToolPostcondition = entries.some(
      (e) => (e.trace?.toolPostconditionViolations?.length ?? 0) > 0,
    );
    const hasCitationPath = entries.some(
      (e) => e.trace?.knowledgeGraphToolsCalled === true,
    );
    assert.ok(hasToolPostcondition, 'need a tool_postcondition (#130) fixture');
    assert.ok(hasCitationPath, 'need a citation_missing (#131) fixture');
  });

  it('covers the deterministic verified (Gap 1) and contradicted (Gap 2) paths (#639)', () => {
    const verifiedEntry = entries.find(
      (e) => e.expected.via === 'deterministic-verified',
    );
    const contradictedEntry = entries.find(
      (e) => e.expected.via === 'deterministic-contradicted',
    );
    assert.ok(verifiedEntry, 'need a deterministic-verified -> approved fixture (Gap 1)');
    assert.ok(contradictedEntry, 'need a deterministic-contradicted -> blocked fixture (Gap 2)');
    // Both paths need an odoo fixture to re-query and a declared Odoo call so the
    // trace-cross-check does not pre-empt the deterministic checker.
    for (const e of [verifiedEntry, contradictedEntry]) {
      assert.ok((e.odoo?.records.length ?? 0) > 0, `${e.id}: expected an odoo fixture`);
      assert.ok(
        e.trace?.domainToolsCalled?.some((t) => t.startsWith('query_odoo_')),
        `${e.id}: expected a query_odoo_* call in the trace`,
      );
    }
    assert.equal(verifiedEntry.expected.status, 'approved');
    assert.equal(contradictedEntry.expected.status, 'blocked');
  });
});

describe('goldenRunner/hasRegression + formatSummary', () => {
  it('detects at least one failing entry', async () => {
    const pass = await runEntry(entry('approved', 'ok'), scriptedRunOnce(['approved']));
    const fail = await runEntry(entry('blocked', 'bad'), scriptedRunOnce(['approved', 'approved', 'approved']));
    assert.equal(hasRegression([pass]), false);
    assert.equal(hasRegression([pass, fail]), true);
  });

  it('summary reports counts, per-entry token cost and total', async () => {
    const results = [
      await runEntry(entry('approved', 'ok'), scriptedRunOnce(['approved'])),
      await runEntry(entry('blocked', 'bad'), scriptedRunOnce(['approved', 'approved', 'approved'])),
    ];
    const summary = formatSummary(results);
    assert.match(summary, /PASS {2}ok/);
    assert.match(summary, /FAIL {2}bad/);
    assert.match(summary, /1\/2 passed, 1 regressed, 40 tokens total/);
  });
});
