// The dependency audit only covers the directories its matrix names. desktop/
// has its own lockfile and ships the Electron runtime, yet it had no audit leg
// until its dependency refresh, so the matrix is checked against the lockfiles
// git tracks instead of against someone's memory.
//
// Run: node --test .github/scripts/
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Directories git tracks with both a package.json and a package-lock.json.
 * The root lockfile has no package.json beside it (an empty stub), so it is
 * not a package directory and needs no leg.
 */
function lockfileDirs() {
  const tracked = new Set(
    execFileSync('git', ['ls-files', '-z'], { cwd: repo, encoding: 'utf8' })
      .split('\0')
      .filter(Boolean),
  );
  return [...tracked]
    .filter((file) => path.posix.basename(file) === 'package-lock.json')
    .map((file) => path.posix.dirname(file))
    .filter((dir) => tracked.has(dir === '.' ? 'package.json' : `${dir}/package.json`))
    .sort();
}

/**
 * The `workspace` values of the `audit` job's matrix. A deliberately small
 * reader (no YAML dependency is installed when this runs): it accepts the
 * inline form `workspace: [a, b]` and the block form `- a` lines, and throws
 * when it cannot find the key, so a reformatted workflow fails loudly
 * instead of passing with an empty list.
 */
export function auditMatrixWorkspaces(workflowText) {
  const lines = workflowText.split('\n');
  const start = lines.findIndex((line) => /^ {2}audit:\s*$/.test(line));
  if (start === -1) throw new Error('ci.yml has no `audit:` job');
  const unquote = (value) => value.trim().replace(/^['"]|['"]$/g, '');
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^ {2}\S/.test(line)) break; // next job
    const match = /^\s+workspace:\s*(.*)$/.exec(line);
    if (!match) continue;
    const inline = match[1].replace(/\s+#.*$/, '').trim();
    if (inline.startsWith('[')) {
      return inline
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map(unquote)
        .filter(Boolean);
    }
    const items = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const item = /^\s+-\s+(\S+)/.exec(lines[j]);
      if (!item) break;
      items.push(unquote(item[1]));
    }
    return items;
  }
  throw new Error('the `audit` job has no `workspace` matrix');
}

test('every tracked lockfile directory is a leg of the audit matrix', () => {
  const workflow = fs.readFileSync(path.join(repo, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.deepEqual(
    [...auditMatrixWorkspaces(workflow)].sort(),
    lockfileDirs(),
    'the audit matrix in .github/workflows/ci.yml must list exactly the directories ' +
      'that carry their own package.json + package-lock.json; a new one also needs ' +
      'a .github/dependabot.yml block and a required status check',
  );
});

test('reads the inline matrix form', () => {
  const text = [
    'jobs:',
    '  audit:',
    '    strategy:',
    '      matrix:',
    "        workspace: [middleware, 'web-ui', desktop] # comment",
    '  other:',
    '    steps: []',
  ].join('\n');
  assert.deepEqual(auditMatrixWorkspaces(text), ['middleware', 'web-ui', 'desktop']);
});

test('reads the block matrix form', () => {
  const text = [
    'jobs:',
    '  audit:',
    '    strategy:',
    '      matrix:',
    '        workspace:',
    '          - middleware',
    '          - "desktop"',
    '    steps: []',
  ].join('\n');
  assert.deepEqual(auditMatrixWorkspaces(text), ['middleware', 'desktop']);
});

test('does not read a workspace key that belongs to another job', () => {
  const text = [
    'jobs:',
    '  audit:',
    '    runs-on: ubuntu-latest',
    '  build:',
    '    strategy:',
    '      matrix:',
    '        workspace: [middleware]',
  ].join('\n');
  assert.throws(() => auditMatrixWorkspaces(text), /no `workspace` matrix/);
});
