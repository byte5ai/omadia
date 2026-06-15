/**
 * `@omadia/llm-provider` — the SDK-free runtime for the LLM provider seam.
 *
 * The neutral CONTRACT (DTOs, `LlmProvider`, model + descriptor + adapter types)
 * lives in `@omadia/llm-provider-api` and is re-exported here so existing
 * consumers keep importing from `@omadia/llm-provider` unchanged. This package
 * adds the RUNTIME: the model registry, the provider catalog, credential
 * resolution, the wire-format adapter registry, and `resolveLlmProvider`. It
 * imports NO vendor SDK and contains NO concrete adapter — those live in
 * `@omadia/llm-adapter-anthropic` / `@omadia/llm-adapter-openai` (issue #298).
 */

// ---- Contract (re-exported from the versioned contract package) ----
export type {
  CacheHints,
  ChatMessage,
  ContentPart,
  FinishReason,
  ImagePart,
  LlmAdapter,
  LlmAdapterBuildOptions,
  LlmAdapterRegistry,
  LlmErrorClassification,
  LlmErrorKind,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStreamEvent,
  LlmUsage,
  ProviderCapabilities,
  SystemBlock,
  TextPart,
  ToolCallPart,
  ToolChoice,
  ToolResultPart,
  ToolSpec,
} from '@omadia/llm-provider-api';
export {
  collectText,
  LLM_PROVIDER_API_VERSION,
  textMessage,
  toolCalls,
} from '@omadia/llm-provider-api';

// ---- Runtime: credentials ----
export {
  legacyProviderApiKeyVaultKey,
  providerApiKeyVaultKey,
  readProviderApiKey,
} from './providerCredentials.js';

// ---- Runtime: provider resolution (registry lookup) ----
export {
  knownProviderBaseUrl,
  resolveLlmProvider,
  type ResolveLlmProviderOptions,
} from './providerFactory.js';

// ---- Runtime: wire-format adapter registry ----
export {
  defaultLlmAdapters,
  LlmAdapterRegistryImpl,
} from './adapterRegistry.js';

// ---- Runtime: provider catalog (+ re-exported descriptor contract types) ----
export {
  LlmProviderCatalog,
  type LlmProviderDescriptor,
  type ProviderPolicy,
  type ProviderQuirks,
  type WireFormat,
} from './providerCatalog.js';

// ---- Runtime: model registry (+ re-exported model contract types) ----
export {
  clearExternalModels,
  coerceModelToProvider,
  getModel,
  isClassRef,
  listModels,
  listModelsByClass,
  listModelsByProvider,
  modelForClass,
  registerExternalModels,
  resolveModelRef,
  resolveRole,
  ROLE_DEFAULT_CLASS,
  type ModelClass,
  type ModelInfo,
  type ModelRole,
  type ProviderId,
} from './modelRegistry.js';
