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
  // #602 (OM-17) — a bare-string label is read as English on BOTH paths.
  { key: 'base_url', type: 'url', label: 'Base URL' },
  {
    key: 'api_key',
    type: 'secret',
    // #602 (OM-17) — a localized label/help map must survive identically on
    // both projections, or a German operator and the install wizard disagree.
    label: { en: 'API key', de: 'API-Schlüssel' },
    help: { en: 'From the provider console', de: 'Aus der Anbieter-Konsole' },
    required: true,
  },
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

// #602 (OM-17) — label/help are localized maps.
test('a bare-string label is read as English (`{ en }`)', () => {
  assert.deepEqual(loadedFields().get('base_url')?.label, { en: 'Base URL' });
});

test('a localized label/help map is preserved verbatim', () => {
  const f = loadedFields().get('api_key');
  assert.deepEqual(f?.label, { en: 'API key', de: 'API-Schlüssel' });
  assert.deepEqual(f?.help, {
    en: 'From the provider console',
    de: 'Aus der Anbieter-Konsole',
  });
});

test('a label-less field falls back to `{ en: <key> }` on the store view', () => {
  const plugin = adaptManifestV1({
    schema_version: '1',
    identity: {
      id: 'de.byte5.integration.test',
      kind: 'integration',
      domain: 'test',
      name: 'Test Plugin',
      version: '1.0.0',
    },
    setup: { fields: [{ key: 'lonely', type: 'string' }] },
  })!;
  assert.deepEqual(plugin.setup_fields[0]?.label, { en: 'lonely' });
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
    // #602 (OM-17) — the localized label/help maps must be identical on both
    // projections, or the store card and the install wizard say different
    // things (or different languages) about the same field.
    assert.deepEqual(
      storeField.label,
      installField.label,
      `label drift on '${installField.key}'`,
    );
    assert.deepEqual(
      storeField.help,
      installField.help,
      `help drift on '${installField.key}'`,
    );
  }
});
