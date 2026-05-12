import { Router } from 'express';
import type { Request, Response } from 'express';

import type {
  Plugin,
  StoreGetResponse,
  StoreListResponse,
} from '../api/admin-v1.js';
import type { InstalledRegistry } from '../plugins/installedRegistry.js';
import type { PluginCatalog } from '../plugins/manifestLoader.js';

interface StoreDeps {
  catalog: PluginCatalog;
  registry: InstalledRegistry;
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
