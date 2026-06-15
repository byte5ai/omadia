export type {
  CacheHints,
  ChatMessage,
  ContentPart,
  FinishReason,
  ImagePart,
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
} from './types.js';

export { collectText, textMessage, toolCalls } from './types.js';

export {
  classifyAnthropicError,
  createAnthropicProvider,
  type AnthropicProviderOptions,
} from './anthropicProvider.js';

export {
  createAnthropicClient,
  type AnthropicClient,
  type AnthropicClientOptions,
} from './anthropicClient.js';

export {
  classifyOpenAiError,
  createOpenAiProvider,
  type OpenAiProviderOptions,
} from './openaiProvider.js';

export {
  createOpenAiClient,
  type OpenAiClient,
  type OpenAiClientOptions,
} from './openaiClient.js';

export {
  legacyProviderApiKeyVaultKey,
  providerApiKeyVaultKey,
  readProviderApiKey,
} from './providerCredentials.js';

export {
  knownProviderBaseUrl,
  resolveLlmProvider,
  type ResolveLlmProviderOptions,
} from './providerFactory.js';

export {
  LlmProviderCatalog,
  type LlmProviderDescriptor,
  type ProviderPolicy,
  type ProviderQuirks,
} from './providerCatalog.js';

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
