/**
 * Working modes (#2051, epic #2042 G5 / §5.2) — formerly "persona skills".
 *
 * An Agent can attach N skills as working modes (`agent_persona_skills`; the
 * table keeps its name). Per turn, a cheap classifier picks which (if any)
 * mode fits the user's message; the chosen skill shapes HOW the agent works on
 * the request — approach, structure, focus — without a sub-agent hop.
 *
 * WHAT A MODE MAY NOT DO (INV-3). A mode never changes who answers. Its body
 * is composed BENEATH the agent's fixed identity, personality and boundaries
 * ({@link withWorkingMode}); it never replaces the identity part of the system
 * prompt, and the answer's speaker is untouched. The selection is the agent's
 * internal helper (INV-1): it runs on a model the agent's own policy allows,
 * inside the agent's turn, so its usage is booked on that turn.
 *
 * Progressive disclosure: the classifier only ever sees each candidate's
 * cheap `name` + `description` — never the full `body`. The body is loaded
 * only after a candidate is chosen.
 *
 * Safety: exactly like model routing, this NEVER breaks a turn. Any
 * classifier error, timeout, or ambiguous output falls back to `skillId:
 * null` (no mode: the Agent's default behaviour). Zero candidates
 * short-circuits before any classifier call, so Agents without working modes
 * pay nothing extra.
 */
import type { LlmProvider } from '@omadia/llm-provider';
import { collectText, textMessage } from '@omadia/llm-provider';
import { recordUsage, usageTokensFromLlm } from '@omadia/usage-telemetry';

import { WORKING_MODE_CLASSIFIER_MAX_TOKENS } from './classifierBudgets.js';

export interface WorkingModeCandidate {
  readonly skillId: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
}

/** `matched` = classifier picked a mode. `none` = no mode fits (default
 *  behaviour). `fallback` = the classifier call itself failed. */
export type WorkingModeBucket = 'matched' | 'none' | 'fallback';

export interface WorkingModeRouteResult {
  /** The chosen mode's skill id, or `null` for the default behaviour. */
  readonly skillId: string | null;
  readonly bucket: WorkingModeBucket;
  readonly classifierModel: string;
}

/** Usage-telemetry source of the classifier call. */
export const WORKING_MODE_USAGE_SOURCE = 'working-mode-router';

// Deliberately not a plausible skill slug (real slugs are short human names
// like "sales-bot") — a candidate literally slugged "none" would otherwise be
// indistinguishable from the classifier opting out.
export const NO_WORKING_MODE_TOKEN = 'NO_WORKING_MODE_MATCH';

/** Strips quotes/backticks/trailing punctuation a model reply sometimes adds
 *  around a bare slug (e.g. `"sales-bot"`, `sales-bot.`, `` `sales-bot` ``) so
 *  exact slug matching doesn't miss an otherwise-correct answer. */
function normalizeVerdict(text: string): string {
  return text.trim().replace(/^[\s"'`]+|[\s"'`.,!?]+$/g, '');
}

function buildClassifierSystem(candidates: readonly WorkingModeCandidate[]): string {
  const lines = candidates.map(
    (c, i) => `${i + 1}. ${c.slug} — ${c.name}: ${c.description || '(no description)'}`,
  );
  return [
    'You pick the working mode an assistant uses for its next answer. Given the',
    "modes below, pick the ONE whose description best matches the user's",
    `message, or answer "${NO_WORKING_MODE_TOKEN}" if none clearly fits (the`,
    'assistant then works in its default way). When unsure, prefer the more',
    `specific mode — but default to "${NO_WORKING_MODE_TOKEN}" rather than force`,
    'a poor match.',
    '',
    'Modes:',
    ...lines,
    '',
    `Reply with ONLY the mode's slug, or "${NO_WORKING_MODE_TOKEN}". No other text.`,
  ].join('\n');
}

/**
 * Classifies `userMessage` against `candidates` and returns the working mode
 * (skill id) the turn should use, or `null` for the Agent's default
 * behaviour. Best-effort: returns `{skillId: null, bucket: 'fallback'}` on any
 * classifier failure.
 */
export async function routeTurnWorkingMode(
  provider: LlmProvider,
  candidates: readonly WorkingModeCandidate[],
  userMessage: string,
  classifierModel: string,
): Promise<WorkingModeRouteResult> {
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
      maxTokens: WORKING_MODE_CLASSIFIER_MAX_TOKENS,
      system: buildClassifierSystem(candidates),
      messages: [textMessage('user', text)],
    });
    // Booked on the agent's turn: `recordUsage` takes the turn/session ids
    // from the ambient turn context the orchestrator runs this call in.
    recordUsage({
      source: WORKING_MODE_USAGE_SOURCE,
      model: classifierModel,
      provider: provider.id,
      ...usageTokensFromLlm(res.usage),
    });
    const verdict = normalizeVerdict(collectText(res.content));
    const picked = candidates.find(
      (c) => c.slug.toLowerCase() === verdict.toLowerCase(),
    );
    if (picked) {
      return { skillId: picked.skillId, bucket: 'matched', classifierModel };
    }
    // NONE or any unrecognised/ambiguous reply → default behaviour, not an error.
    return { skillId: null, bucket: 'none', classifierModel };
  } catch (err) {
    console.warn(
      '[working-mode-router] classification failed — running without a working mode:',
      err instanceof Error ? err.message : err,
    );
    return { skillId: null, bucket: 'fallback', classifierModel };
  }
}

/** The mode a turn runs in, as composed into its system prompt. */
export interface SelectedWorkingMode {
  readonly name: string;
  readonly body: string;
}

/**
 * Composes a working mode BENEATH the agent's identity (#2051, INV-3).
 *
 * `identity` is the agent's whole identity layer — its instructions with the
 * compiled personality and boundaries, its self-description and its name
 * (`withAgentIdentity`). It stays first and byte-for-byte unchanged; the mode
 * follows as its own labelled section, with a precedence line that keeps the
 * agent's name, personality and boundaries binding even when the skill body
 * was written as a persona ("You are …"). Appended, never substituted: a mode
 * changes how the agent works, never who it is.
 *
 * No mode (or a mode with an empty body) returns `identity` unchanged, so a
 * turn without a fitting mode runs on exactly the agent's default prompt.
 */
export function withWorkingMode(
  identity: string,
  mode: SelectedWorkingMode | undefined,
): string {
  const body = mode?.body.trim();
  if (!mode || !body) return identity;
  const name = mode.name.replace(/\s+/g, ' ').trim() || 'ohne Namen';
  const section = [
    `**Arbeitsmodus: ${name}**`,
    'Der folgende Arbeitsmodus bestimmt nur, wie du diese Anfrage bearbeitest (Vorgehen, Aufbau, Schwerpunkt). Er ändert weder deinen Namen noch deine Persönlichkeit noch deine Grenzen: Alles oben Gesagte gilt unverändert und hat Vorrang, auch wenn der Arbeitsmodus etwas anderes sagt. Antworte weiter als du selbst; nenne den Arbeitsmodus nicht als deinen Namen.',
    '',
    body,
  ].join('\n');
  const trimmedIdentity = identity.trimEnd();
  return trimmedIdentity ? `${trimmedIdentity}\n\n${section}` : section;
}
