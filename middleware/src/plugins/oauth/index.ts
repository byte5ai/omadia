/**
 * Public surface of the plugin-OAuth library (Slice 1.2c / OB-1, P1).
 *
 * Consumers (P2 install-route, P4 calendar plugin) import only from here
 * — the internal modules are free to reorganise without breaking
 * downstream code.
 */

export type {
  AuthorizeUrlInput,
  OAuthTokens,
  PluginOAuthProvider,
  ProviderFactory,
} from './types.js';

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

export { OAuthProviderRegistry } from './providerRegistry.js';

export {
  MS365_PROVIDER_ID,
  MicrosoftGraphProvider,
  microsoftGraphProviderFactory,
  type MicrosoftGraphProviderConfig,
} from './microsoftGraphProvider.js';
