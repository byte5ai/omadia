import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { parseTscErrors, type BuildError } from './buildErrorParser.js';

/**
 * BuildSandbox — runs the boilerplate's `scripts/build-zip.mjs` as a
 * child process inside the staging directory and returns either the
 * built ZIP buffer (on success) or a structured failure (on tsc errors,
 * timeout, abort, or missing artefact).
 *
 * Process model:
 *   - Spawn `node scripts/build-zip.mjs` with cwd = stagingDir
 *   - Capture stdout/stderr into byte-capped buffers (default 2 MB each)
 *   - Race against `timeoutMs` (default 45_000) and an optional AbortSignal
 *   - On exit 0: read package.json → resolve `out/<name>-<version>.zip` →
 *     return buffer + cleanup of `node_modules` (symlink) and `out/`
 *   - On non-zero exit: parse stderr via `parseTscErrors`; surface tail
 *     of stdout/stderr for debug (no logs persisted)
 *
 * The actual spawn is exposed via the `executeBuild` option so tests can
 * inject canned exitCode + stdout + stderr without needing a real
 * tsc/zip toolchain.
 */

export interface BuildSuccess {
  ok: true;
  zip: Buffer;
  zipPath: string;
  durationMs: number;
}

export type BuildFailureReason =
  | 'tsc'
  | 'zip_missing'
  | 'package_json_missing'
  | 'timeout'
  | 'abort'
  | 'spawn'
  | 'unknown';

export interface BuildFailure {
  ok: false;
  errors: BuildError[];
  exitCode: number | null;
  stdoutTail: string;
  stderrTail: string;
  durationMs: number;
  reason: BuildFailureReason;
}

export type BuildResult = BuildSuccess | BuildFailure;

export interface BuildExecutionResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  reason: BuildFailureReason | 'ok';
}

export interface BuildExecutionContext {
  stagingDir: string;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}

export interface BuildSandboxOptions {
  stagingDir: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  /** Override for tests — replaces the child-process spawn step. */
  executeBuild?: (ctx: BuildExecutionContext) => Promise<BuildExecutionResult>;
}

const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const TAIL_BYTES = 4096;

export async function build(opts: BuildSandboxOptions): Promise<BuildResult> {
  const start = Date.now();
  const stagingDir = path.resolve(opts.stagingDir);
  const ctx: BuildExecutionContext = {
    stagingDir,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxOutputBytes: opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    signal: opts.signal,
  };

  const exec = opts.executeBuild ?? executeBuildViaSpawn;
  const result = await exec(ctx);
  const durationMs = Date.now() - start;

  if (result.exitCode !== 0 || result.reason !== 'ok') {
    // tsc writes diagnostics to STDOUT by default (stderr only carries
    // the spawn-level / unhandled-exception trace from build-zip.mjs).
    // Parse both streams so the tsc-error path stays observable
    // regardless of where tsc decided to dump them.
    const errors = parseTscErrors(`${result.stdout}\n${result.stderr}`);
    let reason: BuildFailureReason;
    if (result.reason === 'ok') {
      reason = errors.length > 0 ? 'tsc' : 'unknown';
    } else {
      reason = result.reason;
    }
    return {
      ok: false,
      errors,
      exitCode: result.exitCode,
      stdoutTail: tail(result.stdout),
      stderrTail: tail(result.stderr),
      durationMs,
      reason,
    };
  }

  // Resolve zip path from package.json
  let pkg: { name?: string; version?: string };
  try {
    const raw = await fs.readFile(path.join(stagingDir, 'package.json'), 'utf-8');
    pkg = JSON.parse(raw) as typeof pkg;
  } catch {
    return failure(result, durationMs, 'package_json_missing');
  }
  if (!pkg.name || !pkg.version) {
    return failure(result, durationMs, 'package_json_missing');
  }

  const zipPath = path.join(stagingDir, 'out', `${pkg.name}-${pkg.version}.zip`);
  let zip: Buffer;
  try {
    zip = await fs.readFile(zipPath);
  } catch {
    return failure(result, durationMs, 'zip_missing');
  }

  // Cleanup: drop node_modules symlink/dir + out/. Staging dir itself is
  // kept by the caller (typically the BuildQueue) for inspection or reuse.
  await Promise.allSettled([
    fs.rm(path.join(stagingDir, 'node_modules'), { recursive: true, force: true }),
    fs.rm(path.join(stagingDir, 'out'), { recursive: true, force: true }),
  ]);

  return { ok: true, zip, zipPath, durationMs };
}

function failure(
  result: BuildExecutionResult,
  durationMs: number,
  reason: BuildFailureReason,
): BuildFailure {
  return {
    ok: false,
    errors: [],
    exitCode: result.exitCode,
    stdoutTail: tail(result.stdout),
    stderrTail: tail(result.stderr),
    durationMs,
    reason,
  };
}

function tail(s: string): string {
  return s.length > TAIL_BYTES ? `…${s.slice(-TAIL_BYTES)}` : s;
}

async function executeBuildViaSpawn(
  ctx: BuildExecutionContext,
): Promise<BuildExecutionResult> {
  return new Promise((resolve) => {
    let stdoutBuf = Buffer.alloc(0);
    let stderrBuf = Buffer.alloc(0);
    let stdoutOverflow = false;
    let stderrOverflow = false;
    let resolved = false;
    let pendingReason: BuildFailureReason | 'ok' = 'ok';

    let proc: ChildProcess;
    try {
      proc = spawn('node', ['scripts/build-zip.mjs'], {
        cwd: ctx.stagingDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
    } catch (err) {
      resolve({
        exitCode: null,
        stdout: '',
        stderr: `[spawn-error] ${(err as Error).message}`,
        reason: 'spawn',
      });
      return;
    }

    const timeoutHandle = setTimeout(() => {
      if (!resolved) {
        pendingReason = 'timeout';
        proc.kill('SIGKILL');
      }
    }, ctx.timeoutMs);

    const onAbort = () => {
      if (!resolved) {
        pendingReason = 'abort';
        proc.kill('SIGKILL');
      }
    };
    if (ctx.signal) ctx.signal.addEventListener('abort', onAbort);

    const appendStdout = (chunk: Buffer) => {
      const room = ctx.maxOutputBytes - stdoutBuf.length;
      if (room <= 0) {
        stdoutOverflow = true;
        return;
      }
      if (chunk.length > room) {
        stdoutBuf = Buffer.concat([stdoutBuf, chunk.subarray(0, room)]);
        stdoutOverflow = true;
      } else {
        stdoutBuf = Buffer.concat([stdoutBuf, chunk]);
      }
    };
    const appendStderr = (chunk: Buffer) => {
      const room = ctx.maxOutputBytes - stderrBuf.length;
      if (room <= 0) {
        stderrOverflow = true;
        return;
      }
      if (chunk.length > room) {
        stderrBuf = Buffer.concat([stderrBuf, chunk.subarray(0, room)]);
        stderrOverflow = true;
      } else {
        stderrBuf = Buffer.concat([stderrBuf, chunk]);
      }
    };

    proc.stdout?.on('data', appendStdout);
    proc.stderr?.on('data', appendStderr);

    proc.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutHandle);
      if (ctx.signal) ctx.signal.removeEventListener('abort', onAbort);
      resolve({
        exitCode: null,
        stdout: stdoutBuf.toString('utf-8'),
        stderr: `${stderrBuf.toString('utf-8')}\n[spawn-error] ${err.message}`,
        reason: 'spawn',
      });
    });

    proc.on('close', (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutHandle);
      if (ctx.signal) ctx.signal.removeEventListener('abort', onAbort);

      let stdout = stdoutBuf.toString('utf-8');
      let stderr = stderrBuf.toString('utf-8');
      if (stdoutOverflow) stdout += '\n[stdout truncated]';
      if (stderrOverflow) stderr += '\n[stderr truncated]';

      resolve({
        exitCode: code,
        stdout,
        stderr,
        reason: pendingReason,
      });
    });
  });
}

export const _internal = { executeBuildViaSpawn };
