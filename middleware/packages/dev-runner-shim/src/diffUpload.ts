/**
 * Epic #470 W0 — diff bundle format + upload (spec §5 step 6, §8).
 *
 * The phone-home `POST /jobs/:id/diff` route stores its text/plain body
 * verbatim as one `diff` artifact, but the host-side `diffApplyService` needs
 * the unified diff and the `--numstat` totals SEPARATELY (it cross-checks one
 * against the other before any ref moves). The spec text describes uploading
 * "unified diff + --numstat" as a single body but does not pin the on-wire
 * split. This module pins it: a sentinel line the worker splits on.
 *
 * The sentinel is a bare, unprefixed line. It cannot occur inside a unified
 * diff — every hunk content line is prefixed with a space, `+`, or `-`, and no
 * diff header line matches it — so the split is unambiguous. The worker unit
 * (`w0-worker`) MUST split on the same marker; see the spec-delta note.
 */

/** Separates the unified diff (before) from the numstat (after). */
export const NUMSTAT_MARKER = '\n===OMADIA-DEV-RUNNER-NUMSTAT-V1===\n';

/** Compose the upload body: `<binary unified diff><marker><numstat>`. */
export function bundleDiff(diff: string, numstat: string): string {
  return `${diff}${NUMSTAT_MARKER}${numstat}`;
}

/** Inverse of `bundleDiff`, provided so the worker splits identically. If the
 *  marker is absent the whole body is the diff and the numstat is empty. */
export function splitDiffBundle(bundle: string): { diff: string; numstat: string } {
  const at = bundle.indexOf(NUMSTAT_MARKER);
  if (at === -1) return { diff: bundle, numstat: '' };
  return {
    diff: bundle.slice(0, at),
    numstat: bundle.slice(at + NUMSTAT_MARKER.length),
  };
}
