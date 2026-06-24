/**
 * Bundled built-in LLM providers (the "everything is a plugin" migration).
 *
 * The `@omadia/llm-provider` package is now provider-AGNOSTIC: its static model
 * registry (`RAW_MODELS`) is empty. Providers are contributed at runtime via the
 * `LlmProviderCatalog` (overlay). To keep a fresh omadia install functional out
 * of the box, the APP (middleware) ships these three providers as bundled
 * built-ins and registers them into the catalog at boot — BEFORE any plugin
 * activates and before the builder/orchestrator resolve a model. This is the
 * "auto-installed built-ins" the design calls for; the standalone, installable
 * versions live in their own repos (byte5ai/omadia-llm-{anthropic,openai,mistral}).
 *
 * Keep these descriptors in sync with those repos' `manifest.yaml` `llm_provider`
 * blocks. MiniMax is deliberately NOT bundled — it ships only as an installable
 * plugin (byte5ai/omadia-llm-minimax).
 */
import type {
  LlmProviderCatalog,
  LlmProviderDescriptor,
} from '@omadia/llm-provider';

export const BUILTIN_LLM_PROVIDERS: ReadonlyArray<LlmProviderDescriptor> = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    wireFormat: 'anthropic',
    baseURL: 'https://api.anthropic.com',
    // Preserves the previous hard-coded behaviour (`provider !== 'anthropic'`):
    // the AVV third-party disclosure is suppressed for Anthropic.
    policy: { requiresAvvDisclosure: false },
    models: [
      {
        id: 'anthropic:claude-opus-4-8',
        provider: 'anthropic',
        modelId: 'claude-opus-4-8',
        label: 'Claude Opus 4.8',
        class: 'frontier',
        maxTokens: 32_000,
        contextWindow: 200_000,
        vision: true,
        aliases: ['opus'],
      },
      {
        id: 'anthropic:claude-sonnet-4-6',
        provider: 'anthropic',
        modelId: 'claude-sonnet-4-6',
        label: 'Claude Sonnet 4.6',
        class: 'balanced',
        maxTokens: 64_000,
        contextWindow: 200_000,
        vision: true,
        aliases: ['sonnet'],
      },
      {
        id: 'anthropic:claude-haiku-4-5-20251001',
        provider: 'anthropic',
        modelId: 'claude-haiku-4-5-20251001',
        label: 'Claude Haiku 4.5',
        class: 'fast',
        maxTokens: 8_192,
        contextWindow: 200_000,
        vision: true,
        aliases: ['haiku'],
      },
    ],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    wireFormat: 'openai-compatible',
    baseURL: 'https://api.openai.com/v1',
    // A baseURL is set, so the adapter treats this as openai-compatible and would
    // emit the legacy `max_tokens`; GPT-5 / o-series require `max_completion_tokens`.
    quirks: { maxTokensField: 'max_completion_tokens' },
    models: [
      {
        id: 'openai:gpt-5.5',
        provider: 'openai',
        modelId: 'gpt-5.5',
        label: 'GPT-5.5',
        class: 'frontier',
        maxTokens: 128_000,
        contextWindow: 1_047_576,
        vision: true,
      },
      {
        id: 'openai:gpt-5.4',
        provider: 'openai',
        modelId: 'gpt-5.4',
        label: 'GPT-5.4',
        class: 'balanced',
        maxTokens: 128_000,
        contextWindow: 400_000,
        vision: true,
      },
      {
        id: 'openai:gpt-5.4-mini',
        provider: 'openai',
        modelId: 'gpt-5.4-mini',
        label: 'GPT-5.4 mini',
        class: 'fast',
        maxTokens: 128_000,
        contextWindow: 400_000,
        vision: true,
        classDefault: true,
      },
      {
        id: 'openai:gpt-5.4-nano',
        provider: 'openai',
        modelId: 'gpt-5.4-nano',
        label: 'GPT-5.4 nano',
        class: 'fast',
        maxTokens: 128_000,
        contextWindow: 400_000,
        vision: true,
      },
    ],
  },
  {
    // #309 Shape 2 — the local official `claude` CLI driven as a keyless,
    // tool-less completion provider on the operator's Claude subscription. Not
    // an HTTP endpoint: the `claude-cli` adapter spawns `claude -p`. Keyless
    // (auth = host capability via `claude auth login`, surfaced on the
    // Subscription CLIs admin page); `baseURL` is unused by this adapter.
    id: 'claude-cli',
    label: 'Claude (subscription CLI)',
    wireFormat: 'claude-cli',
    baseURL: '',
    policy: { requiresApiKey: false, requiresAvvDisclosure: false },
    models: [
      // modelId is suffixed `-cli` so it never collides with another provider's
      // alias (the registry requires globally-unique aliases and id ==
      // `<provider>:<modelId>`); the claude-cli adapter strips the `-cli` suffix
      // back to the CLI alias (`opus`/`sonnet`/`haiku`) for `claude -p --model`.
      {
        id: 'claude-cli:opus-cli',
        provider: 'claude-cli',
        modelId: 'opus-cli',
        label: 'Claude Opus (CLI)',
        class: 'frontier',
        maxTokens: 32_000,
        contextWindow: 200_000,
        vision: false,
      },
      {
        id: 'claude-cli:sonnet-cli',
        provider: 'claude-cli',
        modelId: 'sonnet-cli',
        label: 'Claude Sonnet (CLI)',
        class: 'balanced',
        maxTokens: 64_000,
        contextWindow: 200_000,
        vision: false,
        classDefault: true,
      },
      {
        id: 'claude-cli:haiku-cli',
        provider: 'claude-cli',
        modelId: 'haiku-cli',
        label: 'Claude Haiku (CLI)',
        class: 'fast',
        maxTokens: 8_192,
        contextWindow: 200_000,
        vision: false,
      },
    ],
  },
  {
    id: 'mistral',
    label: 'Mistral',
    wireFormat: 'openai-compatible',
    baseURL: 'https://api.mistral.ai/v1',
    // EU-hosted (France) — surfaces the no-third-country-transfer note.
    policy: { euHosted: true },
    // No quirk: Mistral's OpenAI-compatible layer uses the legacy `max_tokens`,
    // which is exactly what the adapter emits for a non-openai id by default.
    models: [
      {
        id: 'mistral:mistral-large-latest',
        provider: 'mistral',
        modelId: 'mistral-large-latest',
        label: 'Mistral Large 3',
        class: 'frontier',
        maxTokens: 8_192,
        contextWindow: 128_000,
        vision: true,
      },
      {
        id: 'mistral:mistral-medium-latest',
        provider: 'mistral',
        modelId: 'mistral-medium-latest',
        label: 'Mistral Medium 3.5',
        class: 'balanced',
        maxTokens: 8_192,
        contextWindow: 128_000,
        vision: true,
      },
      {
        id: 'mistral:mistral-small-latest',
        provider: 'mistral',
        modelId: 'mistral-small-latest',
        label: 'Mistral Small 4',
        class: 'fast',
        maxTokens: 8_192,
        contextWindow: 128_000,
        vision: false,
      },
    ],
  },
];

/**
 * Register the bundled built-in providers into a catalog (which also registers
 * their models into the global overlay). Idempotent per catalog. Call at boot
 * before plugin activation, and in tests that need a populated model registry.
 */
export function registerBuiltinLlmProviders(catalog: LlmProviderCatalog): void {
  for (const descriptor of BUILTIN_LLM_PROVIDERS) {
    catalog.register(descriptor);
  }
}
