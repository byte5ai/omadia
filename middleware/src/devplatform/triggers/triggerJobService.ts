/**
 * Epic #470 W4 — the trigger job-creation service (spec §3).
 *
 * This is the ONE choke point every non-interactive trigger source funnels
 * through: the webhook route now, the tracker poller and plugin triggers later.
 * Two invariants live here — deliberately in the SERVICE, not in any route — so a
 * future trigger source inherits them for free:
 *
 *   1. STRUCTURAL REFUSALS. A trigger job may never run on the `local` backend
 *      (it shares the middleware host) and never on a `device_flow` repo. A
 *      `webhook` job additionally REQUIRES `github_app` credentials — the webhook
 *      secret only exists in that mode, so any other credential kind is a
 *      contradiction. A violation returns `refused_policy` and NO job is created.
 *
 *   2. FIRST-SOURCE HUMAN GATE. "GitHub lets triage+ apply labels" is not an
 *      authorization decision omadia inherits: the FIRST job from a not-yet-seen
 *      (repo, sender) pair is parked at a human gate BEFORE any agent runs. The
 *      route detects the new pair (from the delivery ledger) and passes
 *      `requireGate`; the hold itself is expressed here.
 *
 * The injected store interfaces are intentionally MINIMAL subsets of the concrete
 * `DevJobStore` / `DevJobGateStore` — the service is decoupled from their full
 * (and still-evolving) shapes and is testable with plain fakes.
 */

import type { Pool } from 'pg';

import type {
  DevJob,
  DevJobKind,
  DevJobPhase,
  DevJobSource,
  DevJobStatus,
  DevRepo,
  RunnerBackendKind,
} from '../types.js';

/** Minimal `DevJobStore` surface the service needs. A gated job is born
 *  `status:'waiting', phase:'await_human'` in this single INSERT (fix #2), so the
 *  service no longer needs the advancePhase/parkForGate two-step. */
export interface TriggerJobStore {
  createJob(input: {
    repoId: string;
    kind: DevJobKind;
    brief: string;
    source: DevJobSource;
    sourceRef?: string | null;
    backend: RunnerBackendKind;
    createdBy: string;
    runnerTokenHash: string;
    phase?: DevJobPhase;
    status?: DevJobStatus;
  }): Promise<DevJob>;
}

/** Minimal `DevJobGateStore.open` input the service needs. The concrete store's
 *  `open` accepts a superset (plan artifact pinning etc.); a trigger gate needs
 *  none of that — it fires before any plan exists. `gateKind: 'review'` makes the
 *  standard gate-resolve route re-queue the job at `implement` on approval. */
export interface TriggerGateOpenInput {
  jobId: string;
  gateKind?: 'review';
  questions: Array<{ id: string; text: string }>;
  principalKind: 'user' | 'role';
  principalRef: string;
  baseSha?: string | null;
  deadlineIso?: string | null;
}
export interface TriggerGateStore {
  open(input: TriggerGateOpenInput): Promise<unknown>;
}

export interface TriggerJobServiceDeps {
  jobStore: TriggerJobStore;
  gateStore: TriggerGateStore;
  log?: (msg: string) => void;
}

export type TriggerJobDecision = 'created' | 'refused_policy' | 'deduped_active_job';

/** True iff a Postgres error is a unique-violation (SQLSTATE 23505). The partial
 *  unique index `dev_jobs_webhook_one_active` (0028) raises this when a concurrent
 *  delivery for the same issue tries to create a second active webhook job. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';
}

export interface CreateTriggerJobInput {
  repo: DevRepo;
  /** Backend the job will run on. Structurally refused if `'local'`. */
  backend: RunnerBackendKind;
  kind: DevJobKind;
  brief: string;
  sourceRef: string;
  source: DevJobSource;
  createdBy: string;
  runnerTokenHash: string;
  /** True for the FIRST job from a not-yet-seen (repo, sender) pair: the job is
   *  created, a human gate opened, and the job parked BEFORE any agent runs. */
  requireGate: boolean;
  /** For the gate question text only. */
  senderLogin?: string;
}

export interface CreateTriggerJobResult {
  decision: TriggerJobDecision;
  job?: DevJob;
  gated: boolean;
  reason?: string;
}

/**
 * Create a job for a trigger source, enforcing the structural refusals and the
 * first-source human gate. Returns `refused_policy` (no job) on a structural
 * violation, otherwise `created` with the job (and `gated: true` when it was held
 * at the first-source gate).
 */
export async function createTriggerJob(
  deps: TriggerJobServiceDeps,
  input: CreateTriggerJobInput,
): Promise<CreateTriggerJobResult> {
  const { repo } = input;

  // --- Structural refusals (spec §3) --------------------------------------
  if (input.backend === 'local') {
    return { decision: 'refused_policy', gated: false, reason: 'local backend not allowed for trigger jobs' };
  }
  if (repo.credentialKind === 'device_flow') {
    return { decision: 'refused_policy', gated: false, reason: 'device_flow credential not allowed for trigger jobs' };
  }
  if (input.source === 'webhook' && repo.credentialKind !== 'github_app') {
    return {
      decision: 'refused_policy',
      gated: false,
      reason: `webhook jobs require github_app credential (repo is '${repo.credentialKind}')`,
    };
  }

  // --- Create the job. pipeline_mode defaults to 'gated' in the DB (0023); a
  //     trigger job is NEVER collapsed (spec §3).
  //
  //     A gated job (fix #2) is born DIRECTLY at `status:'waiting',
  //     phase:'await_human'` in this ONE INSERT — never transiently `'queued'`, so
  //     `claimNextQueued` (which requires `status='queued'`) can never provision a
  //     runner for it in the window before the gate holds. The already-wired
  //     `/gates/:id/resolve` route still resumes it (approve →
  //     `requeueAtPhase('implement')`, which is fenced on `phase='await_human'`).
  //
  //     The INSERT races safely against a concurrent delivery for the SAME issue:
  //     the partial unique index `dev_jobs_webhook_one_active` (0028) lets exactly
  //     ONE win; the loser's 23505 becomes `deduped_active_job` (fix #3), the
  //     atomic backstop behind the route's cheap pre-check. --------------------
  let job: DevJob;
  try {
    job = await deps.jobStore.createJob({
      repoId: repo.id,
      kind: input.kind,
      brief: input.brief,
      source: input.source,
      sourceRef: input.sourceRef,
      backend: input.backend,
      createdBy: input.createdBy,
      runnerTokenHash: input.runnerTokenHash,
      phase: input.requireGate ? 'await_human' : undefined,
      status: input.requireGate ? 'waiting' : undefined,
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      deps.log?.(`[dev-platform] trigger job deduped (active job exists) for ${input.sourceRef}`);
      return { decision: 'deduped_active_job', gated: false };
    }
    throw err;
  }

  if (!input.requireGate) {
    return { decision: 'created', job, gated: false };
  }

  // --- First-source human gate --------------------------------------------
  // The job is ALREADY parked (`waiting` at `await_human`, no lease) from the
  // INSERT above; we only open the 'review' gate over it. Opening the gate LAST
  // is safe: the job is unclaimable the entire time, so there is no window in
  // which the agent could run before the gate exists.
  const principal = repo.approverRoleKey
    ? ({ kind: 'role', ref: repo.approverRoleKey } as const)
    : ({ kind: 'user', ref: repo.createdBy } as const);
  await deps.gateStore.open({
    jobId: job.id,
    gateKind: 'review',
    questions: [
      {
        id: 'approve-trigger-source',
        text:
          `First job from trigger source '${input.senderLogin ?? 'unknown'}' on ` +
          `${repo.owner}/${repo.name}. Approve before the agent runs.`,
      },
    ],
    principalKind: principal.kind,
    principalRef: principal.ref,
    baseSha: null,
    deadlineIso: repo.gateDeadlineIso,
  });
  deps.log?.(`[dev-platform] trigger job ${job.id} parked at first-source gate for ${repo.owner}/${repo.name}`);
  return { decision: 'created', job, gated: true };
}

/**
 * True iff a NON-terminal job already exists for this repo + `source_ref` from the
 * same trigger source — the label-remove/re-add spam guard (spec §3). Concrete DB
 * helper; the route injects it (and tests fake it).
 */
export async function hasActiveTriggerJob(
  pool: Pool,
  repoId: string,
  sourceRef: string,
  source: DevJobSource,
): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM dev_jobs
      WHERE repo_id = $1 AND source_ref = $2 AND source = $3
        AND status NOT IN ('done','failed','cancelled','stalled','budget_exceeded')
      LIMIT 1`,
    [repoId, sourceRef, source],
  );
  return (r.rowCount ?? 0) > 0;
}
