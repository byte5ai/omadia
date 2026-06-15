/**
 * @omadia/orchestrator-extras — RecallRelevanceJudge.
 *
 * The cross-session recall legs (plans / processes / insights) over-fetch by
 * lexical overlap and embedding cosine. Both are coarse: a long, business-noun-
 * packed *generic* note can out-score a specific on-topic fact (observed live —
 * a generic "AI has no Odoo access, use Dynamics…" reference scored a higher
 * cosine than the specific weekly course list for the query "Kurse diese
 * Woche"). No score threshold can separate signal from noise when the noise
 * scores higher.
 *
 * This judge does a single, cheap, LLM-agnostic relevance pass over the
 * already-fetched candidates: it asks the configured FAST model class (resolved
 * to a concrete model id by the caller — never hardcoded to one vendor) which
 * items are actually useful for answering the CURRENT message, and returns the
 * surviving ids. It is the precision stage on top of the cheap recall legs.
 *
 * Failure semantics: FAIL-OPEN. Any error (empty/non-JSON response, provider
 * throw) returns ALL candidate ids — a degraded judge must never silently hide
 * recall that the cheaper legs already deemed plausible.
 */

import type { LlmProvider } from '@omadia/llm-provider';
import { collectText, textMessage } from '@omadia/llm-provider';

export type RecallCandidateKind = 'plan' | 'process' | 'insight';

export interface RecallCandidate {
  /** Stable id used to map the verdict back onto the source hit. */
  id: string;
  kind: RecallCandidateKind;
  /** Short human-readable text the judge reasons over (caller truncates). */
  text: string;
}

export interface RecallRelevanceJudge {
  /**
   * Returns the subset of candidate ids judged relevant to `userMessage`.
   * FAIL-OPEN: on any error returns every candidate id unchanged.
   */
  filterRelevant(
    userMessage: string,
    candidates: readonly RecallCandidate[],
  ): Promise<Set<string>>;
}

export interface RecallRelevanceJudgeOptions {
  /** Provider-agnostic LLM. */
  llm: LlmProvider;
  /**
   * Concrete model id the provider understands. The caller resolves the FAST
   * model class (`class:fast`) to this id so the judge stays vendor-neutral.
   */
  model: string;
  /** Max tokens for the verdict (ids only → tiny). Default 512. */
  maxTokens?: number;
  /** Per-candidate text cap fed to the model. Default 280 chars. */
  maxCandidateChars?: number;
  log?: (msg: string) => void;
}

const DEFAULT_MAX_TOKENS = 512;
const DEFAULT_MAX_CANDIDATE_CHARS = 280;

const SYSTEM_PROMPT = `You filter "recalled context" for relevance.

You are given the user's CURRENT message and a list of items recalled from
earlier sessions (each with an id, a kind, and its text). Decide which items are
DIRECTLY useful for answering THIS specific message right now.

KEEP an item only if it is on-topic and specifically helpful for the current
message. DROP:
  - generic background / operational notes that apply to almost any request
    (e.g. "the agent has no access to X, use Y instead", tool/integration
    inventories, SEO notes) unless the message is specifically about that;
  - items about a different subject than the current message;
  - anything only loosely or incidentally related.

Be strict: when in doubt, DROP. Keeping nothing is a valid answer.

Output STRICT JSON with exactly one field, the ids to KEEP:
  { "relevant": ["<id>", "<id>"] }
No markdown fence, no commentary.`;

/** Build a relevance judge backed by the provider's FAST model class. */
export function createRecallRelevanceJudge(
  opts: RecallRelevanceJudgeOptions,
): RecallRelevanceJudge {
  const model = opts.model.trim();
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const maxChars = opts.maxCandidateChars ?? DEFAULT_MAX_CANDIDATE_CHARS;
  const log = opts.log ?? ((msg): void => console.error(msg));

  return {
    async filterRelevant(
      userMessage: string,
      candidates: readonly RecallCandidate[],
    ): Promise<Set<string>> {
      const allIds = new Set(candidates.map((c) => c.id));
      // Nothing to judge, or no usable message → keep everything (cheap legs win).
      if (candidates.length === 0 || userMessage.trim().length === 0) {
        return allIds;
      }

      const lines = candidates.map((c) => {
        const text = c.text.replace(/\s+/g, ' ').trim().slice(0, maxChars);
        return `[id=${c.id} kind=${c.kind}] ${text}`;
      });
      const userBlock =
        `Current message:\n${userMessage.trim()}\n\n` +
        `Recalled items:\n${lines.join('\n')}`;

      try {
        const response = await opts.llm.complete({
          model,
          maxTokens,
          system: SYSTEM_PROMPT,
          messages: [textMessage('user', userBlock)],
        });
        const replyText = collectText(response.content);
        if (!replyText) {
          log('[recall-judge] empty response — keeping all candidates');
          return allIds;
        }
        const parsed = parseJsonStrict(replyText);
        const rawRelevant = (parsed as { relevant?: unknown } | null)?.relevant;
        if (!Array.isArray(rawRelevant)) {
          log(
            `[recall-judge] non-JSON / missing "relevant": ${replyText.slice(0, 120)}… — keeping all`,
          );
          return allIds;
        }
        // Intersect with known ids so a hallucinated id can't resurrect or
        // invent a candidate.
        const kept = new Set<string>();
        for (const id of rawRelevant) {
          if (typeof id === 'string' && allIds.has(id)) kept.add(id);
        }
        return kept;
      } catch (err) {
        log(
          `[recall-judge] judge call failed — keeping all candidates: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return allIds;
      }
    },
  };
}

/** Parse strict JSON, tolerating a stray ```fence the model might add. */
function parseJsonStrict(raw: string): unknown {
  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/i, '')
    .trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}
