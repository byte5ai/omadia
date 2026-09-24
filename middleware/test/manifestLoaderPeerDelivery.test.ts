/**
 * #1018 W0 — `channel.peer_delivery` on a schema-v1 channel manifest.
 *
 * Contract only: no shipped channel declares `'native'` yet. What is pinned
 * here is the failure direction — an unknown value must read as UNDECLARED
 * (= `'none'`, the relay is the only path), never as `'native'`, because
 * `'native'` is what will later make an inbound handler drop peer messages.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { adaptManifestV1 } from '../src/plugins/manifestLoader.js';

function channelManifest(channel: Record<string, unknown>): Record<string, unknown> {
  return {
    schema_version: '1',
    identity: {
      id: 'de.byte5.channel.test',
      kind: 'channel',
      domain: 'test',
      name: 'Test Channel',
      version: '1.0.0',
    },
    channel: {
      transport: { kind: 'webhook', routes: [] },
      capabilities: ['text'],
      adapters: ['text'],
      ...channel,
    },
  };
}

test('peer_delivery: native is carried through', () => {
  const plugin = adaptManifestV1(channelManifest({ peer_delivery: 'native' }));
  assert.equal(plugin?.channel?.peer_delivery, 'native');
});

test('peer_delivery: none is carried through', () => {
  const plugin = adaptManifestV1(channelManifest({ peer_delivery: 'none' }));
  assert.equal(plugin?.channel?.peer_delivery, 'none');
});

test('peer_delivery absent or unknown reads as undeclared, never as native', () => {
  assert.equal(adaptManifestV1(channelManifest({}))?.channel?.peer_delivery, undefined);
  assert.equal(
    adaptManifestV1(channelManifest({ peer_delivery: 'always' }))?.channel?.peer_delivery,
    undefined,
  );
});
