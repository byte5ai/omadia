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
  /** `dockerInJob` (W5, spec §8) OPTIONAL so W0/W2 payloads keep validating.
   *  Mirror of `middleware/src/devplatform/types.ts`. */
  capabilities: { installDeps: boolean; runTests: boolean; dockerInJob?: boolean };
  /**
   * W2 gated pipeline (spec §4). All three are OPTIONAL so the W0 collapsed
   * `/spec` payload keeps validating unchanged; the collapsed path
   * (`runShim`) ignores them entirely. THE SEAM: for a gated provision the
   * middleware `/spec` route must populate `phaseContext` (at minimum the
   * start `phase`) and, for a repo that needs it, `bootstrap`.
   */
  phaseContext?: PhaseContext;
  bootstrap?: BootstrapSpec;
}

// ---------------------------------------------------------------------------
// W2 — gated pipeline additions (spec §4).
//
// The runner runs each phase as a FRESH headless CLI session; the MIDDLEWARE,
// never the runner, decides transitions. These types mirror
// `middleware/src/devplatform/{types.ts,pipeline/{phaseEngine,phasePrompts,
// reviewLoop}.ts}` (the source of truth) — the same deliberate duplication as
// `RUNNER_PROTOCOL_VERSION`: this package must not import middleware code
// (untrusted-adjacent, a separate bundle), so the contract is restated here and
// kept honest by the protocol-version gate + tests.
// ---------------------------------------------------------------------------

/** Pipeline phases. Mirror of `DEV_JOB_PHASES`. */
export const DEV_JOB_PHASES = [
  'analyze',
  'bootstrap',
  'plan',
  'clarify',
  'await_human',
  'implement',
  'review',
  'pr',
] as const;
export type DevJobPhase = (typeof DEV_JOB_PHASES)[number];
export function isDevJobPhase(x: unknown): x is DevJobPhase {
  return typeof x === 'string' && (DEV_JOB_PHASES as readonly string[]).includes(x);
}

/** The phases that actually start a headless CLI session (spec §4 table). */
export const AGENT_SESSION_PHASES = ['analyze', 'plan', 'clarify', 'implement', 'review'] as const;
export type AgentSessionPhase = (typeof AGENT_SESSION_PHASES)[number];
export function isAgentSessionPhase(p: DevJobPhase): p is AgentSessionPhase {
  return (AGENT_SESSION_PHASES as readonly string[]).includes(p);
}

export type ReviewSeverity = 'blocker' | 'major' | 'minor';
/** Mirror of `pipeline/reviewLoop.ReviewFinding`. */
export interface ReviewFinding {
  severity: ReviewSeverity;
  file: string;
  line?: number;
  issue: string;
  suggestion?: string;
}
/** Mirror of `pipeline/reviewLoop.ReviewVerdict`. */
export interface ReviewVerdict {
  verdict: 'approve' | 'request_changes';
  summary: string;
  findings: ReviewFinding[];
}

/** A clarify question surfaced at the gate. Mirror of `gateStore.GateQuestion`. */
export interface GateQuestion {
  id: string;
  text: string;
}

/** An operator answer collected at the gate (mirror of `phasePrompts.OperatorAnswer`). */
export interface OperatorAnswer {
  questionId: string;
  text: string;
}

/**
 * Cross-provision inputs the runner cannot reproduce in-session, plus the phase
 * the runner begins at. Provision A builds every phase input from the brief +
 * the artifacts it just produced, so for it `phase` is all that is needed.
 * Provision B (implement/review) additionally needs the human-APPROVED `plan`
 * and the gate `answers` (produced in provision A, living server-side) — the
 * middleware packs those onto the `/spec` it serves the second provision.
 */
export interface PhaseContext {
  /** Phase the runner begins at (the job's current `dev_jobs.phase`). */
  phase: DevJobPhase;
  /** Provision B: the approved plan artifact content. */
  plan?: string;
  /** Provision B: operator answers collected at the gate. */
  answers?: OperatorAnswer[];
  /** review→implement retry: prior review findings, replayed to implement. */
  priorFindings?: ReviewFinding[];
  /** 0 on the first implement; incremented per review→implement retry round. */
  attempt?: number;
}

/**
 * Bootstrap (dependency install) is a COMMAND, not a CLI session (spec §4). The
 * middleware resolves it from `dev_repos.bootstrap_command` or the detected
 * default and hands it here; the runner executes it under its own timeout.
 */
export interface BootstrapSpec {
  command: string;
  /** Defaults to `DEV_BOOTSTRAP_TIMEOUT_MS` (600 s) when absent. */
  timeoutMs?: number;
}

/** The runner's `POST /jobs/:id/phase-result` body (spec §4). */
export interface PhaseResultBody {
  phase: DevJobPhase;
  ok: boolean;
  artifact?: { kind: string; content: string; meta?: Record<string, unknown> };
  /** clarify only — the questions to surface at the gate (may be empty). */
  questions?: GateQuestion[];
  /** review only — the raw verdict object (the engine validates it). */
  verdict?: unknown;
  headSha?: string;
  diffstat?: string;
  error?: string;
}

/**
 * The engine's reply to a phase result. Mirror of the SHIPPED
 * `PhaseEngine.PhaseDirective` (`pipeline/phaseEngine.ts`), which the route
 * serialises verbatim via `res.json(directive)`.
 *
 * NOTE — contract reconciliation: spec §4 prose sketches
 * `{ next: { phase, spec } }` (directive carries the next phase spec), but the
 * shipped engine returns `{ directive: 'next', phase }` and carries NO spec. The
 * shipped shape is authoritative, so the shim builds each phase session locally
 * from `phasePrompts` + the artifacts it holds. If the middleware later chooses
 * to carry the spec on the directive, drop the local prompt copy and read it
 * from here instead.
 */
export type PhaseDirective =
  | { directive: 'next'; phase: DevJobPhase }
  | { directive: 'park' }
  | { directive: 'done' }
  | { directive: 'failed'; reason: string };

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
  /**
   * W2 dispatch flag (`OMADIA_PIPELINE_MODE`). `'gated'` runs the phase loop
   * (`runPhasedShim`); anything else (default) runs the W0 collapsed
   * `runShim`. Read from the env — the backend that launches the container
   * knows the job's mode, and dispatching here avoids a second, side-effecting
   * `GET /spec` just to learn it. OPTIONAL so W0 callers that build `ShimEnv`
   * literally keep type-checking.
   */
  pipelineMode?: 'gated' | 'collapsed';
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
  const pipelineMode = env['OMADIA_PIPELINE_MODE']?.trim() === 'gated' ? 'gated' : 'collapsed';
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    jobId,
    jobToken,
    workspace,
    cliBin,
    llmEnvAllowed,
    pipelineMode,
  };
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key]?.trim();
  if (!v) throw new Error(`dev-runner-shim: missing required env ${key}`);
  return v;
}
