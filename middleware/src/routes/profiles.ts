import path from 'node:path';

import { Router, raw as expressRaw } from 'express';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import multer from 'multer';
import { stringify as stringifyYaml } from 'yaml';

import type { AdminAuditLog } from '../auth/adminAuditLog.js';
import type { DraftStore } from '../plugins/builder/draftStore.js';
import {
  reconstructSpecFromBundle,
  SpecReconstructError,
} from '../plugins/builder/specFromBundle.js';
import type { InstalledRegistry } from '../plugins/installedRegistry.js';
import type { PluginCatalog } from '../plugins/manifestLoader.js';
import type { PackageUploadService } from '../plugins/packageUploadService.js';
import {
  ProfileBundleImporter,
  type ImportErrorCode,
} from '../plugins/profileBundleImporter.js';
import {
  builtInProfilesDir,
  listProfiles,
  loadProfile,
  ProfileLoadError,
  type Profile,
} from '../plugins/profileLoader.js';
import type { UploadedPackageStore } from '../plugins/uploadedPackageStore.js';
import {
  ProfileStorageValidationError,
  type LiveProfileStorageService,
} from '../profileStorage/liveProfileStorageService.js';
import { renderSnapshotsAdminUi } from '../profileSnapshots/adminUiSnapshots.js';
import { renderHealthAdminUi } from '../profileSnapshots/adminUiHealth.js';
import {
  SnapshotIntegrityError,
  SnapshotNotFoundError,
  SnapshotValidationError,
  type DiffSide,
  type SnapshotService,
  type SnapshotSummary,
  type SnapshotDetail,
} from '../profileSnapshots/snapshotService.js';

interface ProfilesDeps {
  catalog: PluginCatalog;
  registry: InstalledRegistry;
  /** Profile-Quellverzeichnis. Default: built-in `<middleware>/profiles/`.
   *  Tests override this with a tmp dir. */
  profilesDir?: string;
  /** Phase 2.1.5 — live agent.md + knowledge storage. Optional so unit
   *  tests that exercise only the bootstrap-profile endpoints (list /
   *  apply / export) can omit it without setting up a Postgres. When
   *  absent, the live-state routes return 503. */
  liveStorage?: LiveProfileStorageService;
  /** Phase 2.2 — snapshot capture / rollback / diff. Optional for the
   *  same reason as `liveStorage`. When absent, snapshot routes 503. */
  snapshotService?: SnapshotService;
  /** Phase 2.2 — admin audit log for create / mark-deploy-ready / rollback
   *  mutations. When absent, mutations are still permitted (development
   *  setups) but log a warning instead of writing an audit row. */
  auditLog?: AdminAuditLog;
  /** Phase 2.4 — Builder draft store. Required for `target=draft` imports.
   *  When absent, the import-bundle route still accepts `target=profile`
   *  for Bootstrap-Profile imports. */
  draftStore?: DraftStore;
  /** Phase 2.4 — uploaded package index. Required for the import-bundle
   *  route to verify pinned plugins against the local catalog. */
  uploadedPackageStore?: UploadedPackageStore;
  /** Phase 2.4 — package upload service. Required only when imported
   *  bundles carry vendored plugin ZIPs that need to be installed
   *  during the import. */
  packageUploadService?: PackageUploadService;
  /** Phase 2.4 — cap on the uploaded bundle ZIP size. Default 50 MB
   *  (matches the bundle spec from Phase 2.1). */
  importBundleMaxBytes?: number;
  /** Phase 2.3 — Postgres pool for the drift / health-score read-paths.
   *  Required for `GET /health` and `GET /:id/health`; routes 503 when
   *  absent (matches snapshot-service guard semantics). */
  driftSweepPool?: Pool;
}

const MAX_BODY_BYTES = 5 * 1024 * 1024;

export interface ProfileApplyOutcome {
  profile_id: string;
  installed: Array<{ id: string; version: string }>;
  skipped: Array<{ id: string; reason: 'already_installed' }>;
  errored: Array<{
    id: string;
    reason: 'not_in_catalog' | 'incompatible' | 'register_failed';
    message: string;
  }>;
}

const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Bootstrap-Profile endpoints (S+12-2a).
 *
 * GET    /          — list available profiles (built-in + future uploads)
 * GET    /:id       — single profile detail
 * POST   /:id/apply — chained install: register every plugin from the
 *                     profile that's not already in the registry; skip
 *                     duplicates idempotently. Returns
 *                     {installed, skipped, errored} per plugin.
 *
 * The endpoint follows the `bootstrapKnowledgeGraphFromEnv` pattern
 * (catalog → registry.register, idempotent, non-destructive). It does
 * NOT call `installService.create`; that path is geared toward
 * UI-driven setup-form flow and would require a per-plugin job state
 * machine. Profile-apply is a bulk seed.
 *
 * Activation happens later in the normal lifecycle — `activateAllInstalled`
 * walks the registry on the next boot, and the existing capability
 * resolver enforces dependency ordering with soft-fail cascade. Plugins
 * that need secrets land in `errored` state until the operator runs the
 * setup-form via RequiresWizard; that's the exact behaviour we want for
 * non-interactive profile seeding.
 */
export function createProfilesRouter(deps: ProfilesDeps): Router {
  const router = Router();
  const dir = deps.profilesDir ?? builtInProfilesDir();

  router.get('/', async (_req: Request, res: Response) => {
    try {
      const profiles = await listProfiles(dir);
      res.json({
        items: profiles.map(toProfileSummary),
        total: profiles.length,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ code: 'profiles.list_failed', message });
    }
  });

  // /export must be registered BEFORE /:id, otherwise Express would match
  // it as a profile id named "export" and 404 on the file lookup.
  router.get('/export', (_req: Request, res: Response) => {
    try {
      const installed = deps.registry.list();
      const plugins = installed.map((entry) =>
        Object.keys(entry.config).length === 0
          ? entry.id
          : { id: entry.id, config: entry.config },
      );
      const exported = {
        schema_version: 1,
        id: 'exported',
        name: 'Exported Stack',
        description: `Profil-Export am ${new Date().toISOString()}. Operator setzt Secrets nach Apply via Wizard — nur non-secret-config exportiert.`,
        plugins,
      };
      const yaml = stringifyYaml(exported);
      res.set('Content-Type', 'application/yaml');
      res.set(
        'Content-Disposition',
        'attachment; filename="exported.yaml"',
      );
      res.send(yaml);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ code: 'profiles.export_failed', message });
    }
  });

  // ── Phase 2.3 — drift / health-score read-paths (OB-65) ────────────────
  // Registered before `/:id` so 'health' doesn't get mistaken for a
  // profile id. Per-profile history is registered later under `/:id/...`
  // — Express matches longest path-segment first within an exact path,
  // so `/<something>/health` cleanly distinguishes from `/<something>`.

  const driftPool = deps.driftSweepPool;
  const driftGuard = (res: Response): boolean => {
    if (!driftPool) {
      res.status(503).json({
        code: 'profile_health.unavailable',
        message:
          'profile health/drift requires the snapshot service + Postgres pool to be configured',
      });
      return false;
    }
    return true;
  };

  // GET /health/admin-ui — server-rendered HTML operator surface
  // Registered BEFORE `/health` because Express matches in order and we
  // don't want the JSON route to also resolve `/health/admin-ui`.
  router.get('/health/admin-ui', (_req: Request, res: Response) => {
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'no-store');
    res.send(renderHealthAdminUi());
  });

  // GET /health — latest score per profile (across all deploy-ready snapshots)
  router.get('/health', async (_req: Request, res: Response) => {
    if (!driftGuard(res)) return;
    try {
      const result = await driftPool!.query<{
        profile_id: string;
        snapshot_id: string;
        latest_score: string;
        diverged_count: number;
        computed_at: Date;
      }>(
        `WITH ranked AS (
           SELECT
             ps.profile_id,
             phs.snapshot_id,
             phs.drift_score,
             phs.computed_at,
             phs.diverged_assets,
             ROW_NUMBER() OVER (
               PARTITION BY ps.profile_id
               ORDER BY phs.computed_at DESC
             ) AS rn
           FROM profile_health_score phs
           JOIN profile_snapshot ps ON ps.id = phs.snapshot_id
         )
         SELECT
           profile_id,
           snapshot_id,
           drift_score::text AS latest_score,
           computed_at,
           COALESCE(jsonb_array_length(diverged_assets->'divergedAssets'), 0) AS diverged_count
         FROM ranked
         WHERE rn = 1
         ORDER BY profile_id ASC`,
      );
      res.json({
        profiles: result.rows.map((r) => ({
          profile_id: r.profile_id,
          snapshot_id: r.snapshot_id,
          // Surface 0-100 integer publicly; DB column is the 0-1 fraction.
          latest_score: Math.round(Number(r.latest_score) * 100),
          diverged_count: Number(r.diverged_count),
          computed_at: r.computed_at instanceof Date
            ? r.computed_at.toISOString()
            : new Date(r.computed_at).toISOString(),
        })),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ code: 'profile_health.internal', message });
    }
  });

  // ── Phase 2.4 — Profile-Bundle import (OB-66) ──────────────────────────
  // Mirror image of the OB-83 export path. Operator uploads a .zip Profile-
  // Bundle (`profile-bundle-v1.md`); the route hands it to BundleImporter
  // for hash + whitelist verification, then materialises the result either
  // as a fresh Builder-Draft (default for UUID profile-ids — the shape a
  // Builder snapshot exports) or directly into the live state of an
  // existing Bootstrap-Profile (kebab-case ids, opt-in via `target=profile`
  // and `overwrite=true` if the profile already has live content).
  //
  // Must be registered BEFORE GET /:id so Express doesn't try to match
  // "import-bundle" as a profile id on the read path.

  const importBundleMaxBytes =
    deps.importBundleMaxBytes ?? 50 * 1024 * 1024;
  const importUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: importBundleMaxBytes,
      files: 1,
      fields: 6,
    },
    fileFilter: (_req, file, cb) => {
      const accepted =
        file.mimetype === 'application/zip' ||
        file.mimetype === 'application/x-zip-compressed' ||
        file.mimetype === 'application/octet-stream' ||
        file.originalname.toLowerCase().endsWith('.zip');
      if (accepted) {
        cb(null, true);
        return;
      }
      cb(new Error(`unsupported mimetype: ${file.mimetype}`));
    },
  });

  router.post(
    '/import-bundle',
    (req, res, next) => {
      importUpload.single('file')(req, res, (err: unknown) => {
        if (!err) {
          next();
          return;
        }
        const isMulterError =
          err instanceof multer.MulterError ||
          (typeof err === 'object' && err !== null && 'code' in err);
        const code = isMulterError
          ? String((err as { code?: string }).code ?? 'multipart')
          : 'multipart';
        const message = err instanceof Error ? err.message : String(err);
        const status = code === 'LIMIT_FILE_SIZE' ? 413 : 400;
        res.status(status).json({
          code: `bundle.upload_${code.toLowerCase()}`,
          message,
        });
      });
    },
    async (req: Request, res: Response) => {
      if (!liveStorageGuard(res)) return;
      if (!deps.uploadedPackageStore) {
        res.status(503).json({
          code: 'bundle.import_unavailable',
          message: 'bundle import requires an uploaded package store',
        });
        return;
      }

      const file = (req as Request & { file?: Express.Multer.File }).file;
      if (!file) {
        res.status(400).json({
          code: 'bundle.upload_no_file',
          message: "Feld 'file' (multipart) fehlt.",
        });
        return;
      }

      const body = (req.body ?? {}) as {
        target?: unknown;
        overwrite?: unknown;
        name?: unknown;
      };
      const explicitTarget = parseImportTarget(body.target);
      const overwrite = body.overwrite === 'true' || body.overwrite === true;
      const explicitName =
        typeof body.name === 'string' && body.name.trim().length > 0
          ? body.name.trim()
          : undefined;
      const userEmail = actorOf(req);

      const importer = new ProfileBundleImporter({
        uploadedPackageStore: deps.uploadedPackageStore,
        catalog: deps.catalog,
        ...(deps.packageUploadService
          ? { uploadService: deps.packageUploadService }
          : {}),
        maxBytes: importBundleMaxBytes,
      });

      type Outcome = {
        importedAs: 'draft' | 'profile';
        profileId: string;
        draftId?: string;
        divergedAssets: string[];
        plugins: Array<{
          id: string;
          version: string;
          was_existing: boolean;
          vendored: boolean;
        }>;
        specSource: 'spec_json' | 'agent_md_fallback' | 'profile_no_spec';
      };
      // These slots are written from inside the importer's onPersist
      // closure. TypeScript's control-flow analysis cannot follow closure
      // side-effects into the outer scope, so we widen via a holder object;
      // the property lookups after `await importer.import(…)` then read the
      // freshly-written values without TS narrowing them back to `null`.
      const sideChannel: {
        outcome: Outcome | null;
        conflict: { divergedAssets: string[] } | null;
        specReconstructFailed: SpecReconstructError | null;
      } = { outcome: null, conflict: null, specReconstructFailed: null };

      try {
        const result = await importer.import({
          fileBuffer: file.buffer,
          uploadedBy: userEmail,
          onPersist: async (payload) => {
            const manifestProfileId = payload.manifest.profile.id;
            const target =
              explicitTarget ?? inferImportTarget(manifestProfileId);

            const specJsonEntry = payload.knowledge.find(
              (k) =>
                k.filename === 'knowledge/spec.json' ||
                k.filename === 'spec.json',
            );
            const knowledgeWithoutSpecJson = payload.knowledge.filter(
              (k) =>
                k.filename !== 'knowledge/spec.json' &&
                k.filename !== 'spec.json',
            );

            if (target === 'draft') {
              if (!deps.draftStore) {
                throw new Error(
                  'draft import requested but DraftStore is not configured',
                );
              }
              let reconstructed;
              try {
                reconstructed = reconstructSpecFromBundle({
                  bundleAgentMd: payload.agentMd,
                  bundleSpecJson: specJsonEntry?.content ?? null,
                  fallbackName:
                    explicitName ?? payload.manifest.profile.name,
                });
              } catch (err) {
                if (err instanceof SpecReconstructError) {
                  sideChannel.specReconstructFailed = err;
                  throw err;
                }
                throw err;
              }

              const draft = await deps.draftStore.create(
                userEmail,
                reconstructed.name,
              );
              await deps.draftStore.update(userEmail, draft.id, {
                spec: reconstructed.spec,
                name: reconstructed.name,
              });

              await liveStorage!.setAgentMd(
                draft.id,
                payload.agentMd,
                userEmail,
              );
              for (const k of knowledgeWithoutSpecJson) {
                const filename = k.filename.startsWith('knowledge/')
                  ? k.filename.slice('knowledge/'.length)
                  : k.filename;
                await liveStorage!.setKnowledgeFile(
                  draft.id,
                  filename,
                  k.content,
                  userEmail,
                );
              }

              sideChannel.outcome = {
                importedAs: 'draft',
                profileId: draft.id,
                draftId: draft.id,
                divergedAssets: [],
                plugins: payload.plugins.map((p) => ({
                  id: p.id,
                  version: p.version,
                  was_existing: !p.installed,
                  vendored: p.vendored,
                })),
                specSource: reconstructed.source,
              };
              return;
            }

            // target === 'profile' — write into Bootstrap-Profile live state
            const liveAgent = await liveStorage!.getAgentMd(manifestProfileId);
            const liveKnowledge = await liveStorage!.listKnowledge(
              manifestProfileId,
            );
            const diverged: string[] = [];
            if (liveAgent && liveAgent.sha256 !== payload.manifest.agent.sha256) {
              diverged.push('agent.md');
            }
            for (const k of payload.manifest.knowledge) {
              const baseName = k.file.startsWith('knowledge/')
                ? k.file.slice('knowledge/'.length)
                : k.file;
              const live = liveKnowledge.find((x) => x.filename === baseName);
              if (live && live.sha256 !== k.sha256) {
                diverged.push(k.file);
              }
            }
            if (diverged.length > 0 && !overwrite) {
              sideChannel.conflict = { divergedAssets: diverged };
              throw new Error('bundle import would overwrite live content');
            }

            await liveStorage!.setAgentMd(
              manifestProfileId,
              payload.agentMd,
              userEmail,
            );
            for (const k of knowledgeWithoutSpecJson) {
              const filename = k.filename.startsWith('knowledge/')
                ? k.filename.slice('knowledge/'.length)
                : k.filename;
              await liveStorage!.setKnowledgeFile(
                manifestProfileId,
                filename,
                k.content,
                userEmail,
              );
            }

            sideChannel.outcome = {
              importedAs: 'profile',
              profileId: manifestProfileId,
              divergedAssets: diverged,
              plugins: payload.plugins.map((p) => ({
                id: p.id,
                version: p.version,
                was_existing: !p.installed,
                vendored: p.vendored,
              })),
              specSource: 'profile_no_spec',
            };
          },
        });

        if (!result.ok) {
          // Spec reconstruction errors surface as bundle.persist_failed
          // from the importer; remap to a 400 with a stable code so the
          // operator UI can recognise schema drift and react.
          if (sideChannel.specReconstructFailed) {
            res.status(400).json({
              code: 'bundle.invalid_spec_json',
              message: sideChannel.specReconstructFailed.message,
            });
            return;
          }
          if (sideChannel.conflict) {
            res.status(409).json({
              code: 'bundle.import_conflict',
              message:
                'profile already has live content; pass overwrite=true to replace',
              diverged_assets: sideChannel.conflict.divergedAssets,
            });
            return;
          }
          res.status(mapImportCodeToStatus(result.code)).json({
            code: result.code,
            message: result.message,
          });
          return;
        }

        if (!sideChannel.outcome) {
          res.status(500).json({
            code: 'bundle.import_internal',
            message: 'importer returned ok=true but onPersist did not run',
          });
          return;
        }
        const out = sideChannel.outcome;

        const responseBody: Record<string, unknown> = {
          ok: true,
          imported_as: out.importedAs,
          profile_id: out.profileId,
          plugins_installed: out.plugins,
          diverged_assets: out.divergedAssets,
          spec_source: out.specSource,
        };
        if (out.draftId) responseBody['draft_id'] = out.draftId;
        res.json(responseBody);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({
          code: 'bundle.import_internal',
          message,
        });
      }
    },
  );

  router.get('/:id', async (req: Request, res: Response) => {
    const id = req.params['id'];
    if (typeof id !== 'string' || !PROFILE_ID_PATTERN.test(id)) {
      res.status(400).json({
        code: 'profiles.invalid_id',
        message: 'profile id must be lowercase kebab-case',
      });
      return;
    }

    const profile = await tryLoadProfile(dir, id);
    if (!profile) {
      res.status(404).json({
        code: 'profiles.not_found',
        message: `no profile with id '${id}'`,
      });
      return;
    }
    res.json(profile);
  });

  router.post('/:id/apply', async (req: Request, res: Response) => {
    const id = req.params['id'];
    if (typeof id !== 'string' || !PROFILE_ID_PATTERN.test(id)) {
      res.status(400).json({
        code: 'profiles.invalid_id',
        message: 'profile id must be lowercase kebab-case',
      });
      return;
    }

    const profile = await tryLoadProfile(dir, id);
    if (!profile) {
      res.status(404).json({
        code: 'profiles.not_found',
        message: `no profile with id '${id}'`,
      });
      return;
    }

    try {
      const outcome = await applyProfile(profile, deps);
      res.json(outcome);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ code: 'profiles.apply_failed', message });
    }
  });

  // ── Phase 2.1.5 — live agent.md + knowledge endpoints ──────────────────
  // Unblocks Phase 2.2 (Snapshots) and Phase 2.4 (Export/Import). UI for
  // editing agent.md lands in Phase 2.5 / 3 (Persona-UI); these routes are
  // intentionally thin so tests, rollback, and import flows can write the
  // live state today.

  const liveStorage = deps.liveStorage;
  const liveStorageGuard = (res: Response): boolean => {
    if (!liveStorage) {
      res.status(503).json({
        code: 'profile_storage.unavailable',
        message: 'live profile storage is not configured on this instance',
      });
      return false;
    }
    return true;
  };
  const handleStorageError = (err: unknown, res: Response): void => {
    if (err instanceof ProfileStorageValidationError) {
      res.status(400).json({ code: err.code, message: err.message });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ code: 'profile_storage.internal', message });
  };
  const actorOf = (req: Request): string =>
    req.session?.email ?? req.session?.sub ?? 'unknown';

  // GET /:id/agent-md — read raw markdown
  router.get('/:id/agent-md', async (req: Request, res: Response) => {
    if (!liveStorageGuard(res)) return;
    const id = req.params['id'];
    if (typeof id !== 'string' || !PROFILE_ID_PATTERN.test(id)) {
      res
        .status(400)
        .json({ code: 'profiles.invalid_id', message: 'profile id must be lowercase kebab-case' });
      return;
    }
    try {
      const rec = await liveStorage!.getAgentMd(id);
      if (!rec) {
        res.status(404).json({ code: 'profile_storage.not_found', message: 'no agent.md set for this profile' });
        return;
      }
      res.set('Content-Type', 'text/markdown; charset=utf-8');
      res.set('X-Sha256', rec.sha256);
      res.set('X-Updated-At', rec.updatedAt.toISOString());
      res.set('X-Updated-By', rec.updatedBy);
      res.send(rec.content);
    } catch (err) {
      handleStorageError(err, res);
    }
  });

  // PUT /:id/agent-md — write raw markdown body
  router.put(
    '/:id/agent-md',
    expressRaw({ type: '*/*', limit: MAX_BODY_BYTES }),
    async (req: Request, res: Response) => {
      if (!liveStorageGuard(res)) return;
      const id = req.params['id'];
      if (typeof id !== 'string' || !PROFILE_ID_PATTERN.test(id)) {
        res
          .status(400)
          .json({ code: 'profiles.invalid_id', message: 'profile id must be lowercase kebab-case' });
        return;
      }
      const body = req.body;
      if (!Buffer.isBuffer(body)) {
        res.status(400).json({
          code: 'profile_storage.invalid_body',
          message: 'expected raw body (text/markdown or application/octet-stream)',
        });
        return;
      }
      try {
        const written = await liveStorage!.setAgentMd(id, body, actorOf(req));
        res.json({
          sha256: written.sha256,
          size_bytes: written.sizeBytes,
          updated_at: written.updatedAt.toISOString(),
        });
      } catch (err) {
        handleStorageError(err, res);
      }
    },
  );

  // GET /:id/knowledge — list summaries
  router.get('/:id/knowledge', async (req: Request, res: Response) => {
    if (!liveStorageGuard(res)) return;
    const id = req.params['id'];
    if (typeof id !== 'string' || !PROFILE_ID_PATTERN.test(id)) {
      res
        .status(400)
        .json({ code: 'profiles.invalid_id', message: 'profile id must be lowercase kebab-case' });
      return;
    }
    try {
      const files = await liveStorage!.listKnowledge(id);
      res.json({
        files: files.map((f) => ({
          filename: f.filename,
          sha256: f.sha256,
          size_bytes: f.sizeBytes,
          updated_at: f.updatedAt.toISOString(),
        })),
      });
    } catch (err) {
      handleStorageError(err, res);
    }
  });

  // GET /:id/knowledge/:filename — fetch raw bytes
  router.get('/:id/knowledge/:filename', async (req: Request, res: Response) => {
    if (!liveStorageGuard(res)) return;
    const id = req.params['id'];
    const filename = req.params['filename'];
    if (typeof id !== 'string' || !PROFILE_ID_PATTERN.test(id)) {
      res.status(400).json({ code: 'profiles.invalid_id', message: 'profile id must be lowercase kebab-case' });
      return;
    }
    if (typeof filename !== 'string') {
      res.status(400).json({ code: 'profile_storage.invalid_filename', message: 'filename required' });
      return;
    }
    try {
      const rec = await liveStorage!.getKnowledgeFile(id, filename);
      if (!rec) {
        res.status(404).json({ code: 'profile_storage.not_found', message: `no knowledge file '${filename}'` });
        return;
      }
      res.set('Content-Type', 'application/octet-stream');
      res.set('X-Sha256', rec.sha256);
      res.set('X-Updated-At', rec.updatedAt.toISOString());
      res.set('X-Updated-By', rec.updatedBy);
      res.send(rec.content);
    } catch (err) {
      handleStorageError(err, res);
    }
  });

  // PUT /:id/knowledge/:filename — write raw bytes
  router.put(
    '/:id/knowledge/:filename',
    expressRaw({ type: '*/*', limit: MAX_BODY_BYTES }),
    async (req: Request, res: Response) => {
      if (!liveStorageGuard(res)) return;
      const id = req.params['id'];
      const filename = req.params['filename'];
      if (typeof id !== 'string' || !PROFILE_ID_PATTERN.test(id)) {
        res.status(400).json({ code: 'profiles.invalid_id', message: 'profile id must be lowercase kebab-case' });
        return;
      }
      if (typeof filename !== 'string') {
        res.status(400).json({ code: 'profile_storage.invalid_filename', message: 'filename required' });
        return;
      }
      const body = req.body;
      if (!Buffer.isBuffer(body)) {
        res.status(400).json({
          code: 'profile_storage.invalid_body',
          message: 'expected raw body (octet-stream)',
        });
        return;
      }
      try {
        const written = await liveStorage!.setKnowledgeFile(id, filename, body, actorOf(req));
        res.json({
          filename: written.filename,
          sha256: written.sha256,
          size_bytes: written.sizeBytes,
          updated_at: written.updatedAt.toISOString(),
        });
      } catch (err) {
        handleStorageError(err, res);
      }
    },
  );

  // ── Phase 2.2 — profile-snapshot endpoints ─────────────────────────────
  // Slice D of OB-64. createSnapshot / markDeployReady / rollback write
  // to _admin_audit; diff and read paths are audit-free.

  const snapshotService = deps.snapshotService;
  const auditLog = deps.auditLog;
  const snapshotGuard = (res: Response): boolean => {
    if (!snapshotService || !liveStorage) {
      res.status(503).json({
        code: 'profile_snapshot.unavailable',
        message:
          'profile snapshots require live-storage + snapshot-service to be configured on this instance',
      });
      return false;
    }
    return true;
  };

  const handleSnapshotError = (err: unknown, res: Response): void => {
    if (err instanceof SnapshotNotFoundError) {
      res.status(404).json({ code: err.code, message: err.message });
      return;
    }
    if (err instanceof SnapshotValidationError) {
      res.status(400).json({ code: err.code, message: err.message });
      return;
    }
    if (err instanceof SnapshotIntegrityError) {
      res.status(500).json({ code: err.code, message: err.message });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ code: 'profile_snapshot.internal', message });
  };

  const writeAudit = async (
    action:
      | 'profile_snapshot.create'
      | 'profile_snapshot.mark_deploy_ready'
      | 'profile_snapshot.rollback',
    actorEmail: string,
    target: string,
    after: unknown,
  ): Promise<void> => {
    if (!auditLog) return;
    try {
      await auditLog.record({
        actor: { email: actorEmail },
        action,
        target,
        after,
      });
    } catch (err) {
      // Audit failures must not break the user-visible flow — log + continue.
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[profile-snapshot] audit write failed for ${action}: ${message}`);
    }
  };

  // POST /:id/snapshot — capture the current live state as a new snapshot
  router.post('/:id/snapshot', async (req: Request, res: Response) => {
    if (!snapshotGuard(res)) return;
    const id = req.params['id'];
    if (typeof id !== 'string' || !PROFILE_ID_PATTERN.test(id)) {
      res.status(400).json({ code: 'profiles.invalid_id', message: 'profile id must be lowercase kebab-case' });
      return;
    }
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as {
      notes?: unknown;
      vendor?: unknown;
    };
    const notes =
      typeof body.notes === 'string' && body.notes.length > 0 && body.notes.length <= 1000
        ? body.notes
        : undefined;
    const vendor = body.vendor === true;
    try {
      const result = await snapshotService!.createSnapshot({
        profileId: id,
        createdBy: actorOf(req),
        ...(notes !== undefined ? { notes } : {}),
        vendorPlugins: vendor,
      });
      if (!result.wasExisting) {
        await writeAudit(
          'profile_snapshot.create',
          actorOf(req),
          `profile:${id}:snapshot:${result.snapshotId}`,
          {
            snapshot_id: result.snapshotId,
            bundle_hash: result.bundleHash,
            bundle_size_bytes: result.bundleSizeBytes,
          },
        );
      }
      res.json({
        snapshot_id: result.snapshotId,
        bundle_hash: result.bundleHash,
        bundle_size_bytes: result.bundleSizeBytes,
        created_at: result.createdAt.toISOString(),
        was_existing: result.wasExisting,
      });
    } catch (err) {
      handleSnapshotError(err, res);
    }
  });

  // GET /:id/snapshots — list summaries for a profile
  router.get('/:id/snapshots', async (req: Request, res: Response) => {
    if (!snapshotGuard(res)) return;
    const id = req.params['id'];
    if (typeof id !== 'string' || !PROFILE_ID_PATTERN.test(id)) {
      res.status(400).json({ code: 'profiles.invalid_id', message: 'profile id must be lowercase kebab-case' });
      return;
    }
    try {
      const summaries = await snapshotService!.listSnapshots(id);
      res.json({ snapshots: summaries.map(serializeSummary) });
    } catch (err) {
      handleSnapshotError(err, res);
    }
  });

  // GET /:id/snapshots/:sid — detail with assets + drift
  router.get('/:id/snapshots/:sid', async (req: Request, res: Response) => {
    if (!snapshotGuard(res)) return;
    const id = req.params['id'];
    const sid = req.params['sid'];
    if (typeof id !== 'string' || !PROFILE_ID_PATTERN.test(id) || typeof sid !== 'string') {
      res.status(400).json({ code: 'profiles.invalid_id', message: 'profile id or snapshot id invalid' });
      return;
    }
    try {
      const detail = await snapshotService!.getSnapshot(sid);
      if (!detail || detail.profileId !== id) {
        res.status(404).json({
          code: 'profile_snapshot.not_found',
          message: `no snapshot ${sid} for profile ${id}`,
        });
        return;
      }
      res.json(serializeDetail(detail));
    } catch (err) {
      handleSnapshotError(err, res);
    }
  });

  // GET /:id/snapshots/:sid/download — default serves the inner plugin
  // ZIP (the format the operator can drop straight into
  // /install/packages/upload). Phase 3 (OB-67) Slice 10 packs AGENT.md
  // with persona + quality frontmatter into that ZIP, so the install
  // path now carries the operator's slider settings — the persona-
  // wirkt-im-Output use-case no longer requires the Profile-Bundle.
  //
  // ?format=bundle returns the full Profile-Bundle (manifest +
  // agent.md + plugins.lock + knowledge + plugins/) for the cross-
  // instance migration flow: drop it into POST /api/v1/profiles/
  // import-bundle, get a fresh Builder-Draft with everything restored.
  //
  // If a Builder-Draft snapshot has no plugin ZIP (build failed at
  // capture time), the default download falls back to the bundle and
  // surfaces the build-source view — the operator gets agent.md +
  // spec.json so nothing is lost.
  router.get('/:id/snapshots/:sid/download', async (req: Request, res: Response) => {
    if (!snapshotGuard(res)) return;
    const id = req.params['id'];
    const sid = req.params['sid'];
    if (typeof id !== 'string' || !PROFILE_ID_PATTERN.test(id) || typeof sid !== 'string') {
      res.status(400).json({ code: 'profiles.invalid_id', message: 'profile id or snapshot id invalid' });
      return;
    }
    const requestedFormat = req.query['format'];
    const wantBundle = requestedFormat === 'bundle';
    try {
      const detail = await snapshotService!.getSnapshot(sid);
      if (!detail || detail.profileId !== id) {
        res.status(404).json({
          code: 'profile_snapshot.not_found',
          message: `no snapshot ${sid} for profile ${id}`,
        });
        return;
      }

      const pluginAsset = detail.assets.find(
        (a) => a.path.startsWith('plugins/') && a.path.endsWith('.zip'),
      );
      const slug = composeBundleFilenameSlug(detail);

      // Default: plugin-only ZIP (installable). Falls through to the
      // bundle when no plugin asset exists (legacy / bootstrap snaps).
      if (!wantBundle && pluginAsset) {
        const pluginBuffer = await snapshotService!.getAssetBytes(
          sid,
          pluginAsset.path,
        );
        if (pluginBuffer) {
          const filename = `${slug}-${detail.bundleHash.slice(0, 12)}.zip`;
          res.set('Content-Type', 'application/zip');
          res.set(
            'Content-Disposition',
            `attachment; filename="${filename}"`,
          );
          res.send(pluginBuffer);
          return;
        }
      }

      // Bundle path (?format=bundle, or fallback when plugin asset is
      // missing).
      const buffer = await snapshotService!.assembleBundle(sid);
      if (!buffer) {
        res.status(500).json({
          code: 'profile_snapshot.empty',
          message: `snapshot ${sid} has no asset rows — refusing to serve empty zip`,
        });
        return;
      }
      const filename = `${slug}-${detail.bundleHash.slice(0, 12)}-bundle.zip`;
      res.set('Content-Type', 'application/zip');
      res.set(
        'Content-Disposition',
        `attachment; filename="${filename}"`,
      );
      res.send(buffer);
    } catch (err) {
      handleSnapshotError(err, res);
    }
  });

  // POST /:id/snapshots/:sid/mark-deploy-ready — flip flag + audit
  router.post(
    '/:id/snapshots/:sid/mark-deploy-ready',
    async (req: Request, res: Response) => {
      if (!snapshotGuard(res)) return;
      const id = req.params['id'];
      const sid = req.params['sid'];
      if (typeof id !== 'string' || !PROFILE_ID_PATTERN.test(id) || typeof sid !== 'string') {
        res.status(400).json({ code: 'profiles.invalid_id', message: 'profile id or snapshot id invalid' });
        return;
      }
      try {
        const detail = await snapshotService!.getSnapshot(sid);
        if (!detail || detail.profileId !== id) {
          res.status(404).json({
            code: 'profile_snapshot.not_found',
            message: `no snapshot ${sid} for profile ${id}`,
          });
          return;
        }
        const summary = await snapshotService!.markDeployReady({
          snapshotId: sid,
          operator: actorOf(req),
        });
        await writeAudit(
          'profile_snapshot.mark_deploy_ready',
          actorOf(req),
          `profile:${id}:snapshot:${sid}`,
          { snapshot_id: sid, profile_id: id },
        );
        res.json(serializeSummary(summary));
      } catch (err) {
        handleSnapshotError(err, res);
      }
    },
  );

  // POST /:id/rollback/:sid — restore live state from snapshot bytes
  router.post('/:id/rollback/:sid', async (req: Request, res: Response) => {
    if (!snapshotGuard(res)) return;
    const id = req.params['id'];
    const sid = req.params['sid'];
    if (typeof id !== 'string' || !PROFILE_ID_PATTERN.test(id) || typeof sid !== 'string') {
      res.status(400).json({ code: 'profiles.invalid_id', message: 'profile id or snapshot id invalid' });
      return;
    }
    try {
      const detail = await snapshotService!.getSnapshot(sid);
      if (!detail || detail.profileId !== id) {
        res.status(404).json({
          code: 'profile_snapshot.not_found',
          message: `no snapshot ${sid} for profile ${id}`,
        });
        return;
      }
      const operator = actorOf(req);
      const result = await snapshotService!.rollback({
        snapshotId: sid,
        operator,
        onPersist: async (payload) => {
          // Restore agent.md
          await liveStorage!.setAgentMd(id, payload.agentMd, operator);
          // Restore knowledge files. Strategy: write each captured file,
          // then delete any live file not present in the snapshot. This
          // makes rollback transactional from the operator's view: after
          // it completes, the knowledge dir matches the snapshot exactly.
          const wantedFilenames = new Set<string>();
          for (const k of payload.knowledge) {
            const baseName = k.filename.startsWith('knowledge/')
              ? k.filename.slice('knowledge/'.length)
              : k.filename;
            await liveStorage!.setKnowledgeFile(id, baseName, k.content, operator);
            wantedFilenames.add(baseName);
          }
          const live = await liveStorage!.listKnowledge(id);
          for (const f of live) {
            if (!wantedFilenames.has(f.filename)) {
              await liveStorage!.removeKnowledgeFile(id, f.filename);
            }
          }
        },
      });
      await writeAudit(
        'profile_snapshot.rollback',
        operator,
        `profile:${id}:snapshot:${sid}`,
        {
          snapshot_id: sid,
          profile_id: id,
          bundle_hash: result.rolledBackTo.bundleHash,
          diverged_assets: result.divergedAssets,
        },
      );
      res.json({
        rolled_back_to: {
          snapshot_id: result.rolledBackTo.snapshotId,
          bundle_hash: result.rolledBackTo.bundleHash,
        },
        applied_at: result.appliedAt.toISOString(),
        diverged_assets: result.divergedAssets,
      });
    } catch (err) {
      handleSnapshotError(err, res);
    }
  });

  // GET /:id/health — drift-score history for one profile (newest first, max 30)
  router.get('/:id/health', async (req: Request, res: Response) => {
    if (!driftGuard(res)) return;
    const id = req.params['id'];
    if (typeof id !== 'string' || !PROFILE_ID_PATTERN.test(id)) {
      res.status(400).json({
        code: 'profiles.invalid_id',
        message: 'profile id must be lowercase kebab-case',
      });
      return;
    }
    try {
      const result = await driftPool!.query<{
        snapshot_id: string;
        drift_score: string;
        computed_at: Date;
        diverged_assets: unknown;
      }>(
        `SELECT
           phs.snapshot_id,
           phs.drift_score::text AS drift_score,
           phs.computed_at,
           phs.diverged_assets
         FROM profile_health_score phs
         JOIN profile_snapshot ps ON ps.id = phs.snapshot_id
         WHERE ps.profile_id = $1
         ORDER BY phs.computed_at DESC
         LIMIT 30`,
        [id],
      );
      res.json({
        history: result.rows.map((r) => {
          const payload = (r.diverged_assets ?? {}) as {
            score?: number;
            divergedAssets?: unknown[];
            suggestions?: unknown[];
          };
          return {
            snapshot_id: r.snapshot_id,
            score:
              typeof payload.score === 'number'
                ? payload.score
                : Math.round(Number(r.drift_score) * 100),
            computed_at:
              r.computed_at instanceof Date
                ? r.computed_at.toISOString()
                : new Date(r.computed_at).toISOString(),
            diverged_assets: Array.isArray(payload.divergedAssets)
              ? payload.divergedAssets
              : [],
            suggestions: Array.isArray(payload.suggestions)
              ? payload.suggestions
              : [],
          };
        }),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ code: 'profile_health.internal', message });
    }
  });

  // GET /:id/snapshots/admin-ui — server-rendered HTML operator surface
  router.get('/:id/snapshots/admin-ui', (req: Request, res: Response) => {
    if (!snapshotGuard(res)) return;
    const id = req.params['id'];
    if (typeof id !== 'string' || !PROFILE_ID_PATTERN.test(id)) {
      res.status(400).json({ code: 'profiles.invalid_id', message: 'profile id must be lowercase kebab-case' });
      return;
    }
    res.set('Content-Type', 'text/html; charset=utf-8');
    // No cache — operators expect a click to reflect a fresh snapshot.
    res.set('Cache-Control', 'no-store');
    res.send(renderSnapshotsAdminUi(id));
  });

  // GET /:id/diff?base=<sid|live>&target=<sid|live> — asset-level diff
  router.get('/:id/diff', async (req: Request, res: Response) => {
    if (!snapshotGuard(res)) return;
    const id = req.params['id'];
    if (typeof id !== 'string' || !PROFILE_ID_PATTERN.test(id)) {
      res.status(400).json({ code: 'profiles.invalid_id', message: 'profile id must be lowercase kebab-case' });
      return;
    }
    const baseRaw = req.query['base'];
    const targetRaw = req.query['target'];
    const base = parseDiffSide(baseRaw, id);
    const target = parseDiffSide(targetRaw, id);
    if (!base || !target) {
      res.status(400).json({
        code: 'profile_snapshot.invalid_diff_side',
        message: "base and target must be 'live' or a snapshot UUID",
      });
      return;
    }
    try {
      // For snapshot sides, defensively confirm cross-profile scoping.
      for (const side of [base, target]) {
        if (side.kind === 'snapshot') {
          const detail = await snapshotService!.getSnapshot(side.snapshotId);
          if (!detail || detail.profileId !== id) {
            res.status(404).json({
              code: 'profile_snapshot.not_found',
              message: `no snapshot ${side.snapshotId} for profile ${id}`,
            });
            return;
          }
        }
      }
      const diffs = await snapshotService!.diff({ base, target });
      res.json({
        diffs: diffs.map((d) => ({
          path: d.path,
          status: d.status,
          base_sha256: d.baseSha256,
          target_sha256: d.targetSha256,
        })),
      });
    } catch (err) {
      handleSnapshotError(err, res);
    }
  });

  // DELETE /:id/knowledge/:filename — remove (idempotent)
  router.delete('/:id/knowledge/:filename', async (req: Request, res: Response) => {
    if (!liveStorageGuard(res)) return;
    const id = req.params['id'];
    const filename = req.params['filename'];
    if (typeof id !== 'string' || !PROFILE_ID_PATTERN.test(id)) {
      res.status(400).json({ code: 'profiles.invalid_id', message: 'profile id must be lowercase kebab-case' });
      return;
    }
    if (typeof filename !== 'string') {
      res.status(400).json({ code: 'profile_storage.invalid_filename', message: 'filename required' });
      return;
    }
    try {
      const result = await liveStorage!.removeKnowledgeFile(id, filename);
      res.json({ ok: true, removed: result.removed });
    } catch (err) {
      handleStorageError(err, res);
    }
  });

  return router;
}

async function tryLoadProfile(
  dir: string,
  id: string,
): Promise<Profile | null> {
  // PROFILE_ID_PATTERN already rejected `..` / `/` / dots — but use basename
  // as defence-in-depth so nothing in the lookup escapes the profiles dir.
  const safeId = path.basename(id);
  const file = path.join(dir, `${safeId}.yaml`);
  try {
    return await loadProfile(file);
  } catch (err) {
    if (err instanceof ProfileLoadError) {
      // ENOENT bubbles through ProfileLoadError; treat as 404.
      const cause = (err as { cause?: unknown }).cause as
        | NodeJS.ErrnoException
        | undefined;
      if (cause?.code === 'ENOENT') return null;
    }
    throw err;
  }
}

async function applyProfile(
  profile: Profile,
  deps: ProfilesDeps,
): Promise<ProfileApplyOutcome> {
  const outcome: ProfileApplyOutcome = {
    profile_id: profile.id,
    installed: [],
    skipped: [],
    errored: [],
  };

  for (const entry of profile.plugins) {
    if (deps.registry.has(entry.id)) {
      outcome.skipped.push({ id: entry.id, reason: 'already_installed' });
      continue;
    }

    const catalogEntry = deps.catalog.get(entry.id);
    if (!catalogEntry) {
      outcome.errored.push({
        id: entry.id,
        reason: 'not_in_catalog',
        message: `plugin '${entry.id}' is not in the catalog — drop it from the profile or upload a custom package`,
      });
      continue;
    }

    if (catalogEntry.plugin.install_state === 'incompatible') {
      outcome.errored.push({
        id: entry.id,
        reason: 'incompatible',
        message:
          catalogEntry.plugin.incompatibility_reasons?.join('; ') ??
          'plugin is marked incompatible',
      });
      continue;
    }

    try {
      await deps.registry.register({
        id: entry.id,
        installed_version: catalogEntry.plugin.version,
        installed_at: new Date().toISOString(),
        status: 'active',
        config: entry.config,
      });
      outcome.installed.push({
        id: entry.id,
        version: catalogEntry.plugin.version,
      });
    } catch (err) {
      outcome.errored.push({
        id: entry.id,
        reason: 'register_failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return outcome;
}

function toProfileSummary(profile: Profile): {
  id: string;
  name: string;
  description: string;
  plugin_count: number;
  plugin_ids: string[];
} {
  return {
    id: profile.id,
    name: profile.name,
    description: profile.description,
    plugin_count: profile.plugins.length,
    plugin_ids: profile.plugins.map((p) => p.id),
  };
}

// ── snapshot serialisation helpers ──────────────────────────────────────────

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function serializeSummary(s: SnapshotSummary): Record<string, unknown> {
  return {
    snapshot_id: s.snapshotId,
    profile_id: s.profileId,
    profile_version: s.profileVersion,
    bundle_hash: s.bundleHash,
    bundle_size_bytes: s.bundleSizeBytes,
    created_at: s.createdAt.toISOString(),
    created_by: s.createdBy,
    notes: s.notes,
    is_deploy_ready: s.isDeployReady,
    deploy_ready_at: s.deployReadyAt ? s.deployReadyAt.toISOString() : null,
    deploy_ready_by: s.deployReadyBy,
  };
}

function serializeDetail(d: SnapshotDetail): Record<string, unknown> {
  return {
    ...serializeSummary(d),
    drift_score: d.driftScore,
    manifest_yaml: d.manifestYaml,
    assets: d.assets.map((a) => ({
      path: a.path,
      sha256: a.sha256,
      size_bytes: a.sizeBytes,
    })),
  };
}

function parseDiffSide(raw: unknown, profileId: string): DiffSide | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  if (raw === 'live') return { kind: 'live', profileId };
  if (UUID_PATTERN.test(raw)) return { kind: 'snapshot', snapshotId: raw };
  return null;
}

/**
 * Build a filesystem-safe slug for the snapshot download.
 *
 * Resolution order:
 *  1. `identity.id` parsed out of the captured agent.md frontmatter
 *     (the operator-authored reverse-DNS plugin id, e.g.
 *     `de.byte5.agent.calendar`) — most useful when an export is later
 *     dropped next to other plugin ZIPs.
 *  2. Slugified `profile.name` from the manifest YAML.
 *  3. Bare `profile_id` as the last resort.
 */
function composeBundleFilenameSlug(detail: SnapshotDetail): string {
  const fromAgent = parseAgentIdentityIdFromManifest(detail.manifestYaml);
  if (fromAgent) return slugifyForFilename(fromAgent);
  const fromName = parseProfileNameFromManifest(detail.manifestYaml);
  if (fromName) return slugifyForFilename(fromName);
  return slugifyForFilename(detail.profileId);
}

/**
 * Cheap line-based parsers — pulling in `yaml` here just to read two
 * scalars would inflate the route module. The manifest is generated by
 * the zipper in a known shape (top-level `profile:` and `agent:`
 * blocks), so a regex-grep is sufficient and keeps this layer light.
 * If the manifest format ever changes, the slug fallback chain still
 * produces a usable filename.
 */
function parseProfileNameFromManifest(manifestYaml: string): string | null {
  // matches `  name: "Some Name"` or `  name: Some Name` inside the
  // profile block
  const match = /\n\s*profile:\s*\n(?:\s+[^\n]*\n)*?\s+name:\s*"?([^"\n]+?)"?\s*\n/.exec(
    `\n${manifestYaml}`,
  );
  if (!match) return null;
  const v = match[1]?.trim();
  return v && v.length > 0 ? v : null;
}

function parseAgentIdentityIdFromManifest(manifestYaml: string): string | null {
  // The bundle manifest doesn't carry the agent identity directly — but
  // when agent.md frontmatter is embedded later via Phase 3 we'll add
  // it. Today this returns null; keeping the hook so the slug pipeline
  // can promote it without touching the call site.
  void manifestYaml;
  return null;
}

// ── Phase 2.4 — import-bundle helpers ──────────────────────────────────────

function parseImportTarget(raw: unknown): 'draft' | 'profile' | undefined {
  if (raw === 'draft' || raw === 'profile') return raw;
  return undefined;
}

/**
 * Builder snapshots use the draft UUID as `profile.id`; Bootstrap-Profile
 * snapshots ship with the kebab-case id (`production`, `kg-neon`, …).
 * The bundle manifest schema accepts both, so the import path needs a
 * heuristic to default the persistence target. Operators can override
 * via the `target` form field.
 */
function inferImportTarget(profileId: string): 'draft' | 'profile' {
  return UUID_PATTERN.test(profileId) ? 'draft' : 'profile';
}

const IMPORT_CODE_TO_STATUS: Record<ImportErrorCode, number> = {
  'bundle.invalid_zip': 400,
  'bundle.too_large': 413,
  'bundle.missing_manifest': 400,
  'bundle.invalid_manifest': 400,
  'bundle.missing_agent_md': 400,
  'bundle.missing_plugins_lock': 400,
  'bundle.unsupported_spec_version': 400,
  'bundle.hash_mismatch': 400,
  'bundle.agent_hash_mismatch': 400,
  'bundle.knowledge_hash_mismatch': 400,
  'bundle.unknown_plugin': 400,
  'bundle.plugin_sha_mismatch': 400,
  'bundle.vendored_plugin_missing': 400,
  'bundle.vendored_install_failed': 502,
  'bundle.foreign_top_level': 400,
  'bundle.persist_failed': 500,
};

function mapImportCodeToStatus(code: ImportErrorCode): number {
  return IMPORT_CODE_TO_STATUS[code] ?? 500;
}

function slugifyForFilename(input: string): string {
  const trimmed = input.trim().toLowerCase();
  // collapse anything that isn't alphanumeric, dot, dash, or underscore
  const cleaned = trimmed
    .normalize('NFKD')
    .replace(/[^\p{Letter}\p{Number}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  if (cleaned.length === 0) return 'snapshot';
  return cleaned.length > 60 ? cleaned.slice(0, 60) : cleaned;
}
