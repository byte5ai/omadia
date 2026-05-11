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

import type Anthropic from '@anthropic-ai/sdk';
import type { EntryType } from '@omadia/plugin-api';

import type { SignificanceScorer } from './captureFilter.js';

export interface HaikuSignificanceScorerOptions {
  anthropic: Anthropic;
  /** Anthropic model id. Default: `claude-haiku-4-5-20251001`. */
  model?: string;
  /** Max tokens budget for the scoring response. Tiny — JSON only. */
  maxTokens?: number;
  /** Optional log sink. Defaults to `console.error`. */
  log?: (msg: string) => void;
}

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
                0.5 = useful answer, but no new fact about the user/world.
                1.0 = high-signal: a decision, deadline, name, address, password
                      hint, customer-specific quirk, recurring pattern.
  entry_type
    "memory"  — A general fact, preference, or note (default).
    "process" — A repeatable how-to / SOP / workflow description.
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

      const response = await opts.anthropic.messages.create({
        model,
        max_tokens: maxTokens,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: `<turn>\n${trimmed}\n</turn>`,
          },
        ],
      });

      const replyText = extractFirstText(response.content);
      if (!replyText) {
        log('[significance-scorer] empty response from Haiku');
        return { score: 0 };
      }

      const parsed = parseJsonStrict(replyText);
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

function extractFirstText(
  content: Anthropic.Messages.ContentBlock[] | undefined,
): string | null {
  if (!content) return null;
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      return block.text;
    }
  }
  return null;
}

/** Parse strict JSON; tolerate a leading/trailing fence the model might
 *  ship despite the system prompt. Returns `null` on any parse error. */
function parseJsonStrict(raw: string): unknown {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
