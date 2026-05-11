import { Router } from 'express';
import type { Request, Response } from 'express';

import type { PluginCatalog } from '../plugins/manifestLoader.js';

interface AdminDomainsDeps {
  catalog: PluginCatalog;
}

/**
 * Admin → Plugin-Domain overview (Palaia Phase 8 / OB-77 Slice 3c).
 *
 * Read-only operator-facing surface. Lists every plugin currently in the
 * `PluginCatalog` together with its declared `identity.domain`, grouped
 * by domain so the operator can spot:
 *   - plugins that auto-fallbacked to `unknown.<id>` (manifest needs a
 *     domain entry)
 *   - clusters of plugins under the same domain (e.g. multiple
 *     odoo.* connectors)
 *
 * Curation (rename / merge / hierarchy) is **deferred to OB-78** (Phase 9
 * Agent-Profile + Default-Process-Set). This route intentionally exposes
 * no write endpoints — operators wanting to change a domain edit the
 * plugin's manifest.yaml or, for uploaded packages, re-upload via the
 * Builder (Slice 3d) which captures the field at agent-creation time.
 *
 * Mount path: `/api/admin/domains`. Mounted alongside the other dev
 * admin endpoints (kg-priorities, kg-lifecycle) in `src/index.ts`.
 */
export function createAdminDomainsRouter(deps: AdminDomainsDeps): Router {
  const router = Router();

  router.get('/', (_req: Request, res: Response) => {
    try {
      const entries = deps.catalog.list();
      const plugins = entries.map((e) => ({
        id: e.plugin.id,
        name: e.plugin.name,
        kind: e.plugin.kind,
        domain: e.plugin.domain,
        version: e.plugin.version,
        installState: e.plugin.install_state,
      }));

      // Bucket by domain. Sort buckets alphabetically; within a bucket,
      // sort by plugin id. Auto-fallback domains (`unknown.*`) bubble to
      // the bottom so the operator's eye lands on real domains first.
      const byDomain = new Map<string, typeof plugins>();
      for (const p of plugins) {
        const list = byDomain.get(p.domain) ?? [];
        list.push(p);
        byDomain.set(p.domain, list);
      }
      const buckets = Array.from(byDomain.entries())
        .map(([domain, items]) => ({
          domain,
          isFallback: domain.startsWith('unknown.'),
          plugins: items.sort((a, b) => a.id.localeCompare(b.id)),
        }))
        .sort((a, b) => {
          if (a.isFallback !== b.isFallback) return a.isFallback ? 1 : -1;
          return a.domain.localeCompare(b.domain);
        });

      const totals = {
        plugins: plugins.length,
        domains: byDomain.size,
        fallbackDomains: buckets.filter((b) => b.isFallback).length,
      };

      res.json({ totals, buckets });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  return router;
}
