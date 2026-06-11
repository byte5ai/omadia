import { createFetcher } from './fetcher.js';
import { createToolkit, type Toolkit } from './toolkit.js';
import type { PluginContext } from './types.js';

export const AGENT_ID = '@omadia/agent-seo-analyst' as const;

const DEFAULT_BASE_URL = 'https://omadia.ai';
const DEFAULT_USER_AGENT = 'byte5-seo-bot/0.1 (+https://omadia.ai)';
const DEFAULT_MAX_PAGES = 25;
const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_TIMEOUT_MS = 15_000;

export interface AgentHandle {
  readonly toolkit: Toolkit;
  close(): Promise<void>;
}

export async function activate(ctx: PluginContext): Promise<AgentHandle> {
  // #91 — all outbound traffic must go through ctx.http so the manifest
  // allow-list + audit mode are enforced. Without it the plugin cannot run.
  if (!ctx.http) {
    throw new Error(
      'seo-analyst: ctx.http is unavailable — the manifest must declare ' +
        'permissions.network.outbound so the kernel provisions the HTTP accessor.',
    );
  }
  // #91 — operator-selected audit mode. Surfaced in the blocked-host error
  // path so the agent never silently substitutes a different URL.
  // Cosmetic only (surfaced in blocked-host errors + the self-test log). The
  // ENFORCED mode lives in the kernel's ctx.http; the manifest declares
  // `public-web` as the default audit mode, so mirror that when config is unset.
  const auditMode = ctx.config.get<string>('audit_mode') ?? 'public-web';
  ctx.log('activating', { auditMode });

  const targetBaseUrl = ctx.config.get<string>('target_base_url') ?? DEFAULT_BASE_URL;
  const userAgent = ctx.config.get<string>('user_agent') ?? DEFAULT_USER_AGENT;
  const crawlMaxPages = ctx.config.get<number>('crawl_max_pages') ?? DEFAULT_MAX_PAGES;
  const crawlMaxDepth = ctx.config.get<number>('crawl_max_depth') ?? DEFAULT_MAX_DEPTH;
  const timeoutMs = ctx.config.get<number>('request_timeout_ms') ?? DEFAULT_TIMEOUT_MS;

  const fetcher = createFetcher({
    userAgent,
    timeoutMs,
    log: ctx.log,
    http: ctx.http,
  });

  // Self-Test: is the target URL reachable? HEAD would suffice, but many
  // websites answer HEAD with 405. So GET with a short timeout.
  const ping = await fetcher.get(targetBaseUrl, true);
  if (ping.blocked !== undefined) {
    ctx.log('self-test blocked', { targetBaseUrl, auditMode });
    throw new Error(`seo-analyst: ${ping.blocked}`);
  }
  if (ping.status === 0) {
    ctx.log('self-test failed', { targetBaseUrl });
    throw new Error(`seo-analyst: Ziel-URL nicht erreichbar (${targetBaseUrl})`);
  }
  ctx.log('self-test ok', { targetBaseUrl, status: ping.status });

  const toolkit = createToolkit({
    fetcher,
    targetBaseUrl,
    userAgent,
    crawlMaxPages,
    crawlMaxDepth,
    auditMode,
    log: ctx.log,
  });

  return {
    toolkit,
    async close() {
      ctx.log('deactivating');
      await toolkit.close();
    },
  };
}

export default { AGENT_ID, activate };
