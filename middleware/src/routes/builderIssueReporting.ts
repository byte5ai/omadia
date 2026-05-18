import { randomUUID } from 'node:crypto';

import type { Router, Request, Response } from 'express';

import type { DraftStore } from '../plugins/builder/draftStore.js';
import type { GithubIssueCache } from '../plugins/builder/githubIssueCache.js';
import type { UserChoiceCoordinator } from '../plugins/builder/userChoiceCoordinator.js';
import type {
  AgentSpecSkeleton,
  IssueRef,
  Workaround,
} from '../plugins/builder/types.js';

/**
 * Native issue-reporting routes (concept plan: docs/plans/native-issue-
 * reporting.md). Provides:
 *
 *   POST /drafts/:id/user-choice/:choiceId      — resolve a pending
 *                                                  ask_user_choice
 *   POST /drafts/:id/workarounds/confirm-issue  — confirm browser-
 *                                                  submitted issue
 *                                                  number, persist
 *                                                  workaround
 *
 * Mount via `registerBuilderIssueReportingRoutes(router, deps)`.
 *
 * All endpoints require an admin session. Drafts are owner-scoped
 * via DraftStore — a foreign user cannot resolve choices or persist
 * workarounds on another operator's draft.
 */

export interface BuilderIssueReportingDeps {
  store: DraftStore;
  userChoice: UserChoiceCoordinator;
  githubIssueCache: GithubIssueCache;
  upstream: {
    owner: string;
    repo: string;
    /** Labels every confirmed issue must carry. */
    requiredLabels: readonly string[];
  };
}

export function registerBuilderIssueReportingRoutes(
  router: Router,
  deps: BuilderIssueReportingDeps,
): void {
  router.post(
    '/drafts/:id/user-choice/:choiceId',
    async (req: Request, res: Response) => {
      const email = readEmail(req);
      if (!email) return sendJson(res, 401, { code: 'auth.missing' });
      const draftId = readParam(req, 'id');
      const choiceId = readParam(req, 'choiceId');
      if (!draftId || !choiceId) {
        return sendJson(res, 400, { code: 'builder.invalid_path_params' });
      }

      const draft = await deps.store.load(email, draftId);
      if (!draft) return sendJson(res, 404, { code: 'builder.draft_not_found' });

      const body = (req.body ?? {}) as { value?: unknown; cancel?: unknown };
      if (body.cancel === true) {
        const ok = deps.userChoice.cancel({ draftId, choiceId });
        return sendJson(res, ok ? 200 : 404, {
          ok,
          ...(ok ? {} : { code: 'builder.user_choice_not_found' }),
        });
      }
      if (typeof body.value !== 'string' || body.value.length === 0) {
        return sendJson(res, 400, {
          code: 'builder.user_choice_invalid_value',
        });
      }
      const ok = deps.userChoice.resolve({
        draftId,
        choiceId,
        value: body.value,
      });
      return sendJson(res, ok ? 200 : 404, {
        ok,
        ...(ok ? {} : { code: 'builder.user_choice_not_found' }),
      });
    },
  );

  router.post(
    '/drafts/:id/workarounds/confirm-issue',
    async (req: Request, res: Response) => {
      const email = readEmail(req);
      if (!email) return sendJson(res, 401, { code: 'auth.missing' });
      const draftId = readParam(req, 'id');
      if (!draftId) {
        return sendJson(res, 400, { code: 'builder.invalid_id' });
      }

      const body = (req.body ?? {}) as {
        issueNumber?: unknown;
        fingerprint?: unknown;
        summary?: unknown;
        owner?: unknown;
        repo?: unknown;
      };
      const issueNumber = toPositiveInt(body.issueNumber);
      const fingerprint = toNonEmptyString(body.fingerprint);
      const summary = toNonEmptyString(body.summary);
      const owner = toNonEmptyString(body.owner) ?? deps.upstream.owner;
      const repo = toNonEmptyString(body.repo) ?? deps.upstream.repo;
      if (!issueNumber || !fingerprint || !summary) {
        return sendJson(res, 400, {
          code: 'builder.confirm_issue_invalid_payload',
          message:
            'issueNumber (positive integer), fingerprint, and summary are required',
        });
      }

      const draft = await deps.store.load(email, draftId);
      if (!draft) return sendJson(res, 404, { code: 'builder.draft_not_found' });

      const verdict = await deps.githubIssueCache.validateIssueMatchesFingerprint(
        owner,
        repo,
        issueNumber,
        fingerprint,
        deps.upstream.requiredLabels,
      );
      if (!verdict.ok) {
        return sendJson(res, 422, {
          code: `builder.confirm_issue_${verdict.reason}`,
          message: confirmFailureMessage(verdict.reason),
          details: verdict.details,
        });
      }

      const issueRef: IssueRef = {
        owner,
        repo,
        number: issueNumber,
        url: verdict.url,
      };
      const newWorkaround: Workaround = {
        id: randomUUID(),
        issueRef,
        fingerprint,
        summary,
        createdAt: Date.now(),
      };
      const nextSpec = appendWorkaround(draft.spec, newWorkaround);
      const updated = await deps.store.update(email, draftId, {
        spec: nextSpec,
      });
      if (!updated) {
        return sendJson(res, 500, {
          code: 'builder.confirm_issue_persist_failed',
        });
      }

      return sendJson(res, 200, {
        ok: true,
        workaround: newWorkaround,
        issueState: verdict.state,
        closedAt: verdict.closedAt,
      });
    },
  );
}

// ── helpers ─────────────────────────────────────────────────────────────────

function appendWorkaround(
  spec: AgentSpecSkeleton,
  workaround: Workaround,
): AgentSpecSkeleton {
  const existing = spec.builder_settings?.workarounds ?? [];
  // Idempotency: dedup by fingerprint.
  const filtered = existing.filter((w) => w.fingerprint !== workaround.fingerprint);
  return {
    ...spec,
    builder_settings: {
      auto_fix_enabled: spec.builder_settings?.auto_fix_enabled ?? false,
      ...spec.builder_settings,
      workarounds: [...filtered, workaround],
    },
  };
}

function confirmFailureMessage(reason: string): string {
  switch (reason) {
    case 'not_found':
      return 'Issue does not exist in the upstream repo.';
    case 'fingerprint_mismatch':
      return 'Issue body does not contain the omadia fingerprint marker — this issue was not created by the builder.';
    case 'missing_labels':
      return 'Issue is missing the required from-builder-bot / needs-triage labels.';
    case 'fetch_failed':
      return 'Could not fetch the issue from GitHub — check the upstream config or rate limits.';
    default:
      return 'Issue validation failed.';
  }
}

function readEmail(req: Request): string | null {
  const email = req.session?.email;
  return typeof email === 'string' && email.length > 0 ? email : null;
}

function readParam(req: Request, name: string): string | null {
  const raw = req.params[name];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

function toPositiveInt(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) return null;
  return n;
}

function toNonEmptyString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function sendJson(
  res: Response,
  status: number,
  body: Record<string, unknown>,
): Response {
  return res.status(status).json(body);
}
