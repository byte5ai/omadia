/**
 * Public surface of the kernel OAuth broker library (spec 005).
 *
 * The broker drives standard authorization-code flows for plugins that declare
 * a `type:oauth` setup field + an `oauth_providers` descriptor. The generic
 * `engine` executes the dance from descriptor data — no plugin code runs, so
 * client secrets + refresh tokens stay kernel-side.
 *
 * Consumers (broker routes, `ctx.oauthTokens`) import only from here; internal
 * modules are free to reorganise without breaking downstream code.
 */

export { generateCodeVerifier, computeCodeChallenge } from './pkce.js';

export {
  signOAuthState,
  verifyOAuthState,
  type OAuthStateClaims,
} from './state.js';

export {
  PendingFlowStore,
  type PendingFlow,
  type PendingFlowInit,
  type PendingFlowStoreOptions,
} from './pendingFlows.js';

export {
  buildAuthorizeUrl,
  exchangeCode,
  refreshAccessToken,
  type OAuthEngineTokens,
  type AuthorizeUrlParams,
  type ExchangeCodeParams,
  type RefreshParams,
} from './engine.js';

export {
  oauthVaultKey,
  readStoredTokens,
  writeStoredTokens,
  type StoredOAuthTokens,
} from './tokenStore.js';

export {
  OAuthBrokerService,
  type OAuthBrokerDeps,
  type StartInput,
  type CallbackInput,
} from './brokerService.js';

export {
  OAuthBrokerError,
  resolveOAuthProvider,
  type ResolvedOAuthProvider,
} from './providerResolve.js';
