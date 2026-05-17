import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { DynamicChannelPluginResolver } from '../src/channels/dynamicChannelResolver.js';

/**
 * Cache-invalidation regression coverage for the plugin-upgrade flow.
 *
 * Bug observed 2026-05-15 on Fly: uploading channel-teams 0.2.0 over the
 * already-cached 0.1.3 module hit DynamicChannelPluginResolver's
 * agentId-keyed cache and silently re-activated the OLD module. Only a
 * `fly machine restart` cleared the cache.
 *
 * Fix: ChannelPluginResolver.invalidate(agentId) opt-in method, called
 * from ChannelRegistry.deactivate. The resolver drops its own cache AND
 * rotates a per-agent ESM cache-bust token so the next dynamic-import
 * resolves to a unique URL Node has not seen before.
 *
 * Test scope: we assert the resolver-level contract only — caching on
 * repeat resolve, identity change after invalidate, and idempotency.
 * The full ESM-bust handshake (?v=... query routing to a fresh module)
 * is verified end-to-end against the production Node runtime, not in
 * this suite: tsx's loader, used as our test runner, ignores file://
 * cache-bust query strings, so a v1→v2 swap test would pass in prod
 * but fail here for reasons unrelated to the fix.
 */

function writePluginEntry(packageRoot: string, marker: string): void {
  const distDir = join(packageRoot, 'dist');
  mkdirSync(distDir, { recursive: true });
  writeFileSync(
    join(distDir, 'plugin.js'),
    `export async function activate() {
       return { marker: ${JSON.stringify(marker)}, close: async () => {} };
     }
    `,
  );
}

function makeResolver(
  agentId: string,
  pkgDir: string,
): {
  resolver: DynamicChannelPluginResolver;
  getCalls: () => number;
} {
  let callCount = 0;
  const resolver = new DynamicChannelPluginResolver({
    catalog: {
      get: (id) => {
        if (id !== agentId) return undefined;
        callCount += 1;
        return {
          plugin: { id: agentId, kind: 'channel' },
          manifest: {},
          packageRoot: pkgDir,
        };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    uploadedStore: {
      get: () => ({ path: pkgDir, version: '1.0.0' }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  });
  return { resolver, getCalls: () => callCount };
}

describe('DynamicChannelPluginResolver.invalidate', () => {
  it('caches the resolved plugin: second resolve does not re-consult catalog', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dynchan-cache-'));
    try {
      const agentId = '@test/channel-cache-probe';
      const pkgDir = join(root, 'pkg');
      writePluginEntry(pkgDir, 'v1');
      const { resolver, getCalls } = makeResolver(agentId, pkgDir);

      const first = await resolver.resolve(agentId);
      assert.ok(first, 'resolver returned an impl');
      assert.equal(getCalls(), 1, 'first resolve hits the catalog once');

      const second = await resolver.resolve(agentId);
      assert.equal(second, first, 'cached resolve returns the same instance');
      assert.equal(getCalls(), 1, 'second resolve serves from cache (no catalog call)');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('invalidate clears the resolver cache: next resolve re-consults catalog', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dynchan-cache-'));
    try {
      const agentId = '@test/channel-cache-probe';
      const pkgDir = join(root, 'pkg');
      writePluginEntry(pkgDir, 'v1');
      const { resolver, getCalls } = makeResolver(agentId, pkgDir);

      await resolver.resolve(agentId);
      assert.equal(getCalls(), 1);

      resolver.invalidate(agentId);
      await resolver.resolve(agentId);
      assert.equal(
        getCalls(),
        2,
        'after invalidate the next resolve must re-consult the catalog (cache cleared)',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('invalidate on a never-cached agentId is a no-op', () => {
    const resolver = new DynamicChannelPluginResolver({
      catalog: { get: () => undefined } as never,
      uploadedStore: { get: () => undefined } as never,
    });
    resolver.invalidate('@test/never-cached');
    resolver.invalidate('@test/never-cached'); // idempotent
  });

  it('repeat invalidate rotates the per-agent bust token (best-effort observable)', async () => {
    // The bust token is private state, so we can only observe it via the
    // import URL the resolver constructs. Smoke that test by spying on
    // catalog.get-after-invalidate: each invalidate followed by a resolve
    // must trigger another catalog lookup.
    const root = mkdtempSync(join(tmpdir(), 'dynchan-cache-'));
    try {
      const agentId = '@test/channel-cache-probe';
      const pkgDir = join(root, 'pkg');
      writePluginEntry(pkgDir, 'v1');
      const { resolver, getCalls } = makeResolver(agentId, pkgDir);

      await resolver.resolve(agentId);
      resolver.invalidate(agentId);
      await resolver.resolve(agentId);
      resolver.invalidate(agentId);
      await resolver.resolve(agentId);
      assert.equal(
        getCalls(),
        3,
        'three resolves bracketing two invalidate calls all hit the catalog',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
