/**
 * Hard resource ceilings for every container omadia starts for agent code:
 * the per-scope sandbox (`DockerSandboxBackend`, #576) and published apps
 * (`DockerPublishRuntime` in `@omadia/publish`, #581).
 *
 * `AgentComputerProfile.maxRunSeconds` only bounds ONE `run()` call: its
 * `timeout` kills the wrapper shell, not what that shell left behind in the
 * long-lived container. A fork bomb or a runaway allocation inside the
 * container is bounded by these limits and nothing else, so they are wired
 * into `docker run` (and `docker update` on re-attach), never merely declared,
 * and the sandbox backend checks them with `resourceLimitsNotInForce()` before
 * a container runs anything.
 *
 * Fail-closed like `DEFAULT_AGENT_COMPUTER_PROFILE`: there is deliberately no
 * "unlimited". Docker reads `0` as "no limit" for all three flags, and it
 * also applies no limit to some positive values (see
 * `SANDBOX_RESOURCE_LIMIT_BOUNDS`). So only a number inside its field's range
 * counts; anything else (0, negative, out of range, empty, junk) falls back
 * to the next source instead of reaching argv. An operator who needs more
 * sets a larger number within the range.
 */
export interface SandboxResourceLimits {
  /** RAM ceiling in MiB. Also the RAM+swap ceiling (`--memory-swap`), so the
   *  container cannot swap past it. A whole number from 6 to 1048576 (1 TiB). */
  readonly memoryMb: number;
  /** CPU share (`--cpus`) from 0.01 to 1024; fractions such as 0.5 are allowed. */
  readonly cpus: number;
  /** Maximum number of processes and threads (`--pids-limit`). A whole number
   *  from 1 to 4194304. */
  readonly pidsLimit: number;
}

/** Raw, unvalidated values per field, e.g. straight from plugin config. */
export type SandboxResourceLimitInput = {
  readonly [K in keyof SandboxResourceLimits]?: unknown;
};

type LimitEnv = Readonly<Record<string, string | undefined>>;

export const DEFAULT_SANDBOX_RESOURCE_LIMITS: SandboxResourceLimits = Object.freeze({
  memoryMb: 512,
  cpus: 1,
  pidsLimit: 256,
});

/** Deployment-wide defaults, read when a caller passes no valid value for a field. */
export const SANDBOX_RESOURCE_LIMIT_ENV_KEYS: Readonly<Record<keyof SandboxResourceLimits, string>> =
  Object.freeze({
    memoryMb: 'OMADIA_SANDBOX_MEMORY_MB',
    cpus: 'OMADIA_SANDBOX_CPUS',
    pidsLimit: 'OMADIA_SANDBOX_PIDS_LIMIT',
  });

interface LimitRange {
  readonly min: number;
  readonly max: number;
}

/**
 * The range in which Docker applies each value as a real ceiling. Outside it
 * Docker refuses the container or, worse, starts it with no limit and no
 * error (reproduced on Docker 29.4, cgroup v2):
 *
 * - `cpus` becomes a CFS quota of `cpus × 100000` µs per 100 ms period,
 *   truncated to whole µs. Below 0.00001 the quota is 0, which runc writes as
 *   `max`: unlimited. Below 0.01 the kernel refuses the sub-millisecond quota.
 *   A huge value overflows the CLI's int64 nano-CPU count, and `1e64` wraps
 *   to exactly 0: unlimited again. Docker itself refuses more CPUs than the
 *   host has; 1024 only keeps the number finite.
 * - `memoryMb`: Docker refuses less than 6 MiB. From 2^43 MiB the byte count
 *   overflows int64, and `String(1e21)` is `1e+21`, which Docker parses as a
 *   float; on arm64 both are recorded as no limit. 1 TiB is far below that.
 * - `pidsLimit`: the kernel's `pids.max` takes at most 4194304
 *   (`PID_MAX_LIMIT` on 64-bit Linux).
 *
 * Every value in range renders as plain digits, never in exponent notation.
 */
export const SANDBOX_RESOURCE_LIMIT_BOUNDS: Readonly<Record<keyof SandboxResourceLimits, LimitRange>> =
  Object.freeze({
    memoryMb: Object.freeze({ min: 6, max: 1_048_576 }),
    cpus: Object.freeze({ min: 0.01, max: 1024 }),
    pidsLimit: Object.freeze({ min: 1, max: 4_194_304 }),
  });

function inRange(value: number, range: LimitRange): boolean {
  return value >= range.min && value <= range.max;
}

const IS_VALID: Readonly<Record<keyof SandboxResourceLimits, (value: number) => boolean>> = {
  memoryMb: (value) => Number.isInteger(value) && inRange(value, SANDBOX_RESOURCE_LIMIT_BOUNDS.memoryMb),
  cpus: (value) => inRange(value, SANDBOX_RESOURCE_LIMIT_BOUNDS.cpus),
  pidsLimit: (value) => Number.isInteger(value) && inRange(value, SANDBOX_RESOURCE_LIMIT_BOUNDS.pidsLimit),
};

function parseLimit(raw: unknown, isValid: (value: number) => boolean): number | undefined {
  let value: number;
  if (typeof raw === 'number') {
    value = raw;
  } else if (typeof raw === 'string' && raw.trim().length > 0) {
    value = Number(raw.trim());
  } else {
    return undefined;
  }
  return isValid(value) ? value : undefined;
}

/**
 * Resolve each field independently: a valid value in `overrides` wins, then a
 * valid value in its `OMADIA_SANDBOX_*` env variable, then the default. The
 * result is frozen and always complete.
 */
export function resolveSandboxResourceLimits(
  overrides: SandboxResourceLimitInput = {},
  env: LimitEnv = process.env,
): SandboxResourceLimits {
  const pick = (field: keyof SandboxResourceLimits): number =>
    parseLimit(overrides[field], IS_VALID[field]) ??
    parseLimit(env[SANDBOX_RESOURCE_LIMIT_ENV_KEYS[field]], IS_VALID[field]) ??
    DEFAULT_SANDBOX_RESOURCE_LIMITS[field];
  return Object.freeze({
    memoryMb: pick('memoryMb'),
    cpus: pick('cpus'),
    pidsLimit: pick('pidsLimit'),
  });
}

/**
 * The flags for `docker run` and `docker update`. Every site that starts a
 * container for agent code goes through this builder, so a new site cannot
 * forget one flag. The input is re-validated: a hand-built `{ memoryMb: 0 }`
 * or `{ cpus: 1e-7 }` would otherwise tell Docker "no limit".
 *
 * `--memory-swap` equals `--memory`: without it Docker lets the container
 * swap up to the same amount again, and `docker update` refuses to raise
 * `--memory` above a swap ceiling it was not given at the same time.
 */
export function dockerResourceLimitArgs(limits: SandboxResourceLimits): readonly string[] {
  const safe = resolveSandboxResourceLimits(limits);
  const memory = `${String(safe.memoryMb)}m`;
  return [
    '--memory',
    memory,
    '--memory-swap',
    memory,
    '--cpus',
    String(safe.cpus),
    '--pids-limit',
    String(safe.pidsLimit),
  ];
}

const BYTES_PER_MIB = 1024 * 1024;
const NANO_CPUS_PER_CPU = 1_000_000_000;
/** The CFS period the kernel uses when a quota is set without one. */
const DEFAULT_CPU_PERIOD_US = 100_000;

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * The limits a container does NOT have in force, judged from its
 * `docker inspect` `.HostConfig`. Each entry names one flag whose value is
 * missing (absent, `null`, `0` or `-1`, which Docker all reads as no limit) or
 * looser than `limits` asks for; an empty result means every limit holds. A
 * stricter value counts as in force. The CPU share is read from `NanoCpus`
 * (what `--cpus` records) or, when that is unset, from `CpuQuota` over
 * `CpuPeriod`, so a runtime that records the share as a CFS quota passes too.
 *
 * Entries carry numbers only, never text from Docker, so they can be logged
 * and shown as they are.
 */
export function resourceLimitsNotInForce(hostConfig: unknown, limits: SandboxResourceLimits): readonly string[] {
  const safe = resolveSandboxResourceLimits(limits);
  const host: Readonly<Record<string, unknown>> =
    typeof hostConfig === 'object' && hostConfig !== null ? (hostConfig as Record<string, unknown>) : {};
  const memoryBytes = safe.memoryMb * BYTES_PER_MIB;
  const quota = positiveNumber(host['CpuQuota']);
  const period = positiveNumber(host['CpuPeriod']) ?? DEFAULT_CPU_PERIOD_US;
  const nanoCpus =
    positiveNumber(host['NanoCpus']) ??
    (quota !== undefined ? Math.round((quota * NANO_CPUS_PER_CPU) / period) : undefined);
  const checks: ReadonlyArray<readonly [string, number | undefined, number, string]> = [
    ['--memory', positiveNumber(host['Memory']), memoryBytes, 'bytes'],
    ['--memory-swap', positiveNumber(host['MemorySwap']), memoryBytes, 'bytes'],
    ['--cpus', nanoCpus, Math.round(safe.cpus * NANO_CPUS_PER_CPU), 'nano-CPUs'],
    ['--pids-limit', positiveNumber(host['PidsLimit']), safe.pidsLimit, 'processes'],
  ];
  return checks.flatMap(([flag, actual, required, unit]) => {
    if (actual === undefined) return [`${flag} not set (required ${String(required)} ${unit})`];
    if (actual > required) return [`${flag} ${String(actual)} ${unit} (required at most ${String(required)})`];
    return [];
  });
}
