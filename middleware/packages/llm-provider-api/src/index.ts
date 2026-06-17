/**
 * `@omadia/llm-provider-api` — the versioned, SDK-free LLM provider contract.
 *
 * This is the entire public surface a provider/adapter plugin compiles against:
 * the neutral request/response DTOs, the `LlmProvider` interface, the model
 * descriptor + registry types, and the wire-format adapter contract. It has zero
 * runtime dependencies and never imports a vendor SDK. The runtime that consumes
 * this contract (catalog, model registry, resolution, adapter registry) lives in
 * `@omadia/llm-provider`; the concrete adapters live in `@omadia/llm-adapter-*`.
 */

// Neutral LLM DTOs + content helpers.
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

// Model-registry contract types (runtime registry lives in @omadia/llm-provider).
export type { ModelClass, ModelInfo, ModelRole, ProviderId } from './models.js';

// Provider descriptor contract (runtime catalog lives in @omadia/llm-provider).
export type {
  LlmProviderDescriptor,
  ProviderPolicy,
  ProviderQuirks,
  WireFormat,
} from './descriptor.js';

// Wire-format adapter contract (implemented by @omadia/llm-adapter-* packages).
export type {
  LlmAdapter,
  LlmAdapterBuildOptions,
  LlmAdapterRegistry,
} from './adapter.js';

export { LLM_PROVIDER_API_VERSION } from './version.js';
