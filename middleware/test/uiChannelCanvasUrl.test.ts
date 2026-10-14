/**
 * The absolute canvas URL `@omadia/ui-channel` advertises on `GET
 * /omadia-ui/info` (#293), and where its `ws`/`wss` comes from (#1310, §10o).
 *
 * The plugin keeps zero runtime deps on the kernel, so it carries its own copy
 * of two kernel facts: the `PUBLIC_SCHEME` app-setting key, and the scheme
 * resolution the kernel does in `requestIsSecure`. Two copies drift, and the
 * failure would be quiet — a `ws://` URL handed to an HTTPS page, blocked as
 * mixed content, on exactly the deployments that declared HTTPS. The last case
 * here pins the copies together; the rest pin the resolution.
 *
 * `absoluteCanvasWsUrl` is module-private, so these drive the registered route
 * the way the kernel does.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { PluginContext } from '@omadia/plugin-api';
import type { ChannelHandle, CoreApi } from '@omadia/channel-sdk';

import { activate, CANVAS_PATH, INFO_PATH } from '../packages/omadia-ui-channel/src/plugin.js';
import { PUBLIC_SCHEME_SETTING } from '../src/http/requestTrust.js';

type Handler = (req: unknown, res: unknown) => void;

/** The discovery handler the plugin registers, plus its channel handle. */
async function discoveryRoute(): Promise<{ handler: Handler; handle: ChannelHandle }> {
  const ctx = {
    agentId: '@omadia/ui-channel',
    log: () => {},
    notifications: { registerChannel: () => () => {} },
    // `activate` resolves the tenant id from the service registry once the
    // kernel wired a WebSocket registry (plugin.ts, `if (wsAvailable)`), which
    // these cases need so the route advertises a wsUrl at all.
    services: { get: () => undefined },
  } as unknown as PluginContext;
  let handler: Handler | undefined;
  const core = {
    registerRoute: (_id: string, _m: string, path: string, h: Handler) => {
      if (path === INFO_PATH) handler = h;
    },
    // Feature-detected by the plugin: without it the route reports
    // `websocket: 'unavailable'` and advertises no wsUrl at all.
    registerWebSocket: () => () => {},
  } as unknown as CoreApi;
  const handle = await activate(ctx, core);
  assert.ok(handler, 'precondition: the discovery route was registered');
  return { handler, handle };
}

interface RequestShape {
  /** `req.secure` — what express computed from the connection + trusted hops. */
  readonly secure?: boolean;
  /** The value stored under the `PUBLIC_SCHEME` app setting, if any. */
  readonly publicScheme?: string;
  readonly headers?: Record<string, string>;
}

/** The advertised `wsUrl` for one request shape. */
async function wsUrlFor(req: RequestShape): Promise<string | undefined> {
  const { handler, handle } = await discoveryRoute();
  let body: { wsUrl?: string } = {};
  handler(
    {
      headers: req.headers ?? { host: 'omadia.example.com' },
      secure: req.secure,
      app: { get: (name: string) => (name === PUBLIC_SCHEME_SETTING ? req.publicScheme : undefined) },
    },
    { json: (payload: { wsUrl?: string }) => { body = payload; } },
  );
  await handle.close();
  return body.wsUrl;
}

describe('ui-channel canvas URL — scheme follows the connection', () => {
  it('advertises ws:// on a plain-HTTP request', async () => {
    assert.equal(
      await wsUrlFor({ secure: false }),
      `ws://omadia.example.com${CANVAS_PATH}`,
    );
  });

  it('advertises wss:// when express says the connection is secure', async () => {
    assert.equal(
      await wsUrlFor({ secure: true }),
      `wss://omadia.example.com${CANVAS_PATH}`,
    );
  });

  it('ignores a raw x-forwarded-proto the client wrote (#1310)', async () => {
    // The whole defect in one case: before #1310 this header decided the
    // scheme, so a client picked the URL it was then handed.
    assert.equal(
      await wsUrlFor({
        secure: false,
        headers: { host: 'omadia.example.com', 'x-forwarded-proto': 'https' },
      }),
      `ws://omadia.example.com${CANVAS_PATH}`,
    );
  });

  it('still honours x-forwarded-host — a proxied host is otherwise unreachable', async () => {
    assert.equal(
      await wsUrlFor({
        secure: true,
        headers: { host: 'internal:8080', 'x-forwarded-host': 'public.example.com, internal' },
      }),
      `wss://public.example.com${CANVAS_PATH}`,
    );
  });
});

describe('ui-channel canvas URL — PUBLIC_SCHEME', () => {
  it('`https` wins over a plain-HTTP connection (TLS terminated upstream)', async () => {
    assert.equal(
      await wsUrlFor({ secure: false, publicScheme: 'https' }),
      `wss://omadia.example.com${CANVAS_PATH}`,
    );
  });

  it('`http` wins over a secure connection', async () => {
    assert.equal(
      await wsUrlFor({ secure: true, publicScheme: 'http' }),
      `ws://omadia.example.com${CANVAS_PATH}`,
    );
  });

  it('`auto`, an unset setting and a typo all fall back to the connection', async () => {
    for (const publicScheme of ['auto', undefined, 'always', '']) {
      assert.equal(
        await wsUrlFor({ secure: true, publicScheme }),
        `wss://omadia.example.com${CANVAS_PATH}`,
        `publicScheme=${JSON.stringify(publicScheme)}`,
      );
      assert.equal(
        await wsUrlFor({ secure: false, publicScheme }),
        `ws://omadia.example.com${CANVAS_PATH}`,
        `publicScheme=${JSON.stringify(publicScheme)}`,
      );
    }
  });

  it('reads the SAME app-setting key the kernel writes', async () => {
    // The plugin spells the key literally to keep its zero kernel deps. If
    // either side renames it, the plugin reads `undefined`, silently falls back
    // to the connection, and an HTTPS deployment starts advertising ws://.
    // This case fails instead.
    assert.equal(PUBLIC_SCHEME_SETTING, 'omadia:public-scheme');
    assert.equal(
      await wsUrlFor({ secure: false, publicScheme: 'https' }),
      `wss://omadia.example.com${CANVAS_PATH}`,
      'the plugin did not read the kernel key',
    );
  });
});
