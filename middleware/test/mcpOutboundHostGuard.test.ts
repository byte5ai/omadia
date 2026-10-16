import { afterEach, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { McpManager, type McpServerConfig, type McpServerRow } from '@omadia/orchestrator';

import {
  checkOperatorOutboundUrl,
  createMcpConnectGuard,
  isMcpEndpointRefusal,
  MCP_STDIO_DISABLED_MESSAGE,
  type OutboundLookupFn,
  unmapIpv4,
} from '../src/services/mcpOutboundHostGuard.js';
import { resetMcpGrantPolicyForTests } from '../src/services/mcpGrantPolicy.js';
import { rescanAllMcpServers } from '../src/services/mcpRescan.js';

/**
 * Issues #1341 / #1342 — the operator outbound host rule (shared by registry
 * URLs and manual MCP http/sse endpoints) and the McpManager connect guard
 * built on it. Link-local / cloud-metadata targets are refused; private and
 * loopback hosts stay allowed on purpose (intranet registries and servers).
 */

/** Lookup stub: a fixed answer table, everything else is NXDOMAIN. */
function lookupFrom(table: Record<string, string[]>): OutboundLookupFn {
  return (host) => {
    const addrs = table[host];
    if (!addrs) return Promise.reject(new Error(`getaddrinfo ENOTFOUND ${host}`));
    return Promise.resolve(addrs.map((address) => ({ address })));
  };
}

const NO_DNS = lookupFrom({});

describe('checkOperatorOutboundUrl', () => {
  for (const url of [
    'http://169.254.169.254/latest/meta-data',
    'http://[fe80::1]/catalog',
    'http://[::ffff:169.254.169.254]/',
    'http://metadata.google.internal/computeMetadata/v1',
    'http://metadata/',
    // IPv6 metadata endpoints and IPv4 carried inside IPv6 (security review).
    'http://[fd00:ec2::254]/latest/meta-data/',
    'http://[fd20:ce::254]/',
    'http://[::169.254.169.254]/',
    'http://[64:ff9b::a9fe:a9fe]/',
    'http://[::ffff:0:a9fe:a9fe]/',
    'http://[2002:a9fe:a9fe::]/',
  ]) {
    it(`refuses ${url} as blocked_host`, async () => {
      const refusal = await checkOperatorOutboundUrl(url, NO_DNS);
      assert.equal(refusal?.code, 'blocked_host');
      assert.match(refusal?.message ?? '', /refused/);
    });
  }

  it('keeps the exact pre-extraction messages', async () => {
    assert.deepEqual(await checkOperatorOutboundUrl('http://169.254.169.254/', NO_DNS), {
      code: 'blocked_host',
      message: 'link-local/metadata address refused: 169.254.169.254',
    });
    assert.deepEqual(await checkOperatorOutboundUrl('http://metadata.goog/', NO_DNS), {
      code: 'blocked_host',
      message: 'metadata hostname refused: metadata.goog',
    });
  });

  for (const url of [
    'http://postgres:5432/',
    'http://localhost:3000/',
    'http://127.0.0.1/',
    'http://10.0.0.5/',
    'http://192.168.1.20/mcp',
    'https://mcp.example.com/mcp',
  ]) {
    it(`allows ${url} (private/loopback stay reachable)`, async () => {
      const lookup = lookupFrom({
        postgres: ['172.18.0.3'],
        localhost: ['127.0.0.1', '::1'],
        '127.0.0.1': ['127.0.0.1'],
        '10.0.0.5': ['10.0.0.5'],
        '192.168.1.20': ['192.168.1.20'],
        'mcp.example.com': ['93.184.216.34'],
      });
      assert.equal(await checkOperatorOutboundUrl(url, lookup), null);
    });
  }

  it('refuses a hostname that resolves to a link-local address', async () => {
    const lookup = lookupFrom({ 'imds.attacker.example': ['10.0.0.1', '169.254.169.254'] });
    assert.deepEqual(await checkOperatorOutboundUrl('http://imds.attacker.example/', lookup), {
      code: 'blocked_host',
      message:
        'host "imds.attacker.example" resolves to a link-local/metadata address (169.254.169.254)',
    });
  });

  it('refuses a hostname that resolves to an IPv4-mapped link-local address', async () => {
    const lookup = lookupFrom({ 'v6.attacker.example': ['::ffff:169.254.10.1'] });
    const refusal = await checkOperatorOutboundUrl('http://v6.attacker.example/', lookup);
    assert.equal(refusal?.code, 'blocked_host');
  });

  it('unmaps both spellings of an IPv4-mapped address (URL normalizes to hex)', () => {
    assert.equal(new URL('http://[::ffff:169.254.169.254]/').hostname, '[::ffff:a9fe:a9fe]');
    assert.equal(unmapIpv4('[::ffff:a9fe:a9fe]'), '169.254.169.254');
    assert.equal(unmapIpv4('::ffff:169.254.169.254'), '169.254.169.254');
    assert.equal(unmapIpv4('::ffff:7f00:1'), '127.0.0.1');
    assert.equal(unmapIpv4('fe80::1'), 'fe80::1');
  });

  it('treats a DNS failure as no refusal (the fetch fails loudly on its own)', async () => {
    assert.equal(await checkOperatorOutboundUrl('http://does-not-resolve.invalid/', NO_DNS), null);
  });

  it('reports invalid_url for an unparseable URL or a non-http(s) scheme', async () => {
    assert.equal((await checkOperatorOutboundUrl('not a url', NO_DNS))?.code, 'invalid_url');
    assert.equal((await checkOperatorOutboundUrl('file:///etc/passwd', NO_DNS))?.code, 'invalid_url');
  });
});

function cfg(overrides: Partial<McpServerConfig>): McpServerConfig {
  return {
    id: '00000000-0000-4000-8000-0000000000a1',
    name: 'guarded',
    transport: 'http',
    endpoint: 'http://169.254.169.254/',
    ...overrides,
  };
}

/** Records every `fetch` the code under test makes and refuses all of them. */
function trapFetch(): { calls: string[]; restore(): void } {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = ((input: string | URL | Request) => {
    calls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return Promise.reject(new TypeError('fetch failed (trapped by test)'));
  }) as typeof fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

describe('createMcpConnectGuard + McpManager (connect-time guard)', () => {
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  it('refuses an http endpoint at 169.254.169.254 before any network attempt', async () => {
    const trap = trapFetch();
    restore = trap.restore;
    const mcp = new McpManager({ connectGuard: createMcpConnectGuard({ stdioEnabled: true }) });
    await assert.rejects(mcp.listTools(cfg({}), { fresh: true }), (err: unknown) => {
      assert.ok(isMcpEndpointRefusal(err));
      assert.equal(err.code, 'blocked_host');
      assert.equal(err.message, 'link-local/metadata address refused: 169.254.169.254');
      return true;
    });
    assert.deepEqual(trap.calls, []);
    // A rejected connect is not cached: the next attempt is refused afresh.
    assert.equal(mcp.poolSize, 0);
  });

  it('refuses an sse endpoint whose host resolves to link-local', async () => {
    const trap = trapFetch();
    restore = trap.restore;
    const mcp = new McpManager({
      connectGuard: createMcpConnectGuard({
        stdioEnabled: true,
        lookup: lookupFrom({ 'imds.attacker.example': ['169.254.169.254'] }),
      }),
    });
    await assert.rejects(
      mcp.listTools(cfg({ transport: 'sse', endpoint: 'http://imds.attacker.example/sse' })),
      (err: unknown) => isMcpEndpointRefusal(err) && err.code === 'blocked_host',
    );
    assert.deepEqual(trap.calls, []);
  });

  it('lets an allowed host through to the transport (the guard does not over-block)', async () => {
    const trap = trapFetch();
    restore = trap.restore;
    const mcp = new McpManager({
      connectGuard: createMcpConnectGuard({ stdioEnabled: true, lookup: NO_DNS }),
    });
    await assert.rejects(
      mcp.listTools(cfg({ endpoint: 'http://127.0.0.1:9/mcp' }), { fresh: true }),
      (err: unknown) => !isMcpEndpointRefusal(err),
    );
    assert.ok(trap.calls.length > 0, 'the transport must have tried to dial the allowed host');
  });

  it('refuses an existing stdio row while stdio is disabled, without spawning it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-stdio-guard-'));
    const marker = join(dir, 'spawned');
    try {
      const mcp = new McpManager({ connectGuard: createMcpConnectGuard({ stdioEnabled: false }) });
      const stdio = cfg({ transport: 'stdio', endpoint: `touch ${marker}` });
      await assert.rejects(mcp.listTools(stdio, { fresh: true }), (err: unknown) => {
        assert.ok(isMcpEndpointRefusal(err));
        assert.equal(err.code, 'stdio_disabled');
        assert.equal(err.message, MCP_STDIO_DISABLED_MESSAGE);
        return true;
      });
      // Give a (wrongly) spawned child time to create its marker.
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(existsSync(marker), false, 'no child process may be spawned');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('callTool returns the refusal and skips the auth-prompt fallback (no OAuth probe of the host)', async () => {
    const trap = trapFetch();
    restore = trap.restore;
    let authFailureCalls = 0;
    const audited: Array<{ outcome: string | undefined; error: string | null }> = [];
    const mcp = new McpManager({
      connectGuard: createMcpConnectGuard({ stdioEnabled: true }),
      onToolCall: (entry) => audited.push({ outcome: entry.outcome, error: entry.error }),
      auth: {
        getToken: () => Promise.resolve(null),
        onAuthFailure: () => {
          authFailureCalls += 1;
          return Promise.resolve('auth prompt');
        },
      },
    });
    const result = await mcp.callTool(cfg({}), 'anything', {});
    assert.equal(
      result,
      'Error: could not connect to MCP server "guarded": link-local/metadata address refused: 169.254.169.254',
    );
    assert.equal(authFailureCalls, 0);
    assert.deepEqual(trap.calls, []);
    assert.equal(audited.length, 1);
    assert.equal(audited[0]?.outcome, 'fail');
  });
});

describe('rescanAllMcpServers with a refusing guard', () => {
  afterEach(() => resetMcpGrantPolicyForTests());

  function row(id: string, name: string, endpoint: string): McpServerRow {
    return {
      id,
      name,
      transport: 'http',
      endpoint,
      headers: {},
      secretRef: null,
      status: 'enabled',
      lastDiscoveredAt: null,
      discoveredTools: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      source: 'manual',
      registryId: null,
      license: null,
      author: null,
      sourceUrl: null,
      privacyBypass: false,
      kgIngest: false,
      configSchema: [],
      config: {},
      delegation: 'service',
    };
  }

  it('records the refusal as a failure and keeps sweeping the other servers', async () => {
    const BLOCKED = '00000000-0000-4000-8000-0000000000b1';
    const GOOD = '00000000-0000-4000-8000-0000000000b2';
    const persisted: string[] = [];
    const graph = {
      listMcpServers: () =>
        Promise.resolve([
          row(BLOCKED, 'meta', 'http://169.254.169.254/'),
          row(GOOD, 'good', 'https://mcp.example.com/mcp'),
        ]),
      upsertMcpToolVerdict: () => Promise.resolve(),
      setMcpDiscoveredTools: (id: string) => {
        persisted.push(id);
        return Promise.resolve();
      },
      pruneMcpToolVerdicts: () => Promise.resolve(),
      bumpMcpGrantEpoch: () => Promise.resolve(0),
      bumpSkillBindingEpoch: () => Promise.resolve(0),
      listMcpToolVerdicts: () => Promise.resolve([]),
      listMcpToolVerdictAcks: () => Promise.resolve([]),
    };
    const guarded = new McpManager({ connectGuard: createMcpConnectGuard({ stdioEnabled: true }) });
    // The real guarded manager for the blocked row; a stub for the good one
    // (no live MCP server needed to prove the sweep continues).
    const manager: Pick<McpManager, 'listTools'> = {
      listTools: (c, opts) =>
        c.id === BLOCKED
          ? guarded.listTools(c, opts)
          : Promise.resolve([{ name: 'ping', description: 'ping' }]),
    };
    const result = await rescanAllMcpServers(graph as never, manager);
    assert.equal(result.scannedServers, 1);
    assert.deepEqual(persisted, [GOOD]);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0]?.serverId, BLOCKED);
    assert.match(
      result.failures[0]?.error ?? '',
      /McpEndpointRefusedError: link-local\/metadata address refused: 169\.254\.169\.254/,
    );
  });
});

describe('IPv6 literals (security review)', () => {
  it('resolves an IPv6 literal without its brackets', async () => {
    const asked: string[] = [];
    await checkOperatorOutboundUrl('http://[2001:db8::1]/', (host) => {
      asked.push(host);
      return Promise.resolve([{ address: host }]);
    });
    assert.deepEqual(asked, ['2001:db8::1']);
  });

  it('decodes the IPv4 inside every IPv6 embedding', () => {
    assert.equal(unmapIpv4('[::a9fe:a9fe]'), '169.254.169.254');
    assert.equal(unmapIpv4('64:ff9b::a9fe:a9fe'), '169.254.169.254');
    assert.equal(unmapIpv4('::ffff:0:a9fe:a9fe'), '169.254.169.254');
    assert.equal(unmapIpv4('2002:a9fe:a9fe::1'), '169.254.169.254');
    assert.equal(unmapIpv4('::1'), '::1');
    assert.equal(unmapIpv4('::'), '::');
    assert.equal(unmapIpv4('2001:db8::1'), '2001:db8::1');
  });

  it('still allows private and loopback IPv6', async () => {
    for (const url of ['http://[::1]/', 'http://[fd12:3456::1]/']) {
      assert.equal(await checkOperatorOutboundUrl(url, NO_DNS), null, url);
    }
  });
});
