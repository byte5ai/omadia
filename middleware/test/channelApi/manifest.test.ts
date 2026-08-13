import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { loadManifestFromPath } from '../../src/plugins/manifestLoader.js';

/**
 * Issue #438 — the manifest for the new public API channel package. Mirrors
 * `test/uiChannelPlugin.test.ts`'s manifest coverage for `@omadia/ui-channel`.
 */
describe('@omadia/channel-api manifest', () => {
  it('is a valid schema-v1 channel manifest with a chat webhook route', async () => {
    const manifestPath = fileURLToPath(
      new URL('../../packages/harness-channel-api/manifest.yaml', import.meta.url),
    );
    const entry = await loadManifestFromPath(manifestPath);
    assert.ok(entry, 'manifest loads as a valid schema-v1 document');
    assert.equal(entry.plugin.kind, 'channel');
    assert.equal(entry.plugin.id, '@omadia/channel-api');

    const channel = entry.plugin.channel;
    assert.ok(channel, 'channel block present');
    assert.equal(channel.transport.kind, 'webhook');
    assert.ok(
      channel.transport.routes.some(
        (r) => r.path === '/api/public/v1/chat' && r.method === 'POST',
      ),
      'declares the public chat route',
    );
    assert.ok(channel.capabilities.includes('text'));

    // No dispatch_service — a classic channel, dispatches to the shared
    // chatAgent like Teams/Telegram (see IncomingTurn.channelType doc).
    assert.equal(channel.dispatch_service, undefined);
  });

  it('declares permissions.secrets.runtime_write (required — API keys are vault-backed)', async () => {
    const manifestPath = fileURLToPath(
      new URL('../../packages/harness-channel-api/manifest.yaml', import.meta.url),
    );
    const entry = await loadManifestFromPath(manifestPath);
    assert.ok(entry);
    assert.equal(entry.plugin.permissions_summary.secrets_runtime_write, true);
  });
});
