/**
 * Wraps an `LlmProvider` so every `complete()` and the terminal `final` event
 * of `stream()` is recorded by the usage telemetry singleton, transparently.
 *
 * This is the provider-level successor to `withUsageTracking` (which proxies a
 * raw Anthropic SDK client). The background Haiku callers — verifier
 * ClaimExtractor/EvidenceJudge, the orchestrator-extras scorers/extractors —
 * migrated off the SDK onto the neutral contract in phase 2 of
 * docs/plans/llm-provider-interface-plan.md; they now receive a provider, so
 * telemetry moves to the provider boundary too.
 *
 * The model id and usage come straight off the neutral `LlmResponse`, so we no
 * longer have to dig the model out of the request args. Telemetry never
 * disturbs the call: a recorder throw is swallowed.
 */
import type {
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStreamEvent,
  LlmUsage,
} from '@omadia/llm-provider';
import { recordUsage } from './recorder.js';

export interface UsageTrackingOptions {
  /** Logical origin tag stored on each row (e.g. 'verifier', 'extras'). */
  readonly source: string;
  readonly tenantId?: string | undefined;
}

function record(
  usage: LlmUsage,
  model: string,
  opts: UsageTrackingOptions,
): void {
  try {
    recordUsage({
      source: opts.source,
      model,
      tenantId: opts.tenantId,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      // Neutral usage names cacheWriteTokens what the recorder calls
      // cacheCreationTokens; both default to 0 when the provider omits them.
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      cacheCreationTokens: usage.cacheWriteTokens ?? 0,
    });
  } catch {
    // Telemetry must never disturb the call.
  }
}

/**
 * Returns a usage-tracking decorator over `provider`. The original is not
 * mutated; `id`, `capabilities`, and `classifyError` pass through unchanged.
 */
export function withProviderUsageTracking(
  provider: LlmProvider,
  opts: UsageTrackingOptions,
): LlmProvider {
  return {
    id: provider.id,
    capabilities: provider.capabilities,
    async complete(req: LlmRequest): Promise<LlmResponse> {
      const response = await provider.complete(req);
      record(response.usage, response.model, opts);
      return response;
    },
    async *stream(req: LlmRequest): AsyncIterable<LlmStreamEvent> {
      for await (const event of provider.stream(req)) {
        if (event.type === 'final') {
          record(event.response.usage, event.response.model, opts);
        }
        yield event;
      }
    },
    classifyError: provider.classifyError,
  };
}
