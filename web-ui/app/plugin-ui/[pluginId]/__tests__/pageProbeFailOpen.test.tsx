import { PassThrough } from 'node:stream';

import { createTranslator } from 'next-intl';
import { renderToPipeableStream } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import enMessages from '../../../../messages/en.json';

/**
 * #1454 — the page and the real probe, composed.
 *
 * `page.test.tsx` mocks `pluginUiBundleMayExist`, so it can only ever agree
 * with whatever the mock was told. The rule that decides whether this gate is
 * safe lives in the seam BETWEEN page and probe: a definite 404 must 404 the
 * page, and every other failure — a 500, a dead middleware, a timeout — must
 * still render the frame. Mocked on either side of that seam the rule is
 * untestable, so these tests use the real module and stub `fetch` instead.
 *
 * Why it matters: fail-closed here would turn "the middleware is restarting"
 * into "this plugin does not exist" on every plugin UI at once.
 */

const NOT_FOUND = 'NEXT_NOT_FOUND';

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error(NOT_FOUND);
  },
}));

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({
      locale: 'en',
      messages: enMessages as Record<string, unknown>,
      namespace,
    }),
}));

vi.mock('../_components/PluginUiFrame', () => ({
  PluginUiFrame: ({ pluginId }: { pluginId: string }) => (
    <div data-testid="frame" data-plugin-id={pluginId} />
  ),
}));

// Deliberately NOT mocked: `@/app/_lib/pluginUiBundle` is the module under
// test here, together with the page.
const { default: PluginUiPage } = await import('../page');

async function renderToHtml(node: React.ReactElement): Promise<string> {
  return new Promise((resolve, reject) => {
    const stream = new PassThrough();
    let html = '';
    stream.on('data', (chunk: Buffer) => {
      html += chunk.toString();
    });
    stream.on('end', () => resolve(html));
    const { pipe } = renderToPipeableStream(node, {
      onAllReady: () => pipe(stream),
      onError: reject,
    });
  });
}

function stubFetch(impl: () => Promise<Response>): ReturnType<typeof vi.fn> {
  const spy = vi.fn(impl);
  vi.stubGlobal('fetch', spy);
  return spy;
}

const params = (pluginId: string): Promise<{ pluginId: string }> =>
  Promise.resolve({ pluginId });

beforeEach(() => {
  vi.stubEnv('MIDDLEWARE_URL', 'http://middleware:8080');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('/plugin-ui/[pluginId] with the real bundle probe (#1454)', () => {
  it('404s on the middleware\'s definite 404', async () => {
    stubFetch(async () => new Response(null, { status: 404 }));
    await expect(PluginUiPage({ params: params('does-not-exist') })).rejects.toThrow(
      NOT_FOUND,
    );
  });

  it('renders the frame when the middleware is unreachable', async () => {
    stubFetch(() => Promise.reject(new TypeError('fetch failed')));
    const html = await renderToHtml(await PluginUiPage({ params: params('some-plugin') }));
    expect(html).toContain('data-plugin-id="some-plugin"');
  });

  it('renders the frame on a 500 rather than claiming the plugin has no UI', async () => {
    stubFetch(async () => new Response(null, { status: 500 }));
    const html = await renderToHtml(await PluginUiPage({ params: params('some-plugin') }));
    expect(html).toContain('data-plugin-id="some-plugin"');
  });

  it('asks for the bundle entry of the decoded id, scope encoded as one segment', async () => {
    const spy = stubFetch(async () => new Response(null, { status: 200 }));
    const html = await renderToHtml(
      await PluginUiPage({ params: params('%40omadia%2Fexample-ui') }),
    );
    expect(spy.mock.calls[0]?.[0]).toBe(
      'http://middleware:8080/p/%40omadia%2Fexample-ui/ui/index.html',
    );
    expect(html).toContain('data-plugin-id="@omadia/example-ui"');
  });
});
