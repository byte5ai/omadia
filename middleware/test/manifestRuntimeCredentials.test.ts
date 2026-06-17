/**
 * Spec 004 Phase A/B — verifies `adaptManifestV1` maps the runtime-credential
 * permission gates (`permissions.secrets.runtime_write`, `permissions.flows`)
 * onto `permissions_summary`, defaulting both to `false` when absent.
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

test('defaults secrets_runtime_write and flows to false when permissions omit them', () => {
  const plugin = adaptManifestV1(manifest());
  assert.ok(plugin);
  assert.equal(plugin.permissions_summary.secrets_runtime_write, false);
  assert.equal(plugin.permissions_summary.flows, false);
});

test('maps permissions.secrets.runtime_write: true', () => {
  const plugin = adaptManifestV1(
    manifest({ permissions: { secrets: { runtime_write: true } } }),
  );
  assert.ok(plugin);
  assert.equal(plugin.permissions_summary.secrets_runtime_write, true);
});

test('maps permissions.flows: true', () => {
  const plugin = adaptManifestV1(manifest({ permissions: { flows: true } }));
  assert.ok(plugin);
  assert.equal(plugin.permissions_summary.flows, true);
});

test('treats non-boolean runtime_write / flows as false', () => {
  const plugin = adaptManifestV1(
    manifest({
      permissions: { secrets: { runtime_write: 'yes' }, flows: 1 },
    }),
  );
  assert.ok(plugin);
  assert.equal(plugin.permissions_summary.secrets_runtime_write, false);
  assert.equal(plugin.permissions_summary.flows, false);
});
