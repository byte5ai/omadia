import type { DraftStore } from './draftStore.js';
import type { PreviewHandle } from './previewRuntime.js';
import { invokeToolsOnHandle, type RuntimeSmokeResult } from './runtimeSmoke.js';
import type { SpecEventBus } from './specEventBus.js';
import { parseAgentSpec } from './agentSpec.js';

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
 * Reuses the just-activated PreviewHandle (the same one the chat
 * surface uses) — no separate sandbox, no double-extract, no
 * disk-collision with the preview-cache's dir layout.
 */

export interface RuntimeSmokeOrchestratorDeps {
  draftStore: DraftStore;
  bus: SpecEventBus;
  /** Per-tool timeout, default 10s (mirrors invokeToolsOnHandle default). */
  toolTimeoutMs?: number;
  logger?: (...args: unknown[]) => void;
}

export class RuntimeSmokeOrchestrator {
  private readonly draftStore: DraftStore;
  private readonly bus: SpecEventBus;
  private readonly toolTimeoutMs: number | undefined;
  private readonly log: (...args: unknown[]) => void;

  /** Per-draft last successfully-smoked rev. Smoke is skipped if the
   *  rev hasn't advanced since the previous attempt. */
  private readonly lastSmokedRev = new Map<string, number>();

  constructor(deps: RuntimeSmokeOrchestratorDeps) {
    this.draftStore = deps.draftStore;
    this.bus = deps.bus;
    this.toolTimeoutMs = deps.toolTimeoutMs;
    this.log = deps.logger ?? (() => {});
  }

  /**
   * Fire-and-forget. Skips the smoke if `handle.rev` has already been
   * smoked for this draft. Otherwise emits `runtime_smoke_status:running`
   * synchronously (so the UI can flip its indicator immediately) and
   * runs the per-tool invocations on a detached promise that emits the
   * terminal event when done.
   */
  attemptSmoke(opts: {
    handle: PreviewHandle;
    userEmail: string;
    draftId: string;
  }): void {
    const { handle, userEmail, draftId } = opts;
    const last = this.lastSmokedRev.get(draftId);
    if (last !== undefined && last >= handle.rev) {
      return;
    }
    // Reserve the rev BEFORE the async work so concurrent ensureWarm
    // returns don't race-fire two smoke runs for the same build.
    this.lastSmokedRev.set(draftId, handle.rev);

    this.bus.emit(draftId, {
      type: 'runtime_smoke_status',
      phase: 'running',
      buildN: handle.rev,
    });

    void this.runDetached({ handle, userEmail, draftId });
  }

  private async runDetached(opts: {
    handle: PreviewHandle;
    userEmail: string;
    draftId: string;
  }): Promise<void> {
    const { handle, userEmail, draftId } = opts;
    let result: RuntimeSmokeResult;
    try {
      const draft = await this.draftStore.load(userEmail, draftId);
      if (!draft) {
        this.bus.emit(draftId, {
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
        this.bus.emit(draftId, {
          type: 'runtime_smoke_status',
          phase: 'failed',
          buildN: handle.rev,
          reason: 'activate_failed',
          activateError: `spec invalid: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }
      result = await invokeToolsOnHandle({
        handle,
        spec,
        ...(this.toolTimeoutMs !== undefined ? { toolTimeoutMs: this.toolTimeoutMs } : {}),
      });
    } catch (err) {
      // invokeToolsOnHandle itself shouldn't throw — but if the
      // handle.toolkit access blows up (cached handle was closed by
      // a concurrent invalidate), surface as activate_failed for UI.
      this.bus.emit(draftId, {
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

    this.bus.emit(draftId, {
      type: 'runtime_smoke_status',
      phase: result.ok ? 'ok' : 'failed',
      buildN: handle.rev,
      reason: result.reason,
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
