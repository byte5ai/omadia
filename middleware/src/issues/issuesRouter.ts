/**
 * In-app issue reporting: the operator writes a free-form note, the
 * primary connected LLM reformulates it into a clean English GitHub
 * issue, the operator reviews it, and it is filed to byte5ai/omadia as
 * the operator's OWN GitHub account.
 *
 * GitHub auth uses the **device flow** (only a public client id, no
 * secret), so omadia can ship with byte5's OAuth App baked in. Every
 * route is behind requireAuth — there is no public OAuth callback (the
 * device flow has no browser redirect).
 *
 *   GET  /github/status          -> { connected, login, oauthConfigured }
 *   POST /github/connect/start   -> { userCode, verificationUri, expiresIn, interval }
 *   POST /github/connect/poll    -> { status: pending|authorized|expired|denied|error, login? }
 *   POST /github/disconnect      -> { ok }
 *   POST /preview                -> { title, body, category, diagnostics? }
 *   POST /create                 -> { number, htmlUrl }
 *
 * `diagnostics` (both routes, optional, issue #433): a client-captured
 * stack-trace/log excerpt. It is never sent to the LLM reformulator — logs
 * go verbatim (post-sanitization), not through the rephrasing pass. It is
 * redacted with the same secrets scanner as the rest of the body FIRST,
 * over the full excerpt, and only then given its own tail-truncation
 * (newest lines kept — the opposite of the sanitizer's head-preserving
 * default, since the newest log lines are the useful ones) before being
 * appended as a collapsed `<details>` block. Redaction must run before
 * truncation, not after — truncating first can cut the prefix a secret
 * pattern needs to match out of the kept window, letting the credential
 * itself survive unredacted. See `buildDiagnosticsBlock` below. GitHub's
 * REST API has no file-attachment endpoint, so an inline collapsed block
 * is the only mechanism available.
 *
 * Express-4 caveat (see routes/adminProviders.ts): async handlers must
 * try/catch internally — Express 4 does not forward async rejections.
 */

import { Router, type Request, type Response } from 'express';

import {
  resolveLlmProvider,
  type LlmProvider,
  type LlmProviderCatalog,
} from '@omadia/llm-provider';

import type { SecretVault } from '../secrets/vault.js';
import type { InstalledRegistry } from '../plugins/installedRegistry.js';
import type {
  CreateIssueInput,
  CreateIssueResult,
} from '../plugins/builder/githubIssueCreator.js';
import { loadUpstreamIssueConfig } from '../plugins/builder/upstreamIssueConfig.js';
import { sanitizeIssueBody } from '../plugins/builder/issueBodySanitizer.js';

import { GITHUB_ISSUE_SCOPES } from './githubOAuthProvider.js';
import type { GitHubDeviceFlowProvider } from './githubOAuthProvider.js';
import { DeviceFlowStore } from './deviceFlowStore.js';
import {
  clearConnection,
  getConnection,
  getToken,
  saveConnection,
} from './operatorGithubStore.js';
import {
  isIssueCategory,
  reformulateIssue,
  type IssueCategory,
} from './issueReformulator.js';

const ORCHESTRATOR_ID = '@omadia/orchestrator';
const DEFAULT_PROVIDER_ID = 'anthropic';
const MAX_TEXT_LEN = 5000;
const MAX_TITLE_LEN = 120;
const MAX_BODY_LEN = 20000;
// Diagnostics get their own, smaller cap so an attached log excerpt cannot
// crowd out the description. MAX_DIAGNOSTICS_INPUT_LEN bounds what the
// client may submit; MAX_DIAGNOSTICS_BYTES is the tail-truncated size that
// actually ends up in the filed issue.
const MAX_DIAGNOSTICS_INPUT_LEN = 20000;
const MAX_DIAGNOSTICS_BYTES = 8 * 1024;

const LABELS_BY_CATEGORY: Record<IssueCategory, readonly string[]> = {
  bug: ['bug'],
  feature: ['enhancement'],
  improvement: ['enhancement'],
};

const CATEGORY_LABEL: Record<IssueCategory, string> = {
  bug: 'Bug',
  feature: 'Feature',
  improvement: 'Improvement',
};

type IssueCreator = {
  createIssue(input: CreateIssueInput): Promise<CreateIssueResult>;
};

export interface IssuesRouterDeps {
  vault: SecretVault;
  installedRegistry: InstalledRegistry;
  llmProviderCatalog: LlmProviderCatalog;
  /** GitHub device-flow provider, or null when no client id is configured. */
  githubProvider: GitHubDeviceFlowProvider | null;
  /** Builds an issue creator bound to the operator's bearer token. */
  createIssueCreator: (getToken: () => Promise<string>) => IssueCreator;
  /** Test seam: override how the primary LLM is resolved. */
  resolveLlm?: () => Promise<{ provider: LlmProvider; model: string } | null>;
  /** Test seam: inject a deterministic device-flow store. */
  deviceStore?: DeviceFlowStore;
}

export function createIssuesRouter(deps: IssuesRouterDeps): Router {
  const router = Router();
  const deviceStore = deps.deviceStore ?? new DeviceFlowStore();
  const scopes = [...GITHUB_ISSUE_SCOPES];
  const resolveLlm = deps.resolveLlm ?? (() => defaultResolveLlm(deps));
  // Per-operator throttles: bound device-code spam, LLM cost (preview),
  // and public-repo issue flooding (create).
  const startLimiter = new RateLimiter(10, 5 * 60 * 1000);
  const previewLimiter = new RateLimiter(20, 5 * 60 * 1000);
  const createLimiter = new RateLimiter(5, 10 * 60 * 1000);

  // ---- GET /github/status --------------------------------------------
  router.get('/github/status', async (req: Request, res: Response) => {
    try {
      const sub = req.session?.sub;
      if (!sub) {
        res.status(401).json({ code: 'unauthorized' });
        return;
      }
      const conn = await getConnection(deps.vault, sub);
      res.json({
        connected: conn.connected,
        login: conn.login ?? null,
        oauthConfigured: deps.githubProvider !== null,
      });
    } catch {
      res.status(500).json({ code: 'status_failed' });
    }
  });

  // ---- POST /github/connect/start (device flow) ----------------------
  router.post('/github/connect/start', async (req: Request, res: Response) => {
    try {
      const sub = req.session?.sub;
      if (!sub) {
        res.status(401).json({ code: 'unauthorized' });
        return;
      }
      if (!deps.githubProvider) {
        res.status(503).json({ code: 'github_oauth_unconfigured' });
        return;
      }
      if (!startLimiter.allow(sub)) {
        res.status(429).json({ code: 'rate_limited' });
        return;
      }
      const dc = await deps.githubProvider.requestDeviceCode(scopes);
      deviceStore.start(sub, dc.deviceCode, dc.interval, dc.expiresIn);
      // device_code is the secret half — it stays server-side.
      res.json({
        userCode: dc.userCode,
        verificationUri: dc.verificationUri,
        expiresIn: dc.expiresIn,
        interval: dc.interval,
      });
    } catch {
      res.status(502).json({ code: 'connect_start_failed' });
    }
  });

  // ---- POST /github/connect/poll -------------------------------------
  router.post('/github/connect/poll', async (req: Request, res: Response) => {
    try {
      const sub = req.session?.sub;
      if (!sub) {
        res.status(401).json({ code: 'unauthorized' });
        return;
      }
      if (!deps.githubProvider) {
        res.status(503).json({ code: 'github_oauth_unconfigured' });
        return;
      }
      const flow = deviceStore.get(sub);
      if (!flow) {
        res.json({ status: 'expired' });
        return;
      }
      // Throttle server-side so clients can't poll GitHub faster than the
      // advertised interval (GitHub would otherwise answer slow_down).
      if (deviceStore.isTooSoon(sub)) {
        res.json({ status: 'pending' });
        return;
      }
      deviceStore.markPolled(sub);
      const result = await deps.githubProvider.pollAccessToken(flow.deviceCode);
      switch (result.status) {
        case 'authorized': {
          let login = '';
          try {
            login = await deps.githubProvider.fetchUserLogin(result.accessToken);
          } catch {
            // non-fatal: connection still works without a display handle
          }
          await saveConnection(deps.vault, sub, {
            accessToken: result.accessToken,
            login,
            scope: result.scope,
          });
          deviceStore.delete(sub);
          res.json({ status: 'authorized', login: login || null });
          return;
        }
        case 'slow_down':
          deviceStore.bumpInterval(sub, result.interval);
          res.json({ status: 'pending', interval: result.interval });
          return;
        case 'pending':
          res.json({ status: 'pending' });
          return;
        case 'expired':
          deviceStore.delete(sub);
          res.json({ status: 'expired' });
          return;
        case 'denied':
          deviceStore.delete(sub);
          res.json({ status: 'denied' });
          return;
        default:
          res.json({ status: 'error' });
          return;
      }
    } catch {
      res.status(500).json({ code: 'connect_poll_failed' });
    }
  });

  // ---- POST /github/disconnect ---------------------------------------
  router.post('/github/disconnect', async (req: Request, res: Response) => {
    try {
      const sub = req.session?.sub;
      if (!sub) {
        res.status(401).json({ code: 'unauthorized' });
        return;
      }
      deviceStore.delete(sub);
      await clearConnection(deps.vault, sub);
      res.json({ ok: true });
    } catch {
      res.status(500).json({ code: 'disconnect_failed' });
    }
  });

  // ---- POST /preview --------------------------------------------------
  router.post('/preview', async (req: Request, res: Response) => {
    try {
      const sub = req.session?.sub;
      if (!sub) {
        res.status(401).json({ code: 'unauthorized' });
        return;
      }
      if (!previewLimiter.allow(sub)) {
        res.status(429).json({ code: 'rate_limited' });
        return;
      }
      const body = (req.body ?? {}) as {
        text?: unknown;
        category?: unknown;
        diagnostics?: unknown;
      };
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      const category = body.category;
      if (!text || text.length > MAX_TEXT_LEN) {
        res.status(400).json({ code: 'invalid_text' });
        return;
      }
      if (!isIssueCategory(category)) {
        res.status(400).json({ code: 'invalid_category' });
        return;
      }
      const diagnostics = parseDiagnosticsField(body.diagnostics);
      if (!diagnostics.ok) {
        res.status(400).json({ code: 'invalid_diagnostics' });
        return;
      }
      const llm = await resolveLlm();
      if (!llm) {
        res.status(503).json({ code: 'llm_unconfigured' });
        return;
      }
      let result;
      try {
        result = await reformulateIssue({
          provider: llm.provider,
          model: llm.model,
          rawText: text,
          category,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[issues] reformulate failed (provider=${llm.provider.id}, model=${llm.model}):`,
          msg,
        );
        // Surface provider quota / rate-limit distinctly so the operator
        // knows it's a billing/throttling issue, not a phrasing failure.
        const rateLimited = /\b429\b|quota|rate[ _-]?limit/i.test(msg);
        res
          .status(rateLimited ? 429 : 502)
          .json({ code: rateLimited ? 'llm_rate_limited' : 'reformulate_failed' });
        return;
      }
      res.json({
        title: result.title,
        body: result.body,
        category,
        // Sanitized/truncated up front so the operator reviews the exact
        // block that /create will append — never round-tripped through the
        // LLM above.
        ...(diagnostics.value
          ? { diagnostics: buildDiagnosticsBlock(diagnostics.value) }
          : {}),
      });
    } catch {
      res.status(500).json({ code: 'preview_failed' });
    }
  });

  // ---- POST /create ---------------------------------------------------
  router.post('/create', async (req: Request, res: Response) => {
    try {
      const sub = req.session?.sub;
      if (!sub) {
        res.status(401).json({ code: 'unauthorized' });
        return;
      }
      if (!createLimiter.allow(sub)) {
        res.status(429).json({ code: 'rate_limited' });
        return;
      }
      const body = (req.body ?? {}) as {
        title?: unknown;
        body?: unknown;
        category?: unknown;
        diagnostics?: unknown;
      };
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      const issueBody = typeof body.body === 'string' ? body.body.trim() : '';
      const category = body.category;
      if (!title || title.length > MAX_TITLE_LEN) {
        res.status(400).json({ code: 'invalid_title' });
        return;
      }
      if (!issueBody || issueBody.length > MAX_BODY_LEN) {
        res.status(400).json({ code: 'invalid_body' });
        return;
      }
      if (!isIssueCategory(category)) {
        res.status(400).json({ code: 'invalid_category' });
        return;
      }
      const diagnostics = parseDiagnosticsField(body.diagnostics);
      if (!diagnostics.ok) {
        res.status(400).json({ code: 'invalid_diagnostics' });
        return;
      }
      const token = await getToken(deps.vault, sub);
      if (!token) {
        res.status(409).json({ code: 'github_not_connected' });
        return;
      }
      const conn = await getConnection(deps.vault, sub);
      const upstream = loadUpstreamIssueConfig();
      // Defang operator/LLM content before it lands publicly under the
      // operator's real GitHub identity: no @mention pings, no #ref
      // cross-link spam, no raw HTML (tracking pixels). The footer is
      // trusted server content, so it is built AFTER sanitizing.
      const safeTitle = sanitizeIssueText(title);
      const safeBody = sanitizeIssueText(issueBody);
      // The diagnostics block is server-generated markup (a `<details>`
      // wrapper around already-sanitized text) — it must NOT go through
      // sanitizeIssueText a second time, or that would escape our own
      // `<details>`/`<summary>` tags the same way it defangs LLM-authored
      // HTML.
      const diagnosticsBlock = diagnostics.value
        ? buildDiagnosticsBlock(diagnostics.value)
        : '';
      const footer = `\n\n<sub>Filed via the omadia in-app issue reporter${
        conn.login ? ` by @${conn.login}` : ''
      }.</sub>`;
      const fullBody = `**Type:** ${CATEGORY_LABEL[category]}\n\n${safeBody}${diagnosticsBlock}${footer}`;
      const creator = deps.createIssueCreator(() => Promise.resolve(token));
      const result = await creator.createIssue({
        owner: upstream.owner,
        repo: upstream.repo,
        title: safeTitle,
        body: fullBody,
        labels: LABELS_BY_CATEGORY[category],
      });
      if (!result.ok) {
        res.status(statusForReason(result.reason)).json({
          code: `github_${result.reason}`,
        });
        return;
      }
      res.json({ number: result.number, htmlUrl: result.url });
    } catch {
      res.status(500).json({ code: 'create_failed' });
    }
  });

  return router;
}

async function defaultResolveLlm(
  deps: IssuesRouterDeps,
): Promise<{ provider: LlmProvider; model: string } | null> {
  const cfg = deps.installedRegistry.get(ORCHESTRATOR_ID)?.config ?? {};
  const providerId =
    (typeof cfg['llm_provider'] === 'string' && cfg['llm_provider']) ||
    DEFAULT_PROVIDER_ID;
  const model =
    (typeof cfg['orchestrator_model'] === 'string' && cfg['orchestrator_model']) ||
    defaultModelFor(providerId);
  const provider = await resolveLlmProvider({
    providerId,
    getSecret: (k) => deps.vault.get(ORCHESTRATOR_ID, k),
    catalog: deps.llmProviderCatalog,
    maxRetries: 3,
  });
  if (!provider) {
    console.warn(
      `[issues] no LLM provider resolved (providerId=${providerId}) — is the primary provider's API key set?`,
    );
    return null;
  }
  return { provider, model };
}

function defaultModelFor(providerId: string): string {
  switch (providerId) {
    case 'openai':
      return 'gpt-4o-mini';
    case 'mistral':
      return 'mistral-small-latest';
    default:
      return 'claude-haiku-4-5';
  }
}

function statusForReason(
  reason: Extract<CreateIssueResult, { ok: false }>['reason'],
): number {
  switch (reason) {
    case 'auth':
      return 401;
    case 'forbidden':
      return 403;
    case 'validation':
      return 422;
    case 'rate_limited':
      return 429;
    default:
      return 502;
  }
}

/** Minimal sliding-window per-key rate limiter (in-memory, single
 *  process). Entries self-prune on access, so the map stays bounded by
 *  the set of recently-active operators. */
class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  allow(key: string): boolean {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter(
      (ts) => t - ts < this.windowMs,
    );
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(key, recent);
    return true;
  }
}

/** Neutralize notification/reference/HTML vectors in operator- or
 *  LLM-authored text before it is filed into the public repo under the
 *  operator's own GitHub identity. A zero-width space after the sigil
 *  keeps the text readable while stopping GitHub from linking it. */
function sanitizeIssueText(input: string): string {
  const zwsp = String.fromCharCode(0x200b); // zero-width space — breaks the link, stays invisible
  return input
    .replace(/(^|[^\w`/])@([a-z\d])/gi, (_m, p1: string, p2: string) => `${p1}@${zwsp}${p2}`)
    .replace(/(^|[^\w`])#(\d)/g, (_m, p1: string, p2: string) => `${p1}#${zwsp}${p2}`)
    .replace(/<(\/?[a-zA-Z][^>]*)>/g, '&lt;$1&gt;');
}

type DiagnosticsField = { ok: true; value: string | null } | { ok: false };

/** Validate the optional `diagnostics` field shared by /preview and
 *  /create: absent/empty is fine (opt-in, default off), anything else must
 *  be a string within MAX_DIAGNOSTICS_INPUT_LEN. */
function parseDiagnosticsField(raw: unknown): DiagnosticsField {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: null };
  if (trimmed.length > MAX_DIAGNOSTICS_INPUT_LEN) return { ok: false };
  return { ok: true, value: trimmed };
}

/** Keep the newest `maxBytes` bytes of `raw`, dropping the oldest content.
 *  This is the opposite of sanitizeIssueBody's own size cap (which keeps
 *  the head) — a log/stack excerpt is most useful at its tail, where the
 *  triggering error is. */
function truncateDiagnosticsTail(
  raw: string,
  maxBytes: number,
): { text: string; truncatedBytes: number } {
  const encoded = new TextEncoder().encode(raw);
  if (encoded.length <= maxBytes) {
    return { text: raw, truncatedBytes: 0 };
  }
  const truncatedBytes = encoded.length - maxBytes;
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const tail = decoder.decode(encoded.slice(encoded.length - maxBytes));
  return { text: tail, truncatedBytes };
}

/** Longest run of consecutive backticks in `text`, or 0 if none. Used to
 *  size the fence delimiter below — CommonMark closes a fenced code block
 *  on the first line matching (or exceeding) the opening fence's backtick
 *  count, so a fence no longer than a backtick run already present in the
 *  content lets that run act as a premature closer. */
function longestBacktickRun(text: string): number {
  const runs = text.match(/`+/g);
  if (!runs) return 0;
  return runs.reduce((max, run) => Math.max(max, run.length), 0);
}

/** Compose the collapsed diagnostics block appended to a filed issue: run
 *  the builder's secrets scanner over the FULL raw excerpt first, then
 *  tail-truncate the already-redacted text to MAX_DIAGNOSTICS_BYTES (logs
 *  are the highest-PII payload this flow ever posts). Shared by /preview
 *  (so the operator reviews the exact block before filing) and /create
 *  (which actually appends it).
 *
 *  Order matters here: redaction MUST run before truncation, not after.
 *  Tail-truncating first and then redacting lets the cut point land inside
 *  a secret pattern's required context — e.g. `Authorization: Bearer
 *  <token>` where the truncation window starts partway through the value,
 *  after the `Authorization: Bearer ` prefix the bearer-token regex needs
 *  to match. The token itself would then survive truncation while its
 *  prefix does not, so the pattern never matches and the credential ships
 *  unredacted. Running sanitizeIssueBody() on the untruncated excerpt
 *  guarantees every pattern sees its full match context; only the already-
 *  redacted output is then trimmed to size. sanitizeIssueBody() is given a
 *  byte budget generous enough that its own (head-truncating) size cap
 *  cannot fire before our tail truncation runs below — note redaction can
 *  make the text LONGER than the raw input (e.g. a bare AWS key match
 *  expands to the longer `[REDACTED:aws-access-key]` marker), so the
 *  budget must not be sized off the raw input's own byte length.
 *
 *  The excerpt is attacker-influenceable (window 'error'/'unhandledrejection'
 *  messages, raw server response bodies) and sanitizeIssueBody() does no
 *  backtick/HTML escaping — only secret redaction and size-truncation. A
 *  fixed ` ```text ` fence is therefore breakable by content containing its
 *  own ``` run, letting the tail of the diagnostics render as live markdown/
 *  HTML instead of literal text. Fixed per the standard CommonMark technique:
 *  the fence delimiter must be longer than the longest backtick run present
 *  in the fenced content. */
function buildDiagnosticsBlock(raw: string): string {
  // MAX_DIAGNOSTICS_INPUT_LEN already bounds the raw (UTF-16) length;
  // budget generously past its worst-case UTF-8 + redaction-expansion size
  // so sanitizeIssueBody() never truncates ahead of our own tail cap.
  const sanitizeBudget = MAX_DIAGNOSTICS_INPUT_LEN * 8;
  const sanitized = sanitizeIssueBody(raw, { maxBytes: sanitizeBudget });
  const { text, truncatedBytes } = truncateDiagnosticsTail(
    sanitized.body,
    MAX_DIAGNOSTICS_BYTES,
  );
  const marker =
    truncatedBytes > 0
      ? `[…] ${truncatedBytes} older bytes truncated — showing the most recent diagnostics.\n\n`
      : '';
  const fenceLength = Math.max(3, longestBacktickRun(text) + 1);
  const fence = '`'.repeat(fenceLength);
  return `\n\n<details>\n<summary>Diagnostics</summary>\n\n${fence}text\n${marker}${text}\n${fence}\n\n</details>`;
}
