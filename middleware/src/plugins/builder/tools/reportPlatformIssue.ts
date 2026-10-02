import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { sanitizeIssueBody } from '../issueBodySanitizer.js';
import type { BuilderTool } from './types.js';

/**
 * `omadia_report_core_bug` — operator-confirmed reporting of core bugs
 * into the upstream repo. (Renamed off `report_platform_issue`; see the
 * id comment on the tool below.)
 *
 * Run logic:
 *
 *   0. Wiring. Without upstream-issue config, issue cache and triage
 *      log the tool does nothing and returns `mode='unavailable'`.
 *
 *   1. Dedup. If the GitHub issue cache finds an open or closed issue
 *      matching the fingerprint, return `mode='reused'` with the
 *      existing ref. The agent then attaches the workaround to that
 *      issue instead of creating a new one.
 *
 *   2. Rate-limit. The per-operator quota (default 3 platform-class
 *      submissions / 24 h) is checked against the triage log. When
 *      exceeded the tool returns `mode='rate_limited'` so the agent
 *      can surface a clear message and keep moving without an issue.
 *
 *   3. Sanitize. Body is run through the secret/URL/size sanitizer;
 *      the sanitized body is what the operator approves.
 *
 *   4. Submit, on one of two paths — the server picks, not the agent:
 *
 *      a. `mode='created-pending'`, when a GitHub App is wired for an
 *         allowlisted upstream: the operator confirms the sanitized
 *         body, then the create-issue route files the issue as the bot.
 *      b. `mode='browser-submit'` otherwise: the tool builds the
 *         pre-populated `github.com/.../issues/new?...` URL, the UI
 *         opens it in a new tab, and the operator submits under their
 *         own account; the confirm-issue route POSTs the resulting
 *         issue-number back.
 *
 *      Both paths validate the bot-label + fingerprint marker before
 *      persisting the workaround, and the irreversible POST always
 *      happens in a route after an explicit operator confirm — never
 *      autonomously in `run`.
 *
 * There is deliberately no PAT code path and no vault lookup here, so
 * the tool cannot regress into a half-working insecure mode.
 */

const InputSchema = z
  .object({
    title: z.string().min(8).max(180),
    body: z.string().min(1).max(200_000),
    fingerprint: z.string().min(8).max(64),
    /**
     * Human-readable headline ("Workaround removed double-encoding").
     * Internal triage-log label only — not the GitHub issue title (that
     * is `title`). Capped at 500 chars so a full sentence fits without
     * hard-failing the report; the `.describe()` surfaces the cap into
     * the tool's JSON schema so the agent generates a compliant value.
     */
    summary: z
      .string()
      .min(1)
      .max(500)
      .describe('One-line headline for the triage log (≤500 chars, keep it concise).'),
    severity: z.enum(['bug', 'gap', 'inconsistency']),
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

export type ReportMode =
  | 'reused'
  | 'created-pending'
  | 'browser-submit'
  | 'rate_limited'
  | 'unavailable';

export interface ReportPlatformIssueResult {
  ok: boolean;
  mode: ReportMode;
  /** Set when `mode === 'reused'`: the existing issue ref. */
  reusedIssue?: {
    owner: string;
    repo: string;
    number: number;
    url: string;
    state: 'open' | 'closed';
  };
  /** Set when `mode === 'browser-submit'`: the URL to open + pending id. */
  browserSubmit?: {
    githubNewUrl: string;
    pendingId: string;
    fingerprintMarker: string;
  };
  /**
   * Set when `mode === 'created-pending'`: the server can file the issue
   * directly via the GitHub App, but only after the operator confirms the
   * sanitized body. The UI shows `sanitizedBody`, and on confirm POSTs to
   * the `workarounds/create-issue` route (which performs the actual,
   * irreversible create server-side). No GitHub tab is opened.
   */
  directSubmit?: {
    pendingId: string;
    fingerprintMarker: string;
  };
  /** Sanitized issue body. Empty for `reused` / `rate_limited`. */
  sanitizedBody?: string;
  redactions?: Array<{ kind: string; index: number; length: number }>;
  /** Hint for the UI when `mode === 'rate_limited'`. */
  rateLimit?: { used: number; cap: number; windowHours: number };
  /** Reason string when `mode === 'unavailable'`. */
  reason?: string;
}

const DEFAULT_RATE_LIMIT_CAP = 3;
const RATE_LIMIT_WINDOW_HOURS = 24;

export const reportPlatformIssueTool: BuilderTool<Input, ReportPlatformIssueResult> = {
  // Renamed off `report_platform_issue` (Issue #206): that id collided
  // with the Anthropic platform-injected tool of the same name, which
  // shadowed this native tool so the agent's call went to Anthropic
  // instead of the omadia repo. `omadia_`-prefixed ids cannot be
  // shadowed by provider-side tools.
  id: 'omadia_report_core_bug',
  description:
    'File an omadia CORE bug into the upstream repo. ' +
    'Use only after `ask_user_choice` returned `report_workaround` or ' +
    '`report_pause` for a platform-classified triage. The tool first ' +
    'checks for a duplicate via fingerprint, then enforces the per-' +
    'operator daily rate limit, then sanitizes the body. When the server ' +
    'has a GitHub App wired (mode=created-pending) the operator confirms ' +
    'the sanitized body and the issue is filed directly by the bot; ' +
    'otherwise (mode=browser-submit) a pre-populated GitHub tab opens and ' +
    'the operator submits under their own account. Either way the round-' +
    'trip validates the bot-label + fingerprint marker before the ' +
    'workaround is persisted — nothing reaches the public repo unconfirmed.',
  input: InputSchema,
  async run(input, ctx): Promise<ReportPlatformIssueResult> {
    if (!ctx.upstreamIssueConfig || !ctx.githubIssueCache || !ctx.triageLog) {
      return {
        ok: false,
        mode: 'unavailable',
        reason: 'issue reporting deps are not wired on this instance',
      };
    }

    const { owner, repo, labels } = ctx.upstreamIssueConfig;

    // 1. Dedup against existing issues.
    const existing = await ctx.githubIssueCache.searchByFingerprint(
      owner,
      repo,
      input.fingerprint,
      labels,
    );
    if (existing) {
      return {
        ok: true,
        mode: 'reused',
        reusedIssue: {
          owner,
          repo,
          number: existing.number,
          url: existing.url,
          state: existing.state,
        },
      };
    }

    // 2. Rate-limit pro Operator.
    const used = ctx.triageLog.platformCountInWindow(ctx.userEmail);
    if (used >= DEFAULT_RATE_LIMIT_CAP) {
      return {
        ok: false,
        mode: 'rate_limited',
        rateLimit: {
          used,
          cap: DEFAULT_RATE_LIMIT_CAP,
          windowHours: RATE_LIMIT_WINDOW_HOURS,
        },
      };
    }

    // 3. Sanitize body.
    const fingerprintMarker = `<!-- omadia-fingerprint: ${input.fingerprint} -->`;
    const enrichedBody = `${input.body.trim()}\n\n${fingerprintMarker}\n`;
    const sanitized = sanitizeIssueBody(enrichedBody);

    const pendingId = randomUUID();

    // 4a. Direct-create available (GitHub App wired + allowlisted upstream):
    //     hand the operator a confirm step on the *sanitized* body. The
    //     actual irreversible POST happens server-side in the create-issue
    //     route only after that confirm — never autonomously here.
    if (ctx.directIssueCreateAvailable) {
      // Surface a confirm card on every open tab. The actual filing happens
      // only when the operator confirms via the create-issue route.
      ctx.bus.emit(ctx.draftId, {
        type: 'issue_report_pending',
        pendingId,
        mode: 'created-pending',
        title: input.title,
        summary: input.summary,
        fingerprint: input.fingerprint,
        fingerprintMarker,
        sanitizedBody: sanitized.body,
      });
      return {
        ok: true,
        mode: 'created-pending',
        directSubmit: { pendingId, fingerprintMarker },
        sanitizedBody: sanitized.body,
        redactions: sanitized.redactions,
      };
    }

    // 4b. Fallback: browser-submit URL the operator opens + submits under
    //     their own GitHub account.
    const params = new URLSearchParams({
      title: input.title,
      body: sanitized.body,
      labels: labels.join(','),
    });
    const githubNewUrl = `https://github.com/${owner}/${repo}/issues/new?${params.toString()}`;

    ctx.bus.emit(ctx.draftId, {
      type: 'issue_report_pending',
      pendingId,
      mode: 'browser-submit',
      title: input.title,
      summary: input.summary,
      fingerprint: input.fingerprint,
      fingerprintMarker,
      sanitizedBody: sanitized.body,
      githubNewUrl,
    });

    return {
      ok: true,
      mode: 'browser-submit',
      browserSubmit: {
        githubNewUrl,
        pendingId,
        fingerprintMarker,
      },
      sanitizedBody: sanitized.body,
      redactions: sanitized.redactions,
    };
  },
};
