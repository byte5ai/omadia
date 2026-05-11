import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

import { parseTscErrors, type BuildError } from './buildErrorParser.js';

/**
 * typecheckStaging — runs `node node_modules/typescript/bin/tsc --noEmit
 * --pretty false` inside a prepared staging directory and parses tsc
 * diagnostics from stdout+stderr (tsc writes to stdout by default;
 * see B.6-13.1).
 *
 * Direct binary invocation is intentional: `npx tsc` swallows stderr in
 * some TTY-detection paths (root cause of the empty-output failures in
 * B.6-13). Requires typescript to be installed in stagingDir/node_modules,
 * which `BUILD_TIME_ONLY_DEPS` guarantees for build-template-prepared
 * staging directories.
 *
 * The actual spawn is exposed via the `executeTypecheck` option so tests
 * can inject canned exit + stdout + stderr without a real toolchain.
 *
 * Reused by:
 *   - B.7-2 fill_slot tool (warm-staging tsc-gate)
 *   - Future pre-build static checks (B.8+)
 */

export type TypecheckReason = 'ok' | 'tsc' | 'timeout' | 'abort' | 'spawn' | 'unknown';

export interface TypecheckResult {
  /** True iff exit code 0 AND no parsed errors. Callers should treat
   * `ok === false` as authoritative — the `errors[]` array may be empty
   * even on failure (e.g. spawn errors or non-tsc failures). */
  ok: boolean;
  errors: BuildError[];
  exitCode: number | null;
  stdoutTail: string;
  stderrTail: string;
  durationMs: number;
  reason: TypecheckReason;
}

export interface TypecheckExecutionResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  reason: TypecheckReason;
}

export interface TypecheckExecutionContext {
  stagingDir: string;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}

export interface TypecheckOptions {
  stagingDir: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  /** Override for tests — replaces the child-process spawn step. */
  executeTypecheck?: (ctx: TypecheckExecutionContext) => Promise<TypecheckExecutionResult>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const TAIL_BYTES = 4096;

export async function typecheckStaging(opts: TypecheckOptions): Promise<TypecheckResult> {
  const start = Date.now();
  const stagingDir = path.resolve(opts.stagingDir);
  const ctx: TypecheckExecutionContext = {
    stagingDir,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxOutputBytes: opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    signal: opts.signal,
  };

  const exec = opts.executeTypecheck ?? executeTypecheckViaSpawn;
  const result = await exec(ctx);
  const durationMs = Date.now() - start;
  const errors = parseTscErrors(`${result.stdout}\n${result.stderr}`);

  let reason: TypecheckReason;
  if (result.reason !== 'ok') {
    reason = result.reason;
  } else if (result.exitCode !== 0) {
    reason = errors.length > 0 ? 'tsc' : 'unknown';
  } else {
    reason = 'ok';
  }

  return {
    ok: reason === 'ok' && errors.length === 0,
    errors,
    exitCode: result.exitCode,
    stdoutTail: tail(result.stdout),
    stderrTail: tail(result.stderr),
    durationMs,
    reason,
  };
}

/**
 * Filters BuildError[] to those originating from a specific file. The
 * fill_slot tool uses this to surface only errors in the file the agent
 * just wrote, while still running tsc against the whole staging dir
 * (single-file tsc is impractical because imports need the full tree).
 *
 * Path comparison is normalized: tsc may emit paths with or without a
 * leading `./` depending on tsconfig include patterns. We strip leading
 * `./` and run path.normalize on both sides.
 */
export function filterErrorsByFile(errors: BuildError[], relPath: string): BuildError[] {
  const target = normalizeRelPath(relPath);
  return errors.filter((e) => normalizeRelPath(e.path) === target);
}

function normalizeRelPath(p: string): string {
  return path.normalize(p).replace(/^\.[\\/]/, '');
}

function tail(s: string): string {
  return s.length > TAIL_BYTES ? `…${s.slice(-TAIL_BYTES)}` : s;
}

async function executeTypecheckViaSpawn(
  ctx: TypecheckExecutionContext,
): Promise<TypecheckExecutionResult> {
  return new Promise((resolve) => {
    let stdoutBuf = Buffer.alloc(0);
    let stderrBuf = Buffer.alloc(0);
    let stdoutOverflow = false;
    let stderrOverflow = false;
    let resolved = false;
    let pendingReason: TypecheckReason = 'ok';

    let proc: ChildProcess;
    try {
      proc = spawn(
        'node',
        ['node_modules/typescript/bin/tsc', '--noEmit', '--pretty', 'false'],
        {
          cwd: ctx.stagingDir,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: process.env,
        },
      );
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

export const _internal = { executeTypecheckViaSpawn };
