import { randomUUID } from 'node:crypto';

import { nextStep, parseIsoDurationMs } from '@omadia/conductor-core';
import type { JsonObject, JsonValue, Step, WorkflowGraph } from '@omadia/conductor-core';

import type { ConductorWorkflowStore } from './workflowStore.js';
import type { ConductorRun, ConductorRunStore, TriggerKind } from './runStore.js';
import { RunLeaseLostError } from './runStore.js';
import type { ConductorAwaitStore } from './awaitStore.js';
import type { StepEffects } from './stepEffects.js';
import { canonicalizePrincipalId } from './principalId.js';
import { appendTranscript } from './transcript.js';
import type { RoleHolderResolver } from './roleHolderResolver.js';
import type { AggregateHolderLookup } from '@omadia/channel-sdk';

export class WorkflowNotFoundError extends Error {}
export class WorkflowDisabledError extends Error {}
export class WorkflowNotPublishedError extends Error {}
export class AwaitNotPendingError extends Error {}
/** A responder who is not a current holder tried to resolve an await (authorization gate). */
export class AwaitResponderNotHolderError extends Error {}
/** #759 — cancel asked for a run that is already terminal (surfaced as 409). */
export class RunAlreadyEndedError extends Error {}

export interface PreviewStep {
  stepId: string;
  kind: 'agent' | 'action' | 'human' | 'timer';
  actor: string;
  postcondition: string;
  transition: string | null;
  result: JsonValue;
}

export interface PreviewResult {
  status: 'completed' | 'failed';
  steps: PreviewStep[];
  context: JsonObject;
}

const MAX_STEPS = 1000;

function asObject(v: JsonValue | undefined): JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? v : {};
}

/**
 * A human response counts as approval unless it is explicitly `{ approved: false }` (the reject
 * button's payload). Fail-open by default: an absent/garbage/missing flag counts as approval, and
 * only a strict boolean `false` is a reject (the inbox sends a typed boolean). A guard step's
 * postcondition can still inspect the raw `responses` map for finer policy.
 *
 * #759 — with `strict` (the step's `human.strictApproval` flag) the polarity inverts: only an
 * explicit `{ approved: true }` approves, everything else — absent field, null, garbage — is a
 * rejection. For steps that gate irreversible actions.
 */
function isApproved(response: JsonValue, strict = false): boolean {
  const obj =
    typeof response === 'object' && response !== null && !Array.isArray(response)
      ? (response as JsonObject)
      : undefined;
  if (strict) return obj?.approved === true;
  return obj?.approved !== false;
}

// #330 C3 (review L1) — ONE ISO-8601 duration parser for validate-time and
// runtime (lives in conductor-core); re-exported so existing imports keep working.
export { parseIsoDurationMs } from '@omadia/conductor-core';

/**
 * Owns run advancement: the engine (`@omadia/conductor-core`) decides the path; this executor
 * performs per-step I/O (via StepEffects) and persists each step + accumulated context before
 * advancing (FR-004). A human step opens a durable await and parks the run as `waiting`; when a
 * human responds (resolveAwait) or the deadline passes (expireAwait) the run resumes.
 */
export class ConductorRunExecutor {
  private readonly workflowStore: ConductorWorkflowStore;
  private readonly runStore: ConductorRunStore;
  private readonly awaitStore: ConductorAwaitStore;
  private readonly effects: StepEffects;
  /** Late-bound role→holders resolver — the required responders for a quorum='all' role await.
   *  Required (not optional) so a role-based 'all' can never silently degrade to 'any' when unwired.
   *
   *  #333 phase 3 — returns an `AggregateHolderLookup`, not a bare list, because both decisions
   *  this executor makes from it fail OPEN on a shrunken list: a quorum='all' would complete with
   *  too few approvals, and `openHumanAwait` would mistake "we could not ask" for "nobody holds
   *  this role" and take the fallback, skipping the human step entirely. The type forces both
   *  sites to see `partial`. */
  private readonly resolveRoleHolders: RoleHolderResolver;
  /** Issue #437 — fired once a REAL (non-dry-run) run reaches a terminal status
   *  ('completed'/'failed', and since #759 'cancelled'). Feeds the outbound webhook
   *  dispatcher; best-effort and never awaited inline — a slow/broken subscriber must
   *  not stall run driving. In the narrow expire-vs-cancel race the notification can
   *  fire twice for one run; subscribers must treat run-ended as at-least-once. */
  private readonly notifyRunEnded?: (run: ConductorRun) => void;
  private readonly log: (msg: string) => void;

  constructor(deps: {
    workflowStore: ConductorWorkflowStore;
    runStore: ConductorRunStore;
    awaitStore: ConductorAwaitStore;
    effects: StepEffects;
    resolveRoleHolders: RoleHolderResolver;
    notifyRunEnded?: (run: ConductorRun) => void;
    log?: (msg: string) => void;
  }) {
    this.workflowStore = deps.workflowStore;
    this.runStore = deps.runStore;
    this.awaitStore = deps.awaitStore;
    this.effects = deps.effects;
    this.resolveRoleHolders = deps.resolveRoleHolders;
    this.notifyRunEnded = deps.notifyRunEnded;
    this.log = deps.log ?? (() => undefined);
  }

  async startRun(input: {
    slug: string;
    payload: JsonObject;
    triggerKind?: TriggerKind;
    triggerSource?: JsonValue | null;
    isDryRun?: boolean;
    awaitCompletion?: boolean;
  }): Promise<ConductorRun> {
    const wf = await this.workflowStore.getBySlug(input.slug);
    if (!wf) throw new WorkflowNotFoundError(`workflow '${input.slug}' not found`);
    if (wf.status === 'disabled') {
      this.log(`[conductor] suppressed trigger for disabled workflow '${input.slug}'`);
      throw new WorkflowDisabledError(`workflow '${input.slug}' is disabled`);
    }
    if (!wf.activeVersionId) throw new WorkflowNotPublishedError(`workflow '${input.slug}' has no active version`);
    const version = await this.workflowStore.getVersion(wf.activeVersionId);
    if (!version) throw new WorkflowNotPublishedError(`active version of '${input.slug}' missing`);

    const lease = randomUUID();
    const run = await this.runStore.create({
      workflowVersionId: version.id,
      entryStepId: version.graph.entryStepId,
      context: input.payload,
      triggerKind: input.triggerKind ?? 'manual',
      triggerSource: input.triggerSource ?? null,
      isDryRun: input.isDryRun ?? false,
      claimedBy: lease,
    });

    if (input.awaitCompletion) {
      return this.driveFrom(run.id, version.graph, version.graph.entryStepId, input.payload, lease);
    }
    const graph = version.graph;
    void this.driveFrom(run.id, graph, graph.entryStepId, input.payload, lease).catch((err) => {
      this.log(`[conductor] run ${run.id} drive crashed: ${err instanceof Error ? err.message : String(err)}`);
    });
    return run;
  }

  /**
   * The run's trigger, in the shape effects consume.
   *
   * Tolerant on purpose: a run that cannot be read back yields an EMPTY meta,
   * which effects treat as "not channel-triggered" — the same answer a manual
   * run gives. That is the safe direction here because the origin rule refuses
   * on a channel trigger it cannot attribute; an unreadable run must not be
   * turned into a channel trigger by accident.
   */
  private async triggerMetaFor(
    runId: string,
  ): Promise<{ triggerKind?: TriggerKind; triggerEventId?: string; workflowId?: string | null }> {
    const run = await this.runStore.get(runId);
    if (!run) return {};
    const source = run.triggerSource;
    const eventId =
      typeof source === 'object' && source !== null && !Array.isArray(source)
        ? (source as Record<string, unknown>)['eventId']
        : undefined;
    // The workflow behind the run's version — a `say` step's floor is checked
    // against it. Same tolerance as above: an unreadable version yields null,
    // and the say service then finds no matching attachment and stays silent
    // rather than posting on an unproven authority.
    // A dry run rehearses; it must not speak into a live conversation. Leaving
    // the workflow id off is how that is enforced — the say service refuses a
    // turn that belongs to no workflow.
    const workflowId = run.isDryRun
      ? null
      : await this.workflowStore
          .getVersion(run.workflowVersionId)
          .then((v) => v?.workflowId ?? null)
          .catch(() => null);
    return {
      ...(run.triggerKind ? { triggerKind: run.triggerKind } : {}),
      ...(typeof eventId === 'string' && eventId !== ''
        ? { triggerEventId: eventId }
        : {}),
      workflowId,
    };
  }

  /**
   * Drive a run forward from `startStepId`. Human steps open an await and park. Every step/park
   * write is fenced on `lease` (the driver's claimed_by token): if a resume worker has taken the
   * run over (because this drive stalled past staleMs), the next write throws RunLeaseLostError and
   * this superseded driver stops — the new owner is now driving, so the run is never double-driven.
   */
  private async driveFrom(
    runId: string,
    graph: WorkflowGraph,
    startStepId: string,
    startContext: JsonObject,
    lease: string,
  ): Promise<ConductorRun> {
    let context: JsonObject = { ...startContext };
    let currentStepId: string | null = startStepId;
    let seq = (await this.runStore.stepsForRun(runId)).length;
    // How this run began, read ONCE here rather than threaded through the five
    // `driveFrom` callers — three of them are resume paths that already hold
    // the run, and a sixth parameter on a private method is a worse seam than
    // one read per drive (an agent step costs an LLM turn; this costs a row).
    //
    // Effects need it to tell a run started by a message to a bot from one a
    // human or a schedule started: only the first has an addressed identity
    // whose permissions the work must stay inside.
    const triggerMeta = await this.triggerMetaFor(runId);

    try {
      while (currentStepId && seq < MAX_STEPS) {
        const stepId: string = currentStepId;
        // #759 — honour a pending operator cancel at the step boundary. A
        // mid-step kill is deliberately not attempted: the at-least-once
        // effect window stays bounded to one step, exactly like crash
        // recovery. The synthetic step row is fenced on the lease, so a
        // superseded driver cannot also record the cancellation.
        if (await this.runStore.isCancelRequested(runId)) {
          await this.runStore.recordStepAndAdvance({
            runId, seq, stepId, actor: { kind: 'operator_cancel' },
            postconditionOutcome: 'n/a', transitionTaken: null, nextStepId: null,
            context, status: 'cancelled', claimedBy: lease,
          });
          this.log(`[conductor] run ${runId} cancelled at step boundary '${stepId}'`);
          break;
        }
        const step = graph.steps.find((s) => s.id === stepId);
        if (!step) {
          await this.runStore.recordStepAndAdvance({
            runId, seq, stepId, actor: null, postconditionOutcome: 'n/a', transitionTaken: null,
            nextStepId: null, context, status: 'failed', claimedBy: lease,
          });
          break;
        }

        // #330 C3 — deterministic per-step attempt counter. Bumped BEFORE the
        // step runs so a transition guard like `lt ctx.stepAttempts.moderate 24`
        // bounds assess/nudge loops without trusting the model to count.
        context = this.bumpStepAttempt(context, stepId);

        // #330 C3 — timer step: deterministic park. The awaitWorker's deadline
        // poll fires expireAwait, which follows the step's fallback (the
        // on-expiry edge) — the same machinery human deadlines already use.
        if (step.kind === 'timer') {
          const durationMs = parseIsoDurationMs(step.timer?.duration ?? null);
          if (!durationMs || !step.fallbackTransitionId) {
            // validate() catches this at publish time; a runtime miss must
            // fail loudly rather than park a run nothing can ever wake.
            await this.runStore.recordStepAndAdvance({
              runId, seq, stepId, actor: { kind: 'timer', invalid: true },
              postconditionOutcome: 'n/a', transitionTaken: null, nextStepId: null,
              context, status: 'failed', claimedBy: lease,
            });
            break;
          }
          await this.awaitStore.create({
            runId,
            stepId: step.id,
            principalKind: 'timer',
            principalRef: 'timer',
            channelType: 'timer',
            message: `timer ${step.timer?.duration ?? ''}`,
            quorum: 'any',
            reminderIntervalMs: null,
            deadlineAt: new Date(Date.now() + durationMs),
            fallbackTransitionId: step.fallbackTransitionId,
          });
          await this.runStore.park(runId, step.id, context, lease);
          // Same cancel-vs-park race close as the human park (#759).
          if (await this.runStore.isCancelRequested(runId)) {
            return this.finalizeCancelledWaitingRun(runId, lease);
          }
          this.log(`[conductor] run ${runId} parked on timer '${step.id}' (${step.timer?.duration ?? '?'})`);
          return (await this.runStore.get(runId)) ?? (await this.requireRun(runId));
        }

        // Human step → durable await + park; resolveAwait/expireAwait resume the run.
        if (step.kind === 'human') {
          const parked = await this.openHumanAwait(runId, step, context, lease);
          if (parked) {
            // #759 — close the cancel-vs-park race: a cancel landing between
            // the loop-head check and this park would otherwise strand a
            // 'waiting' run with the flag set — reminders keep pinging and
            // nothing sweeps it. Re-check after the park (we still own the
            // lease) and finalize exactly like the waiting-path cancel.
            if (await this.runStore.isCancelRequested(runId)) {
              return this.finalizeCancelledWaitingRun(runId, lease);
            }
            return (await this.runStore.get(runId)) ?? (await this.requireRun(runId));
          }
          // No reachable holder → don't hang. Take the step's in-graph fallback (FR-024), else fail.
          const fb = step.fallbackTransitionId ? graph.transitions.find((tr) => tr.id === step.fallbackTransitionId) : undefined;
          await this.runStore.recordStepAndAdvance({
            runId, seq, stepId, actor: { kind: 'human', noHolder: true },
            postconditionOutcome: 'unmet', transitionTaken: fb?.id ?? null, nextStepId: fb?.target ?? null,
            context, status: fb ? 'running' : 'failed', claimedBy: lease,
          });
          if (!fb) break;
          currentStepId = fb.target;
          seq += 1;
          continue;
        }

        let exec;
        try {
          exec = step.kind === 'agent'
            ? await this.effects.runAgentStep(step, context, { runId, ...triggerMeta })
            : await this.effects.runActionStep(step, context, { runId, ...triggerMeta });
        } catch (err) {
          this.log(`[conductor] run ${runId} step '${stepId}' threw: ${err instanceof Error ? err.message : String(err)}`);
          await this.runStore.recordStepAndAdvance({
            runId, seq, stepId, actor: { kind: step.kind, ref: step.agentId ?? step.actionId ?? null },
            postconditionOutcome: 'n/a', transitionTaken: null, nextStepId: null, context, status: 'failed', claimedBy: lease,
          });
          break;
        }

        const decision = nextStep(graph, stepId, exec.result, context);
        context = this.accumulate(context, stepId, exec.result);
        context = appendTranscript(context, step, exec.result);
        currentStepId = await this.applyDecision(runId, seq, stepId, exec.actor, decision, context, lease);
        if (currentStepId) seq += 1;
      }
    } catch (err) {
      if (err instanceof RunLeaseLostError) {
        this.log(`[conductor] run ${runId} drive yielded: ${err.message}`);
        return (await this.runStore.get(runId)) ?? (await this.requireRun(runId));
      }
      throw err;
    }

    // The while loop's natural exit represents "this drive is genuinely done" — a parked
    // human await and RunLeaseLostError both return earlier, above.
    return this.finalizeIfEnded((await this.runStore.get(runId)) ?? (await this.requireRun(runId)));
  }

  /**
   * Fires `notifyRunEnded` exactly once a run is observed in a genuinely terminal,
   * non-dry-run status (issue #437 — feeds the outbound webhook dispatcher).
   * Best-effort and fire-and-forget: a broken/slow subscriber must never affect run
   * driving, and a dry-run has no external effects to report.
   *
   * Centralizes the check used at every place a drive can stop without recursing back
   * into `driveFrom` — `driveFrom`'s own loop-exit (above) covers everything that
   * happens INSIDE a drive (including a direct in-loop terminal record, which never
   * goes through `applyDecision`); `resolveAwait` (a 'complete'
   * or 'stuck' decision that does not resume driving) and `expireAwait`'s no-fallback
   * branch each call this directly for the same reason.
   */
  private finalizeIfEnded(run: ConductorRun): ConductorRun {
    // 'cancelled' (#759) is a terminal outcome subscribers care about — a
    // webhook consumer watching for run end must not wait forever on a run an
    // operator killed.
    if (
      !run.isDryRun &&
      (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled')
    ) {
      try {
        this.notifyRunEnded?.(run);
      } catch (err) {
        this.log(`[conductor] run ${run.id} notifyRunEnded threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return run;
  }

  /**
   * Re-drive a run left 'running' by a process restart (US2 / SC-002). The run's
   * `current_step_id` points at the next not-yet-executed step — `recordStepAndAdvance`
   * persists the COMPLETED step and only then advances the pointer — so re-driving from
   * there never re-runs a step that was already recorded. The single residual gap is a
   * step whose effect ran but whose record never committed (a crash mid-effect): that one
   * step is re-executed, the inherent at-least-once limit of crash-resume without effect
   * idempotency keys. Called only by the resume worker, after it has claimed the run.
   */
  async resumeRun(runId: string, lease: string): Promise<ConductorRun> {
    const run = await this.requireRun(runId);
    if (run.status !== 'running') return run; // completed/parked between claim and resume
    if (!run.currentStepId) {
      // 'running' with no next step is an inconsistent state — finalize rather than hang.
      const seq = (await this.runStore.stepsForRun(runId)).length;
      await this.runStore.recordStepAndAdvance({
        runId, seq, stepId: '(resume)', actor: { kind: 'resume', reason: 'no_current_step' },
        postconditionOutcome: 'n/a', transitionTaken: null, nextStepId: null, context: run.context, status: 'failed', claimedBy: lease,
      });
      return (await this.runStore.get(runId)) ?? run;
    }
    const { graph } = await this.loadRunGraph(runId);
    this.log(`[conductor] resuming run ${runId} at step '${run.currentStepId}'`);
    return this.driveFrom(runId, graph, run.currentStepId, run.context, lease);
  }

  /**
   * #759 — operator cancel. A 'waiting' run is finalized immediately (its
   * open awaits close as 'cancelled', a synthetic step records the actor);
   * a 'running' run gets the cancel flag and its driver honours it at the
   * next step boundary (`driveFrom`); a terminal run throws
   * {@link RunAlreadyEndedError} (409 at the route).
   */
  async cancelRun(runId: string, requestedBy: string): Promise<ConductorRun> {
    const flagged = await this.runStore.requestCancel(runId, requestedBy);
    if (!flagged) {
      // Either unknown or already terminal — distinguish for the caller.
      const existing = await this.runStore.get(runId);
      if (!existing) throw new WorkflowNotFoundError(`run '${runId}' not found`);
      throw new RunAlreadyEndedError(`run '${runId}' is already ${existing.status}`);
    }
    if (flagged.status === 'waiting') {
      return this.finalizeCancelledWaitingRun(runId);
    }
    this.log(`[conductor] run ${runId} cancel requested by '${requestedBy}' — driver will honour at the next step boundary`);
    return flagged;
  }

  /**
   * #759 — finalize a 'waiting' (or just-parked) run whose cancel flag is set:
   * close its open awaits as 'cancelled', record the synthetic operator step,
   * fire run-ended. `lease` is passed when the caller still owns the run (the
   * park-race path inside driveFrom); absent, a fresh lease is acquired (the
   * route path, where the run is parked with no live driver). `requestedBy`
   * comes from the persisted flag — the columns are deliberately never
   * cleared, they are the load-bearing backstop for every cancel race.
   */
  private async finalizeCancelledWaitingRun(runId: string, lease?: string): Promise<ConductorRun> {
    const run = await this.requireRun(runId);
    const closed = await this.awaitStore.cancelForRun(runId);
    const l = lease ?? randomUUID();
    if (!lease) await this.runStore.acquireLease(runId, l);
    const seq = (await this.runStore.stepsForRun(runId)).length;
    await this.runStore.recordStepAndAdvance({
      runId, seq, stepId: run.currentStepId ?? '(cancel)',
      actor: {
        kind: 'operator_cancel',
        ...(run.cancelRequestedBy ? { requestedBy: run.cancelRequestedBy } : {}),
      },
      postconditionOutcome: 'n/a', transitionTaken: null, nextStepId: null,
      context: run.context, status: 'cancelled', claimedBy: l,
    });
    this.log(
      `[conductor] run ${runId} cancelled by '${run.cancelRequestedBy ?? 'operator'}' (${closed} await(s) closed)`,
    );
    return this.finalizeIfEnded((await this.runStore.get(runId)) ?? run);
  }

  /** A human responded — resolve the await and resume the run. */
  async resolveAwait(awaitId: string, responderId: string, response: JsonValue): Promise<ConductorRun> {
    const aw = await this.awaitStore.get(awaitId);
    if (!aw || aw.status !== 'waiting') throw new AwaitNotPendingError(`await '${awaitId}' is not pending`);

    // Holders resolved LIVE (baton moves re-target) and canonicalized so a lowercased-email responder
    // (the channel layer always lowercases) matches an operator-typed holder. Used for BOTH the
    // authorization gate below and the quorum='all' completeness check.
    //
    // #333 phase 3 — `holdersPartial` is true when a holder source could not answer, which makes
    // `required` a LOWER BOUND rather than the truth. It is deliberately NOT applied to the
    // authorization gate: a shrunken list there merely rejects a real holder, which fails closed.
    // It IS applied to the quorum='all' completeness check below, which fails OPEN.
    const roleHolders: AggregateHolderLookup =
      aw.principalKind === 'role'
        ? await this.resolveRoleHolders(aw.principalRef)
        : { holders: [aw.principalRef], partial: false, bySource: [] };
    const required = [...roleHolders.holders].map(canonicalizePrincipalId);
    const holdersPartial = roleHolders.partial;
    const requiredSet = new Set(required);
    const responder = canonicalizePrincipalId(responderId);

    // Authorization gate: only a current holder may resolve an await. Without this, the Action.Submit
    // payload (client-controllable, carries only awaitId) let any recipient of the card resolve a step
    // they don't own — including non-holders in a shared chat (review: Forge HIGH-1 / Claude M1).
    if (!requiredSet.has(responder)) {
      throw new AwaitResponderNotHolderError(`responder '${responderId}' is not a holder of await '${awaitId}'`);
    }

    await this.awaitStore.recordResponse(awaitId, responder, response);

    // Loaded before quorum aggregation (not only for the resume below) because the step's
    // #759 `strictApproval` flag changes how responses are interpreted.
    const { graph, run } = await this.loadRunGraph(aw.runId);
    const strict = graph.steps.find((s) => s.id === aw.stepId)?.human?.strictApproval === true;

    // Quorum: 'any' resumes on the first response (feeding that response on). 'all' records each
    // response and resumes only once EVERY current holder has answered — holders resolved live, so a
    // baton move correctly changes who is required. The aggregate is fed to the engine for 'all'.
    //
    // #759 strictApproval — the executor NORMALIZES the result it feeds the engine: `approved`
    // becomes true only for an explicit `{approved:true}`. Postconditions keep reading
    // `stepResult.approved` unchanged. An object response keeps its other keys; a non-object
    // response (string/array/number — always a rejection under strict) survives under `raw` so
    // the step record and run context never lose the payload the decision was made on.
    let stepResult: JsonValue = strict
      ? {
          ...(typeof response === 'object' && response !== null && !Array.isArray(response)
            ? (response as JsonObject)
            : { raw: response }),
          approved: isApproved(response, true),
        }
      : response;
    if (aw.quorum === 'all') {
      const responses = await this.awaitStore.listResponses(awaitId);
      const respondedRequired = new Set(
        responses.map((r) => canonicalizePrincipalId(r.responderId)).filter((id) => requiredSet.has(id)),
      );
      // Empty `required` (a role with no current holders, e.g. all batons moved away) is NOT
      // vacuously complete — that would let one stray response resolve a no-holder await. Such a
      // run stays waiting until its deadline fires the fallback (FR-024).
      //
      // #333 phase 3 — nor is a PARTIAL holder list ever complete. The pre-existing guard above
      // covers the empty case; the partial case could not arise while holders came only from the
      // local table, and it is the more dangerous one: `required` looks plausible and non-empty
      // while silently omitting whoever the unreachable source knows about, so a four-eyes
      // approval would complete on two. Failing closed stalls the run until its deadline fires
      // the fallback — the same well-trodden path an unanswered await already takes.
      const complete =
        !holdersPartial && required.length > 0 && required.every((h) => respondedRequired.has(h));
      if (!complete) {
        if (holdersPartial) {
          this.log(
            `[conductor] await ${awaitId} quorum 'all': REFUSING to complete — holder list is partial (${roleHolders.bySource
              .filter((s) => s.lookup.outcome === 'unavailable')
              .map((s) => s.sourceId)
              .join(', ')} unavailable)`,
          );
        }
        this.log(`[conductor] await ${awaitId} quorum 'all': ${respondedRequired.size}/${required.length} required responded`);
        return (await this.runStore.get(aw.runId)) ?? (await this.requireRun(aw.runId));
      }
      // Aggregate over CURRENT required holders only — a holder who lost the baton (or whose stale
      // answer predates a baton move) must not skew `approved` or appear in `responses` (review C#1).
      const counted = responses.filter((r) => requiredSet.has(canonicalizePrincipalId(r.responderId)));
      stepResult = {
        quorum: 'all',
        approved: counted.every((r) => isApproved(r.response, strict)),
        responses: Object.fromEntries(counted.map((r) => [canonicalizePrincipalId(r.responderId), r.response])),
      };
    }

    const won = await this.awaitStore.close(awaitId, 'resolved');
    if (!won) throw new AwaitNotPendingError(`await '${awaitId}' was already resolved`);

    const lease = randomUUID();
    await this.runStore.acquireLease(aw.runId, lease); // take over the parked run's lease
    const decision = nextStep(graph, aw.stepId, stepResult, run.context);
    const context = this.accumulate(run.context, aw.stepId, stepResult);
    const seq = (await this.runStore.stepsForRun(aw.runId)).length;
    const next = await this.applyDecision(aw.runId, seq, aw.stepId, { kind: 'human', quorum: aw.quorum, resolvedUserId: responder }, decision, context, lease);
    if (next) return this.driveFrom(aw.runId, graph, next, context, lease);
    return this.finalizeIfEnded((await this.runStore.get(aw.runId)) ?? run);
  }

  /** A deadline passed with no response — close the await and fire the in-graph fallback (FR-017). */
  async expireAwait(awaitId: string): Promise<void> {
    const aw = await this.awaitStore.get(awaitId);
    if (!aw || aw.status !== 'waiting') return;
    const won = await this.awaitStore.close(awaitId, 'timed_out');
    if (!won) return;

    const { graph, run } = await this.loadRunGraph(aw.runId);
    const lease = randomUUID();
    await this.runStore.acquireLease(aw.runId, lease); // take over the parked run's lease
    const seq = (await this.runStore.stepsForRun(aw.runId)).length;
    const fallback = aw.fallbackTransitionId ? graph.transitions.find((tr) => tr.id === aw.fallbackTransitionId) : undefined;
    // #330 C3 — a timer expiry is the step doing exactly its job, not a
    // missed deadline; the actor says so, and the trace stays honest.
    const actor: JsonValue = aw.principalKind === 'timer' ? { kind: 'timer', ticked: true } : { kind: 'human', timedOut: true };
    // A timer expiring is the step working as designed — 'unmet' would lie.
    const expiredOutcome = aw.principalKind === 'timer' ? 'n/a' : 'unmet';
    if (!fallback) {
      await this.runStore.recordStepAndAdvance({
        runId: aw.runId, seq, stepId: aw.stepId, actor,
        postconditionOutcome: expiredOutcome, transitionTaken: null, nextStepId: null, context: run.context, status: 'failed', claimedBy: lease,
      });
      const ended = await this.runStore.get(aw.runId);
      if (ended) this.finalizeIfEnded(ended);
      return;
    }
    await this.runStore.recordStepAndAdvance({
      runId: aw.runId, seq, stepId: aw.stepId, actor,
      postconditionOutcome: expiredOutcome, transitionTaken: fallback.id, nextStepId: fallback.target, context: run.context, status: 'running', claimedBy: lease,
    });
    this.log(`[conductor] await ${awaitId} timed out → fallback '${fallback.id}' (run ${aw.runId})`);
    await this.driveFrom(aw.runId, graph, fallback.target, run.context, lease);
  }

  /**
   * Dry-run / preview (US8 / FR-029): simulate the workflow path in memory with NO persistence
   * and NO side effects — no conductor_runs/awaits rows, no real notification, no durable await.
   * Human steps are answered inline (supplied `humanResponses[stepId]`, default `{approved:true}`);
   * agent steps run a real turn; action steps are stubbed (irreversible connector actions are not
   * executed). Returns the full simulated step path so the operator gains confidence before activating.
   */
  async previewRun(slug: string, payload: JsonObject, humanResponses: Record<string, JsonValue> = {}): Promise<PreviewResult> {
    const wf = await this.workflowStore.getBySlug(slug);
    if (!wf) throw new WorkflowNotFoundError(`workflow '${slug}' not found`);
    if (!wf.activeVersionId) throw new WorkflowNotPublishedError(`workflow '${slug}' has no active version`);
    const version = await this.workflowStore.getVersion(wf.activeVersionId);
    if (!version) throw new WorkflowNotPublishedError(`active version of '${slug}' missing`);
    const graph = version.graph;

    let context: JsonObject = { ...payload };
    let currentStepId: string | null = graph.entryStepId;
    const steps: PreviewStep[] = [];
    let status: 'completed' | 'failed' = 'completed';
    let guard = MAX_STEPS;

    while (currentStepId && guard-- > 0) {
      const stepId: string = currentStepId;
      const step = graph.steps.find((s) => s.id === stepId);
      if (!step) {
        status = 'failed';
        break;
      }

      context = this.bumpStepAttempt(context, stepId);

      // #330 C3 — preview simulates a timer instantly: record it and follow
      // the on-expiry fallback (no parking in a dry-run).
      if (step.kind === 'timer') {
        const fb = step.fallbackTransitionId ? graph.transitions.find((tr) => tr.id === step.fallbackTransitionId) : undefined;
        steps.push({
          stepId,
          kind: step.kind,
          actor: 'timer (simulated instant)',
          postcondition: 'n/a',
          transition: fb?.id ?? null,
          result: { simulated: true, duration: step.timer?.duration ?? null },
        });
        if (!fb) {
          status = 'failed';
          break;
        }
        currentStepId = fb.target;
        continue;
      }

      let result: JsonValue;
      let actor: string;
      if (step.kind === 'human') {
        result = humanResponses[stepId] ?? { approved: true };
        actor = 'human (inline)';
      } else if (step.kind === 'agent') {
        const exec = await this.effects.runAgentStep(step, context, { runId: `preview:${slug}` });
        result = exec.result;
        actor = `agent:${step.agentId ?? '?'}`;
      } else {
        result = { simulated: true, actionId: step.actionId ?? null };
        actor = `action (stubbed):${step.actionId ?? '?'}`;
      }

      const decision = nextStep(graph, stepId, result, context);
      context = this.accumulate(context, stepId, result);
      steps.push({
        stepId,
        kind: step.kind,
        actor,
        postcondition: decision.postcondition,
        transition: decision.kind === 'advance' ? decision.transitionId : null,
        result,
      });

      if (decision.kind === 'advance') {
        currentStepId = decision.targetStepId;
      } else {
        status = decision.kind === 'complete' ? 'completed' : 'failed';
        currentStepId = null;
      }
    }

    return { status, steps, context };
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  /** Opens a durable await + parks the run. Returns false (without parking) when a role principal has
   *  NO current holder — nobody could answer, so the caller takes the step's fallback instead of
   *  hanging the run forever (FR-024). */
  private async openHumanAwait(runId: string, step: Step, context: JsonObject, lease: string): Promise<boolean> {
    const h = step.human;
    if (h?.principal.kind === 'role') {
      const lookup = await this.resolveRoleHolders(h.principal.ref);
      // #333 phase 3 — "no holders" may only trigger the fallback when we actually KNOW there are
      // none. On a partial lookup an empty list means "we could not ask", and taking the fallback
      // there would skip the human step altogether — an approval silently bypassed by a directory
      // outage. Park instead: the await's own deadline reaches the same fallback later, but only
      // after giving the real holders a chance to answer.
      if (lookup.holders.length === 0 && lookup.partial) {
        this.log(
          `[conductor] run ${runId} human step '${step.id}' role '${h.principal.ref}': holder lookup is PARTIAL and empty — parking rather than taking the fallback`,
        );
      } else if (lookup.holders.length === 0) {
        this.log(`[conductor] run ${runId} human step '${step.id}' role '${h.principal.ref}' has no current holder`);
        return false;
      }
    }
    const deadlineMs = parseIsoDurationMs(h?.deadline ?? null);
    const reminderMs = parseIsoDurationMs(h?.reminderInterval ?? null);
    // create() is idempotent (one open await per run+step), so a crash-and-resume between
    // create and park never doubles the await; park is fenced on the lease.
    await this.awaitStore.create({
      runId,
      stepId: step.id,
      principalKind: h?.principal.kind ?? 'role',
      principalRef: h?.principal.ref ?? '',
      channelType: h?.channel ?? 'teams',
      message: h?.message ?? '',
      quorum: h?.quorum ?? 'any',
      reminderIntervalMs: reminderMs,
      deadlineAt: deadlineMs ? new Date(Date.now() + deadlineMs) : null,
      fallbackTransitionId: step.fallbackTransitionId ?? null,
    });
    await this.runStore.park(runId, step.id, context, lease);
    this.log(`[conductor] run ${runId} awaiting human at step '${step.id}' (${h?.principal.kind}:${h?.principal.ref})`);
    return true;
  }

  private accumulate(context: JsonObject, stepId: string, result: JsonValue): JsonObject {
    const prev = asObject(context.steps);
    return { ...context, steps: { ...prev, [stepId]: result } };
  }

  /** #330 C3 — `ctx.stepAttempts[stepId]`: how often a step has been ENTERED
   *  in this run. Deterministic loop budget for guarded cycles. */
  private bumpStepAttempt(context: JsonObject, stepId: string): JsonObject {
    const prev = asObject(context.stepAttempts);
    const before = typeof prev[stepId] === 'number' ? (prev[stepId] as number) : 0;
    return { ...context, stepAttempts: { ...prev, [stepId]: before + 1 } };
  }

  /** Persist a step's decision; returns the next step id to drive, or null if the run ended/parked. */
  private async applyDecision(
    runId: string,
    seq: number,
    stepId: string,
    actor: JsonValue,
    decision: ReturnType<typeof nextStep>,
    context: JsonObject,
    lease: string,
  ): Promise<string | null> {
    if (decision.kind === 'advance') {
      await this.runStore.recordStepAndAdvance({
        runId, seq, stepId, actor, postconditionOutcome: decision.postcondition, transitionTaken: decision.transitionId,
        nextStepId: decision.targetStepId, context, status: 'running', claimedBy: lease,
      });
      return decision.targetStepId;
    }
    if (decision.kind === 'complete') {
      await this.runStore.recordStepAndAdvance({
        runId, seq, stepId, actor, postconditionOutcome: decision.postcondition, transitionTaken: null,
        nextStepId: null, context, status: 'completed', claimedBy: lease,
      });
      return null;
    }
    this.log(`[conductor] run ${runId} stuck at '${stepId}': ${decision.message}`);
    await this.runStore.recordStepAndAdvance({
      runId, seq, stepId, actor, postconditionOutcome: decision.postcondition, transitionTaken: null,
      nextStepId: stepId, context, status: 'failed', claimedBy: lease,
    });
    return null;
  }

  private async loadRunGraph(runId: string): Promise<{ graph: WorkflowGraph; run: ConductorRun }> {
    const run = await this.requireRun(runId);
    const version = await this.workflowStore.getVersion(run.workflowVersionId);
    if (!version) throw new WorkflowNotPublishedError(`version for run '${runId}' missing`);
    return { graph: version.graph, run };
  }

  private async requireRun(runId: string): Promise<ConductorRun> {
    const run = await this.runStore.get(runId);
    if (!run) throw new WorkflowNotFoundError(`run '${runId}' not found`);
    return run;
  }
}
