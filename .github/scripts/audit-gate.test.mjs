// The audit leg's decision (audit-gate.mjs): production findings always fail;
// development-only findings pass only with a valid, unexpired exception whose
// `via` names every route package-lock.json gives into the tree.
//
// Run: node --test .github/scripts/audit-gate.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { blockingAdvisories, evaluate, exceptionProblems, lockGraph, packageNameOf, routesTo } from './audit-gate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const ADVISORY = 'GHSA-aaaa-bbbb-cccc';
const URL = `https://github.com/advisories/${ADVISORY}`;

/** A report shaped like npm's. `effects` is left empty on purpose: the gate must not need it. */
function report(nodes = ['node_modules/glob-lib']) {
  return {
    vulnerabilities: {
      'glob-lib': {
        name: 'glob-lib',
        severity: 'high',
        isDirect: false,
        via: [{ source: 1, name: 'glob-lib', title: 'nested patterns', url: URL, severity: 'high', range: '<=3.0.3' }],
        effects: [],
        nodes,
      },
    },
  };
}

/** web-ui-like: lint-config (dev) -> matcher -> glob-lib; next (prod) does not use it. */
function lock(extra = {}) {
  return {
    lockfileVersion: 3,
    packages: {
      '': { name: 'web-ui', dependencies: { next: '^16' }, devDependencies: { 'lint-config': '^16' } },
      'node_modules/next': { version: '16.0.0' },
      'node_modules/lint-config': { version: '16.0.0', dev: true, dependencies: { matcher: '^4' } },
      'node_modules/matcher': { version: '4.0.0', dev: true, dependencies: { 'glob-lib': '^3' } },
      'node_modules/glob-lib': { version: '3.0.3', dev: true },
      ...extra,
    },
  };
}

const clean = { vulnerabilities: {} };

function exception(overrides = {}) {
  return {
    advisory: ADVISORY,
    package: 'glob-lib',
    workspaces: ['web-ui'],
    via: ['lint-config'],
    reason: 'Expands the repository’s own static lint patterns only, never request input.',
    reviewed: '2026-10-04',
    expires: '2026-11-15',
    ...overrides,
  };
}

function decide({ full = report(), prod = clean, lockfile = lock(), entries = [exception()], workspace = 'web-ui', today = '2026-10-10' } = {}) {
  return evaluate({ workspace, full, prod, lock: lockfile, exceptions: { exceptions: entries }, today });
}

test('a development-only advisory with a valid exception passes and is reported', () => {
  const result = decide();
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.warnings, []);
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

test('an exception reviewed in the future fails, so the 90 days cannot be moved ahead', () => {
  const result = decide({ entries: [exception({ reviewed: '2030-01-01', expires: '2030-03-31' })] });
  assert.ok(result.failures.some((f) => /lies in the future/.test(f)));
});

test('an exception close to its expiry is announced', () => {
  const result = decide({ today: '2026-11-05' });
  assert.deepEqual(result.failures, []);
  assert.ok(result.warnings.some((w) => /expires on 2026-11-15/.test(w)));
});

test('an advisory in the production tree fails even with an exception', () => {
  const result = decide({ prod: report() });
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /production tree/);
});

test('routes come from the lockfile, not from the report’s effects links', () => {
  // The report says nothing about dependents; a production route still fails.
  const lockfile = lock({ 'node_modules/next': { version: '16.0.0', dependencies: { matcher: '^4' } } });
  const result = decide({ lockfile, entries: [exception({ via: ['lint-config', 'next'] })] });
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /next is not a devDependency/);
});

test('a route through a runtime dependency fails', () => {
  const lockfile = {
    lockfileVersion: 3,
    packages: {
      '': { name: 'desktop', devDependencies: { 'packager': '^26', electron: '^44' } },
      'node_modules/packager': { version: '26.0.0', dev: true, dependencies: { matcher: '^4' } },
      'node_modules/electron': { version: '44.0.0', dev: true, dependencies: { 'http-lib': '^1' } },
      'node_modules/http-lib': { version: '1.0.0', dev: true, dependencies: { matcher: '^4' } },
      'node_modules/matcher': { version: '4.0.0', dev: true, dependencies: { 'glob-lib': '^3' } },
      'node_modules/glob-lib': { version: '3.0.3', dev: true },
    },
  };
  const result = decide({ lockfile, workspace: 'desktop', entries: [exception({ workspaces: ['desktop'], via: ['packager'] })] });
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /passes through node_modules\/electron, which ships as a runtime/);
});

test('"via" may not name a runtime', () => {
  assert.match(exceptionProblems(exception({ workspaces: ['desktop'], via: ['electron'] })).join(), /runtime of desktop/);
});

test('a route the exception does not name fails', () => {
  const lockfile = lock({
    '': { name: 'web-ui', devDependencies: { 'lint-config': '^16', 'test-runner': '^5' } },
    'node_modules/test-runner': { version: '5.0.0', dev: true, dependencies: { matcher: '^4' } },
  });
  const result = decide({ lockfile });
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /does not name test-runner/);
});

test('a chain with no way up to the project fails closed', () => {
  // matcher <-> glob-lib form a cycle that nothing in the project depends on.
  const lockfile = {
    lockfileVersion: 3,
    packages: {
      '': { name: 'web-ui', devDependencies: {} },
      'node_modules/matcher': { version: '4.0.0', dependencies: { 'glob-lib': '^3' } },
      'node_modules/glob-lib': { version: '3.0.3', dependencies: { matcher: '^4' } },
    },
  };
  const result = decide({ lockfile });
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /no route from the project/);
  const orphan = decide({ lockfile: { lockfileVersion: 3, packages: { '': { name: 'web-ui' }, 'node_modules/glob-lib': { version: '3.0.3' } } } });
  assert.match(orphan.failures[0], /has no route from the project/);
});

test('devDependencies of a workspace count as development routes, and links resolve to the workspace', () => {
  const lockfile = {
    lockfileVersion: 3,
    packages: {
      '': { name: 'middleware', workspaces: ['packages/*'], dependencies: { '@app/core': '*' } },
      'node_modules/@app/core': { resolved: 'packages/core', link: true },
      'packages/core': { name: '@app/core', dependencies: { kit: '^1' }, devDependencies: { 'test-runner': '^5' } },
      'node_modules/kit': { version: '1.0.0' },
      'node_modules/test-runner': { version: '5.0.0', dev: true, dependencies: { matcher: '^4' } },
      'node_modules/matcher': { version: '4.0.0', dev: true, dependencies: { 'glob-lib': '^3' } },
      'node_modules/glob-lib': { version: '3.0.3', dev: true },
    },
  };
  const accepted = decide({ lockfile, workspace: 'middleware', entries: [exception({ workspaces: ['middleware'], via: ['test-runner'] })] });
  assert.deepEqual(accepted.failures, []);
  assert.match(accepted.notices[0], /via packages\/core:test-runner/);
  // The same package reached through the workspace's runtime dependency is production.
  lockfile.packages['node_modules/kit'].dependencies = { matcher: '^4' };
  const rejected = decide({ lockfile, workspace: 'middleware', entries: [exception({ workspaces: ['middleware'], via: ['test-runner', 'kit'] })] });
  assert.match(rejected.failures[0], /packages\/core:kit is not a devDependency/);
});

test('nested copies resolve to the closest node_modules', () => {
  const lockfile = lock({
    'node_modules/lint-config': { version: '16.0.0', dev: true, dependencies: { matcher: '^5' } },
    'node_modules/lint-config/node_modules/matcher': { version: '5.0.0', dev: true, dependencies: { 'glob-lib': '^3' } },
  });
  const graph = lockGraph(lockfile);
  const { roots } = routesTo(graph, ['node_modules/glob-lib']);
  // The hoisted matcher@4 has no dependent any more; the nested matcher@5 leads to lint-config.
  assert.deepEqual(roots.map((r) => r.name), ['lint-config']);
  assert.equal(packageNameOf('node_modules/a/node_modules/@scope/b'), '@scope/b');
  assert.equal(packageNameOf('packages/core'), null);
});

test('an exception that matches nothing any more is reported for removal', () => {
  const result = decide({ full: clean });
  assert.deepEqual(result.failures, []);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /matches nothing in web-ui any more/);
});

test('"via" names that are no route any more are reported', () => {
  const result = decide({ entries: [exception({ via: ['lint-config', 'old-tool'] })] });
  assert.deepEqual(result.failures, []);
  assert.ok(result.warnings.some((w) => /names old-tool in "via", which is no route any more/.test(w)));
});

test('malformed exceptions fail the leg', () => {
  assert.match(exceptionProblems(exception({ reason: 'dev only' })).join(), /reason/);
  assert.match(exceptionProblems(exception({ expires: '2027-06-01' })).join(), /more than 90 days/);
  assert.match(exceptionProblems(exception({ expires: '2026-09-01' })).join(), /before "reviewed"/);
  assert.match(exceptionProblems(exception({ expires: '2026-02-31' })).join(), /valid YYYY-MM-DD/);
  assert.match(exceptionProblems(exception({ via: [] })).join(), /via/);
  assert.match(exceptionProblems(exception({ advisory: 'CVE-2026-1' })).join(), /GHSA/);
  const result = decide({ entries: [exception({ reason: '' })] });
  assert.ok(result.failures.some((f) => /entry 1/.test(f)));
  const noList = evaluate({ workspace: 'web-ui', full: clean, prod: clean, lock: lock(), exceptions: {}, today: '2026-10-10' });
  assert.ok(noList.failures.some((f) => /no "exceptions" array/.test(f)));
});

test('a file that is not an audit report or a lockfile is never read as a clean tree', () => {
  assert.throws(() => blockingAdvisories({ error: 'audit endpoint returned an error' }), /not an npm audit JSON report/);
  assert.throws(() => decide({ prod: {} }), /not an npm audit JSON report/);
  assert.throws(() => decide({ lockfile: { name: 'x' } }), /not an npm lockfile/);
});

test('moderate and low advisories do not need an exception', () => {
  const full = report();
  full.vulnerabilities['glob-lib'].via[0].severity = 'moderate';
  assert.deepEqual(blockingAdvisories(full), []);
});

test('the command decides through a symlinked path as well', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-gate-'));
  try {
    const write = (name, value) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, JSON.stringify(value));
      return file;
    };
    const link = path.join(dir, 'gate-link.mjs');
    fs.symlinkSync(path.join(here, 'audit-gate.mjs'), link);
    const args = [
      link, '--workspace', 'web-ui', '--full', write('full.json', report()), '--prod', write('prod.json', clean),
      '--lock', write('lock.json', lock()), '--exceptions', write('exceptions.json', { exceptions: [] }), '--today', '2026-10-10',
    ];
    const run = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stdout, /::error::high GHSA-aaaa-bbbb-cccc in glob-lib/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('every exception in .github/audit-exceptions.json is well-formed', () => {
  const file = JSON.parse(fs.readFileSync(path.join(repo, '.github', 'audit-exceptions.json'), 'utf8'));
  assert.ok(Array.isArray(file.exceptions));
  for (const entry of file.exceptions) assert.deepEqual(exceptionProblems(entry), [], `${entry.advisory} ${entry.package}`);
});
