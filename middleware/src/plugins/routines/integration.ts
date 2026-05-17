import {
  type RoutineListAttachmentInput,
  type RoutinesIntegration,
} from '@omadia/plugin-api';

import type { RoutinesHandle } from './initRoutines.js';
import { createProactiveSender } from './genericProactiveSender.js';
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
): RoutinesIntegration {
  return {
    captureRoutineTurn(info) {
      routineTurnContext.enter({
        tenant: info.tenant,
        userId: info.userId,
        channel: info.channel,
        conversationRef: info.conversationRef,
      });
    },

    publishProactiveSend(channel, send) {
      handle.senderRegistry.register(
        createProactiveSender(channel, async (ref, msg, routine) => {
          await send(
            ref,
            {
              text: msg.text,
              ...(msg.cardBody !== undefined ? { cardBody: msg.cardBody } : {}),
            },
            routine,
          );
        }),
      );
    },

    async handleRoutineAction({ action, id }) {
      if (action === 'pause') {
        const updated = await handle.runner.pauseRoutine(id);
        return `Routine "${updated.name}" pausiert.`;
      }
      if (action === 'resume') {
        const updated = await handle.runner.resumeRoutine(id);
        return `Routine "${updated.name}" wieder aktiv.`;
      }
      if (action === 'trigger_now') {
        const updated = await handle.runner.triggerRoutineNow(id);
        const status = updated.lastRunStatus ?? 'ok';
        return status === 'ok'
          ? `Routine "${updated.name}" wurde manuell ausgelöst — Antwort kommt gleich.`
          : `Routine "${updated.name}" lief manuell, aber mit Status "${status}" — siehe Operator-UI für Details.`;
      }
      const ok = await handle.runner.deleteRoutine(id);
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
