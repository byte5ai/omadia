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
} from './golden/goldenRunner.js';

function entry(expected: StatusName, id = 'e'): GoldenEntry {
  return { id, userMessage: 'u', answer: 'a', expected: { status: expected } };
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

describe('goldenRunner/corpus integrity (#129 acceptance, key-free)', () => {
  const dir = new URL('./golden/corpus/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  const entries = files.flatMap((f) =>
    loadCorpusFromText(readFileSync(new URL(f, dir), 'utf8'), f),
  );

  it('every corpus line parses and there are at least 12 entries', () => {
    assert.ok(files.length > 0, 'corpus dir must contain .jsonl files');
    assert.ok(entries.length >= 12, `expected >= 12 entries, got ${entries.length}`);
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
