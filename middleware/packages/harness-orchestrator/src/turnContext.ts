import { AsyncLocalStorage } from 'node:async_hooks';
import type { ChatParticipantsProvider } from './chatParticipants.js';
import type { PrivacyTurnHandle } from './privacyHandle.js';

/**
 * Per-turn context that propagates implicitly through every `await` triggered
 * during a single orchestrator turn — via Node's AsyncLocalStorage.
 *
 * Carries:
 *   - `turnId`   — stable identifier for EntityRefBus / session-logger
 *                  correlation across concurrent Teams conversations.
 *   - `turnDate` — the frozen "today" for this turn, as `YYYY-MM-DD` in
 *                  Europe/Berlin. Set once at turn start and read by every
 *                  `messages.create` site (orchestrator + sub-agents) so a
 *                  turn that rolls past midnight keeps a single, consistent
 *                  date throughout. Without this the Claude models guess
 *                  from training-data era (usually 2025) and silently
 *                  corrupt "letzte 3 Monate"-style Odoo queries.
 *   - `chatParticipants` (optional) — lazy accessor for the active chat's
 *                  roster. Set by the Teams adapter (via TeamsRosterProvider)
 *                  in an outer ALS scope; the orchestrator re-threads it into
 *                  its own child scope so the `get_chat_participants` tool
 *                  can resolve the roster without the orchestrator knowing
 *                  anything about Teams. Undefined for non-channel turns
 *                  (HTTP /api/chat, tests) — callers must degrade gracefully.
 *
 * Usage:
 * - Entry points (orchestrator.chat / orchestrator.chatStream) compute
 *   both fields and establish context with `run(value, fn)` or `enter(value)`.
 * - Downstream code reads `currentTurnId()` / `currentTurnDate()`. The date
 *   helper falls back to a fresh value when called outside any turn context
 *   (unit tests, ad-hoc invocations) so callers never need a guard.
 */
export interface TurnContextValue {
  turnId: string;
  turnDate: string;
  chatParticipants?: ChatParticipantsProvider;
  /**
   * Privacy-Proxy Slice 2.1: per-turn privacy handle threaded through the
   * call tree so every `messages.create` / `messages.stream` site can
   * tokenise outbound payloads + restore inbound tokens without an
   * explicit parameter sweep. Set by the orchestrator at the start of
   * `chatInContextInner` when a `privacy.redact@1` provider is registered;
   * undefined when no provider is installed (then call sites pass
   * payloads through unmodified — byte-identical pre-plugin behaviour).
   */
  privacyHandle?: PrivacyTurnHandle;
}

const storage = new AsyncLocalStorage<TurnContextValue>();

export const turnContext = {
  /** Runs `fn` with `value` as the active turn. Use from regular async fns. */
  run<T>(value: TurnContextValue, fn: () => Promise<T>): Promise<T> {
    return storage.run(value, fn);
  },
  /**
   * Sets the turn context for the current async resource and its descendants.
   * Used from async generators (`chatStream`) because AsyncLocalStorage.run()
   * doesn't compose with `yield`. Scope is bounded by the enclosing HTTP
   * request — a new request creates a fresh async resource chain.
   */
  enter(value: TurnContextValue): void {
    storage.enterWith(value);
  },
  /**
   * Runs `fn` in an outer scope that only installs a `chatParticipants`
   * provider — turnId/turnDate are left as placeholders the orchestrator
   * will overwrite in its own `run()`. Used by channel adapters (Teams)
   * to hand the tool a way to resolve the roster without needing to know
   * a valid turnId up-front.
   */
  runWithChatParticipants<T>(
    chatParticipants: ChatParticipantsProvider,
    fn: () => Promise<T>,
  ): Promise<T> {
    const prev = storage.getStore();
    return storage.run(
      {
        turnId: prev?.turnId ?? '',
        turnDate: prev?.turnDate ?? today(),
        chatParticipants,
        ...(prev?.privacyHandle ? { privacyHandle: prev.privacyHandle } : {}),
      },
      fn,
    );
  },
  /** Full context object, or undefined when called outside any turn. */
  current(): TurnContextValue | undefined {
    return storage.getStore();
  },
  /** Convenience accessor. Undefined outside any turn context. */
  currentTurnId(): string | undefined {
    return storage.getStore()?.turnId;
  },
  /**
   * The turn's frozen date as `YYYY-MM-DD`. Falls back to a fresh
   * Europe/Berlin date when called outside any turn — keeps tests and
   * ad-hoc invocations correct.
   */
  currentTurnDate(): string {
    return storage.getStore()?.turnDate ?? today();
  },
};

/** `YYYY-MM-DD` in Europe/Berlin. Single place this computation lives. */
export function today(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
  }).format(new Date());
}

/**
 * The date-grounding preamble Claude sees before any stable system prompt
 * content. Derived from the turn's frozen date so every `messages.create`
 * site in a single turn speaks the same "today", no matter how deep in the
 * tool loop or which sub-agent.
 *
 * Packaged as a dedicated system block so the stable prompt next to it stays
 * cache-eligible across turns.
 */
export function buildDateHeader(date: string): string {
  const weekday = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    weekday: 'long',
  }).format(new Date(`${date}T12:00:00Z`));
  return `Heute ist ${weekday}, der ${date} (Europa/Berlin). Rechne jede relative Zeitangabe ("die letzten N Monate", "dieses Quartal", "gestern", "Q1") strikt gegen dieses Datum — niemals gegen dein Trainings-Cutoff. Wenn du bei einem konkreten Datum unsicher bist, frag zurück statt zu raten.`;
}
