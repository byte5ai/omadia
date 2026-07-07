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
  });
});
