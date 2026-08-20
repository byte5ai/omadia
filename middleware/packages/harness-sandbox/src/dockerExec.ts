import { spawn } from 'node:child_process';

/**
 * The one spawn primitive `DockerSandboxBackend` runs every `docker …`
 * invocation through. Mirrors `buildSandbox.ts`'s `executeBuild` injection
 * pattern deliberately: tests replace `execDocker` with a canned responder so
 * the FULL backend logic (arg construction, path clamping, profile → flag
 * translation, timeout handling, output capping) runs with no real Docker
 * daemon — the same seam that lets `buildSandbox.test.ts` exercise the tsc
 * failure paths without a real tsc.
 */
export interface DockerExecContext {
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  /** Piped to the child's stdin when present (used by `write()`). */
  readonly input?: string;
}

export interface DockerExecResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly outputTruncated: boolean;
}

export type DockerExec = (ctx: DockerExecContext) => Promise<DockerExecResult>;

/** Real `docker` CLI spawn. Node builtins only, same constraint as
 *  `dev-runner-shim` — no dependency may enter this seam. */
export const execDockerViaSpawn: DockerExec = (ctx) => {
  return new Promise((resolve) => {
    let stdoutBuf: Buffer = Buffer.alloc(0);
    let stderrBuf: Buffer = Buffer.alloc(0);
    let truncated = false;
    let resolved = false;
    let timedOut = false;

    const child = spawn('docker', ctx.args as string[], {
      stdio: ctx.input !== undefined ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      if (!resolved) {
        timedOut = true;
        child.kill('SIGKILL');
      }
    }, ctx.timeoutMs);
    timer.unref?.();

    const cap = (buf: Buffer, chunk: Buffer): Buffer => {
      const room = ctx.maxOutputBytes - buf.length;
      if (room <= 0) {
        truncated = true;
        return buf;
      }
      if (chunk.length > room) {
        truncated = true;
        return Buffer.concat([buf, chunk.subarray(0, room)]);
      }
      return Buffer.concat([buf, chunk]);
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf = cap(stdoutBuf, chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf = cap(stderrBuf, chunk);
    });

    child.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve({
        exitCode: null,
        stdout: stdoutBuf.toString('utf-8'),
        stderr: `${stderrBuf.toString('utf-8')}\n[spawn-error] ${err.message}`,
        timedOut,
        outputTruncated: truncated,
      });
    });

    child.on('close', (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve({
        exitCode: code,
        stdout: stdoutBuf.toString('utf-8'),
        stderr: stderrBuf.toString('utf-8'),
        timedOut,
        outputTruncated: truncated,
      });
    });

    if (ctx.input !== undefined) {
      child.stdin?.end(ctx.input, 'utf-8');
    }
  });
};
