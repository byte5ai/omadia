/**
 * OB-29-3 — exposes the Anthropic adapter as the narrow plugin-facing
 * `LlmProvider` for the kernel ServiceRegistry. Plugins that declare
 * `permissions.llm.models_allowed` reach this provider via
 * `ctx.llm.complete(req)` — `createLlmAccessor` adds the model-whitelist
 * + per-invocation budget + max-tokens-clamp on top.
 *
 * Since the provider-decoupling refactor (docs/plans/
 * llm-provider-interface-plan.md, phase 1) this file is a thin wrapper
 * over `@omadia/llm-provider`'s Anthropic adapter: it translates the
 * plain-string plugin messages into neutral content parts and maps the
 * neutral `finishReason` back onto the legacy `stopReason` union the
 * v1 plugin contract promises. The surface stays narrow (no streaming,
 * no tools — the orchestrator handles tool-loops itself).
 */
import {
  createAnthropicProvider,
  type AnthropicClient,
} from '@omadia/llm-adapter-anthropic';
import {
  collectText,
  textMessage,
  type LlmProvider as NeutralLlmProvider,
  type RefusalDetails,
} from '@omadia/llm-provider';
import type {
  LlmCompleteRequest,
  LlmCompleteResult,
  LlmProvider,
} from '@omadia/plugin-api';

export interface AnthropicLlmProviderOptions {
  readonly client: AnthropicClient;
  readonly log?: (...args: unknown[]) => void;
}

/** Neutral finishReason → legacy v1 `stopReason` union. The raw vendor
 *  value wins when it is one of the legacy literals (preserves
 *  `stop_sequence`, which the neutral union collapses into `stop`). A
 *  refusal (#1219) is a neutral `'stop'` and used to come out as
 *  `'end_turn'` — a decline reported as a normal turn end; the neutral
 *  `refusal` object is the signal, so it wins over every other mapping. */
function toLegacyStopReason(
  finishReason: 'stop' | 'tool_calls' | 'max_tokens',
  providerFinishReason: string | undefined,
  refusal: RefusalDetails | undefined,
): LlmCompleteResult['stopReason'] {
  if (refusal !== undefined || providerFinishReason === 'refusal') {
    return 'refusal';
  }
  if (
    providerFinishReason === 'end_turn' ||
    providerFinishReason === 'max_tokens' ||
    providerFinishReason === 'stop_sequence' ||
    providerFinishReason === 'tool_use'
  ) {
    return providerFinishReason;
  }
  switch (finishReason) {
    case 'tool_calls':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'stop':
      return 'end_turn';
  }
}

/**
 * Bridge ANY neutral `@omadia/llm-provider` provider (Anthropic, OpenAI,
 * openai-compatible) to the narrow plugin-facing `LlmProvider` the v1 plugin
 * contract promises. The translation (plain-string messages → neutral parts,
 * neutral `finishReason` → legacy `stopReason`) is provider-agnostic; only the
 * construction of the underlying neutral provider differs per provider. Used by
 * the kernel's `'llm'` service (Anthropic) and by `ctx.llm` when a plugin is
 * pinned to a non-Anthropic provider (see pluginContext.createLlmAccessor).
 */
export function createLlmProviderFromNeutral(
  neutral: NeutralLlmProvider,
  log: (...args: unknown[]) => void = (...args) => console.log('[llm]', ...args),
): LlmProvider {
  return {
    async complete(req: LlmCompleteRequest): Promise<LlmCompleteResult> {
      const started = Date.now();
      const response = await neutral.complete({
        model: req.model,
        maxTokens: req.maxTokens ?? 4096,
        ...(req.system !== undefined ? { system: req.system } : {}),
        ...(req.temperature !== undefined
          ? { temperature: req.temperature }
          : {}),
        // #1219 — forwarded as-is; an adapter without a structured-output
        // channel drops it, so a plugin asking for a schema never breaks a turn.
        ...(req.outputFormat !== undefined
          ? { outputFormat: req.outputFormat }
          : {}),
        messages: req.messages.map((m) => textMessage(m.role, m.content)),
      });
      const elapsed = Date.now() - started;
      log(
        `complete ok model=${response.model} in=${String(response.usage.inputTokens)} out=${String(response.usage.outputTokens)} ms=${String(elapsed)}`,
      );
      // #1219 — only the category crosses into the plugin contract; the
      // vendor's free-text explanation stays in this log line.
      const refusal = response.refusal;
      if (refusal !== undefined) {
        log(
          `complete declined by the model's safety classifiers model=${response.model} category=${refusal.category ?? 'none'}`,
        );
      }
      return {
        text: collectText(response.content),
        model: response.model,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        finishReason: response.finishReason,
        stopReason: toLegacyStopReason(
          response.finishReason,
          response.providerFinishReason,
          refusal,
        ),
        ...(refusal !== undefined
          ? {
              refusal:
                refusal.category !== undefined
                  ? { category: refusal.category }
                  : {},
            }
          : {}),
      };
    },
  };
}

export function createAnthropicLlmProvider(
  opts: AnthropicLlmProviderOptions,
): LlmProvider {
  const log = opts.log ?? ((...args) => console.log('[llm]', ...args));
  return createLlmProviderFromNeutral(
    createAnthropicProvider({ client: opts.client }),
    log,
  );
}
