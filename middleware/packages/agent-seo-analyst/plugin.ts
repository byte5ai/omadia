import { createFetcher } from './fetcher.js';
import { createToolkit, type Toolkit } from './toolkit.js';
import type { PluginContext } from './types.js';

export const AGENT_ID = '@omadia/agent-seo-analyst' as const;

const DEFAULT_BASE_URL = 'https://example.com';
const DEFAULT_USER_AGENT = 'omadia-seo-bot/0.1';
const DEFAULT_MAX_PAGES = 25;
const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_TIMEOUT_MS = 15_000;

export interface AgentHandle {
  readonly toolkit: Toolkit;
  close(): Promise<void>;
}

export async function activate(ctx: PluginContext): Promise<AgentHandle> {
  ctx.log('activating');

  const targetBaseUrl = ctx.config.get<string>('target_base_url') ?? DEFAULT_BASE_URL;
  const userAgent = ctx.config.get<string>('user_agent') ?? DEFAULT_USER_AGENT;
  const crawlMaxPages = ctx.config.get<number>('crawl_max_pages') ?? DEFAULT_MAX_PAGES;
  const crawlMaxDepth = ctx.config.get<number>('crawl_max_depth') ?? DEFAULT_MAX_DEPTH;
  const timeoutMs = ctx.config.get<number>('request_timeout_ms') ?? DEFAULT_TIMEOUT_MS;

  const fetcher = createFetcher({
    userAgent,
    timeoutMs,
    log: ctx.log,
  });

  // Self-Test: is the target URL reachable? HEAD would suffice, but many
  // websites answer HEAD with 405. So GET with a short timeout.
  const ping = await fetcher.get(targetBaseUrl, true);
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
