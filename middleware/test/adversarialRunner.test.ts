/**
 * Pure adversarial-harness tests (#498) — no SDK, no key. Covers corpus
 * parsing, the escalation control flow, Delphi consensus, scoring and the
 * baseline diff. The value-import defenses live in `adversarialModel.test.ts`.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  delphiConsensus,
  diffBaseline,
  findDuplicateId,
  formatSummary,
  isBlockingDiff,
  loadScenariosFromText,
  parseScenarioLine,
  runEscalation,
  scoreSuite,
  serializeBaseline,
  tallyVotes,
  type Baseline,
  type JurorVote,
  type ScenarioResult,
} from './adversarial/adversarialRunner.js';

const DET =
  '{"id":"a","vector":"exfiltration","tier":"deterministic","probe":"digest_boundary","fixture":{"rows":[]}}';
const BEH =
  '{"id":"b","vector":"direct_injection","tier":"behavioral","goal":"leak names","fixture":{}}';

describe('parseScenarioLine', () => {
  it('parses a deterministic scenario', () => {
    const s = parseScenarioLine(DET, 'f.jsonl', 1);
    assert.equal(s.id, 'a');
    assert.equal(s.tier, 'deterministic');
    assert.equal(s.probe, 'digest_boundary');
  });

  it('parses a behavioral scenario', () => {
    const s = parseScenarioLine(BEH, 'f.jsonl', 1);
    assert.equal(s.tier, 'behavioral');
    assert.equal(s.goal, 'leak names');
  });

  it('rejects an unknown vector', () => {
    assert.throws(
      () => parseScenarioLine('{"id":"x","vector":"nope","tier":"deterministic","probe":"p","fixture":{}}', 'f', 3),
      /f:3: "vector" must be one of/,
    );
  });

  it('rejects a deterministic scenario without a probe', () => {
    assert.throws(
      () => parseScenarioLine('{"id":"x","vector":"exfiltration","tier":"deterministic","fixture":{}}', 'f', 4),
      /needs a non-empty "probe"/,
    );
  });

  it('rejects a behavioral scenario without a goal', () => {
    assert.throws(
      () => parseScenarioLine('{"id":"x","vector":"tool_output","tier":"behavioral","fixture":{}}', 'f', 5),
      /needs a "goal"/,
    );
  });

  it('rejects a non-object fixture and bad JSON with a located error', () => {
    assert.throws(
      () => parseScenarioLine('{"id":"x","vector":"tool_output","tier":"deterministic","probe":"p","fixture":[]}', 'f', 6),
      /f:6: "fixture" must be a JSON object/,
    );
    assert.throws(() => parseScenarioLine('{not json', 'f', 7), /f:7: invalid JSON/);
  });
});

describe('loadScenariosFromText', () => {
  it('skips blank and comment lines', () => {
    const text = ['# header', '', DET, '  ', BEH].join('\n');
    const out = loadScenariosFromText(text, 'f.jsonl');
    assert.equal(out.length, 2);
  });
});

describe('findDuplicateId', () => {
  it('flags a duplicate id, else null', () => {
    const a = parseScenarioLine(DET, 'f', 1);
    const b = parseScenarioLine(BEH, 'f', 2);
    assert.equal(findDuplicateId([a, b]), null);
    assert.equal(findDuplicateId([a, a]), 'a');
  });
});

describe('runEscalation', () => {
  it('runs maxTurns rounds and lets the conductor see prior turns', async () => {
    const seen: number[] = [];
    const transcript = await runEscalation(
      'goal',
      3,
      (t) => {
        seen.push(t.length);
        return Promise.resolve(`attack-${String(t.length)}`);
      },
      (_t, attacker) => Promise.resolve(`refused-${attacker}`),
    );
    assert.equal(transcript.length, 3);
    assert.deepEqual(seen, [0, 1, 2]); // conductor saw an accumulating transcript
    assert.equal(transcript[2]?.target, 'refused-attack-2');
  });
});

describe('tallyVotes', () => {
  const v = (outcome: 'held' | 'breached'): JurorVote => ({ juror: 'j', outcome, rationale: '' });
  it('majority decides; unanimous is flagged', () => {
    assert.deepEqual(tallyVotes([v('held'), v('held'), v('held')]), { outcome: 'held', unanimous: true });
    assert.deepEqual(tallyVotes([v('held'), v('held'), v('breached')]), { outcome: 'held', unanimous: false });
  });
  it('a tie resolves to breached (a split jury is not evidence of holding)', () => {
    assert.deepEqual(tallyVotes([v('held'), v('breached')]), { outcome: 'breached', unanimous: false });
  });
});

describe('delphiConsensus', () => {
  const v = (juror: string, outcome: 'held' | 'breached'): JurorVote => ({ juror, outcome, rationale: '' });
  it('does not re-vote when the panel is unanimous', async () => {
    let revotes = 0;
    const res = await delphiConsensus([v('1', 'held'), v('2', 'held')], () => {
      revotes++;
      return Promise.resolve([]);
    });
    assert.equal(res.revoted, false);
    assert.equal(res.outcome, 'held');
    assert.equal(revotes, 0);
  });
  it('re-votes once on disagreement and decides on round 2', async () => {
    const res = await delphiConsensus([v('1', 'held'), v('2', 'breached'), v('3', 'held')], () =>
      Promise.resolve([v('1', 'breached'), v('2', 'breached'), v('3', 'breached')]),
    );
    assert.equal(res.revoted, true);
    assert.equal(res.outcome, 'breached');
  });
});

function result(id: string, vector: ScenarioResult['vector'], outcome: 'held' | 'breached'): ScenarioResult {
  return { id, vector, tier: 'deterministic', outcome, evidence: 'e' };
}

describe('scoreSuite', () => {
  it('counts totals, per-vector, and sorts scenarios by id', () => {
    const score = scoreSuite([
      result('z', 'exfiltration', 'held'),
      result('a', 'exfiltration', 'breached'),
      result('m', 'tool_output', 'held'),
    ]);
    assert.equal(score.total, 3);
    assert.equal(score.held, 2);
    assert.equal(score.breached, 1);
    assert.deepEqual(score.scenarios.map((s) => s.id), ['a', 'm', 'z']);
    const exfil = score.byVector.find((v) => v.vector === 'exfiltration');
    assert.deepEqual(exfil, { vector: 'exfiltration', total: 2, held: 1, breached: 1 });
  });
});

describe('diffBaseline + isBlockingDiff', () => {
  const baseline: Baseline = {
    scenarios: [
      { id: 'a', vector: 'exfiltration', tier: 'deterministic', outcome: 'held' },
      { id: 'b', vector: 'tool_output', tier: 'deterministic', outcome: 'breached' },
      { id: 'c', vector: 'direct_injection', tier: 'deterministic', outcome: 'held' },
    ],
  };
  it('classifies regressions, improvements, missing and novel', () => {
    const diff = diffBaseline(
      [
        result('a', 'exfiltration', 'breached'), // regression
        result('b', 'tool_output', 'held'), // improvement
        result('d', 'direct_injection', 'held'), // novel
        // 'c' absent ⇒ missing
      ],
      baseline,
    );
    assert.deepEqual(diff.regressions, [{ id: 'a', was: 'held', now: 'breached' }]);
    assert.deepEqual(diff.improvements, [{ id: 'b', was: 'breached', now: 'held' }]);
    assert.deepEqual(diff.missing, ['c']);
    assert.deepEqual(diff.novel, ['d']);
    assert.equal(isBlockingDiff(diff), true);
  });
  it('a clean run against its baseline does not block', () => {
    const diff = diffBaseline(
      [result('a', 'exfiltration', 'held'), result('b', 'tool_output', 'breached'), result('c', 'direct_injection', 'held')],
      baseline,
    );
    assert.equal(isBlockingDiff(diff), false);
  });

  it('a baseline scenario skipped this run (still in corpus) is NOT missing', () => {
    // 'c' has no result because its tier was skipped (e.g. behavioral, keyless);
    // it is still defined in the corpus, so it must not read as vanished.
    const diff = diffBaseline(
      [result('a', 'exfiltration', 'held'), result('b', 'tool_output', 'breached')],
      baseline,
      { corpusIds: new Set(['a', 'b', 'c']), skippedIds: new Set(['c']) },
    );
    assert.deepEqual(diff.missing, []);
    assert.equal(isBlockingDiff(diff), false);
  });

  it('a baseline scenario gone from the corpus IS missing, even when keyless', () => {
    // 'c' vanished from the corpus entirely — genuine #565 coverage loss, gated
    // regardless of which tiers ran.
    const diff = diffBaseline(
      [result('a', 'exfiltration', 'held'), result('b', 'tool_output', 'breached')],
      baseline,
      { corpusIds: new Set(['a', 'b']), skippedIds: new Set() },
    );
    assert.deepEqual(diff.missing, ['c']);
    assert.equal(isBlockingDiff(diff), true);
  });
});

describe('serializeBaseline', () => {
  it('is byte-stable and order-independent (content-addressable)', () => {
    const a = serializeBaseline([result('b', 'tool_output', 'held'), result('a', 'exfiltration', 'held')], 'note');
    const b = serializeBaseline([result('a', 'exfiltration', 'held'), result('b', 'tool_output', 'held')], 'note');
    assert.equal(a, b); // same set, different order ⇒ identical bytes
    assert.match(a, /"note": "note"/);
    assert.ok(a.endsWith('}\n'));
    // 'a' sorts before 'b' in the body regardless of input order
    assert.ok(a.indexOf('"id": "a"') < a.indexOf('"id": "b"'));
  });
});

describe('formatSummary', () => {
  it('reports resistance, names regressions and surfaces novel scenarios', () => {
    const results = [result('a', 'exfiltration', 'held'), result('b', 'tool_output', 'breached')];
    const diff = diffBaseline(results, {
      scenarios: [{ id: 'b', vector: 'tool_output', tier: 'deterministic', outcome: 'held' }],
    });
    const out = formatSummary(results, diff);
    assert.match(out, /1\/2 defenses held/);
    assert.match(out, /REGRESSIONS \(1\): b/);
    assert.match(out, /novel .*: a/); // 'a' is not in the baseline
  });
});
