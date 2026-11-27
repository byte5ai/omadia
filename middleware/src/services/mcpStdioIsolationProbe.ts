/**
 * #2306 / ADR-0270 — is the stdio user switch usable on this host?
 *
 * With `MCP_STDIO_RUN_AS` set, every stdio child is started through
 * `sudo -n -E -H -u <user> --`. Whether that works depends on the host (the
 * image ships the user and a sudoers rule; a from-source run usually has
 * neither). The connect guard asks this probe before any child is spawned and
 * refuses the connect when the switch fails (fail closed): a configured
 * isolation that silently falls back to the middleware's own user would be the
 * exact leak the setting exists to close.
 *
 * The probe runs `sudo … -- true` with the same flags the real launch uses. A
 * success is cached for the process lifetime (the sudoers rule does not change
 * under a running container); a failure only for `failureTtlMs`, so fixing the
 * host does not need a restart.
 */

import { execFile } from 'node:child_process';

import { MCP_STDIO_SUDO_COMMAND, stdioRunAsPrefix } from '@omadia/orchestrator';

/** Resolves to `null` when the switch works, otherwise to a short reason. */
export type McpStdioIsolationProbe = () => Promise<string | null>;

/** Runs a command and resolves with its failure text, or `null` on exit 0. */
export type ProbeExec = (command: string, args: readonly string[]) => Promise<string | null>;

const PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_FAILURE_TTL_MS = 30_000;
/** sudo's own error line is enough to tell "no rule" from "no sudo". */
const MAX_REASON_CHARS = 200;

const defaultExec: ProbeExec = (command, args) =>
  new Promise((resolve) => {
    execFile(
      command,
      [...args],
      // Only PATH: the probe must not hand the middleware's env to sudo either.
      { env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, timeout: PROBE_TIMEOUT_MS },
      (err, _stdout, stderr) => {
        if (!err) {
          resolve(null);
          return;
        }
        const text = String(stderr).trim().split('\n')[0] ?? '';
        const code = (err as NodeJS.ErrnoException).code;
        resolve((text || (typeof code === 'string' ? code : err.message)).slice(0, MAX_REASON_CHARS));
      },
    );
  });

export function createStdioIsolationProbe(
  runAsUser: string,
  opts: { readonly exec?: ProbeExec; readonly now?: () => number; readonly failureTtlMs?: number } = {},
): McpStdioIsolationProbe {
  const exec = opts.exec ?? defaultExec;
  const now = opts.now ?? Date.now;
  const failureTtlMs = opts.failureTtlMs ?? DEFAULT_FAILURE_TTL_MS;
  const args = [...stdioRunAsPrefix(runAsUser), 'true'];
  let ok = false;
  let failure: { reason: string; at: number } | null = null;
  let inFlight: Promise<string | null> | null = null;

  return async () => {
    if (ok) return null;
    if (failure && now() - failure.at < failureTtlMs) return failure.reason;
    if (!inFlight) {
      inFlight = exec(MCP_STDIO_SUDO_COMMAND, args)
        .catch((err: unknown) => (err instanceof Error ? err.message : String(err)))
        .then((reason) => {
          if (reason === null) {
            ok = true;
            failure = null;
          } else {
            failure = { reason, at: now() };
          }
          return reason;
        })
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  };
}
