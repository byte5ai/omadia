import { EventEmitter } from 'node:events';

import type { JsonPatch } from './specPatcher.js';

/**
 * Origin of a mutation. `agent` events come from the BuilderAgent's tool
 * calls, `user` events come from inline-editor PATCH endpoints,
 * `eslint-autofix` events come from the slot-typecheck pipeline's
 * pre-tsc auto-fix pass (OB-46) when a slot's source was rewritten by
 * ESLint and persisted back to the DraftStore. The frontend uses the
 * cause to render the turn-log entry distinctly ("ESLint auto-fix
 * applied to slot `<key>`") so the operator sees the trail explicitly
 * instead of an unattributed mutation.
 */
export type SpecBusCause = 'agent' | 'user' | 'eslint-autofix';

/**
 * Events emitted on the per-draft EventEmitter. The Builder UI (and the
 * preview rebuild scheduler) subscribes to these to react to spec/slot
 * mutations as they happen.
 *
 * `build_status` (B.6-6) lets the Workspace header surface a live
 * indicator regardless of whether the rebuild was triggered by a chat
 * turn (PreviewStreamEvent path) or a bare `PATCH /spec` (this path).
 * The phase ordering is `building` → `ok` | `failed`; `building` may
 * fire many times before the corresponding terminal — clients should
 * treat the latest state as authoritative.
 */
export type SpecBusEvent =
  | { type: 'spec_patch'; patches: JsonPatch[]; cause: SpecBusCause }
  | { type: 'slot_patch'; slotKey: string; source: string; cause: SpecBusCause }
  | { type: 'lint_result'; issues: ReadonlyArray<unknown>; cause: SpecBusCause }
  | {
      type: 'build_status';
      phase: 'building' | 'ok' | 'failed';
      buildN?: number;
      reason?: string;
      errorCount?: number;
      /** Structured tsc errors (per-file, per-line) — surfaced so the
       *  Slot-Editor can hang Monaco markers on the exact source lines
       *  instead of forcing the operator to read a stderr-tail. Capped
       *  at 50 entries to keep the SSE frame size sane. Field name `file`
       *  matches the existing BuildErrorRow wire shape used by the
       *  Preview pane's PreviewStreamEvent.error path. */
      errors?: ReadonlyArray<{
        file: string;
        line: number;
        column: number;
        code: string;
        message: string;
      }>;
    }
  | {
      /**
       * B.7-6: Builder-Agent could not fix a slot after the configured
       * retry limit (default 3) within a single turn. Emitted by
       * `fill_slot` when the Nth re-call still returns `ok: false`. The
       * frontend hangs an orange banner in PreviewChatPane asking the
       * operator to inspect the slot manually. Auto-cleared on the next
       * successful `fill_slot` for the same slotKey or at the start of
       * the next turn.
       */
      type: 'agent_stuck';
      slotKey: string;
      attempts: number;
      lastReason: string;
      lastSummary: string;
      lastErrorCount: number;
    }
  | {
      /**
       * B.9-3: Runtime-smoke status surfaced after every successful
       * preview build. Fires asynchronously — `running` immediately
       * after build_status:ok, then `ok` / `failed` once each tool was
       * invoked with a synthetic input. Per-tool results carry status
       * + errorMessage so the UI can pinpoint which tool blew up.
       */
      type: 'runtime_smoke_status';
      phase: 'running' | 'ok' | 'failed';
      buildN: number;
      reason?:
        | 'ok'
        | 'activate_failed'
        | 'tool_failures'
        | 'no_tools'
        | 'admin_route_schema_violation';
      activateError?: string;
      results?: ReadonlyArray<{
        toolId: string;
        status: 'ok' | 'timeout' | 'threw' | 'validation_failed';
        durationMs: number;
        errorMessage?: string;
      }>;
      /**
       * Theme D — admin-route smoke results, surfaced after tool smoke
       * completes for plugins that registered routes via
       * `ctx.routes.register`. Empty for plugins with no routes.
       */
      adminRouteResults?: ReadonlyArray<{
        endpoint: string;
        status:
          | 'ok'
          | 'empty_warning'
          | 'schema_violation'
          | 'http_error'
          | 'timeout'
          | 'introspection_failed';
        httpStatus?: number;
        durationMs: number;
        reason?: string;
      }>;
    }
  | {
      /**
       * Option-C, C-4: AutoFixOrchestrator surfaces its trigger
       * lifecycle. Emitted on every reaction to build_status:failed
       * or runtime_smoke_status:failed when the draft has the
       * `builder_settings.auto_fix_enabled` flag set.
       *
       *   `triggered`    — orchestrator is firing a synthetic
       *                    Builder turn now. The frontend renders
       *                    a compact "Auto-Fix #N läuft" indicator.
       *   `stopped_loop` — the same error fingerprint repeated for
       *                    the Nth consecutive auto-attempt
       *                    (default cap: 3). The orchestrator
       *                    refuses to fire again, PATCHes
       *                    `auto_fix_enabled: false` so the next
       *                    failure does not silently re-arm, and
       *                    surfaces an operator-needed banner.
       *
       * `kind` mirrors the failure source. `identicalCount` is set
       * on `stopped_loop` so the UI can quote the exact retry count.
       */
      type: 'auto_fix_status';
      phase: 'triggered' | 'stopped_loop';
      kind: 'build_failed' | 'smoke_failed';
      buildN: number;
      identicalCount?: number;
    };

export type SpecBusListener = (event: SpecBusEvent) => void;

const EVENT_NAME = 'event';

/**
 * Per-draft event bus. Each draft gets its own `EventEmitter`, lazy-created on
 * first subscribe and garbage-collected when the last listener leaves.
 *
 * Why per-draft (not per-session): two browser tabs editing the same draft
 * must see each other's user-edits and the agent's tool-call patches. A
 * per-session bus would route edits from tab A only to tab A.
 */
export class SpecEventBus {
  private readonly emitters = new Map<string, EventEmitter>();

  /**
   * Subscribe a listener for a draft. Returns an unsubscribe function. When
   * the last listener for a draft unsubscribes, the underlying emitter is
   * dropped to avoid a `Map` leak across long-lived processes.
   */
  subscribe(draftId: string, listener: SpecBusListener): () => void {
    let emitter = this.emitters.get(draftId);
    if (!emitter) {
      emitter = new EventEmitter();
      // Builder draft may have many concurrent observers (multi-tab + scheduler
      // + builder UI). Default of 10 is too tight; lift to silence warnings
      // without going to Infinity (still want to catch genuine leaks).
      emitter.setMaxListeners(64);
      this.emitters.set(draftId, emitter);
    }
    emitter.on(EVENT_NAME, listener);

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const e = this.emitters.get(draftId);
      if (!e) return;
      e.off(EVENT_NAME, listener);
      if (e.listenerCount(EVENT_NAME) === 0) {
        this.emitters.delete(draftId);
      }
    };
  }

  /**
   * Emit an event to all subscribers of `draftId`. No-op if the draft has no
   * subscribers — emitting before anyone listens is fine and matches typical
   * lifecycle (agent patches a draft before the UI mounts).
   */
  emit(draftId: string, event: SpecBusEvent): void {
    const emitter = this.emitters.get(draftId);
    if (!emitter) return;
    emitter.emit(EVENT_NAME, event);
  }

  /** Number of active subscribers for a draft (0 if no emitter). */
  listenerCount(draftId: string): number {
    return this.emitters.get(draftId)?.listenerCount(EVENT_NAME) ?? 0;
  }

  /** Number of drafts with at least one active subscriber. Test-only helper. */
  activeDraftCount(): number {
    return this.emitters.size;
  }
}
