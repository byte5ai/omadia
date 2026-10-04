// The audit leg's decision (audit-gate.mjs): production findings always fail,
// development-only findings pass only with a valid, unexpired exception that
// names every route into the tree.
//
// Run: node --test .github/scripts/audit-gate.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { blockingAdvisories, evaluate, exceptionProblems, rootsOf } from './audit-gate.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const URL = 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc';

/** A report shaped like npm's: the advisory on the vulnerable package, dependents linked by `effects`. */
function lintChainReport() {
  return {
    vulnerabilities: {
      'glob-lib': {
        name: 'glob-lib',
        severity: 'high',
        isDirect: false,
        via: [{ source: 1, name: 'glob-lib', title: 'nested patterns', url: URL, severity: 'high', range: '<=3.0.3' }],
        effects: ['matcher'],
      },
      matcher: { name: 'matcher', severity: 'high', isDirect: false, via: ['glob-lib'], effects: ['lint-config'] },
      'lint-config': { name: 'lint-config', severity: 'high', isDirect: true, via: ['matcher'], effects: [] },
    },
  };
}

const clean = { vulnerabilities: {} };
const packageJson = { dependencies: { next: '^16.0.0' }, devDependencies: { 'lint-config': '^16.0.0' } };

function exception(overrides = {}) {
  return {
    advisory: 'GHSA-aaaa-bbbb-cccc',
    package: 'glob-lib',
    workspaces: ['web-ui'],
    via: ['lint-config'],
    reason: 'Expands the repository’s own static lint patterns only, never request input.',
    reviewed: '2026-10-04',
    expires: '2026-11-15',
    ...overrides,
  };
}

function decide({ full = lintChainReport(), prod = clean, pkg = packageJson, entries = [exception()], workspace = 'web-ui', today = '2026-10-10' } = {}) {
  return evaluate({ workspace, full, prod, packageJson: pkg, exceptions: { exceptions: entries }, today });
}

test('a development-only advisory with a valid exception passes and is reported', () => {
  const result = decide();
  assert.deepEqual(result.failures, []);
  assert.equal(result.notices.length, 1);
  assert.match(result.notices[0], /GHSA-aaaa-bbbb-cccc in glob-lib \(via lint-config\) accepted until 2026-11-15/);
});

test('without an exception the advisory fails the leg', () => {
  const result = decide({ entries: [] });
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /has no exception/);
});

test('an exception for another workspace or advisory does not apply', () => {
  assert.equal(decide({ entries: [exception({ workspaces: ['middleware'] })] }).failures.length, 1);
  assert.equal(decide({ entries: [exception({ advisory: 'GHSA-zzzz-zzzz-zzzz' })] }).failures.length, 1);
});

test('an expired exception fails; the expiry day itself still passes', () => {
  assert.deepEqual(decide({ today: '2026-11-15' }).failures, []);
  const result = decide({ today: '2026-11-16' });
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /expired on 2026-11-15/);
});

test('an advisory in the production tree fails even with an exception', () => {
  const result = decide({ prod: lintChainReport() });
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /production tree/);
});

test('a route through a runtime dependency fails even when the exception names it', () => {
  const full = lintChainReport();
  full.vulnerabilities.matcher.effects = ['lint-config', 'electron'];
  full.vulnerabilities.electron = { name: 'electron', severity: 'high', isDirect: true, via: ['matcher'], effects: [] };
  const result = decide({
    full,
    workspace: 'desktop',
    pkg: { devDependencies: { 'lint-config': '1', electron: '44' } },
    entries: [exception({ workspaces: ['desktop'], via: ['lint-config', 'electron'] })],
  });
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /electron ships as a runtime/);
});

test('a route through a production dependency fails', () => {
  const full = lintChainReport();
  full.vulnerabilities.matcher.effects = ['lint-config', 'next'];
  full.vulnerabilities.next = { name: 'next', severity: 'high', isDirect: true, via: ['matcher'], effects: [] };
  const result = decide({ full, entries: [exception({ via: ['lint-config', 'next'] })] });
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /next is not a devDependency/);
});

test('a route the exception does not name fails', () => {
  const full = lintChainReport();
  full.vulnerabilities.matcher.effects = ['lint-config', 'test-runner'];
  full.vulnerabilities['test-runner'] = { name: 'test-runner', severity: 'high', isDirect: true, via: ['matcher'], effects: [] };
  const result = decide({ full, pkg: { devDependencies: { 'lint-config': '1', 'test-runner': '1' } } });
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /does not name test-runner/);
});

test('a chain that ends nowhere fails closed', () => {
  const full = lintChainReport();
  full.vulnerabilities['lint-config'].isDirect = false;
  assert.deepEqual(rootsOf(full, 'glob-lib'), ['unrooted:lint-config']);
  assert.equal(decide({ full }).failures.length, 1);
});

test('an exception that matches nothing any more is reported for removal', () => {
  const result = decide({ full: clean });
  assert.deepEqual(result.failures, []);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /matches nothing in web-ui any more/);
});

test('malformed exceptions fail the leg', () => {
  assert.match(exceptionProblems(exception({ reason: 'dev only' })).join(), /reason/);
  assert.match(exceptionProblems(exception({ expires: '2027-06-01' })).join(), /more than 90 days/);
  assert.match(exceptionProblems(exception({ expires: '2026-09-01' })).join(), /before "reviewed"/);
  assert.match(exceptionProblems(exception({ via: [] })).join(), /via/);
  assert.match(exceptionProblems(exception({ advisory: 'CVE-2026-1' })).join(), /GHSA/);
  const result = decide({ entries: [exception({ reason: '' })] });
  assert.ok(result.failures.some((f) => /entry 1/.test(f)));
});

test('a file that is not an audit report is never read as a clean tree', () => {
  assert.throws(() => blockingAdvisories({ error: 'audit endpoint returned an error' }), /not an npm audit JSON report/);
  assert.throws(() => decide({ prod: {} }), /not an npm audit JSON report/);
});

test('moderate and low advisories do not need an exception', () => {
  const full = lintChainReport();
  full.vulnerabilities['glob-lib'].via[0].severity = 'moderate';
  assert.deepEqual(blockingAdvisories(full), []);
});

test('every exception in .github/audit-exceptions.json is well-formed', () => {
  const file = JSON.parse(fs.readFileSync(path.join(repo, '.github', 'audit-exceptions.json'), 'utf8'));
  assert.ok(Array.isArray(file.exceptions));
  for (const entry of file.exceptions) assert.deepEqual(exceptionProblems(entry), [], `${entry.advisory} ${entry.package}`);
});
