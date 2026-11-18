import { resolveSandboxResourceLimits, type SandboxResourceLimits } from '@omadia/sandbox';

/**
 * Operator setting for the sandbox container ceilings (see
 * `@omadia/sandbox`'s `resourceLimits.ts`). The keys are orchestrator setup
 * fields in `manifest.yaml`; `plugin.ts` reads them ONCE and hands the result
 * to both Docker paths (`execute` and `publish`), so the two cannot drift.
 */
export const SANDBOX_LIMIT_CONFIG_KEYS: Readonly<Record<keyof SandboxResourceLimits, string>> =
  Object.freeze({
    memoryMb: 'sandbox_memory_mb',
    cpus: 'sandbox_cpus',
    pidsLimit: 'sandbox_pids_limit',
  });

/**
 * Per field: a valid setup-field value, else the `OMADIA_SANDBOX_*` env
 * variable, else the built-in default. Same order as `cli_turn_seconds`
 * (OM-104), so an operator raising a limit in the UI is not overruled by a
 * stale deployment variable. Empty, `0` and junk count as "not set"; there is
 * no "unlimited".
 */
export function readSandboxResourceLimits(
  get: (key: string) => unknown,
  env?: Readonly<Record<string, string | undefined>>,
): SandboxResourceLimits {
  return resolveSandboxResourceLimits(
    {
      memoryMb: get(SANDBOX_LIMIT_CONFIG_KEYS.memoryMb),
      cpus: get(SANDBOX_LIMIT_CONFIG_KEYS.cpus),
      pidsLimit: get(SANDBOX_LIMIT_CONFIG_KEYS.pidsLimit),
    },
    env,
  );
}

/** One-line summary for the boot log, e.g. `memory=512m cpus=1 pids=256`. */
export function describeSandboxResourceLimits(limits: SandboxResourceLimits): string {
  return `memory=${String(limits.memoryMb)}m cpus=${String(limits.cpus)} pids=${String(limits.pidsLimit)}`;
}
