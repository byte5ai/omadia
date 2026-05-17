/**
 * Privacy-Engine Hardening — Single-Token-Bypass.
 *
 * When a user's input message is dominated by PII tokens after the
 * privacy guard tokenises it, the LLM has no semantic content to work
 * with. In practice the LLM tends to rationalise the leftover tokens
 * as "unfilled template variables" and hallucinates a polite "you forgot
 * to fill in [Name]"-style response. Observed in production 2026-05-15
 * (Christian-Wendler-screenshot in HANDOFF).
 *
 * Instead of letting the LLM hallucinate, we short-circuit before the
 * call and ship a clear "kann ich nicht beantworten" response. The
 * operator sees the bypass diagnostic in stdout (and eventually the
 * privacy receipt once S-7.5 lands).
 *
 * Pure: no I/O beyond the privacy handle's `processOutbound` call. The
 * bypass logic doesn't know about chat history or system prompts — it
 * only looks at THIS turn's user message. Other turns in the
 * conversation are unaffected.
 */

import type { PrivacyTurnHandle } from './privacyHandle.js';

/**
 * Local copy of the canonical privacy-guard token shape. Kept in sync
 * with `TOKEN_REGEX` in `@omadia/plugin-privacy-guard/tokenizeMap` —
 * the orchestrator already speaks this protocol (cf. the streaming
 * boundary helper in `privacyHandle.ts`), so duplicating the small
 * literal here avoids a cross-package import for a single regex.
 */
const TOKEN_REGEX = /«[A-Z][A-Z_]*_\d+»/g;

export interface TokenSaturationBypassConfig {
  /**
   * Trigger threshold as a ratio of non-whitespace original characters
   * that got replaced by tokens. Default 0.65 — empirically tuned to
   * avoid false positives on realistic German chat inputs where the
   * user references multiple people inside a normal sentence (e.g.
   * "Mit Marcel Wege und Anna Müller das Meeting" → coverage ≈ 0.56,
   * which the LLM handles fine). Only inputs that are dominated by
   * tokens — essentially name lists with minimal connective tissue —
   * cross this line. The 2026-05-15 production-screenshot case
   * ("Hey, Bitchi, sei lieb Du Deinem Papa Marcel!" → r ≈ 0.51) sits
   * below the threshold by design: we accept the occasional
   * hallucination on that specific shape rather than the larger
   * false-positive surface a lower threshold would create. The
   * orphan-placeholder footer (engine slice #4) softens the impact
   * when the LLM does produce `[Name]` artifacts.
   */
  readonly ratio: number;
  /**
   * Minimum non-whitespace input length to even consider bypass.
   * Default 15 — a typical short greeting + one name ("Hi Marcel")
   * sits below this and never triggers, regardless of ratio.
   */
  readonly minLength: number;
  /**
   * Minimum distinct token count to consider bypass. Default 4 —
   * paired with the high ratio threshold so the bypass fires only on
   * inputs where 4+ entities saturate the message. Three-name
   * sentences with descriptive context (e.g. "Marcel, Anna, Ben —
   * alle drei im Office heute?") stay below this floor and reach the
   * LLM normally.
   */
  readonly minTokenCount: number;
}

export const DEFAULT_BYPASS_CONFIG: TokenSaturationBypassConfig = {
  ratio: 0.65,
  minLength: 15,
  minTokenCount: 4,
};

export interface TokenSaturationAnalysis {
  readonly triggered: boolean;
  /** Total non-whitespace chars in the original user message. */
  readonly originalChars: number;
  /** Sum of char-lengths of all `«TYPE_N»` tokens in the tokenised text. */
  readonly tokenChars: number;
  /** Non-whitespace chars in the tokenised text that are NOT inside a token shape. */
  readonly survivedChars: number;
  /** Number of distinct token occurrences in the tokenised text. */
  readonly tokenCount: number;
  /** Fraction of original non-whitespace chars that got tokenised away. */
  readonly coverageRatio: number;
}

/**
 * Compute saturation statistics for a single user message against the
 * active privacy handle. Caller decides what to do with the result
 * (typically: ship a canned answer instead of the LLM call).
 */
export async function analyzeTokenSaturation(
  userMessage: string,
  privacy: PrivacyTurnHandle,
  config: TokenSaturationBypassConfig = DEFAULT_BYPASS_CONFIG,
): Promise<TokenSaturationAnalysis> {
  const originalNonWs = stripWhitespace(userMessage);
  if (originalNonWs.length < config.minLength) {
    return {
      triggered: false,
      originalChars: originalNonWs.length,
      tokenChars: 0,
      survivedChars: originalNonWs.length,
      tokenCount: 0,
      coverageRatio: 0,
    };
  }
  let outbound;
  try {
    outbound = await privacy.processOutbound({
      systemPrompt: '',
      messages: [{ role: 'user', content: userMessage }],
    });
  } catch {
    // Tokenisation itself failed — refuse to bypass (the LLM path can
    // still degrade gracefully, but we shouldn't double-fail).
    return {
      triggered: false,
      originalChars: originalNonWs.length,
      tokenChars: 0,
      survivedChars: originalNonWs.length,
      tokenCount: 0,
      coverageRatio: 0,
    };
  }
  const tokenised = outbound.messages[0]?.content ?? userMessage;
  const tokenisedNonWs = stripWhitespace(tokenised);
  let tokenChars = 0;
  let tokenCount = 0;
  const re = new RegExp(TOKEN_REGEX.source, 'g');
  for (const match of tokenised.matchAll(re)) {
    tokenChars += match[0].length;
    tokenCount += 1;
  }
  const survivedChars = Math.max(0, tokenisedNonWs.length - tokenChars);
  const coverageRatio =
    originalNonWs.length > 0
      ? (originalNonWs.length - survivedChars) / originalNonWs.length
      : 0;
  const triggered =
    coverageRatio >= config.ratio && tokenCount >= config.minTokenCount;
  return {
    triggered,
    originalChars: originalNonWs.length,
    tokenChars,
    survivedChars,
    tokenCount,
    coverageRatio,
  };
}

/**
 * User-facing canned answer when bypass triggers. German to match the
 * existing chat-UI tone. Mentions "Privacy-Guard" explicitly so the
 * user can attribute the refusal correctly and report false positives.
 */
export function bypassCannedAnswer(analysis: TokenSaturationAnalysis): string {
  const pct = Math.round(analysis.coverageRatio * 100);
  return [
    'Ich kann deine Nachricht so nicht sinnvoll beantworten — unser ' +
      'Privacy-Guard hat den Großteil davon als personenbezogene Daten ' +
      `(Namen / Adressen / o.ä.) erkannt (${String(pct)}% des Texts ` +
      `${String(analysis.tokenCount)} Tokens).`,
    '',
    'Formuliere die Frage bitte ohne konkrete Personenangaben — oder, ' +
      'falls die Erkennung danebenliegt (z.B. bei kreativen Spitznamen ' +
      'oder gängigen Begriffen), sag dem Team Bescheid.',
  ].join('\n');
}

function stripWhitespace(text: string): string {
  return text.replace(/\s+/gu, '');
}
