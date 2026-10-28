import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pluginUiBundleMayExist } from '../pluginUiBundle';

/**
 * #1454 — the probe the plugin UI host page gates on.
 *
 * The page used to render heading, subtitle and frame for every well-formed
 * id, so an id with no bundle painted the middleware's raw
 * `{"error":"plugin_ui_not_found"}` JSON inside the frame with an HTTP 200
 * page around it. The page now asks first, and these tests pin the two
 * properties that decide whether that gate is right:
 *
 *   - the URL. A scoped id must stay ONE path segment (`%40omadia%2Fx`), the
 *     same path `PluginUiFrame` uses for the iframe `src` — both build it with
 *     `pluginUiEntryPath`. Dropping the encoding would 404 every `@scope/name`
 *     plugin, the #1399 bug class.
 *   - the verdict on everything that is not a 404. An unreachable middleware
 *     or a 500 must NOT be reported as "this plugin has no UI": that would
 *     turn an unrelated outage into a wrong not-found page. Only a definite
 *     404 means absent — hence `MayExist`.
 */

function stubFetch(impl: () => Promise<Response>): ReturnType<typeof vi.fn> {
  const spy = vi.fn(impl);
  vi.stubGlobal('fetch', spy);
  return spy;
}

function status(code: number): () => Promise<Response> {
  return async () => new Response(null, { status: code });
}

function callOf(spy: ReturnType<typeof vi.fn>): [string, RequestInit] {
  return spy.mock.calls[0] as [string, RequestInit];
}

beforeEach(() => {
  vi.stubEnv('MIDDLEWARE_URL', 'http://middleware:8080');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('pluginUiBundleMayExist (#1454)', () => {
  it('probes the bundle entry with a scoped id kept in one segment', async () => {
    const spy = stubFetch(status(200));
    await pluginUiBundleMayExist('@omadia/example-ui');
    const [url, init] = callOf(spy);
    expect(url).toBe('http://middleware:8080/p/%40omadia%2Fexample-ui/ui/index.html');
    expect(init.method).toBe('HEAD');
  });

  it('falls back to the local middleware when MIDDLEWARE_URL is unset or empty', async () => {
    vi.stubEnv('MIDDLEWARE_URL', '');
    const spy = stubFetch(status(200));
    await pluginUiBundleMayExist('some-plugin');
    expect(callOf(spy)[0]).toBe('http://localhost:3979/p/some-plugin/ui/index.html');
  });

  it('never caches the answer and carries a deadline', async () => {
    // A hanging middleware must not park the RSC payload — the ceiling is
    // `api.ts`'s shared one, which `rscFetchTimeout.test.ts` owns the value of.
    const spy = stubFetch(status(200));
    await pluginUiBundleMayExist('some-plugin');
    const [, init] = callOf(spy);
    expect(init.cache).toBe('no-store');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('reports a served bundle as present', async () => {
    stubFetch(status(200));
    await expect(pluginUiBundleMayExist('some-plugin')).resolves.toBe(true);
  });

  it('reports a 404 as absent — unknown id and installed-without-ui alike', async () => {
    stubFetch(status(404));
    await expect(pluginUiBundleMayExist('does-not-exist')).resolves.toBe(false);
    await expect(pluginUiBundleMayExist('@omadia/integration-confluence')).resolves.toBe(false);
  });

  it('does not call a 500 an absent UI', async () => {
    stubFetch(status(500));
    await expect(pluginUiBundleMayExist('some-plugin')).resolves.toBe(true);
  });

  it('does not call an unreachable middleware an absent UI', async () => {
    stubFetch(() => Promise.reject(new TypeError('fetch failed')));
    await expect(pluginUiBundleMayExist('some-plugin')).resolves.toBe(true);
  });
});
