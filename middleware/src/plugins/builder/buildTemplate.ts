import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * BuildTemplate — provides a pre-resolved `node_modules` for build sandboxes.
 *
 * Boilerplate-generated agents `peerDependencies` `@omadia/plugin-api`,
 * `zod`, `@anthropic-ai/sdk` etc.; running `npm install` once per build is
 * untenable on Fly cold starts. Instead we maintain a single `build-template`
 * directory whose `node_modules/` is reused by every build via symlink.
 *
 * Two dep classes:
 *   - **npmDeps**: real packages on the npm registry (`zod`, `typescript`,
 *     `@anthropic-ai/sdk`). Installed via one-shot `npm install --omit=dev`.
 *   - **workspaceDeps**: byte5 workspace packages (`@omadia/plugin-api`
 *     and friends) — not on npm. Symlinked into `node_modules/<name>` from
 *     their on-disk paths in `middleware/packages/`.
 *
 * Both classes feed a content-hash; if the hash matches what we wrote last
 * time AND `node_modules/` is present, `ensureBuildTemplate` is a no-op
 * (Rule #15/#23 — idempotent boot init).
 */

export interface BuildTemplateOptions {
  /** Absolute path to the build template root, e.g. `data/builder/build-template`. */
  templateRoot: string;
  /** Real npm registry deps as `{ name: semver-range }`. */
  npmDeps: Readonly<Record<string, string>>;
  /** Workspace package deps as `{ scoped-name: absolute-path-to-package }`. */
  workspaceDeps: Readonly<Record<string, string>>;
  /** Tests pass `true` to skip the actual `npm install` step. */
  skipNpmInstall?: boolean;
  installTimeoutMs?: number;
}

export interface BuildTemplateResult {
  ready: boolean;
  reused: boolean;
  durationMs: number;
  installedAt?: string;
  reason?: string;
}

const HASH_FILE = '.harness-build-template.hash';
const DEFAULT_INSTALL_TIMEOUT_MS = 120_000;

export async function ensureBuildTemplate(
  opts: BuildTemplateOptions,
): Promise<BuildTemplateResult> {
  const start = Date.now();
  const {
    templateRoot,
    npmDeps,
    workspaceDeps,
    skipNpmInstall = false,
    installTimeoutMs = DEFAULT_INSTALL_TIMEOUT_MS,
  } = opts;

  await fs.mkdir(templateRoot, { recursive: true });

  const pkgJsonText = renderPackageJson(npmDeps);
  const pkgJsonPath = path.join(templateRoot, 'package.json');
  const newHash = computeHash(pkgJsonText, workspaceDeps);

  const hashPath = path.join(templateRoot, HASH_FILE);
  let existingHash = '';
  try {
    existingHash = (await fs.readFile(hashPath, 'utf-8')).trim();
  } catch {
    /* no hash yet — fresh install path */
  }

  const nodeModulesPath = path.join(templateRoot, 'node_modules');
  const reused = newHash === existingHash && existsSync(nodeModulesPath);

  if (reused) {
    return { ready: true, reused: true, durationMs: Date.now() - start };
  }

  // Re-init from scratch
  await fs.writeFile(pkgJsonPath, pkgJsonText, 'utf-8');

  if (Object.keys(npmDeps).length > 0 && !skipNpmInstall) {
    // Wipe stale node_modules before running install
    await fs.rm(nodeModulesPath, { recursive: true, force: true });
    const installResult = await runNpmInstall(templateRoot, installTimeoutMs);
    if (!installResult.ok) {
      return {
        ready: false,
        reused: false,
        durationMs: Date.now() - start,
        reason: `npm install failed: ${installResult.message}`,
      };
    }
  }

  // Materialise workspace symlinks (idempotent — replace stale links).
  // node_modules dir exists by now (npm install created it, or skipNpmInstall
  // means we make it ourselves).
  await fs.mkdir(nodeModulesPath, { recursive: true });
  for (const [name, srcPath] of Object.entries(workspaceDeps)) {
    const linkPath = path.join(nodeModulesPath, name);
    await fs.mkdir(path.dirname(linkPath), { recursive: true });
    try {
      await fs.rm(linkPath, { recursive: true, force: true });
    } catch {
      /* ignore — may not exist */
    }
    await fs.symlink(path.resolve(srcPath), linkPath, 'dir');
  }

  await fs.writeFile(hashPath, newHash, 'utf-8');

  return {
    ready: true,
    reused: false,
    durationMs: Date.now() - start,
    installedAt: new Date().toISOString(),
  };
}

function renderPackageJson(npmDeps: Readonly<Record<string, string>>): string {
  const sortedDeps: Record<string, string> = {};
  for (const key of Object.keys(npmDeps).sort()) {
    sortedDeps[key] = npmDeps[key]!;
  }
  const pkg = {
    name: 'harness-build-template',
    private: true,
    type: 'module' as const,
    dependencies: sortedDeps,
  };
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

function computeHash(
  pkgJsonText: string,
  workspaceDeps: Readonly<Record<string, string>>,
): string {
  const hasher = createHash('sha256');
  hasher.update(pkgJsonText);
  // Sort workspace dep entries deterministically — same content yields same
  // hash regardless of object-iteration order.
  const sortedEntries = Object.keys(workspaceDeps)
    .sort()
    .map((name) => `${name}=${workspaceDeps[name]}`)
    .join('|');
  hasher.update(sortedEntries);
  return hasher.digest('hex');
}

interface NpmInstallResult {
  ok: boolean;
  message: string;
}

function runNpmInstall(
  templateRoot: string,
  timeoutMs: number,
): Promise<NpmInstallResult> {
  return new Promise((resolve) => {
    let resolved = false;
    let stderrTail = '';

    const proc = spawn(
      'npm',
      ['install', '--omit=dev', '--no-audit', '--no-fund'],
      {
        cwd: templateRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      },
    );

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill('SIGKILL');
        resolve({ ok: false, message: 'timeout' });
      }
    }, timeoutMs);

    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf-8')).slice(-2048);
    });

    proc.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve({ ok: false, message: `spawn error: ${err.message}` });
    });

    proc.on('close', (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      if (code === 0) resolve({ ok: true, message: 'ok' });
      else resolve({ ok: false, message: `exit ${code}: ${stderrTail.trim()}` });
    });
  });
}

// --- Staging-Dir-Preparation --------------------------------------------

export interface PrepareStagingDirOptions {
  templateRoot: string;
  draftId: string;
  buildN: number;
  files: ReadonlyMap<string, Buffer>;
  /** Defaults to `<templateRoot>/../staging`. Tests override. */
  stagingBaseDir?: string;
}

export async function prepareStagingDir(
  opts: PrepareStagingDirOptions,
): Promise<string> {
  const stagingBase =
    opts.stagingBaseDir ?? path.join(path.dirname(opts.templateRoot), 'staging');
  const dirName = `${opts.draftId}-${opts.buildN}-${Date.now()}`;
  const stagingDir = path.join(stagingBase, dirName);

  await fs.mkdir(stagingDir, { recursive: true });

  for (const [relPath, content] of opts.files) {
    const absPath = path.join(stagingDir, relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, content);
  }

  // Symlink node_modules from build template — single shared install reused
  // across every build.
  const templateNodeModules = path.join(opts.templateRoot, 'node_modules');
  const stagingNodeModules = path.join(stagingDir, 'node_modules');
  // Replace any stale symlink/dir at the target.
  try {
    await fs.rm(stagingNodeModules, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  await fs.symlink(path.resolve(templateNodeModules), stagingNodeModules, 'dir');

  return stagingDir;
}

export async function cleanupStagingDir(stagingDir: string): Promise<void> {
  await fs.rm(stagingDir, { recursive: true, force: true });
}
