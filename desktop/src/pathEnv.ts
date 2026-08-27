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
    // Covers pip --user, pipx, and — decisively — Claude Code's own native
    // installer (claude.ai/install.sh), which symlinks `claude` here. That
    // install path is entirely independent of Homebrew/npm/nvm/volta/asdf, so
    // none of the checks above would ever find it.
    path.join(homeDir, '.local', 'bin'),
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

function resolveNvmBinDir(homeDir: string): string | null {
  try {
    const defaultAliasPath = path.join(homeDir, '.nvm', 'alias', 'default');
    const defaultAlias = fs.readFileSync(defaultAliasPath, 'utf8').trim();
    if (!isLiteralNodeVersion(defaultAlias)) return null;

    const versionsDir = path.join(homeDir, '.nvm', 'versions', 'node');
    const versionEntries = fs.readdirSync(versionsDir).sort();
    const exactMatch = versionEntries.find((entry) => entry === defaultAlias);
    if (exactMatch) return path.join(versionsDir, exactMatch, 'bin');

    const versionPrefix = defaultAlias.startsWith('v') ? defaultAlias : `v${defaultAlias}`;
    const prefixMatch = versionEntries.find((entry) => entry.startsWith(versionPrefix));
    return prefixMatch ? path.join(versionsDir, prefixMatch, 'bin') : null;
  } catch {
    // nvm is optional per-user tooling; any missing/unreadable state is skipped
    // silently so app boot never depends on probing it.
    return null;
  }
}

function isLiteralNodeVersion(value: string): boolean {
  return /^(?:v)?\d+(?:\.\d+)*$/.test(value);
}
