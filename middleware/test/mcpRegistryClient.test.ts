import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  McpRegistryClient,
  McpRegistryError,
  type McpRegistryConfig,
} from '../src/services/mcpRegistryClient.js';

const REGISTRY: McpRegistryConfig = {
  id: 'reg-1',
  name: 'official',
  url: 'https://registry.example',
  authKind: 'none',
  token: null,
};

const OFFICIAL_DOC = {
  servers: [
    {
      server: {
        name: 'io.github.acme/billing',
        description: 'Billing tools for acme.',
        version: '1.2.0',
        repository: { url: 'https://github.com/acme/billing-mcp' },
        remotes: [{ type: 'streamable-http', url: 'https://mcp.acme.example/http' }],
      },
    },
    {
      server: {
        name: 'io.github.acme/local-notes',
        description: 'Notes via npm package.',
        packages: [{ registry_name: 'npm', name: '@acme/notes-mcp' }],
      },
    },
    {
      server: {
        name: 'io.github.acme/browse-only',
        description: 'No remotes, no packages.',
      },
    },
  ],
};

function fetchOk(doc: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(doc), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

describe('McpRegistryClient', () => {
  it('normalizes official-shape entries: remotes, npm packages, browse-only', async () => {
    const client = new McpRegistryClient({ fetchImpl: fetchOk(OFFICIAL_DOC), log: () => {} });
    const entries = await client.catalog(REGISTRY);
    assert.equal(entries.length, 3);
    const [http, npm, browseOnly] = entries;
    assert.equal(http?.transport, 'http');
    assert.equal(http?.endpoint, 'https://mcp.acme.example/http');
    assert.equal(http?.author, 'acme');
    assert.equal(http?.sourceUrl, 'https://github.com/acme/billing-mcp');
    assert.equal(npm?.transport, 'stdio');
    assert.equal(npm?.endpoint, 'npx -y -- @acme/notes-mcp');
    assert.equal(browseOnly?.transport, null);
    assert.equal(browseOnly?.endpoint, null);
  });

  it('searches name and description case-insensitively', async () => {
    const client = new McpRegistryClient({ fetchImpl: fetchOk(OFFICIAL_DOC), log: () => {} });
    const hits = await client.search(REGISTRY, 'BILLING');
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.id, 'io.github.acme/billing');
  });

  it('resolve throws catalog_entry_not_found for unknown ids', async () => {
    const client = new McpRegistryClient({ fetchImpl: fetchOk(OFFICIAL_DOC), log: () => {} });
    await assert.rejects(
      client.resolve(REGISTRY, 'nope'),
      (err: unknown) => err instanceof McpRegistryError && err.code === 'catalog_entry_not_found',
    );
  });

  it('serves the second call from cache (single fetch)', async () => {
    let calls = 0;
    const counting: typeof fetch = (async (...args: Parameters<typeof fetch>) => {
      calls += 1;
      return fetchOk(OFFICIAL_DOC)(...args);
    }) as typeof fetch;
    const client = new McpRegistryClient({ fetchImpl: counting, log: () => {} });
    await client.catalog(REGISTRY);
    await client.catalog(REGISTRY);
    assert.equal(calls, 1);
    client.invalidate(REGISTRY.id);
    await client.catalog(REGISTRY);
    assert.equal(calls, 2);
  });

  it('sends the bearer token for authed registries', async () => {
    let seenAuth: string | null = null;
    const capturing: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenAuth = (init?.headers as Record<string, string> | undefined)?.['authorization'] ?? null;
      return fetchOk(OFFICIAL_DOC)(input, init);
    }) as typeof fetch;
    const client = new McpRegistryClient({ fetchImpl: capturing, log: () => {} });
    await client.catalog({ ...REGISTRY, id: 'reg-2', authKind: 'bearer', token: 's3cret' });
    assert.equal(seenAuth, 'Bearer s3cret');
  });

  it('refuses internal/link-local catalog remotes (browse-only), keeps public https', async () => {
    const doc = {
      servers: [
        { name: 'public', remotes: [{ type: 'http', url: 'https://mcp.public.example/http' }] },
        { name: 'metadata', remotes: [{ type: 'http', url: 'https://metadata.google.internal/mcp' }] },
        { name: 'loopback', remotes: [{ type: 'http', url: 'https://127.0.0.1/mcp' }] },
        { name: 'private', remotes: [{ type: 'http', url: 'https://10.1.2.3/mcp' }] },
        { name: 'plainhttp', remotes: [{ type: 'http', url: 'http://mcp.public.example/http' }] },
      ],
    };
    const client = new McpRegistryClient({ fetchImpl: fetchOk(doc), log: () => {} });
    const byName = new Map((await client.catalog(REGISTRY)).map((e) => [e.name, e]));
    assert.equal(byName.get('public')?.transport, 'http');
    assert.equal(byName.get('metadata')?.transport, null);
    assert.equal(byName.get('loopback')?.transport, null);
    assert.equal(byName.get('private')?.transport, null);
    assert.equal(byName.get('plainhttp')?.transport, null);
  });

  it('refuses npx option-shaped npm names, accepts real ones with a -- separator', async () => {
    const doc = {
      servers: [
        { name: 'ok', packages: [{ registry_name: 'npm', name: '@acme/notes-mcp' }] },
        { name: 'flag', packages: [{ registry_name: 'npm', name: '-y' }] },
        { name: 'dashdash', packages: [{ registry_name: 'npm', name: '--yes' }] },
      ],
    };
    const client = new McpRegistryClient({ fetchImpl: fetchOk(doc), log: () => {} });
    const byName = new Map((await client.catalog(REGISTRY)).map((e) => [e.name, e]));
    assert.equal(byName.get('ok')?.endpoint, 'npx -y -- @acme/notes-mcp');
    assert.equal(byName.get('flag')?.transport, null);
    assert.equal(byName.get('dashdash')?.transport, null);
  });

  it('official: dedups to the latest version per server name', async () => {
    const doc = {
      servers: [
        { server: { name: 'io.x/a', version: '1.0.0', remotes: [{ type: 'streamable-http', url: 'https://a.example/mcp' }] }, _meta: { isLatest: false } },
        { server: { name: 'io.x/a', version: '2.0.0', remotes: [{ type: 'streamable-http', url: 'https://a.example/mcp' }] }, _meta: { isLatest: true } },
      ],
    };
    const client = new McpRegistryClient({ fetchImpl: fetchOk(doc), log: () => {} });
    const entries = await client.catalog(REGISTRY);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.version, '2.0.0');
  });

  it('official: reads registryType/identifier npm packages (current schema)', async () => {
    const doc = {
      servers: [
        { server: { name: 'io.x/np', packages: [{ registryType: 'npm', identifier: '@acme/tool-mcp', transport: { type: 'stdio' } }] } },
      ],
    };
    const client = new McpRegistryClient({ fetchImpl: fetchOk(doc), log: () => {} });
    const entries = await client.catalog(REGISTRY);
    assert.equal(entries[0]?.transport, 'stdio');
    assert.equal(entries[0]?.endpoint, 'npx -y -- @acme/tool-mcp');
  });

  it('smithery: normalizes list entries and resolves endpoint on a second fetch', async () => {
    const list = {
      servers: [
        { qualifiedName: 'acme/search', displayName: 'Acme Search', description: 'Search things.', remote: true, owner: 'acme', homepage: 'https://acme.example' },
        { qualifiedName: 'acme/local', displayName: 'Local only', remote: false },
      ],
      pagination: { totalCount: 2 },
    };
    const detail = {
      qualifiedName: 'acme/search',
      connections: [{ type: 'http', deploymentUrl: 'https://server.smithery.ai/acme/search/mcp' }],
    };
    const fetchImpl: typeof fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes('/servers/acme') ? detail : list;
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const smithery = { ...REGISTRY, id: 'sm', name: 'smithery', kind: 'smithery' as const };
    const client = new McpRegistryClient({ fetchImpl, log: () => {} });
    const entries = await client.catalog(smithery);
    assert.equal(entries.length, 2);
    const search = entries.find((e) => e.id === 'acme/search');
    assert.equal(search?.transport, 'http');
    assert.equal(search?.endpoint, null); // deferred
    assert.equal(entries.find((e) => e.id === 'acme/local')?.transport, null);
    // resolve() does the second-hop fetch to fill the endpoint:
    const resolved = await client.resolve(smithery, 'acme/search');
    assert.equal(resolved.endpoint, 'https://server.smithery.ai/acme/search/mcp');
  });

  it('smithery: refuses a detail endpoint on an internal host', async () => {
    const list = { servers: [{ qualifiedName: 'acme/evil', displayName: 'Evil', remote: true }] };
    const detail = { connections: [{ type: 'http', deploymentUrl: 'https://10.0.0.1/mcp' }] };
    const fetchImpl: typeof fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      return new Response(JSON.stringify(url.includes('/servers/acme') ? detail : list), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const smithery = { ...REGISTRY, id: 'sm2', name: 'smithery', kind: 'smithery' as const };
    const client = new McpRegistryClient({ fetchImpl, log: () => {} });
    await assert.rejects(client.resolve(smithery, 'acme/evil'), /blocked_host|not_importable|refused/);
  });

  it('drops non-http(s) sourceUrl (no javascript: hrefs)', async () => {
    const doc = {
      servers: [
        { qualifiedName: 'acme/x', displayName: 'X', remote: true, homepage: 'javascript:alert(1)' },
      ],
    };
    const smithery = { ...REGISTRY, id: 'sm3', name: 'smithery', kind: 'smithery' as const };
    const client = new McpRegistryClient({ fetchImpl: fetchOk(doc), log: () => {} });
    const entries = await client.catalog(smithery);
    assert.equal(entries[0]?.sourceUrl, null);
  });

  it('resolve refuses a marketplace endpoint on a literal internal host', async () => {
    // Generic registry whose catalog entry carries an internal https remote —
    // the sync host block (via resolve's assertUntrustedEndpointSafe) refuses it.
    const doc = {
      servers: [{ name: 'io.x/internal', remotes: [{ type: 'http', url: 'https://192.168.0.5/mcp' }] }],
    };
    const client = new McpRegistryClient({ fetchImpl: fetchOk(doc), log: () => {} });
    const entries = await client.catalog(REGISTRY);
    // Internal remote never became an endpoint at normalize time (browse-only):
    assert.equal(entries[0]?.transport, null);
    assert.equal(entries[0]?.endpoint, null);
  });

  it('passes the query to the server-side search param (official=search, smithery=q)', async () => {
    const seen: string[] = [];
    const fetchImpl: typeof fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return fetchOk(OFFICIAL_DOC)(input);
    }) as typeof fetch;
    const official = { ...REGISTRY, id: 'of', kind: 'official' as const };
    const smithery = { ...REGISTRY, id: 'sm', kind: 'smithery' as const };
    const client = new McpRegistryClient({ fetchImpl, log: () => {} });
    await client.search(official, 'postgres');
    await client.search(smithery, 'postgres');
    assert.ok(seen.some((u) => u.includes('/v0/servers') && u.includes('search=postgres')), 'official uses ?search=');
    assert.ok(seen.some((u) => u.includes('/servers') && u.includes('q=postgres')), 'smithery uses ?q=');
  });

  it('resolves a searched entry that is not on the browsed first page (official)', async () => {
    // Browse page has only "a"; a search for "deep" returns "io.x/deep".
    const browse = { servers: [{ server: { name: 'io.x/a' } }] };
    const searchDoc = { servers: [{ server: { name: 'io.x/deep', remotes: [{ type: 'streamable-http', url: 'https://deep.example/mcp' }] } }] };
    const fetchImpl: typeof fetch = (async (input: RequestInfo | URL) => {
      const u = String(input);
      const body = u.includes('search=io.x') ? searchDoc : browse;
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const official = { ...REGISTRY, id: 'of2', kind: 'official' as const };
    const client = new McpRegistryClient({ fetchImpl, log: () => {} });
    // Not in browse cache, but resolve() looks it up by id server-side:
    const resolved = await client.resolve(official, 'io.x/deep');
    assert.equal(resolved.endpoint, 'https://deep.example/mcp');
  });

  it('falls back to a plain servers document at the base URL', async () => {
    const plainDoc = { servers: [{ name: 'simple', remotes: [{ type: 'sse', url: 'https://x/sse' }] }] };
    const fetchImpl: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/v0/servers')) return new Response('not found', { status: 404 });
      return fetchOk(plainDoc)(input, init);
    }) as typeof fetch;
    const client = new McpRegistryClient({ fetchImpl, log: () => {} });
    const entries = await client.catalog({ ...REGISTRY, id: 'reg-3' });
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.transport, 'sse');
    // Issue #541: an sse-only entry stays importable (the MCP removal window is
    // open) but is flagged so the operator sees what they are signing up for.
    assert.equal(entries[0]?.transportDeprecated, true);
  });

  // ── issue #541: deprecated-transport preference on the import path ─────────
  // The marketplace importer is the SECOND way an `sse` row can be minted (the
  // operator picker is the first), so the deprecation has to bite here too — a
  // UI-only change would keep importing legacy SSE servers from catalogs.
  describe('deprecated transport preference (#541)', () => {
    async function catalogOf(remotes: unknown[]) {
      const doc = { servers: [{ name: 'dual', remotes }] };
      const fetchImpl: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes('/v0/servers')) return new Response('nf', { status: 404 });
        return fetchOk(doc)(input, init);
      }) as typeof fetch;
      const client = new McpRegistryClient({ fetchImpl, log: () => {} });
      return (await client.catalog({ ...REGISTRY, id: 'reg-541' }))[0];
    }

    it('prefers the streamable-http remote when an entry offers sse too', async () => {
      const entry = await catalogOf([
        { type: 'sse', url: 'https://x.example/sse' },
        { type: 'streamable-http', url: 'https://x.example/mcp' },
      ]);
      assert.equal(entry?.transport, 'http');
      assert.equal(entry?.endpoint, 'https://x.example/mcp');
      assert.equal(entry?.transportDeprecated, false);
    });

    it('still imports an sse-only entry, flagged as deprecated', async () => {
      const entry = await catalogOf([{ type: 'sse', url: 'https://x.example/sse' }]);
      assert.equal(entry?.transport, 'sse');
      assert.equal(entry?.endpoint, 'https://x.example/sse');
      assert.equal(entry?.transportDeprecated, true);
    });

    it('does not let the preference bypass the untrusted-remote guard', async () => {
      // The only http remote is plain-http/internal → refused; the safe sse
      // remote is used instead rather than the preference smuggling it through.
      const entry = await catalogOf([
        { type: 'sse', url: 'https://x.example/sse' },
        { type: 'streamable-http', url: 'http://169.254.169.254/mcp' },
      ]);
      assert.equal(entry?.transport, 'sse');
      assert.equal(entry?.transportDeprecated, true);
    });

    it('marks a stdio entry as non-deprecated', async () => {
      const doc = { servers: [{ name: 'local', packages: [{ registry_name: 'npm', name: '@acme/x' }] }] };
      const fetchImpl: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes('/v0/servers')) return new Response('nf', { status: 404 });
        return fetchOk(doc)(input, init);
      }) as typeof fetch;
      const client = new McpRegistryClient({ fetchImpl, log: () => {} });
      const entry = (await client.catalog({ ...REGISTRY, id: 'reg-541b' }))[0];
      assert.equal(entry?.transport, 'stdio');
      assert.equal(entry?.transportDeprecated, false);
    });
  });

  // ── dead-host search latency ────────────────────────────────────────────
  // registry.modelcontextprotocol.io started black-holing packets, and the
  // marketplace search reacted by spending FOUR full timeouts on it: two
  // candidate URLs for the server-side search, then two more for the
  // local-filter fallback. At the 15s default that is a ~60s spinner with no
  // feedback, which reads as "search is broken" rather than "registry is down".
  describe('unreachable registry fails fast', () => {
    /** A host that never answers: every attempt rejects at the transport level. */
    function deadHost(counter: { n: number }): typeof fetch {
      return (async () => {
        counter.n += 1;
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch;
    }

    it('does not retry a dead official registry through the local-filter fallback', async () => {
      const calls = { n: 0 };
      const client = new McpRegistryClient({ fetchImpl: deadHost(calls), log: () => {} });
      const official = { ...REGISTRY, id: 'dead-official', kind: 'official' as const };
      await assert.rejects(
        client.search(official, 'strava'),
        (err: unknown) => err instanceof McpRegistryError && err.code === 'transport_failed',
      );
      // One attempt: the /v0/servers search URL. The bare base URL is not a
      // catalog endpoint for a typed `official` registry, and the local-filter
      // fallback must not re-run against the same dead host.
      assert.equal(calls.n, 1);
    });

    it('keeps the base-URL candidate for a generic registry', async () => {
      const calls = { n: 0 };
      const client = new McpRegistryClient({ fetchImpl: deadHost(calls), log: () => {} });
      await assert.rejects(client.catalog({ ...REGISTRY, id: 'dead-generic' }));
      // /v0/servers then the plain document at the base URL — the `generic`
      // shape genuinely lives at one of the two, so both are still probed.
      assert.equal(calls.n, 2);
    });

    it('reports an expired deadline as `timeout`, not a transport failure', async () => {
      const stalls: typeof fetch = (async (_input: unknown, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        })) as unknown as typeof fetch;
      const client = new McpRegistryClient({ fetchImpl: stalls, log: () => {}, timeoutMs: 20 });
      const official = { ...REGISTRY, id: 'slow-official', kind: 'official' as const };
      await assert.rejects(
        client.search(official, 'strava'),
        (err: unknown) => err instanceof McpRegistryError && err.code === 'timeout',
      );
    });

    // The fast-fail must key off TRANSPORT failure only. A registry that
    // answers 200 with a non-JSON body is answering — the local-filter
    // fallback is exactly the rescue path for it, and labelling it
    // "unreachable" would both skip that path and misinform the operator.
    it('still falls back to the local filter when the registry answers badly', async () => {
      let calls = 0;
      const answersHtml: typeof fetch = (async () => {
        calls += 1;
        return new Response('<!doctype html><html>nope</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }) as unknown as typeof fetch;
      const client = new McpRegistryClient({ fetchImpl: answersHtml, log: () => {} });
      const official = { ...REGISTRY, id: 'html-official', kind: 'official' as const };
      await assert.rejects(
        client.search(official, 'strava'),
        (err: unknown) => err instanceof McpRegistryError && err.code === 'bad_catalog_shape',
      );
      // Two attempts: the server-side search, then the local-filter fallback's
      // catalog() — NOT short-circuited after the first, because the host
      // answered.
      assert.equal(calls, 2);
    });

    it('does not re-dial a host that just refused, until an explicit refresh', async () => {
      const calls = { n: 0 };
      const client = new McpRegistryClient({ fetchImpl: deadHost(calls), log: () => {} });
      const official = { ...REGISTRY, id: 'sticky-dead', kind: 'official' as const };

      await assert.rejects(client.search(official, 'strava'));
      assert.equal(calls.n, 1);

      // An auto-loading UI re-entering the tab must not pay the timeout again.
      await assert.rejects(client.search(official, 'strava'));
      await assert.rejects(client.catalog(official));
      assert.equal(calls.n, 1);

      // The operator explicitly asking to retry does reach the host again.
      client.invalidate(official.id);
      await assert.rejects(client.search(official, 'strava'));
      assert.equal(calls.n, 2);
    });
  });
});
