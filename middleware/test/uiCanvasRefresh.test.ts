/**
 * omadia-ui#5 — LLM-free refresh recipes (@omadia/fast-path refreshRecipes.ts,
 * recipeStore.ts): a whitelisted RefreshSource maps a tool's output onto a
 * canvas container, keyed by canvas session and container.
 *
 * deriveDataRequirements and composeStructuredPayloadPatch are tested in the
 * @omadia/ui-orchestrator plugin repo.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  applyRefreshSource,
  parseRefreshSource,
} from '../packages/harness-plugin-fast-path/src/refreshRecipes.js';
import { createRecipeStore } from '../packages/harness-plugin-fast-path/src/recipeStore.js';

describe('refresh recipes (LLM-free path)', () => {
  it('parseRefreshSource whitelists shape and drops junk', () => {
    const ok = parseRefreshSource({
      tool: 'dynamics_fetchxml',
      input: { fetchXml: '<fetch>…next-week…</fetch>' },
      map: { name: 'ud_name', amount: 'totalamount', junk: 42 },
      rowKey: 'invoiceid',
    });
    assert.ok(ok);
    assert.equal(ok.tool, 'dynamics_fetchxml');
    assert.deepEqual(ok.map, { name: 'ud_name', amount: 'totalamount' });
    assert.equal(ok.rowKey, 'invoiceid');
    assert.equal(parseRefreshSource({ tool: 'x' }), null); // no map
    assert.equal(parseRefreshSource({ map: { a: 'b' } }), null); // no tool
    assert.equal(parseRefreshSource('nope'), null);
  });

  it('applyRefreshSource maps OData-style output (first array, rowKey, null→empty)', () => {
    const source = parseRefreshSource({
      tool: 't',
      map: { name: 'ud_name', amount: 'totalamount' },
      rowKey: 'invoiceid',
    });
    assert.ok(source);
    const raw = JSON.stringify({
      '@odata.context': 'ctx',
      value: [
        { invoiceid: 'a-1', ud_name: 'GUTSCHRIFT 1', totalamount: 99.5, noise: true },
        { invoiceid: 'a-2', ud_name: null, totalamount: 12 },
      ],
    });
    assert.deepEqual(applyRefreshSource(raw, source), [
      { name: 'GUTSCHRIFT 1', amount: 99.5, rowKey: 'a-1' },
      { name: '', amount: 12, rowKey: 'a-2' },
    ]);
  });

  it('applyRefreshSource follows itemsPath and refuses wrong shapes', () => {
    const source = parseRefreshSource({ tool: 't', itemsPath: 'data.records', map: { v: 'val' } });
    assert.ok(source);
    assert.deepEqual(
      applyRefreshSource(JSON.stringify({ data: { records: [{ val: 1 }] } }), source),
      [{ v: 1 }],
    );
    // empty result set is a VALID refresh (table empties)
    assert.deepEqual(
      applyRefreshSource(JSON.stringify({ data: { records: [] } }), source),
      [],
    );
    // no mapped attribute present → wrong shape, refuse (agent fallback)
    assert.equal(
      applyRefreshSource(JSON.stringify({ data: { records: [{ other: 1 }] } }), source),
      null,
    );
    assert.equal(applyRefreshSource('not json', source), null);
    assert.equal(applyRefreshSource(JSON.stringify({ data: {} }), source), null);
  });

  it('recipe store keys by canvas session and container', () => {
    const store = createRecipeStore();
    const src = parseRefreshSource({ tool: 't', map: { a: 'b' } });
    assert.ok(src);
    store.set('sess-1', 'table-1', src);
    assert.equal(store.get('sess-1', 'table-1'), src);
    assert.equal(store.get('sess-1', 'other'), undefined);
    assert.equal(store.get('sess-2', 'table-1'), undefined);
  });
});
