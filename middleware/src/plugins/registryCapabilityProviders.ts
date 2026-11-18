import { parseCapabilityRef } from '@omadia/plugin-api';

import type { RegistryPluginEntry } from '../api/registry-v1.js';
import type {
  CapabilityProviderRef,
  InstallChainResolution,
} from './capabilityResolver.js';
import { checkCoreCompat } from './coreCompat.js';
import type { InstalledRegistry } from './installedRegistry.js';
import { versionDirection } from './versionDirection.js';

/**
 * #1463 — name a Hub provider when the local catalog has none.
 *
 * `walkCapabilityInstallChain` only searches the local catalog, which holds ONE
 * version per plugin id: the installed one. With an outdated parent installed
 * (`integration-odoo` 0.2.0, `provides: []`), a consumer's requires came back
 * with no provider at all, and the wizard told the operator to upload one —
 * while the Hub's newer version of that very parent provides the capability.
 *
 * For each capability the catalog cannot provide, this looks at the latest Hub
 * version of every listed plugin (`manifest_summary.provides`) and adds it as a
 * `source: 'registry'` candidate: `update_from` set when that plugin is
 * installed at an older version ("update Odoo Connector 0.2.0 → 0.2.1"), a
 * plain Hub install otherwise. A latest version this core cannot run, and an
 * installed plugin already at (or past) the Hub's latest, are skipped — they
 * would not provide anything either.
 *
 * Capabilities that already have catalog candidates are left as they are.
 * Never throws: an unreachable Hub leaves the chain unchanged, which is the
 * answer the operator got before.
 */
export async function addRegistryCapabilityProviders(
  chain: InstallChainResolution,
  deps: {
    readonly listRegistryPlugins: () => Promise<readonly RegistryPluginEntry[]>;
    readonly registry: Pick<InstalledRegistry, 'get'>;
    readonly log?: (message: string) => void;
  },
): Promise<InstallChainResolution> {
  if (!chain.available_providers.some((e) => e.providers.length === 0)) {
    return chain;
  }
  let plugins: readonly RegistryPluginEntry[];
  try {
    plugins = await deps.listRegistryPlugins();
  } catch (err) {
    deps.log?.(
      `[install] Hub lookup for missing capability providers failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return chain;
  }

  return {
    ...chain,
    available_providers: chain.available_providers.map((entry) => {
      if (entry.providers.length > 0) return entry;
      let wanted: { name: string; major: number };
      try {
        wanted = parseCapabilityRef(entry.capability);
      } catch {
        return entry;
      }
      const providers = plugins
        .map((p) => registryProviderRef(p, wanted, deps.registry))
        .filter((ref): ref is CapabilityProviderRef => ref !== null)
        .sort((a, b) => a.id.localeCompare(b.id));
      return providers.length > 0 ? { ...entry, providers } : entry;
    }),
  };
}

function registryProviderRef(
  plugin: RegistryPluginEntry,
  wanted: { name: string; major: number },
  registry: Pick<InstalledRegistry, 'get'>,
): CapabilityProviderRef | null {
  const latest = plugin.versions.find((v) => v.version === plugin.latest_version);
  if (!latest) return null;
  const provides = (latest.manifest_summary.provides ?? []).some((raw) => {
    try {
      const ref = parseCapabilityRef(raw);
      return ref.name === wanted.name && ref.major === wanted.major;
    } catch {
      return false;
    }
  });
  if (!provides) return null;
  if (
    checkCoreCompat({
      id: plugin.id,
      version: latest.version,
      compat_core: latest.compat_core,
    }) !== null
  ) {
    return null;
  }
  const installed = registry.get(plugin.id);
  if (installed && versionDirection(installed.installed_version, latest.version) !== 'upgrade') {
    return null;
  }
  return {
    id: plugin.id,
    name: plugin.name,
    kind: plugin.kind,
    version: latest.version,
    install_state: installed ? 'update-available' : 'available',
    already_installed: installed !== undefined,
    active: installed?.status === 'active',
    source: 'registry',
    ...(installed ? { update_from: installed.installed_version } : {}),
  };
}
