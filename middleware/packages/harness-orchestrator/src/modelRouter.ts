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
import type Anthropic from '@anthropic-ai/sdk';
import { normalizeUsage, recordUsage } from '@omadia/usage-telemetry';

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function firstText(message: any): string {
  const content = message?.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        return block.text;
      }
    }
  }
  return '';
}

/**
 * Classifies `userMessage` and returns the model id the turn should run on.
 * Best-effort: returns `fallbackModel` on any failure.
 */
export async function routeTurnModel(
  client: Anthropic,
  cfg: ModelRoutingConfig,
  userMessage: string,
  fallbackModel: string,
): Promise<string> {
  const text = userMessage.trim().slice(0, 4000);
  if (!text) return cfg.complexModel;
  try {
    const res = await client.messages.create({
      model: cfg.classifierModel,
      max_tokens: 8,
      system: CLASSIFIER_SYSTEM,
      messages: [{ role: 'user', content: text }],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const usage = (res as any)?.usage;
    if (usage) {
      recordUsage({
        source: 'model-router',
        model: cfg.classifierModel,
        ...normalizeUsage(usage),
      });
    }
    const verdict = firstText(res).toUpperCase();
    if (verdict.includes('SIMPLE')) return cfg.simpleModel;
    // 'COMPLEX' or anything ambiguous → stronger model.
    return cfg.complexModel;
  } catch (err) {
    console.warn(
      '[model-router] classification failed — using fallback model:',
      err instanceof Error ? err.message : err,
    );
    return fallbackModel;
  }
}
