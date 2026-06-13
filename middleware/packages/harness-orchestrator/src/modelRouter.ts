/**
 * Per-turn Sonnet/Opus routing via a cheap Haiku classifier.
 *
 * The orchestrator model is the single biggest cost driver (Opus, full context
 * × up to N tool rounds). Many turns — greetings, single-fact lookups, short
 * confirmations — don't need Opus-tier reasoning. This routes each turn: a
 * Haiku call (≈1/5 the price of Opus, one short response) classifies the user
 * message, and the turn runs on Sonnet (simple) or Opus (complex).
 *
 * Safety: routing NEVER breaks a turn. Any classifier error, timeout, or
 * ambiguous output falls back to the stronger/complex model (or the caller's
 * configured fallback) — we'd rather overspend than degrade an answer. The
 * classifier's own token usage is recorded as source 'model-router' so its
 * cost is visible in the dashboard and can be weighed against the savings.
 */
import type { LlmProvider } from '@omadia/llm-provider';
import { collectText, textMessage } from '@omadia/llm-provider';
import { recordUsage } from '@omadia/usage-telemetry';

export interface ModelRoutingConfig {
  /** Haiku-tier model used for the classification call itself. */
  readonly classifierModel: string;
  /** Model for SIMPLE turns (typically Sonnet). */
  readonly simpleModel: string;
  /** Model for COMPLEX turns (typically Opus). */
  readonly complexModel: string;
}

const CLASSIFIER_SYSTEM = [
  'You are a router. Classify the user message into exactly one bucket:',
  '- SIMPLE: greeting, chit-chat, a single factual lookup, a short',
  '  confirmation, or a one-step request needing no planning or multi-tool work.',
  '- COMPLEX: anything multi-step, agentic, tool-heavy, code, analysis,',
  '  planning, or where reasoning quality clearly matters.',
  'When unsure, answer COMPLEX. Reply with ONLY the single word SIMPLE or COMPLEX.',
].join('\n');

/** The bucket the classifier (or the fallback) landed on. `fallback` means the
 *  classifier call failed and the caller's fallback model was used. */
export type RoutingBucket = 'simple' | 'complex' | 'fallback';

export interface RouteResult {
  /** Model id the turn should run on. */
  readonly model: string;
  /** Which bucket the turn was routed into. */
  readonly bucket: RoutingBucket;
  /** The Haiku-tier model that made (or attempted) the classification. */
  readonly classifierModel: string;
}

/**
 * Classifies `userMessage` and returns the model id the turn should run on,
 * together with the routing decision so callers can surface it in the UI.
 * Best-effort: returns `fallbackModel` (bucket `fallback`) on any failure.
 */
export async function routeTurnModel(
  provider: LlmProvider,
  cfg: ModelRoutingConfig,
  userMessage: string,
  fallbackModel: string,
): Promise<RouteResult> {
  const text = userMessage.trim().slice(0, 4000);
  // Empty message → nothing to classify; default to the stronger model.
  if (!text) {
    return {
      model: cfg.complexModel,
      bucket: 'complex',
      classifierModel: cfg.classifierModel,
    };
  }
  try {
    const res = await provider.complete({
      model: cfg.classifierModel,
      maxTokens: 8,
      system: CLASSIFIER_SYSTEM,
      messages: [textMessage('user', text)],
    });
    recordUsage({
      source: 'model-router',
      model: cfg.classifierModel,
      inputTokens: res.usage.inputTokens,
      outputTokens: res.usage.outputTokens,
      cacheReadTokens: res.usage.cacheReadTokens ?? 0,
      cacheCreationTokens: res.usage.cacheWriteTokens ?? 0,
    });
    const verdict = collectText(res.content).toUpperCase();
    if (verdict.includes('SIMPLE')) {
      return {
        model: cfg.simpleModel,
        bucket: 'simple',
        classifierModel: cfg.classifierModel,
      };
    }
    // 'COMPLEX' or anything ambiguous → stronger model.
    return {
      model: cfg.complexModel,
      bucket: 'complex',
      classifierModel: cfg.classifierModel,
    };
  } catch (err) {
    console.warn(
      '[model-router] classification failed — using fallback model:',
      err instanceof Error ? err.message : err,
    );
    return {
      model: fallbackModel,
      bucket: 'fallback',
      classifierModel: cfg.classifierModel,
    };
  }
}
