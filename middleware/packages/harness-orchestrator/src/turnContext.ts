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
  /**
   * Per-orchestrator isolation — slug of the Agent (orchestrator) handling
   * this turn. Set by the orchestrator at turn start (= `this.agentId`).
   * Read by the per-call MemoryAccessor so a plugin's notes land under the
   * active orchestrator's namespace, and available to any other turn-scoped
   * consumer that needs the Agent identity. Undefined outside a turn (ad-hoc
   * invocations, activate-time plugin writes) → callers fall back to
   * `'default'`.
   */
  agentSlug?: string;
  chatParticipants?: ChatParticipantsProvider;
  /**
   * Privacy-Proxy Slice 2.1: per-turn privacy handle threaded through the
   * call tree so every tool-dispatch site can intern raw tool results
   * behind the Privacy Shield v4 Data-Plane Boundary without an explicit
   * parameter sweep. Set by the orchestrator at the start of the turn
   * when a `privacy.redact@1` provider is registered; undefined when no
   * provider is installed (then tool results flow through unmodified).
   */
  privacyHandle?: PrivacyTurnHandle;
  /**
   * Phase C.2 — Raw tool-result capture hook. When set by an outer scope
   * (currently: the routine runner), every tool dispatch site (main agent
   * + sub-agents) invokes this callback with the RAW handler-returned
   * result BEFORE `privacy.internToolResultV4` interns it. The callback
   * is responsible for stashing the value somewhere it can be consumed
   * later (typically `routineTurnContext.currentRawToolResults()` from
   * the routines plugin). Repeat calls for the same tool name overwrite
   * the previous entry — last-write-wins.
   *
   * Undefined for chat turns and non-templated routine turns; tool
   * dispatch then skips the capture and behaves byte-identically to
   * pre-C.2.
   */
  captureRawToolResult?: (toolName: string, rawResult: string) => void;
  /**
   * Canvas sentinel tap (Omadia UI). Set by the ui-orchestrator around a
   * canvas turn: every dispatch site hands a sentinel-bearing RAW tool
   * result (`_pending*` canvas directives) here BEFORE the privacy guard
   * interns it. The surface synthesis then composes patches from ground
   * truth — including server-side resolved dataset rows the LLM must never
   * see — while the LLM keeps receiving only the interned digest.
   * Undefined outside canvas turns (and on guard-less servers the streamed
   * result still carries the sentinel anyway); dispatch then behaves
   * byte-identically to before.
   */
  canvasSentinelSink?: (toolName: string, rawResult: string) => void;
  /**
   * Privacy Shield v4 — sub-agent data-plane bridge. Set by the
   * orchestrator in a nested scope around a single domain-tool dispatch
   * (one per call, so concurrent sub-agents each get their own array via
   * AsyncLocalStorage). Every `internToolResultV4` a sub-agent runs inside
   * that scope pushes its `datasetId` here; the orchestrator then hands the
   * parent agent the digests of those REAL datasets instead of re-interning
   * the sub-agent's `[masked]`-baked prose. Undefined outside a domain-tool
   * dispatch — sub-agent interning then behaves byte-identically to before.
   */
  subAgentDatasetSink?: string[];
  /**
   * Slice 2.5 — sub-agent bypass flag. Set by the orchestrator in a
   * nested scope around a single domain-tool dispatch (alongside
   * `subAgentDatasetSink`). Flipped to `true` by `dispatchTool` whenever
   * a tool call inside that scope honors the operator's per-plugin
   * `bypass` setting and returns raw. The parent dispatch reads this at
   * the end of the sub-agent run: if set AND `subAgentDatasetSink` is
   * empty, it passes the sub-agent's narration through raw (instead of
   * interning it) — because the sub-agent already saw real values for
   * the bypassed tools, its narration already carries real content and
   * re-interning would mask the synthesis the user is asking for.
   *
   * Mutable holder so the inner scope's writes are visible to the outer
   * scope's reader after `turnContext.run(...)` returns. Undefined
   * outside a domain-tool dispatch.
   */
  subAgentBypassFlag?: { value: boolean };
  /**
   * Slice 2.5 — agent plugin id (manifest `identity.id`) of the
   * currently-executing sub-agent's owning agent. Set by the
   * orchestrator in the nested scope around a domain-tool dispatch
   * (alongside `subAgentDatasetSink` and `subAgentBypassFlag`) BEFORE
   * the sub-agent's tool loop runs. Read by the privacy bypass resolver
   * inside `LocalSubAgent.dispatchToolToTool` to look up the operator's
   * `_privacy_mode` on the OWNING agent — so a single bypass setting
   * on (e.g.) `@omadia/agent-confluence` applies to every
   * `confluence_search` / `confluence_get_page` call the sub-agent
   * makes, regardless of which integration plugin contributed the
   * underlying tool. Undefined outside a domain-tool dispatch.
   */
  subAgentOwnerPluginId?: string;
  /**
   * MCP call attribution overrides (epic #459 W2, issue #462). The audit
   * observer in `McpManager.callTool` derives the caller taxonomy
   * (agent | subagent | skill | plugin | unattributed) from the turn context;
   * these two fields let a non-agent dispatch surface identify itself: the
   * skill-binding path (#456) sets `mcpCallerKind: 'skill'` +
   * `mcpCallerId: <skill slug>`, the plugin accessor (#458) sets
   * `'plugin'` + the plugin id. Unset for plain agent/sub-agent turns.
   */
  mcpCallerKind?: 'skill' | 'plugin';
  mcpCallerId?: string;
  /**
   * Epic #459 W4/W5 (codex fold) — the persona skill the W8 per-turn router
   * selected as this turn's acting identity, or undefined when no persona is
   * active. Skill-bound MCP DomainTools check it at dispatch: a tool bound to
   * skill X must not be callable on a turn where X is not the active persona
   * (that would exceed the bind-time consent). Set by the orchestrator right
   * after persona routing, mutated on the live store so nested scopes see it.
   */
  activePersonaSkillId?: string;
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
        ...(prev?.agentSlug ? { agentSlug: prev.agentSlug } : {}),
        chatParticipants,
        ...(prev?.privacyHandle ? { privacyHandle: prev.privacyHandle } : {}),
        ...(prev?.captureRawToolResult
          ? { captureRawToolResult: prev.captureRawToolResult }
          : {}),
        ...(prev?.canvasSentinelSink
          ? { canvasSentinelSink: prev.canvasSentinelSink }
          : {}),
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
   * The Agent (orchestrator) slug handling the active turn, or undefined
   * outside any turn context. Used for per-orchestrator memory/KG isolation.
   */
  currentAgentSlug(): string | undefined {
    return storage.getStore()?.agentSlug;
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
