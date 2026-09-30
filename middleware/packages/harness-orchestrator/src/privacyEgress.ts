/**
 * Deferred privacy finalisation for turns the answer verifier wraps.
 *
 * A turn behind a Privacy Shield ends with `finalize`: the turn's surrogate
 * map, dataset store and C1 cache are dropped and the receipt row is written
 * (`turn_receipts`, idempotent on the turn id — it cannot be amended later).
 * The verifier runs AFTER the turn produced its answer, and its model
 * requests must use that same map and land in that same receipt. So a turn
 * run on the verifier's behalf does not finalize itself: it hands a
 * {@link PrivacyEgressContinuation} to the wrapper, which verifies through it
 * and then finalizes — exactly once, also when verification fails or the
 * client goes away.
 *
 * Nothing here is kernel-wide state: the hand-over lives on the orchestrator
 * instance, keyed weakly by the caller's input object.
 */

import type { PrivacyReceipt } from '@omadia/plugin-api';
import type { VerifierPrivacy } from '@omadia/verifier';

import type { PrivacyTurnHandle } from './privacyHandle.js';

/** Thrown by the verifier privacy view when masking cannot be guaranteed.
 *  The verifier stages catch it and send nothing. */
export class VerifierEgressBlockedError extends Error {
  constructor(reason: string) {
    super(`[privacy] verifier request not sent — ${reason}`);
    this.name = 'VerifierEgressBlockedError';
  }
}

export interface PrivacyEgressContinuation {
  /** The turn id — also the key of the turn's `turn_receipts` row. */
  readonly receiptId: string;
  /**
   * The view the verifier sends through, bound to this turn's handle.
   * `undefined` when the turn's answer is not model prose the verifier may
   * see: a server-rendered v4 answer (real values its model never saw), a
   * Direct Line relay (restored before it got here) or the privacy refusal.
   * The wrapper then skips verification for this turn.
   */
  readonly verifierPrivacy: VerifierPrivacy | undefined;
  /**
   * Would the turn's prompt-mask policy change `text`? Side-effect free (no
   * map entry, no receipt line). `true` when masking would be blocked.
   */
  maskWouldAlter(text: string): Promise<boolean>;
  /** Surrogates of this turn still present in `text` (see the handle). */
  countUnresolvedSurrogates(text: string): Promise<number>;
  /**
   * Drop the turn's privacy state and persist its receipt. Memoised: every
   * call returns the first call's result, so wrappers may call it from both
   * the happy path and a `finally`.
   */
  finalize(): Promise<PrivacyReceipt | undefined>;
}

export function createPrivacyEgressContinuation(deps: {
  readonly handle: PrivacyTurnHandle;
  readonly receiptId: string;
  /** Pre-restore answer, or `undefined` when the verifier must skip. */
  readonly wireAnswer: string | undefined;
  /** Finalize the handle and persist the receipt. Must not throw. */
  readonly settle: () => Promise<PrivacyReceipt | undefined>;
}): PrivacyEgressContinuation {
  const { handle } = deps;
  let settled: Promise<PrivacyReceipt | undefined> | undefined;
  const verifierPrivacy: VerifierPrivacy | undefined =
    deps.wireAnswer === undefined
      ? undefined
      : {
          wireAnswer: deps.wireAnswer,
          async maskForWire(text: string): Promise<string> {
            // Always asks the service — also for an empty text — so every
            // verifier request is counted in the receipt.
            const result = await handle.maskUserPrompt(text, { stage: 'verifier' });
            if (result.outcome === 'blocked') {
              throw new VerifierEgressBlockedError(result.reason);
            }
            return result.outcome === 'masked' ? result.maskedText : text;
          },
          async projectForWire(
            text: string,
            identityValues: readonly string[],
          ): Promise<string> {
            if (handle.projectVerifierText === undefined) {
              throw new VerifierEgressBlockedError('projection unavailable');
            }
            const result = await handle.projectVerifierText(text, identityValues);
            // Anything but `masked` — including a provider that answers
            // `disabled` — means the text is not projected: never send it.
            if (result.outcome !== 'masked') {
              throw new VerifierEgressBlockedError(
                result.outcome === 'blocked' ? result.reason : 'projection unavailable',
              );
            }
            return result.maskedText;
          },
          restore: (text: string) => handle.restorePromptPseudonyms(text),
        };
  return {
    receiptId: deps.receiptId,
    verifierPrivacy,
    async maskWouldAlter(text: string): Promise<boolean> {
      const result = await handle.maskUserPrompt(text, {
        stage: 'verifier',
        preview: true,
      });
      if (result.outcome === 'blocked') return true;
      return result.outcome === 'masked' && result.maskedText !== text;
    },
    countUnresolvedSurrogates: async (text: string) =>
      (await handle.countUnresolvedSurrogates?.(text)) ?? 0,
    finalize(): Promise<PrivacyReceipt | undefined> {
      settled ??= deps.settle();
      return settled;
    },
  };
}

/**
 * Hand-over between one orchestrator and the wrapper that runs its turns.
 * Keyed by the caller's input object — the wrapper passes the SAME object to
 * `markPrivacyFinalizeHeld`, `runTurn` / `chatStream` and `takePrivacyEgress`.
 * Both collections are weak, so an input the caller drops takes its entries
 * with it.
 */
export class PrivacyEgressHandover {
  private readonly held = new WeakSet<object>();
  private readonly stashed = new WeakMap<object, PrivacyEgressContinuation>();

  /** Ask the next turn run with `input` to defer its privacy finalisation. */
  hold(input: object): void {
    this.held.add(input);
  }

  /** One-shot: true when `input` was held; the mark is consumed, so a later
   *  direct run with the same object finalizes as usual. */
  consumeHold(input: object): boolean {
    return this.held.delete(input);
  }

  stash(input: object, continuation: PrivacyEgressContinuation): void {
    // A continuation nobody took must not be orphaned: its turn state would
    // otherwise outlive the turn until restart.
    const orphan = this.stashed.get(input);
    if (orphan !== undefined) void orphan.finalize();
    this.stashed.set(input, continuation);
  }

  take(input: object): PrivacyEgressContinuation | undefined {
    const continuation = this.stashed.get(input);
    this.stashed.delete(input);
    return continuation;
  }
}
