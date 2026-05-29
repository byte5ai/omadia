import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  resolveDependencyParents,
  type DependencyChainDeps,
} from '../src/plugins/dependencyChainResolver.js';
import type { Plugin, PluginKind } from '../src/api/admin-v1.js';
import type { PluginCatalog } from '../src/plugins/manifestLoader.js';
import type { InstalledRegistry } from '../src/plugins/installedRegistry.js';
import type { RegistryClient } from '../src/plugins/registryClient.js';
import type {
  PackageUploadService,
  IngestInput,
} from '../src/plugins/packageUploadService.js';

const SHA = 'a'.repeat(64);

function mkPlugin(
  id: string,
  depends_on: string[] = [],
  kind: PluginKind = 'integration',
): Plugin {
  return {
    id,
    kind,
    name: id,
    version: '1.0.0',
    latest_version: '1.0.0',
    description: '',
    authors: [],
    license: 'MIT',
    icon_url: null,
    categories: [],
    domain: 'x.y',
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
    depends_on,
    jobs: [],
    provides: [],
    requires: [],
    multi_instance: true,
    privacy_class: 'default',
  };
}

/**
 * Build a stateful test harness:
 *  - `local`   = id → depends_on for plugins already in the local catalog
 *  - `remote`  = id → depends_on for plugins available in the registry index
 *  - `installed` = ids currently in the installed-registry
 * The fake `ingest` ADDS the fetched plugin to the local catalog (with its
 * remote depends_on), so the resolver's transitive walk sees it post-ingest.
 */
function harness(opts: {
  local: Record<string, string[]>;
  remote?: Record<string, string[]>;
  installed?: string[];
}): {
  deps: DependencyChainDeps;
  fetched: string[];
  isLocal: (id: string) => boolean;
} {
  const present = new Map<string, string[]>(Object.entries(opts.local));
  const remoteMap = new Map<string, string[]>(Object.entries(opts.remote ?? {}));
  const installedSet = new Set<string>(opts.installed ?? []);
  const fetched: string[] = [];

  const catalog = {
    get: (id: string) =>
      present.has(id) ? { plugin: mkPlugin(id, present.get(id)!), manifest: {} } : undefined,
    list: () =>
      [...present].map(([id, d]) => ({ plugin: mkPlugin(id, d), manifest: {} })),
  } as unknown as PluginCatalog;

  const registry = {
    has: (id: string) => installedSet.has(id),
  } as unknown as InstalledRegistry;

  const client = {
    hasRegistries: () => remoteMap.size > 0,
    listAll: async () => ({
      plugins: [...remoteMap].map(([id, d]) => ({
        registry: 'pub',
        entry: {
          id,
          name: id,
          kind: 'integration' as PluginKind,
          domain: 'x.y',
          description: '',
          categories: [],
          authors: [],
          license: 'MIT',
          icon_url: null,
          latest_version: '1.0.0',
          versions: [
            {
              version: '1.0.0',
              compat_core: '>=1.0 <2.0',
              sha256: SHA,
              size_bytes: 1,
              download_url: `https://hub.test/dl/${encodeURIComponent(id)}.zip`,
              published_at: '',
              manifest_summary: { depends_on: d },
            },
          ],
        },
      })),
      errors: [],
    }),
    fetchPackage: async ({ downloadUrl }: { downloadUrl: string }) => {
      const id = decodeURIComponent(
        downloadUrl.replace('https://hub.test/dl/', '').replace('.zip', ''),
      );
      fetched.push(id);
      return { buffer: Buffer.from(id, 'utf8'), sha256: SHA };
    },
  } as unknown as RegistryClient;

  const packageUpload = {
    ingest: async (input: IngestInput) => {
      const id = input.fileBuffer.toString('utf8');
      present.set(id, remoteMap.get(id) ?? []);
      return { ok: true, plugin_id: id, version: '1.0.0', package: {} as never };
    },
  } as unknown as PackageUploadService;

  return {
    deps: { catalog, registry, client, packageUpload, log: () => {} },
    fetched,
    isLocal: (id) => present.has(id),
  };
}

const TEAMS = '@omadia/channel-teams';
const M365 = '@omadia/integration-microsoft365';

describe('resolveDependencyParents (C5)', () => {
  it('returns an empty chain when the target has no depends_on', async () => {
    const h = harness({ local: { [TEAMS]: [] }, remote: { [M365]: [] } });
    const { chain, unresolvable } = await resolveDependencyParents(TEAMS, h.deps);
    assert.deepEqual(chain.unresolved_requires, []);
    assert.deepEqual(chain.available_providers, []);
    assert.deepEqual(unresolvable, []);
    assert.deepEqual(h.fetched, [], 'no registry calls when nothing to resolve');
  });

  it('fetches + ingests a remote-only parent and returns it as a single-provider chain', async () => {
    const h = harness({ local: { [TEAMS]: [M365] }, remote: { [M365]: [] } });
    const { chain } = await resolveDependencyParents(TEAMS, h.deps);

    assert.deepEqual(chain.unresolved_requires, [M365]);
    assert.equal(chain.available_providers.length, 1);
    const entry = chain.available_providers[0]!;
    assert.equal(entry.capability, M365);
    assert.equal(entry.providers.length, 1);
    assert.equal(entry.providers[0]!.id, M365);
    assert.equal(entry.providers[0]!.already_installed, false);

    // the parent was actually pulled + ingested → now locally installable
    assert.deepEqual(h.fetched, [M365]);
    assert.ok(h.isLocal(M365), 'parent ingested into the catalog');
  });

  it('drops a parent that is already installed (gate satisfied)', async () => {
    const h = harness({
      local: { [TEAMS]: [M365], [M365]: [] },
      installed: [M365],
    });
    const { chain } = await resolveDependencyParents(TEAMS, h.deps);
    assert.deepEqual(chain.unresolved_requires, []);
    assert.deepEqual(h.fetched, [], 'installed parent needs no fetch');
  });

  it('resolves transitively, deepest parent first (topo order)', async () => {
    // A (local) → B (remote) → C (remote)
    const h = harness({
      local: { '@x/A': ['@x/B'] },
      remote: { '@x/B': ['@x/C'], '@x/C': [] },
    });
    const { chain } = await resolveDependencyParents('@x/A', h.deps);
    assert.deepEqual(chain.unresolved_requires, ['@x/C', '@x/B']);
    assert.deepEqual(h.fetched.sort(), ['@x/B', '@x/C']);
  });

  it('surfaces an unresolvable parent with empty providers', async () => {
    const h = harness({ local: { [TEAMS]: ['@x/ghost'] }, remote: {} });
    const { chain, unresolvable } = await resolveDependencyParents(TEAMS, h.deps);
    assert.deepEqual(chain.unresolved_requires, ['@x/ghost']);
    assert.equal(chain.available_providers[0]!.providers.length, 0);
    assert.deepEqual(unresolvable, ['@x/ghost']);
  });
});
