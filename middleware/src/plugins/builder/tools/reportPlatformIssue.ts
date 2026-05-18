import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { sanitizeIssueBody } from '../issueBodySanitizer.js';
import type { BuilderTool } from './types.js';

/**
 * `report_platform_issue` — browser-submit-only path for v1 (concept
 * plan: docs/plans/native-issue-reporting.md).
 *
 * Run logic:
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
 *   4. Browser submit. The tool builds the pre-populated
 *      `github.com/.../issues/new?...` URL and returns it. The UI
 *      opens it in a new tab, waits for the operator to submit, then
 *      POSTs the resulting issue-number back via the confirm-issue
 *      route. That route validates the marker + label, then persists
 *      the workaround.
 *
 * v1 does NOT support PAT-backed direct creation — that lands in
 * v1.2b with the encrypted vault. The tool deliberately has no PAT
 * code path so it cannot regress into a half-working insecure mode.
 */

const InputSchema = z
  .object({
    title: z.string().min(8).max(180),
    body: z.string().min(1).max(200_000),
    fingerprint: z.string().min(8).max(64),
    /** Human-readable one-liner ("Workaround removed double-encoding"). */
    summary: z.string().min(1).max(280),
    severity: z.enum(['bug', 'gap', 'inconsistency']),
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

export type ReportMode = 'reused' | 'browser-submit' | 'rate_limited' | 'unavailable';

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
  id: 'report_platform_issue',
  description:
    'Open a pre-populated GitHub issue tab for the operator to submit. ' +
    'Use only after `ask_user_choice` returned `report_workaround` or ' +
    '`report_pause` for a platform-classified triage. The tool first ' +
    'checks for a duplicate via fingerprint, then enforces the per-' +
    'operator daily rate limit, then sanitizes the body. The operator ' +
    'submits the issue under their own GitHub account; v1 does NOT ' +
    'support PAT-backed direct creation. After the operator submits, ' +
    'the UI confirms the resulting issue number via the confirm-issue ' +
    'route — that round-trip validates the bot-label + fingerprint ' +
    'marker before the workaround is persisted.',
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

    // 4. Build browser-submit URL.
    const pendingId = randomUUID();
    const params = new URLSearchParams({
      title: input.title,
      body: sanitized.body,
      labels: labels.join(','),
    });
    const githubNewUrl = `https://github.com/${owner}/${repo}/issues/new?${params.toString()}`;

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
