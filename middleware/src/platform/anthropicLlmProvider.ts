/**
 * OB-29-3 — wraps a `@anthropic-ai/sdk` client as an `LlmProvider`
 * for the kernel ServiceRegistry. Plugins that declare
 * `permissions.llm.models_allowed` reach this provider via
 * `ctx.llm.complete(req)` — `createLlmAccessor` adds the model-whitelist
 * + per-invocation budget + max-tokens-clamp on top.
 *
 * Per-call latency / cost concerns belong to the consumer side; this
 * wrapper keeps the surface narrow (no streaming, no tools — the
 * orchestrator handles tool-loops itself) so it stays easy to swap for
 * a fake in tests.
 */
import type Anthropic from '@anthropic-ai/sdk';

import type {
  LlmCompleteRequest,
  LlmCompleteResult,
  LlmProvider,
} from '@omadia/plugin-api';

export interface AnthropicLlmProviderOptions {
  readonly client: Anthropic;
  readonly log?: (...args: unknown[]) => void;
}

export function createAnthropicLlmProvider(
  opts: AnthropicLlmProviderOptions,
): LlmProvider {
  const { client } = opts;
  const log = opts.log ?? ((...args) => console.log('[llm]', ...args));
  return {
    async complete(req: LlmCompleteRequest): Promise<LlmCompleteResult> {
      const started = Date.now();
      const response = await client.messages.create({
        model: req.model,
        max_tokens: req.maxTokens ?? 4096,
        ...(req.system !== undefined ? { system: req.system } : {}),
        ...(req.temperature !== undefined
          ? { temperature: req.temperature }
          : {}),
        messages: req.messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
      });
      const text = response.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');
      const elapsed = Date.now() - started;
      log(
        `complete ok model=${response.model} in=${String(response.usage.input_tokens)} out=${String(response.usage.output_tokens)} ms=${String(elapsed)}`,
      );
      // Anthropic stop_reason can be null on some streaming edge-cases;
      // narrow it here so the plugin contract stays a small union.
      const stopReason = (response.stop_reason ?? 'end_turn') as
        | 'end_turn'
        | 'max_tokens'
        | 'stop_sequence'
        | 'tool_use';
      return {
        text,
        model: response.model,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        stopReason,
      };
    },
  };
}
