import type { JsonObject } from '@omadia/conductor-core';

/**
 * Issue #1707 — what a run-lifecycle webhook delivery is allowed to carry.
 *
 * `buildRunEventPayload` (conductor/index.ts) assembles the FULL run event once per
 * terminal run, including `context` — the run's accumulated step results, which hold
 * whatever a human typed into an approval step ("kommentar": "P09 Testkommentar" in
 * the report). Every subscription then gets its OWN projection of that payload, and
 * the projection runs BEFORE `createDelivery`, so an opted-out subscription's context
 * is absent from both the outbound body and the stored `payload` column.
 *
 * Why a projection rather than dropping `context` from `buildRunEventPayload`: an
 * integration that legitimately needs the step results (an archive, a reporting
 * receiver the operator runs themselves) keeps working by opting in per subscription,
 * and the two delivery paths — the inline terminal-run hook and the retry worker's
 * reconciliation pass — share this one function, so they can never disagree about
 * what a given subscription receives.
 */

/**
 * Project the full run event down to what one subscription may receive. Opted out
 * (the default) the `context` key is REMOVED and `contextOmitted: true` takes its
 * place, so a receiver can tell "this run had no context" apart from "this
 * subscription is not allowed to see it" and its operator knows which flag to flip.
 */
export function projectRunEventPayload(
  full: JsonObject,
  /** The subscription's `include_context` flag (`false` for every row by default). */
  opts: { includeContext: boolean },
): JsonObject {
  if (opts.includeContext) return full;
  const projected: JsonObject = { ...full };
  delete projected['context'];
  return { ...projected, contextOmitted: true };
}
