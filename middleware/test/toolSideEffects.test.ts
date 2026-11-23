/**
 * Spec 2042 §5.10/§5.11 — a plugin tool declares its effect in the
 * manifest (`capabilities[].side_effects: read | write | none`); a tool
 * without a declaration is `unknown`, never `read`.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { adaptManifestV1 } from '../src/plugins/manifestLoader.js';
import { declaredToolEffect } from '../src/plugins/toolSideEffects.js';

function pluginWith(capabilities: unknown) {
  const original = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(' '));
  try {
    const plugin = adaptManifestV1(
      {
        schema_version: '1',
        identity: { id: '@acme/crm', name: 'CRM', version: '1.0.0', kind: 'integration' },
        capabilities,
      },
      () => undefined,
    );
    assert.ok(plugin);
    return { plugin, warnings };
  } finally {
    console.warn = original;
  }
}

describe('declared tool effects', () => {
  it('reads side_effects per tool id', () => {
    const { plugin } = pluginWith([
      { id: 'crm_search', side_effects: 'read' },
      { id: 'crm_create_note', side_effects: 'write' },
      { id: 'crm_format', side_effects: 'none' },
      { id: 'crm_legacy' },
    ]);
    assert.equal(declaredToolEffect(plugin, 'crm_search'), 'read');
    assert.equal(declaredToolEffect(plugin, 'crm_create_note'), 'write');
    assert.equal(declaredToolEffect(plugin, 'crm_format'), 'none');
    assert.equal(declaredToolEffect(plugin, 'crm_legacy'), 'unknown');
    assert.equal(declaredToolEffect(plugin, 'not_declared'), 'unknown');
    assert.equal(declaredToolEffect(undefined, 'crm_search'), 'unknown');
  });

  it('drops a value outside the vocabulary with a warning: unknown, not read', () => {
    const { plugin, warnings } = pluginWith([{ id: 'crm_sync', side_effects: 'maybe' }]);
    assert.equal(declaredToolEffect(plugin, 'crm_sync'), 'unknown');
    assert.match(warnings.join('\n'), /crm_sync.*side_effects "maybe"/);
  });

  it('is not fooled by prototype names', () => {
    const { plugin } = pluginWith([{ id: '__proto__', side_effects: 'write' }]);
    assert.equal(declaredToolEffect(plugin, 'constructor'), 'unknown');
    assert.equal(declaredToolEffect(plugin, '__proto__'), 'write');
  });

  it('leaves a plugin without declarations without the field', () => {
    const { plugin } = pluginWith(undefined);
    assert.equal(plugin.tool_side_effects, undefined);
  });
});
