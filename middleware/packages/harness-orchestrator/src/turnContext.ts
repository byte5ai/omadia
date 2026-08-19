import { AsyncLocalStorage } from 'node:async_hooks';
import type { AudienceFloorProvider } from './audienceFloorGuard.js';
import type { CommandPolicyProvider } from './commandPolicyGuard.js';
import type { ChatParticipantsProvider } from './chatParticipants.js';
import type { McpInputSentinelMint } from './mcp/pendingMcpInput.js';
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
  /**
   * Omadia user id of the human driving this turn (= turn input `userId`).
   * Set by the orchestrator at turn start. Used by dispatch-time consumers
   * that must attribute per-user data — e.g. MCP→KG ingestion writes the
   * observation with `aclOwners: [userId]` so it is recallable only by its
   * owner. Undefined for system/ad-hoc turns.
   */
  userId?: string;
  /**
   * #430 fixup (reviewer round 5) — the turn caller's CANONICAL `omadiaUserId`
   * uuid, resolved ONCE by `resolveTurnOwnerIdentity` at turn start (see
   * `orchestrator.ts`'s `runTurn`/`chatStream`) and reused by every
   * turn-scoped consumer that needs it for a KnowledgeGraph dataset ACL
   * check — currently `QueryDatasetTool` (viewer/owner filtering) and
   * `ingestAttachments` (dataset ownership on CSV import).
   *
   * Unlike `userId` above (which is the RAW turn input — a Teams AAD oid for
   * a channel turn, already-canonical for HTTP/CLI turns), this field is
   * ALWAYS the canonical uuid when set. Undefined when resolution wasn't
   * possible (no `KnowledgeGraph` wired up for a channel turn, or resolution
   * failed) — callers must treat that as "no identity available", never fall
   * back to the raw `userId` for an ACL decision.
   */
  resolvedOmadiaUserId?: string;
  /**
   * W2-1 (#544) — the turn's session scope (`input.sessionScope`, falling back
   * to the turn id when the caller supplied none), as computed once by the
   * orchestrator entry point.
   *
   * Exists so the MCP manager can key a parked `input_required` record on
   * `{userId, sessionId, correlationId}` without a call-site parameter sweep.
   * NOT safe as a key on its own: `resolveScope` returns the literal
   * `'http-default'` for unscoped HTTP turns, so every such caller shares this
   * value — that was the live cross-user hole in #445. It is one component of
   * the triple, never the whole key.
   */
  sessionScope?: string;
  chatParticipants?: ChatParticipantsProvider;
  /**
   * #575 — resolves the audience floor for this turn: what everyone currently
   * present is jointly permitted to do. Invoked PER tool dispatch rather than
   * once per turn, because a turn-start snapshot is a TOCTOU hole (spec §5.2) —
   * somebody can join between the model deciding to call a tool and the call
   * firing.
   *
   * `undefined` when no audience source is installed, and that means the floor
   * is **not enforced** — not that it is closed. The distinction matters
   * enormously: a closed floor denies everything, so reading "nobody configured
   * this" as "closed" would silently disable every tool in every deployment.
   * Same shape and same reasoning as `privacyHandle` below.
   */
  audienceFloor?: AudienceFloorProvider;
  /**
   * #580 — resolves the shell-normalizing command policy in force for this turn.
   * Read PER tool dispatch by `commandPolicyGuard.guardToolCommands`, which
   * normalizes any command-shaped argument and applies the org floor + cascade.
   *
   * `undefined` when no policy provider is installed, and — exactly like
   * `audienceFloor` above — that means the policy is **not enforced**, not that
   * every command is denied. No shell-execute tool ships yet, so this is inert in
   * every current deployment; the seam exists so the primitive plugs straight in
   * when an execute (or command-carrying connector) tool lands.
   */
  commandPolicy?: CommandPolicyProvider;
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
   * Epic #459 W9 (codex fold) — the identity MCP OAuth tokens are keyed to for
   * this turn. Set by the turn's entry point to the authenticated user so the
   * manager resolves that user's token. Unset outside a user turn; the auth
   * provider then falls back to the operator scope.
   */
  mcpUserKey?: string;
  /**
   * Epic #459 W4/W5 (codex fold) — the persona skill the W8 per-turn router
   * selected as this turn's acting identity, or undefined when no persona is
   * active. Skill-bound MCP DomainTools check it at dispatch: a tool bound to
   * skill X must not be callable on a turn where X is not the active persona
   * (that would exceed the bind-time consent). Set by the orchestrator right
   * after persona routing, mutated on the live store so nested scopes see it.
   */
  activePersonaSkillId?: string;
  /**
   * W2-1 (#544) — outcome of an MCP `input_required` REPLAY performed at turn
   * start, as a note to append to the user's wire message so the model can
   * narrate the result in this same turn.
   *
   * Rides the turn context rather than a parameter for the same reason
   * `privacyHandle` does: it would otherwise need threading through
   * `runTurn → chatInContext → chatInContextInner` and the streaming mirror of
   * all three, on both of which every call site already passes `input`. Written
   * onto the LIVE store inside the turn scope (same technique as
   * `activePersonaSkillId`), read once when the wire messages are assembled.
   *
   * Carries no collected values — those may be secrets the user typed for the
   * server, and this string reaches the LLM and the session log.
   */
  mcpInputReplayNote?: string;
  /**
   * #570 — per-dispatch provenance receipt for the MRTR sentinel.
   *
   * Installed by `dispatchTool` in a nested scope around a SINGLE tool dispatch
   * (one box per call, so concurrent calls in one `allSettled` batch cannot see
   * each other's), and written only by `McpManager.parkInputRequired` when it
   * mints a `[mcp_input_required:<id>]` sentinel. The Privacy Shield reads it
   * back to decide whether a result may skip interning: without this the
   * sentinel is interned like any other tool result and the whole #544 card
   * flow is dead whenever a privacy guard is installed — which is the default.
   *
   * Undefined when no privacy handle is active (nothing interns, so nothing
   * needs exempting) — dispatch then behaves byte-identically to before.
   * See {@link McpInputSentinelMint} for why this is not a string-shape check.
   */
  mcpInputSentinelMint?: McpInputSentinelMint;
}

const storage = new AsyncLocalStorage<TurnContextValue>();

export const turnContext = {
  /** Runs `fn` with `value` as the active turn. Use from regular async fns. */
  run<T>(value: TurnContextValue, fn: () => Promise<T>): Promise<T> {
    return storage.run(value, fn);
  },
  /**
   * Sets the turn context for the current async resource and its descendants.
   *
   * ⚠️ NOT usable from an async generator. `enterWith` binds the store to the
   * async resource that is executing at that instant, but a generator is
   * resumed in the async context of whoever called `.next()` — so the store is
   * gone the moment the generator yields, and every continuation after that
   * point sees either nothing or the CONSUMER's ambient scope. The streaming
   * orchestrator entry point used to do exactly this, which silently broke MCP
   * audit attribution (`callerKind`/`turnId`/`mcpUserKey`) on every streaming
   * turn. Use {@link runGenerator} from generators.
   *
   * Correct uses are plain async functions whose own async chain bounds the
   * scope — e.g. an Express route handler establishing a per-request identity.
   */
  enter(value: TurnContextValue): void {
    storage.enterWith(value);
  },
  /**
   * Establishes `value` for the entire lifetime of an async generator — the
   * `run()` equivalent that composes with `yield`.
   *
   * Every advance of the inner generator is performed inside `storage.run`, so
   * the context is active for exactly the spans that execute generator body
   * code, and is NOT active while the consumer processes a yielded value.
   * `value` is passed by reference on every step, so writes onto the live store
   * (`activePersonaSkillId`, `mcpInputReplayNote`) stay visible to later steps
   * — same semantics `run()` gives a plain async function.
   */
  runGenerator<T>(
    value: TurnContextValue,
    makeGenerator: () => AsyncGenerator<T>,
  ): AsyncGenerator<T> {
    return runGeneratorInContext(value, makeGenerator);
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
        // W3-A: the caller identity MCP OAuth tokens are keyed to must survive
        // an adapter-established outer scope, or every audited MCP call on a
        // channel turn records `unresolved` and a `per_user` server fails closed.
        ...(prev?.mcpUserKey ? { mcpUserKey: prev.mcpUserKey } : {}),
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

/**
 * Implementation of {@link turnContext.runGenerator}. Kept as a module-level
 * generator function (rather than inline) so it can `yield` while still owning
 * the `storage.run` wrapping of every `next()`.
 */
async function* runGeneratorInContext<T>(
  value: TurnContextValue,
  makeGenerator: () => AsyncGenerator<T>,
): AsyncGenerator<T> {
  // Create inside the scope too: a factory that reads the context eagerly
  // (before its first yield) then behaves the same as one that reads it later.
  const inner = storage.run(value, makeGenerator);
  let exhausted = false;
  try {
    for (;;) {
      const step = await storage.run(value, () => inner.next());
      if (step.done) {
        exhausted = true;
        return;
      }
      yield step.value;
    }
  } finally {
    // The consumer broke out of its loop or threw. Drive the inner generator's
    // own `finally` blocks (steering-bus teardown, privacy finalisation) INSIDE
    // the turn scope — outside it they would run context-less, which is the
    // very bug this helper exists to prevent.
    //
    // Teardown NEVER replaces the exit reason. `inner.return(undefined)` was
    // awaited bare, and a throwing finaliser (privacy finalisation is the
    // realistic one) inside a `finally` block REPLACES the completion of the
    // whole generator: the client abort or upstream error that actually ended
    // the turn was overwritten by a secondary teardown failure, and the real
    // reason — the one worth debugging — was gone. So the teardown failure is
    // caught and reported here instead of being allowed to propagate. It is not
    // swallowed: {@link onTurnTeardownError} always sees it, and the caller
    // still gets the original reason.
    if (!exhausted) {
      try {
        await storage.run(value, async () => {
          await inner.return(undefined);
        });
      } catch (err: unknown) {
        reportTurnTeardownError(value.turnId, err);
      }
    }
  }
}

/** Handler for a teardown failure. Overridable so a test can assert the error
 *  is surfaced rather than inferring it from console output. */
let turnTeardownErrorHandler: (turnId: string, err: unknown) => void = (
  turnId,
  err,
) => {
  console.error(
    `[turnContext] teardown of turn '${turnId}' threw while finalising ` +
      `(steering-bus teardown / privacy finalisation). The turn's original exit ` +
      `reason was preserved and is what the caller sees; this is the secondary ` +
      `failure:`,
    err,
  );
};

/**
 * Install a teardown-error handler. Returns a restore function.
 *
 * Exists because a teardown failure is deliberately not thrown (see
 * `runGeneratorInContext`), so without a hook the only evidence would be a log
 * line — which is neither assertable nor routable to real error reporting.
 */
export function onTurnTeardownError(
  handler: (turnId: string, err: unknown) => void,
): () => void {
  const previous = turnTeardownErrorHandler;
  turnTeardownErrorHandler = handler;
  return (): void => {
    turnTeardownErrorHandler = previous;
  };
}

function reportTurnTeardownError(turnId: string, err: unknown): void {
  try {
    turnTeardownErrorHandler(turnId, err);
  } catch {
    /* a reporter that throws must not become the exit reason either */
  }
}

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
