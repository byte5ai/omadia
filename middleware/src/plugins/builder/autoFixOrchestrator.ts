/**
 * AutoFixOrchestrator (Option-C, C-4) — closes the build/error → fix
 * loop without operator intervention.
 *
 * Architecture: bus-subscriber. The orchestrator listens to the same
 * SpecEventBus that the frontend SSE forwarder uses, so build_status
 * and runtime_smoke_status events flow through one canonical surface.
 * On every `*_failed` event for a draft whose
 * `spec.builder_settings.auto_fix_enabled` is true, the orchestrator
 *
 *   1. computes a stable fingerprint of the failure shape,
 *   2. dedupes per-buildN (one trigger per build, even if SSE replay
 *      delivers the same event twice),
 *   3. compares the fingerprint to the previous auto-attempt; if the
 *      same fingerprint has now persisted for `MAX_IDENTICAL_ATTEMPTS`
 *      consecutive auto-attempts, it surfaces `stopped_loop`, flips
 *      the spec flag back to `auto_fix_enabled: false`, and refuses
 *      to fire again,
 *   4. otherwise emits `auto_fix_status: triggered` and fires a
 *      synthetic Builder turn with `composeFixPrompt(...)` as the
 *      user message — fire-and-forget; the agent's own runTurn
 *      iteration drives the rest of the rebuild loop.
 *
 * Loop-state is per-draft and in-memory (Map). The orchestrator must
 * be `ensureSubscribed`d when an operator opens the workspace; the
 * SSE route is the natural seam. Subscriptions are idempotent.
 *
 * Why the `userEmail` indirection: runTurn requires it to scope the
 * draft load. The first `ensureSubscribed` call captures the email +
 * model from the active session/draft so subsequent failure-events
 * have everything they need without re-fetching session state.
 */

import { createHash, randomUUID } from 'node:crypto';

import { composeFixPrompt } from './composeFixPrompt.js';
import type { BuilderAgent } from './builderAgent.js';
import type { DraftStore } from './draftStore.js';
import type { SpecEventBus, SpecBusEvent } from './specEventBus.js';
import type { BuilderTurnRingBuffer } from './turnRingBuffer.js';
import { applySpecPatches } from './specPatcher.js';
import { parseAgentSpec } from './agentSpec.js';

export const MAX_IDENTICAL_ATTEMPTS = 3;

/** Anthropic-style model id required by `BuilderAgent.runTurn(modelChoice)`. */
type AnthropicModelId = string;

export interface AutoFixOrchestratorDeps {
  bus: SpecEventBus;
  draftStore: DraftStore;
  builderAgent: BuilderAgent;
  /** Fallback Anthropic model id when a draft has none recorded. */
  defaultModel: AnthropicModelId;
  /** Resolves a `BuilderModelId` ('haiku'|'sonnet'|'opus') to an
   *  Anthropic id. The route uses the same registry. */
  resolveModelId: (builderModelId: 'haiku' | 'sonnet' | 'opus') => AnthropicModelId;
  /** Optional ring buffer so auto-turn frames are replayable across
   *  tabs the same way an HTTP-route turn is. */
  turnRingBuffer?: BuilderTurnRingBuffer;
  logger?: (...args: unknown[]) => void;
}

interface DraftAutoFixState {
  userEmail: string;
  /** Last fingerprint we triggered for. */
  lastFp: string | null;
  /** Number of consecutive auto-attempts with `lastFp`. */
  consecutiveCount: number;
  /** buildN values for which we've already triggered (per kind) so SSE
   *  replay doesn't fire twice for the same build. */
  triggeredByKind: Map<'build_failed' | 'smoke_failed', Set<number>>;
  /**
   * Pause-lock: serialises auto-turns per draft. Set to the active
   * `turnId` when an auto-turn fires; cleared in the turn's finally
   * block. While non-null, `tryTrigger` short-circuits — without this
   * the rebuild a turn just kicked off can fire `build_status:failed`
   * for the next buildN BEFORE the original turn finished, leading to
   * overlapping turns ("nervös"). With it, every auto-turn runs to
   * completion (success OR error) before the next can fire.
   */
  inFlightTurnId: string | null;
  unsubscribe: () => void;
}

/**
 * Stable fingerprint over the failure shape. SHA-256 over a sorted,
 * normalised projection so the agent's incidental output (line numbers
 * shifting after a partial fix, error order changing) doesn't perturb
 * loop-detection. Field-by-field rationale:
 *
 *   - build_status: code-only because the message often embeds line
 *     numbers / paths that shift when the agent edits a slot.
 *     Sorted so order-of-emission doesn't matter.
 *   - smoke: toolId + status, ignoring durationMs and message text
 *     (timing varies; messages embed runtime values).
 */
export function computeFingerprint(
  ev:
    | Extract<SpecBusEvent, { type: 'build_status' }>
    | Extract<SpecBusEvent, { type: 'runtime_smoke_status' }>,
): string {
  let projection: string;
  if (ev.type === 'build_status') {
    const codes = (ev.errors ?? [])
      .map((e) => e.code)
      .filter((c): c is string => typeof c === 'string' && c.length > 0)
      .sort();
    projection = `build:${codes.join(',') || ev.reason || 'unknown'}`;
  } else {
    const tools = (ev.results ?? [])
      .filter((r) => r.status !== 'ok')
      .map((r) => `${r.toolId}:${r.status}`)
      .sort();
    const adminRoutes = (ev.adminRouteResults ?? [])
      .filter(
        (r) =>
          r.status === 'schema_violation' ||
          r.status === 'http_error' ||
          r.status === 'timeout',
      )
      .map((r) => `${r.endpoint}:${r.status}`)
      .sort();
    const toolsPart = tools.join(',') || 'no-tools';
    const adminPart = adminRoutes.join(',') || 'no-admin';
    projection = `smoke:${ev.reason ?? 'unknown'}:${toolsPart}|${adminPart}`;
  }
  return createHash('sha256').update(projection).digest('hex').slice(0, 16);
}

export class AutoFixOrchestrator {
  private readonly bus: SpecEventBus;
  private readonly draftStore: DraftStore;
  private readonly builderAgent: BuilderAgent;
  private readonly defaultModel: AnthropicModelId;
  private readonly resolveModelId: (
    builderModelId: 'haiku' | 'sonnet' | 'opus',
  ) => AnthropicModelId;
  private readonly turnRingBuffer: BuilderTurnRingBuffer | undefined;
  private readonly log: (...args: unknown[]) => void;

  private readonly perDraft = new Map<string, DraftAutoFixState>();

  constructor(deps: AutoFixOrchestratorDeps) {
    this.bus = deps.bus;
    this.draftStore = deps.draftStore;
    this.builderAgent = deps.builderAgent;
    this.defaultModel = deps.defaultModel;
    this.resolveModelId = deps.resolveModelId;
    this.turnRingBuffer = deps.turnRingBuffer;
    this.log = deps.logger ?? (() => {});
  }

  /**
   * Idempotent: registers a bus listener for the draft if not already
   * present. Captures the active operator's `userEmail` so failure
   * events know who to attribute the auto-fix-turn to. Re-calling with
   * a new email is a no-op (the orchestrator does not impersonate
   * across operators within a single draft session).
   */
  ensureSubscribed(draftId: string, userEmail: string): void {
    if (this.perDraft.has(draftId)) return;

    const state: DraftAutoFixState = {
      userEmail,
      lastFp: null,
      consecutiveCount: 0,
      triggeredByKind: new Map(),
      inFlightTurnId: null,
      unsubscribe: () => {},
    };
    state.unsubscribe = this.bus.subscribe(draftId, (ev) => {
      this.handleEvent(draftId, ev).catch((err: unknown) => {
        this.log('autoFix: handleEvent failed', draftId, err);
      });
    });
    this.perDraft.set(draftId, state);
  }

  /** Test-only inspector — exposes the fingerprint streak + in-flight
   *  pause-lock so loop-detection and serialisation can be asserted
   *  without poking private state. */
  inspectStreak(
    draftId: string,
  ): {
    lastFp: string | null;
    consecutiveCount: number;
    inFlightTurnId: string | null;
  } | null {
    const s = this.perDraft.get(draftId);
    if (!s) return null;
    return {
      lastFp: s.lastFp,
      consecutiveCount: s.consecutiveCount,
      inFlightTurnId: s.inFlightTurnId,
    };
  }

  /** Drop all per-draft state. Test-only convenience. */
  reset(): void {
    for (const s of this.perDraft.values()) s.unsubscribe();
    this.perDraft.clear();
  }

  private async handleEvent(draftId: string, ev: SpecBusEvent): Promise<void> {
    const state = this.perDraft.get(draftId);
    if (!state) return;

    // We care about exactly two failure surfaces. Everything else
    // (spec_patch, build_status:building/ok, etc.) is irrelevant to
    // the AutoFix loop. We DO listen for build_status:ok to clear
    // the streak — a successful build means whatever the agent did
    // worked, even if it happened in a non-auto turn.
    if (ev.type === 'build_status' && ev.phase === 'ok') {
      state.lastFp = null;
      state.consecutiveCount = 0;
      return;
    }
    if (ev.type === 'build_status' && ev.phase === 'failed') {
      await this.tryTrigger(draftId, state, ev, 'build_failed');
      return;
    }
    if (ev.type === 'runtime_smoke_status' && ev.phase === 'failed') {
      await this.tryTrigger(draftId, state, ev, 'smoke_failed');
      return;
    }
  }

  private async tryTrigger(
    draftId: string,
    state: DraftAutoFixState,
    ev:
      | Extract<SpecBusEvent, { type: 'build_status' }>
      | Extract<SpecBusEvent, { type: 'runtime_smoke_status' }>,
    kind: 'build_failed' | 'smoke_failed',
  ): Promise<void> {
    const buildN = ev.buildN ?? 0;

    // Pause-lock: an auto-turn is already running. Drop the trigger
    // silently — the inflight turn will produce its own follow-up
    // build_status frames; if those still fail, the orchestrator will
    // re-arm AFTER the lock clears in fireTurn's finally. Without this
    // gate the rebuild a turn just kicked off can fire failures for
    // the next buildN before the original turn finished, causing
    // overlapping turns and the "nervös" loop.
    if (state.inFlightTurnId !== null) {
      this.log('autoFix: skip trigger — auto-turn inflight', {
        draftId,
        kind,
        buildN,
        inFlight: state.inFlightTurnId,
      });
      return;
    }

    // Per-(buildN,kind) dedup.
    let kindSet = state.triggeredByKind.get(kind);
    if (!kindSet) {
      kindSet = new Set();
      state.triggeredByKind.set(kind, kindSet);
    }
    if (kindSet.has(buildN)) return;
    kindSet.add(buildN);

    // Need an up-to-date spec to read the toggle and guard against an
    // operator flipping it off mid-build. parseAgentSpec applies the
    // schema default so legacy drafts without builder_settings parse
    // cleanly (auto_fix_enabled: false).
    const draft = await this.draftStore.load(state.userEmail, draftId);
    if (!draft) return;
    let parsedSpec: ReturnType<typeof parseAgentSpec>;
    try {
      parsedSpec = parseAgentSpec(draft.spec);
    } catch {
      // Spec is mid-construction and not yet Zod-valid. AutoFix only
      // makes sense for specs that compile, so we wait for the
      // operator to clean up enough to pass parseAgentSpec.
      return;
    }
    if (!parsedSpec.builder_settings.auto_fix_enabled) return;

    const fp = computeFingerprint(ev);
    if (state.lastFp === fp) {
      state.consecutiveCount += 1;
    } else {
      state.lastFp = fp;
      state.consecutiveCount = 1;
    }

    if (state.consecutiveCount > MAX_IDENTICAL_ATTEMPTS) {
      // Already MAX_IDENTICAL_ATTEMPTS triggers fired with this fp;
      // refuse to fire a (MAX+1)-th. Flip the toggle back so the next
      // failure doesn't silently re-arm, and surface the loop-stop
      // banner via the bus.
      this.log(
        'autoFix: stopped_loop after',
        MAX_IDENTICAL_ATTEMPTS,
        'identical attempts',
        { draftId, kind, buildN, fp },
      );
      await this.flipToggleOff(draftId, state, parsedSpec).catch((err: unknown) => {
        this.log('autoFix: flipToggleOff failed', draftId, err);
      });
      this.bus.emit(draftId, {
        type: 'auto_fix_status',
        phase: 'stopped_loop',
        kind,
        buildN,
        identicalCount: state.consecutiveCount - 1,
      });
      // Also reset so a future re-enable starts fresh.
      state.consecutiveCount = 0;
      state.lastFp = null;
      return;
    }

    // Acquire the pause-lock SYNCHRONOUSLY before emitting `triggered`
    // and before the `void fireTurn(...)` returns control to the event
    // loop, so any further bus events that land in the same tick see
    // the lock as held. Cleared in fireTurn's finally — including on
    // error paths — so a crashing turn does not wedge the lock.
    const turnId = randomUUID();
    state.inFlightTurnId = turnId;

    this.bus.emit(draftId, {
      type: 'auto_fix_status',
      phase: 'triggered',
      kind,
      buildN,
    });

    let userMessage: string;
    if (kind === 'build_failed') {
      userMessage = composeFixPrompt({
        kind: 'build_failed',
        buildN,
        reason: ev.type === 'build_status' ? ev.reason : undefined,
        errors:
          ev.type === 'build_status'
            ? ev.errors?.map((e) => ({
                path: e.file,
                line: e.line,
                col: e.column,
                code: e.code,
                message: e.message,
              }))
            : undefined,
      });
    } else if (
      ev.type === 'runtime_smoke_status' &&
      ev.reason === 'admin_route_schema_violation'
    ) {
      // Theme D: admin-route smoke failure — point the agent at the
      // route-handler contract, not at tools.
      userMessage = composeFixPrompt({
        kind: 'admin_route_schema_violation',
        buildN,
        adminRouteResults: ev.adminRouteResults,
      });
    } else {
      userMessage = composeFixPrompt({
        kind: 'smoke_failed',
        buildN,
        smokeResults:
          ev.type === 'runtime_smoke_status' ? ev.results : undefined,
      });
    }

    void this.fireTurn({
      draftId,
      userEmail: state.userEmail,
      userMessage,
      modelChoice: this.resolveDraftModel(draft.codegenModel),
      turnId,
    })
      .catch((err: unknown) => {
        this.log('autoFix: fireTurn failed', draftId, err);
      })
      .finally(() => {
        // Only clear if WE are still the owner — a `reset()` between
        // start and finish (test-only) may have already wiped state.
        if (state.inFlightTurnId === turnId) {
          state.inFlightTurnId = null;
        }
      });
  }

  private resolveDraftModel(
    builderModelId: 'haiku' | 'sonnet' | 'opus' | string,
  ): AnthropicModelId {
    if (
      builderModelId === 'haiku' ||
      builderModelId === 'sonnet' ||
      builderModelId === 'opus'
    ) {
      return this.resolveModelId(builderModelId);
    }
    return this.defaultModel;
  }

  private async fireTurn(opts: {
    draftId: string;
    userEmail: string;
    userMessage: string;
    modelChoice: AnthropicModelId;
    /** Provided by `tryTrigger` so the same id is also stored in the
     *  pause-lock — we do not generate it here to keep the lock <-> turn
     *  identity 1:1. */
    turnId: string;
  }): Promise<void> {
    const { turnId } = opts;
    this.turnRingBuffer?.start(turnId);
    const stamp = (ev: { type: string } & Record<string, unknown>): void => {
      // No-op when there's no ring buffer — auto-turn frames are still
      // visible to other tabs via the SpecEventBus path (spec_patch /
      // slot_patch / build_status emitted by the tools themselves).
      this.turnRingBuffer?.record(
        turnId,
        ev as Parameters<BuilderTurnRingBuffer['record']>[1],
      );
    };
    try {
      const iter = this.builderAgent.runTurn({
        draftId: opts.draftId,
        userEmail: opts.userEmail,
        userMessage: opts.userMessage,
        modelChoice: opts.modelChoice,
        turnId,
      });
      for await (const ev of iter) {
        stamp(ev);
      }
    } finally {
      this.turnRingBuffer?.finalize(turnId);
    }
  }

  private async flipToggleOff(
    draftId: string,
    state: DraftAutoFixState,
    currentSpec: ReturnType<typeof parseAgentSpec>,
  ): Promise<void> {
    if (!currentSpec.builder_settings.auto_fix_enabled) return;
    const patch = [
      {
        op: 'replace' as const,
        path: '/builder_settings/auto_fix_enabled',
        value: false,
      },
    ];
    const { spec: nextSpec } = applySpecPatches(currentSpec, patch);
    const draft = await this.draftStore.load(state.userEmail, draftId);
    if (!draft) return;
    await this.draftStore.update(state.userEmail, draftId, {
      spec: nextSpec,
    });
    this.bus.emit(draftId, {
      type: 'spec_patch',
      patches: patch,
      cause: 'agent',
    });
  }
}

