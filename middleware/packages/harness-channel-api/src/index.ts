// @omadia/channel-api — public barrel.
export { activate, API_PREFIX } from './plugin.js';

export {
  createApiKeyStore,
  type ApiKeyRecord,
  type ApiKeyPublicView,
  type ApiKeyStore,
  type CreateApiKeyOptions,
  type CreatedApiKey,
} from './apiKeyStore.js';

export {
  API_KEY_PREFIX,
  mintApiKey,
  sha256Hex,
  verifyApiKey,
  type MintedApiKey,
} from './apiKeyToken.js';

export {
  createAuditLog,
  MAX_ENTRIES as AUDIT_LOG_MAX_ENTRIES,
  type AuditEntry,
  type AuditLog,
} from './auditLog.js';

export { createRateLimiter, type RateLimiter } from './rateLimiter.js';

export {
  createApiChatRouter,
  CHAT_ROUTE,
  type ApiChatRouterDeps,
} from './chatRouter.js';

export { createAdminKeysRouter } from './adminKeysRouter.js';
