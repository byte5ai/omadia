/**
 * Hard resource ceilings for every container omadia starts for agent code:
 * the per-scope sandbox (`DockerSandboxBackend`, #576) and published apps
 * (`DockerPublishRuntime` in `@omadia/publish`, #581).
 *
 * `AgentComputerProfile.maxRunSeconds` only bounds ONE `run()` call: its
 * `timeout` kills the wrapper shell, not what that shell left behind in the
 * long-lived container. A fork bomb or a runaway allocation inside the
 * container is bounded by these limits and nothing else, so they are wired
 * into `docker run` (and `docker update` on re-attach), never merely declared.
 *
 * Fail-closed like `DEFAULT_AGENT_COMPUTER_PROFILE`: there is deliberately no
 * "unlimited". Docker reads `0` as "no limit" for all three flags, so a value
 * that is not a positive number (0, negative, empty, junk) falls back to the
 * next source instead of reaching argv. An operator who needs more sets a
 * larger number.
 */
export interface SandboxResourceLimits {
  /** RAM ceiling in MiB. Also the RAM+swap ceiling (`--memory-swap`), so the
   *  container cannot swap past it. A whole number. */
  readonly memoryMb: number;
  /** CPU share (`--cpus`); fractions such as 0.5 are allowed. */
  readonly cpus: number;
  /** Maximum number of processes and threads (`--pids-limit`). A whole number. */
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

const IS_VALID: Readonly<Record<keyof SandboxResourceLimits, (value: number) => boolean>> = {
  memoryMb: (value) => Number.isInteger(value) && value > 0,
  cpus: (value) => Number.isFinite(value) && value > 0,
  pidsLimit: (value) => Number.isInteger(value) && value > 0,
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
 * would otherwise tell Docker "no limit".
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
