/**
 * OM-09 — the build identity shown on the help page.
 *
 * A support request without a version number is a guessing game. Read from
 * `package.json` at module load (server-side; the help page is a server
 * component) so it cannot drift from what was actually shipped.
 */
import pkg from '../../package.json';

export const APP_VERSION: string =
  typeof pkg.version === 'string' ? pkg.version : 'unknown';
