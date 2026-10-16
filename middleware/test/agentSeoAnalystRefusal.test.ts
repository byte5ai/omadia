import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { modelReadableToolErrorMessage } from '@omadia/plugin-api';
import type { HttpAccessor, PluginContext } from '@omadia/plugin-api';

import { createFetcher } from '../packages/agent-seo-analyst/fetcher.js';
import { activate } from '../packages/agent-seo-analyst/plugin.js';
import { createToolkit } from '../packages/agent-seo-analyst/toolkit.js';
import type { TechnicalReport } from '../packages/agent-seo-analyst/types.js';

/**
 * #1343 / #1344 / #1351 — the SEO analyst never reports on a site it did not
 * reach, says why in a message the model may read, and activates without
 * network access.
 */

const noopLog = (): void => {};

function blockedError(url: string): Error {
  const err = new Error(
    `plugin '@omadia/agent-seo-analyst' is not permitted to reach '${new URL(url).hostname}' — ` +
      'is a private, loopback, link-local or otherwise non-public address',
  );
  err.name = 'HttpBlockedAddressError';
  return err;
}

function toolkitWith(http: HttpAccessor): ReturnType<typeof createToolkit> {
  const fetcher = createFetcher({ userAgent: 'ua', timeoutMs: 5000, log: noopLog, http });
  return createToolkit({
    fetcher,
    targetBaseUrl: 'https://omadia.ai',
    userAgent: 'ua',
    crawlMaxPages: 5,
    crawlMaxDepth: 1,
    auditMode: 'public-web',
    log: noopLog,
  });
}

const CALLS = [
  ['analyze_page', { url: 'http://10.0.0.5/' }],
  ['check_technical_seo', { base_url: 'http://10.0.0.5/' }],
  ['audit_site', { start_url: 'http://10.0.0.5/' }],
] as const;

describe('agent-seo-analyst — no report for a site it never reached (#1344)', () => {
  for (const [id, input] of CALLS) {
    it(`${id} rejects a host the SSRF guard blocked, with a model-readable refusal`, async () => {
      const toolkit = toolkitWith({
        async fetch(url: string): Promise<Response> {
          throw blockedError(url);
        },
      });
      await assert.rejects(toolkit.getTool(id)!.run(input), (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(err.name, 'ToolRefusalError');
        assert.match(err.message, /not permitted to reach '10\.0\.0\.5'/);
        assert.match(err.message, /\(audit mode: public-web\)\. The requested URL was NOT analysed/);
        // #1343 — the host passes this message to the model.
        assert.equal(modelReadableToolErrorMessage(err), err.message);
        return true;
      });
    });

    it(`${id} rejects an unreachable host instead of scoring an empty response`, async () => {
      const toolkit = toolkitWith({
        async fetch(): Promise<Response> {
          throw new TypeError('fetch failed');
        },
      });
      await assert.rejects(toolkit.getTool(id)!.run(input), (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(err.name, 'ToolRefusalError');
        assert.match(err.message, /^fetch failed for http:\/\/10\.0\.0\.5\/? — /);
        return true;
      });
    });
  }

  it('reports a blocked robots.txt sitemap on another host as fetch.blocked, not sitemap.missing', async () => {
    const toolkit = toolkitWith({
      async fetch(url: string): Promise<Response> {
        if (url.startsWith('https://cdn.internal.example/')) throw blockedError(url);
        if (url.endsWith('/robots.txt')) {
          return new Response('User-agent: *\nAllow: /\nSitemap: https://cdn.internal.example/sitemap.xml\n', {
            status: 200,
          });
        }
        return new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } });
      },
    });
    const report = (await toolkit
      .getTool('check_technical_seo')!
      .run({ base_url: 'https://shop.example/' })) as TechnicalReport;
    const codes = report.issues.map((i) => i.code);
    assert.ok(codes.includes('fetch.blocked'), codes.join(','));
    assert.equal(codes.includes('sitemap.missing'), false);
    assert.equal(report.sitemaps[0]?.blocked, true);
  });

  it('keeps per-page handling for a later page of the crawl', async () => {
    const toolkit = toolkitWith({
      async fetch(url: string): Promise<Response> {
        if (url.endsWith('/broken')) throw new TypeError('fetch failed');
        const res = new Response('<html><body><a href="/broken">x</a></body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
        // A constructed Response has an empty `url`; the crawler resolves links against it.
        Object.defineProperty(res, 'url', { value: url });
        return res;
      },
    });
    const report = (await toolkit
      .getTool('audit_site')!
      .run({ start_url: 'https://shop.example/' })) as { per_page: { url: string; status: number }[] };
    assert.deepEqual(
      report.per_page.map((p) => p.status),
      [200, 0],
    );
  });
});

function contextWith(fetch: HttpAccessor['fetch']): PluginContext {
  return {
    http: { fetch },
    config: { get: () => undefined },
    log: noopLog,
  } as unknown as PluginContext;
}

describe('agent-seo-analyst — activation without network access (#1351)', () => {
  it('activates when the target fails fast (DNS failure, connection refused)', async () => {
    const handle = await activate(
      contextWith(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    assert.equal(handle.toolkit.tools.length, 3);
  });

  it('activates within its own 5 s budget when the connection hangs', async () => {
    const started = Date.now();
    const handle = await activate(
      contextWith(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('This operation was aborted', 'AbortError'));
            });
          }),
      ),
    );
    const elapsed = Date.now() - started;
    assert.equal(handle.toolkit.tools.length, 3);
    assert.ok(elapsed < 10_000, `activate() took ${String(elapsed)} ms — over the runtime's 10 s budget`);
  });

  it('still refuses to activate when the audit mode blocks the configured target', async () => {
    await assert.rejects(
      activate(
        contextWith(async (url) => {
          throw blockedError(url);
        }),
      ),
      /seo-analyst: plugin '@omadia\/agent-seo-analyst' is not permitted to reach 'omadia\.ai'/,
    );
  });
});
