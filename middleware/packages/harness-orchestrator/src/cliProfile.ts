import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Spec 2042 §5.10 — the isolated profile of every Claude CLI spawn.
 *
 * Every start of the CLI (`run_loop` for an agent turn, `complete` for
 * summaries, extraction, classification, the verifier) runs with `HOME` and
 * `CLAUDE_CONFIG_DIR` pointing to ONE kernel-managed directory that holds
 * only the subscription login. So no `~/.claude/CLAUDE.md`, `AGENTS.md` or
 * other instruction file of the operator's home is read; the project-memory
 * half was already closed by spawning in an empty working directory.
 *
 * The directory:
 *   - the deployment's own `CLAUDE_CONFIG_DIR` when one is set (the image
 *     sets `/data/claude-cli`, where `claude auth login` writes): it already
 *     is a directory only for the login;
 *   - otherwise `<data dir>/claude-cli-profile`, seeded once with the login
 *     file of the default config directory (`~/.claude/.credentials.json`)
 *     where the CLI keeps its login in a file.
 *
 * On macOS the CLI keeps its login in the keychain, under an entry that
 * belongs to the config directory: a fresh profile is not logged in. In
 * mode `auto` the kernel therefore isolates only where the login can follow
 * (a deployment directory, a login file to seed, or a profile that was
 * logged in already), and otherwise keeps the inherited environment and
 * says so at boot; mode `isolated` always isolates (sign in once more in
 * Settings → the CLI's login uses the profile too).
 *
 * The profile is checked before every spawn: an instruction file in it
 * refuses the spawn instead of feeding the file to the model.
 */

/** Files the CLI reads as instructions when they sit in its config or home. */
export const CLI_PROFILE_INSTRUCTION_FILES: readonly string[] = [
  'CLAUDE.md',
  'CLAUDE.local.md',
  'AGENTS.md',
  path.join('.claude', 'CLAUDE.md'),
  path.join('.claude', 'AGENTS.md'),
];

/** The CLI's login file, where it keeps one (Linux, containers). */
export const CLI_CREDENTIALS_FILE = '.credentials.json';

export type CliProfileMode = 'auto' | 'isolated' | 'inherit';

export interface CliProfileDecision {
  /** The profile directory, or `undefined` when the environment is inherited. */
  readonly dir: string | undefined;
  /** Why, for the boot log. */
  readonly reason: string;
}

const PROFILE_SLOT = Symbol.for('omadia.cli.profileDir');
type Slots = Record<symbol, unknown>;

/** The profile every spawn uses. Set once by the kernel at boot. */
export function setCliProfileDir(dir: string | undefined): void {
  (globalThis as unknown as Slots)[PROFILE_SLOT] = dir;
}

export function cliProfileDir(): string | undefined {
  return (globalThis as unknown as Slots)[PROFILE_SLOT] as string | undefined;
}

/** `HOME` and `CLAUDE_CONFIG_DIR` of the profile over `env`. */
export function applyCliProfile(env: NodeJS.ProcessEnv, dir: string | undefined = cliProfileDir()): NodeJS.ProcessEnv {
  if (dir === undefined) return env;
  return { ...env, HOME: dir, CLAUDE_CONFIG_DIR: dir };
}

/**
 * Decide the profile at boot and prepare its directory. Pure apart from the
 * file system work on the profile directory itself.
 */
export function decideCliProfile(input: {
  readonly mode: CliProfileMode;
  /** The deployment's `CLAUDE_CONFIG_DIR`, if set. */
  readonly configuredDir: string | undefined;
  /** The operator's home (`HOME`). */
  readonly home: string | undefined;
  /** The kernel's data directory. */
  readonly dataDir: string;
}): CliProfileDecision {
  if (input.mode === 'inherit') return { dir: undefined, reason: 'CLI profile inherited (OMADIA_CLI_PROFILE=inherit)' };
  const configured = input.configuredDir?.trim();
  if (configured) {
    return { dir: path.resolve(configured), reason: `CLI profile is the deployment's login directory ${configured}` };
  }
  const dir = path.join(input.dataDir, 'claude-cli-profile');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, CLI_CREDENTIALS_FILE);
  const source = input.home ? path.join(input.home, '.claude', CLI_CREDENTIALS_FILE) : undefined;
  if (!existsSync(target) && source && existsSync(source)) {
    copyFileSync(source, target);
    return { dir, reason: `CLI profile ${dir}, login taken over from ${source}` };
  }
  if (existsSync(target) || input.mode === 'isolated' || existsSync(path.join(dir, '.claude.json'))) {
    return { dir, reason: `CLI profile ${dir}` };
  }
  return {
    dir: undefined,
    reason:
      'CLI profile NOT isolated: the CLI keeps its login outside a file (macOS keychain), so an isolated profile would be signed out. ' +
      'Set OMADIA_CLI_PROFILE=isolated and sign in once more to isolate it; until then an instruction file in ~/.claude can reach the model',
  };
}

/** Instruction files present in the profile; empty when it is clean. */
export function cliProfileInstructionFiles(dir: string | undefined = cliProfileDir()): string[] {
  if (dir === undefined) return [];
  return CLI_PROFILE_INSTRUCTION_FILES.map((f) => path.join(dir, f)).filter((f) => existsSync(f));
}

/** Thrown before a spawn whose profile holds an instruction file. */
export class CliProfileNotCleanError extends Error {
  readonly files: readonly string[];
  constructor(files: readonly string[]) {
    super(
      `the Claude CLI profile holds instruction files (${files.join(', ')}); a spawn would feed them to the model. ` +
        'Remove them: the profile holds only the subscription login (spec 2042 §5.10)',
    );
    this.name = 'CliProfileNotCleanError';
    this.files = files;
  }
}

/** Throws {@link CliProfileNotCleanError} when the profile is not clean. */
export function assertCliProfileClean(dir: string | undefined = cliProfileDir()): void {
  const files = cliProfileInstructionFiles(dir);
  if (files.length > 0) throw new CliProfileNotCleanError(files);
}
