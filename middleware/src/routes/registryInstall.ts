import { Router } from 'express';
import type { Request, Response } from 'express';

import type { RegistryClient } from '../plugins/registryClient.js';
import { RegistryError } from '../plugins/registryClient.js';
import {
  INGEST_CONFLICT_CODES,
  type PackageUploadService,
} from '../plugins/packageUploadService.js';
import type { PluginCatalog } from '../plugins/manifestLoader.js';
import type { InstalledRegistry } from '../plugins/installedRegistry.js';
import {
  DependencyChainError,
  resolveDependencyParents,
} from '../plugins/dependencyChainResolver.js';
import { isTruthyFlag } from '../http/requestFlags.js';
import { checkCoreCompat } from '../plugins/coreCompat.js';

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
 *   POST /:id?version=X&allow_downgrade=1
 *                        …even when X is OLDER than the installed version
 *
 * `:id` is URL-encoded (scoped names like `@omadia%2Fplugin-office`). On
 * success the package is ingested + catalogued locally; the caller then drives
 * the normal install-job flow (POST /api/v1/install/plugins/:id) for the setup
 * form + activation.
 *
 * For a plugin that is NOT yet installed this route does not activate anything
 * — it only makes the remote package locally available, identical to a manual
 * ZIP upload. For one that IS installed and active, the ingest pipeline's
 * `onPackageReady` hook swaps the running instance (#1455 — the doc comment
 * here used to claim the route never activates, which is why an older
 * `?version=` could replace a running plugin unnoticed). An ingest whose
 * version sorts BELOW the installed one is therefore refused with 409
 * `package.downgrade_blocked` unless the caller passes `allow_downgrade=1`,
 * and a successful swap reports its `direction` in the response.
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
      const { plugins, errors } = await deps.client.listAll();
      const resolved = plugins.find((p) => p.entry.id === id);
      if (!resolved && errors.length > 0) {
        // #1482 — not finding the plugin proves nothing when a registry
        // could not be read: it may well be in there. Name the registry that
        // failed instead of answering "not found".
        res.status(502).json({
          code: 'registry_install.registry_unavailable',
          message: `no plugin '${id}' in the readable registries; could not read ${errors
            .map((e) => `'${e.registry}' (${e.message})`)
            .join(', ')}`,
          params: { registries: errors.map((e) => e.registry).join(', ') },
        });
        return;
      }
      if (!resolved) {
        res.status(404).json({
          code: 'registry_install.plugin_not_found',
          message: `no plugin '${id}' in any configured registry`,
        });
        return;
      }

      const wanted = asString(req.query['version']) || resolved.entry.latest_version;
      // #1455 — explicit operator consent to replace the installed version
      // with an older one. Absent, the ingest pipeline refuses the swap.
      // `bareFlag`: `?allow_downgrade` with no value is a hand-typed URL, and
      // that is the operator writing the flag.
      const allowDowngrade = isTruthyFlag(req.query['allow_downgrade'], {
        bareFlag: true,
      });
      const verEntry = resolved.entry.versions.find((v) => v.version === wanted);
      if (!verEntry) {
        res.status(404).json({
          code: 'registry_install.version_not_found',
          message: `plugin '${id}' has no version '${wanted}'`,
        });
        return;
      }

      // #1463 — refuse a version this core cannot run before downloading it.
      // The ingest pipeline would refuse it too, with the same code; checking
      // the index entry first just saves the fetch and names the reason.
      const coreRefusal = checkCoreCompat({
        id,
        version: verEntry.version,
        compat_core: verEntry.compat_core,
      });
      if (coreRefusal) {
        res.status(refusalStatus('package.incompatible_core')).json({
          code: 'package.incompatible_core',
          message: coreRefusal.message,
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
        ...(allowDowngrade ? { allowDowngrade: true } : {}),
      });

      if (!result.ok) {
        // ingest failures are caller-fixable (bad manifest, id conflict, dup
        // version) → 422, with the pipeline's own code/message.
        //
        // #1455 — except a host-state refusal (id taken, version already
        // there, older version): the package is well-formed and the request
        // answerable, it is this host that says no → 409. The `params` carry
        // the two versions so the UI can name them in the operator's locale.
        res.status(refusalStatus(result.code)).json({
          code: result.code,
          message: result.message,
          ...(result.params !== undefined ? { params: result.params } : {}),
        });
        return;
      }

      // #1092 — "ingested", not "installed": the package is fetched, verified
      // and registered, but it still has to go through the install wizard
      // (configure + activate) before it serves anything.
      log(
        `[registry] ingested ${result.plugin_id}@${result.version} from '${resolved.registry}' — package registered, not yet installed`,
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
        // #1455 — present only when this ingest replaced another version.
        // Without it a caller cannot tell an update from a downgrade.
        ...(result.direction !== undefined ? { direction: result.direction } : {}),
        // #1452 — the ingest succeeded and the plugin did NOT come back up.
        // Still 201: the package is registered, which is what this endpoint
        // promises; the activation is a separate fact the operator who
        // clicked "Update" has to see, and before this field the only trace
        // was one log line.
        ...(result.activation_error !== undefined
          ? { activation_error: result.activation_error }
          : {}),
        // #1463 — the running plugin was (re)started by this ingest.
        ...(result.activated ? { activated: true } : {}),
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
      if (err instanceof DependencyChainError) {
        // #1455 — a parent the chain tried to pull was refused by the ingest
        // pipeline. That is the caller's problem, not this host's: it carries
        // the pipeline's own code, and a refused parent downgrade answers 409
        // like the target's would rather than a blanket 500.
        res.status(refusalStatus(err.code)).json({
          code: err.code,
          message: err.message,
        });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ code: 'registry_install.internal', message });
    }
  });

  return router;
}

/** Status for an ingest refusal, whether it came from the target's own ingest
 *  or from a parent in its dependency chain: a host-state conflict is 409,
 *  everything else is a caller-fixable 422. */
function refusalStatus(code: string): number {
  return INGEST_CONFLICT_CODES.has(code) ? 409 : 422;
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
