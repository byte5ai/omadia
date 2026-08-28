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
 * loose /superseded/ rather than the exact current string is the cheap
 * insurance — it survives a rename to "start superseded" or "boot was
 * superseded" (PR #944 reworks that lifecycle). If the marker is dropped
 * entirely the tests here go red, which is the point.
 */

/** What the shell should do about a rejected boot. */
export type BootFailureKind =
  /** Deliberately discarded by a newer boot/stop. Explain and wait. */
  | 'superseded'
  /** A genuine failure the user has to act on. */
  | 'fatal';

export interface BootFailure {
  readonly kind: BootFailureKind;
  /** The raw text, for the log and the support detail — never the headline. */
  readonly detail: string;
}

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

export function classifyBootFailure(err: unknown): BootFailure {
  const detail = describeError(err);
  return {
    kind: SUPERSEDED_MARKER.test(detail) ? 'superseded' : 'fatal',
    detail,
  };
}
