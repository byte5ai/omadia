/**
 * @omadia/orchestrator-extras — SessionSummaryGenerator (palaia / OB-75).
 *
 * Haiku-backed Bullet-List-Summary für eine Session. Wird vom
 * `BriefingService` lazy-on-demand aufgerufen, wenn beim
 * `loadSessionBriefing`-Call keine frische Summary für eine Session
 * vorliegt (oder die letzte Summary älter ist als der jüngste
 * non-summary Turn der Session).
 *
 * Storage-Konvention (siehe `SESSION_SUMMARY_MARKER`): das Ergebnis
 * wird vom Caller via `kg.ingestTurn` als Turn mit
 *   - `userMessage = '<session-summary>'` (Marker für Lookup-Filter)
 *   - `assistantAnswer = <summary text>`
 *   - `entryType = 'process'`
 * persistiert. Kein Schema-Change nötig.
 *
 * Failure-Semantik: alle Errors werden gefangen, ein Log auf stderr
 * geschrieben (Fly droppt stdout INFO), und ein leerer String
 * zurückgegeben. Der Caller persistiert dann KEINE Summary — beim
 * nächsten Briefing-Load wird ein Retry versucht.
 */

import type Anthropic from '@anthropic-ai/sdk';

export interface SessionSummaryInput {
  /** Session-Scope (z.B. 'chat-1', 'teams-…'). Reines Diagnose-Feld
   *  für den Prompt; nicht zum Filtern. */
  scope: string;
  /** Letzte ~10 Turns chronologisch. Caller hat sie bereits gefiltert
   *  (keine `<session-summary>`-Marker-Turns). */
  turns: ReadonlyArray<{
    time: string;
    userMessage: string;
    assistantAnswer: string;
  }>;
}

export interface SessionSummaryGenerator {
  /** Liefert eine kurze Markdown-Bullet-Liste der wichtigsten
   *  Decisions / Outputs / offenen Tasks. Leerer String bei Failure
   *  oder zu wenig Material. */
  generate(input: SessionSummaryInput): Promise<string>;
}

export interface HaikuSessionSummaryGeneratorOptions {
  anthropic: Anthropic;
  /** Anthropic model id. Default: `claude-haiku-4-5-20251001`. */
  model?: string;
  /** Max Tokens für die Summary. Bewusst klein gehalten — eine
   *  Briefing-Summary soll prägnant sein. Default 400 Tokens. */
  maxTokens?: number;
  /** Optional log sink. Defaults to `console.error`. */
  log?: (msg: string) => void;
}

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_MAX_TOKENS = 400;

/** Marker im `userMessage`-Property eines Summary-Turns. Wird vom
 *  BriefingService beim Lookup matched und beim Tail-Load gefiltert
 *  (keine Recursion: Briefing soll nicht sich selbst sehen). */
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
