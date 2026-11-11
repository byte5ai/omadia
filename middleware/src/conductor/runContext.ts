// Executor-owned run-context keys, and the one filter that keeps callers out of them.
//
// A run's initial context is caller-supplied (a trigger payload, a manual start
// body, an agent's createEphemeralRun input), but a few keys inside it are
// written by the executor itself and read back as ground truth:
//
//   steps          — per-step results; a seeded one presents a result for a step
//                    that never ran, and a postcondition/transition believes it.
//   stepAttempts   — the deterministic loop budget (bumpStepAttempt). A seeded
//                    negative counter stretches a guarded cycle (`lt
//                    ctx.stepAttempts.a 3` ran eight times on -5, issue #1702),
//                    a seeded high one skips the loop altogether.
//   transcript /
//   transcriptText — the agent dialogue bus; a seeded one fabricates a
//                    conversation the next speaker then answers as if real.
//
// Whoever can POST a signed inbound webhook must not get a vote on any of
// those, so every entry point into a run strips them: startRun() and
// previewRun() in runExecutor (the chokepoint for event/webhook, manual, cron
// and agent triggers) and listOwnRuns on the way back out, which hands a plugin
// the start payload rather than executor state.
//
// `ctx.speaker` is deliberately NOT reserved, though `advanceSpeaker` writes it:
// a single-voice workflow is *started* with its speaker, so the caller owns the
// opening value and the executor only rotates it from there. Seeding it picks
// who speaks first — which the payload is allowed to decide — not what was said.
//
// Only the top level is filtered, because only the top level is what the
// executor reads: a payload's own `{ nested: { steps: … } }` is ordinary data.

import type { JsonObject } from '@omadia/conductor-core';

export const RESERVED_CONTEXT_KEYS: ReadonlySet<string> = new Set([
  'steps',
  'stepAttempts',
  'transcript',
  'transcriptText',
]);

/** A copy of `context` without the executor-owned keys. */
export function sanitizeRunContext(context: JsonObject): JsonObject;
export function sanitizeRunContext(context: Record<string, unknown>): Record<string, unknown>;
export function sanitizeRunContext(context: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(context).filter(([key]) => !RESERVED_CONTEXT_KEYS.has(key)));
}
