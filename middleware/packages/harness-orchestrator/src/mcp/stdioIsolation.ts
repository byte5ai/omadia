/**
 * #2306 / ADR-0270 — how a stdio MCP server is started.
 *
 * Two boundaries, applied independently:
 *
 *  1. **Environment.** The child never inherits the middleware's environment.
 *     It gets the MCP SDK's curated base (`StdioClientTransport` always merges
 *     `getDefaultEnvironment()`: HOME, LOGNAME, PATH, SHELL, TERM, USER — no
 *     secrets), the locale variables below, and the row's own config env
 *     (operator values + Vault secrets, epic #459). That holds everywhere,
 *     including from-source runs and the desktop app.
 *
 *  2. **OS user.** With `runAsUser` set (the container image sets
 *     `MCP_STDIO_RUN_AS=omadia-mcp`), the command is started through
 *     `sudo -n -E -H -u <user> -- <command> <args…>`. The child then runs under
 *     its own UID: it cannot read the middleware's `/proc/<pid>/environ`
 *     (VAULT_KEY, DATABASE_URL, provider keys) nor the `0700` data directory.
 *     The env goes to sudo through `execve` (never through argv, which any
 *     user can read in `/proc/<pid>/cmdline`); `-E` keeps it, which the
 *     sudoers rule allows with `SETENV`. `-H` sets HOME to the target user's
 *     home, and sudo sets USER/LOGNAME/PATH (secure_path) itself.
 *
 *     A small `/bin/sh` shim (a supervisor since #2329, see below) sets `umask 077` and gives each server its
 *     own npm cache (`$HOME/.npm-cache/<hash of the server id>`), so one
 *     server's `npx` does not install into, or run from, another server's
 *     cache by accident. That separates caches, not servers: every stdio
 *     child shares the one run-as UID, so a hostile server can still read the
 *     other children's `/proc/<pid>/environ` (their config values) and files.
 *     ADR-0270 names that residual risk.
 *
 * Whether sudo is actually usable is checked by the middleware's connect guard
 * before any child is spawned (fail closed, `stdio_isolation_unavailable`).
 * This module only builds the launch; it never spawns.
 */

import { createHash } from 'node:crypto';

/** The privilege helper. Resolved through PATH like any command. */
export const MCP_STDIO_SUDO_COMMAND = 'sudo';

/**
 * Locale variables a server may need to format text. Copied from the
 * middleware's environment when set; nothing else of it reaches the child.
 */
export const MCP_STDIO_LOCALE_ENV_KEYS: readonly string[] = ['LANG', 'LC_ALL', 'LC_CTYPE', 'TZ'];

/**
 * #2329 — seconds the shim waits after SIGTERM before it SIGKILLs the
 * server. Below the SDK's 2 s + 2 s close sequence plus a margin, far below
 * the 30 s retire grace (#2307).
 */
export const MCP_STDIO_STOP_GRACE_S = 3;

/**
 * Runs as the target user, between sudo and the server: `$0` is the cache
 * key, `"$@"` the server's own command line (positional, never re-parsed by
 * the shell). A row that sets `npm_config_cache` itself keeps its value.
 *
 * #2329 — a supervisor, not an `exec`: the middleware cannot signal a child
 * of another UID, and sudo cannot forward a SIGKILL it receives itself. The
 * shim starts the server in its own process group (`setsid`, where
 * installed) and keeps the middleware's stdin for it. On SIGTERM (which sudo
 * forwards), or when its parent sudo is gone (`/proc`, Linux), it sends TERM
 * to the server's group, then KILL after {@link MCP_STDIO_STOP_GRACE_S}
 * seconds, so a server that ignores both stdin EOF and SIGTERM is still
 * gone. The server's exit status is the shim's.
 */
export const MCP_STDIO_CHILD_SHIM = [
  'umask 077',
  ': "${npm_config_cache:=$HOME/.npm-cache/$0}"',
  'export npm_config_cache',
  // The trap stands before the fork (a background child resets it), so a
  // SIGTERM in between cannot end the shim and leave the server behind.
  'child=',
  'stop() {',
  "  trap '' TERM INT HUP",
  '  child=${child:-$!}',
  '  [ -n "$child" ] || exit 143',
  '  kill -s TERM -- "-$child" 2>/dev/null || kill -s TERM "$child" 2>/dev/null',
  '  n=0',
  `  while [ "$n" -lt ${String(MCP_STDIO_STOP_GRACE_S)} ] && kill -0 "$child" 2>/dev/null; do sleep 1; n=$((n + 1)); done`,
  '  kill -s KILL -- "-$child" 2>/dev/null || kill -s KILL "$child" 2>/dev/null',
  '  exit 143',
  '}',
  'trap stop TERM INT HUP',
  'exec 3<&0',
  'if command -v setsid >/dev/null 2>&1; then setsid "$@" <&3 3<&- & else "$@" <&3 3<&- & fi',
  'child=$!',
  'exec 3<&- </dev/null',
  'parent=$PPID',
  // The watcher holds none of the server's pipes: its `sleep` must not delay
  // the EOF the SDK reads when the server exits.
  'if [ -d "/proc/$parent" ]; then',
  '  (while [ -d "/proc/$parent" ] && kill -0 "$child" 2>/dev/null; do sleep 1; done',
  '   [ -d "/proc/$parent" ] || kill -s TERM "$$") >/dev/null 2>&1 &',
  'fi',
  'wait "$child"',
].join('\n');

/** Cache directory name of one server: stable, path-safe, not the raw id. */
export function stdioCacheKey(serverId: string): string {
  return createHash('sha256').update(serverId).digest('hex').slice(0, 16);
}

/** A POSIX user name as `useradd` accepts it (no uid, no path, no flags). */
export const MCP_STDIO_RUN_AS_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;

export interface McpStdioIsolation {
  /** OS user the child runs as. Unset: same user as the middleware. */
  readonly runAsUser?: string;
}

export interface McpStdioLaunch {
  readonly command: string;
  readonly args: string[];
  readonly env: Record<string, string>;
}

/** The sudo arguments that precede the server's own command line. */
export function stdioRunAsPrefix(user: string): string[] {
  if (!MCP_STDIO_RUN_AS_PATTERN.test(user)) {
    throw new Error(`invalid stdio run-as user "${user}"`);
  }
  return ['-n', '-E', '-H', '-u', user, '--'];
}

/**
 * The env handed to the transport: the locale variables plus the row's config
 * env. The SDK merges its curated base underneath; with a user switch, sudo
 * then replaces HOME (`-H`), USER, LOGNAME and PATH (secure_path) with the
 * target user's. `processEnv` is a parameter only so tests can pin it.
 */
export function stdioChildEnv(
  configEnv: Readonly<Record<string, string>> | undefined,
  processEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of MCP_STDIO_LOCALE_ENV_KEYS) {
    const value = processEnv[key];
    if (typeof value === 'string' && value !== '') env[key] = value;
  }
  return { ...env, ...(configEnv ?? {}) };
}

/** Command, args and env for one stdio child of server `serverId`. */
export function stdioLaunch(
  serverId: string,
  command: string,
  args: readonly string[],
  configEnv: Readonly<Record<string, string>> | undefined,
  isolation: McpStdioIsolation = {},
): McpStdioLaunch {
  const env = stdioChildEnv(configEnv);
  if (!isolation.runAsUser) return { command, args: [...args], env };
  return {
    command: MCP_STDIO_SUDO_COMMAND,
    args: [
      ...stdioRunAsPrefix(isolation.runAsUser),
      '/bin/sh',
      '-c',
      MCP_STDIO_CHILD_SHIM,
      stdioCacheKey(serverId),
      command,
      ...args,
    ],
    env,
  };
}
