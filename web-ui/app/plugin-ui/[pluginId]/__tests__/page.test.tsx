import { createRequire } from 'node:module';
import { PassThrough } from 'node:stream';

import { createTranslator } from 'next-intl';
import { renderToPipeableStream } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { NavEntryDto } from '@/app/_lib/navigation';

import deMessages from '../../../../messages/de.json';
import enMessages from '../../../../messages/en.json';

/**
 * #1399 — the plugin UI host page 404'd for every scoped plugin id.
 * #1454 — and then rendered its frame for ids with no bundle at all, so the
 * middleware's raw `{"error":"plugin_ui_not_found"}` JSON showed as the page
 * content with an HTTP 200 around it. The bundle probe is mocked here (its own
 * behaviour is pinned in `app/_lib/__tests__/pluginUiBundle.test.ts`); what
 * these tests own is that the page REFUSES when the probe says absent, and
 * that it refuses through `notFound()` in the page file itself — the only
 * call site `app/__tests__/loadingBoundaries.test.ts` can see, and the only
 * one that yields a real 404 status (#1398).
 *
 * The unit test on the id gate passed throughout, because it decoded the value
 * itself before checking it: it tested the assumption in a comment ("Next hands
 * us the DECODED segment"), not the value the route gets. These tests build the
 * page params with Next's OWN param resolver (`getDynamicParam`, the function
 * whose result Next documents as "the value that is passed to user code"), so
 * a Next upgrade that changes the encoding either way is exercised here rather
 * than assumed.
 */

const NOT_FOUND = 'NEXT_NOT_FOUND';

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error(NOT_FOUND);
  },
}));

vi.mock('next-intl/server', () => ({
  getLocale: async () => 'en',
  getTranslations: async (namespace: string) =>
    createTranslator({
      locale: 'en',
      messages: enMessages as Record<string, unknown>,
      namespace,
    }),
}));

const bundleExists = vi.fn<(pluginId: string) => Promise<boolean>>();

vi.mock('@/app/_lib/pluginUiBundle', () => ({
  pluginUiBundleMayExist: (pluginId: string) => bundleExists(pluginId),
}));

const navEntries = vi.fn<(locale: string) => Promise<readonly NavEntryDto[]>>();

// The real `pluginUiNavLabel`; only the network half is stubbed.
vi.mock('@/app/_lib/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/_lib/navigation')>()),
  fetchNavEntries: (locale: string) => navEntries(locale),
}));

vi.mock('../_components/PluginUiFrame', () => ({
  PluginUiFrame: ({ pluginId, name }: { pluginId: string; name: string }) => (
    <div data-testid="frame" data-plugin-id={pluginId} data-name={name} />
  ),
}));

const { default: PluginUiPage, generateMetadata } = await import('../page');

beforeEach(() => {
  bundleExists.mockReset();
  bundleExists.mockResolvedValue(true);
  navEntries.mockReset();
  navEntries.mockResolvedValue([]);
});

const requireFromHere = createRequire(import.meta.url);
const { getDynamicParam } = requireFromHere(
  'next/dist/shared/lib/router/utils/get-dynamic-param.js',
) as {
  getDynamicParam: (
    params: Record<string, string>,
    segmentKey: string,
    type: string,
    fallbackRouteParams: null,
  ) => { value: string };
};

/** The `params` Next hands the page for a request to `/plugin-ui/<raw>`. */
function paramsFor(rawSegment: string): Promise<{ pluginId: string }> {
  // Next's matcher decodes the URL path before it interpolates the params;
  // `getDynamicParam` then produces the value user code receives.
  const matched = decodeURIComponent(rawSegment);
  const { value } = getDynamicParam({ pluginId: matched }, 'pluginId', 'd', null);
  return Promise.resolve({ pluginId: value });
}

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

describe('/plugin-ui/[pluginId] — scoped plugin ids (#1399)', () => {
  it('Next passes the scoped id to the page still percent-encoded', async () => {
    // Pins the premise. If a Next upgrade starts decoding, this fails and the
    // comment in `decodePluginIdSegment` needs updating; the page keeps
    // working either way (see the already-decoded case below).
    expect((await paramsFor('%40omadia%2Fexample-ui')).pluginId).toBe(
      '%40omadia%2Fexample-ui',
    );
  });

  it('renders the host page for /plugin-ui/%40omadia%2Fexample-ui', async () => {
    const page = await PluginUiPage({ params: paramsFor('%40omadia%2Fexample-ui') });
    const html = await renderToHtml(page);
    expect(html).toContain('@omadia/example-ui');
    // The frame gets the DECODED id; it encodes it once for the iframe src.
    expect(html).toContain('data-plugin-id="@omadia/example-ui"');
  });

  it('titles the tab with the decoded id', async () => {
    const meta = await generateMetadata({ params: paramsFor('%40omadia%2Fexample-ui') });
    expect(String(meta.title)).toContain('@omadia/example-ui');
    expect(String(meta.title)).not.toContain('%40');
  });

  it('still renders an unscoped id and an already-decoded scoped id', async () => {
    const unscoped = await renderToHtml(
      await PluginUiPage({ params: paramsFor('some-plugin') }),
    );
    expect(unscoped).toContain('data-plugin-id="some-plugin"');
    const decoded = await renderToHtml(
      await PluginUiPage({ params: Promise.resolve({ pluginId: '@omadia/example-ui' }) }),
    );
    expect(decoded).toContain('data-plugin-id="@omadia/example-ui"');
  });

  it('404s on encoded traversal and broken encoding', async () => {
    for (const raw of ['%2e%2e', '%40omadia%2F..']) {
      await expect(PluginUiPage({ params: paramsFor(raw) })).rejects.toThrow(NOT_FOUND);
    }
    await expect(
      PluginUiPage({ params: Promise.resolve({ pluginId: '%E0%A4%A' }) }),
    ).rejects.toThrow(NOT_FOUND);
    expect(await generateMetadata({ params: Promise.resolve({ pluginId: '%E0%A4%A' }) })).toEqual({});
  });
});

describe('/plugin-ui/[pluginId] — ids with no UI bundle (#1454)', () => {
  it('404s an unknown id and an installed plugin that ships no ui/', async () => {
    bundleExists.mockResolvedValue(false);
    for (const raw of ['does-not-exist', '%40omadia%2Fintegration-confluence']) {
      await expect(PluginUiPage({ params: paramsFor(raw) })).rejects.toThrow(NOT_FOUND);
    }
  });

  it('probes the decoded id, not the raw segment', async () => {
    bundleExists.mockResolvedValue(false);
    await expect(
      PluginUiPage({ params: paramsFor('%40omadia%2Fintegration-confluence') }),
    ).rejects.toThrow(NOT_FOUND);
    expect(bundleExists).toHaveBeenCalledWith('@omadia/integration-confluence');
  });

  it('never probes an id the charset gate already refused', async () => {
    await expect(PluginUiPage({ params: paramsFor('%2e%2e') })).rejects.toThrow(NOT_FOUND);
    expect(bundleExists).not.toHaveBeenCalled();
  });

  it('gives the tab the default title instead of echoing a UI-less id', async () => {
    bundleExists.mockResolvedValue(false);
    expect(await generateMetadata({ params: paramsFor('does-not-exist') })).toEqual({});
  });

  it('renders heading, subtitle and frame once the bundle is there', async () => {
    bundleExists.mockResolvedValue(true);
    const html = await renderToHtml(
      await PluginUiPage({ params: paramsFor('%40omadia%2Fexample-ui') }),
    );
    expect(html).toContain('data-plugin-id="@omadia/example-ui"');
    expect(html).not.toContain('plugin_ui_not_found');
  });
});

describe('/plugin-ui/[pluginId] — the plugin is named, not its id (#1479)', () => {
  const entry = (over: Partial<NavEntryDto> = {}): NavEntryDto => ({
    pluginId: '@omadia/dev-platform',
    navId: 'main',
    href: `/plugin-ui/${encodeURIComponent('@omadia/dev-platform')}`,
    order: 100,
    label: 'Dev Platform',
    ...over,
  });

  it('uses the nav label in heading, tab title and frame title', async () => {
    navEntries.mockResolvedValue([entry()]);
    const params = paramsFor('%40omadia%2Fdev-platform');
    const html = await renderToHtml(await PluginUiPage({ params }));
    expect(html).toMatch(/<h1[^>]*>Dev Platform<\/h1>/);
    expect(html).toContain('data-name="Dev Platform"');
    // The frame still loads by id.
    expect(html).toContain('data-plugin-id="@omadia/dev-platform"');
    const meta = await generateMetadata({ params: paramsFor('%40omadia%2Fdev-platform') });
    expect(meta.title).toBe('Dev Platform — Plugin UI');
    expect(navEntries).toHaveBeenCalledWith('en');
  });

  it('ignores the same plugin’s entries for other pages and other plugins’ entries', async () => {
    navEntries.mockResolvedValue([
      entry({ href: '/admin/dev-platform-settings', label: 'Dev settings' }),
      entry({ pluginId: '@omadia/other', href: '/plugin-ui/%40omadia%2Fother', label: 'Other' }),
    ]);
    const html = await renderToHtml(
      await PluginUiPage({ params: paramsFor('%40omadia%2Fdev-platform') }),
    );
    expect(html).toMatch(/<h1[^>]*>@omadia\/dev-platform<\/h1>/);
  });

  it('falls back to the id when the plugin registered no nav entry', async () => {
    const meta = await generateMetadata({ params: paramsFor('%40omadia%2Fdev-platform') });
    expect(meta.title).toBe('@omadia/dev-platform — Plugin UI');
  });
});

describe('/plugin-ui/[pluginId] — subtitle (#1501)', () => {
  it('does not claim the frame isolates the plugin', async () => {
    // The frame is `allow-same-origin allow-scripts` on purpose (see
    // `PluginUiFrame.tsx`); the copy must say what that means, not "sandboxed".
    const html = await renderToHtml(
      await PluginUiPage({ params: paramsFor('some-plugin') }),
    );
    expect(html).toContain(enMessages.pluginUi.subtitle);
    for (const subtitle of [enMessages.pluginUi.subtitle, deMessages.pluginUi.subtitle]) {
      expect(subtitle).not.toMatch(/sandbox|abgeschotteten Frame|isolated frame/i);
    }
  });
});
