/**
 * @omadia/orchestrator-extras — SignificanceScorer (palaia / OB-71).
 *
 * Haiku-backed `[0,1]` significance score + optional `entry_type` suggestion
 * for a captured turn. Used by `CaptureFilter` at `level=normal|aggressive`.
 *
 * Failure semantics (HANDOFF · OB-71 Eckpfeiler #2): every error here is
 * caught by `CaptureFilter.classify()` itself; the turn is still persisted
 * with the default classification. We log on stderr (Fly drops stdout INFO)
 * and let the caller do the policy.
 */

import type { LlmProvider } from '@omadia/llm-provider';
import { collectText, textMessage } from '@omadia/llm-provider';
import type { DecisionModelService, DecisionQuestion, EntryType } from '@omadia/plugin-api';
import { normalizeDecisionBatch, parseLlmJson } from '@omadia/plugin-api';

import type { SignificanceScorer } from './captureFilter.js';
import type { OpenJobPrivacy } from './jobPrivacy.js';

export interface HaikuSignificanceScorerOptions {
  /** Provider-agnostic LLM (Anthropic adapter today). Was `anthropic` pre-phase-2. */
  llm: LlmProvider;
  /** Anthropic model id. Default: `claude-haiku-4-5-20251001`. */
  model?: string;
  /** Max tokens budget for the scoring response. Tiny — JSON only. */
  maxTokens?: number;
  /** Optional log sink. Defaults to `console.error`. */
  log?: (msg: string) => void;
  /**
   * #1540 — the Privacy Shield route for the scored text. Every caller sends
   * stored text: the live capture filter (the turn's masked view, or the
   * stored turn when the turn had no shield), the bulk promotion job (stored
   * turns with their real values) and the scratch-promotion reaper (agent
   * notes). A run that cannot mask throws, so each caller counts a failed
   * score instead of an insignificant turn. Absent ⇒ the text goes out as
   * stored.
   */
  privacy?: OpenJobPrivacy;
  /**
   * `decisionModel@1` — resolved LAZILY per call. With a batch-capable
   * service the masked text is scored in ONE batch (`significant` yes/no →
   * score, `entry_type` choice) instead of the LLM; any error or missing
   * answer falls back to the LLM call unchanged.
   */
  decide?: () => DecisionModelService | undefined;
}

const DECISION_TASK = 'memory.significance';
const DECISION_QUESTIONS: Readonly<Record<string, DecisionQuestion>> = {
  significant: {
    kind: 'yesno',
    instruction:
      'Is this conversation turn worth remembering for future sessions? Yes for a decision, deadline, ' +
      'name, customer-specific quirk, recurring pattern, or learned data-model / schema / domain ' +
      'conventions. No for chit-chat, thanks, greetings, a one-off answer with no new fact, or a ' +
      'question answered from what is already remembered.',
  },
  entry_type: {
    kind: 'choice',
    instruction: 'What kind of memory entry is this turn?',
    options: [
      { id: 'memory', description: 'A general fact, preference, or note.' },
      {
        id: 'process',
        description:
          'A repeatable how-to / SOP / workflow, or a stable data-model / schema / convention.',
      },
      {
        id: 'task',
        description:
          'Something the user explicitly asked to be done or tracked (remind me, add to my list, follow up).',
      },
    ],
  },
};

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_MAX_TOKENS = 256;

const SYSTEM_PROMPT = `You are a memory significance classifier.
You are given a single conversation turn between a user and an assistant.

Output STRICT JSON with exactly two fields:
  {
    "score":      number in [0,1],
    "entry_type": "memory" | "process" | "task"
  }

Definitions:
  score      — How worth-remembering is this turn for future recall?
                0.0 = trivial chit-chat, weather, "thanks", repeated greetings.
                0.1 = the user only asks about something already known and the
                      answer restates it ("which bike do I like?", "you told me
                      earlier that …"): nothing new to remember.
                0.5 = useful answer, but no new fact about the user/world.
                1.0 = high-signal: a decision, deadline, name, address, password
                      hint, customer-specific quirk, recurring pattern, OR
                      **learned data-model / schema / domain conventions**
                      (which table/entity holds which data, field names and
                      meaning, entity-set names, how to filter/join). This
                      reusable structure must survive across sessions so the
                      agent never re-discovers it — score it HIGH (>=0.85).
                      (A time-bound data snapshot like "29 courses next week"
                      is mid-signal ~0.5, NOT high.)
  entry_type
    "memory"  — A general fact, preference, or note (default).
    "process" — A repeatable how-to / SOP / workflow description, OR a stable
                 data-model / schema / convention (entities, fields, lookups).
    "task"    — Something the user explicitly asked to be done or
                 tracked ("remind me", "add to my list", "follow up").

Reply with JSON only — NO markdown fence, NO commentary.`;

/** Build a `SignificanceScorer` backed by an Anthropic Haiku call. */
export function createHaikuSignificanceScorer(
  opts: HaikuSignificanceScorerOptions,
): SignificanceScorer {
  const model = opts.model?.trim() || DEFAULT_MODEL;
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const log = opts.log ?? ((msg): void => console.error(msg));

  return {
    async score(text: string): Promise<{
      score: number;
      suggestedEntryType?: EntryType;
    }> {
      // Defensive: an empty text body is trivially zero-significance and
      // there's no point burning a Haiku call.
      const trimmed = text.trim();
      if (trimmed.length === 0) {
        return { score: 0 };
      }

      const run = opts.privacy?.('significance-scorer');
      const masked = run ? await run.mask(trimmed) : { send: true as const, text: trimmed };
      if (!masked.send) {
        throw new Error(`privacy: ${masked.reason} — score skipped`);
      }

      const decided = await decideSignificance(opts.decide, masked.text, log);
      if (decided) return decided;

      const response = await opts.llm.complete({
        model,
        maxTokens,
        system: SYSTEM_PROMPT,
        messages: [textMessage('user', `<turn>\n${masked.text}\n</turn>`)],
      });

      const replyText = collectText(response.content);
      if (!replyText) {
        log('[significance-scorer] empty response from Haiku');
        return { score: 0 };
      }

      const parsed = parseLlmJson(replyText);
      if (!parsed) {
        log(
          `[significance-scorer] non-JSON response: ${replyText.slice(0, 120)}…`,
        );
        return { score: 0 };
      }

      const rawScore = (parsed as { score?: unknown }).score;
      const rawEntryType = (parsed as { entry_type?: unknown }).entry_type;

      const score = clamp01(typeof rawScore === 'number' ? rawScore : 0);
      const suggestedEntryType: EntryType | undefined =
        rawEntryType === 'memory' ||
        rawEntryType === 'process' ||
        rawEntryType === 'task'
          ? rawEntryType
          : undefined;

      return { score, suggestedEntryType };
    },
  };
}

/**
 * The decision-model score: one batch over the already-masked turn. Returns
 * undefined — never throws — without a batch-capable decision model, on a
 * failed call, or when either answer is missing; the caller then asks the
 * LLM. Logs timing and the outcome only, never text.
 */
async function decideSignificance(
  decide: (() => DecisionModelService | undefined) | undefined,
  maskedText: string,
  log: (msg: string) => void,
): Promise<{ score: number; suggestedEntryType: EntryType } | undefined> {
  let service: DecisionModelService | undefined;
  try {
    service = decide?.();
  } catch {
    return undefined;
  }
  if (!service?.decideAll) return undefined;
  const startedAt = Date.now();
  const prefix = (): string =>
    `[significance-scorer] decision model provider=${service.provider} ms=${String(Date.now() - startedAt)}`;
  try {
    const result = normalizeDecisionBatch(
      { questions: DECISION_QUESTIONS },
      await service.decideAll({ task: DECISION_TASK, input: maskedText, questions: DECISION_QUESTIONS }),
    );
    const significant = result.answers['significant'];
    const entryType = result.answers['entry_type'];
    if (significant?.kind !== 'yesno' || entryType?.kind !== 'choice') {
      log(`${prefix()} missing answers — LLM scorer`);
      return undefined;
    }
    const type = entryType.choice as EntryType;
    const score = clamp01(significant.probability);
    log(`${prefix()} score=${score.toFixed(2)} entry_type=${type}`);
    return { score, suggestedEntryType: type };
  } catch (err) {
    log(`${prefix()} failed (${err instanceof Error ? err.name : 'error'}) — LLM scorer`);
    return undefined;
  }
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
