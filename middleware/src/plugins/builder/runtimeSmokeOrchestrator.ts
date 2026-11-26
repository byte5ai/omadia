import type { DraftStore } from './draftStore.js';
import type { PreviewActivateOptions, PreviewHandle } from './previewRuntime.js';
import { runRuntimeSmoke, type RuntimeSmokeResult } from './runtimeSmoke.js';
import type { SpecBusEvent, SpecEventBus } from './specEventBus.js';
import { parseAgentSpec } from './agentSpec.js';

/** The `runtime_smoke_status` variant of the spec-bus event union. */
type RuntimeSmokeEvent = Extract<SpecBusEvent, { type: 'runtime_smoke_status' }>;

/**
 * Issue #227 — last runtime-smoke outcome for a draft, retained in-memory so
 * the Builder agent's `runtime_smoke_status` tool can pull it (ctx.memory /
 * ctx.http availability, per-tool + route smoke) without an operator-driven
 * preview round-trip. Mirrors the emitted bus event minus its `type` tag,
 * plus a record timestamp.
 */
export interface SmokeStatusSnapshot extends Omit<RuntimeSmokeEvent, 'type'> {
  /** ISO-8601 timestamp of when this snapshot was recorded. */
  smokedAt: string;
}

/**
 * RuntimeSmokeOrchestrator (B.9-3) — kicks off the runtime-smoke pass
 * after each fresh preview build, dedup'd per (draftId, rev) so the
 * smoke runs once per build no matter how many ensureWarm calls land
 * on the cached handle.
 *
 * Fire-and-forget pattern: `attemptSmoke` returns immediately; the
 * actual invocations + bus emits run on a detached promise. Callers
 * never await the smoke; the SSE consumer picks up the events as they
 * arrive.
 *
 * #1778 — the smoke activates its OWN instance of the build with stub
 * setup values and `ctx.smokeMode === true` (`runRuntimeSmoke`), never the
 * warm preview handle: that one holds the operator's test credentials, and
 * a smoke on it ran every tool — writes included — against real systems
 * after every build. Tools declared `side_effects: 'write'` are not called.
 */

export interface RuntimeSmokeOrchestratorDeps {
  draftStore: DraftStore;
  bus: SpecEventBus;
  /** Activates the smoke's own stub instance (`PreviewRuntime.activate`). */
  activate: (opts: PreviewActivateOptions) => Promise<PreviewHandle>;
  /** Per-tool timeout, default 10s (mirrors invokeToolsOnHandle default). */
  toolTimeoutMs?: number;
  logger?: (...args: unknown[]) => void;
  /** Spec 2042 §5.10 — runs `work` as one operator job started by
   *  `startedBy` (the kernel's `modelWork.run`), so its model calls have a
   *  context, a budget and a deadline. Absent (tests): `work` runs as is. */
  runAsJob?: <T>(startedBy: string, work: () => Promise<T>) => Promise<T>;
}

/** One fresh build to smoke: its number and its plugin ZIP. */
export interface SmokeTarget {
  readonly rev: number;
  readonly zipBuffer: Buffer;
  readonly userEmail: string;
  readonly draftId: string;
}

export class RuntimeSmokeOrchestrator {
  private readonly draftStore: DraftStore;
  private readonly bus: SpecEventBus;
  private readonly activate: RuntimeSmokeOrchestratorDeps['activate'];
  private readonly toolTimeoutMs: number | undefined;
  private readonly log: (...args: unknown[]) => void;
  private readonly runAsJob: NonNullable<RuntimeSmokeOrchestratorDeps['runAsJob']>;

  /** Per-draft last successfully-smoked rev. Smoke is skipped if the
   *  rev hasn't advanced since the previous attempt. */
  private readonly lastSmokedRev = new Map<string, number>();

  /** Issue #227 — per-draft last smoke outcome (in-memory), surfaced to the
   *  Builder via the `runtime_smoke_status` tool. */
  private readonly lastStatus = new Map<string, SmokeStatusSnapshot>();

  constructor(deps: RuntimeSmokeOrchestratorDeps) {
    this.draftStore = deps.draftStore;
    this.bus = deps.bus;
    this.activate = deps.activate;
    this.toolTimeoutMs = deps.toolTimeoutMs;
    this.log = deps.logger ?? (() => {});
    this.runAsJob = deps.runAsJob ?? ((_by, work) => work());
  }

  /**
   * Fire-and-forget. Skips the smoke if `rev` has already been
   * smoked for this draft. Otherwise emits `runtime_smoke_status:running`
   * synchronously (so the UI can flip its indicator immediately) and
   * runs the per-tool invocations on a detached promise that emits the
   * terminal event when done.
   */
  attemptSmoke(opts: SmokeTarget): void {
    const { rev, userEmail, draftId } = opts;
    const last = this.lastSmokedRev.get(draftId);
    if (last !== undefined && last >= rev) {
      return;
    }
    // Reserve the rev BEFORE the async work so concurrent ensureWarm
    // returns don't race-fire two smoke runs for the same build.
    this.lastSmokedRev.set(draftId, rev);

    this.emitSmoke(draftId, {
      type: 'runtime_smoke_status',
      phase: 'running',
      buildN: rev,
    });

    // The smoke runs the draft's tools, which may ask a model: one operator
    // job per smoke run, attributed to the draft's operator.
    void this.runAsJob(userEmail, () => this.runDetached(opts)).catch(
      (err: unknown) => {
        this.log('runtime smoke: operator job not started', draftId, err);
      },
    );
  }

  /**
   * Issue #227 — last recorded smoke outcome for a draft, or `undefined` when
   * no smoke has run for it in the current process.
   */
  getLastSmokeStatus(draftId: string): SmokeStatusSnapshot | undefined {
    return this.lastStatus.get(draftId);
  }

  /**
   * Emit a `runtime_smoke_status` event on the bus AND retain it as the
   * draft's last-known snapshot (Issue #227). All smoke emits funnel through
   * here so the pull-tool and the SSE stream never drift.
   */
  private emitSmoke(draftId: string, event: RuntimeSmokeEvent): void {
    this.bus.emit(draftId, event);
    const { type: _type, ...rest } = event;
    this.lastStatus.set(draftId, { ...rest, smokedAt: new Date().toISOString() });
  }

  private async runDetached(opts: SmokeTarget): Promise<void> {
    const { userEmail, draftId } = opts;
    const handle = { rev: opts.rev };
    let result: RuntimeSmokeResult;
    try {
      const draft = await this.draftStore.load(userEmail, draftId);
      if (!draft) {
        this.emitSmoke(draftId, {
          type: 'runtime_smoke_status',
          phase: 'failed',
          buildN: handle.rev,
          reason: 'activate_failed',
          activateError: `draft '${draftId}' not found`,
        });
        return;
      }
      let spec;
      try {
        spec = parseAgentSpec(draft.spec);
      } catch (err) {
        this.emitSmoke(draftId, {
          type: 'runtime_smoke_status',
          phase: 'failed',
          buildN: handle.rev,
          reason: 'activate_failed',
          activateError: `spec invalid: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }
      result = await runRuntimeSmoke({
        zipBuffer: opts.zipBuffer,
        spec,
        draftId,
        rev: opts.rev,
        activate: this.activate,
        ...(this.toolTimeoutMs !== undefined ? { toolTimeoutMs: this.toolTimeoutMs } : {}),
      });
    } catch (err) {
      // runRuntimeSmoke reports activation failures itself; anything that
      // still throws is surfaced as activate_failed for the UI.
      this.emitSmoke(draftId, {
        type: 'runtime_smoke_status',
        phase: 'failed',
        buildN: handle.rev,
        reason: 'activate_failed',
        activateError: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    this.log(
      `[smoke] draft=${draftId} rev=${String(handle.rev)} ok=${String(result.ok)} reason=${result.reason} tools=${String(result.results.length)} duration_ms=${String(result.durationMs)}`,
    );

    this.emitSmoke(draftId, {
      type: 'runtime_smoke_status',
      phase: result.ok ? 'ok' : 'failed',
      buildN: handle.rev,
      reason: result.reason,
      ...(result.activateError !== undefined ? { activateError: result.activateError } : {}),
      results: result.results.map((r) => ({
        toolId: r.toolId,
        status: r.status,
        durationMs: r.durationMs,
        ...(r.errorMessage !== undefined ? { errorMessage: r.errorMessage } : {}),
      })),
      ...(result.adminRouteResults && result.adminRouteResults.length > 0
        ? {
            adminRouteResults: result.adminRouteResults.map((r) => ({
              endpoint: r.endpoint,
              status: r.status,
              durationMs: r.durationMs,
              ...(r.httpStatus !== undefined ? { httpStatus: r.httpStatus } : {}),
              ...(r.reason !== undefined ? { reason: r.reason } : {}),
            })),
          }
        : {}),
      ...(result.uiRouteResults && result.uiRouteResults.length > 0
        ? {
            uiRouteResults: result.uiRouteResults.map((r) => ({
              endpoint: r.endpoint,
              status: r.status,
              durationMs: r.durationMs,
              ...(r.httpStatus !== undefined ? { httpStatus: r.httpStatus } : {}),
              ...(r.reason !== undefined ? { reason: r.reason } : {}),
            })),
          }
        : {}),
    });
  }
}
