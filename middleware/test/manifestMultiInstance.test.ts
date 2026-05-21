/**
 * US1 — verifies the manifest multi-instance extension: `adaptManifestV1`
 * maps `multi_instance` / `multi_instance_justification` / `privacy_class`
 * onto the loaded `Plugin`, defaults them permissively, and falls back on
 * an invalid `privacy_class`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { adaptManifestV1 } from '../src/plugins/manifestLoader.js';

function manifest(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: '1',
    identity: {
      id: 'de.byte5.agent.test',
      kind: 'agent',
      domain: 'test',
      name: 'Test Plugin',
      version: '1.0.0',
    },
    ...extra,
  };
}

test('defaults multi_instance to true and privacy_class to default when omitted', () => {
  const plugin = adaptManifestV1(manifest());
  assert.ok(plugin);
  assert.equal(plugin.multi_instance, true);
  assert.equal(plugin.privacy_class, 'default');
  assert.equal(plugin.multi_instance_justification, undefined);
});

test('maps an explicit multi_instance:false with a justification', () => {
  const plugin = adaptManifestV1(
    manifest({
      multi_instance: false,
      multi_instance_justification: 'holds an exclusive hardware lock',
    }),
  );
  assert.ok(plugin);
  assert.equal(plugin.multi_instance, false);
  assert.equal(
    plugin.multi_instance_justification,
    'holds an exclusive hardware lock',
  );
});

test('maps an explicit privacy_class', () => {
  const plugin = adaptManifestV1(manifest({ privacy_class: 'strict' }));
  assert.ok(plugin);
  assert.equal(plugin.privacy_class, 'strict');
});

test('falls back to default on an unknown privacy_class', () => {
  const plugin = adaptManifestV1(manifest({ privacy_class: 'open' }));
  assert.ok(plugin);
  assert.equal(plugin.privacy_class, 'default');
});

test('keeps multi_instance:false even when justification is missing', () => {
  const plugin = adaptManifestV1(manifest({ multi_instance: false }));
  assert.ok(plugin);
  assert.equal(plugin.multi_instance, false);
  assert.equal(plugin.multi_instance_justification, undefined);
});
