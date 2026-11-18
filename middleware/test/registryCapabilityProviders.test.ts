import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { RegistryPluginEntry } from '../src/api/registry-v1.js';
import type { InstallChainResolution } from '../src/plugins/capabilityResolver.js';
import type { InstalledAgent } from '../src/plugins/installedRegistry.js';
import { addRegistryCapabilityProviders } from '../src/plugins/registryCapabilityProviders.js';

/**
 * #1463 — with `integration-odoo` 0.2.0 installed (`provides: []`), the local
 * catalog has no provider for `odoo.client@^1`; the Hub's 0.2.1 has. The
 * missing-capability answer must say "update", not "upload".
 */
function hubEntry(
  id: string,
  versions: Array<{ version: string; provides?: string[]; compat_core?: string }>,
): RegistryPluginEntry {
  return {
    id,
    name: id === '@omadia/integration-odoo' ? 'Odoo Connector' : id,
    kind: 'integration',
    domain: 'test',
    description: '',
    categories: [],
    authors: [],
    license: 'MIT',
    icon_url: null,
    latest_version: versions[versions.length - 1]!.version,
    versions: versions.map((v) => ({
      version: v.version,
      compat_core: v.compat_core ?? '>=1.0 <2.0',
      sha256: 'a'.repeat(64),
      size_bytes: 1,
      download_url: 'https://hub.example/x.zip',
      published_at: '2026-10-01T00:00:00Z',
      manifest_summary: { provides: v.provides ?? [] },
    })),
  } as RegistryPluginEntry;
}

const HUB = [
  hubEntry('@omadia/integration-odoo', [
    { version: '0.2.0' },
    { version: '0.2.1', provides: ['odoo.client@1', 'odoo.agentToolkit.hr@1'] },
  ]),
  hubEntry('@acme/other', [{ version: '1.0.0', provides: ['unrelated@1'] }]),
];

function chain(...capabilities: string[]): InstallChainResolution {
  return {
    unresolved_requires: capabilities,
    available_providers: capabilities.map((capability) => ({ capability, providers: [] })),
  };
}

function registryWith(entries: Array<Partial<InstalledAgent> & { id: string }>) {
  const map = new Map(entries.map((e) => [e.id, e as InstalledAgent]));
  return { get: (id: string) => map.get(id) };
}

const installedOdoo = {
  id: '@omadia/integration-odoo',
  installed_version: '0.2.0',
  installed_at: '2026-10-01T00:00:00Z',
  status: 'errored' as const,
  config: {},
};

describe('#1463 — addRegistryCapabilityProviders', () => {
  it('offers the Hub update of an installed, outdated provider', async () => {
    const out = await addRegistryCapabilityProviders(chain('odoo.client@^1'), {
      listRegistryPlugins: async () => HUB,
      registry: registryWith([installedOdoo]),
    });
    assert.deepEqual(out.available_providers[0]!.providers, [
      {
        id: '@omadia/integration-odoo',
        name: 'Odoo Connector',
        kind: 'integration',
        version: '0.2.1',
        install_state: 'update-available',
        already_installed: true,
        active: false,
        source: 'registry',
        update_from: '0.2.0',
      },
    ]);
  });

  it('offers a plain Hub install when the provider is not installed', async () => {
    const out = await addRegistryCapabilityProviders(chain('odoo.agentToolkit.hr@^1'), {
      listRegistryPlugins: async () => HUB,
      registry: registryWith([]),
    });
    const [ref] = out.available_providers[0]!.providers;
    assert.equal(ref?.source, 'registry');
    assert.equal(ref?.already_installed, false);
    assert.equal(ref?.update_from, undefined);
  });

  it('skips a Hub latest that is not newer than the installed one, or that this core refuses', async () => {
    const current = await addRegistryCapabilityProviders(chain('odoo.client@^1'), {
      listRegistryPlugins: async () => HUB,
      registry: registryWith([{ ...installedOdoo, installed_version: '0.2.1' }]),
    });
    assert.deepEqual(current.available_providers[0]!.providers, []);

    const refused = await addRegistryCapabilityProviders(chain('odoo.client@^1'), {
      listRegistryPlugins: async () => [
        hubEntry('@omadia/integration-odoo', [
          { version: '0.2.1', provides: ['odoo.client@1'], compat_core: '>=9.0' },
        ]),
      ],
      registry: registryWith([installedOdoo]),
    });
    assert.deepEqual(refused.available_providers[0]!.providers, []);
  });

  it('leaves capabilities with catalog providers alone and survives an unreachable Hub', async () => {
    const withCatalog: InstallChainResolution = {
      unresolved_requires: ['odoo.client@^1'],
      available_providers: [
        {
          capability: 'odoo.client@^1',
          providers: [
            {
              id: 'local',
              name: 'Local',
              kind: 'integration',
              version: '1.0.0',
              install_state: 'available',
              already_installed: false,
              active: false,
            },
          ],
        },
      ],
    };
    let listed = false;
    const same = await addRegistryCapabilityProviders(withCatalog, {
      listRegistryPlugins: async () => {
        listed = true;
        return HUB;
      },
      registry: registryWith([]),
    });
    assert.equal(same, withCatalog);
    assert.equal(listed, false, 'no Hub round-trip when nothing is missing');

    const logs: string[] = [];
    const down = chain('odoo.client@^1');
    const out = await addRegistryCapabilityProviders(down, {
      listRegistryPlugins: () => Promise.reject(new Error('hub down')),
      registry: registryWith([]),
      log: (m) => logs.push(m),
    });
    assert.equal(out, down);
    assert.match(logs[0] ?? '', /hub down/);
  });
});
