/**
 * Telling a real boot failure apart from a boot that was deliberately
 * discarded (OM-56).
 *
 * The supervisor invalidates an outdated boot by bumping a generation counter
 * and throwing. That rejection travelled all the way into a native error
 * dialog, raw: the tester was shown `Error: boot superseded` while an update
 * was being applied exactly as designed, and offered two buttons that could
 * both do damage — *Quit* aborts mid-update, *Re-run setup* starts a setup
 * while the database is being snapshotted. The only correct action, waiting,
 * was not on offer.
 *
 * A superseded boot is a STATE, not a failure. It needs an explanation with no
 * destructive affordance, or no dialog at all.
 *
 * COUPLING, deliberate and worth knowing: the supervisor communicates this
 * through an Error MESSAGE, so this classifier has to read one. Matching a
 * loose /superseded/ rather than the exact current string is cheap insurance —
 * it survives a rename to "start superseded" or "boot was superseded".
 *
 * That insurance is NOT self-enforcing, and an earlier version of this comment
 * wrongly claimed it was. The marker is a duplicated literal: `'boot
 * superseded'` in `supervisor.ts`, {@link SUPERSEDED_MARKER} here, and nothing
 * in the type system bridging them. Mutating this classifier turns tests red;
 * mutating the supervisor's message did NOT. Since PR #944 is reworking exactly
 * that supersession path, a silent regression here would bring back the
 * destructive Quit / Re-run-setup dialog during updates with a green suite.
 *
 * So `test/bootFailure.test.mts` reads the supervisor's own source and runs its
 * thrown literals through this classifier. That is a source-level tripwire
 * rather than a type-level one — `supervisor.ts` reaches Electron through
 * `paths.ts`, so a Node test cannot import it — and it fails if the message is
 * renamed OR removed. The clean end state is one shared exported constant, or a
 * typed rejection; both belong to whoever owns the supervisor next.
 *
 * An unreadable secrets file IS a typed rejection, and is classified from the
 * error itself, before it is flattened to text. It needs its own dialog: the
 * generic one offers "Re-run setup" as its default, and setup would only hit
 * the same file again. What helps is a keychain prompt or a restore, and that
 * dialog says which (see `secretsRecovery.ts`).
 *
 * A rejection while the app is quitting is no failure either (FU-161).
 * Quitting while the first page loads aborts `loadURL`, and that rejection was
 * logged as `boot failed` and could put the failure dialog in front of an app
 * that was exiting. The shell says whether it is quitting, and then every
 * rejection is `interrupted`: logged, never shown.
 */
import { isSecretsUnreadableError, type SecretsUnreadableStage } from './secretsBlob';

/** What the shell should do about a rejected boot. */
export type BootFailureKind =
  /** Deliberately discarded by a newer boot/stop. Explain and wait. */
  | 'superseded'
  /** The secrets file exists but cannot be used. Explain the restore; never re-run setup. */
  | 'secrets-unreadable'
  /** The app is quitting, so the rejection is part of the quit. Log it; show nothing. */
  | 'interrupted'
  /** A genuine failure the user has to act on. */
  | 'fatal';

/** What the shell knows about itself when a boot is rejected. */
export interface BootFailureContext {
  /** The app is on its way out (`before-quit` has fired, or a quit was asked for). */
  readonly quitting?: boolean;
}

/** What the secrets dialog has to name, copied off `SecretsUnreadableError`. */
export interface SecretsFailure {
  readonly file: string;
  readonly stage: SecretsUnreadableStage;
  readonly reason: string;
  readonly snapshotDir: string | null;
}

export type BootFailure =
  | {
      readonly kind: 'superseded' | 'interrupted' | 'fatal';
      /** The raw text, for the log and the support detail — never the headline. */
      readonly detail: string;
    }
  | {
      readonly kind: 'secrets-unreadable';
      readonly detail: string;
      readonly secrets: SecretsFailure;
    };

const SUPERSEDED_MARKER = /superseded/i;

/** Normalize anything a rejected promise can carry into a single line. */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === 'string') return err;
  // An object thrown by non-Error code still has to reach the support detail.
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

export function classifyBootFailure(err: unknown, context: BootFailureContext = {}): BootFailure {
  const detail = describeError(err);
  // Quitting first, over every other kind: an app on its way out can show no
  // dialog, and the rejection is almost always the quit itself (an aborted
  // page load, a stopped supervisor). The detail still reaches the log.
  if (context.quitting === true) return { kind: 'interrupted', detail };
  // Typed first: the code and fields survive any rewording of the message.
  if (isSecretsUnreadableError(err)) {
    return {
      kind: 'secrets-unreadable',
      detail,
      secrets: {
        file: err.file,
        stage: err.stage,
        reason: err.reason,
        snapshotDir: err.snapshotDir,
      },
    };
  }
  return {
    kind: SUPERSEDED_MARKER.test(detail) ? 'superseded' : 'fatal',
    detail,
  };
}
