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
    assert.equal(npm?.endpoint, 'npx -y @acme/notes-mcp');
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
