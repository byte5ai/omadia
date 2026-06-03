import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { ChannelManifestBlock } from '../src/api/admin-v1.js';
import { deriveChannelType } from '../src/channels/channelType.js';

/**
 * US7 — channelType autodiscovery bridges an inbound turn's `channelId`
 * (catalog id) to the short `channel_bindings.channel_type` selector operators
 * bind under, with no per-channel wiring.
 */

function block(channel_type?: string): ChannelManifestBlock {
  return {
    transport: { kind: 'webhook', routes: [], verify_signature: false },
    capabilities: ['text'],
    adapters: ['text'],
    ...(channel_type ? { channel_type } : {}),
  };
}

describe('deriveChannelType', () => {
  it('derives the last dotted segment of the channel id', () => {
    assert.equal(deriveChannelType('de.byte5.channel.teams'), 'teams');
    assert.equal(deriveChannelType('de.byte5.channel.telegram'), 'telegram');
  });

  it('prefers a manifest-declared channel_type over the derived segment', () => {
    assert.equal(
      deriveChannelType('de.byte5.channel.teams-eu', { manifest: block('teams') }),
      'teams',
    );
  });

  it('normalises case + whitespace so manifest and operator input match', () => {
    assert.equal(
      deriveChannelType('x', { manifest: block('  Teams  ') }),
      'teams',
    );
    assert.equal(deriveChannelType('de.byte5.channel.TELEGRAM'), 'telegram');
  });

  it('falls back to the whole id when there is no dot', () => {
    assert.equal(deriveChannelType('teams'), 'teams');
  });

  it('ignores an empty/whitespace manifest channel_type and derives instead', () => {
    assert.equal(
      deriveChannelType('de.byte5.channel.teams', { manifest: block('   ') }),
      'teams',
    );
  });
});
