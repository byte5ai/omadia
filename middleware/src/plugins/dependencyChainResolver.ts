// ===========================================================================
// Remote depends_on chain resolver (Slice C5).
// ---------------------------------------------------------------------------
// A plugin's `depends_on` parents are a STRICT install-time dependency: Core's
// install service refuses to install a child whose parent isn't installed
// (`install.missing_dependencies`), because the child inherits the parent's
// vault secrets/config (e.g. channel-teams reads the microsoft365 integration's
// Bot-Framework + Graph credentials).
//
// When installing from a remote registry, those parents may themselves be
// remote-only (not yet in the local catalog). This resolver walks the target's
// `depends_on` transitively, FETCHES + INGESTS any remote-only parent so it
// becomes locally installable, and returns the missing parents as an
// `InstallChainResolution` — the SAME shape the capability-chain wizard
// consumes, so the operator UI walks "parents → target" with no new component.
//
// It ingests (makes available) but never activates: each parent still gets its
// own setup form in the wizard. Topo-ordered, parents-first.
// ===========================================================================

import type { PluginCatalog } from './manifestLoader.js';
import type { InstalledRegistry } from './installedRegistry.js';
import type { RegistryClient } from './registryClient.js';
import { RegistryError } from './registryClient.js';
import type { PackageUploadService } from './packageUploadService.js';
import type {
  InstallChainResolution,
  UnresolvedCapabilityEntry,
} from './capabilityResolver.js';

export interface DependencyChainDeps {
  catalog: PluginCatalog;
  registry: InstalledRegistry;
  client: RegistryClient;
  packageUpload: PackageUploadService;
  log?: (msg: string) => void;
}

export interface DependencyChainResult {
  /** Missing-parent chain for the UI wizard (topo: parents-first), each parent
   *  modelled as a single-provider entry. Empty when the target's parents are
   *  all already installed. */
  chain: InstallChainResolution;
  /** Parent ids that could not be resolved in the catalog or any registry —
   *  surfaced (with empty providers) so the wizard shows the blocker. */
  unresolvable: string[];
}

const EMPTY: DependencyChainResult = {
  chain: { unresolved_requires: [], available_providers: [] },
  unresolvable: [],
};

/**
 * Resolve + ingest the transitive `depends_on` parents of an ALREADY-INGESTED
 * target. Returns the missing (not-yet-installed) parents as a wizard chain.
 */
export async function resolveDependencyParents(
  targetId: string,
  deps: DependencyChainDeps,
): Promise<DependencyChainResult> {
  const log = deps.log ?? (() => {});
  const targetEntry = deps.catalog.get(targetId);
  if (!targetEntry) return EMPTY;
  const directParents = targetEntry.plugin.depends_on ?? [];
  if (directParents.length === 0) return EMPTY;

  // Snapshot the remote catalogs once for resolution.
  const remote = deps.client.hasRegistries()
    ? (await deps.client.listAll()).plugins
    : [];
  const findRemote = (id: string) =>
    remote.find((p) => p.entry.id === id);

  const visited = new Set<string>();
  const order: string[] = []; // post-order DFS → parents before dependents
  const unresolvable: string[] = [];

  // Ingest `id` from a registry iff it isn't already in the local catalog.
  // Returns true once the plugin is locally available.
  const ensurePresent = async (id: string): Promise<boolean> => {
    if (deps.catalog.get(id)) return true;
    const r = findRemote(id);
    if (!r) return false;
    const ver =
      r.entry.versions.find((v) => v.version === r.entry.latest_version) ??
      r.entry.versions[0];
    if (!ver) return false;
    const { buffer, sha256 } = await deps.client.fetchPackage({
      registry: r.registry,
      downloadUrl: ver.download_url,
      sha256: ver.sha256,
    });
    const res = await deps.packageUpload.ingest({
      fileBuffer: buffer,
      originalFilename: `${sanitize(id)}-${ver.version}.zip`,
      uploadedBy: `registry:${r.registry}`,
      sha256,
    });
    if (!res.ok) {
      // A duplicate-version failure means the package is already on disk —
      // treat as present if the catalog now resolves it. Anything else is a
      // genuine ingest error.
      if (deps.catalog.get(id)) return true;
      throw new DependencyChainError(res.code, res.message);
    }
    log(`[registry] ingested dependency ${id}@${ver.version} from '${r.registry}'`);
    return true;
  };

  const visit = async (id: string): Promise<void> => {
    if (visited.has(id)) return;
    visited.add(id);
    const present = await ensurePresent(id);
    if (!present) {
      unresolvable.push(id);
      order.push(id);
      return;
    }
    const entry = deps.catalog.get(id);
    for (const parent of entry?.plugin.depends_on ?? []) {
      await visit(parent);
    }
    order.push(id);
  };

  for (const p of directParents) await visit(p);

  // Missing = resolved parents not yet installed. Already-installed parents
  // drop out (the install gate is satisfied for them).
  const missing = order.filter((id) => !deps.registry.has(id));
  const available_providers: UnresolvedCapabilityEntry[] = missing.map((id) => {
    const plugin = deps.catalog.get(id)?.plugin;
    return {
      capability: id, // the parent id doubles as the chain-step label
      providers: plugin
        ? [
            {
              id,
              name: plugin.name,
              kind: plugin.kind,
              version: plugin.version,
              install_state: 'available' as const,
              already_installed: false,
              active: false,
            },
          ]
        : [], // unresolvable → wizard renders the blocker
    };
  });

  return {
    chain: { unresolved_requires: missing, available_providers },
    unresolvable,
  };
}

export class DependencyChainError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'DependencyChainError';
    this.code = code;
  }
}

/** Re-export so the route can distinguish upstream fetch failures. */
export { RegistryError };

function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}
