/**
 * Adapter CONTRACT — the seam that lets the concrete wire-format adapters live
 * OUTSIDE this contract package and outside the runtime core. Each adapter
 * package (`@omadia/llm-adapter-anthropic`, `@omadia/llm-adapter-openai`)
 * implements `LlmAdapter` for one `WireFormat` and registers itself into an
 * `LlmAdapterRegistry`. The resolution seam in `@omadia/llm-provider` looks up
 * the adapter for a provider's wire format and calls `build()` — so neither the
 * contract nor the runtime core imports a vendor SDK.
 *
 * Keying adapters by WIRE FORMAT (not provider id) is deliberate: a new provider
 * that speaks an existing wire format needs only a descriptor (a plugin); a
 * genuinely new protocol needs a new adapter package that registers itself here.
 */
import type { ProviderQuirks, WireFormat } from './descriptor.js';
import type { LlmProvider } from './types.js';

/** Everything an adapter needs to construct a concrete provider from resolved
 *  credentials + descriptor metadata. The resolution seam fills this in. */
export interface LlmAdapterBuildOptions {
  /** Resolved API key (the seam already read it from the vault). */
  readonly apiKey: string;
  /** API base URL. Omitted only for the literal `openai` provider (its SDK
   *  defaults to api.openai.com); every other id carries one. */
  readonly baseURL?: string;
  /** SDK auto-retry count (the orchestrator uses 5; others keep the SDK default). */
  readonly maxRetries?: number;
  /** Provider id to stamp on the built `LlmProvider` for non-default
   *  openai-compatible providers (e.g. `mistral`, `minimax`). */
  readonly id?: string;
  /** OpenAI-adapter vendor quirks from the descriptor; ignored by other adapters. */
  readonly quirks?: ProviderQuirks;
  readonly log?: (...args: unknown[]) => void;
}

/** A wire-format adapter: turns resolved credentials into a working provider. */
export interface LlmAdapter {
  /** The wire format this adapter speaks — its registry key. */
  readonly wireFormat: WireFormat;
  /** Build a concrete provider. Synchronous: SDK clients construct eagerly. */
  build(opts: LlmAdapterBuildOptions): LlmProvider;
}

/** Registry of wire-format adapters. The runtime core ships a concrete
 *  implementation + a process-default instance; adapter packages register into
 *  it at boot, and the resolution seam reads from it. */
export interface LlmAdapterRegistry {
  /** Register (or idempotently replace) the adapter for its wire format. */
  register(adapter: LlmAdapter): void;
  get(wireFormat: WireFormat): LlmAdapter | undefined;
  has(wireFormat: WireFormat): boolean;
  list(): ReadonlyArray<LlmAdapter>;
}
