import type { PrivacyReceipt } from '@omadia/plugin-api';
import type { FollowUpOption, SemanticAnswer } from './outgoing.js';

/**
 * Orchestrator surface contract — the duck-typed interface every chat-handling
 * implementation satisfies (the concrete `Orchestrator` class plus any
 * wrappers like the answer-verifier's `VerifierService`). Channel adapters
 * (Teams, Telegram, the HTTP dev route) hold a `ChatAgent` and never depend
 * on the concrete class — that lets the kernel swap in wrappers without
 * touching the connector code.
 *
 * `chat()` returns the channel-agnostic `SemanticAnswer` — connector plugins
 * translate it to their native wire format (Adaptive Card / MarkdownV2 +
 * inline keyboards / …). `chatStream()` stays internal-observability-shaped
 * so dev UIs and the verifier wrapper can render a live trace.
 *
 * Lifted from `middleware/src/services/orchestrator.ts` in S+10-2 so the
 * orchestrator-plugin (S+10-3/4) and channel-plugins-final (S+11) can
 * consume it without depending on the kernel-internal class.
 */
/**
 * Channel-side hooks the route wires up so it can render a live "what is the
 * agent doing right now" indicator. All callbacks are optional and
 * fire-and-forget — the orchestrator never throws if a hook errors.
 *
 * Structurally compatible with the orchestrator-internal `AskObserver` so
 * the orchestrator's wider observer type assigns into this without copying
 * fields.
 */
export interface ChatStreamObserver {
  onIteration?(ev: { iteration: number }): void;
  onIterationPhase?(ev: {
    iteration: number;
    phase: 'thinking' | 'streaming' | 'tool_running' | 'idle';
  }): void;
  onTokenChunk?(ev: {
    iteration: number;
    deltaTokens: number;
    cumulativeOutputTokens: number;
    tokensPerSec: number;
  }): void;
  onIterationUsage?(ev: {
    iteration: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
  }): void;
}

export interface ChatAgent {
  chat(input: ChatTurnInput): Promise<SemanticAnswer>;
  chatStream(
    input: ChatTurnInput,
    observer?: ChatStreamObserver,
  ): AsyncGenerator<ChatStreamEvent>;
}

/** Inbound channel-supplied attachment (image/file/audio/video). Vision-capable
 *  models receive image kinds inline; other kinds are dropped today. */
export interface ChatTurnAttachment {
  kind: 'image' | 'file' | 'audio' | 'video';
  url: string;
  mediaType: string;
  name?: string;
  sizeBytes?: number;
  /** Optional pre-fetched bytes when the channel owns a token-protected fetch
   *  path (Telegram). Absent → orchestrator fetches `url` itself. */
  bytesBase64?: string;
}

/** Diagram render produced by the `render_diagram` tool during a turn,
 *  surfaced as a sidecar attachment. */
export interface DiagramAttachment {
  kind: 'image';
  url: string;
  altText: string;
  diagramKind: string;
  cacheHit: boolean;
}

/** Pending Smart-Card clarification request — populated when the model
 *  invoked `ask_user_choice` and the orchestrator short-circuited the turn.
 *  Mirrors the kernel-side `PendingUserChoice` from
 *  `middleware/src/tools/askUserChoiceTool.ts`; assignment-compatible by
 *  structure. */
export interface PendingUserChoice {
  question: string;
  rationale?: string;
  options: Array<{ label: string; value: string }>;
}

/** Slot-picker card scheduled by `find_free_slots`. Mirrors the kernel-side
 *  `PendingSlotCard` from `middleware/src/tools/findFreeSlotsTool.ts`. */
export interface PendingSlotCard {
  question: string;
  subjectHint?: string;
  slots: Array<{
    slotId: string;
    start: string;
    end: string;
    timeZone: string;
    label: string;
    confidence: number;
  }>;
}

/** Outcome of a sub-agent run-trace (status discriminator). Mirrors the
 *  KG-side `RunStatus` from `@omadia/knowledge-graph`. Inlined here
 *  to avoid a build-order dep — channel-sdk builds before the KG plugin. */
export type RunStatus = 'success' | 'error';

/** Per-tool-call entry in a run trace. Structural copy of KG-side
 *  `RunToolCall`; identical shape so the session logger can hand the trace
 *  straight to `KnowledgeGraph.ingestTurn` after stamping `turnId`. */
export interface RunToolCall {
  /** Unique id within the turn — orchestrator tool_use id or nanoid from the
   *  sub-agent. Becomes part of the ToolCall node's external id. */
  callId: string;
  toolName: string;
  durationMs: number;
  isError: boolean;
  /** Orchestrator-level tool: 'orchestrator'. Sub-agent tool: the agent name. */
  agentContext: string;
  /** External ids of entities produced by this call (odoo://…, confluence://…).
   *  Wired by the entity-ref bus, same source as `TurnIngest.entityRefs`. */
  producedEntityIds?: string[];
}

/** Per-sub-agent invocation entry in a run trace. */
export interface RunAgentInvocation {
  /** 0-based index across the Run — ties back the INVOKED_AGENT edge ordering. */
  index: number;
  agentName: string;
  durationMs: number;
  subIterations: number;
  status: RunStatus;
  toolCalls: RunToolCall[];
}

/**
 * Run trace collected during a turn, BEFORE the session logger has stamped
 * the canonical turn id. Mirrors KG-side `Omit<RunTrace, 'turnId'>` — a
 * structural copy is kept here so channel-sdk does not need a peer-dep on
 * `@omadia/knowledge-graph` (which would invert the build order).
 * The session logger attaches the turnId right before handing the finalised
 * trace to `KnowledgeGraph.ingestTurn`.
 */
export interface RunTracePayload {
  scope: string;
  userId?: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  status: RunStatus;
  iterations: number;
  /** Top-level tool calls the orchestrator issued directly (memory, graph, …). */
  orchestratorToolCalls: RunToolCall[];
  /** One entry per sub-agent invocation in invocation-order. */
  agentInvocations: RunAgentInvocation[];
}

/** Compact verifier summary attached to `ChatTurnResult` and the streaming
 *  `verifier` event. */
export interface VerifierResultSummary {
  badge: 'verified' | 'partial' | 'corrected' | 'failed';
  status: 'approved' | 'approved_with_disclaimer' | 'blocked';
  claimCount: number;
  contradictionCount: number;
  unverifiedCount: number;
  retryCount: number;
  latencyMs: number;
  mode: 'shadow' | 'enforce';
}

/**
 * Channel-supplied per-turn input. Constructed by the channel adapter from
 * the platform-native event and handed to `ChatAgent.chat()` /
 * `chatStream()`. Optional fields are channel-specific (calendar tools need
 * `ssoAssertion`, etc.); absent fields just disable the corresponding
 * feature.
 */
export interface ChatTurnInput {
  userMessage: string;
  /** Identifier for session-transcript bucketing — Teams conversation id, 'http', … */
  sessionScope?: string;
  /**
   * Stable per-user identifier (Teams AAD object id, HTTP `x-user-id`). Flows
   * straight into the graph's Session/Turn nodes so the dev UI can filter to
   * "only this user's history". Never reaches the model prompt.
   */
  userId?: string;
  /**
   * Chronologically ordered previous turns of this chat (oldest first), as
   * maintained by an in-memory store outside the orchestrator. When present,
   * they are injected as real `messages[]` entries ahead of the current user
   * message — this is the authoritative mechanism for follow-up coherence.
   * The graph-based retriever still runs (for cross-chat context), but it
   * no longer has to carry single-chat continuity.
   */
  priorTurns?: Array<{ userMessage: string; assistantAnswer: string }>;
  /**
   * Free-form addendum injected into the system prompt for this turn only.
   * Currently used by the answer-verifier's retry path to hand back a
   * correction hint after contradictions were detected. Callers that don't
   * need it simply omit.
   */
  extraSystemHint?: string;
  /**
   * "Fresh check" mode — bypass the FTS context block, verbatim tail, and
   * memory-read convention for this turn only. The orchestrator treats the
   * user message as the sole source of truth and is explicitly told not to
   * consult `/memories/` for this turn. Used by the Teams card's
   * `🔄 Fresh Check` button when the user distrusts a cached-memory answer.
   */
  freshCheck?: boolean;
  /**
   * Teams SSO assertion (JWT) for the calling user. When present, the
   * calendar tools (`find_free_slots` / `book_meeting`) can OBO-exchange
   * for a delegated Graph token. Absent → the calendar tools return an
   * `sso_unavailable` error string and the model falls back to prose.
   * Never echoed to the prompt.
   */
  ssoAssertion?: string;
  /**
   * Optional IANA time zone for the calling user (from Graph
   * `mailboxSettings`, or inferred). When present, the calendar tools use
   * it for `findMeetingTimes` + event creation; absent → UTC.
   */
  userTimeZone?: string;
  /**
   * Inbound attachments from the channel (S+7.7+). Today only image
   * kinds reach the model — vision-capable Claude builds a multimodal
   * `content[]` array combining each image with the userMessage. Other
   * kinds (audio/video/file) are ignored for now (channel-specific
   * pre-processing land later). Channel adapters supply
   * `bytesBase64` when they own a token-protected fetch path
   * (Telegram); otherwise the orchestrator fetches `url` itself.
   */
  attachments?: ChatTurnAttachment[];
}

/**
 * Internal kernel-shaped result of a single chat turn — observability-rich
 * (`runTrace`, `toolCalls`, `iterations`) for dev UIs, verifier evidence and
 * session logging. Channel adapters never see this directly; they consume
 * the `SemanticAnswer` from `chat()`. Verifier wrappers that need the trace
 * call `runTurn()` instead.
 */
export interface ChatTurnResult {
  answer: string;
  toolCalls: number;
  iterations: number;
  /**
   * Agentic run trace for the turn, suitable for rendering a tool-trace
   * panel. Present when a sessionScope was supplied (sub-agents + orchestrator
   * tool calls get recorded). Absent for fire-and-forget dev calls without a
   * scope. Callers that only need the answer can ignore this.
   */
  runTrace?: RunTracePayload;
  /**
   * Image attachments emitted by Orchestrator tools during this turn (currently
   * only `render_diagram`). Consumers like the Teams adapter append these as
   * Adaptive-Card Image elements on the final reply. Empty/undefined when no
   * diagram was rendered.
   */
  attachments?: DiagramAttachment[];
  /**
   * Answer-verifier summary. Populated only when the verifier is configured
   * AND ran for this turn (trigger router fired). Consumers like the Teams
   * adapter render a badge based on `badge`; dev UIs can surface the full
   * claim breakdown. See docs/plans/answer-verifier-agent.md for semantics.
   */
  verifier?: VerifierResultSummary;
  /**
   * Set when the orchestrator short-circuits after the model invoked
   * `ask_user_choice`. Channel adapters (Teams, web-dev UI) render this as a
   * Smart-Card with button options instead of a plain answer. A click fires a
   * fresh turn with the chosen label/value as `userMessage`. Mutually exclusive
   * with a meaningful `answer` — `answer` will usually be empty or short
   * pre-question text.
   */
  pendingUserChoice?: PendingUserChoice;
  /**
   * 1-click refinement buttons rendered below the answer. Populated when the
   * LLM invoked `suggest_follow_ups` during the turn. Clicks fire a fresh
   * user turn with the option's `prompt` as the message. Empty/undefined
   * when no follow-ups were scheduled.
   */
  followUpOptions?: FollowUpOption[];
  /**
   * Slot-picker card scheduled by `find_free_slots`. When present, the Teams
   * adapter renders an Adaptive Card with clickable time-slot buttons below
   * the natural-language answer. A click fires a fresh user turn whose
   * message triggers `book_meeting(slotId, subject)` on the next round.
   * Sidecar — does NOT short-circuit the turn.
   */
  pendingSlotCard?: PendingSlotCard;
  /**
   * Routine list smart-card payload scheduled by `manage_routine.list`.
   * When present, the channel renders an Adaptive Card with one row per
   * routine and inline Pause/Resume/Löschen actions, alongside the
   * natural-language answer. Sidecar — does NOT short-circuit the turn.
   */
  pendingRoutineList?: PendingRoutineList;
  /**
   * Set to `true` when a calendar tool failed this turn with a
   * `consent_required` AAD error. The Teams adapter renders an OAuthCard
   * sidecar so the user can grant calendar scopes in one click; a retry of
   * the original question after consent then succeeds silently. Sidecar —
   * does NOT short-circuit the turn; the natural-language answer still
   * ships so the user sees the bot acknowledged the request.
   */
  pendingOAuthConsent?: boolean;
  /**
   * Privacy-Proxy aggregate receipt for this turn. Populated when a
   * `privacy.redact@1` provider is registered AND processed at least one
   * outbound payload during the turn. PII-free by construction (no spans,
   * no offsets, no raw values, no token-map preview); safe to surface
   * inline in any channel. Connectors that can render rich UI (Teams
   * Adaptive Card ToggleVisibility, web inline disclosure) display it as
   * an expandable card under the answer. Connectors without rich UI MAY
   * ignore this field.
   */
  privacyReceipt?: PrivacyReceipt;
}

/**
 * Routine list payload — kernel-internal mirror of `OutgoingRoutineList`
 * (channel-sdk's outgoing.ts). Kept structurally compatible so
 * `toSemanticAnswer` is a 1:1 map. Lives on the kernel-internal contract
 * so the orchestrator can drain a `pendingRoutineList` field without
 * pulling the channel-shaped name into its tool-side types.
 */
export interface PendingRoutineList {
  filter: 'all' | 'active' | 'paused';
  totals: { all: number; active: number; paused: number };
  routines: Array<{
    id: string;
    name: string;
    cron: string;
    prompt: string;
    status: 'active' | 'paused';
    lastRunAt: string | null;
    lastRunStatus: 'ok' | 'error' | 'timeout' | null;
  }>;
}

/**
 * Per-tool agent metadata. Attached by the chat route to `tool_use` events
 * (and `sub_tool_use`) so the UI can render a clickable agent pill without
 * a hardcoded `tool name → agent` table on the client. Resolution happens
 * server-side: built-in agents come from a curated map, Builder-uploaded
 * agents from `DynamicAgentRuntime.findAgentByToolName()`. When a tool is
 * not backed by an agent (helper tools like `memory`, `ask_user_choice`,
 * `render_diagram`), the field stays `undefined`.
 *
 * Tone is one of four byte5 brand fills; see TONE_CLASS in the web-dev
 * `AgentUsagePills` for the rendered hex. For Builder-uploaded agents the
 * tone is derived deterministically from the agent id so the same agent
 * always gets the same colour across sessions and devices.
 */
export interface AgentMeta {
  id: string;
  label: string;
  tone: 'cyan' | 'navy' | 'magenta' | 'warning';
}

/**
 * Events emitted by `chatStream` in order, one per observable state transition
 * inside the tool loop. Local dev UIs render these as a live trace; production
 * callers can ignore everything except `done` / `error`.
 */
export type ChatStreamEvent =
  | { type: 'iteration_start'; iteration: number }
  | { type: 'text_delta'; text: string }
  | {
      type: 'tool_use';
      id: string;
      name: string;
      input: unknown;
      /** Set by the chat route when `name` resolves to an installed agent. */
      agent?: AgentMeta;
    }
  | { type: 'tool_result'; id: string; output: string; durationMs: number; isError?: boolean }
  /**
   * OB-77 (Palaia Phase 8) — fired AFTER the nudge pipeline has run on
   * the iteration's tool_results. Channel renderers collect these per
   * turn and render them as a consolidated list below the tool trace
   * (NOT inside any individual tool row). The pipeline's `<nudge>`
   * block is also embedded in `tool_result.content` so the agent sees
   * it on its next API call — but the UI uses this dedicated event so
   * placement + de-duplication are independent of tool-result
   * rendering. `id` is the tool_use_id the nudge fired against.
   */
  | {
      type: 'nudge';
      id: string;
      nudgeId: string;
      text: string;
      cta?: {
        label: string;
        toolName: string;
        arguments: Record<string, unknown>;
      };
    }
  /** Heartbeat every ~5s while a tool call is still in flight. Gives the UI a
   * live "still working" signal and keeps any intermediate proxy from idling
   * the stream out. elapsedMs is measured from the corresponding `tool_use`. */
  | { type: 'tool_progress'; id: string; elapsedMs: number }
  /**
   * Turn-level liveness pulse. Emitted on a fixed cadence (~2s) by the
   * route while a turn is in flight. Gives the UI a "still working" signal
   * even when no `text_delta` / `tool_use` arrived recently. Same shape as
   * the builder's `heartbeat` event so the front-ends can share the
   * liveness-rendering logic.
   */
  | {
      type: 'heartbeat';
      sinceLastActivityMs: number;
      currentIteration: number;
      toolCallsThisIter: number;
      phase?: 'thinking' | 'streaming' | 'tool_running' | 'idle';
      tokensStreamedThisIter?: number;
    }
  /**
   * Live token-stream pulse. One per assistant-text / tool-input delta the
   * model emits, throttled to the trailing-500ms window so the UI ticker
   * does not flood. `tokensPerSec` is computed from the same window.
   */
  | {
      type: 'stream_token_chunk';
      iteration: number;
      deltaTokens: number;
      cumulativeOutputTokens: number;
      tokensPerSec: number;
    }
  /**
   * Authoritative usage block read off `stream.finalMessage()` at iteration
   * end. Carries cache-read/creation input tokens so the UI can render a
   * 🟢 cache-hit indicator separately from the live token-stream chunks
   * (which only see approximated output counts).
   */
  | {
      type: 'iteration_usage';
      iteration: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
    }
  /** Sub-agent iteration boundary. Surfaces the inner Claude loop so a long
   * domain-tool call is no longer an opaque black box in the UI. */
  | { type: 'sub_iteration'; parentId: string; iteration: number }
  /** Sub-agent initiated an inner tool call (e.g. odoo_execute). */
  | { type: 'sub_tool_use'; parentId: string; id: string; name: string; input: unknown }
  /** Sub-agent's inner tool call finished. */
  | {
      type: 'sub_tool_result';
      parentId: string;
      id: string;
      output: string;
      durationMs: number;
      isError: boolean;
    }
  | {
      type: 'done';
      answer: string;
      toolCalls: number;
      iterations: number;
      attachments?: DiagramAttachment[];
      /**
       * Agentic run trace for this turn (same shape as ChatTurnResult.runTrace).
       * Consumed by the verifier's chatStream wrapper to run the trace-
       * cross-check rule. Clients that don't need it can ignore it.
       */
      runTrace?: RunTracePayload;
      /**
       * Present when the turn ended because Claude invoked `ask_user_choice`.
       * See ChatTurnResult.pendingUserChoice for semantics.
       */
      pendingUserChoice?: PendingUserChoice;
      /** 1-click refinement buttons attached to the answer; see
       *  ChatTurnResult.followUpOptions for semantics. */
      followUpOptions?: FollowUpOption[];
      /** Slot-picker card scheduled by `find_free_slots`. */
      pendingSlotCard?: PendingSlotCard;
      /** `true` when a calendar tool hit `consent_required` this turn. */
      pendingOAuthConsent?: boolean;
      /** Privacy-Proxy aggregate receipt for this turn. PII-free; clients
       *  render it as a collapsible disclosure under the answer. */
      privacyReceipt?: PrivacyReceipt;
    }
  /**
   * Emitted after `done` by the verifier wrapper (only when enabled). The
   * client can render a badge, hide unverified facts, or simply ignore the
   * event. Never emitted by the base orchestrator.
   */
  | { type: 'verifier'; summary: VerifierResultSummary }
  | { type: 'error'; message: string };
