import type { PrivacyGuardService } from '@omadia/plugin-api';

/**
 * #1540 — Privacy Shield for fast-model calls that run BEFORE a turn has a
 * privacy handle: the canvas skeleton composer, the in-place planner and the
 * chat-channel fast-path triage.
 *
 * Each of them sends the user's text to a fast model BEFORE the base turn
 * starts, so the turn's privacy handle does not exist yet. With a privacy
 * guard running, the text goes through the guard's stored-text scope instead
 * (`openStoredTextScope`, always on): the identity shapes of the C0 baseline,
 * the operator deny-list and C1 through the call's own surrogate map, which
 * also restores the model's skeleton so its labels show the real values.
 *
 * Failure-closed: a guard without `openStoredTextScope`, a scope that cannot
 * be opened, or any mask result but `masked` skips the model call, and the
 * turn gets the static fallback skeleton. The base turn still runs with its
 * own shield. No guard ⇒ no privacy run (the text goes out as before).
 */

/** What the call may send: the masked text, or why the call is skipped. */
export type StoredTextMaskOutcome =
  | { readonly send: true; readonly text: string }
  | { readonly send: false; readonly reason: string };

/** One model call: mask the request, restore the model's output. */
export interface StoredTextPrivacyRun {
  mask(text: string): Promise<StoredTextMaskOutcome>;
  restore(text: string): string;
}

/** PII-free job names the guard logs with every mask call. */
export const SKELETON_PRIVACY_JOB = 'canvas-skeleton';
export const TRIAGE_PRIVACY_JOB = 'fast-path-triage';

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function refused(reason: string): StoredTextPrivacyRun {
  return {
    mask: async () => ({ send: false, reason }),
    restore: (text) => text,
  };
}

/** Opens the privacy run for one fast-model call through `guard`. */
export function openStoredTextPrivacy(guard: PrivacyGuardService, job: string): StoredTextPrivacyRun {
  if (guard.openStoredTextScope === undefined) {
    return refused('the installed privacy guard cannot mask stored text');
  }
  let scope: ReturnType<NonNullable<PrivacyGuardService['openStoredTextScope']>>;
  try {
    scope = guard.openStoredTextScope({ job });
  } catch (err) {
    return refused(`opening the stored-text scope failed: ${messageOf(err)}`);
  }
  return {
    async mask(text) {
      try {
        const result = await scope.maskStoredText(text);
        if (result.outcome === 'masked') return { send: true, text: result.maskedText };
        if (result.outcome === 'blocked') return { send: false, reason: `blocked: ${result.reason}` };
        return { send: false, reason: 'the privacy guard reported masking disabled' };
      } catch (err) {
        return { send: false, reason: `masking failed: ${messageOf(err)}` };
      }
    },
    restore: (text) => scope.restoreStoredText(text),
  };
}

/** The privacy run for one canvas skeleton composition. */
export function openSkeletonPrivacy(guard: PrivacyGuardService): StoredTextPrivacyRun {
  return openStoredTextPrivacy(guard, SKELETON_PRIVACY_JOB);
}
