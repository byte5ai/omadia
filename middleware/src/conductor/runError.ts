import type { JsonObject, StuckCode } from '@omadia/conductor-core';

import { redactSecrets } from '../services/secretRedaction.js';
import { redactProviderInternals } from '../services/providerInternalsRedaction.js';

/**
 * #1699 — why a run (or a recovered step) did not complete normally.
 *
 * ONE closed vocabulary for every site in `runExecutor.ts` that records a
 * non-normal outcome, and the single source of truth for the `error_code`
 * column added in `migrations/0013_conductor_run_error.sql` (deliberately
 * CHECK-less — see that file). The code is decided AT the site, never parsed
 * back out of a sentence: the sentence is free to be reworded, the code is not.
 *
 * The engine's own `StuckCode` values are reused unchanged rather than
 * flattened into one `postcondition_stuck`: `@omadia/conductor-core` already
 * classifies why advancement failed (ambiguous guards vs. no fallback vs. a
 * dangling fallback id), and that classification was simply being dropped on
 * the floor.
 */
export type ConductorRunErrorCode =
  | StuckCode
  /** The run's `current_step_id` names a step the published graph does not contain. */
  | 'step_not_in_graph'
  /** A timer step reached at runtime without a parsable duration or without its on-expiry edge. */
  | 'timer_misconfigured'
  /** A human step's principal resolved to nobody who could answer (FR-024). */
  | 'no_role_holder'
  /** A human await passed its deadline unanswered. */
  | 'await_timed_out'
  /** An agent/action effect threw. */
  | 'effect_threw'
  /** An effect blew the per-step budget (`stepTimeoutMs`). */
  | 'step_timeout'
  /** A resume found a `running` run with no next step — an inconsistent state. */
  | 'resume_no_current_step'
  /** The drive (or a preview) hit the engine's hard step budget with work left. */
  | 'max_steps_exceeded';

/**
 * The vocabulary as a value, written as an exhaustive record so adding a member
 * to the union above (or to the engine's `StuckCode`) fails the build here
 * instead of silently producing a code no reader accepts.
 */
const RUN_ERROR_CODES: Record<ConductorRunErrorCode, true> = {
  // engine (`StuckCode`)
  unknown_step: true,
  postcondition_unmet_no_fallback: true,
  no_transition_no_fallback: true,
  ambiguous_guards: true,
  fallback_transition_missing: true,
  // executor
  step_not_in_graph: true,
  timer_misconfigured: true,
  no_role_holder: true,
  await_timed_out: true,
  effect_threw: true,
  step_timeout: true,
  resume_no_current_step: true,
  max_steps_exceeded: true,
};

/**
 * Validate a stored value against the vocabulary. An unknown code is dropped —
 * a code this build cannot interpret must never be rendered as if it could be
 * (a newer middleware, or a hand-edited row, is the realistic source), so the
 * reader shows "cause not recorded" where the code would go. The stored
 * message is NOT dropped with it: it was redacted and truncated on the way in,
 * and it is the only thing left that can still help. It renders as supporting
 * detail, never as the label.
 */
export function asRunErrorCode(value: unknown): ConductorRunErrorCode | null {
  return typeof value === 'string' && Object.hasOwn(RUN_ERROR_CODES, value)
    ? (value as ConductorRunErrorCode)
    : null;
}

/**
 * Cap for the persisted message. The column is read by an operator, not a
 * debugger: a provider can answer with kilobytes of JSON, and the first lines
 * are the only ones that ever carry the cause.
 */
export const RUN_ERROR_MESSAGE_MAX = 2_000;

export interface ConductorRunError {
  code: ConductorRunErrorCode;
  /** Redacted + truncated. Null only when a site genuinely has no sentence to offer. */
  message: string | null;
  /** The code's typed arguments (engine `nodeIds`, the agent/action ref, the blown budget). */
  detail?: JsonObject | null;
}

/**
 * Make a message fit to persist in an operator-visible column.
 *
 * `redactSecrets` strips credentials (bearer tokens, `"api_key": …` fields,
 * auth headers, secret-ish query params) and `redactProviderInternals` strips
 * provider correlation handles (`request_id`, `cf-ray`, `sk-…`) — the exact
 * pair of leaks a raw provider error carries, and the reason the reported 429
 * could not simply be stored verbatim.
 *
 * It removes CREDENTIALS, not PII: an upstream error quoting a customer name
 * still lands in the column. That is the same boundary `redactAuditError` draws
 * for `mcp_call_log`, and the run trace already renders the full run context
 * next to this field.
 */
export function redactRunErrorMessage(raw: string): string {
  const clean = redactProviderInternals(redactSecrets(raw));
  const flat = clean.replace(/\s+/g, ' ').trim();
  return flat.length > RUN_ERROR_MESSAGE_MAX
    ? `${flat.slice(0, RUN_ERROR_MESSAGE_MAX - 1)}…`
    : flat;
}

/**
 * The two causes raised from more than one site (the drive loop and the dry
 * run), so the code, the sentence and the detail keys cannot drift apart
 * between them.
 */
export function stepNotInGraphError(stepId: string): ConductorRunError {
  return runError('step_not_in_graph', `step '${stepId}' is not in the published graph`);
}

export function timerMisconfiguredError(
  stepId: string,
  /** Which half of the timer contract is missing — `validate()` rejects both at
   *  publish time, so reaching either at runtime is the loud-failure case. */
  missing: 'duration' | 'fallback',
  timer: { duration?: string | null; fallbackTransitionId?: string | null },
): ConductorRunError {
  const cause =
    missing === 'fallback'
      ? 'no on-expiry fallback transition'
      : `no parsable duration ('${timer.duration ?? ''}')`;
  return runError('timer_misconfigured', `timer step '${stepId}' has ${cause}`, {
    duration: timer.duration ?? null,
    fallbackTransitionId: timer.fallbackTransitionId ?? null,
  });
}

/** A cause the executor states itself (ids and graph refs, no exception involved). */
export function runError(
  code: ConductorRunErrorCode,
  message: string,
  detail?: JsonObject,
): ConductorRunError {
  return {
    code,
    message: redactRunErrorMessage(message),
    ...(detail ? { detail } : {}),
  };
}

/**
 * A cause carried by a thrown value.
 *
 * `StepTimeoutError` is told apart by `name` rather than `instanceof` on
 * purpose: the class lives in `realStepEffects.ts`, and the executor must stay
 * free of the real effects implementation (a `StubStepEffects` deployment, or a
 * second copy of the class across a bundle boundary, would silently fall
 * through an `instanceof` check). The stack is deliberately never read.
 */
export function runErrorFromThrow(err: unknown, detail?: JsonObject): ConductorRunError {
  const timedOut = err instanceof Error && err.name === 'StepTimeoutError';
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return runError(timedOut ? 'step_timeout' : 'effect_threw', raw, detail);
}
