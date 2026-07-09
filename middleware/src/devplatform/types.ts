/**
 * Epic #470 W0 — dev platform shared types and runtime validators.
 *
 * Migration 0021 deliberately drops the CHECK constraints on
 * `dev_job_events.type` and `dev_job_artifacts.kind`: both enums grow every
 * wave (W1-W3), so a DB CHECK would be a liability. This module is therefore
 * the ONLY enforcement point for those unions — the runtime validators below
 * replace the dropped constraints. Each union is derived from a single `as
 * const` array so the type and its validator can never drift apart; a later
 * wave adds a value in exactly one place.
 *
 * Snake_case DB columns are mapped to camelCase here; timestamptz columns are
 * surfaced as ISO strings, jsonb as structured objects.
 */

/**
 * Phone-home wire-protocol version. Bumped whenever the runner <-> middleware
 * contract changes; the shim aborts loudly on a mismatch (spec §5). Baked into
 * both the shim bundle and every `DevJobSpec`.
 */
export const RUNNER_PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Enums — single-source-of-truth arrays + derived unions + runtime validators.
// ---------------------------------------------------------------------------

const isMember = <T extends string>(values: readonly T[], x: unknown): x is T =>
  typeof x === 'string' && (values as readonly string[]).includes(x);

/** Job lifecycle. Mirrors the `dev_jobs.status` CHECK in 0021. */
export const DEV_JOB_STATUSES = [
  'queued',
  'provisioning',
  'running',
  'waiting',
  'applying',
  'done',
  'failed',
  'cancelled',
  'stalled',
  'budget_exceeded',
] as const;
export type DevJobStatus = (typeof DEV_JOB_STATUSES)[number];
export function isDevJobStatus(x: unknown): x is DevJobStatus {
  return isMember(DEV_JOB_STATUSES, x);
}

/** Terminal statuses — no further transition is legal once reached. */
export const TERMINAL_DEV_JOB_STATUSES = [
  'done',
  'failed',
  'cancelled',
  'stalled',
  'budget_exceeded',
] as const satisfies readonly DevJobStatus[];
export function isTerminalDevJobStatus(x: unknown): x is DevJobStatus {
  return isMember(TERMINAL_DEV_JOB_STATUSES, x);
}

/**
 * Pipeline phase. W0 runs collapsed as `implement`; the full set ships now so
 * W2 needs no schema change. `dev_jobs.phase` is intentionally unconstrained in
 * the DB — this union is the enforcement point and it grows in W2.
 */
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
  return isMember(DEV_JOB_PHASES, x);
}

/** Job kind. Mirrors the `dev_jobs.kind` CHECK. `file_issues` was cut (phantom). */
export const DEV_JOB_KINDS = ['analyze', 'fix_issue', 'implement'] as const;
export type DevJobKind = (typeof DEV_JOB_KINDS)[number];
export function isDevJobKind(x: unknown): x is DevJobKind {
  return isMember(DEV_JOB_KINDS, x);
}

/** Where a job originated. Mirrors the `dev_jobs.source` CHECK. */
export const DEV_JOB_SOURCES = [
  'chat',
  'admin',
  'conductor',
  'webhook',
  'schedule',
  'tracker',
] as const;
export type DevJobSource = (typeof DEV_JOB_SOURCES)[number];
export function isDevJobSource(x: unknown): x is DevJobSource {
  return isMember(DEV_JOB_SOURCES, x);
}

/**
 * Event type. NOT constrained by the DB (0021) — validated here. Grows in
 * W1-W3, so a new value is added to this array alone.
 */
export const DEV_JOB_EVENT_TYPES = [
  'log',
  'tool',
  'status',
  'heartbeat',
  'egress',
  'token',
  'gate',
  'phase',
  'approval',
] as const;
export type DevJobEventType = (typeof DEV_JOB_EVENT_TYPES)[number];
export function isDevJobEventType(x: unknown): x is DevJobEventType {
  return isMember(DEV_JOB_EVENT_TYPES, x);
}

/** Auth mode. Mirrors the `dev_jobs.auth_mode` CHECK (spec §6b / Q4 decision). */
export const DEV_JOB_AUTH_MODES = ['api_key', 'subscription'] as const;
export type DevJobAuthMode = (typeof DEV_JOB_AUTH_MODES)[number];
export function isDevJobAuthMode(x: unknown): x is DevJobAuthMode {
  return isMember(DEV_JOB_AUTH_MODES, x);
}

/**
 * Artifact kind. NOT constrained by the DB (0021) — validated here. W0's known
 * set; W2/W3 add more (e.g. `test_report` gains meaning once tests execute).
 */
export const DEV_JOB_ARTIFACT_KINDS = [
  'diff',
  'test_report',
  'analysis',
  'plan',
  'summary',
] as const;
export type DevJobArtifactKind = (typeof DEV_JOB_ARTIFACT_KINDS)[number];
export function isDevJobArtifactKind(x: unknown): x is DevJobArtifactKind {
  return isMember(DEV_JOB_ARTIFACT_KINDS, x);
}

/** Runner backend. Mirrors the `dev_jobs.backend` CHECK. */
export const RUNNER_BACKEND_KINDS = ['local', 'docker', 'fly'] as const;
export type RunnerBackendKind = (typeof RUNNER_BACKEND_KINDS)[number];
export function isRunnerBackendKind(x: unknown): x is RunnerBackendKind {
  return isMember(RUNNER_BACKEND_KINDS, x);
}

/** Repo credential kind. Mirrors the `dev_repos.credential_kind` CHECK. */
export const DEV_REPO_CREDENTIAL_KINDS = [
  'github_app',
  'device_flow',
  'pat',
  'deploy_key',
] as const;
export type DevRepoCredentialKind = (typeof DEV_REPO_CREDENTIAL_KINDS)[number];
export function isDevRepoCredentialKind(x: unknown): x is DevRepoCredentialKind {
  return isMember(DEV_REPO_CREDENTIAL_KINDS, x);
}

// ---------------------------------------------------------------------------
// Runner seam — the phone-home contract and backend interface (spec §4).
// ---------------------------------------------------------------------------

/**
 * What the runner fetches with its job token. Carries NO credential: the clone
 * token is fetched separately, read-only, at git time (spec §4, GET /scm-token).
 * The absence of a credential field here is a regression-tested guarantee.
 */
export interface DevJobSpec {
  protocol: typeof RUNNER_PROTOCOL_VERSION;
  jobId: string;
  /** Seed for the shim's event `seq` namespace; a gated job runs many provisions. */
  provision: number;
  kind: DevJobKind;
  /** Composed prompt including the untrusted ticket block (spec §7). */
  brief: string;
  /** Pinned tree — no credential rides here. */
  repo: { cloneUrl: string; defaultBranch: string; baseSha: string };
  /** `omadia/job-<id8>-<slug>`, precomputed host-side. */
  branch: string;
  agent: { kind: 'claude-cli'; model?: string; maxTurns?: number };
  limits: { wallClockMs: number };
  /** Both false on the jailed local backend (no install, no test execution). */
  capabilities: { installDeps: boolean; runTests: boolean };
}

/** A live (or recently live) runner instance, persisted to `dev_jobs.runner_handle`. */
export interface RunnerHandle {
  backend: RunnerBackendKind;
  id: string;
  /** Local backend only. */
  pid?: number;
  startedAt: string;
}

/** provision() gets pointers, not secrets: the runner pulls the spec itself. */
export interface DevJobProvisionInput {
  jobId: string;
  jobToken: string;
  baseUrl: string;
}

/** The backend seam. Same shape for local, docker (W1), and fly (W4). */
export interface RunnerBackend {
  readonly kind: RunnerBackendKind;
  provision(input: DevJobProvisionInput): Promise<RunnerHandle>;
  terminate(handle: RunnerHandle): Promise<void>;
  reap(): Promise<RunnerHandle[]>;
}

// ---------------------------------------------------------------------------
// Result reported by the runner / recorded by the worker (spec §4 POST /result).
// ---------------------------------------------------------------------------

export type DevJobOutcome = 'diff_ready' | 'no_changes' | 'failed';

/** Self-declared usage. `estimated` is true for subscription jobs (spec §6b). */
export interface DevJobUsage {
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  estimated?: boolean;
}

export interface DevJobResult {
  outcome: DevJobOutcome;
  /** Artifact id of the uploaded `diff`, present when `outcome === 'diff_ready'`. */
  diffArtifactId?: string;
  summary?: string;
  error?: string;
  usage?: DevJobUsage;
}

// ---------------------------------------------------------------------------
// Persisted rows (camelCase views of the 0021 tables).
// ---------------------------------------------------------------------------

/** A registered repository (`dev_repos`). Secrets live in Vault, never here. */
export interface DevRepo {
  id: string;
  forgeKind: string;
  owner: string;
  name: string;
  cloneUrl: string;
  defaultBranch: string;
  credentialKind: DevRepoCredentialKind;
  /** Vault key prefix, e.g. `repo/<id>`. */
  credentialRef: string;
  trackerKind: string | null;
  trackerConfig: Record<string, unknown>;
  allowedTriggers: string[];
  /** Empty = `createdBy` only (spec §6 launch authorization). */
  allowedLaunchers: string[];
  egressAllowlist: string[];
  runsTests: boolean;
  /** Tri-state: true/false/null — null means "could not verify" (spec §6). */
  branchProtectionOk: boolean | null;
  branchProtectionCheckedAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** A job (`dev_jobs`). */
export interface DevJob {
  id: string;
  repoId: string;
  kind: DevJobKind;
  brief: string;
  source: DevJobSource;
  sourceRef: string | null;
  /** Pinned at job start; W2 re-clones this exact tree. */
  baseSha: string | null;
  backend: RunnerBackendKind;
  agentKind: string;
  authMode: DevJobAuthMode;
  provision: number;
  phase: DevJobPhase;
  status: DevJobStatus;
  /** Lease token — a UUID (`randomUUID()`); every worker write is fenced on it. */
  claimedBy: string | null;
  claimedAt: string | null;
  lastHeartbeatAt: string | null;
  runnerHandle: RunnerHandle | null;
  /** sha256 hex of the one-time runner token; plaintext is never stored. */
  runnerTokenHash: string | null;
  branch: string | null;
  prUrl: string | null;
  result: DevJobResult | null;
  error: string | null;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  createdBy: string;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  updatedAt: string;
}

/** A stored event (`dev_job_events`). `id` is the sole ordering key. */
export interface DevJobEvent {
  /** IDENTITY column — SSE `id:` and `Last-Event-ID` use this, never `seq`. */
  id: number;
  jobId: string;
  /** Which runner session emitted this. */
  provision: number;
  /** Runner-assigned, monotonic WITHIN a provision. */
  seq: number;
  type: DevJobEventType;
  ts: string;
  payload: Record<string, unknown>;
}

/** A stored artifact (`dev_job_artifacts`). */
export interface DevJobArtifact {
  id: string;
  jobId: string;
  kind: DevJobArtifactKind;
  content: string;
  meta: Record<string, unknown>;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Insert inputs (what a caller supplies; generated columns are omitted).
// ---------------------------------------------------------------------------

/** Input to `DevJobStore.createRepo`. Generated ids/timestamps are omitted. */
export interface NewDevRepo {
  forgeKind?: string;
  owner: string;
  name: string;
  cloneUrl: string;
  defaultBranch?: string;
  credentialKind: DevRepoCredentialKind;
  credentialRef: string;
  trackerKind?: string | null;
  trackerConfig?: Record<string, unknown>;
  allowedTriggers?: string[];
  allowedLaunchers?: string[];
  egressAllowlist?: string[];
  runsTests?: boolean;
  createdBy: string;
}

/**
 * Input to `DevJobStore.createJob` (combined with `{ runnerTokenHash }` by the
 * store). Lifecycle columns (status, claim, heartbeat, result, usage) are set
 * by the store and worker, never by the caller.
 */
export interface NewDevJob {
  repoId: string;
  kind: DevJobKind;
  brief: string;
  source: DevJobSource;
  sourceRef?: string | null;
  baseSha?: string | null;
  backend: RunnerBackendKind;
  agentKind?: string;
  authMode?: DevJobAuthMode;
  provision?: number;
  phase?: DevJobPhase;
  branch?: string | null;
  createdBy: string;
}
