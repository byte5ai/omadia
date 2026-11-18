import { strict as assert } from 'node:assert';
import { describe, it, type TestContext } from 'node:test';

import type { EntityIngest, KnowledgeGraph } from '@omadia/plugin-api';

/**
 * Backend-agnostic contract for the exact-id lookup `findEntities({ id })`
 * (plugin-api 1.21.0). The verifier resolves an entity handle such as
 * `hr.employee:7` through it, so every backend must treat `id` as an
 * identity, never as a search:
 *
 *  - exactly the record whose `props.id` equals the id, compared as strings
 *    after trimming, so `7`, `'7'` and `' 7 '` all address it;
 *  - an id that is not in the graph, an id of another model, or an empty
 *    id returns `[]` — never a neighbouring record;
 *  - `id` narrows `nameContains` (both must hold), it never widens it;
 *  - only Odoo/Confluence entity nodes are covered, like the rest of
 *    `findEntities`; plugin-namespaced entities are out of reach.
 *
 * `nameContains` stays what it always was: a substring search over
 * displayName and id. The fixture makes the difference visible — the
 * partners 7, 17 and 70 all contain "7".
 *
 * Shared by the in-memory suite and the Neon suite (same pattern as
 * memoryStoreConformance.ts). `getGraph` returns a graph that already holds
 * {@link FIND_BY_ID_ENTITIES}, or `undefined` when the backend is not
 * available — each case then skips itself, because this file's callers also
 * run under the plain `test/**\/*.test.ts` glob where no database exists.
 */

export const FIND_BY_ID_ENTITIES: readonly EntityIngest[] = [
  { system: 'odoo', model: 'res.partner', id: 7, displayName: 'Partner Seven' },
  { system: 'odoo', model: 'res.partner', id: 17, displayName: 'Team 7' },
  { system: 'odoo', model: 'res.partner', id: 70, displayName: 'Partner Seventy' },
  { system: 'odoo', model: 'hr.employee', id: 7, displayName: 'Employee Seven' },
  { system: 'confluence', model: 'page', id: '123456', displayName: 'Runbook Page' },
  { system: 'crm', model: 'Contact', id: 7, displayName: 'Plugin Contact Seven' },
];

async function ids(
  kg: KnowledgeGraph,
  opts: Parameters<KnowledgeGraph['findEntities']>[0],
): Promise<string[]> {
  const nodes = await kg.findEntities(opts);
  return nodes.map((n) => n.id).sort();
}

export function runFindEntitiesByIdContract(
  label: string,
  getGraph: () => Promise<KnowledgeGraph | undefined>,
): void {
  describe(`findEntities({ id }) — exact entity lookup · ${label}`, () => {
    async function withGraph(
      t: TestContext,
      fn: (kg: KnowledgeGraph) => Promise<void>,
    ): Promise<void> {
      const kg = await getGraph();
      if (!kg) {
        t.skip('backend not available');
        return;
      }
      await fn(kg);
    }

    it('resolves exactly the requested record, whether the id is a number or a string', (t) =>
      withGraph(t, async (kg) => {
        const partner7 = ['odoo:res.partner:7'];
        assert.deepEqual(await ids(kg, { model: 'res.partner', id: 7 }), partner7);
        assert.deepEqual(await ids(kg, { model: 'res.partner', id: '7' }), partner7);
        assert.deepEqual(await ids(kg, { model: 'res.partner', id: ' 7 ' }), partner7);
        assert.deepEqual(
          await ids(kg, { model: 'hr.employee', id: 7 }),
          ['odoo:hr.employee:7'],
        );
        // Confluence page ids are stored as strings; a numeric query still
        // addresses them because both sides are compared as strings.
        assert.deepEqual(
          await ids(kg, { model: 'page', id: 123456 }),
          ['confluence:page:123456'],
        );
        assert.deepEqual(
          await ids(kg, { model: 'page', id: '123456' }),
          ['confluence:page:123456'],
        );
      }));

    it('keeps nameContains a substring search, which is why a handle never goes through it', (t) =>
      withGraph(t, async (kg) => {
        assert.deepEqual(await ids(kg, { model: 'res.partner', nameContains: '7' }), [
          'odoo:res.partner:17',
          'odoo:res.partner:7',
          'odoo:res.partner:70',
        ]);
      }));

    it('returns nothing for an id not in the graph, an id of another model, or an empty id', (t) =>
      withGraph(t, async (kg) => {
        assert.deepEqual(await ids(kg, { model: 'res.partner', id: 999 }), []);
        assert.deepEqual(await ids(kg, { model: 'hr.department', id: 7 }), []);
        assert.deepEqual(await ids(kg, { model: 'res.partner', id: '' }), []);
        assert.deepEqual(await ids(kg, { model: 'res.partner', id: '   ' }), []);
      }));

    it('narrows nameContains and never widens it', (t) =>
      withGraph(t, async (kg) => {
        assert.deepEqual(
          await ids(kg, { model: 'res.partner', id: 17, nameContains: 'team' }),
          ['odoo:res.partner:17'],
        );
        assert.deepEqual(
          await ids(kg, { model: 'res.partner', id: 7, nameContains: 'team' }),
          [],
        );
      }));

    it('does not reach plugin-namespaced entities', (t) =>
      withGraph(t, async (kg) => {
        assert.deepEqual(await ids(kg, { model: 'Contact', id: 7 }), []);
      }));
  });
}
