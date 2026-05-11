import type { Router, Request, Response } from 'express';

import {
  installDraft,
  type InstallDraftDeps,
  type InstallFailureReason,
  type InstallResult,
} from '../plugins/builder/installCommit.js';
import {
  cloneFromInstalled,
  type CloneFailureReason,
  type CloneFromInstalledDeps,
  type CloneResult,
} from '../plugins/builder/cloneFromInstalled.js';

/**
 * Builder install-commit + edit-from-store routes (Phase B.6-1, B.6-3).
 *
 *   POST /drafts/:id/install                  (B.6-1, install-commit)
 *   POST /drafts/from-installed/:agentId      (B.6-3, edit-from-store)
 *
 * Both share the install-adjacent dependency surface (DraftStore + an extra
 * orchestrator dep) so they live in the same module. Owner-scoped — drafts
 * belonging to user A are unreachable for user B (DraftStore queries always
 * filter by `user_email`).
 *
 * Status mapping for /install (`InstallFailureReason`):
 *   draft_not_found    → 404
 *   conflict           → 409  (id collision with built-in or duplicate version)
 *   too_large          → 413
 *   spec_invalid       → 422  (Zod validation failed)
 *   codegen_failed     → 422  (CodegenError, contains issue list)
 *   build_failed       → 422  (tsc / sandbox failure)
 *   manifest_invalid   → 422  (manifest.yaml or package.json mismatch)
 *   pipeline_failed    → 500  (staging / unexpected pipeline error)
 *   ingest_failed      → 500  (unmapped ingest failure)
 *
 * Status mapping for /from-installed (`CloneFailureReason`):
 *   source_not_found   → 404  (no source draft for this agent_id + user)
 *   quota_exceeded     → 409  (user is at the draft cap)
 *
 * Success of /install returns 200 with `{ ok, installedAgentId, version,
 * packageBytes }` — the InstallDiffModal redirects to
 * `/store?highlight=<installedAgentId>`.
 *
 * Success of /from-installed returns 201 with `{ ok, draftId, sourceDraftId,
 * installedAgentId }` — the store-page Edit-button redirects to
 * `/store/builder/<draftId>`.
 */

export interface BuilderInstallDeps
  extends InstallDraftDeps,
    CloneFromInstalledDeps {}

export function registerBuilderInstallRoutes(
  router: Router,
  deps: BuilderInstallDeps,
): void {
  router.post(
    '/drafts/:id/install',
    async (req: Request, res: Response) => {
      const email = readEmail(req);
      if (!email) {
        return sendJson(res, 401, {
          code: 'auth.missing',
          message: 'no session',
        });
      }
      const draftId = readId(req);
      if (!draftId) {
        return sendJson(res, 400, {
          code: 'builder.invalid_id',
          message: 'missing :id',
        });
      }

      let result: InstallResult;
      try {
        result = await installDraft({ userEmail: email, draftId }, deps);
      } catch (err) {
        return sendJson(res, 500, {
          code: 'builder.install_failed',
          message: err instanceof Error ? err.message : String(err),
        });
      }

      if (result.ok) {
        return sendJson(res, 200, {
          ok: true,
          installedAgentId: result.installedAgentId,
          version: result.version,
          packageBytes: result.packageBytes,
        });
      }

      const status = statusForReason(result.reason);
      const body: Record<string, unknown> = {
        ok: false,
        reason: result.reason,
        code: result.code,
        message: result.message,
      };
      if (result.details !== undefined) body.details = result.details;
      return sendJson(res, status, body);
    },
  );

  router.post(
    '/drafts/from-installed/:agentId',
    async (req: Request, res: Response) => {
      const email = readEmail(req);
      if (!email) {
        return sendJson(res, 401, {
          code: 'auth.missing',
          message: 'no session',
        });
      }
      const agentId = readAgentId(req);
      if (!agentId) {
        return sendJson(res, 400, {
          code: 'builder.invalid_agent_id',
          message: 'missing :agentId',
        });
      }

      let result: CloneResult;
      try {
        result = await cloneFromInstalled(
          { userEmail: email, installedAgentId: agentId },
          deps,
        );
      } catch (err) {
        return sendJson(res, 500, {
          code: 'builder.clone_failed',
          message: err instanceof Error ? err.message : String(err),
        });
      }

      if (result.ok) {
        return sendJson(res, 201, {
          ok: true,
          draftId: result.draftId,
          sourceDraftId: result.sourceDraftId,
          installedAgentId: result.installedAgentId,
        });
      }

      const status = statusForCloneReason(result.reason);
      const body: Record<string, unknown> = {
        ok: false,
        reason: result.reason,
        code: result.code,
        message: result.message,
      };
      if (result.details !== undefined) body.details = result.details;
      return sendJson(res, status, body);
    },
  );
}

// ---------------------------------------------------------------------------

function statusForReason(reason: InstallFailureReason): number {
  switch (reason) {
    case 'draft_not_found':
      return 404;
    case 'conflict':
      return 409;
    case 'too_large':
      return 413;
    case 'spec_invalid':
    case 'codegen_failed':
    case 'build_failed':
    case 'manifest_invalid':
      return 422;
    case 'pipeline_failed':
    case 'ingest_failed':
    default:
      return 500;
  }
}

function statusForCloneReason(reason: CloneFailureReason): number {
  switch (reason) {
    case 'source_not_found':
      return 404;
    case 'quota_exceeded':
      return 409;
    default:
      return 500;
  }
}

function readEmail(req: Request): string | null {
  const email = req.session?.email;
  return typeof email === 'string' && email.length > 0 ? email : null;
}

function readId(req: Request): string | null {
  const raw = req.params['id'];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

function readAgentId(req: Request): string | null {
  const raw = req.params['agentId'];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

function sendJson(
  res: Response,
  status: number,
  body: Record<string, unknown>,
): Response {
  return res.status(status).json(body);
}
