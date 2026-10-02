/**
 * @omadia/orchestrator-extras — Privacy Shield for the memory jobs (WP-10).
 *
 * The extras call the model through their own provider and send STORED text:
 * recalled memories, a session's stored turns, pairs of memories, memory
 * summaries. Stored text holds real values (the session log keeps the user's
 * original message, and answers are persisted with their real values
 * restored), so with a privacy guard installed it is masked whatever
 * `mask_user_prompt` says. That flag is about the user's own words in the
 * turn's prompt; it never covered memories.
 *
 * A job opens one {@link JobPrivacyRun} per run, masks what goes to its model
 * and restores real values in what comes back. Two routes:
 *
 *  - INSIDE a turn ({@link createInTurnJobPrivacy}): the job's request goes
 *    through the turn's privacy handle with `maskReplayedAnswer`, the
 *    always-on mask the kernel already uses for replayed answers and recalled
 *    context. The spans join the turn's surrogate map, count as the turn's own
 *    egress on its receipt, and `restorePromptPseudonyms` restores them. Never
 *    the flag-gated `maskUserPrompt`: a handle without `maskReplayedAnswer`
 *    skips the job. Only for jobs the turn AWAITS (the recall relevance judge,
 *    the session briefing): a fire-and-forget job can outlive the turn's map.
 *  - OUTSIDE a turn ({@link createJobPrivacy}): no privacy guard installed ⇒
 *    today's behaviour; a guard installed ⇒ the job is skipped unless the
 *    guard can mask stored text.
 *
 * Failure-closed throughout: anything but a `masked` result skips the job's
 * model call (`send: false`, with the reason for the job's log line).
 */

import type { PrivacyGuardService, PrivacyPromptMaskResult } from '@omadia/plugin-api';

/** Service key the kernel publishes its `turnContext` accessor under. */
export const TURN_CONTEXT_SERVICE_NAME = 'turnContext';

/** What a job may send: the masked text, or why the run is skipped. */
export type JobMaskOutcome =
  | { readonly send: true; readonly text: string }
  | { readonly send: false; readonly reason: string };

/** One job run: mask the request, restore real values in the model's output. */
export interface JobPrivacyRun {
  mask(text: string): Promise<JobMaskOutcome>;
  /** Real values back into the model's output; identity when nothing was masked. */
  restore(text: string): Promise<string>;
}

/** Opens a run for the named job. The name is PII-free and only logged. */
export type OpenJobPrivacy = (job: string) => JobPrivacyRun;

/** The slice of the kernel's per-turn privacy handle a memory job uses. */
export interface TurnPrivacyHandleLike {
  maskReplayedAnswer?(text: string): Promise<PrivacyPromptMaskResult>;
  restorePromptPseudonyms?(text: string): Promise<string>;
}

/** The slice of the kernel's `turnContext` service a memory job reads. */
export interface TurnPrivacyContext {
  current(): { readonly privacyHandle?: TurnPrivacyHandleLike } | undefined;
}

/** No privacy guard installed: the text goes out as stored, as before WP-10. */
const UNGUARDED_RUN: JobPrivacyRun = {
  mask: async (text) => ({ send: true, text }),
  restore: async (text) => text,
};

function refusedRun(reason: string): JobPrivacyRun {
  return {
    mask: async () => ({ send: false, reason }),
    restore: async (text) => text,
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Only `masked` is a promise that the text is safe to send. */
export function outcomeOfMask(result: PrivacyPromptMaskResult): JobMaskOutcome {
  if (result.outcome === 'masked') return { send: true, text: result.maskedText };
  if (result.outcome === 'blocked') return { send: false, reason: `blocked: ${result.reason}` };
  return { send: false, reason: 'the privacy guard reported masking disabled' };
}

/** A run through the turn's privacy handle (see the module header). */
function turnRun(handle: TurnPrivacyHandleLike): JobPrivacyRun {
  return {
    async mask(text) {
      if (handle.maskReplayedAnswer === undefined) {
        return { send: false, reason: 'the turn privacy handle has no maskReplayedAnswer' };
      }
      try {
        return outcomeOfMask(await handle.maskReplayedAnswer(text));
      } catch (err) {
        return { send: false, reason: `masking failed: ${messageOf(err)}` };
      }
    },
    async restore(text) {
      return handle.restorePromptPseudonyms === undefined
        ? text
        : handle.restorePromptPseudonyms(text);
    },
  };
}

/**
 * The route for a job outside a turn. `resolveGuard` is read per run (a
 * privacy guard may be installed after this plugin activated); a lookup that
 * throws skips the run rather than guessing that no guard is installed.
 */
export function createJobPrivacy(
  resolveGuard: () => PrivacyGuardService | undefined,
): OpenJobPrivacy {
  return () => {
    let guard: PrivacyGuardService | undefined;
    try {
      guard = resolveGuard();
    } catch (err) {
      return refusedRun(`privacy guard lookup failed: ${messageOf(err)}`);
    }
    if (guard === undefined) return UNGUARDED_RUN;
    return refusedRun('the installed privacy guard cannot mask stored text');
  };
}

/**
 * The route for a job the turn awaits: through the turn's privacy handle when
 * the job runs inside a turn, otherwise through `outsideTurn`.
 */
export function createInTurnJobPrivacy(deps: {
  readonly turnContext: () => TurnPrivacyContext | undefined;
  readonly outsideTurn: OpenJobPrivacy;
}): OpenJobPrivacy {
  return (job) => {
    let handle: TurnPrivacyHandleLike | undefined;
    try {
      handle = deps.turnContext()?.current()?.privacyHandle;
    } catch {
      // No readable turn: the outside-turn route still knows whether a guard
      // is installed, so this can only mask more, never less.
      handle = undefined;
    }
    return handle === undefined ? deps.outsideTurn(job) : turnRun(handle);
  };
}
