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
 * Whether sudo is actually usable is checked by the middleware's connect guard
 * before any child is spawned (fail closed, `stdio_isolation_unavailable`).
 * This module only builds the launch; it never spawns.
 */

/** The privilege helper. Resolved through PATH like any command. */
export const MCP_STDIO_SUDO_COMMAND = 'sudo';

/**
 * Locale variables a server may need to format text. Copied from the
 * middleware's environment when set; nothing else of it reaches the child.
 */
export const MCP_STDIO_LOCALE_ENV_KEYS: readonly string[] = ['LANG', 'LC_ALL', 'LC_CTYPE', 'TZ'];

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

/** Command, args and env for one stdio child. */
export function stdioLaunch(
  command: string,
  args: readonly string[],
  configEnv: Readonly<Record<string, string>> | undefined,
  isolation: McpStdioIsolation = {},
): McpStdioLaunch {
  const env = stdioChildEnv(configEnv);
  if (!isolation.runAsUser) return { command, args: [...args], env };
  return {
    command: MCP_STDIO_SUDO_COMMAND,
    args: [...stdioRunAsPrefix(isolation.runAsUser), command, ...args],
    env,
  };
}
