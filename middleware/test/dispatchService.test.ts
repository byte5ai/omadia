import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { CHAT_AGENT_SERVICE } from '@omadia/channel-sdk';

import type { ChannelManifestBlock } from '../src/api/admin-v1.js';
import { resolveDispatchService } from '../src/channels/dispatchService.js';

/**
 * PR-6 — per-channel dispatch resolution. A channel manifest may declare
 * `channel.dispatch_service` to route its turns to an alternate orchestrator
 * (Omadia UI's `canvasChatAgent`); classic channels declare none and must keep
 * resolving to the shared `chatAgent`, with zero behaviour change.
 */
describe('resolveDispatchService', () => {
  const baseChannel: ChannelManifestBlock = {
    transport: { kind: 'websocket', routes: [], verify_signature: false },
    capabilities: ['text'],
    adapters: ['text'],
  };

  it('falls back to chatAgent when the channel block is undefined', () => {
    assert.equal(resolveDispatchService(undefined), CHAT_AGENT_SERVICE);
    assert.equal(resolveDispatchService(undefined), 'chatAgent');
  });

  it('falls back to chatAgent when no dispatch_service is declared', () => {
    assert.equal(resolveDispatchService(baseChannel), CHAT_AGENT_SERVICE);
  });

  it('returns the declared bare dispatch_service when present', () => {
    const canvas: ChannelManifestBlock = {
      ...baseChannel,
      capabilities: ['text', 'canvas'],
      dispatch_service: 'canvasChatAgent',
    };
    assert.equal(resolveDispatchService(canvas), 'canvasChatAgent');
  });
});
