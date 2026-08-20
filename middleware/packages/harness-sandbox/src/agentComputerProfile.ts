/**
 * Issue #576 (qm competitive analysis) — `AgentComputerProfile`: what a scope's
 * sandbox is allowed to do.
 *
 * This is the single declaration point every backend MUST read before it acts.
 * A profile field that a backend does not translate into an actual constraint is
 * exactly the repo's most-repeated defect (a declared capability nobody wires) —
 * see the `harness-lib-generalization-plan1` and `pr736-command-policy`
 * postmortems. Each field's doc comment below names the exact call site that is
 * required to enforce it, and `test/sandbox/dockerSandbox.test.ts` asserts that
 * enforcement against the *effect* (the argv a backend would run, or — behind
 * the Docker-availability gate — an actual blocked egress attempt), never just
 * against the type.
 */
export interface AgentComputerProfile {
  /**
   * Whether this scope's sandbox survives past a single tool call. `false`
   * means the backend MAY tear the sandbox down as soon as the call that
   * provisioned it returns (or on process exit); `true` is what P3's
   * scope-durability registry keeps alive and re-attaches to. Read by
   * `SandboxRegistry` (P3) to decide whether a teardown-on-idle reaper may
   * reap this scope's sandbox at all.
   */
  readonly persistent: boolean;
  /**
   * Whether the sandbox may reach the network. `false` MUST result in the
   * backend provisioning the sandbox with no route to any external host —
   * for `DockerSandboxBackend` that is `docker run --network none` (see
   * `dockerSandbox.ts`'s `provision()`), not a policy the sandboxed process
   * could be expected to honour on its own.
   */
  readonly egress: boolean;
  /**
   * Whether the backend should expose interactive/background process-session
   * capability (a long-lived shell a caller can attach/detach from, distinct
   * from the one-shot `run()` every backend supports). Declared here as the
   * seam qm's design calls for; `DockerSandboxBackend` v1 does not implement
   * it — `hasProcessSessions()` returns `false` for every sandbox it
   * provisions regardless of this flag, and that is asserted by
   * `agentComputerProfile.test.ts` rather than left to be discovered. A
   * profile that requests it without a backend that honours it is a
   * configuration error the caller must be able to detect, which is why the
   * capability is a type guard against the SANDBOX INSTANCE (what the
   * backend actually built) and not a re-statement of the profile.
   */
  readonly processSessions: boolean;
  /** Wall-clock budget for a single `run()` call, in seconds. Enforced by the
   *  backend's own exec timeout (mirrors `buildSandbox.ts`'s `timeoutMs`). */
  readonly maxRunSeconds: number;
  /** Byte cap applied independently to stdout and stderr per `run()` call. */
  readonly maxOutputBytes: number;
}

/**
 * The conservative default: no persistence, no egress, no process sessions,
 * short budget. A caller must OPT IN to anything riskier — the same
 * fail-closed posture the command policy and the #772 broker use.
 */
export const DEFAULT_AGENT_COMPUTER_PROFILE: AgentComputerProfile = Object.freeze({
  persistent: false,
  egress: false,
  processSessions: false,
  maxRunSeconds: 60,
  maxOutputBytes: 1_048_576,
});

/** Merge partial overrides onto the default profile. Never mutates its input. */
export function resolveAgentComputerProfile(
  overrides?: Partial<AgentComputerProfile>,
): AgentComputerProfile {
  return Object.freeze({ ...DEFAULT_AGENT_COMPUTER_PROFILE, ...overrides });
}
