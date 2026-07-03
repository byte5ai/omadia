/**
 * Per-turn direct-answer persona routing via a cheap Haiku classifier
 * (Wave 8 — twin of {@link routeTurnModel} in `modelRouter.ts`).
 *
 * An Agent can attach N skills as "direct-answer" persona candidates — skills
 * that shape the TOP-LEVEL orchestrator's own system prompt for a turn, with
 * no sub-agent/tool-call indirection (unlike `agent_subagents.skill_id`,
 * which backs a delegated specialist). This module picks, per turn, which
 * (if any) candidate fits the user's message.
 *
 * Progressive disclosure: the classifier only ever sees each candidate's
 * cheap `name` + `description` — never the full `body`. The body is loaded
 * and installed as the system prompt only after a candidate is chosen.
 *
 * Safety: exactly like model routing, this NEVER breaks a turn. Any
 * classifier error, timeout, or ambiguous output falls back to `skillId:
 * null` (the Agent's ordinary default identity) — we'd rather run generic
 * than misfire into the wrong persona. Zero candidates short-circuits before
 * any classifier call, so Agents without persona skills pay nothing extra.
 */
import type { LlmProvider } from '@omadia/llm-provider';
import { collectText, textMessage } from '@omadia/llm-provider';
import { recordUsage } from '@omadia/usage-telemetry';

export interface PersonaCandidate {
  readonly skillId: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
}

/** `matched` = classifier picked a candidate. `none` = classifier chose the
 *  default identity. `fallback` = the classifier call itself failed. */
export type PersonaRoutingBucket = 'matched' | 'none' | 'fallback';

export interface PersonaRouteResult {
  /** The chosen candidate's skill id, or `null` for the default identity. */
  readonly skillId: string | null;
  readonly bucket: PersonaRoutingBucket;
  readonly classifierModel: string;
}

// Deliberately not a plausible skill slug (real slugs are short human names
// like "sales-bot") — a candidate literally slugged "none" would otherwise be
// indistinguishable from the classifier opting out.
const NONE_TOKEN = 'NO_PERSONA_MATCH';

/** Strips quotes/backticks/trailing punctuation a model reply sometimes adds
 *  around a bare slug (e.g. `"sales-bot"`, `sales-bot.`, `` `sales-bot` ``) so
 *  exact slug matching doesn't miss an otherwise-correct answer. */
function normalizeVerdict(text: string): string {
  return text.trim().replace(/^[\s"'`]+|[\s"'`.,!?]+$/g, '');
}

function buildClassifierSystem(candidates: readonly PersonaCandidate[]): string {
  const lines = candidates.map(
    (c, i) => `${i + 1}. ${c.slug} — ${c.name}: ${c.description || '(no description)'}`,
  );
  return [
    'You are a persona router. Given the candidates below, pick the ONE',
    "whose description best matches the user's message, or answer",
    `"${NONE_TOKEN}" if none clearly fits (a generic default persona will`,
    'answer instead). When unsure, prefer the more specific candidate — but',
    `default to "${NONE_TOKEN}" rather than force a poor match.`,
    '',
    'Candidates:',
    ...lines,
    '',
    `Reply with ONLY the candidate's slug, or "${NONE_TOKEN}". No other text.`,
  ].join('\n');
}

/**
 * Classifies `userMessage` against `candidates` and returns the persona
 * (skill id) the turn should adopt, or `null` for the Agent's default
 * identity. Best-effort: returns `{skillId: null, bucket: 'fallback'}` on any
 * classifier failure.
 */
export async function routeTurnPersona(
  provider: LlmProvider,
  candidates: readonly PersonaCandidate[],
  userMessage: string,
  classifierModel: string,
): Promise<PersonaRouteResult> {
  if (candidates.length === 0) {
    return { skillId: null, bucket: 'none', classifierModel };
  }
  const text = userMessage.trim().slice(0, 4000);
  if (!text) {
    return { skillId: null, bucket: 'none', classifierModel };
  }
  try {
    const res = await provider.complete({
      model: classifierModel,
      maxTokens: 16,
      system: buildClassifierSystem(candidates),
      messages: [textMessage('user', text)],
    });
    recordUsage({
      source: 'persona-router',
      model: classifierModel,
      inputTokens: res.usage.inputTokens,
      outputTokens: res.usage.outputTokens,
      cacheReadTokens: res.usage.cacheReadTokens ?? 0,
      cacheCreationTokens: res.usage.cacheWriteTokens ?? 0,
    });
    const verdict = normalizeVerdict(collectText(res.content));
    const picked = candidates.find(
      (c) => c.slug.toLowerCase() === verdict.toLowerCase(),
    );
    if (picked) {
      return { skillId: picked.skillId, bucket: 'matched', classifierModel };
    }
    // NONE or any unrecognised/ambiguous reply → default identity, not an error.
    return { skillId: null, bucket: 'none', classifierModel };
  } catch (err) {
    console.warn(
      '[persona-router] classification failed — using default identity:',
      err instanceof Error ? err.message : err,
    );
    return { skillId: null, bucket: 'fallback', classifierModel };
  }
}
