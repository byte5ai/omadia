/**
 * Service-type auto-discovery — verifies `adaptManifestV1` parses an
 * integration manifest's `service_types:` block onto the loaded `Plugin`,
 * defaults to absent when omitted, and graceful-degrades (warn + skip) on
 * malformed entries instead of breaking catalog-load.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { adaptManifestV1 } from '../src/plugins/manifestLoader.js';

function manifest(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: '1',
    identity: {
      id: '@omadia/integration-odoo',
      kind: 'integration',
      domain: 'odoo',
      name: 'Odoo Integration',
      version: '1.0.0',
    },
    ...extra,
  };
}

test('service_types is absent when the manifest omits the block', () => {
  const plugin = adaptManifestV1(manifest());
  assert.ok(plugin);
  assert.equal(plugin.service_types, undefined);
});

test('parses a well-formed service_types block', () => {
  const plugin = adaptManifestV1(
    manifest({
      service_types: [
        { service: 'odoo.client', type: { from: '@omadia/integration-odoo', name: 'OdooClient' } },
        { service: 'odoo.cache', type: { from: '@omadia/integration-odoo', name: 'OdooResponseCache' } },
      ],
    }),
  );
  assert.ok(plugin);
  assert.deepEqual(plugin.service_types, [
    { service: 'odoo.client', type: { from: '@omadia/integration-odoo', name: 'OdooClient' } },
    { service: 'odoo.cache', type: { from: '@omadia/integration-odoo', name: 'OdooResponseCache' } },
  ]);
});

test('trims surrounding whitespace on service / from / name', () => {
  const plugin = adaptManifestV1(
    manifest({
      service_types: [
        { service: '  odoo.client  ', type: { from: ' @omadia/integration-odoo ', name: ' OdooClient ' } },
      ],
    }),
  );
  assert.ok(plugin);
  assert.deepEqual(plugin.service_types, [
    { service: 'odoo.client', type: { from: '@omadia/integration-odoo', name: 'OdooClient' } },
  ]);
});

test('drops malformed entries (missing service / type.from / type.name) but keeps the valid ones', () => {
  const plugin = adaptManifestV1(
    manifest({
      service_types: [
        { service: 'odoo.client', type: { from: '@omadia/integration-odoo', name: 'OdooClient' } },
        { type: { from: '@omadia/integration-odoo', name: 'NoService' } }, // no service
        { service: 'odoo.broken', type: { name: 'NoFrom' } }, // no type.from
        { service: 'odoo.broken2', type: { from: '@omadia/integration-odoo' } }, // no type.name
        { service: 'odoo.broken3' }, // no type at all
        'not-an-object', // wrong shape
      ],
    }),
  );
  assert.ok(plugin);
  assert.deepEqual(plugin.service_types, [
    { service: 'odoo.client', type: { from: '@omadia/integration-odoo', name: 'OdooClient' } },
  ]);
});

test('a service_types block with only malformed entries yields absent (no empty array)', () => {
  const plugin = adaptManifestV1(
    manifest({ service_types: [{ service: 'x' }, 'bad'] }),
  );
  assert.ok(plugin);
  assert.equal(plugin.service_types, undefined);
});

test('a non-array service_types value is ignored', () => {
  const plugin = adaptManifestV1(manifest({ service_types: { service: 'x' } }));
  assert.ok(plugin);
  assert.equal(plugin.service_types, undefined);
});
