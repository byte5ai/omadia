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
 * Failure semantics: FAIL-OPEN, but DETERMINISTICALLY so. A genuine verdict
 * (the model answered with parseable JSON) is cached and replayed for an
 * identical (model, message, candidate-set) so the same query does not
 * oscillate between "filtered" and "unfiltered" across repeated turns (R5). An
 * abstain — empty/non-JSON response or a provider throw — returns ALL candidate
 * ids (the cheap legs already floored + limited them, so keeping that set is
 * itself deterministic) and is NOT cached, so a transient failure can neither
 * poison the cache nor hide recall the cheaper legs surfaced.
 *
 * Privacy (WP-10): the request carries stored real values, so with a privacy
 * guard installed it goes through `opts.privacy` first — inside a turn the
 * turn's handle, `maskReplayedAnswer`, whatever `mask_user_prompt` says. A run
 * that cannot mask skips the judge like an abstain: every candidate kept,
 * nothing sent, nothing cached.
 */

import type { LlmProvider } from '@omadia/llm-provider';
import { collectText, textMessage } from '@omadia/llm-provider';

import type { OpenJobPrivacy } from './jobPrivacy.js';

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
  /**
   * Max distinct (message, candidate-set) verdicts to remember for replay.
   * Bounds memory; 0 disables caching. Default 256.
   */
  verdictCacheMax?: number;
  log?: (msg: string) => void;
  /**
   * WP-10 — the Privacy Shield route for the judge's request. The plugin
   * passes the in-turn route (`createInTurnJobPrivacy`). Absent ⇒ the request
   * goes out as built.
   */
  privacy?: OpenJobPrivacy;
}

const DEFAULT_MAX_TOKENS = 512;
const DEFAULT_MAX_CANDIDATE_CHARS = 280;
const DEFAULT_VERDICT_CACHE_MAX = 256;

/**
 * Stable cache key for a verdict. Candidate id+text are included (ids are
 * stable and texts derive deterministically from the same source rows, so an
 * identical recall produces an identical key) and sorted so candidate ordering
 * never changes the key.
 */
function verdictCacheKey(
  model: string,
  userMessage: string,
  candidates: readonly RecallCandidate[],
): string {
  const parts = candidates
    .map((c) => `${c.id}${c.kind}${c.text.replace(/\s+/g, ' ').trim()}`)
    .sort();
  return `${model}\0${userMessage.trim()}\0${parts.join('')}`;
}

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
  const cacheMax = opts.verdictCacheMax ?? DEFAULT_VERDICT_CACHE_MAX;
  const log = opts.log ?? ((msg): void => console.error(msg));

  // Per-instance verdict cache (the judge is constructed once per boot, so this
  // lives for the process). Insertion-ordered Map → evict oldest on overflow.
  // Stores ONLY genuine verdicts (the kept id list), never abstains.
  const verdictCache = new Map<string, readonly string[]>();

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

      // Replay a prior genuine verdict for an identical query (R5 determinism).
      const cacheKey =
        cacheMax > 0 ? verdictCacheKey(model, userMessage, candidates) : '';
      if (cacheMax > 0) {
        const cached = verdictCache.get(cacheKey);
        if (cached) {
          // Refresh recency (move to newest) and intersect with current ids.
          verdictCache.delete(cacheKey);
          verdictCache.set(cacheKey, cached);
          const kept = new Set<string>();
          for (const id of cached) if (allIds.has(id)) kept.add(id);
          return kept;
        }
      }

      const lines = candidates.map((c) => {
        const text = c.text.replace(/\s+/g, ' ').trim().slice(0, maxChars);
        return `[id=${c.id} kind=${c.kind}] ${text}`;
      });
      const userBlock =
        `Current message:\n${userMessage.trim()}\n\n` +
        `Recalled items:\n${lines.join('\n')}`;

      try {
        const run = opts.privacy?.('recall-judge');
        const masked = run
          ? await run.mask(userBlock)
          : { send: true as const, text: userBlock };
        if (!masked.send) {
          log(`[recall-judge] privacy: ${masked.reason} — judge skipped, keeping all candidates`);
          return allIds;
        }
        const response = await opts.llm.complete({
          model,
          maxTokens,
          system: SYSTEM_PROMPT,
          messages: [textMessage('user', masked.text)],
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
        // Cache this genuine verdict for deterministic replay. Evict the oldest
        // entry when over the cap (insertion-ordered Map).
        if (cacheMax > 0) {
          verdictCache.set(cacheKey, [...kept]);
          if (verdictCache.size > cacheMax) {
            const oldest = verdictCache.keys().next().value;
            if (oldest !== undefined) verdictCache.delete(oldest);
          }
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
