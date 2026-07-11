import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  evaluateDiffPolicy,
  type DiffPolicyInput,
  type NumstatEntry,
} from '../../src/devplatform/policy/diffPolicyEngine.js';
import { parseUnifiedDiff } from '../../src/devplatform/policy/parseUnifiedDiff.js';

/**
 * Epic #470 W3 — diffPolicyEngine unit tests.
 *
 * The engine cross-checks parser totals against the uploaded `--numstat`
 * (rule `diff-integrity`). Except for the dedicated mismatch test, every case
 * derives its numstat FROM the parser via `truthfulNumstat`, so integrity is
 * satisfied and only the rule under test is exercised.
 */

/** Build an "add new file" unified diff — the easiest shape to keep hunk counts exact. */
function addFileDiff(path: string, lines: string[]): string {
  const body = lines.map((l) => '+' + l).join('\n');
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    'index 0000000000000000000000000000000000000000..1111111111111111111111111111111111111111',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    body,
    '',
  ].join('\n');
}

/** Honest numstat that agrees with the parser — keeps diff-integrity green. */
function truthfulNumstat(diff: string): NumstatEntry[] {
  return parseUnifiedDiff(diff).map((f) => ({
    path: f.path,
    additions: f.additions,
    deletions: f.deletions,
    binary: f.binary,
  }));
}

function evalDiff(diff: string, extra: Partial<DiffPolicyInput> = {}) {
  return evaluateDiffPolicy({
    diff,
    numstat: extra.numstat ?? truthfulNumstat(diff),
    jobTokens: [],
    ...extra,
  });
}

const ruleIds = (v: { findings: Array<{ ruleId: string }> }) => v.findings.map((f) => f.ruleId).sort();

describe('diffPolicyEngine — v1 rules', () => {
  it('a clean small diff → allow', () => {
    const diff = addFileDiff('src/foo.ts', ['export const a = 1;', 'export const b = 2;']);
    const v = evalDiff(diff);
    assert.equal(v.decision, 'allow');
    assert.deepEqual(v.findings, []);
    assert.equal(v.stats.filesTouched, 1);
    assert.equal(v.stats.additions, 2);
  });

  it('a .github/workflows/ci.yml touch → gate (protected-ci)', () => {
    const v = evalDiff(addFileDiff('.github/workflows/ci.yml', ['on: push']));
    assert.equal(v.decision, 'gate');
    assert.ok(ruleIds(v).includes('protected-ci'));
  });

  it('> 50 files → gate (max-files)', () => {
    const diffs = Array.from({ length: 51 }, (_, i) => addFileDiff(`src/f${i}.ts`, ['x']));
    const v = evalDiff(diffs.join(''));
    assert.equal(v.decision, 'gate');
    assert.ok(ruleIds(v).includes('max-files'));
    assert.equal(v.stats.filesTouched, 51);
  });

  it('> maxAddedLines → gate (max-added-lines, override-configurable)', () => {
    const diff = addFileDiff('src/big.ts', ['a', 'b', 'c', 'd', 'e', 'f']);
    const v = evalDiff(diff, { policyOverrides: { maxAddedLines: 5 } });
    assert.equal(v.decision, 'gate');
    assert.ok(ruleIds(v).includes('max-added-lines'));
  });

  it('a .git/config path → DENY (git-internals)', () => {
    const v = evalDiff(addFileDiff('.git/config', ['[core]']));
    // COUNTER-PROOF: if the git-internals rule is removed from the engine, this
    // diff touches no protected/manifest path and is small → decision would be
    // 'allow' and BOTH assertions below fail. Revert the rule to confirm.
    assert.equal(v.decision, 'deny');
    assert.ok(ruleIds(v).includes('git-internals'));
  });

  it('a ../etc/passwd path → DENY (git-internals)', () => {
    const v = evalDiff(addFileDiff('../etc/passwd', ['root:x:0:0']));
    assert.equal(v.decision, 'deny');
    assert.ok(ruleIds(v).includes('git-internals'));
  });

  it('a credential in the DIFF → DENY (credential-content)', () => {
    const secret = 'ghp_' + 'A'.repeat(36);
    const v = evalDiff(addFileDiff('src/config.ts', [`const t = "${secret}";`]));
    // COUNTER-PROOF: remove the credential-content rule and this diff (a normal
    // small src file) → decision 'allow'; this assertion fails. Revert to confirm.
    assert.equal(v.decision, 'deny');
    assert.ok(ruleIds(v).includes('credential-content'));
  });

  it('a credential in the PR BODY → DENY (credential-content)', () => {
    const secret = 'ghp_' + 'B'.repeat(36);
    const v = evalDiff(addFileDiff('src/ok.ts', ['const ok = 1;']), { prBody: `deploy with ${secret}` });
    assert.equal(v.decision, 'deny');
    assert.ok(ruleIds(v).includes('credential-content'));
  });

  it('a credential in a TRACKER COMMENT → DENY (credential-content)', () => {
    const secret = 'ghp_' + 'C'.repeat(36);
    const v = evalDiff(addFileDiff('src/ok.ts', ['const ok = 1;']), { trackerComments: ['fyi', `key ${secret}`] });
    assert.equal(v.decision, 'deny');
    assert.ok(ruleIds(v).includes('credential-content'));
  });

  it('manifest + lockfile → gate; lockfile-only → allow', () => {
    const both = evalDiff(
      addFileDiff('package.json', ['{}']) + addFileDiff('package-lock.json', ['{}']),
    );
    assert.equal(both.decision, 'gate');
    assert.ok(ruleIds(both).includes('dep-manifest-lockfile'));

    const lockOnly = evalDiff(addFileDiff('package-lock.json', ['{ "v": 3 }']));
    assert.equal(lockOnly.decision, 'allow', 'a lockfile-only change is allowed');
  });

  it('numstat understated by the runner → gate (diff-integrity)', () => {
    const diff = addFileDiff('src/foo.ts', ['a', 'b', 'c']);
    const honest = truthfulNumstat(diff);
    const understated = honest.map((e) => ({ ...e, additions: Math.max(0, e.additions - 1) }));
    const v = evalDiff(diff, { numstat: understated });
    assert.equal(v.decision, 'gate');
    assert.ok(ruleIds(v).includes('diff-integrity'));
  });

  it('deny precedence: a deny alongside a gate → deny', () => {
    // A protected CI file (gate) AND a .git path (deny) in one diff.
    const diff = addFileDiff('.github/workflows/ci.yml', ['on: push']) + addFileDiff('.git/hooks/pre', ['#!/bin/sh']);
    const v = evalDiff(diff);
    assert.equal(v.decision, 'deny');
    assert.ok(ruleIds(v).includes('git-internals'));
    assert.ok(ruleIds(v).includes('protected-ci'));
  });
});

describe('diffPolicyEngine — override merge', () => {
  it('raising maxFiles clears the max-files gate', () => {
    const diff = Array.from({ length: 51 }, (_, i) => addFileDiff(`src/f${i}.ts`, ['x'])).join('');
    const v = evalDiff(diff, { policyOverrides: { maxFiles: 100 } });
    assert.equal(v.decision, 'allow');
  });

  it('adding an extraProtectedGlob gates an otherwise-clean path', () => {
    const diff = addFileDiff('docs/readme.md', ['# hi']);
    assert.equal(evalDiff(diff).decision, 'allow', 'clean without the override');
    const v = evalDiff(diff, { policyOverrides: { extraProtectedGlobs: ['docs/**'] } });
    assert.equal(v.decision, 'gate');
    assert.ok(ruleIds(v).includes('protected-ci'));
  });

  it('unprotecting a glob clears the protected-ci gate', () => {
    const diff = addFileDiff('.github/workflows/ci.yml', ['on: push']);
    assert.equal(evalDiff(diff).decision, 'gate', 'gated without the override');
    const v = evalDiff(diff, { policyOverrides: { unprotectedGlobs: ['.github/workflows/**'] } });
    assert.equal(v.decision, 'allow');
  });

  it('an override CANNOT disable the git-internals deny', () => {
    const diff = addFileDiff('.git/config', ['[core]']);
    // Unprotect everything and raise every threshold — deny must survive.
    const v = evalDiff(diff, {
      policyOverrides: { unprotectedGlobs: ['**'], maxFiles: 9999, maxAddedLines: 9999 },
    });
    // COUNTER-PROOF: git-internals is a deny rule, structurally separate from the
    // override knobs. If the rule were removed, `unprotectedGlobs: ['**']` leaves
    // nothing → 'allow'; this assertion fails. Revert the rule to confirm.
    assert.equal(v.decision, 'deny');
    assert.ok(ruleIds(v).includes('git-internals'));
  });

  it('an override CANNOT disable the credential-content deny', () => {
    const secret = 'ghp_' + 'D'.repeat(36);
    const diff = addFileDiff('src/config.ts', [`const t = "${secret}";`]);
    const v = evalDiff(diff, { policyOverrides: { unprotectedGlobs: ['**'], maxFiles: 9999 } });
    // COUNTER-PROOF: credential-content is non-overridable. Remove the rule and
    // this diff → 'allow'; this assertion fails. Revert the rule to confirm.
    assert.equal(v.decision, 'deny');
    assert.ok(ruleIds(v).includes('credential-content'));
  });
});

/** An "add new file" diff with an explicit mode (e.g. 120000 for a symlink). */
function addFileDiffMode(path: string, lines: string[], mode: string): string {
  const body = lines.map((l) => '+' + l).join('\n');
  return [
    `diff --git a/${path} b/${path}`,
    `new file mode ${mode}`,
    'index 0000000000000000000000000000000000000000..1111111111111111111111111111111111111111',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    body,
    '',
  ].join('\n');
}

describe('diffPolicyEngine — Forge W3 deny-bypass regressions', () => {
  it('a secret on an added line whose CONTENT starts with `++` is still DENY (not a header)', () => {
    // git emits the hunk line as `+` + content; content `++ghp_...` → `+++ghp_...`.
    // The old raw-string guard mistook it for the `+++ b/path` header and skipped it.
    const secret = 'ghp_' + 'E'.repeat(36);
    const diff = addFileDiff('src/x.ts', ['++' + secret]);
    const v = evalDiff(diff);
    assert.equal(v.decision, 'deny', 'the ++-prefixed secret line must not slip the credential deny');
    assert.ok(ruleIds(v).includes('credential-content'));
  });

  it('git-internals is case-insensitive — .GIT/ is DENY', () => {
    const v = evalDiff(addFileDiff('.GIT/config', ['[core]']));
    assert.equal(v.decision, 'deny');
    assert.ok(ruleIds(v).includes('git-internals'));
  });

  it('a symlink whose TARGET is .git/ (or escapes via ..) is DENY', () => {
    const intoGit = evalDiff(addFileDiffMode('hook-link', ['.git/hooks/pre-commit'], '120000'));
    assert.equal(intoGit.decision, 'deny', 'a symlink into .git/ is git-internals');
    assert.ok(ruleIds(intoGit).includes('git-internals'));
    const escape = evalDiff(addFileDiffMode('escape', ['../../../../etc/cron.d/pwn'], '120000'));
    assert.equal(escape.decision, 'deny', 'a symlink escaping the tree is git-internals');
  });

  it('a secret split across two added lines is still caught (whitespace-joined scan)', () => {
    const secret = 'ghp_' + 'F'.repeat(36);
    const half = secret.length >> 1;
    const diff = addFileDiff('src/y.ts', [secret.slice(0, half), secret.slice(half)]);
    const v = evalDiff(diff);
    assert.equal(v.decision, 'deny', 'a secret split across + lines must still deny');
    assert.ok(ruleIds(v).includes('credential-content'));
  });

  it("scans the job's OWN token values (jobTokens is required, no fail-open)", () => {
    const nonce = 'job-nonce-' + 'Z'.repeat(24);
    const diff = addFileDiff('src/leak.ts', [`const x = "${nonce}";`]);
    const v = evalDiff(diff, { jobTokens: [nonce] });
    assert.equal(v.decision, 'deny', "the job's own token in the diff is a leak");
    assert.ok(ruleIds(v).includes('credential-content'));
  });
});

describe('diffPolicyEngine — determinism', () => {
  it('same input → identical verdict', () => {
    const diff =
      addFileDiff('.github/workflows/ci.yml', ['on: push']) +
      addFileDiff('package.json', ['{}']) +
      addFileDiff('src/foo.ts', ['const a = 1;']);
    const input: DiffPolicyInput = { diff, numstat: truthfulNumstat(diff), jobTokens: [] };
    assert.deepEqual(evaluateDiffPolicy(input), evaluateDiffPolicy(input));
  });
});
