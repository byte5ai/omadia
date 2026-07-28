// @omadia/api-key-auth — public barrel (issue #439).
//
// The single implementation of omadia's server-to-server API-key credential:
// mint/hash/verify, the vault-backed store with per-key scopes, the per-key
// rate limiter, the usage audit log, and the mountable `requireApiKey`
// Express middleware. Consumed by the kernel and by plugins alike — neither
// direction is a layering inversion, which is exactly why this lives in its
// own workspace package rather than in `middleware/src/auth/` (a plugin
// cannot import kernel source) or in `@omadia/channel-api` (the kernel must
// never import a channel plugin).

export {
  API_KEY_PREFIX,
  mintApiKey,
  sha256Hex,
  verifyApiKey,
  type MintedApiKey,
} from './apiKeyToken.js';

export {
  assertValidScopes,
  CHAT_WRITE_SCOPE,
  hasScope,
  isValidScope,
  LEGACY_DEFAULT_SCOPES,
  normalizeScopes,
  WILDCARD_SCOPE,
  type ApiKeyScope,
} from './apiKeyScopes.js';

export {
  createApiKeyStore,
  type ApiKeyPublicView,
  type ApiKeyRecord,
  type ApiKeyStore,
  type CreateApiKeyOptions,
  type CreatedApiKey,
} from './apiKeyStore.js';

export {
  createAuditLog,
  MAX_ENTRIES as AUDIT_LOG_MAX_ENTRIES,
  type AuditEntry,
  type AuditLog,
  type AuditStatus,
} from './auditLog.js';

export { createRateLimiter, type RateLimiter } from './rateLimiter.js';

export {
  bearerToken,
  requireApiKey,
  type ApiKeyPrincipal,
  type RequireApiKeyOptions,
} from './requireApiKey.js';

export type { ApiKeySecretStorage } from './secretStorage.js';
