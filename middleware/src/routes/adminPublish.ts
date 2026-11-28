/**
 * #2320 — read-only admin view of published apps (#581, ADR-0067). Mounted at
 * `/api/v1/admin/publish` behind `requireAuth`.
 *
 *   GET /apps                    → every app: live version, newest version, count
 *   GET /apps/:appId/versions    → the immutable version log of one app
 *
 * Nothing here deploys or rolls back: a rollback is the `publish_rollback`
 * tool with its owner/grant check (`publishAccess.ts`). Postgres only — the
 * in-memory store lives inside the orchestrator plugin's process state and
 * is not readable from here; without a pool both routes answer 503
 * `publish_admin.unavailable`.
 */

import { Router, type Request, type Response } from 'express';

import type { PublishStore } from '@omadia/publish';

import type { PublishAppSummary } from '../services/publishAppCatalog.js';

export interface AdminPublishRouteDeps {
  readonly store?: Pick<PublishStore, 'listVersions' | 'getPointer'>;
  readonly listApps?: () => Promise<readonly PublishAppSummary[]>;
}

/** The publish tool's own appId rule (`publishTool.ts`). */
const APP_ID_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;

function unavailable(res: Response): void {
  res.status(503).json({
    code: 'publish_admin.unavailable',
    message: 'the version list needs the Postgres database',
  });
}

export function createAdminPublishRouter(deps: AdminPublishRouteDeps): Router {
  const router = Router();

  router.get('/apps', async (_req: Request, res: Response): Promise<void> => {
    if (!deps.listApps) {
      unavailable(res);
      return;
    }
    try {
      const apps = await deps.listApps();
      res.json({
        apps: apps.map((a) => ({
          app_id: a.appId,
          name: a.name,
          current_version: a.currentVersion,
          latest_version: a.latestVersion,
          version_count: a.versionCount,
          updated_at: a.updatedAt.toISOString(),
        })),
      });
    } catch (err) {
      console.error('[admin-publish] app list failed:', err);
      res.status(500).json({ code: 'publish_admin.list_failed', message: 'could not list published apps' });
    }
  });

  router.get('/apps/:appId/versions', async (req: Request, res: Response): Promise<void> => {
    if (!deps.store) {
      unavailable(res);
      return;
    }
    const appId = req.params.appId as string;
    if (!APP_ID_RE.test(appId)) {
      res.status(400).json({ code: 'publish_admin.invalid_app', message: 'appId is a lowercase, hyphen-safe slug' });
      return;
    }
    try {
      const [versions, pointer] = await Promise.all([deps.store.listVersions(appId), deps.store.getPointer(appId)]);
      if (versions.length === 0) {
        res.status(404).json({ code: 'publish_admin.not_found', message: 'no published app with that id' });
        return;
      }
      const current = pointer?.currentVersion ?? null;
      res.json({
        app_id: appId,
        current_version: current,
        versions: [...versions]
          .sort((a, b) => b.version - a.version)
          .map((v) => ({
            version: v.version,
            name: v.name,
            entrypoint: v.entrypoint,
            dir_hash: v.dirHash,
            source_scope_key: v.sourceScopeKey,
            created_at: v.createdAt.toISOString(),
            current: v.version === current,
          })),
      });
    } catch (err) {
      console.error('[admin-publish] version list failed:', err);
      res.status(500).json({ code: 'publish_admin.list_failed', message: 'could not list the versions' });
    }
  });

  return router;
}
