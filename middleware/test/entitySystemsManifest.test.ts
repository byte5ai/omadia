import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { extractPermissions } from '../src/plugins/manifestLoader.js';
import { isKernelReservedSystem } from '../src/platform/kernelNodeNamespaces.js';

/**
 * ADR-0167 — `odoo` and `confluence` are no longer host-reserved: the plugin
 * that writes them declares them in `permissions.graph.entity_systems`. Only
 * the kernel's own node namespaces (and any value with a colon) are dropped.
 */
describe('manifest loader: graph.entity_systems (ADR-0167)', () => {
  const systemsOf = (entity_systems: unknown): readonly string[] =>
    extractPermissions({ graph: { entity_systems } }, '@test/p').graph_entity_systems ?? [];

  it('keeps odoo and confluence as declared', () => {
    assert.deepEqual(systemsOf(['odoo']), ['odoo']);
    assert.deepEqual(systemsOf(['confluence', 'notes']), ['confluence', 'notes']);
  });

  it('drops kernel node namespaces and values with a colon', () => {
    assert.deepEqual(systemsOf(['turn', 'session', 'teams', 'fact', 'turn:x', 'notes']), ['notes']);
  });

  it('reserves exactly the kernel namespaces', () => {
    for (const system of ['turn', 'session', 'user', 'plan', 'process', 'dataset', 'web', 'a:b']) {
      assert.equal(isKernelReservedSystem(system), true, system);
    }
    for (const system of ['odoo', 'confluence', 'notes']) {
      assert.equal(isKernelReservedSystem(system), false, system);
    }
  });
});
