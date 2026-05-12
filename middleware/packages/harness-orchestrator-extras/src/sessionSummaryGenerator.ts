/**
 * @omadia/orchestrator-extras — SessionSummaryGenerator (palaia / OB-75).
 *
 * Haiku-backed bullet-list summary for a session. Called lazy-on-demand
 * by the `BriefingService` when, during a `loadSessionBriefing` call,
 * no fresh summary is present for a session (or the latest summary
 * is older than the newest non-summary turn of the session).
 *
 * Storage convention (see `SESSION_SUMMARY_MARKER`): the result is
 * persisted by the caller via `kg.ingestTurn` as a turn with
 *   - `userMessage = '<session-summary>'` (marker for lookup filter)
 *   - `assistantAnswer = <summary text>`
 *   - `entryType = 'process'`
 * No schema change required.
 *
 * Failure semantics: all errors are caught, a log line written to stderr
 * (Fly drops stdout INFO), and an empty string is returned. The caller
 * then persists NO summary — on the next Briefing-Load a retry is
 * attempted.
 */

import type Anthropic from '@anthropic-ai/sdk';

export interface SessionSummaryInput {
  /** Session scope (e.g. 'chat-1', 'teams-…'). Pure diagnostic field
   *  for the prompt; not used for filtering. */
  scope: string;
  /** Last ~10 turns in chronological order. Caller has already filtered
   *  them (no `<session-summary>` marker turns). */
  turns: ReadonlyArray<{
    time: string;
    userMessage: string;
    assistantAnswer: string;
  }>;
}

export interface SessionSummaryGenerator {
  /** Returns a short Markdown bullet list of the most important
   *  decisions / outputs / open tasks. Empty string on failure
   *  or insufficient material. */
  generate(input: SessionSummaryInput): Promise<string>;
}

export interface HaikuSessionSummaryGeneratorOptions {
  anthropic: Anthropic;
  /** Anthropic model id. Default: `claude-haiku-4-5-20251001`. */
  model?: string;
  /** Max tokens for the summary. Deliberately small — a briefing
   *  summary should be terse. Default 400 tokens. */
  maxTokens?: number;
  /** Optional log sink. Defaults to `console.error`. */
  log?: (msg: string) => void;
}

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_MAX_TOKENS = 400;

/** Marker in the `userMessage` property of a summary turn. Matched by
 *  the BriefingService on lookup and filtered out on tail-load
 *  (no recursion: a Briefing must not see itself). */
export const SESSION_SUMMARY_MARKER = '<session-summary>';

const SYSTEM_PROMPT = `You are a session-continuity summarizer for an AI assistant.

You are given the recent turns of a chat session. Produce a concise
German Markdown bullet list (max 8 bullets) covering:

  • **Entscheidungen** — was wurde beschlossen / vereinbart?
  • **Outputs** — welche konkreten Ergebnisse wurden produziert?
  • **Offene Tasks** — was bleibt zu erledigen?

Rules:
  - Bullets only. No prose, no headings, no closing summary.
  - Max 100 chars per bullet.
  - If a category has nothing, omit it (don't write "(keine)").
  - Preserve specific names, IDs, dates, numbers verbatim.
  - Drop greetings / chit-chat / clarification turns.
  - DO NOT echo any 'palaia-hint' / privacy markers — they have been
    stripped pre-input but if you see them, ignore them.

Return ONLY the Markdown bullets — no fences, no commentary.`;

/** Build a `SessionSummaryGenerator` backed by an Anthropic Haiku call. */
export function createHaikuSessionSummaryGenerator(
  opts: HaikuSessionSummaryGeneratorOptions,
): SessionSummaryGenerator {
  const model = opts.model?.trim() || DEFAULT_MODEL;
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const log = opts.log ?? ((msg): void => { console.error(msg); });

  return {
    async generate(input: SessionSummaryInput): Promise<string> {
      // No turns → nothing to summarize. Skip the LLM call.
      const turns = input.turns.filter(
        (t) =>
          (t.userMessage.trim().length > 0 ||
            t.assistantAnswer.trim().length > 0) &&
          t.userMessage !== SESSION_SUMMARY_MARKER,
      );
      if (turns.length === 0) return '';

      const transcript = turns
        .map(
          (t) =>
            `[${t.time}]\nUser: ${truncate(t.userMessage, 600)}\nAssistant: ${truncate(t.assistantAnswer, 1200)}`,
        )
        .join('\n\n');

      try {
        const response = await opts.anthropic.messages.create({
          model,
          max_tokens: maxTokens,
          system: SYSTEM_PROMPT,
          messages: [
            {
              role: 'user',
              content: `<session scope="${input.scope}">\n${transcript}\n</session>`,
            },
          ],
        });
        const text = extractFirstText(response.content);
        if (!text) {
          log(`[session-summary] empty response from Haiku (scope=${input.scope})`);
          return '';
        }
        return text.trim();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`[session-summary] Haiku call failed (scope=${input.scope}): ${msg}`);
        return '';
      }
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

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}
