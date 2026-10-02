import { strict as assert } from 'node:assert';
import { describe, it, mock } from 'node:test';
import { inspect } from 'node:util';

import { createPrivacyTurnHandle, guardControlFlowResult } from '@omadia/orchestrator';
import { createPrivacyGuardService } from '@omadia/plugin-privacy-guard/dist/index.js';
import {
  WEB_SEARCH_TOOL_NAME,
  WebSearchError,
  WebSearchProviderError,
  WebSearchQuotaError,
} from '@omadia/plugin-web-search';
import type { SearchProvider, SearchResponse } from '@omadia/plugin-web-search';
import { TtlLruCache } from '@omadia/plugin-web-search/dist/cache.js';
import { createBraveProvider } from '@omadia/plugin-web-search/dist/providers/brave.js';
import { createTavilyProvider } from '@omadia/plugin-web-search/dist/providers/tavily.js';
import { createWebSearchService } from '@omadia/plugin-web-search/dist/searchService.js';
import { createWebSearchToolHandler } from '@omadia/plugin-web-search/dist/searchTool.js';

/**
 * A web_search failure reaches the model in the plugin's own words only:
 * provider id, HTTP status, an auth / quota / config hint. A transport
 * exception (undici, DNS, a proxy) and an upstream response body carry text
 * the plugin never wrote. The providers keep them on `cause` / `body`, the
 * tool logs them under a ref, and neither reaches the model. Synthetic values.
 */

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

const NAME = 'Jane Doe';
const EMAIL = 'erika.mustermann@example.com';
const REF = /\[ref (err_[0-9a-f]{12})\]/;

/** A fetch that fails in transport, its message quoting a value. */
const throwingFetch: FetchFn = () =>
  Promise.reject(new Error(`connection failed for ${NAME}`));

/** A fetch that answers `status` with a JSON body quoting a value. */
function answering(status: number): FetchFn {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify({ error: `upstream rejected ${EMAIL}` }), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
}

const PROVIDERS = [
  ['tavily', createTavilyProvider],
  ['brave', createBraveProvider],
] as const;

function handlerFor(provider: SearchProvider): (input: unknown) => Promise<string> {
  const svc = createWebSearchService({
    provider,
    cache: new TtlLruCache<SearchResponse>(10, 1000),
    defaultTopK: 5,
    searchTtlMs: 1000,
  });
  return createWebSearchToolHandler(svc);
}

/** Run the handler with console.error captured; returns the result and log. */
async function runCapturingLog(
  handler: (input: unknown) => Promise<string>,
): Promise<{ result: string; log: string[] }> {
  const errorLog = mock.method(console, 'error', () => {});
  try {
    const result = await handler({ query: 'foo' });
    const log = errorLog.mock.calls.map((call) =>
      call.arguments.map((a) => (typeof a === 'string' ? a : inspect(a))).join(' '),
    );
    return { result, log };
  } finally {
    errorLog.mock.restore();
  }
}

function assertLoggedUnderRef(result: string, log: string[], needle: string): void {
  const ref = REF.exec(result)?.[1];
  assert.ok(ref, `no log ref in the result: ${result}`);
  assert.ok(
    log.some((line) => line.includes(`ref=${ref}`) && line.includes(needle)),
    'the withheld detail is logged under the same ref',
  );
}

describe('web_search providers — typed errors carry only the plugin text', () => {
  for (const [id, create] of PROVIDERS) {
    it(`${id}: a transport exception rides as the cause, not in the message`, async () => {
      const provider = create({ apiKey: 'k', fetch: throwingFetch });
      await assert.rejects(provider.search('q', {}), (err: unknown) => {
        assert.ok(err instanceof WebSearchProviderError);
        assert.equal(err.message, `[${id}] request failed`);
        assert.ok(
          err.cause instanceof Error && err.cause.message.includes(NAME),
          'the transport exception stays available for the log',
        );
        return true;
      });
    });

    it(`${id}: a 429 body stays off the quota error's message`, async () => {
      const provider = create({ apiKey: 'k', fetch: answering(429) });
      await assert.rejects(provider.search('q', {}), (err: unknown) => {
        assert.ok(err instanceof WebSearchQuotaError);
        assert.equal(err.message.includes(EMAIL), false, err.message);
        assert.ok(err.body?.includes(EMAIL), 'the body stays available for the log');
        return true;
      });
    });

    it(`${id}: a 5xx body stays off the provider error's message`, async () => {
      const provider = create({ apiKey: 'k', fetch: answering(502) });
      await assert.rejects(provider.search('q', {}), (err: unknown) => {
        assert.ok(err instanceof WebSearchProviderError);
        assert.equal(err.message, `[${id}] HTTP 502`);
        assert.equal(err.status, 502);
        assert.ok(err.body?.includes(EMAIL), 'the body stays available for the log');
        return true;
      });
    });
  }
});

describe('web_search tool — provider failures keep foreign text off the model', () => {
  for (const [id, create] of PROVIDERS) {
    it(`${id}: a transport failure answers without the exception text`, async () => {
      const handler = handlerFor(create({ apiKey: 'k', fetch: throwingFetch }));
      const { result, log } = await runCapturingLog(handler);
      assert.equal(result.includes(NAME), false, `the exception text reached the model: ${result}`);
      assert.match(
        result,
        new RegExp(`^Error: web_search provider '${id}' could not be reached \\[ref err_[0-9a-f]{12}\\]`),
      );
      assertLoggedUnderRef(result, log, NAME);
    });
  }

  it('keeps the HTTP status of a provider failure, not its body', async () => {
    const handler = handlerFor(createTavilyProvider({ apiKey: 'k', fetch: answering(502) }));
    const { result, log } = await runCapturingLog(handler);
    assert.equal(result.includes(EMAIL), false, `the body reached the model: ${result}`);
    assert.match(result, /^Error: web_search provider 'tavily' failed with HTTP 502 \[ref /);
    assertLoggedUnderRef(result, log, EMAIL);
  });

  it('keeps the quota hint and drops the 429 body', async () => {
    const handler = handlerFor(createBraveProvider({ apiKey: 'k', fetch: answering(429) }));
    const { result } = await runCapturingLog(handler);
    assert.equal(result.includes(EMAIL), false, `the body reached the model: ${result}`);
    assert.match(result, /^Error: web_search quota exceeded for provider 'brave'/);
  });

  it('never echoes the message of a provider error, whoever built it', async () => {
    // A provider written elsewhere may still fold foreign text into the
    // message the way this package's providers used to.
    const provider: SearchProvider = {
      id: 'tavily',
      search: () =>
        Promise.reject(
          new WebSearchProviderError('tavily', `request failed: connection failed for ${NAME}`),
        ),
    };
    const { result, log } = await runCapturingLog(handlerFor(provider));
    assert.equal(result.includes(NAME), false, `the message reached the model: ${result}`);
    assertLoggedUnderRef(result, log, NAME);
  });

  it('through the dispatch seam with the real privacy guard: no name, hint intact', async () => {
    // The seam redacts identity patterns, the deny-list and C1 when it is
    // configured — a name in running prose passes it. So the name must not
    // be in the tool result in the first place.
    const handler = handlerFor(createBraveProvider({ apiKey: 'k', fetch: throwingFetch }));
    const { result } = await runCapturingLog(handler);
    const privacy = createPrivacyTurnHandle({
      service: createPrivacyGuardService(),
      sessionId: 'session-web-search',
      turnId: 'turn-web-search',
    });
    const errorLog = mock.method(console, 'error', () => {});
    let forModel: string;
    try {
      forModel = await guardControlFlowResult({
        toolName: WEB_SEARCH_TOOL_NAME,
        result,
        privacy,
        site: 'test',
      });
    } finally {
      errorLog.mock.restore();
    }
    assert.equal(forModel.includes(NAME), false, `the name reached the model: ${forModel}`);
    assert.equal(forModel, result, 'the plugin-authored result passes the redactor unchanged');
  });

  it('withholds the message of a bare WebSearchError', async () => {
    const provider: SearchProvider = {
      id: 'brave',
      search: () => Promise.reject(new WebSearchError(`lookup failed for ${NAME}`)),
    };
    const { result, log } = await runCapturingLog(handlerFor(provider));
    assert.equal(result.includes(NAME), false, `the message reached the model: ${result}`);
    assert.match(result, /^Error: tool `web_search` failed with WebSearchError \[ref err_[0-9a-f]{12}\]/);
    assertLoggedUnderRef(result, log, NAME);
  });
});
