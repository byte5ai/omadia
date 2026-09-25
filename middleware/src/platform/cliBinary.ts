/**
 * #1085 — the one place kernel-side spawn sites ask where the `claude` binary
 * is.
 *
 * omadia used to answer that question two ways: `resolveCliBin()` (the runtime
 * install dir first, PATH second) for everything the operator drives — the
 * version badge, the login flow, the "Install now" button — and a bare
 * `'claude'` constant for every process a turn actually spawned. An operator
 * could install a newer CLI through the UI, watch the badge update, and have
 * every turn keep running the image binary, including the version probe that
 * decides whether `--restricted` is passed.
 *
 * Kept as a function and called per spawn: `resolveCliBin` checks the
 * filesystem when it is called, which is what makes an install visible on the
 * next turn instead of the next restart.
 */

import { cliBackendBin, resolveCliBin } from './cliBackendDetector.js';

/** Backend id of the Claude CLI in `CLI_BACKENDS`. */
const CLAUDE_BACKEND_ID = 'claude';

/**
 * The `claude` binary to spawn right now: runtime install dir, else PATH.
 *
 * The NAME comes from `CLI_BACKENDS` via {@link cliBackendBin}, not from a
 * literal here and not from the orchestrator's `DEFAULT_CLI_BINARY` — the
 * detector entry already owns it and `cliAuthService` already resolves through
 * it, so a second source in this layer would let a rename point login and
 * detection at one binary and every spawn at another.
 */
export function resolveClaudeCliBin(): string {
  return resolveCliBin(cliBackendBin(CLAUDE_BACKEND_ID));
}
