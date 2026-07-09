/**
 * Epic #470 W0 — runner shim wire protocol (spec §4/§5).
 *
 * This package runs OUTSIDE the middleware process (a W0 spawned child, a W1
 * image entrypoint) over untrusted repo content, so it MUST NOT import
 * middleware code. The contract below is therefore duplicated deliberately:
 * `RUNNER_PROTOCOL_VERSION` is baked into the shim bundle, and the shim aborts
 * loudly if a fetched `DevJobSpec.protocol` disagrees (spec §5 step 1). The
 * source of truth is `middleware/src/devplatform/types.ts`; a change there that
 * is not mirrored here is exactly the skew the version check is built to catch.
 *
 * Node builtins only — no dependency may enter this module.
 */

/** Bumped whenever the phone-home contract changes. Mirror of the middleware
 *  constant; a mismatch fails the job with both versions named. */
export const RUNNER_PROTOCOL_VERSION = 1;

/** The prefix every phone-home route hangs off (spec §4). Never renamed. */
export const RUNNER_API_PREFIX = '/api/v1/dev-runner';

export type RunnerEventType =
  | 'log'
  | 'tool'
  | 'status'
  | 'heartbeat'
  | 'egress'
  | 'token'
  | 'gate'
  | 'phase'
  | 'approval';

/**
 * The spec the runner fetches with its job token. Carries NO credential — the
 * clone token is fetched separately, read-only, at git time (GET /scm-token).
 */
export interface DevJobSpec {
  protocol: number;
  jobId: string;
  provision: number;
  kind: 'analyze' | 'fix_issue' | 'implement';
  brief: string;
  repo: { cloneUrl: string; defaultBranch: string; baseSha: string };
  branch: string;
  agent: { kind: 'claude-cli'; model?: string; maxTurns?: number };
  limits: { wallClockMs: number };
  capabilities: { installDeps: boolean; runTests: boolean };
}

/** An event before the home client stamps its `seq`. */
export interface RunnerEvent {
  type: RunnerEventType;
  ts: string;
  payload: Record<string, unknown>;
}

/** An event with its per-provision monotonic `seq` (assigned at flush). */
export interface SeqRunnerEvent extends RunnerEvent {
  seq: number;
}

export type RunnerOutcome = 'diff_ready' | 'no_changes' | 'failed';

export interface RunnerUsage {
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  estimated?: boolean;
}

export interface RunnerResult {
  outcome: RunnerOutcome;
  diffArtifactId?: string;
  summary?: string;
  error?: string;
  usage?: RunnerUsage;
}

/** Inputs the backend hands the shim through the environment (spec §5). */
export interface ShimEnv {
  baseUrl: string;
  jobId: string;
  jobToken: string;
  workspace: string;
  cliBin: string;
  /**
   * W0 LLM-auth passthrough acknowledgment. `true` ONLY when the backend sets
   * `OMADIA_LLM_ENV_ALLOWED=true`, which the jailed LocalProcessBackend does
   * exclusively when it was itself launched with the W0 jail acknowledgment
   * (`DEV_PLATFORM_UNSAFE_LOCAL=true`). Without it the shim NEVER forwards
   * `OMADIA_ANTHROPIC_*` (a long-lived middleware/proxy secret) into the child
   * CLI env. W1's per-job, short-lived LLM-proxy tokens replace this
   * passthrough entirely — the flag exists only to keep the W0 walking
   * skeleton honest about handing a middleware secret to untrusted-adjacent
   * code.
   */
  llmEnvAllowed: boolean;
}

/**
 * Read and validate the shim inputs from `process.env`. Throws a plain Error
 * naming the missing variable — the backend sets all five, so a gap is a
 * wiring bug, not runtime input.
 */
export function readShimEnv(env: NodeJS.ProcessEnv = process.env): ShimEnv {
  const baseUrl = required(env, 'OMADIA_JOB_BASE_URL');
  const jobId = required(env, 'OMADIA_JOB_ID');
  const jobToken = required(env, 'OMADIA_JOB_TOKEN');
  const workspace = required(env, 'OMADIA_WORKSPACE');
  const cliBin = env['OMADIA_CLI_BIN']?.trim() || 'claude';
  const llmEnvAllowed = env['OMADIA_LLM_ENV_ALLOWED']?.trim() === 'true';
  return { baseUrl: baseUrl.replace(/\/+$/, ''), jobId, jobToken, workspace, cliBin, llmEnvAllowed };
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key]?.trim();
  if (!v) throw new Error(`dev-runner-shim: missing required env ${key}`);
  return v;
}
