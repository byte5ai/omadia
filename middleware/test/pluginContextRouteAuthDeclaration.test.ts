/**
 * Epic #470 C6 / G2 — the register-time gate on opting a route OUT of the
 * kernel session gate.
 *
 * `ctx.routes.register(prefix, router, { auth: 'public' | 'custom' })` is the
 * only way a plugin can ask for a route the kernel does not authenticate. This
 * suite pins the constraint that makes that safe: the prefix must lie beneath
 * a path the plugin declared in `permissions.public_paths` — the same list the
 * operator saw in the install dialog and consented to (or did not) via C4/H1.
 *
 * The gate lives here, in the context, rather than in `PluginRouteRegistry`,
 * because this is the only layer that knows which manifest the caller is. The
 * registry stays a generic Express concern.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { Router } from 'express';

import type { Plugin } from '../src/api/admin-v1.js';
import type {
  PluginCatalog,
  PluginCatalogEntry,
} from '../src/plugins/manifestLoader.js';
import { ServiceRegistry } from '../src/platform/serviceRegistry.js';
import { createPluginContext } from '../src/platform/pluginContext.js';

type CtxOpts = Parameters<typeof createPluginContext>[0];

interface Registered {
  prefix: string;
  source: string;
  options: unknown;
}

function makeRouteRegistry(sink: Registered[]) {
  return {
    register(prefix: string, _router: unknown, source: string, options?: unknown) {
      sink.push({ prefix, source, options });
      return () => undefined;
    },
    list: () => [],
    disposeBySource: () => 0,
  } as unknown as CtxOpts['routeRegistry'];
}

function makeStubs() {
  const vault = {
    get: async () => undefined,
    listKeys: async () => [],
  } as unknown as CtxOpts['vault'];
  const registry = {
    has: () => true,
    list: () => [],
    get: () => undefined,
  } as unknown as CtxOpts['registry'];
  const nativeToolRegistry = {
    register: () => () => {},
    registerHandler: () => () => {},
  } as unknown as CtxOpts['nativeToolRegistry'];
  const jobScheduler = {
    register: () => () => {},
    stopForPlugin: () => {},
  } as unknown as CtxOpts['jobScheduler'];
  return { vault, registry, nativeToolRegistry, jobScheduler };
}

function makeCatalog(id: string, publicPathDecls: readonly string[]): PluginCatalog {
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
      public_paths: publicPathDecls,
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

function makeCtx(publicPathDecls: readonly string[]) {
  const id = 'acme';
  const s = makeStubs();
  const seen: Registered[] = [];
  const ctx = createPluginContext({
    agentId: id,
    vault: s.vault,
    registry: s.registry,
    catalog: makeCatalog(id, publicPathDecls),
    serviceRegistry: new ServiceRegistry(),
    nativeToolRegistry: s.nativeToolRegistry,
    routeRegistry: makeRouteRegistry(seen),
    jobScheduler: s.jobScheduler,
    logger: () => {},
  } as unknown as CtxOpts);
  return { ctx, seen };
}

const DECLARED = '/api/plugins/acme/hooks';

describe("#470 C6 / G2 — auth:'public' | 'custom' needs a declaration", () => {
  it("auth:'session' (the default) needs no declaration at all", () => {
    const { ctx, seen } = makeCtx([]);
    ctx.routes.register('/api/plugins/acme/admin', Router());
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.prefix, '/api/plugins/acme/admin');
  });

  it("auth:'custom' at a declared prefix registers, and forwards the options", () => {
    const { ctx, seen } = makeCtx([DECLARED]);
    ctx.routes.register(DECLARED, Router(), { auth: 'custom', body: 'raw' });
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0]?.options, { auth: 'custom', body: 'raw' });
  });

  it("auth:'public' at a declared prefix registers", () => {
    const { ctx, seen } = makeCtx([DECLARED]);
    ctx.routes.register(DECLARED, Router(), { auth: 'public' });
    assert.equal(seen.length, 1);
  });

  it("auth:'public' under a NON-declared prefix throws — nothing is registered", () => {
    const { ctx, seen } = makeCtx([]);
    assert.throws(
      () => ctx.routes.register('/api/plugins/acme/admin', Router(), { auth: 'public' }),
      /not covered by any permissions\.public_paths declaration/,
    );
    assert.equal(seen.length, 0, 'a rejected registration must not reach the registry');
  });

  it('names the declarations it did find, so the manifest bug is obvious', () => {
    const { ctx } = makeCtx([DECLARED]);
    assert.throws(
      () => ctx.routes.register('/api/plugins/acme/admin', Router(), { auth: 'custom' }),
      new RegExp(DECLARED.replace(/\//g, '\\/')),
    );
  });

  /**
   * THE DIRECTION OF THE CONTAINMENT CHECK.
   *
   * A declaration BENEATH the router must not make the router public. If it
   * did, declaring `/api/plugins/acme/hooks` would buy an unauthenticated
   * router at `/api/plugins/acme` — i.e. the plugin's whole admin surface,
   * from a declaration the operator read as "one webhook".
   */
  it('a declaration BENEATH the prefix does not make the prefix public', () => {
    const { ctx, seen } = makeCtx([DECLARED]);
    assert.throws(
      () => ctx.routes.register('/api/plugins/acme', Router(), { auth: 'custom' }),
      /not covered by any permissions\.public_paths declaration/,
    );
    assert.equal(seen.length, 0);
  });

  it('a sibling that merely shares a string prefix does not count as declared', () => {
    const { ctx } = makeCtx([DECLARED]);
    assert.throws(
      () =>
        ctx.routes.register('/api/plugins/acme/hooks-evil', Router(), {
          auth: 'custom',
        }),
      /not covered by any permissions\.public_paths declaration/,
    );
  });

  it('a deeper sub-prefix of a declaration IS covered', () => {
    const { ctx, seen } = makeCtx([DECLARED]);
    ctx.routes.register(`${DECLARED}/github`, Router(), { auth: 'custom' });
    assert.equal(seen.length, 1);
  });
});
