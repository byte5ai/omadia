import { Router } from 'express';
import type { Request, Response } from 'express';

import type { RegistryClient } from '../plugins/registryClient.js';
import { RegistryError } from '../plugins/registryClient.js';
import type { PackageUploadService } from '../plugins/packageUploadService.js';
import type { PluginCatalog } from '../plugins/manifestLoader.js';
import type { InstalledRegistry } from '../plugins/installedRegistry.js';
import { resolveDependencyParents } from '../plugins/dependencyChainResolver.js';

export interface RegistryInstallDeps {
  client: RegistryClient;
  /** Existing ZIP-ingest pipeline — remote install just feeds it a buffer. */
  packageUpload: PackageUploadService;
  /** Catalog + installed-registry — needed to resolve the target's
   *  `depends_on` parents (C5): remote-only parents get fetched + ingested so
   *  the operator wizard can install "parents → target" in one chained flow. */
  catalog: PluginCatalog;
  registry: InstalledRegistry;
  log?: (msg: string) => void;
}

/**
 * Remote-install endpoint — fetch a plugin ZIP from a configured registry and
 * feed it into the EXISTING upload pipeline. Mounted at
 * /api/v1/install/registry behind requireAuth, only when PACKAGE_UPLOAD_ENABLED
 * (it reuses `PackageUploadService.ingest`).
 *
 *   POST /:id            install the latest version of `<id>` from the registry
 *   POST /:id?version=X  install a specific version
 *
 * `:id` is URL-encoded (scoped names like `@omadia%2Fplugin-office`). On
 * success the package is ingested + catalogued locally; the caller then drives
 * the normal install-job flow (POST /api/v1/install/plugins/:id) for the setup
 * form + activation. This route deliberately does NOT activate — it only makes
 * the remote package locally available, identical to a manual ZIP upload.
 */
export function createRegistryInstallRouter(deps: RegistryInstallDeps): Router {
  const router = Router();
  const log = deps.log ?? (() => {});

  router.post('/:id', async (req: Request, res: Response) => {
    const id = readParam(req, 'id');
    if (!id) {
      res.status(400).json({ code: 'registry_install.missing_id' });
      return;
    }
    if (!deps.client.hasRegistries()) {
      res.status(409).json({
        code: 'registry_install.no_registries',
        message: 'no plugin registries are configured',
      });
      return;
    }

    try {
      const { plugins } = await deps.client.listAll();
      const resolved = plugins.find((p) => p.entry.id === id);
      if (!resolved) {
        res.status(404).json({
          code: 'registry_install.plugin_not_found',
          message: `no plugin '${id}' in any configured registry`,
        });
        return;
      }

      const wanted = asString(req.query['version']) || resolved.entry.latest_version;
      const verEntry = resolved.entry.versions.find((v) => v.version === wanted);
      if (!verEntry) {
        res.status(404).json({
          code: 'registry_install.version_not_found',
          message: `plugin '${id}' has no version '${wanted}'`,
        });
        return;
      }

      const { buffer, sha256 } = await deps.client.fetchPackage({
        registry: resolved.registry,
        downloadUrl: verEntry.download_url,
        sha256: verEntry.sha256,
      });

      const result = await deps.packageUpload.ingest({
        fileBuffer: buffer,
        originalFilename: `${sanitize(id)}-${verEntry.version}.zip`,
        uploadedBy: `registry:${resolved.registry}`,
        sha256,
      });

      if (!result.ok) {
        // ingest failures are caller-fixable (bad manifest, id conflict, dup
        // version) → 422, with the pipeline's own code/message.
        res.status(422).json({ code: result.code, message: result.message });
        return;
      }

      log(
        `[registry] installed ${result.plugin_id}@${result.version} from '${resolved.registry}'`,
      );

      // C5 — resolve + ingest the target's transitive depends_on parents.
      // `chain` lists the missing (not-yet-installed) parents so the operator
      // wizard installs them before the target (the install gate is strict on
      // depends_on because the child inherits the parent's vault credentials).
      const { chain } = await resolveDependencyParents(result.plugin_id, {
        catalog: deps.catalog,
        registry: deps.registry,
        client: deps.client,
        packageUpload: deps.packageUpload,
        log,
      });

      res.status(201).json({
        ok: true,
        plugin_id: result.plugin_id,
        version: result.version,
        registry: resolved.registry,
        // Missing depends_on parents to install first (empty → install target
        // directly). Same shape as the capability-chain wizard consumes.
        chain,
        // hint the next step in the install flow
        next: {
          install: `/api/v1/install/plugins/${encodeURIComponent(result.plugin_id)}`,
        },
      });
    } catch (err) {
      if (err instanceof RegistryError) {
        // network / sha256 / host-pin failures are upstream problems → 502
        res.status(502).json({ code: err.code, message: err.message });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ code: 'registry_install.internal', message });
    }
  });

  return router;
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

function readParam(req: Request, key: string): string | undefined {
  const v = (req.params as Record<string, string | string[] | undefined>)[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
