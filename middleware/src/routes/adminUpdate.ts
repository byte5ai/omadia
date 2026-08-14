import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

import type { UpdateAuditStore } from '../update/auditStore.js';
import type { ReleaseLookup } from '../update/releaseLookup.js';
import { releaseIsNewer } from '../update/releaseLookup.js';
import { parseVersion, toTag } from '../update/semver.js';
import type { UpdaterClient } from '../update/updaterClient.js';
import type { AppVersion } from '../update/version.js';

/**
 * Operator-facing self-update surface (#432).
 *
 * Mounted at `/api/v1/admin/update` behind `requireAuth` (cookie session JWT),
 * the same admin surface the Danger Zone uses — not the machine-to-machine
 * `ADMIN_TOKEN` path, because this is driven from a logged-in browser.
 *
 * Three routes with sharply different risk:
 *   GET  /status   — read-only; always answers, even offline / without executor
 *   GET  /history  — the audit trail
 *   POST /         — the destructive one: type-to-confirm enforced SERVER-side
 *                    (`routes/memoryPurge.ts` pattern), audited, then handed to
 *                    the sidecar
 *
 * The POST deliberately returns 202 and does not wait: applying the update
 * recreates the very container serving the request, so awaiting a result here
 * would guarantee a dropped connection that the UI could only read as failure.
 * The client polls `GET /status` instead.
 */

const UpdateBodySchema = z.object({
  targetVersion: z.string().min(1).max(64),
  confirm: z.string(),
});

export interface AdminUpdateDeps {
  /** The build this process is running — see `update/version.ts`. */
  currentVersion: AppVersion;
  releaseLookup: ReleaseLookup;
  /** Absent ⇒ notify-only mode: status still works, POST returns 409. */
  updater?: UpdaterClient;
  /** Absent ⇒ no Postgres (in-memory boot / tests): the audit trail is
   *  reported as unavailable and a trigger is refused, because an
   *  unauditable one-click stack replacement is not a trade worth making. */
  audit?: UpdateAuditStore;
}

export function createAdminUpdateRouter(deps: AdminUpdateDeps): Router {
  const router = Router();
  const current = deps.currentVersion;

  router.get('/status', async (req: Request, res: Response) => {
    const force = req.query['refresh'] === 'true';
    const lookup = await deps.releaseLookup.get(force);

    // Settle any 'requested' row now that a middleware is answering again —
    // this is the only moment we can prove which version actually came up.
    if (deps.audit && current.source !== 'unknown') {
      try {
        await deps.audit.reconcileOpenEntries(toTag(current.version));
      } catch (err) {
        console.error(
          '[admin-update] audit reconcile failed:',
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    let executor: {
      configured: boolean;
      reachable: boolean;
      state?: string;
      targetVersion?: string | null;
      error?: string;
      steps?: readonly string[];
    } = { configured: false, reachable: false };

    if (deps.updater) {
      const status = await deps.updater.getStatus();
      executor = status.ok
        ? {
            configured: true,
            reachable: true,
            state: status.status.state,
            targetVersion: status.status.targetVersion,
            steps: status.status.steps,
            ...(status.status.error !== null
              ? { error: status.status.error }
              : {}),
          }
        : { configured: true, reachable: false, error: status.error };
    }

    res.json({
      current: { version: current.version, source: current.source },
      latest: lookup.release,
      updateAvailable: releaseIsNewer(current.version, lookup.release),
      check: {
        checkedAt: lookup.checkedAt,
        stale: lookup.stale,
        ...(lookup.error !== undefined ? { error: lookup.error } : {}),
      },
      executor,
      auditAvailable: deps.audit !== undefined,
    });
  });

  router.get('/history', async (_req: Request, res: Response) => {
    if (!deps.audit) {
      res.json({ entries: [], available: false });
      return;
    }
    try {
      res.json({ entries: await deps.audit.list(), available: true });
    } catch (err) {
      res.status(500).json({
        error: 'update_history_failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  router.post('/', async (req: Request, res: Response) => {
    const parsed = UpdateBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: 'invalid_request', issues: parsed.error.issues });
      return;
    }
    const { targetVersion, confirm } = parsed.data;

    // Only a pinnable release tag is accepted. `latest` / `edge` / `sha-…`
    // are rejected on purpose: this value is written into the project `.env`
    // and used as a Docker image tag, and a floating tag makes both the
    // rollback target and the health gate undecidable.
    if (parseVersion(targetVersion) === null) {
      res.status(400).json({ error: 'invalid_target_version' });
      return;
    }
    const target = toTag(targetVersion);

    // Server-side type-to-confirm — the operator retypes the exact target tag.
    // Compared against the CANONICAL form so `0.75.0` typed against a `v0.75.0`
    // target still has to match the tag the operator was shown.
    if (toTag(confirm.trim()) !== target) {
      res.status(400).json({ error: 'confirmation_mismatch' });
      return;
    }

    if (!deps.updater) {
      res.status(409).json({ error: 'updater_not_configured' });
      return;
    }
    if (!deps.audit) {
      res.status(409).json({ error: 'audit_unavailable' });
      return;
    }
    if (current.source === 'release' && toTag(current.version) === target) {
      res.status(400).json({ error: 'already_on_target' });
      return;
    }

    const status = await deps.updater.getStatus();
    if (!status.ok) {
      res.status(502).json({ error: 'updater_unreachable', message: status.error });
      return;
    }
    if (status.status.state === 'updating') {
      res.status(409).json({ error: 'update_in_progress' });
      return;
    }

    // Audit BEFORE handing off. A row for an update that never started is a
    // recoverable annoyance; an executed stack replacement with no record is
    // not, and this process is about to be killed by the thing it triggers.
    let entryId: string;
    try {
      const entry = await deps.audit.recordRequest({
        actor: req.session?.email ?? 'unknown',
        fromVersion: current.version,
        toVersion: target,
      });
      entryId = entry.id;
    } catch (err) {
      res.status(500).json({
        error: 'audit_write_failed',
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const accepted = await deps.updater.requestUpdate(target);
    if (!accepted.ok) {
      res.status(502).json({
        error: 'updater_rejected',
        message: accepted.error,
        auditId: entryId,
      });
      return;
    }

    // 202: accepted, not done. The stack restart happens out of band and this
    // connection dies with it — the UI polls /status for the new version.
    res.status(202).json({ accepted: true, targetVersion: target, auditId: entryId });
  });

  return router;
}
