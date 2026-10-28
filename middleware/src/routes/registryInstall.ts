import { Router } from 'express';
import type { Request, Response } from 'express';

import type { RegistryClient } from '../plugins/registryClient.js';
import { RegistryError } from '../plugins/registryClient.js';
import type { PackageUploadService } from '../plugins/packageUploadService.js';
import {
  ingestFailureBody,
  ingestFailureStatus,
} from '../plugins/ingestErrorContract.js';
import type { UploadedPackageStore } from '../plugins/uploadedPackageStore.js';
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
  /** #1495 — the upload store, read to recognise a package this route already
   *  fetched (same version, same sha256). Optional: without it every call
   *  fetches and ingests, as before. */
  store?: Pick<UploadedPackageStore, 'get'>;
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
 *
 * #1495 — asking again for a package this route already fetched (same
 * version, same sha256 in the upload store) is not an error: the route skips
 * the download and the ingest, answers 200 with `already_present: true`, and
 * still resolves the dependency chain. That is what a second "Install now"
 * after a cancelled prerequisites wizard sends, and it used to end in 422
 * `package.duplicate_version`.
 *
 * #1477 — a refusal answers with the same status and body (`code`, `message`,
 * `params`, `details`) as the ZIP upload and the builder install
 * (`ingestErrorContract.ts`), for the target and for a refused parent alike.
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
        res.status(ingestFailureStatus('package.incompatible_core')).json({
          code: 'package.incompatible_core',
          message: coreRefusal.message,
        });
        return;
      }

      // #1495 — already fetched: same version AND same bytes. A different
      // sha256 under the same version (an operator's own zip, a republished
      // Hub version) is NOT this package and still goes to the ingest, which
      // refuses it as `package.duplicate_version`.
      const stored = deps.store?.get(id);
      const alreadyPresent =
        stored !== undefined &&
        stored.version === verEntry.version &&
        stored.sha256.toLowerCase() === verEntry.sha256.toLowerCase();

      // What the response reports. On an ingest, the ids come from the
      // package's own manifest (as before), not from the request.
      let ingested: {
        plugin_id: string;
        version: string;
        direction?: string;
        replaced_version?: string;
        activation_error?: string;
        activated?: boolean;
      } = { plugin_id: id, version: verEntry.version };
      if (alreadyPresent) {
        log(
          `[registry] ${id}@${verEntry.version} from '${resolved.registry}' is already present — skipped download and ingest`,
        );
      } else {
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
          res
            .status(ingestFailureStatus(result.code))
            .json(ingestFailureBody(result));
          return;
        }
        ingested = result;

        // #1092 — "ingested", not "installed": the package is fetched,
        // verified and registered, but it still has to go through the install
        // wizard (configure + activate) before it serves anything.
        log(
          `[registry] ingested ${result.plugin_id}@${result.version} from '${resolved.registry}' — package registered, not yet installed`,
        );
      }

      // C5 — resolve + ingest the target's transitive depends_on parents.
      // `chain` lists the missing (not-yet-installed) parents so the operator
      // wizard installs them before the target (the install gate is strict on
      // depends_on because the child inherits the parent's vault credentials).
      const { chain } = await resolveDependencyParents(ingested.plugin_id, {
        catalog: deps.catalog,
        registry: deps.registry,
        client: deps.client,
        packageUpload: deps.packageUpload,
        log,
      });

      res.status(alreadyPresent ? 200 : 201).json({
        ok: true,
        plugin_id: ingested.plugin_id,
        version: ingested.version,
        registry: resolved.registry,
        ...(alreadyPresent ? { already_present: true } : {}),
        // #1455 — present only when this ingest replaced another version.
        // Without it a caller cannot tell an update from a downgrade.
        ...(ingested.direction !== undefined
          ? { direction: ingested.direction }
          : {}),
        ...(ingested.replaced_version !== undefined
          ? { replaced_version: ingested.replaced_version }
          : {}),
        // #1452 — the ingest succeeded and the plugin did NOT come back up.
        // Still 201: the package is registered, which is what this endpoint
        // promises; the activation is a separate fact the operator who
        // clicked "Update" has to see, and before this field the only trace
        // was one log line.
        ...(ingested.activation_error !== undefined
          ? { activation_error: ingested.activation_error }
          : {}),
        ...(result.activation !== undefined ? { activation: result.activation } : {}),
        // #1463 — the running plugin was (re)started by this ingest.
        ...(ingested.activated === true ? { activated: true } : {}),
        // Missing depends_on parents to install first (empty → install target
        // directly). Same shape as the capability-chain wizard consumes.
        chain,
        // hint the next step in the install flow
        next: {
          install: `/api/v1/install/plugins/${encodeURIComponent(ingested.plugin_id)}`,
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
        // #1477 — with the parent's `params`/`details`, so the drawer can say
        // it in the operator's locale.
        res.status(ingestFailureStatus(err.code)).json(
          ingestFailureBody({
            code: err.code,
            message: err.message,
            ...(err.params !== undefined ? { params: err.params } : {}),
            ...(err.details !== undefined ? { details: err.details } : {}),
          }),
        );
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
