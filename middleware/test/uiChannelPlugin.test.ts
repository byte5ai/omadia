import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import type { CoreApi } from '../packages/harness-channel-sdk/src/index.js';
import type { PluginContext } from '../packages/plugin-api/src/index.js';
import { loadManifestFromPath } from '../src/plugins/manifestLoader.js';
import {
  activate,
  INFO_PATH,
} from '../packages/omadia-ui-channel/src/plugin.js';

/**
 * PR-10a — the omadia-ui-channel skeleton. The manifest declares the canvas
 * surface (capabilities [text, canvas] + dispatch_service canvasChatAgent);
 * activate registers a discovery endpoint. The WS transport is deferred.
 */

describe('omadia-ui-channel manifest', () => {
  it('is a valid schema-v1 channel manifest declaring the canvas surface', async () => {
    const manifestPath = fileURLToPath(
      new URL('../packages/omadia-ui-channel/manifest.yaml', import.meta.url),
    );
    const entry = await loadManifestFromPath(manifestPath);
    assert.ok(entry, 'manifest loads as a valid schema-v1 document');
    assert.equal(entry.plugin.kind, 'channel');
    assert.equal(entry.plugin.id, '@omadia/ui-channel');
    const channel = entry.plugin.channel;
    assert.ok(channel, 'channel block present');
    assert.ok(channel.capabilities.includes('canvas'), "declares the 'canvas' capability");
    assert.ok(channel.capabilities.includes('text'));
    assert.equal(channel.dispatch_service, 'canvasChatAgent');
    assert.equal(channel.canvas_protocol_version, '1.0');
  });
});

describe('omadia-ui-channel activate', () => {
  function makeMocks() {
    // `notifications` is a required PluginContext accessor (activate registers a
    // notification channel via ctx.notifications.registerChannel); mock it so the
    // discovery-route tests exercise activate() without the full kernel wiring.
    const ctx = {
      agentId: '@omadia/ui-channel',
      log: () => {},
      notifications: { registerChannel: () => () => {} },
    } as unknown as PluginContext;
    const captured: {
      channelId?: string;
      method?: string;
      path?: string;
      handler?: (...a: unknown[]) => void;
    } = {};
    const core = {
      registerRoute: (
        channelId: string,
        method: string,
        path: string,
        handler: (...a: unknown[]) => void,
      ) => {
        captured.channelId = channelId;
        captured.method = method;
        captured.path = path;
        captured.handler = handler;
      },
    } as unknown as CoreApi;
    return { ctx, core, captured };
  }

  it('registers a GET discovery route scoped to the channel id', async () => {
    const { ctx, core, captured } = makeMocks();
    const handle = await activate(ctx, core);
    assert.equal(captured.method, 'GET');
    assert.equal(captured.path, INFO_PATH);
    assert.equal(captured.channelId, '@omadia/ui-channel');
    assert.ok(handle.close, 'returns a closeable handle');
    await handle.close();
  });

  it('the discovery handler advertises the canvas protocol + capabilities', async () => {
    const { ctx, core, captured } = makeMocks();
    await activate(ctx, core);
    let body: Record<string, unknown> | undefined;
    const res = { json: (b: Record<string, unknown>) => { body = b; } };
    captured.handler?.({}, res, () => {});
    assert.deepEqual(body?.['capabilities'], ['text', 'canvas']);
    assert.equal(body?.['dispatchService'], 'canvasChatAgent');
    assert.deepEqual(body?.['protocolVersions'], ['1.0']);
  });
});
