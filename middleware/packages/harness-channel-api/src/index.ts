// @omadia/channel-api — public barrel.
//
// The API-key primitives (mint/hash/verify, store, rate limiter, audit log,
// `requireApiKey`) moved to `@omadia/api-key-auth` in issue #439 so the
// kernel can consume them without importing a channel plugin. Import them
// from there — this package no longer re-exports them, because a second
// import path is exactly how a "single implementation" quietly stops being
// one.
export { activate, API_PREFIX } from './plugin.js';

export {
  createApiChatRouter,
  CHAT_ROUTE,
  type ApiChatRouterDeps,
} from './chatRouter.js';

export { createAdminKeysRouter } from './adminKeysRouter.js';
