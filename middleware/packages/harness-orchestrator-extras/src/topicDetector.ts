import type Anthropic from '@anthropic-ai/sdk';
import type { ConversationTurn } from '@omadia/plugin-api';
import {
  cosineSimilarity,
  type EmbeddingClient,
} from '@omadia/embeddings';

/**
 * Three-stage topic-detection pipeline:
 *
 *   1. Embedding-cosine between the new user message and the centroid of the
 *      last N turns' user messages. Cheap (~80 ms with the local sidecar).
 *      High similarity → `continue`. Low similarity → `reset`. Ambiguous →
 *      escalate.
 *   2. LLM-classifier (Haiku, one-shot, forced JSON). Returns continue / reset
 *      / unsure. ~300 ms.
 *   3. `ask` — let the TeamsBot render an Adaptive-Card with two buttons so
 *      the user resolves the ambiguity explicitly.
 *
 * Thresholds are deliberately conservative on the "ask" side: we'd rather
 * ask once than silently lose context. Every decision carries a `reason` so
 * the Teams log shows *why* we picked continue/reset/ask.
 */

export type TopicDecision = 'continue' | 'reset' | 'ask';

export interface TopicClassifyInput {
  userMessage: string;
  history: readonly ConversationTurn[];
}

export interface TopicClassifyResult {
  decision: TopicDecision;
  reason: string;
  /** Cosine similarity between new message and centroid, when computed. */
  similarity?: number;
  /** LLM classifier verdict, when we hit stage 2. */
  classifier?: 'continue' | 'reset' | 'unsure';
}

export interface TopicDetectorOptions {
  /** Auto-continue at and above this similarity. */
  upperThreshold?: number;
  /** Auto-reset at and below this similarity. */
  lowerThreshold?: number;
  /** How many recent turns' user messages feed the centroid. */
  centroidDepth?: number;
  /** Haiku model id for the classifier step. */
  classifierModel?: string;
  /** Token budget for the classifier call (tight — verdict is JSON). */
  classifierMaxTokens?: number;
  /** When every stage fails unexpectedly (network, timeouts), fall back to
   *  this decision. `continue` is the forgiving default — we'd rather keep
   *  context than silently discard it. */
  fallbackDecision?: TopicDecision;
}

const DEFAULTS: Required<TopicDetectorOptions> = {
  upperThreshold: 0.55,
  lowerThreshold: 0.15,
  centroidDepth: 5,
  classifierModel: 'claude-haiku-4-5-20251001',
  classifierMaxTokens: 64,
  fallbackDecision: 'continue',
};

export class TopicDetector {
  private readonly opts: Required<TopicDetectorOptions>;

  constructor(
    private readonly embeddings: EmbeddingClient,
    private readonly anthropic: Anthropic,
    opts: TopicDetectorOptions = {},
  ) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  async classify(input: TopicClassifyInput): Promise<TopicClassifyResult> {
    if (input.history.length === 0) {
      return { decision: 'continue', reason: 'no-history' };
    }

    const similarity = await this.computeSimilarity(input);
    if (!Number.isFinite(similarity)) {
      // Embedding itself failed — we don't want to block the turn, but we also
      // don't want to send a clarification card for every turn while the
      // sidecar is down. Default to fallback (continue) so the user still gets
      // an answer; log loud so ops can pick it up.
      console.error(
        '[topic] embedding step failed — falling back to decision',
        this.opts.fallbackDecision,
      );
      return {
        decision: this.opts.fallbackDecision,
        reason: 'embedding-failed',
      };
    }

    if (similarity >= this.opts.upperThreshold) {
      return { decision: 'continue', reason: 'similarity-high', similarity };
    }
    if (similarity <= this.opts.lowerThreshold) {
      return { decision: 'reset', reason: 'similarity-low', similarity };
    }

    const classifier = await this.runClassifier(input).catch((err) => {
      console.error(
        '[topic] classifier step failed:',
        err instanceof Error ? err.message : err,
      );
      return 'unsure' as const;
    });
    if (classifier === 'continue') {
      return {
        decision: 'continue',
        reason: 'classifier-continue',
        similarity,
        classifier,
      };
    }
    if (classifier === 'reset') {
      return {
        decision: 'reset',
        reason: 'classifier-reset',
        similarity,
        classifier,
      };
    }
    return {
      decision: 'ask',
      reason: 'classifier-unsure',
      similarity,
      classifier,
    };
  }

  private async computeSimilarity(
    input: TopicClassifyInput,
  ): Promise<number> {
    const tail = input.history.slice(-this.opts.centroidDepth);
    // Embed the new message + the tail's user messages in parallel. Ollama
    // usually takes ~80 ms per call; going parallel keeps the critical path
    // at roughly that single-call latency.
    const [newVec, tailVecs] = await Promise.all([
      this.embeddings.embed(input.userMessage).catch(() => [] as number[]),
      Promise.all(
        tail.map((t) =>
          this.embeddings.embed(t.userMessage).catch(() => [] as number[]),
        ),
      ),
    ]);
    if (newVec.length === 0) return Number.NaN;
    const valid = tailVecs.filter((v) => v.length === newVec.length);
    if (valid.length === 0) return Number.NaN;
    const centroid = new Array<number>(newVec.length).fill(0);
    for (const v of valid) {
      for (let i = 0; i < newVec.length; i++) {
        centroid[i] = (centroid[i] ?? 0) + (v[i] ?? 0);
      }
    }
    for (let i = 0; i < newVec.length; i++) {
      centroid[i] = (centroid[i] ?? 0) / valid.length;
    }
    return cosineSimilarity(newVec, centroid);
  }

  private async runClassifier(
    input: TopicClassifyInput,
  ): Promise<'continue' | 'reset' | 'unsure'> {
    const lastTurn = input.history.at(-1);
    if (!lastTurn) return 'unsure';

    const system = `You classify whether a new chat message is a FOLLOW-UP on the immediately previous exchange, or a NEW TOPIC.

Output STRICTLY one of: "continue", "reset", "unsure". Lowercase, no quotes, no explanation. Pick "unsure" only if the message could plausibly be read either way.

Heuristics:
- Follow-up cues: referential pronouns ("das", "die", "davon", "the same"), explicit backref ("und jetzt ohne X", "und für Q4?"), formatting-requests about the previous answer ("als Line-Chart", "kurzer", "auf Englisch").
- New-topic cues: introduces a distinct entity or domain not present in the previous exchange; switches from one business area to another (accounting → HR, invoices → contracts); greets or opens fresh.`;

    const user = `PREVIOUS user message:
${truncate(lastTurn.userMessage, 400)}

PREVIOUS assistant answer:
${truncate(lastTurn.assistantAnswer, 400)}

NEW user message:
${truncate(input.userMessage, 400)}`;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response: any = await this.anthropic.messages.create({
      model: this.opts.classifierModel,
      max_tokens: this.opts.classifierMaxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    });
    const raw = collectFirstText(response).toLowerCase().trim();
    if (raw.startsWith('continue')) return 'continue';
    if (raw.startsWith('reset')) return 'reset';
    return 'unsure';
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function collectFirstText(message: any): string {
  const content = message?.content;
  if (!Array.isArray(content)) return '';
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      return block.text;
    }
  }
  return '';
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}
