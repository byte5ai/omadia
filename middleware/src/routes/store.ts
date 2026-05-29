import { Router } from 'express';
import type { Request, Response } from 'express';

import type {
  Plugin,
  PluginPermissionsSummary,
  PluginSetupField,
  StoreGetResponse,
  StoreListResponse,
} from '../api/admin-v1.js';
import type { InstalledRegistry } from '../plugins/installedRegistry.js';
import type { PluginCatalog } from '../plugins/manifestLoader.js';
import type {
  RegistryClient,
  ResolvedRegistryPlugin,
} from '../plugins/registryClient.js';

interface StoreDeps {
  catalog: PluginCatalog;
  registry: InstalledRegistry;
  /** Optional remote registries. When present, their plugins are merged into
   *  the list with `install_state: 'available'` + a `source` marker so the
   *  operator can install from the hub. A local plugin of the same id wins;
   *  a registry fetch failure never breaks the local listing. */
  client?: RegistryClient;
}

/**
 * Plugin-Store endpoints — first vertical slice of the Admin API v1.
 *
 * Contract lives in docs/harness-platform/api/admin-api.v1.ts,
 * namespace `Store`. Mounted at /api/v1/store/plugins.
 *
 * Slice 1.1 scope:
 *   GET /        — list all known plugins (sorted by display name)
 *   GET /:id     — detail + parsed manifest for a single plugin
 *
 * Out of scope for this slice: pagination cursors, search/category filters,
 * signed-package verification. The catalog is small enough that we return
 * it in full; cursor plumbing is wired but inert until the catalog grows.
 */
export function createStoreRouter(deps: StoreDeps): Router {
  const router = Router();

  router.get('/', async (req: Request, res: Response) => {
    try {
      const search = asOptionalString(req.query['search']);
      const category = asOptionalString(req.query['category']);

      const items: Plugin[] = deps.catalog
        .list()
        .map((entry) => applyInstallState(entry.plugin, deps.registry))
        // OB-29-0: builder-reference plugins (`is_reference_only: true`)
        // are not intended for operator install — they are a pattern source
        // for the BuilderAgent via BUILDER_REFERENCE_ESSENTIALS.
        .filter((plugin) => plugin.is_reference_only !== true)
        .filter((plugin) => matchesSearch(plugin, search))
        .filter((plugin) => matchesCategory(plugin, category));

      // Merge remote-registry plugins (the "store sources"). On an id collision
      // the LOCAL entry wins on content (version, install_state, permissions),
      // but we tag it with the hub `source` so it still surfaces in the store's
      // "Hub" view alongside its real install_state — an already-installed or
      // built-in plugin that the hub also offers must not vanish from the Hub
      // tab. A registry hiccup degrades to local-only, never 500s.
      if (deps.client?.hasRegistries()) {
        // id → index into `items`, so a colliding remote entry can enrich the
        // local plugin in place rather than being dropped.
        const indexById = new Map(items.map((p, i) => [p.id, i]));
        try {
          const { plugins, errors } = await deps.client.listAll();
          for (const resolved of plugins) {
            const existingIdx = indexById.get(resolved.entry.id);
            if (existingIdx !== undefined) {
              const existing = items[existingIdx]!;
              if (!existing.source) {
                // Replace with a copy — catalog plugin objects are shared
                // across requests and must not be mutated.
                items[existingIdx] = {
                  ...existing,
                  source: registrySource(resolved),
                };
              }
              continue;
            }
            const remote = registryEntryToPlugin(resolved);
            if (
              matchesSearch(remote, search) &&
              matchesCategory(remote, category)
            ) {
              indexById.set(remote.id, items.length);
              items.push(remote);
            }
          }
          for (const e of errors) {
            console.warn(`[store] registry '${e.registry}' skipped: ${e.message}`);
          }
        } catch (err) {
          console.warn(
            `[store] remote registry merge skipped: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      const body: StoreListResponse = {
        items,
        next_cursor: null,
        total: items.length,
      };
      res.json(body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ code: 'store.list_failed', message });
    }
  });

  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const rawId = req.params['id'];
      const id = typeof rawId === 'string' ? rawId : undefined;
      if (!id) {
        res.status(400).json({ code: 'store.invalid_id', message: 'missing id' });
        return;
      }

      const entry = deps.catalog.get(id);
      if (!entry) {
        // Not local — try the remote registries so a hub-only plugin's detail
        // page resolves (otherwise the store list would link to a 404).
        const remote = await resolveRemotePlugin(deps.client, id);
        if (remote) {
          const body: StoreGetResponse = {
            plugin: remote,
            manifest: remote.source ? { source: remote.source } : {},
            install_available: true,
          };
          res.json(body);
          return;
        }
        res
          .status(404)
          .json({ code: 'store.plugin_not_found', message: `no plugin with id '${id}'` });
        return;
      }

      // OB-29-0: hide reference-only plugins from the detail endpoint too,
      // not just the list. Operator UI must never surface them.
      if (entry.plugin.is_reference_only === true) {
        res
          .status(404)
          .json({ code: 'store.plugin_not_found', message: `no plugin with id '${id}'` });
        return;
      }

      const plugin = applyInstallState(entry.plugin, deps.registry);
      const installAvailable = plugin.install_state === 'available';
      const body: StoreGetResponse = {
        plugin,
        manifest: entry.manifest,
        install_available: installAvailable,
        ...(plugin.incompatibility_reasons
          ? { blocking_reasons: plugin.incompatibility_reasons }
          : {}),
      };
      res.json(body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ code: 'store.get_failed', message });
    }
  });

  return router;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Overlay the installedRegistry onto the catalog-derived Plugin record. */
function applyInstallState(
  plugin: Plugin,
  registry: InstalledRegistry,
): Plugin {
  // Incompatible stays incompatible — registry state only overrides
  // "available" → "installed". Legacy plugins remain blocked.
  if (plugin.install_state === 'incompatible') return plugin;
  if (registry.has(plugin.id)) {
    return { ...plugin, install_state: 'installed' };
  }
  return plugin;
}

function matchesSearch(plugin: Plugin, search: string | undefined): boolean {
  if (!search) return true;
  const needle = search.toLowerCase();
  return (
    plugin.name.toLowerCase().includes(needle) ||
    plugin.description.toLowerCase().includes(needle) ||
    plugin.id.toLowerCase().includes(needle)
  );
}

function matchesCategory(plugin: Plugin, category: string | undefined): boolean {
  if (!category) return true;
  return plugin.categories.includes(category);
}

/** Resolve a single plugin id against the remote registries (for the detail
 *  endpoint). Returns null if absent or any registry is unreachable. */
async function resolveRemotePlugin(
  client: RegistryClient | undefined,
  id: string,
): Promise<Plugin | null> {
  if (!client?.hasRegistries()) return null;
  try {
    const { plugins } = await client.listAll();
    const resolved = plugins.find((p) => p.entry.id === id);
    return resolved ? registryEntryToPlugin(resolved) : null;
  } catch {
    return null;
  }
}

/** The `source` marker for a remote registry entry: the download coordinates
 *  of its latest advertised version. Reused to (a) build a fully-remote Plugin
 *  and (b) tag a colliding local plugin with its hub origin. */
function registrySource(
  resolved: ResolvedRegistryPlugin,
): NonNullable<Plugin['source']> {
  const { registry, entry } = resolved;
  const ver =
    entry.versions.find((v) => v.version === entry.latest_version) ??
    entry.versions[0]!;
  return { registry, download_url: ver.download_url, sha256: ver.sha256 };
}

/** Map a remote registry entry → the `Plugin` shape the store list returns.
 *  Uses the latest advertised version. Permissions/integrations are left
 *  minimal here — the registry's `manifest_summary` is a display teaser; the
 *  authoritative summary is computed from the real manifest after the package
 *  is fetched + ingested (the install wizard shows that). */
function registryEntryToPlugin(resolved: ResolvedRegistryPlugin): Plugin {
  const { entry } = resolved;
  const ver =
    entry.versions.find((v) => v.version === entry.latest_version) ??
    entry.versions[0]!;
  const summary = ver.manifest_summary ?? {};
  const setupFields = Array.isArray(summary.setup_fields)
    ? (summary.setup_fields as unknown as PluginSetupField[])
    : [];

  return {
    id: entry.id,
    kind: entry.kind,
    name: entry.name,
    version: ver.version,
    latest_version: entry.latest_version,
    description: entry.description,
    authors: entry.authors,
    license: entry.license,
    icon_url: entry.icon_url,
    categories: entry.categories,
    domain: entry.domain,
    compat_core: ver.compat_core,
    signed: false,
    signed_by: null,
    required_secrets: setupFields,
    permissions_summary: emptyPermissionsSummary(),
    integrations_summary: [],
    install_state: 'available',
    depends_on: Array.isArray(summary.depends_on) ? summary.depends_on : [],
    jobs: [],
    provides: Array.isArray(summary.provides) ? summary.provides : [],
    requires: Array.isArray(summary.requires) ? summary.requires : [],
    multi_instance: true,
    privacy_class: 'default',
    source: registrySource(resolved),
  };
}

function emptyPermissionsSummary(): PluginPermissionsSummary {
  return {
    memory_reads: [],
    memory_writes: [],
    graph_reads: [],
    graph_writes: [],
    network_outbound: [],
  };
}
