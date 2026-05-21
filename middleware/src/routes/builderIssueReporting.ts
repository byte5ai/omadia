import { randomUUID } from 'node:crypto';

import type { Router, Request, Response } from 'express';

import type { DraftStore } from '../plugins/builder/draftStore.js';
import type { GithubIssueCache } from '../plugins/builder/githubIssueCache.js';
import type { SpecEventBus } from '../plugins/builder/specEventBus.js';
import type { UserChoiceCoordinator } from '../plugins/builder/userChoiceCoordinator.js';
import type {
  AgentSpecSkeleton,
  IssueRef,
  TranscriptEntry,
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
  /** Optional bus reference for emitting `auto_resume_available`
   *  when the resume route fires. Without it, the route still works
   *  but loses the multi-tab notification. */
  bus?: SpecEventBus;
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

  router.post(
    '/drafts/:id/resume-from-issue',
    async (req: Request, res: Response) => {
      const email = readEmail(req);
      if (!email) return sendJson(res, 401, { code: 'auth.missing' });
      const draftId = readParam(req, 'id');
      if (!draftId) return sendJson(res, 400, { code: 'builder.invalid_id' });
      const draft = await deps.store.load(email, draftId);
      if (!draft) return sendJson(res, 404, { code: 'builder.draft_not_found' });

      const pause = draft.spec.builder_settings?.paused_on_issue;
      if (!pause) {
        return sendJson(res, 409, {
          code: 'builder.not_paused',
          message: 'Draft is not paused on any issue.',
        });
      }

      const owner = pause.issueRef.owner;
      const repo = pause.issueRef.repo;
      const status = await deps.githubIssueCache.getIssueStatus(
        owner,
        repo,
        pause.issueRef.number,
      );
      const force = (req.body ?? {}) as { force?: unknown };
      const isForce = force.force === true;

      if (!isForce && (!status || status.state !== 'closed')) {
        return sendJson(res, 409, {
          code: 'builder.issue_still_open',
          message:
            'Upstream issue is still open. Pass { "force": true } to resume anyway and try without waiting.',
          issueState: status?.state ?? 'unknown',
        });
      }

      const briefingLines = [
        `Resume after pause on issue #${String(pause.issueRef.number)} (${pause.issueRef.url}).`,
        `State: ${status?.state ?? 'unknown'}${
          status?.closedAt ? `, closed at ${new Date(status.closedAt).toISOString()}` : ''
        }.`,
        '',
        'Please re-evaluate whether the platform fix shipped lets us drop',
        'the workaround. If yes: remove the workaround from the spec and',
        'rebuild. If the issue is still open and the operator forced',
        'resume, continue from where the build stopped without removing',
        'the workaround.',
      ];
      const briefingTurn: TranscriptEntry = {
        role: 'user',
        content: briefingLines.join('\n'),
        timestamp: Date.now(),
      };

      const nextSpec = clearPauseOnIssue(draft.spec);
      const updated = await deps.store.update(email, draftId, {
        spec: nextSpec,
        transcript: [...draft.transcript, briefingTurn],
      });
      if (!updated) {
        return sendJson(res, 500, {
          code: 'builder.resume_persist_failed',
        });
      }
      if (deps.bus) {
        deps.bus.emit(draftId, {
          type: 'auto_resume_available',
          issueRef: pause.issueRef,
          closedAt: status?.closedAt ?? null,
        });
      }
      return sendJson(res, 200, {
        ok: true,
        resumedAt: briefingTurn.timestamp,
        issueState: status?.state ?? 'unknown',
        forced: isForce,
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
      ...spec.builder_settings,
      auto_fix_enabled: spec.builder_settings?.auto_fix_enabled ?? false,
      workarounds: [...filtered, workaround],
    },
  };
}

function clearPauseOnIssue(spec: AgentSpecSkeleton): AgentSpecSkeleton {
  if (!spec.builder_settings?.paused_on_issue) return spec;
  const { paused_on_issue: _drop, ...rest } = spec.builder_settings;
  void _drop;
  return {
    ...spec,
    builder_settings: {
      ...rest,
      auto_fix_enabled: rest.auto_fix_enabled ?? false,
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
