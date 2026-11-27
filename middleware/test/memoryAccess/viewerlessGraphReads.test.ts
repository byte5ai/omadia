/**
 * Memory-ACL plan, step 4b — the lint rule against viewer-less graph reads
 * (`eslint/viewerlessGraphReads.mjs`) bites, and its allowlist stays honest.
 *
 * `npm run lint` enforces the rule; this file proves the wiring: a new file
 * that reads the graph without a viewer is an error, a read with the viewer
 * is not, and every allowlisted file still makes such a read (an entry that
 * no longer needs its exemption would hide the next one).
 */
import { strict as assert } from 'node:assert';
import path from 'node:path';
import { describe, it } from 'node:test';

import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';

import {
  VIEWERLESS_GRAPH_READ_ALLOWLIST,
  VIEWERLESS_GRAPH_READ_SELECTORS,
} from '../../eslint/viewerlessGraphReads.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const RULE = 'no-restricted-syntax';

const ruleHits = (results: ESLint.LintResult[]): string[] =>
  results.flatMap((r) =>
    r.messages
      .filter((m) => m.ruleId === RULE)
      .map((m) => `${path.relative(ROOT, r.filePath)}:${String(m.line)}`),
  );

describe('viewer-less graph reads lint rule (memory-ACL plan step 4b)', () => {
  it('flags a viewer-less read in a new file and passes the same read with a viewer', async () => {
    const eslint = new ESLint({ cwd: ROOT });
    const code = [
      'export async function leak(graph: any, scope: string, id: string, viewer: string) {',
      '  await graph.listSessions();', // 2
      '  await graph.getSession(scope);', // 3
      '  await graph.getMemorableKnowledge(id);', // 4
      '  await graph.getNeighbors(id);', // 5
      '  await graph.getSession(scope, { userId: viewer });',
      '  await graph.getMemorableKnowledge(id, viewer);',
      '}',
    ].join('\n');
    const results = await eslint.lintText(code, { filePath: path.join(ROOT, 'src/routes/newRoute.ts') });
    assert.deepEqual(
      ruleHits(results).map((h) => Number(h.split(':').pop())),
      [2, 3, 4, 5],
    );
  });

  it('every allowlisted file still makes a viewer-less read', async () => {
    const files = Object.keys(VIEWERLESS_GRAPH_READ_ALLOWLIST);
    // The rule alone, without the allowlist.
    const eslint = new ESLint({
      cwd: ROOT,
      overrideConfigFile: true,
      overrideConfig: [
        {
          files: ['**/*.ts'],
          languageOptions: { parser: tseslint.parser },
          rules: { [RULE]: ['error', ...VIEWERLESS_GRAPH_READ_SELECTORS] },
        },
      ],
    });
    const hits = ruleHits(await eslint.lintFiles(files.map((f) => path.join(ROOT, f))));
    const stale = files.filter((f) => !hits.some((h) => h.startsWith(`${f}:`)));
    assert.deepEqual(stale, [], 'no viewer-less read left: remove these from the allowlist');
  });
});
