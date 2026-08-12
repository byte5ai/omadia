/**
 * OM-16 prerequisite — `PluginSetupField.required` / `.pattern`.
 *
 * Two independent code paths project the SAME manifest `setup.fields` block:
 *
 *   • `manifestLoader.adaptManifestV1`  → `Plugin.setup_fields`  (store view)
 *   • `installService.extractSetupSchema` → `InstallSetupSchema` (install job)
 *
 * They must agree on required-ness, otherwise the store's "configuration
 * required" badge and the install wizard's validation drift apart silently.
 * The last test here asserts that agreement against ONE shared fixture — it is
 * the only thing standing between the two `f['required'] !== false` copies.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { adaptManifestV1 } from '../src/plugins/manifestLoader.js';
import { extractSetupSchema } from '../src/plugins/installService.js';
import type { PluginCatalogEntry } from '../src/plugins/manifestLoader.js';

/** The one fixture both paths are measured against. */
const SETUP_FIELDS: Array<Record<string, unknown>> = [
  { key: 'base_url', type: 'url', label: 'Base URL' },
  { key: 'api_key', type: 'secret', label: 'API key', required: true },
  { key: 'note', type: 'string', label: 'Note', required: false },
  {
    key: 'tenant',
    type: 'string',
    label: 'Tenant',
    pattern: '^[a-z0-9-]+$',
  },
  // `required` given as a non-boolean: both paths use `!== false`, so this is
  // required. Pinning it stops one side from "helpfully" adding coercion.
  { key: 'weird', type: 'string', label: 'Weird', required: 'no' },
];

function manifest(): Record<string, unknown> {
  return {
    schema_version: '1',
    identity: {
      id: 'de.byte5.integration.test',
      kind: 'integration',
      domain: 'test',
      name: 'Test Plugin',
      version: '1.0.0',
    },
    setup: { fields: SETUP_FIELDS },
  };
}

function loadedFields() {
  const plugin = adaptManifestV1(manifest());
  assert.ok(plugin, 'manifest must load');
  return new Map(plugin.setup_fields.map((f) => [f.key, f]));
}

test('required:false is parsed onto Plugin.setup_fields', () => {
  assert.equal(loadedFields().get('note')?.required, false);
});

test('an omitted `required` defaults to true (required-by-default)', () => {
  assert.equal(loadedFields().get('base_url')?.required, true);
  assert.equal(loadedFields().get('tenant')?.required, true);
});

test('an explicit required:true is preserved', () => {
  assert.equal(loadedFields().get('api_key')?.required, true);
});

test('`pattern` is passed through unchanged, and absent when not declared', () => {
  assert.equal(loadedFields().get('tenant')?.pattern, '^[a-z0-9-]+$');
  assert.equal(loadedFields().get('base_url')?.pattern, undefined);
});

test('store and install-wizard paths agree on required for the SAME fixture', () => {
  const store = loadedFields();
  const entry = {
    plugin: adaptManifestV1(manifest())!,
    manifest: manifest(),
  } as unknown as PluginCatalogEntry;
  const schema = extractSetupSchema(entry);
  assert.ok(schema);

  // The install path additionally injects the kernel's synthetic
  // `_privacy_*` fields (installService.ts, Slice 2.5); those are not part of
  // the manifest contract and never reach the store view — which is exactly
  // why `computeReadiness` skips the same prefix.
  const declared = schema.fields.filter((f) => !f.key.startsWith('_'));
  assert.ok(declared.length > 0, 'install schema must not be empty');
  for (const installField of declared) {
    const storeField = store.get(installField.key);
    assert.ok(storeField, `store view is missing field '${installField.key}'`);
    assert.equal(
      storeField.required,
      installField.required,
      `required drift on '${installField.key}': store=${String(
        storeField.required,
      )} install=${String(installField.required)}`,
    );
    assert.equal(
      storeField.pattern,
      installField.pattern,
      `pattern drift on '${installField.key}'`,
    );
  }
});
