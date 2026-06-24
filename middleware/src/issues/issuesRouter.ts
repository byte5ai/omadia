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
 *   POST /preview                -> { title, body, category }
 *   POST /create                 -> { number, htmlUrl }
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
      const body = (req.body ?? {}) as { text?: unknown; category?: unknown };
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
      res.json({ title: result.title, body: result.body, category });
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
      const footer = `\n\n<sub>Filed via the omadia in-app issue reporter${
        conn.login ? ` by @${conn.login}` : ''
      }.</sub>`;
      const fullBody = `**Type:** ${CATEGORY_LABEL[category]}\n\n${safeBody}${footer}`;
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
