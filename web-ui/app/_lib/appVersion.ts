/**
 * OM-09 — the build identity shown on the help page.
 *
 * A support request without a version number is a guessing game, and a support
 * request with the WRONG version number is worse. This used to read
 * `web-ui/package.json`, which has said `0.2.0` since long before the current
 * release series (v0.74.0 at the time of writing) — so every release printed a
 * confidently wrong version on its help page (#432).
 *
 * The source of truth is now `OMADIA_VERSION`, stamped into the image at build
 * time by `publish-images.yml` and read here at request time (the help page is
 * a server component). An unstamped build reports `unknown` rather than
 * falling back to a number that is known to be stale: "we don't know" is
 * actionable, "0.2.0" sends the reader down the wrong path.
 *
 * Matches the middleware's `update/version.ts`, which reports the same
 * variable via `/health` and the admin update surface.
 */

export const UNKNOWN_VERSION = 'unknown';

function resolve(): string {
  const stamped = process.env.OMADIA_VERSION?.trim();
  return stamped !== undefined && stamped.length > 0 ? stamped : UNKNOWN_VERSION;
}

export const APP_VERSION: string = resolve();
