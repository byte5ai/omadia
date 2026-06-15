/**
 * Spec 004 Phase B (FR-B2..B5) — the `ctx.flows` accessor.
 *
 * Verifies gating (present only with `permissions.flows` AND a threaded
 * signing key + base URL), the `publicUrl` resolution (mirroring the
 * `/bot-api` → `/api` proxy by stripping a leading `/api`), and that
 * `signState`/`verifyState` round-trip while staying plugin-audience-bound
 * (a token minted by plugin A is rejected by plugin B).
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import crypto from 'node:crypto';

import type { Plugin } from '../src/api/admin-v1.js';
import type {
  PluginCatalog,
  PluginCatalogEntry,
} from '../src/plugins/manifestLoader.js';
import { ServiceRegistry } from '../src/platform/serviceRegistry.js';
import { createPluginContext } from '../src/platform/pluginContext.js';

const KEY = new Uint8Array(crypto.randomBytes(64));
const BASE = 'https://omadia.example.com';

function makeRouteRegistry() {
  const entries: { prefix: string; source: string; disposed: boolean }[] = [];
  return {
    register(prefix: string, _router: unknown, source: string) {
      const e = { prefix, source, disposed: false };
      entries.push(e);
      return () => {
        e.disposed = true;
      };
    },
    list: () => entries.map((e) => ({ ...e })),
    disposeBySource: () => 0,
  } as unknown as Parameters<typeof createPluginContext>[0]['routeRegistry'];
}

function makeStubs() {
  const vault = {
    get: async () => undefined,
    listKeys: async () => [],
  } as unknown as Parameters<typeof createPluginContext>[0]['vault'];
  const registry = {
    has: () => true,
    list: () => [],
    get: () => undefined,
  } as unknown as Parameters<typeof createPluginContext>[0]['registry'];
  const stubNativeToolRegistry = {
    register: () => () => {},
    registerHandler: () => () => {},
  } as unknown as Parameters<typeof createPluginContext>[0]['nativeToolRegistry'];
  const stubJobScheduler = {
    register: () => () => {},
    stopForPlugin: () => {},
  } as unknown as Parameters<typeof createPluginContext>[0]['jobScheduler'];
  return { vault, registry, stubNativeToolRegistry, stubJobScheduler };
}

function makeCatalog(id: string, flows: boolean): PluginCatalog {
  const plugin = {
    id,
    kind: 'integration',
    name: id,
    version: '0.1.0',
    domain: 'test',
    setup_fields: [],
    permissions_summary: {
      memory_reads: [],
      memory_writes: [],
      graph_reads: [],
      graph_writes: [],
      network_outbound: [],
      flows,
    },
    depends_on: [],
    provides: [],
    requires: [],
  } as unknown as Plugin;
  const entry = {
    plugin,
    manifest: {},
    source_path: `/abs/${id}/manifest.yaml`,
    source_kind: 'manifest-v1',
  } as unknown as PluginCatalogEntry;
  return {
    list: () => [entry],
    get: (q: string) => (q === id ? entry : undefined),
  } as unknown as PluginCatalog;
}

interface CtxOpts {
  flows?: boolean;
  key?: Uint8Array;
  base?: string;
  id?: string;
}

function makeCtx(o: CtxOpts = {}) {
  const id = o.id ?? 'caller';
  const s = makeStubs();
  const routeRegistry = makeRouteRegistry();
  const ctx = createPluginContext({
    agentId: id,
    vault: s.vault,
    registry: s.registry,
    catalog: makeCatalog(id, o.flows ?? true),
    serviceRegistry: new ServiceRegistry(),
    nativeToolRegistry: s.stubNativeToolRegistry,
    routeRegistry,
    jobScheduler: s.stubJobScheduler,
    flowSigningKey: o.key,
    flowPublicBaseUrl: o.base,
    logger: () => {},
  });
  return { ctx, routeRegistry };
}

describe('Spec 004 — ctx.flows gating', () => {
  it('is undefined when permissions.flows is false', () => {
    const { ctx } = makeCtx({ flows: false, key: KEY, base: BASE });
    assert.equal(ctx.flows, undefined);
  });

  it('is undefined when no signing key is threaded', () => {
    const { ctx } = makeCtx({ flows: true, base: BASE });
    assert.equal(ctx.flows, undefined);
  });

  it('is undefined when no public base URL is threaded', () => {
    const { ctx } = makeCtx({ flows: true, key: KEY });
    assert.equal(ctx.flows, undefined);
  });

  it('is present when declared AND fully wired', () => {
    const { ctx } = makeCtx({ flows: true, key: KEY, base: BASE });
    assert.equal(typeof ctx.flows?.publicUrl, 'function');
    assert.equal(typeof ctx.flows?.signState, 'function');
    assert.equal(typeof ctx.flows?.verifyState, 'function');
  });
});

describe('Spec 004 — ctx.flows.publicUrl', () => {
  it('strips a leading /api and routes through /bot-api', () => {
    const { ctx } = makeCtx({ flows: true, key: KEY, base: BASE });
    ctx.routes.register('/api/github', {} as unknown);
    assert.equal(
      ctx.flows!.publicUrl('flow/callback'),
      'https://omadia.example.com/bot-api/github/flow/callback',
    );
  });

  it('tolerates a leading slash on relPath', () => {
    const { ctx } = makeCtx({ flows: true, key: KEY, base: BASE });
    ctx.routes.register('/api/github', {} as unknown);
    assert.equal(
      ctx.flows!.publicUrl('/flow/callback'),
      'https://omadia.example.com/bot-api/github/flow/callback',
    );
  });

  it('trims a trailing slash on the base URL', () => {
    const { ctx } = makeCtx({ flows: true, key: KEY, base: `${BASE}/` });
    ctx.routes.register('/api/github', {} as unknown);
    assert.equal(
      ctx.flows!.publicUrl('flow/callback'),
      'https://omadia.example.com/bot-api/github/flow/callback',
    );
  });

  it('throws when no route is registered yet', () => {
    const { ctx } = makeCtx({ flows: true, key: KEY, base: BASE });
    assert.throws(() => ctx.flows!.publicUrl('flow/callback'), /no registered route/);
  });

  it('throws on ambiguity, resolves with opts.prefix', () => {
    const { ctx } = makeCtx({ flows: true, key: KEY, base: BASE });
    ctx.routes.register('/api/github/admin', {} as unknown);
    ctx.routes.register('/api/github/flow', {} as unknown);
    assert.throws(() => ctx.flows!.publicUrl('callback'), /multiple routes/);
    assert.equal(
      ctx.flows!.publicUrl('callback', { prefix: '/api/github/flow' }),
      'https://omadia.example.com/bot-api/github/flow/callback',
    );
  });
});

describe('Spec 004 — ctx.flows.signState/verifyState', () => {
  it('round-trips claims bound to the plugin', async () => {
    const { ctx } = makeCtx({ flows: true, key: KEY, base: BASE });
    const token = await ctx.flows!.signState({ org: 'acme' });
    const claims = await ctx.flows!.verifyState(token);
    assert.equal(claims['org'], 'acme');
    assert.equal(claims['aud'], 'plugin:caller');
  });

  it('rejects a token minted by another plugin (same key)', async () => {
    const a = makeCtx({ flows: true, key: KEY, base: BASE, id: 'plugin-a' });
    const b = makeCtx({ flows: true, key: KEY, base: BASE, id: 'plugin-b' });
    const token = await a.ctx.flows!.signState({ org: 'acme' });
    await assert.rejects(() => b.ctx.flows!.verifyState(token), /audience|aud/i);
  });
});
