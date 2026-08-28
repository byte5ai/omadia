import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

import type { UpdateAuditStore } from '../update/auditStore.js';
import type { ReleaseLookup } from '../update/releaseLookup.js';
import { releaseIsNewer } from '../update/releaseLookup.js';
import { parseVersion, toTag } from '../update/semver.js';
import type {
  UpdaterClient,
  UpdaterFailure,
  UpdaterPhase,
} from '../update/updaterClient.js';
import type { PlatformInfo } from '../update/platform.js';
import type { AppVersion } from '../update/version.js';

/**
 * Operator-facing self-update surface (#432).
 *
 * Mounted at `/api/v1/admin/update` behind `requireAuth` (cookie session JWT),
 * the same admin surface the Danger Zone uses — not the machine-to-machine
 * `ADMIN_TOKEN` path, because this is driven from a logged-in browser.
 *
 * Five routes with sharply different risk:
 *   GET  /status    — read-only; always answers, even offline / without executor
 *   GET  /releases  — the versions the operator may pick between
 *   GET  /preflight — read-only: are this version's images actually pullable?
 *   GET  /history   — the audit trail
 *   POST /          — the destructive one: audited, then handed to the sidecar
 *
 * The POST deliberately returns 202 and does not wait: applying the update
 * recreates the very container serving the request, so awaiting a result here
 * would guarantee a dropped connection that the UI could only read as failure.
 * The client polls `GET /status` instead.
 *
 * There is no type-to-confirm gate. It was modelled on the Danger Zone, but
 * the two are not the same risk: a memory purge is irreversible, whereas an
 * update is version-pinned, health-gated and rolled back automatically when
 * the new build does not come up. Retyping the tag proved nothing the picker
 * does not already establish — the operator selects the version explicitly —
 * so it was pure friction on the way to a reversible action. The real
 * safeguards stay: a release tag is still the only accepted target, the audit
 * row is still written before the handoff, and `/preflight` now shows whether
 * the images exist BEFORE anything is touched.
 */

const UpdateBodySchema = z.object({
  targetVersion: z.string().min(1).max(64),
  /** Accepted and ignored — older admin pages still send it. */
  confirm: z.string().optional(),
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
  /** Where this instance runs. Only used to make the notify-only instructions
   *  concrete — it never gates anything. */
  platform: PlatformInfo;
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
      previousVersion?: string | null;
      startedAt?: string | null;
      finishedAt?: string | null;
      error?: string;
      steps?: readonly string[];
      phase?: UpdaterPhase | null;
      failure?: UpdaterFailure | null;
      engine?: string;
      pinPersisted?: boolean;
    } = { configured: false, reachable: false };

    if (deps.updater) {
      const status = await deps.updater.getStatus();
      executor = status.ok
        ? {
            configured: true,
            reachable: true,
            state: status.status.state,
            targetVersion: status.status.targetVersion,
            previousVersion: status.status.previousVersion,
            startedAt: status.status.startedAt,
            finishedAt: status.status.finishedAt,
            steps: status.status.steps,
            // Structured progress + outcome so the page can render a stepper
            // and decode a failed health gate instead of parsing `steps`.
            // Normalised to null (not undefined) so the JSON shape is stable
            // whether or not the sidecar is new enough to send them.
            phase: status.status.phase ?? null,
            failure: status.status.failure ?? null,
            // #696 — the executor tells us which platform it drives and
            // whether it can make the chosen version stick. Both are passed
            // through so the UI can warn instead of implying a guarantee the
            // Fly path cannot give.
            ...(status.status.engine !== undefined
              ? { engine: status.status.engine }
              : {}),
            ...(status.status.pinPersisted !== undefined
              ? { pinPersisted: status.status.pinPersisted }
              : {}),
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
      // Lets the admin page print the operator's ACTUAL manual command instead
      // of one with `<middleware-app>` in it. Non-sensitive: a Fly app name is
      // already public in the app's hostname.
      platform: deps.platform,
    });
  });

  /**
   * The versions the operator may choose between. Deliberately not filtered to
   * "newer than current": a rollback to a known-good build is the single most
   * useful thing this page can offer when something is wrong, and the update
   * job treats a downgrade like any other pinned target.
   */
  router.get('/releases', async (req: Request, res: Response) => {
    const force = req.query['refresh'] === 'true';
    const list = await deps.releaseLookup.list(force);
    res.json({
      releases: list.releases,
      current: { version: current.version, source: current.source },
      check: {
        checkedAt: list.checkedAt,
        stale: list.stale,
        ...(list.error !== undefined ? { error: list.error } : {}),
      },
    });
  });

  /**
   * Read-only: would this version's images actually pull? Answering it before
   * the trigger is the whole point — the same check runs inside the job, but
   * by then the operator has already committed to the run.
   */
  router.get('/preflight', async (req: Request, res: Response) => {
    const raw = req.query['targetVersion'];
    const targetVersion = typeof raw === 'string' ? raw.trim() : '';
    if (parseVersion(targetVersion) === null) {
      res.status(400).json({ error: 'invalid_target_version' });
      return;
    }
    if (!deps.updater) {
      res.status(409).json({ error: 'updater_not_configured' });
      return;
    }
    const result = await deps.updater.preflight(toTag(targetVersion));
    if (!result.ok) {
      // An older sidecar has no /preflight and answers 404. That is "cannot
      // check", not "not available" — the UI must not render it as a missing
      // image and talk the operator out of a perfectly good update.
      res.status(result.status === 404 ? 501 : 502).json({
        error: result.status === 404 ? 'preflight_unsupported' : 'preflight_failed',
        message: result.error,
      });
      return;
    }
    res.json(result.result);
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
    const { targetVersion } = parsed.data;

    // Only a pinnable release tag is accepted. `latest` / `edge` / `sha-…`
    // are rejected on purpose: this value is written into the project `.env`
    // and used as a Docker image tag, and a floating tag makes both the
    // rollback target and the health gate undecidable.
    if (parseVersion(targetVersion) === null) {
      res.status(400).json({ error: 'invalid_target_version' });
      return;
    }
    const target = toTag(targetVersion);

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
