import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  CapabilityParseError,
  capabilitiesMatch,
  parseCapabilityRef,
} from '@omadia/plugin-api';

import {
  MissingCapabilityError,
  findCapabilityProvidersInCatalog,
  resolveCapabilities,
  resolveEligiblePlugins,
  walkCapabilityInstallChain,
} from '../src/plugins/capabilityResolver.js';
import type { PluginCatalog } from '../src/plugins/manifestLoader.js';
import { topoSortByDependsOn } from '../src/plugins/topoSort.js';
import type { InstalledAgent, InstalledRegistry } from '../src/plugins/installedRegistry.js';
import type { Plugin } from '../src/api/admin-v1.js';

/**
 * The resolver + topoSort are exercised with a hand-rolled fake catalog
 * rather than the real YAML-backed PluginCatalog. The surface we care about
 * here is strictly `catalog.list()` + `catalog.get(id).plugin.{provides,requires,depends_on}` —
 * no YAML parsing, no disk I/O, no activation.
 */

type Partial_Plugin = Pick<
  Plugin,
  'id' | 'provides' | 'requires' | 'depends_on'
> & {
  kind?: Plugin['kind'];
  name?: string;
};

function makeCatalog(plugins: Partial_Plugin[]): PluginCatalog {
  const map = new Map<string, { plugin: Plugin; manifest: unknown; source_path: string; source_kind: 'manifest-v1' }>();
  for (const p of plugins) {
    map.set(p.id, {
      plugin: {
        id: p.id,
        kind: p.kind ?? 'tool',
        name: p.name ?? p.id,
        version: '0.1.0',
        latest_version: '0.1.0',
        description: '',
        authors: [],
        license: 'proprietary',
        icon_url: null,
        categories: [],
        domain: 'test',
        compat_core: '>=1.0 <2.0',
        signed: false,
        signed_by: null,
        required_secrets: [],
        permissions_summary: {
          memory_reads: [],
          memory_writes: [],
          graph_reads: [],
          graph_writes: [],
          network_outbound: [],
        },
        integrations_summary: [],
        install_state: 'available',
        depends_on: p.depends_on,
        jobs: [],
        provides: p.provides,
        requires: p.requires,
      },
      manifest: {},
      source_path: `<test>/${p.id}.manifest.yaml`,
      source_kind: 'manifest-v1',
    });
  }
  // Cast to the public interface — we exercise `get(id)` and `list()`,
  // everything else would blow up at runtime and that's fine for test scope.
  return {
    get: (id: string) => map.get(id),
    list: () => Array.from(map.values()),
  } as unknown as PluginCatalog;
}

function makeRegistry(active: InstalledAgent[] = []): InstalledRegistry {
  const map = new Map<string, InstalledAgent>();
  for (const a of active) map.set(a.id, a);
  return {
    list: () => Array.from(map.values()),
    get: (id) => map.get(id),
    has: (id) => map.has(id),
    register: async (entry) => {
      map.set(entry.id, entry);
    },
    remove: async (id) => {
      map.delete(id);
    },
    markActivationFailed: async () => {
      /* no-op for tests */
    },
    markActivationSucceeded: async () => {
      /* no-op for tests */
    },
    updateConfig: async () => {
      /* no-op */
    },
    updateVersion: async () => {
      /* no-op */
    },
  };
}

function makeActiveAgent(id: string): InstalledAgent {
  return {
    id,
    installed_version: '0.1.0',
    installed_at: '2026-04-29T00:00:00Z',
    status: 'active',
    config: {},
  };
}

describe('parseCapabilityRef', () => {
  it('parses `<name>@<major>`', () => {
    assert.deepEqual(parseCapabilityRef('memory.kv@1'), {
      name: 'memory.kv',
      major: 1,
    });
  });

  it('parses `<name>@^<major>` identically (caret stripped)', () => {
    assert.deepEqual(parseCapabilityRef('memory.kv@^3'), {
      name: 'memory.kv',
      major: 3,
    });
  });

  it('trims whitespace', () => {
    assert.deepEqual(parseCapabilityRef('  foo@2  '), {
      name: 'foo',
      major: 2,
    });
  });

  it('rejects missing @', () => {
    assert.throws(() => parseCapabilityRef('noatsign'), CapabilityParseError);
  });

  it('rejects empty name', () => {
    assert.throws(() => parseCapabilityRef('@1'), CapabilityParseError);
  });

  it('rejects empty version', () => {
    assert.throws(() => parseCapabilityRef('foo@'), CapabilityParseError);
  });

  it('rejects non-integer major', () => {
    assert.throws(() => parseCapabilityRef('foo@1.2'), CapabilityParseError);
    assert.throws(() => parseCapabilityRef('foo@abc'), CapabilityParseError);
  });

  it('rejects negative major', () => {
    assert.throws(() => parseCapabilityRef('foo@-1'), CapabilityParseError);
  });

  it('rejects empty string', () => {
    assert.throws(() => parseCapabilityRef(''), CapabilityParseError);
  });
});

describe('capabilitiesMatch', () => {
  it('matches on same name + same major', () => {
    assert.equal(
      capabilitiesMatch(
        { name: 'memory.kv', major: 1 },
        { name: 'memory.kv', major: 1 },
      ),
      true,
    );
  });

  it('rejects different name', () => {
    assert.equal(
      capabilitiesMatch(
        { name: 'memory.kv', major: 1 },
        { name: 'graph.kv', major: 1 },
      ),
      false,
    );
  });

  it('rejects different major', () => {
    assert.equal(
      capabilitiesMatch(
        { name: 'memory.kv', major: 1 },
        { name: 'memory.kv', major: 2 },
      ),
      false,
    );
  });
});

describe('resolveCapabilities (single-pass, soft-fail)', () => {
  it('returns an empty result when nothing requires anything', () => {
    const cat = makeCatalog([
      { id: 'a', provides: ['foo@1'], requires: [], depends_on: [] },
    ]);
    assert.deepEqual(resolveCapabilities(['a'], cat), {
      edges: [],
      unresolved: [],
    });
  });

  it('resolves a requires to a provides, returning an edge provider → consumer', () => {
    const cat = makeCatalog([
      { id: 'provider', provides: ['memoryStore@1'], requires: [], depends_on: [] },
      { id: 'consumer', provides: [], requires: ['memoryStore@^1'], depends_on: [] },
    ]);
    const result = resolveCapabilities(['provider', 'consumer'], cat);
    assert.deepEqual(result.edges, [{ from: 'provider', to: 'consumer' }]);
    assert.deepEqual(result.unresolved, []);
  });

  it('returns the consumer in `unresolved` when no provider exists (no throw)', () => {
    const cat = makeCatalog([
      { id: 'consumer', provides: [], requires: ['memoryStore@^1'], depends_on: [] },
    ]);
    const result = resolveCapabilities(['consumer'], cat);
    assert.deepEqual(result.edges, []);
    assert.equal(result.unresolved.length, 1);
    assert.equal(result.unresolved[0]?.consumerId, 'consumer');
    assert.deepEqual(result.unresolved[0]?.requires, ['memoryStore@^1']);
  });

  it('returns unresolved when major mismatches (provides@1, requires@^2)', () => {
    const cat = makeCatalog([
      { id: 'provider', provides: ['memoryStore@1'], requires: [], depends_on: [] },
      { id: 'consumer', provides: [], requires: ['memoryStore@^2'], depends_on: [] },
    ]);
    const result = resolveCapabilities(['provider', 'consumer'], cat);
    assert.deepEqual(result.unresolved, [
      { consumerId: 'consumer', requires: ['memoryStore@^2'] },
    ]);
  });

  it('throws when two plugins provide the same capability (collision)', () => {
    const cat = makeCatalog([
      { id: 'p1', provides: ['memoryStore@1'], requires: [], depends_on: [] },
      { id: 'p2', provides: ['memoryStore@1'], requires: [], depends_on: [] },
    ]);
    assert.throws(
      () => resolveCapabilities(['p1', 'p2'], cat),
      /provided by both/,
    );
  });

  it('allows a plugin to self-require its own provides (no edge generated, no unresolved)', () => {
    const cat = makeCatalog([
      { id: 'self', provides: ['x@1'], requires: ['x@^1'], depends_on: [] },
    ]);
    assert.deepEqual(resolveCapabilities(['self'], cat), {
      edges: [],
      unresolved: [],
    });
  });

  it('aggregates multiple unresolved requires per consumer', () => {
    const cat = makeCatalog([
      {
        id: 'consumer',
        provides: [],
        requires: ['a@^1', 'b@^1'],
        depends_on: [],
      },
    ]);
    const result = resolveCapabilities(['consumer'], cat);
    assert.equal(result.unresolved.length, 1);
    assert.deepEqual(result.unresolved[0]?.requires, ['a@^1', 'b@^1']);
  });
});

describe('resolveEligiblePlugins (iterative cascade)', () => {
  it('drops cascading consumers when their provider was dropped first', () => {
    // chain: A requires capX; only provider is B; B requires capY which has no provider.
    // Pass 1: B unresolved (capY has no provider). A still resolved (capX → B).
    // After dropping B, pass 2: A unresolved (capX no longer has provider in eligible).
    const cat = makeCatalog([
      { id: 'A', provides: [], requires: ['capX@^1'], depends_on: [] },
      { id: 'B', provides: ['capX@1'], requires: ['capY@^1'], depends_on: [] },
    ]);
    const result = resolveEligiblePlugins(['A', 'B'], cat);
    assert.deepEqual(result.resolved, []);
    assert.equal(result.unresolved.length, 2);
    const byId = new Map(
      result.unresolved.map((u) => [u.consumerId, u.requires]),
    );
    assert.deepEqual(byId.get('B'), ['capY@^1']);
    assert.deepEqual(byId.get('A'), ['capX@^1']);
  });

  it('keeps fully-resolvable plugins and drops only the broken branch', () => {
    const cat = makeCatalog([
      { id: 'good-provider', provides: ['x@1'], requires: [], depends_on: [] },
      { id: 'good-consumer', provides: [], requires: ['x@^1'], depends_on: [] },
      { id: 'broken', provides: [], requires: ['missing@^1'], depends_on: [] },
    ]);
    const result = resolveEligiblePlugins(
      ['good-provider', 'good-consumer', 'broken'],
      cat,
    );
    assert.deepEqual(result.resolved, ['good-provider', 'good-consumer']);
    assert.equal(result.unresolved.length, 1);
    assert.equal(result.unresolved[0]?.consumerId, 'broken');
    assert.deepEqual(result.edges, [
      { from: 'good-provider', to: 'good-consumer' },
    ]);
  });

  it('returns empty unresolved when everything resolves', () => {
    const cat = makeCatalog([
      { id: 'p', provides: ['x@1'], requires: [], depends_on: [] },
      { id: 'c', provides: [], requires: ['x@^1'], depends_on: [] },
    ]);
    const result = resolveEligiblePlugins(['p', 'c'], cat);
    assert.deepEqual(result.resolved, ['p', 'c']);
    assert.deepEqual(result.unresolved, []);
  });
});

describe('topoSortByDependsOn with capability edges', () => {
  it('orders provider before consumer via extraEdges', () => {
    const cat = makeCatalog([
      { id: 'consumer', provides: [], requires: ['memoryStore@^1'], depends_on: [] },
      { id: 'provider', provides: ['memoryStore@1'], requires: [], depends_on: [] },
    ]);
    const result = resolveCapabilities(['consumer', 'provider'], cat);
    // Input order deliberately puts consumer first — capability edge must
    // still make provider come out first.
    const sorted = topoSortByDependsOn(
      ['consumer', 'provider'],
      cat,
      result.edges,
    );
    assert.deepEqual(sorted, ['provider', 'consumer']);
  });

  it('surfaces a capability-induced cycle as a "plugin dependency cycle" error', () => {
    // A depends_on B (explicit), B requires cap@1 which A provides (implicit).
    const cat = makeCatalog([
      { id: 'A', provides: ['cap@1'], requires: [], depends_on: ['B'] },
      { id: 'B', provides: [], requires: ['cap@^1'], depends_on: [] },
    ]);
    const result = resolveCapabilities(['A', 'B'], cat);
    assert.throws(
      () => topoSortByDependsOn(['A', 'B'], cat, result.edges),
      /plugin dependency cycle/,
    );
  });

  it('is order-stable when no capability edges apply', () => {
    const cat = makeCatalog([
      { id: 'x', provides: [], requires: [], depends_on: [] },
      { id: 'y', provides: [], requires: [], depends_on: [] },
      { id: 'z', provides: [], requires: [], depends_on: [] },
    ]);
    const sorted = topoSortByDependsOn(['x', 'y', 'z'], cat, []);
    assert.deepEqual(sorted, ['x', 'y', 'z']);
  });
});

describe('findCapabilityProvidersInCatalog', () => {
  it('returns every catalog plugin matching name + major', () => {
    const cat = makeCatalog([
      { id: 'p1', provides: ['kg@1', 'extra@1'], requires: [], depends_on: [] },
      { id: 'p2', provides: ['kg@1'], requires: [], depends_on: [] },
      { id: 'p3', provides: ['kg@2'], requires: [], depends_on: [] },
      { id: 'p4', provides: ['other@1'], requires: [], depends_on: [] },
    ]);
    const matches = findCapabilityProvidersInCatalog(cat, {
      name: 'kg',
      major: 1,
    });
    const ids = matches.map((m) => m.plugin.id).sort();
    assert.deepEqual(ids, ['p1', 'p2']);
  });

  it('returns empty list when no provider exists', () => {
    const cat = makeCatalog([
      { id: 'p', provides: ['other@1'], requires: [], depends_on: [] },
    ]);
    const matches = findCapabilityProvidersInCatalog(cat, {
      name: 'missing',
      major: 1,
    });
    assert.deepEqual(matches, []);
  });
});

describe('walkCapabilityInstallChain', () => {
  it('returns empty when target plugin needs nothing', () => {
    const cat = makeCatalog([
      { id: 'standalone', provides: [], requires: [], depends_on: [] },
    ]);
    const result = walkCapabilityInstallChain('standalone', cat, makeRegistry());
    assert.deepEqual(result.unresolved_requires, []);
    assert.deepEqual(result.available_providers, []);
  });

  it('skips capabilities already covered by an active provider', () => {
    const cat = makeCatalog([
      { id: 'provider', provides: ['kg@1'], requires: [], depends_on: [] },
      { id: 'consumer', provides: [], requires: ['kg@^1'], depends_on: [] },
    ]);
    const reg = makeRegistry([makeActiveAgent('provider')]);
    const result = walkCapabilityInstallChain('consumer', cat, reg);
    assert.deepEqual(result.unresolved_requires, []);
  });

  it('reports unresolved requires with all catalog candidates', () => {
    const cat = makeCatalog([
      { id: 'kg-inmemory', provides: ['kg@1'], requires: [], depends_on: [] },
      { id: 'kg-neon', provides: ['kg@1'], requires: [], depends_on: [] },
      { id: 'consumer', provides: [], requires: ['kg@^1'], depends_on: [] },
    ]);
    const result = walkCapabilityInstallChain(
      'consumer',
      cat,
      makeRegistry(),
    );
    assert.deepEqual(result.unresolved_requires, ['kg@^1']);
    assert.equal(result.available_providers.length, 1);
    const entry = result.available_providers[0];
    assert.equal(entry?.capability, 'kg@^1');
    const ids = entry?.providers.map((p) => p.id) ?? [];
    assert.deepEqual(ids, ['kg-inmemory', 'kg-neon']);
    assert.equal(entry?.providers[0]?.already_installed, false);
    assert.equal(entry?.providers[0]?.active, false);
  });

  it('walks transitively and orders deepest pre-reqs first', () => {
    // confluence requires kg; only kg-provider can supply kg, and
    // kg-provider itself requires embeddings. Wizard must install
    // embeddings → kg → confluence.
    const cat = makeCatalog([
      {
        id: 'embeddings',
        provides: ['embeddings@1'],
        requires: [],
        depends_on: [],
      },
      {
        id: 'kg-provider',
        provides: ['kg@1'],
        requires: ['embeddings@^1'],
        depends_on: [],
      },
      {
        id: 'confluence',
        provides: [],
        requires: ['kg@^1'],
        depends_on: [],
      },
    ]);
    const result = walkCapabilityInstallChain(
      'confluence',
      cat,
      makeRegistry(),
    );
    // Deepest first: embeddings before kg (depth 1 vs depth 0).
    assert.deepEqual(result.unresolved_requires, ['embeddings@^1', 'kg@^1']);
  });

  it('emits an entry with empty providers when the catalog has no candidate', () => {
    const cat = makeCatalog([
      {
        id: 'consumer',
        provides: [],
        requires: ['nonexistent@^1'],
        depends_on: [],
      },
    ]);
    const result = walkCapabilityInstallChain(
      'consumer',
      cat,
      makeRegistry(),
    );
    assert.deepEqual(result.unresolved_requires, ['nonexistent@^1']);
    assert.equal(result.available_providers[0]?.providers.length, 0);
  });

  it('marks already-installed (but inactive) providers as such', () => {
    const cat = makeCatalog([
      { id: 'provider', provides: ['kg@1'], requires: [], depends_on: [] },
      { id: 'consumer', provides: [], requires: ['kg@^1'], depends_on: [] },
    ]);
    const inactive: InstalledAgent = {
      ...makeActiveAgent('provider'),
      status: 'inactive',
    };
    const reg = makeRegistry([inactive]);
    const result = walkCapabilityInstallChain('consumer', cat, reg);
    // Inactive provider does NOT cover the cap → still unresolved.
    assert.deepEqual(result.unresolved_requires, ['kg@^1']);
    const provider = result.available_providers[0]?.providers[0];
    assert.equal(provider?.already_installed, true);
    assert.equal(provider?.active, false);
  });
});

describe('MissingCapabilityError', () => {
  it('exposes consumerId + capability fields for install-time callers', () => {
    const err = new MissingCapabilityError('consumer-id', 'cap@^1');
    assert.equal(err.consumerId, 'consumer-id');
    assert.equal(err.capability, 'cap@^1');
    assert.ok(err.message.includes('cap@^1'));
    assert.equal(err.name, 'MissingCapabilityError');
  });
});
