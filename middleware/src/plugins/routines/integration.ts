import {
  type RoutineListAttachmentInput,
  type RoutineTurnInput,
  type RoutinesIntegration,
} from '@omadia/plugin-api';

import type { RoutinesHandle } from './initRoutines.js';
import { createProactiveSender } from './genericProactiveSender.js';
import { actorScope, type ManageRoutineContext } from './manageRoutineTool.js';
import { RoutineNotActiveError, type RoutineActorScope } from './routineRunner.js';
import { recordUnscopedRoutineAction } from './unscopedActionMetrics.js';
import {
  ADAPTIVE_CARD_CONTENT_TYPE,
  buildRoutineListSmartCard,
  buildRoutineSmartCard,
} from './routineSmartCard.js';
import { routineTurnContext } from './routineTurnContext.js';

/**
 * Phase 5B factory: turn a RoutinesHandle into a service object the
 * kernel publishes under `routinesIntegration`. Channel plugins
 * (Teams etc.) late-resolve this and wire the five callbacks without
 * needing constructor-injected Deps.
 *
 * The factory captures the handle by reference; closures stay valid for
 * the lifetime of the handle (process lifetime in the routines path
 * since `routinesHandle.close()` only fires on graceful shutdown).
 */
export function createRoutinesIntegration(
  handle: RoutinesHandle,
  /** Optional per-turn observer — the kernel uses it to persist a Conductor channel binding for
   *  reminders, without coupling routines to Conductor. Best-effort: failures must not break a turn. */
  onTurnCaptured?: (info: { userId: string; principalRef?: string; channel: string; conversationRef: unknown }) => void,
): RoutinesIntegration {
  /** The ALS value both turn-capture entry points install. */
  function contextFor(info: RoutineTurnInput): ManageRoutineContext {
    return {
      tenant: info.tenant,
      userId: info.userId,
      channel: info.channel,
      conversationRef: info.conversationRef,
      canTargetOthers: info.canTargetOthers ?? false,
    };
  }

  /** Conductor channel binding for reminders. Best-effort, never fatal. */
  function notifyTurnCaptured(info: RoutineTurnInput): void {
    try {
      onTurnCaptured?.({ userId: info.userId, principalRef: info.principalRef, channel: info.channel, conversationRef: info.conversationRef });
    } catch {
      // never let a binding-capture error break the inbound turn
    }
  }

  return {
    captureRoutineTurn(info) {
      routineTurnContext.enter(contextFor(info));
      notifyTurnCaptured(info);
    },

    /**
     * #1086 — the scoped sibling of `captureRoutineTurn`.
     *
     * Same principal, same Conductor binding, but `run` instead of `enterWith`:
     * the context is gone again when a segment settles. `captureRoutineTurn`
     * cannot offer that — it returns before the turn runs, so it has nothing to
     * scope — and its leak-forward is what #1016 had to build a staleness guard
     * against. Callers that CAN wrap the turn (the kernel's channel-agnostic
     * producer in `CoreApi.handleTurnStream`, and any adapter that controls its
     * own turn body) should prefer this one.
     *
     * Turn-scoped work happens HERE, not in the returned runner: a streaming
     * caller invokes the runner once per pull, so a Conductor binding written
     * inside it would be written once per streamed event instead of once per
     * turn.
     */
    beginRoutineTurn(info) {
      notifyTurnCaptured(info);
      const ctx = contextFor(info);
      return (fn) => routineTurnContext.run(ctx, fn);
    },

    async updateRoutineConversationRef(routineId, conversationRef) {
      await handle.runner.updateConversationRef(routineId, conversationRef);
    },

    publishProactiveSend(channel, send) {
      handle.senderRegistry.register(
        createProactiveSender(channel, async (ref, msg, routine) => {
          await send(
            ref,
            {
              text: msg.text,
              ...(msg.cardBody !== undefined ? { cardBody: msg.cardBody } : {}),
              ...(msg.approval !== undefined ? { approval: msg.approval } : {}),
            },
            routine,
          );
        }),
      );
    },

    /**
     * #1025 — the smart-card buttons are the SECOND door onto the same
     * mutations as `manage_routine`, and they were equally unscoped: the
     * card carries the routine id, so a replayed or hand-crafted action
     * payload reached pause/resume/trigger/delete for any id.
     *
     * #1029 — the first version of this refused when no turn context was
     * present, which would have broken all four buttons in production.
     * The Teams adapter dispatches card clicks out-of-band: `handleMessage`
     * takes the routine branch and returns before `runOrchestratorTurn`,
     * so `captureRoutineTurn` never fires and `current()` is always
     * undefined on this path. Refusing there is not a safe default, it is
     * an outage.
     *
     * Precedence, documented in the contract next to the `actor` field:
     *   1. `actor` from the channel — the only source that is correct on
     *      the out-of-band path, because the adapter holds the activity.
     *   2. the per-turn context, for clicks that do arrive inside a
     *      captured turn.
     *   3. neither ⇒ proceed UNSCOPED as before #1025, and record it.
     *
     * Case 3 keeps a known hole open on purpose, and counts every use so
     * it is observable rather than silent. It disappears the moment the
     * adapter passes `actor`.
     */
    async handleRoutineAction({ action, id, actor }) {
      const ctx = routineTurnContext.current();
      const scope: RoutineActorScope = actor
        ? { kind: 'channel-user', tenant: actor.tenant, userId: actor.userId }
        : ctx
          ? actorScope(ctx)
          : { kind: 'operator' };
      if (!actor && !ctx) {
        recordUnscopedRoutineAction(action, id);
      }
      if (action === 'pause') {
        const updated = await handle.runner.pauseRoutine(id, scope);
        return `Routine "${updated.name}" pausiert.`;
      }
      if (action === 'resume') {
        const updated = await handle.runner.resumeRoutine(id, scope);
        return `Routine "${updated.name}" wieder aktiv.`;
      }
      if (action === 'trigger_now') {
        let updated;
        try {
          updated = await handle.runner.triggerRoutineNow(id, scope);
        } catch (err) {
          if (err instanceof RoutineNotActiveError) {
            return `Routine "${err.routineName}" ist pausiert — erst fortsetzen, dann auslösen.`;
          }
          throw err;
        }
        const status = updated.lastRunStatus ?? 'ok';
        return status === 'ok'
          ? `Routine "${updated.name}" wurde manuell ausgelöst — Antwort kommt gleich.`
          : `Routine "${updated.name}" lief manuell, aber mit Status "${status}" — siehe Operator-UI für Details.`;
      }
      const ok = await handle.runner.deleteRoutine(id, scope);
      return ok
        ? 'Routine gelöscht.'
        : 'Routine wurde bereits gelöscht oder nicht gefunden.';
    },

    buildRoutineSmartCardAttachment(input) {
      return {
        contentType: ADAPTIVE_CARD_CONTENT_TYPE,
        content: buildRoutineSmartCard({
          routine: input.routine,
          body: input.body,
          ...(input.bodyItems !== undefined
            ? { bodyItems: input.bodyItems }
            : {}),
        }),
      };
    },

    buildRoutineListSmartCardAttachment(input: RoutineListAttachmentInput) {
      return {
        contentType: ADAPTIVE_CARD_CONTENT_TYPE,
        content: buildRoutineListSmartCard(input),
      };
    },
  };
}
