import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const UNIX_BIN_DIRS = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/local/sbin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
] as const;

/** Bounds the one-level `~/.local` scan so app boot stays predictable. */
const MAX_LOCAL_TOOL_DIRS = 24;
/** Bounds nvm alias chasing so a cyclic or absurd chain always terminates. */
const MAX_NVM_ALIAS_DEPTH = 10;

export function mergePath(basePath: string | undefined, extraDirs: readonly string[]): string {
  const mergedEntries = [...splitPath(basePath), ...extraDirs];
  const seen = new Set<string>();
  const uniqueEntries: string[] = [];

  for (const entry of mergedEntries) {
    if (seen.has(entry)) continue;
    seen.add(entry);
    uniqueEntries.push(entry);
  }

  return uniqueEntries.join(path.delimiter);
}

export function resolveAugmentedPath(
  basePath: string | undefined,
  platform: NodeJS.Platform = process.platform,
  homeDir: string = os.homedir(),
): string {
  if (platform === 'win32') {
    // Windows GUI apps inherit the user's full registry-backed PATH, so the
    // launcher-truncated PATH problem is specific to macOS/Linux.
    return basePath ?? '';
  }

  if (platform !== 'darwin' && platform !== 'linux') {
    return basePath ?? '';
  }

  const candidateDirs = [
    ...UNIX_BIN_DIRS,
    ...(platform === 'linux' ? ['/snap/bin'] : []),
    path.join(homeDir, '.volta', 'bin'),
    path.join(homeDir, '.asdf', 'shims'),
    // `~/.local/bin` covers pip --user, pipx, and — decisively — Claude Code's
    // own native installer (claude.ai/install.sh), which symlinks `claude`
    // there. The per-tool `~/.local/<tool>/bin` dirs cover the other common
    // shape of the same convention: an unpacked tarball kept under its own
    // name, which is how `~/.local/node/bin` ends up being the only place a
    // machine has `node` and `npm` at all (#925). Both are appended after the
    // inherited PATH, so a system install always keeps precedence.
    ...localBinDirs(homeDir),
  ];
  const extraDirs = existingDirs(candidateDirs);
  const nvmBinDir = resolveNvmBinDir(homeDir);

  if (nvmBinDir && safeExists(nvmBinDir)) {
    extraDirs.push(nvmBinDir);
  }

  return mergePath(basePath, extraDirs);
}

function splitPath(basePath: string | undefined): string[] {
  return (basePath ?? '').split(path.delimiter).filter((entry) => entry.length > 0);
}

function existingDirs(candidateDirs: readonly string[]): string[] {
  return candidateDirs.filter((candidateDir) => safeExists(candidateDir));
}

function safeExists(candidatePath: string): boolean {
  try {
    return fs.existsSync(candidatePath);
  } catch {
    return false;
  }
}

/**
 * `~/.local/bin` plus every `~/.local/<tool>/bin` candidate, one level deep.
 * Existence is checked by the shared `existingDirs` filter; a directory with
 * no `bin` child therefore contributes nothing. Entry names are sorted for a
 * deterministic PATH and the list is capped so an unusual home directory
 * cannot turn boot into an unbounded scan.
 */
function localBinDirs(homeDir: string): string[] {
  const localRoot = path.join(homeDir, '.local');
  const binDirs = [path.join(localRoot, 'bin')];

  let toolEntries: string[];
  try {
    toolEntries = fs.readdirSync(localRoot).sort();
  } catch {
    // Missing or unreadable `~/.local` is the common case, not an error — app
    // boot never depends on probing succeeding.
    return binDirs;
  }

  for (const toolEntry of toolEntries.slice(0, MAX_LOCAL_TOOL_DIRS)) {
    if (toolEntry === 'bin') continue;
    binDirs.push(path.join(localRoot, toolEntry, 'bin'));
  }

  return binDirs;
}

/**
 * The `bin` dir of the version nvm's `default` alias points at, following the
 * alias transitively: the two most common defaults (`lts/*` and `node`) are
 * not literal versions, and treating them as unresolvable made nvm users
 * indistinguishable from users with no Node at all (#925).
 */
function resolveNvmBinDir(homeDir: string): string | null {
  try {
    const aliasRoot = path.join(homeDir, '.nvm', 'alias');
    const versionsDir = path.join(homeDir, '.nvm', 'versions', 'node');
    const visited = new Set<string>();
    let aliasValue = readAliasValue(aliasRoot, 'default');

    for (let depth = 0; aliasValue !== null && depth < MAX_NVM_ALIAS_DEPTH; depth++) {
      if (visited.has(aliasValue)) return null; // cycle
      visited.add(aliasValue);

      if (isLiteralNodeVersion(aliasValue)) return literalVersionBinDir(versionsDir, aliasValue);
      // nvm's `node` alias means "the newest version installed".
      if (aliasValue === 'node') return newestVersionBinDir(versionsDir);

      aliasValue = readAliasValue(aliasRoot, aliasValue);
    }

    return null;
  } catch {
    // nvm is optional per-user tooling; any missing/unreadable state is skipped
    // silently so app boot never depends on probing it.
    return null;
  }
}

/**
 * Content of `<aliasRoot>/<aliasName>`, or null when it cannot be used. Alias
 * files are user-writable data that is turned into a filesystem path, so a
 * value that is absolute or that escapes the alias directory is rejected
 * rather than followed.
 */
function readAliasValue(aliasRoot: string, aliasName: string): string | null {
  if (path.isAbsolute(aliasName)) return null;

  const aliasPath = path.resolve(aliasRoot, aliasName);
  if (!aliasPath.startsWith(aliasRoot + path.sep)) return null;

  try {
    const aliasValue = fs.readFileSync(aliasPath, 'utf8').trim();
    return aliasValue.length > 0 ? aliasValue : null;
  } catch {
    return null;
  }
}

/** Exact-match then `v`-prefix-match against the installed versions. */
function literalVersionBinDir(versionsDir: string, version: string): string | null {
  const versionEntries = fs.readdirSync(versionsDir).sort();
  const exactMatch = versionEntries.find((entry) => entry === version);
  if (exactMatch) return path.join(versionsDir, exactMatch, 'bin');

  const versionPrefix = version.startsWith('v') ? version : `v${version}`;
  const prefixMatch = versionEntries.find((entry) => entry.startsWith(versionPrefix));
  return prefixMatch ? path.join(versionsDir, prefixMatch, 'bin') : null;
}

/** Newest installed version by numeric comparison — `v22.x` beats `v8.x`. */
function newestVersionBinDir(versionsDir: string): string | null {
  const versionEntries = fs.readdirSync(versionsDir).filter(isLiteralNodeVersion);
  if (versionEntries.length === 0) return null;

  const newest = versionEntries.sort(compareNodeVersions)[versionEntries.length - 1]!;
  return path.join(versionsDir, newest, 'bin');
}

function compareNodeVersions(left: string, right: string): number {
  const leftSegments = versionSegments(left);
  const rightSegments = versionSegments(right);
  const segmentCount = Math.max(leftSegments.length, rightSegments.length);

  for (let i = 0; i < segmentCount; i++) {
    const difference = (leftSegments[i] ?? 0) - (rightSegments[i] ?? 0);
    if (difference !== 0) return difference;
  }

  return 0;
}

function versionSegments(version: string): number[] {
  return version
    .replace(/^v/, '')
    .split('.')
    .map((segment) => Number.parseInt(segment, 10) || 0);
}

function isLiteralNodeVersion(value: string): boolean {
  return /^(?:v)?\d+(?:\.\d+)*$/.test(value);
}
