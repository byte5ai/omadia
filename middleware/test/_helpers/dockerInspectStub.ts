import type { DockerExecContext, DockerExecResult } from '../../packages/harness-sandbox/src/dockerExec.js';

/**
 * `docker inspect` for the stub tier of the sandbox tests. `DockerSandboxBackend`
 * checks a container's `.HostConfig` before it runs anything, so a canned
 * `execDocker` has to answer `inspect` the way a real daemon would.
 */

/** The limit fields of a container's `.HostConfig`, as `docker inspect` reports them. */
export interface InspectedLimits {
  readonly Memory: number;
  readonly MemorySwap: number;
  readonly NanoCpus: number;
  readonly CpuQuota: number;
  readonly CpuPeriod: number;
  readonly PidsLimit: number | null;
}

/** A container created without limit flags: Docker records `0` and `null`. */
export const NO_LIMITS: InspectedLimits = Object.freeze({
  Memory: 0,
  MemorySwap: 0,
  NanoCpus: 0,
  CpuQuota: 0,
  CpuPeriod: 0,
  PidsLimit: null,
});

/** What a daemon records for the limit flags of a `docker run` or `docker update` argv. */
export function inspectedLimitsFor(args: readonly string[]): InspectedLimits {
  const flag = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const bytes = (value: string | undefined): number =>
    value === undefined ? 0 : Number.parseInt(value, 10) * 1024 * 1024;
  const cpus = flag('--cpus');
  const pids = flag('--pids-limit');
  return {
    Memory: bytes(flag('--memory')),
    MemorySwap: bytes(flag('--memory-swap')),
    NanoCpus: cpus === undefined ? 0 : Math.round(Number(cpus) * 1e9),
    CpuQuota: 0,
    CpuPeriod: 0,
    PidsLimit: pids === undefined ? null : Number(pids),
  };
}

/** A successful `docker inspect --format '{{json .HostConfig}}'`. */
export function inspectOutput(limits: InspectedLimits): DockerExecResult {
  return { exitCode: 0, stdout: `${JSON.stringify(limits)}\n`, stderr: '', timedOut: false, outputTruncated: false };
}

/**
 * Wraps a canned `execDocker` script so `docker inspect` answers like a daemon
 * that applied the limit flags of the last `run` or `update` the script let
 * succeed (before that, a container without limits). `inspect` replaces that
 * answer for a daemon that drops or loosens a limit, or fails the call.
 */
export function withInspectableLimits<Rest extends unknown[]>(
  script: (ctx: DockerExecContext, ...rest: Rest) => DockerExecResult,
  inspect: (applied: InspectedLimits) => DockerExecResult = inspectOutput,
): (ctx: DockerExecContext, ...rest: Rest) => DockerExecResult {
  let applied = NO_LIMITS;
  return (ctx, ...rest) => {
    if (ctx.args[0] === 'inspect') return inspect(applied);
    const result = script(ctx, ...rest);
    if ((ctx.args[0] === 'run' || ctx.args[0] === 'update') && result.exitCode === 0) {
      applied = inspectedLimitsFor(ctx.args);
    }
    return result;
  };
}
