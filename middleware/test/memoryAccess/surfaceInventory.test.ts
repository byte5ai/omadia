/**
 * Memory-ACL plan, step 4a — every route, native tool and PluginContext
 * method is classified (`surfaceClassification.ts`). A new surface fails
 * here until someone decides, by hand, whether it reads memory and for whom.
 */
import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { ACCESSORS, ROUTES, TOOLS, type Classification } from './surfaceClassification.js';
import { MIDDLEWARE_ROOT, pluginContextAccessors, routesAndTools } from './surfaceInventory.js';

const found = { ...routesAndTools(), accessors: pluginContextAccessors() };

const tables: ReadonlyArray<[keyof typeof found, Readonly<Record<string, Classification>>]> = [
  ['routes', ROUTES],
  ['tools', TOOLS],
  ['accessors', ACCESSORS],
];

describe('memory surface inventory (memory-ACL plan step 4a)', () => {
  for (const [kind, table] of tables) {
    it(`every ${kind} entry in the source is classified`, () => {
      // Positive control: an extractor that finds nothing would pass.
      assert.ok(found[kind].length >= 30, `only ${String(found[kind].length)} ${kind} found`);
      const missing = found[kind].filter((k) => !(k in table));
      assert.deepEqual(
        missing,
        [],
        `unclassified ${kind}: add each to test/memoryAccess/surfaceClassification.ts with its kind and reason`,
      );
    });

    it(`every classified ${kind} entry still exists`, () => {
      const stale = Object.keys(table).filter((k) => !found[kind].includes(k));
      assert.deepEqual(stale, [], `remove these from surfaceClassification.ts (or fix their key)`);
    });

    it(`every viewer-scoped ${kind} entry names a test that exists`, () => {
      const problems: string[] = [];
      for (const [key, c] of Object.entries(table)) {
        if (c.kind !== 'viewer-scoped') {
          if (c.covered) problems.push(`${key}: only viewer-scoped entries name a test`);
          continue;
        }
        if (!c.covered) {
          problems.push(`${key}: viewer-scoped without a test`);
          continue;
        }
        const file = path.join(MIDDLEWARE_ROOT, c.covered.test);
        if (!existsSync(file)) {
          problems.push(`${key}: ${c.covered.test} does not exist`);
        } else if (c.covered.entry && !readFileSync(file, 'utf8').includes(`'${c.covered.entry}'`)) {
          problems.push(`${key}: ${c.covered.test} never uses '${c.covered.entry}'`);
        }
      }
      assert.deepEqual(problems, []);
    });
  }
});
