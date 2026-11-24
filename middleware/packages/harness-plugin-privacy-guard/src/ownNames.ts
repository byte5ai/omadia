/**
 * Spec 2042 — the speaking agent's own names are not PII in its own turn
 * (`PrivacyPromptMaskRequest.ownNames`). Masked, the agent's model read
 * "Ich bin <surrogate>" in its recalled context and "corrected" its name.
 *
 * Rules (docs/security-architecture.md § "Agent's own names"):
 *  - exact equality only, ignoring case, surrounding whitespace, quote
 *    characters and punctuation: "„Dark Clippy“" and "Dark Clippy." match
 *    "Dark Clippy"; "Dark Clippys" (a possessive) or "Mira Schulz" for an
 *    agent "Mira" do not, and stay masked (the safe direction);
 *  - names shorter than 2 characters are ignored;
 *  - the operator deny-list always wins: an own name the deny-list matches
 *    is never exempt, and a deny-list span is never exempt.
 */

import type { PromptPiiDetector } from '@omadia/plugin-api';

/** Detector id of the operator deny-list (`resolveCustomDetector`). */
export const DENY_LIST_DETECTOR_ID = 'custom-terms';

/** Shortest own name that exempts a span; shorter ones are ignored. */
const MIN_OWN_NAME_LENGTH = 2;
const QUOTES = `"'„“”‚‘’«»`;
const LEADING_NOISE = new RegExp(`^[\\s${QUOTES}]+`, 'u');
const TRAILING_NOISE = new RegExp(`[\\s.,;:!?${QUOTES}]+$`, 'u');

/** True when a span value (or a known real value) is one of the agent's own names. */
export type OwnNameMatcher = (value: string) => boolean;

export const NO_OWN_NAMES: OwnNameMatcher = () => false;

export function normalizeOwnName(value: string): string {
  return value.replace(LEADING_NOISE, '').replace(TRAILING_NOISE, '').toLocaleLowerCase();
}

/**
 * The matcher for one mask call: `ownNames` minus every name the operator
 * deny-list (one of `detectors`) matches anywhere in it.
 */
export async function resolveOwnNames(
  ownNames: readonly string[] | undefined,
  detectors: readonly PromptPiiDetector[],
): Promise<OwnNameMatcher> {
  const candidates = (ownNames ?? []).filter(
    (n) => normalizeOwnName(n).length >= MIN_OWN_NAME_LENGTH,
  );
  if (candidates.length === 0) return NO_OWN_NAMES;
  const denyList = detectors.find((d) => d.id === DENY_LIST_DETECTOR_ID);
  const names = new Set<string>();
  for (const name of candidates) {
    if (denyList !== undefined && (await denyList.detect(name)).length > 0) continue;
    names.add(normalizeOwnName(name));
  }
  if (names.size === 0) return NO_OWN_NAMES;
  return (value) => names.has(normalizeOwnName(value));
}
