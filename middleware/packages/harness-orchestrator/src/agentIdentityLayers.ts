/**
 * The per-agent identity layer of the system prompt (#914, #967, #1878, #1890).
 *
 * Moved out of `buildOrchestrator.ts` so the runtime and the operator's
 * "Prompt" preview call the SAME functions: what the preview shows is what the
 * agent is built with, never a second rendering of it.
 */

import { applyArchetypeContract } from './registry/facilitatorNeutrality.js';
import type { ArchetypeId } from './registry/archetype.js';
import { DEFAULT_AGENT_IDENTITY, withIdentityRules } from './management/agentIdentityPrompt.js';
import {
  buildAnswerVerbosityBlock,
  DEFAULT_ANSWER_VERBOSITY,
  type AnswerVerbosity,
} from './answerVerbosity.js';
import {
  buildAnswerLanguageRule,
  DEFAULT_ANSWER_LANGUAGE,
  type AnswerLanguage,
} from './answerLanguage.js';

/**
 * Fold an Agent's own name into the identity text it speaks with (#967).
 *
 * THE PROBLEM THIS SOLVES. `assistantIdentity` is the opening section of the
 * system prompt, and a deployment's platform identity introduces the platform's
 * assistant by name. A bot provisioned into Teams as `Messias` therefore went
 * on introducing itself under that platform name: outwardly one bot, inwardly
 * another, which reads to a user as two different things wearing one avatar.
 *
 * APPENDED, NEVER SUBSTITUTED. The identity text is prose an operator wrote;
 * there is no reliable way to find and replace a name inside it, and trying
 * would corrupt text that merely mentions the name. Stating the name last is
 * both safe and unambiguous — the closing instruction is the one that binds.
 *
 * ONLY THE NAME. No description, no persona, no tone: those belong to the
 * operator's identity form, and inventing them here would put words in an
 * agent's mouth that nobody authored. An Agent that has a name and nothing
 * else keeps every behaviour it had, and answers to its name.
 *
 * A blank or absent name returns the identity byte-for-byte, which is what
 * keeps the prompt (and its cache key) unchanged for every Agent that never
 * authored one.
 */
export function withAgentName(
  identity: string | undefined,
  name: string | undefined,
): string | undefined {
  const trimmedName = name?.trim();
  if (!trimmedName) return identity;
  const nameLine = `Dein Name ist ${trimmedName}. Stelle dich unter diesem Namen vor und verwende ihn, wenn du von dir sprichst — er gilt auch dann, wenn oben ein anderer Name für dich genannt wird.`;
  const trimmedIdentity = identity?.trim();
  return trimmedIdentity ? `${trimmedIdentity}\n\n${nameLine}` : nameLine;
}

/**
 * Fold an Agent's authored SELF-DESCRIPTION into the identity text (#967
 * follow-up) — the operator's "Steckbrief" tab: short and long description.
 *
 * THE PROBLEM THIS SOLVES. These two fields described the agent everywhere a
 * human looked — the Teams store listing, the app package, the operator UI —
 * and nowhere the agent could read. An operator who wrote "HR-Assistentin für
 * Urlaub und Zeiterfassung" got a bot that rendered that sentence in a catalog
 * and could not say it when asked what it does. The identity tabs are a promise
 * that what you type is what the agent becomes; this is the half of that
 * promise that was missing.
 *
 * APPENDED, NEVER SUBSTITUTED — same rule as {@link withAgentName}, and for a
 * stronger reason here. `instructions` (via `composed_prompt`) REPLACES the
 * platform identity outright, which is deliberate and stays (#914): it is the
 * operator saying "this agent behaves like THIS instead". A description is not
 * that. It says what the agent is, not how it works, so it can only ever be an
 * addition — folding it into the replacing slot would let a one-line Steckbrief
 * silently delete a deployment's whole configured behaviour.
 *
 * VERBATIM, UNDER A LABEL. The text is the operator's own; nothing is
 * paraphrased, summarised or expanded. The labels exist because raw prose
 * pasted after a system prompt reads as an instruction rather than as a fact
 * about the agent — the label is framing, not content, and an unauthored field
 * contributes no label and no line. Nothing is invented for an empty field.
 *
 * BOTH, WHEN BOTH ARE THERE. Short and long are not two drafts of one text —
 * the Teams manifest caps them at 80 and 4000 characters precisely because they
 * answer different questions ("what is this?" vs "what can it do?"). An agent
 * asked either question should be able to answer it, so neither is dropped in
 * favour of the other. Identical values are the operator's own repetition and
 * are left alone rather than silently de-duplicated.
 */
export function withAgentSelfDescription(
  identity: string | undefined,
  descriptions: {
    readonly shortDescription?: string | undefined;
    readonly longDescription?: string | undefined;
  },
): string | undefined {
  const short = descriptions.shortDescription?.trim();
  const long = descriptions.longDescription?.trim();
  const lines: string[] = [];
  if (short) lines.push(`Kurzbeschreibung deiner Rolle: ${short}`);
  if (long) lines.push(`Ausführliche Beschreibung deiner Rolle: ${long}`);
  if (lines.length === 0) return identity;
  const block = lines.join('\n\n');
  const trimmedIdentity = identity?.trim();
  return trimmedIdentity ? `${trimmedIdentity}\n\n${block}` : block;
}

/**
 * The whole per-Agent identity layer, composed in ONE place so the precedence
 * is stated once and cannot drift between callers (#914 / #967).
 *
 * THE ORDER IS THE CONTRACT:
 *
 *  1. BASE — the platform-wide `assistantIdentity`, REPLACED outright only by
 *     the Agent's own authored behaviour text. `identityInstructions` is
 *     `COALESCE(composed_prompt, instructions)`: the Charakter (persona axes)
 *     and Grenzen (boundary presets + sycophancy guard) tabs are compiled into
 *     it upstream by `composeAgentIdentityPrompt`, after the authored text.
 *     #1878 — when the operator wrote no behaviour text
 *     (`identityReplacesBase: false`), that compiled text holds only those
 *     sections, and it is APPENDED to the platform identity instead of
 *     replacing it: a boundary or a slider alone must not silently delete the
 *     platform's identity, as the "Behaviour" field's hint promises. Absent
 *     means `true`, the pre-#1878 behaviour, for callers that cannot tell.
 *
 *  2. APPENDED — the Steckbrief (short, then long description). Facts about the
 *     agent, layered ON TOP of whichever text step 1 produced, because a
 *     description must never be able to delete configured behaviour.
 *
 *  3. APPENDED LAST — the name. Last word deliberately: an operator's prose (or
 *     the platform identity) may mention some other name, and the closing
 *     instruction is the one that binds. This is why the name goes AFTER the
 *     descriptions and not directly after the identity text — a long
 *     description that names a predecessor bot must still lose to the name the
 *     agent actually wears.
 *
 * CONFLICT RULE, in one sentence: later text wins over earlier text, and
 * nothing appended can remove what step 1 established.
 *
 * DELIBERATELY EXCLUDED. `accent_color` and the avatar are rendering decisions
 * — they exist so a human can tell two bots apart at a glance in Teams. A model
 * cannot act on either, and describing them in a prompt ("deine Akzentfarbe ist
 * #3B82F6") would spend tokens on a fact that can only produce noise, or worse,
 * invite the agent to talk about its own styling. They stay presentation-only
 * on purpose, not by oversight.
 *
 * An Agent that authored nothing gets the platform identity back byte for byte,
 * which is what keeps every pre-#914 deployment (and its prompt-cache key)
 * exactly where it was.
 */
export function withAgentIdentity(
  baseIdentity: string | undefined,
  authored: {
    readonly identityInstructions?: string | undefined;
    /** #1878 — `false` when `identityInstructions` carries only compiled
     *  sections (no authored behaviour text): appended, not replacing. */
    readonly identityReplacesBase?: boolean | undefined;
    readonly identityName?: string | undefined;
    readonly identityShortDescription?: string | undefined;
    readonly identityLongDescription?: string | undefined;
  },
): string | undefined {
  // Step 1 — replace, or (#1878) append the compiled sections when nothing
  // was authored. A blank value is not an identity, so it falls through rather
  // than silencing the opening section of the system prompt.
  const own = authored.identityInstructions?.trim();
  const base = !own
    ? baseIdentity
    : authored.identityReplacesBase === false
      ? joinSections(baseIdentity, own)
      : own;
  // Steps 2 and 3 — append, descriptions before the name.
  return withAgentName(
    withAgentSelfDescription(base, {
      ...(authored.identityShortDescription !== undefined
        ? { shortDescription: authored.identityShortDescription }
        : {}),
      ...(authored.identityLongDescription !== undefined
        ? { longDescription: authored.identityLongDescription }
        : {}),
    }),
    authored.identityName,
  );
}


function joinSections(first: string | undefined, second: string): string {
  const head = first?.trim();
  return head ? `${head}\n\n${second}` : second;
}

/** What {@link assembleAgentIdentity} reads about one agent. */
export interface AgentIdentityLayerInput {
  readonly archetype?: ArchetypeId | undefined;
  readonly identityInstructions?: string | undefined;
  readonly identityReplacesBase?: boolean | undefined;
  readonly identityName?: string | undefined;
  readonly identityShortDescription?: string | undefined;
  readonly identityLongDescription?: string | undefined;
  readonly consultableColleagues?: readonly string[] | undefined;
}

/**
 * The whole identity section an agent is built with: the platform identity
 * (else {@link DEFAULT_AGENT_IDENTITY}), layered by {@link withAgentIdentity},
 * then the identity rules (#2056) and, last, the archetype's role contract
 * (#2060). `identityText` overrides `input.identityInstructions` — the
 * per-family variant of the compiled text (#1033) runs through the very same
 * layering, so a fallback model keeps the agent's base, name and description.
 */
export function assembleAgentIdentity(
  platformIdentity: string | undefined,
  input: AgentIdentityLayerInput,
  identityText: string | undefined = input.identityInstructions,
): string {
  const layered = withAgentIdentity(platformIdentity?.trim() || DEFAULT_AGENT_IDENTITY, {
    identityInstructions: identityText,
    identityReplacesBase: input.identityReplacesBase,
    identityName: input.identityName,
    identityShortDescription: input.identityShortDescription,
    identityLongDescription: input.identityLongDescription,
  });
  return applyArchetypeContract(
    input.archetype,
    withIdentityRules(layered, input.consultableColleagues),
  );
}

/** Tool calls are not announced in prose (that text never reaches the user). */
export const NO_TOOL_ANNOUNCEMENT_LINE =
  'Kündige Tool-Aufrufe nicht mit Zwischentext an (z.B. „Ich prüfe zuerst mein Memory.“) — solcher Text wird dem Nutzer nicht gezeigt. Schreib die Antwort, wenn die Daten da sind.';

/**
 * #1890 — the head of the stable system prompt: the agent's identity section,
 * then the language rule (ADR-0220: the user's language, else the operator's
 * fallback), the tool-announcement line and the answer-size
 * block (empty for `standard`). `buildSystemPrompt` opens with exactly this
 * string, and the built agent exposes it (`BuiltOrchestrator.identityPrompt`)
 * for the operator's Prompt tab, so the preview is the runtime text.
 * Ends with a newline: the tool section follows directly.
 */
export function identityPreamble(
  identity: string,
  answerVerbosity: AnswerVerbosity = DEFAULT_ANSWER_VERBOSITY,
  answerLanguage: AnswerLanguage = DEFAULT_ANSWER_LANGUAGE,
): string {
  const verbosityBlock = buildAnswerVerbosityBlock(answerVerbosity);
  return `${identity}

${buildAnswerLanguageRule(answerLanguage)}
${NO_TOOL_ANNOUNCEMENT_LINE}
${verbosityBlock ? '\n' + verbosityBlock : ''}`;
}
