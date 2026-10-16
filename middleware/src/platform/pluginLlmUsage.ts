import { providerRecordsOwnUsage, recordUsage } from '@omadia/usage-telemetry';

/** The part of a plugin `ctx.llm` result the cost ledger needs. */
export interface PluginLlmUsage {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * #1390 — one `token_usage` row per plugin `ctx.llm` call, sourced
 * `plugin <id>`. The provider behind `ctx.llm` only logged its token counts, so
 * these calls (e.g. a Haiku classifier before every chat turn) were missing from
 * the cost ledger. Called by the accessors rather than recorded in the provider,
 * so every serving path is covered by one seam: the shared Anthropic `'llm'`
 * service, a pinned provider, and the builder preview.
 *
 * The plugin contract carries no cache counts, and plugin requests set no cache
 * markers, so 0 is the honest value. Turn ids come from the ambient turn
 * context when the call runs inside an orchestrator turn. A provider that
 * records its own rows (`claude-cli`) is skipped so nothing is counted twice.
 */
export function recordPluginLlmUsage(
  source: string,
  providerId: string,
  result: PluginLlmUsage,
): void {
  if (providerRecordsOwnUsage(providerId)) return;
  try {
    recordUsage({
      source,
      model: result.model,
      provider: providerId,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  } catch {
    // Telemetry must never disturb the plugin's call.
  }
}

/** The `source` a plugin's `ctx.llm` rows are recorded under. */
export function pluginLlmUsageSource(agentId: string): string {
  return `plugin ${agentId}`;
}
