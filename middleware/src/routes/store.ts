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
import type { PluginStatusRegistry } from '../platform/pluginStatusRegistry.js';
import type { PluginVerdictLookup } from '../services/pluginVerdict.js';
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
  /** Spec 004 — read-only access to plugins' pushed `ctx.status` so the list
   *  and detail responses can carry `action_status` for the badge/banner. */
  pluginStatusRegistry?: PluginStatusRegistry;
  /** Issue #453 — advisory code-scan verdicts for ingested packages. When
   *  present, the detail response carries a read-only `verdict` and the
   *  operator ack endpoint is mounted. Lookup only — GET never scans. */
  verdicts?: PluginVerdictLookup;
}

/** Overlay the live `ctx.status` value (if any) onto a plugin record. Returns
 *  the input unchanged when no status is reported (the common case). */
function withActionStatus(
  plugin: Plugin,
  statusRegistry: PluginStatusRegistry | undefined,
): Plugin {
  const status = statusRegistry?.get(plugin.id);
  return status ? { ...plugin, action_status: status } : plugin;
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
              // Enrich the local entry with the hub `source` and, when the hub
              // advertises a newer version than what's installed, flag it as
              // `update-available` (C6). Replace with a copy — catalog plugin
              // objects are shared across requests and must not be mutated.
              items[existingIdx] = enrichWithRegistry(
                items[existingIdx]!,
                resolved,
                deps.registry,
              );
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
        items: items.map((p) => withActionStatus(p, deps.pluginStatusRegistry)),
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

      let plugin = applyInstallState(entry.plugin, deps.registry);
      // C6 — update detection on the detail page: if this installed plugin is
      // also advertised by a registry with a newer version, flag it (+ source).
      if (plugin.install_state === 'installed' && deps.client?.hasRegistries()) {
        try {
          const remote = await resolveRemotePlugin(deps.client, id);
          if (remote?.source) {
            const installedVersion =
              deps.registry.get(id)?.installed_version ?? plugin.version;
            if (isNewerVersion(remote.version, installedVersion)) {
              plugin = {
                ...plugin,
                install_state: 'update-available',
                available_version: remote.version,
                source: remote.source,
              };
            } else if (!plugin.source) {
              plugin = { ...plugin, source: remote.source };
            }
          }
        } catch {
          // registry hiccup → keep the local 'installed' view, never 500
        }
      }
      const installAvailable = plugin.install_state === 'available';
      plugin = withActionStatus(plugin, deps.pluginStatusRegistry);
      // Issue #453 — decorate with the advisory code-scan verdict. Pure
      // lookup (never triggers a scan); a store hiccup degrades to "no
      // verdict shown", never a 500.
      let verdict;
      if (deps.verdicts) {
        try {
          verdict = await deps.verdicts.getForPlugin(id);
        } catch {
          verdict = undefined;
        }
      }
      const body: StoreGetResponse = {
        plugin,
        manifest: entry.manifest,
        install_available: installAvailable,
        ...(plugin.incompatibility_reasons
          ? { blocking_reasons: plugin.incompatibility_reasons }
          : {}),
        ...(verdict ? { verdict } : {}),
      };
      res.json(body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ code: 'store.get_failed', message });
    }
  });

  // Issue #453 — operator acknowledgement of a code-scan verdict. Advisory
  // model as in #452: any authenticated operator may ack (omadia has no role
  // differentiation yet — see the acknowledged gap in agentBuilder.ts), but
  // ack_by/ack_at are persisted for audit.
  router.post('/:id/verdict/ack', async (req: Request, res: Response) => {
    try {
      const rawId = req.params['id'];
      const id = typeof rawId === 'string' ? rawId : undefined;
      if (!id) {
        res.status(400).json({ code: 'store.invalid_id', message: 'missing id' });
        return;
      }
      if (!deps.verdicts) {
        res.status(404).json({
          code: 'store.verdicts_unavailable',
          message: 'code-scan verdicts are not enabled on this deployment',
        });
        return;
      }
      const session = (req as Request & { session?: { email: string } }).session;
      const ackedBy = session?.email ?? 'unknown';
      const ack = await deps.verdicts.ack(id, ackedBy);
      if (!ack) {
        res.status(404).json({
          code: 'store.verdict_not_found',
          message: `no code-scan verdict recorded for plugin '${id}'`,
        });
        return;
      }
      res.json({ ack });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ code: 'store.ack_failed', message });
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

/** Enrich a local store entry with its hub `source`, and flag it as
 *  `update-available` (C6) when the hub advertises a newer version than the
 *  installed one. Only installed plugins are eligible — an `available` or
 *  `incompatible` entry keeps its state. Returns a copy (catalog objects are
 *  shared across requests and must not be mutated). */
function enrichWithRegistry(
  existing: Plugin,
  resolved: ResolvedRegistryPlugin,
  registry: InstalledRegistry,
): Plugin {
  const source = existing.source ?? registrySource(resolved);
  if (existing.install_state === 'installed') {
    const hubLatest = resolved.entry.latest_version;
    const installedVersion =
      registry.get(existing.id)?.installed_version ?? existing.version;
    if (isNewerVersion(hubLatest, installedVersion)) {
      return {
        ...existing,
        source,
        install_state: 'update-available',
        available_version: hubLatest,
      };
    }
  }
  return { ...existing, source };
}

/** Parse the numeric `X.Y.Z` core of a semver (pre-release/build stripped).
 *  Returns null when any segment is non-numeric — callers treat that as
 *  "can't compare" and never recommend an update. */
function parseSemver(v: string): number[] | null {
  const core = v.trim().split(/[-+]/)[0] ?? '';
  const parts = core.split('.');
  const nums = parts.map((p) => Number(p));
  if (nums.length === 0 || nums.some((n) => !Number.isInteger(n) || n < 0)) {
    return null;
  }
  return nums;
}

/** True iff `candidate` is a strictly newer version than `current`. Conservative:
 *  unparseable inputs → false (no spurious update prompts). */
function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseSemver(candidate);
  const b = parseSemver(current);
  if (!a || !b) return false;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
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
  const setupGuide =
    summary.setup_guide && Object.keys(summary.setup_guide).length > 0
      ? summary.setup_guide
      : undefined;

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
    setup_fields: setupFields,
    permissions_summary: emptyPermissionsSummary(),
    integrations_summary: [],
    install_state: 'available',
    depends_on: Array.isArray(summary.depends_on) ? summary.depends_on : [],
    jobs: [],
    provides: Array.isArray(summary.provides) ? summary.provides : [],
    requires: Array.isArray(summary.requires) ? summary.requires : [],
    multi_instance: true,
    privacy_class: 'default',
    ...(setupGuide ? { setup_guide: setupGuide } : {}),
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
