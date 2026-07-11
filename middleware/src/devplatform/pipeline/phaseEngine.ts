import type { DevJob, DevJobPhase } from '../types.js';
import { computeTransition, type PhaseResult as RawPhaseResult } from './transitions.js';
import { decideReview, parseReviewVerdict, type ReviewVerdict } from './reviewLoop.js';
import type { DevJobGateStore, GateQuestion } from './gateStore.js';

/**
 * Epic #470 W2 — the phase engine (spec §4). The STATEFUL orchestrator that ties
 * the pure transition table, the review loop, the gate store, and token
 * revocation to persistence, and answers the runner's `POST /phase-result` with a
 * directive.
 *
 * The middleware, never the runner, decides transitions. The runner reports what
 * it did; this validates the report against the job's current phase (a stale
 * runner is rejected), persists the artifact, computes the outcome, applies it in
 * the store, and returns the directive that tells the runner to continue, park,
 * or exit.
 */

/** The runner's POST body for the phase it just ran. */
export interface PhaseResultInput {
  phase: DevJobPhase;
  ok: boolean;
  /** Any phase may attach an artifact (analysis, plan, bootstrap_report, diff…). */
  artifact?: { kind: string; content: string; meta?: Record<string, unknown> };
  /** clarify: the questions to surface at the gate (may be empty). */
  questions?: GateQuestion[];
  /** review: the raw verdict object (validated here). */
  verdict?: unknown;
  headSha?: string;
  error?: string;
}

/** What the engine tells the runner to do next. */
export type PhaseDirective =
  | { directive: 'next'; phase: DevJobPhase }
  | { directive: 'park' }
  | { directive: 'done' }
  | { directive: 'failed'; reason: string };

/** Thrown when a runner reports a phase the job already moved past → 409. */
export class StalePhaseError extends Error {
  constructor(
    readonly jobId: string,
    readonly reported: DevJobPhase,
    readonly current: DevJobPhase,
  ) {
    super(`stale phase result for ${jobId}: reported '${reported}', job is at '${current}'`);
    this.name = 'StalePhaseError';
  }
}

/** A persisted artifact, narrowed to what the gate pins. */
export interface StoredArtifact {
  id: string;
  meta: Record<string, unknown>;
}

/** The store surface the engine needs (real DevJobStore satisfies it). */
export interface PhaseEngineStore {
  addArtifact(jobId: string, kind: string, content: string, meta?: Record<string, unknown>): Promise<string>;
  /** The latest artifact of a kind — the gate pins the persisted `plan`, not the
   *  transient clarify input (which carries none). */
  getLatestArtifact(jobId: string, kind: string): Promise<StoredArtifact | null>;
  advancePhase(jobId: string, from: DevJobPhase, to: DevJobPhase): Promise<boolean>;
  parkForGate(jobId: string): Promise<boolean>;
  setReviewState(jobId: string, attempt: number, fingerprint: string | null): Promise<void>;
}

/** Who may resolve a job's plan gate. */
export interface GatePrincipal {
  kind: 'user' | 'role';
  ref: string;
}

export interface PhaseEngineDeps {
  store: PhaseEngineStore;
  gates: DevJobGateStore;
  /** Terminate the job through the single choke point (revokes tokens). */
  finalize: (jobId: string, status: 'done' | 'failed' | 'cancelled', reason?: string) => Promise<void>;
  /** Revoke a parked job's tokens WITHOUT finalizing it (it stays `waiting`). */
  revokeTokensForPark: (job: DevJob) => Promise<void>;
  /**
   * The gate principal for a job — ('role', repo.approver_role_key) or
   * ('user', created_by). May resolve asynchronously: the real wiring reads the
   * repo row to decide, and the engine only calls this on the (rare) park, which
   * is already an async path. Sync doubles (tests) remain valid.
   */
  gatePrincipal: (job: DevJob) => GatePrincipal | Promise<GatePrincipal>;
  /** The repo's ISO gate deadline; undefined ⇒ store default. May be async (see
   *  `gatePrincipal`). */
  gateDeadlineIso?: (job: DevJob) => string | undefined | Promise<string | undefined>;
  log?: (msg: string) => void;
}

export class PhaseEngine {
  constructor(private readonly deps: PhaseEngineDeps) {}

  /**
   * Handle one phase result. Returns the directive; mutates job state in the
   * store. Throws StalePhaseError (→409) for a phase the job already left.
   */
  async handlePhaseResult(job: DevJob, input: PhaseResultInput): Promise<PhaseDirective> {
    // 1. A stale runner reports a phase the job already advanced past. Discard it.
    if (input.phase !== job.phase) {
      throw new StalePhaseError(job.id, input.phase, job.phase);
    }

    // 2. Persist the artifact BEFORE the transition — the plan the gate references,
    //    the diff the pr applies, must exist when the next step reads them.
    if (input.artifact) {
      await this.deps.store.addArtifact(
        job.id,
        input.artifact.kind,
        input.artifact.content,
        input.artifact.meta ?? {},
      );
    }

    // 3. review has a loop decision that shapes the transition input.
    let reviewVerdict: ReviewVerdict | undefined;
    let reviewExhausted = false;
    if (input.phase === 'review' && input.ok) {
      const parsed = parseReviewVerdict(input.verdict);
      if (!parsed) {
        // The caller re-prompts once before we get here; a second malformed
        // verdict is a protocol failure.
        await this.deps.finalize(job.id, 'failed', 'review produced a malformed verdict');
        return { directive: 'failed', reason: 'malformed review verdict' };
      }
      const decision = decideReview({
        verdict: parsed,
        attempt: job.reviewAttempt,
        previousFingerprint: job.reviewFingerprint,
      });
      reviewVerdict = parsed.verdict === 'request_changes' && decision.action === 'approve'
        ? { ...parsed, verdict: 'approve' } // minor-only coerced
        : parsed;
      if (decision.action === 'retry') {
        await this.deps.store.setReviewState(job.id, decision.nextAttempt, decision.fingerprint);
        reviewVerdict = { ...parsed, verdict: 'request_changes' };
        reviewExhausted = false;
      } else if (decision.action === 'give_up') {
        await this.deps.store.setReviewState(job.id, job.reviewAttempt, decision.fingerprint);
        reviewVerdict = { ...parsed, verdict: 'request_changes' };
        reviewExhausted = true;
      } else {
        reviewVerdict = { ...parsed, verdict: 'approve' };
      }
    }

    // 4. Compute the transition from the pure table.
    const raw: RawPhaseResult = {
      phase: input.phase,
      ok: input.ok,
      ...(input.questions ? { hasQuestions: input.questions.length > 0 } : {}),
      ...(reviewVerdict ? { reviewVerdict: reviewVerdict.verdict } : {}),
      reviewLoopExhausted: reviewExhausted,
    };
    const t = computeTransition(raw, { mode: job.pipelineMode, kind: job.kind });

    // 5. Apply it.
    switch (t.kind) {
      case 'fail':
        await this.deps.finalize(job.id, 'failed', input.error ?? t.reason);
        return { directive: 'failed', reason: input.error ?? t.reason };

      case 'done':
        await this.deps.finalize(job.id, 'done');
        return { directive: 'done' };

      case 'retry_implement': {
        // Same provision — the runner loops back to implement itself. Move the
        // phase pointer back so the next phase-result is validated correctly.
        const ok = await this.deps.store.advancePhase(job.id, 'review', 'implement');
        if (!ok) throw new StalePhaseError(job.id, input.phase, job.phase);
        return { directive: 'next', phase: 'implement' };
      }

      case 'advance': {
        const ok = await this.deps.store.advancePhase(job.id, input.phase, t.to);
        if (!ok) throw new StalePhaseError(job.id, input.phase, job.phase);
        return { directive: 'next', phase: t.to };
      }

      case 'park': {
        // clarify → await_human: advance the pointer, open the gate, park the job,
        // revoke the runner's token (it is exiting), tell the runner to exit.
        const advanced = await this.deps.store.advancePhase(job.id, 'clarify', 'await_human');
        if (!advanced) throw new StalePhaseError(job.id, input.phase, job.phase);
        const principal = await this.deps.gatePrincipal(job);
        // Pin the PERSISTED plan (delivered a phase earlier), not the transient
        // clarify input — otherwise the gate stores nothing and a resume could
        // implement against a plan the human never approved (Forge #1). `planSha256`
        // is stored in the plan artifact's meta by the plan phase.
        const planArtifact = await this.deps.store.getLatestArtifact(job.id, 'plan');
        await this.deps.gates.open({
          jobId: job.id,
          planArtifactId: planArtifact?.id ?? null,
          planSha256: (planArtifact?.meta?.['planSha256'] as string | undefined) ?? null,
          baseSha: job.baseSha,
          questions: input.questions ?? [],
          principalKind: principal.kind,
          principalRef: principal.ref,
          deadlineIso: await this.deps.gateDeadlineIso?.(job),
        });
        await this.deps.store.parkForGate(job.id);
        await this.deps.revokeTokensForPark(job);
        return { directive: 'park' };
      }

      case 'requeue':
        // await_human resolution is driven by the gate route, not a phase-result.
        // Reaching here from a runner is a protocol violation.
        await this.deps.finalize(job.id, 'failed', 'unexpected requeue from a runner result');
        return { directive: 'failed', reason: 'unexpected requeue' };
    }
  }
}
