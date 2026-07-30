/**
 * @omadia/channel-api — issue #438, public API channel.
 *
 * `kind: channel`. Registers ONE router under `/api/public/v1`:
 *   - `POST /chat`         — public, self-authenticating (API key). The only
 *                            path `publicPaths.ts` exempts from the session
 *                            gate for this plugin.
 *   - `/admin/keys`        — key lifecycle (create/list/revoke). NOT
 *                            exempted in `publicPaths.ts`, and (as of the
 *                            issue #438 follow-up) actually enforced: gated
 *                            by `ctx.operatorAuth` inside
 *                            `adminKeysRouter.ts` itself, since
 *                            `core.registerRouter` applies no auth of its
 *                            own — see that file's doc comment.
 *
 * Follows the same "built-in package, activate(ctx, core)" shape as
 * `@omadia/ui-channel` — see that package for the template this mirrors.
 *
 * Issue #439: the key store, rate limiter, audit log and the bearer-auth
 * middleware now live in `@omadia/api-key-auth` so the kernel can reuse them
 * too. This plugin only wires them to `ctx.secrets` and mounts the routes.
 */

import { Router } from 'express';
import type { ChannelHandle, CoreApi } from '@omadia/channel-sdk';
import type { PluginContext } from '@omadia/plugin-api';
import { createApiKeyStore, createAuditLog, createRateLimiter } from '@omadia/api-key-auth';

import { createAdminKeysRouter } from './adminKeysRouter.js';
import { createApiChatRouter } from './chatRouter.js';

/** Mount prefix this plugin registers under. `publicPaths.ts` exempts ONLY
 *  `${API_PREFIX}/chat` from the session gate — keep the two in sync. */
export const API_PREFIX = '/api/public/v1';

export async function activate(
  ctx: PluginContext,
  core: CoreApi,
): Promise<ChannelHandle> {
  ctx.log('activating @omadia/channel-api');

  if (!ctx.secrets.set || !ctx.secrets.delete) {
    // Defensive: the manifest declares permissions.secrets.runtime_write, so
    // this should never happen on a correctly-wired core. Degrade to inert
    // rather than crash the whole plugin-load pass (mirrors how
    // omadia-ui-channel degrades to discovery-only when its WS registry is
    // absent).
    ctx.log(
      '[channel-api] ctx.secrets has no write access — routes NOT mounted (check permissions.secrets.runtime_write in manifest.yaml)',
    );
    return {
      async close(): Promise<void> {},
    };
  }

  const apiKeys = createApiKeyStore(ctx.secrets);
  const auditLog = createAuditLog(ctx.secrets);
  const rateLimiter = createRateLimiter();

  const router = Router();
  router.use(
    createApiChatRouter({
      channelId: ctx.agentId,
      core,
      apiKeys,
      rateLimiter,
      auditLog,
    }),
  );
  router.use('/admin/keys', createAdminKeysRouter(apiKeys, ctx.operatorAuth));

  core.registerRouter(ctx.agentId, API_PREFIX, router);
  ctx.log(
    `[channel-api] chat route at POST ${API_PREFIX}/chat, key admin at ${API_PREFIX}/admin/keys`,
  );

  return {
    async close(): Promise<void> {
      ctx.log('deactivating @omadia/channel-api');
      // Routes are torn down by the kernel per channelId (CoreApi contract) —
      // nothing else to release (no timers, no sockets).
    },
  };
}
