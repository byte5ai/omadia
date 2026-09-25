import { isNoReply, logNoReplyDrop } from '@omadia/channel-sdk';
import type { ChatSessionStore } from '@omadia/orchestrator';

import type { ProactiveSender } from './proactiveSender.js';

/**
 * #1071 — the proactive sender for the browser chat (`channel: 'web'`).
 *
 * Delivery surface: the web chat's own history store (`ChatSessionStore`,
 * `/memories/chat-sessions/<id>.json`). A scheduled routine's output is
 * appended to the ORIGINATING chat as an assistant message marked
 * `proactive`, so the user sees it when they open or re-focus that chat.
 * There is no live push: the web chat has no realtime channel (the WebSocket
 * registry serves channel plugins, SSE serves the builder), so the web UI
 * re-reads the active chat when /chat mounts, after hydration, on chat switch
 * and on visibility change, and folds deliveries into its local copy.
 *
 * Deliberate limits:
 *  - A deleted chat is NOT recreated. `send` throws; the runner records it as
 *    `last_run_error` and keeps the routine active (ProactiveSender contract).
 *  - A `NO_REPLY` answer (the orchestrator's default for a routine with
 *    nothing to report) is dropped, not delivered — as on every other
 *    channel. The run is recorded `ok`: saying nothing was the intent.
 *  - Text only. `cardBody` / `approval` are ignored; `message.text` already
 *    carries the markdown fallback, and the session schema persists no
 *    attachments for any message. Dropped attachments and interactive cards
 *    (`message.interactive`) are logged; an empty
 *    answer throws so the run is not recorded as `ok` with nothing delivered.
 */

/** Routine `channel` value of the browser chat. */
export const WEB_ROUTINE_CHANNEL = 'web';

/**
 * The web chat's delivery handle. `sessionScope` is the orchestrator scope of
 * the creating turn (kept for correlation); `sessionId` names the persisted
 * chat the output is delivered into. It is absent when the creating turn ran
 * under a debug `scope` or without a saved chat — such a routine has nowhere
 * to deliver and is refused at create time.
 */
export interface WebChatConversationRef {
  kind: 'http-chat';
  sessionScope: string;
  sessionId?: string;
}

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

export function webChatConversationRef(
  sessionScope: string,
  sessionId?: string,
): WebChatConversationRef {
  return {
    kind: 'http-chat',
    sessionScope,
    ...(sessionId !== undefined ? { sessionId } : {}),
  };
}

export const WEB_CHAT_NO_CONVERSATION_ERROR =
  'this routine was requested outside a saved web chat, so there is no conversation ' +
  'to deliver it into; start it from a chat tab';

/** The target chat id of a web routine, or a thrown explanation why there is none. */
function targetSessionId(ref: unknown): string {
  if (typeof ref !== 'object' || ref === null) {
    throw new Error(WEB_CHAT_NO_CONVERSATION_ERROR);
  }
  const r = ref as Record<string, unknown>;
  const sessionId = r['sessionId'];
  if (r['kind'] !== 'http-chat' || typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
    throw new Error(WEB_CHAT_NO_CONVERSATION_ERROR);
  }
  return sessionId;
}

export interface WebChatProactiveSenderOptions {
  /** Live resolver — the store is published by the orchestrator plugin and
   *  can appear after boot (LLM-key hot-enable). */
  getStore: () => ChatSessionStore | undefined;
  log?: (msg: string) => void;
  now?: () => number;
}

export function createWebChatProactiveSender(
  opts: WebChatProactiveSenderOptions,
): ProactiveSender {
  const log = opts.log ?? ((m: string) => console.log(m));
  const now = opts.now ?? (() => Date.now());
  return {
    channel: WEB_ROUTINE_CHANNEL,
    validateConversationRef(ref: unknown): void {
      targetSessionId(ref);
    },
    async send({ conversationRef, message, routine }): Promise<void> {
      const sessionId = targetSessionId(conversationRef);
      // Checked before the store lookup and the empty-text throw: a quiet run
      // must neither post the literal sentinel into the chat nor fail.
      if (isNoReply(message)) {
        logNoReplyDrop(WEB_ROUTINE_CHANNEL, {
          trigger: 'routine',
          sessionId,
          ...(routine ? { routineId: routine.id, routineName: routine.name } : {}),
        });
        return;
      }
      const store = opts.getStore();
      if (!store) {
        throw new Error('web chat is not configured (no chat session store)');
      }
      const attachmentCount = message.attachments?.length ?? 0;
      // An empty answer must fail the run: returning quietly would record it
      // as `ok` while the user receives nothing (a diagram- or file-only turn
      // has an empty `text`). Thrown, it lands in `last_run_error`.
      if (message.text.trim().length === 0) {
        throw new Error(
          attachmentCount > 0
            ? `routine produced only attachments (${String(attachmentCount)}), which the web chat delivery cannot carry; nothing was delivered`
            : 'routine produced an empty answer; nothing was delivered to the web chat',
        );
      }
      if (attachmentCount > 0) {
        log(
          `[routines/web-sender] WARN chat '${sessionId}'${routine ? ` (routine ${routine.id})` : ''}: dropped ${String(attachmentCount)} attachment(s) — web delivery is text-only`,
        );
      }
      if (message.interactive) {
        log(
          `[routines/web-sender] WARN chat '${sessionId}'${routine ? ` (routine ${routine.id})` : ''}: dropped interactive '${message.interactive.kind}' — web delivery is text-only`,
        );
      }
      const outcome = await store.appendProactiveMessage(sessionId, {
        content: message.text,
        deliveredAt: now(),
        ...(routine ? { routineId: routine.id, routineName: routine.name } : {}),
      });
      if (outcome === 'not_found') {
        throw new Error(`web chat conversation '${sessionId}' no longer exists`);
      }
    },
  };
}
