import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';

import { loadManifestFromPath } from '../src/plugins/manifestLoader.js';

/**
 * Regression guard for the .env-admin cleanup: the orchestrator model-routing
 * knobs used to be editable ONLY via the admin `/settings` catalog. They now
 * live in the orchestrator's own manifest `setup.fields`, so they show up in
 * the per-plugin settings editor like every other orchestrator setting. These
 * keys must stay in the manifest and keep their bootstrap config-key names.
 */

const MANIFEST = fileURLToPath(
  new URL(
    '../packages/harness-orchestrator/manifest.yaml',
    import.meta.url,
  ),
);

const ROUTING_FIELDS: ReadonlyArray<{ key: string; type: string }> = [
  { key: 'orchestrator_model_routing', type: 'boolean' },
  { key: 'model_routing_classifier_model', type: 'string' },
  { key: 'model_routing_simple_model', type: 'string' },
  { key: 'model_routing_complex_model', type: 'string' },
];

describe('orchestrator manifest — model-routing setup fields', () => {
  it('exposes all four routing knobs with the right types', async () => {
    const entry = await loadManifestFromPath(MANIFEST);
    assert.ok(entry, 'orchestrator manifest.yaml failed to load');
    const fields = entry.plugin.setup_fields ?? [];
    for (const expected of ROUTING_FIELDS) {
      const field = fields.find((f) => f.key === expected.key);
      assert.ok(field, `missing routing setup field: ${expected.key}`);
      assert.equal(
        field.type,
        expected.type,
        `${expected.key} should be type ${expected.type}`,
      );
    }
  });
});
