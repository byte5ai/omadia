/**
 * ADR-0255 — `KERNEL_SQL_RELATIONS` is kept by hand. This scans every kernel
 * migration series and every kernel store for the relations they create, and
 * fails on one the list does not hold, so a new kernel table cannot slip past
 * the borrowed pool's guard.
 */
import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { KERNEL_SQL_RELATIONS, PLUGIN_OWNED_KERNEL_RELATIONS } from '../src/platform/kernelSqlRelations.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CREATE =
  /create\s+(?:or\s+replace\s+)?(?:unlogged\s+)?(?:materialized\s+view|table|view|function)\s+(?:if\s+not\s+exists\s+)?"?(?:public\.)?([a-z_][a-z0-9_]*)/gi;

function files(dir: string, keep: (path: string) => boolean): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules' || name === 'dist') return [];
    return statSync(path).isDirectory() ? files(path, keep) : keep(path) ? [path] : [];
  });
}

function created(): Map<string, string> {
  const sources = [
    ...files(join(ROOT, 'migrations'), (p) => p.endsWith('.sql')),
    ...files(join(ROOT, 'src'), (p) => /\.(sql|ts)$/.test(p)),
    ...files(join(ROOT, 'packages'), (p) => /\/src\/.*\.(sql|ts)$/.test(p) && !p.includes('/test/')),
  ];
  const names = new Map<string, string>();
  for (const path of sources) {
    // Plugin-owned ledgers and schemas live under `plg_`, built at runtime.
    for (const m of readFileSync(path, 'utf8').matchAll(CREATE)) {
      const name = m[1]!.toLowerCase();
      if (['if', 'is', 'plus', 'x'].includes(name)) continue;
      if (!names.has(name)) names.set(name, path.slice(ROOT.length));
    }
  }
  return names;
}

describe('ADR-0255 · KERNEL_SQL_RELATIONS', () => {
  it('lists every relation a kernel migration or store creates', () => {
    const missing = [...created()].filter(([name]) => !KERNEL_SQL_RELATIONS.has(name));
    assert.deepEqual(missing, [], 'add these to src/platform/kernelSqlRelations.ts');
  });

  it('only hands a plugin kernel tables the list holds', () => {
    for (const [plugin, tables] of Object.entries(PLUGIN_OWNED_KERNEL_RELATIONS)) {
      for (const table of tables) assert.ok(KERNEL_SQL_RELATIONS.has(table), `${plugin}: ${table}`);
    }
  });

  it('holds the graph and memory tables the guard exists for', () => {
    for (const table of ['graph_nodes', 'graph_edges', 'memory_files', 'processes', 'turn_receipts', 'users', 'agents']) {
      assert.ok(KERNEL_SQL_RELATIONS.has(table), table);
    }
  });
});
