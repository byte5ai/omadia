/**
 * Outbound semantic contracts. Connector plugins translate these to their
 * native wire format (AdaptiveCard for Teams, Block Kit for Slack, inline
 * keyboards for Telegram, HTML for email, …). The orchestrator emits these
 * shapes channel-agnostically — no Teams / Slack / Telegram leakage leaks
 * back into the core.
 *
 * Stability contract: additive changes only within a major. Adding a new
 * optional field is safe; renaming / removing requires a major bump and
 * a coordinated update across all connector packages.
 */

import type {
  CaptureDisclosure,
  PrivacyReceipt,
  RecalledContext,
} from '@omadia/plugin-api';
import type { OutgoingSurface } from './surface.js';
import type { AiDisclosure } from './aiDisclosure.js';

export type { CaptureDisclosure, PrivacyReceipt, RecalledContext };
export type { AiDisclosure } from './aiDisclosure.js';

/**
 * The top-level shape the orchestrator hands to a connector for rendering.
 * Every field except `text` is optional; a plain text reply is a valid
 * SemanticAnswer. Connectors that cannot render a richer primitive (e.g. a
 * Telegram bot without inline-keyboards for a SlotPicker) SHOULD degrade
 * gracefully (render the question as plain text + slot labels numbered
 * 1..N).
 */
export interface SemanticAnswer {
  /** The assistant's prose response. Connectors MUST render this. */
  text: string;

  /** Visual verifier state — connectors may render as badge / icon / colour. */
  verifier?: VerifierBadge;

  /**
   * True when this turn's answer could have been influenced by persisted
   * memory: an injected prior-context block (session tail + FTS + entity
   * recall) or a `memory`-tool call by the orchestrator. Connectors use this
   * to gate memory-bypass affordances (Teams' "🔄 Fresh Check" button) —
   * absent/false means a re-run without memory would be a no-op, so the
   * affordance should not be offered.
   */
  memoryUsed?: boolean;

  /** Soft-disclaimer line appended to the answer (e.g. "unverified claims"). */
  disclaimer?: string;

  /** Image / file attachments to display alongside the text. */
  attachments?: OutgoingAttachment[];

  /** Suggested next prompts, typically rendered as buttons/chips. */
  followUps?: FollowUpOption[];

  /**
   * One-shot interactive card the user must resolve before continuing
   * (choice ask, slot picker, topic-selection). At most ONE interactive
   * element per answer — connectors may refuse to render two competing
   * interactions.
   */
  interactive?: OutgoingInteractive;

  /**
   * Signalled when an external-integration tool (today: Microsoft Calendar)
   * failed this turn with `consent_required`. Semantically channel-agnostic
   * — each connector decides how to surface it:
   *   - Teams: render an OAuthCard sidecar so the user can grant the scopes
   *     in one click via the Bot-Framework `userTokenClient` flow.
   *   - Telegram / plain-web: no OBO equivalent — connectors should render
   *     the `text` answer unchanged (the orchestrator already wrote a
   *     `sso_unavailable`-style explanation in `text`).
   * Sidecar — does NOT short-circuit the turn.
   */
  oauthConsentPending?: boolean;

  /**
   * Palaia capture-disclosure (OB-81) — what the orchestrator persisted into
   * the knowledge graph for this turn. Surfaced as an expandable section by
   * connectors that can render disclosure UI (Teams Adaptive Card
   * ToggleVisibility section, inline-chat collapsible row). Omitted when the
   * capture-pipeline is inactive / disabled / pre-OB-71. Connectors that
   * cannot render rich UI MAY ignore this field.
   */
  captureDisclosure?: CaptureDisclosure;

  /**
   * Privacy-Proxy aggregate receipt for this turn — what the
   * `privacy.redact@1` provider did with the outbound payload (detected,
   * masked, routed). PII-free by construction. Connectors that can
   * render rich UI surface it as a collapsible disclosure under the
   * answer; others MAY ignore the field. Omitted when no privacy provider
   * is installed.
   */
  privacyReceipt?: PrivacyReceipt;

  /**
   * Privacy Shield v4 — real values rendered into `text` that the LLM never
   * saw (resolved server-side from ground truth behind the data-plane
   * boundary). Connectors MAY highlight their occurrences (e.g. a violet
   * tint) so the asker sees which data was protected. Omitted when the turn
   * produced no server-materialized answer or exposed no masked field.
   */
  maskedValues?: readonly string[];

  /**
   * Omadia UI canvas surface payload (omadia-canvas-protocol/1.0). Present when a
   * canvas-aware turn produced an initial primitive tree. Channels not declaring
   * the `'canvas'` capability ignore it. Additive optional field (see stability
   * contract above) — sidecar, does NOT short-circuit the answer.
   */
  surface?: OutgoingSurface;

  /**
   * Cross-session recall probe — plans/processes/insights the per-turn probe
   * surfaced from PRIOR sessions. Connectors that can render rich UI show it
   * as a collapsible "from earlier sessions" card (web-ui RecalledContextCard,
   * Teams Adaptive Card); others MAY ignore it. Omitted when nothing was
   * recalled. Sidecar — does NOT short-circuit the answer.
   */
  recalled?: RecalledContext;

  /**
   * #332 Layer 1 — tamper-evident agent transparency. A curated projection of
   * the deterministic run-trace's sub-agent invocations, built by the HARNESS
   * (not the LLM) from the choke-point trace. Lets EVERY channel — including
   * Teams / Telegram, which never see the raw `runTrace` — show which
   * specialist(s) were actually consulted this turn. If the orchestrator only
   * *claims* "I asked the Strategist" but never invoked the tool, this array is
   * empty and the contradiction is visible. Omitted when no sub-agent ran.
   * Sidecar — does NOT short-circuit the answer.
   */
  agentsConsulted?: readonly AgentConsultation[];

  /**
   * #332 Layer 2 — Direct Line. The verbatim answer of a sub-agent the USER
   * directed input at (e.g. `@omadia #strategist …`), captured at the choke
   * point and delivered as a HARNESS-owned, attributed segment INDEPENDENT of
   * the orchestrator's own `text`. The orchestrator can neither remove nor
   * rewrite it — its only sanctioned addition is an attributed, additive note
   * in `text` (never a replacement). Still PII-masked by the privacy guard.
   * Omitted on ordinary turns (no direct-line directive). Sidecar.
   */
  delegatedAnswer?: DelegatedAnswer;

  /**
   * #445 — sticky Direct Line indicator. Present on EVERY turn while the
   * feature is enabled, including `{ active: false }` on ordinary turns. That
   * is deliberate: a field that only appears while bound cannot tell a client
   * that a binding ENDED, so a restart, a registry rebuild or a TTL expiry
   * would leave a stale "you are talking to X" banner on screen. Emitting the
   * negative makes the indicator self-correcting on the very next turn.
   * Omitted entirely when the feature is off. Sidecar.
   */
  directLineSession?: DirectLineSessionState;

  /**
   * AI-Act Art. 50 — harness-owned AI disclosure for this turn (#643, epic
   * #642). The structured carrier for channels with a rich UI (badge, footer);
   * the SAME line is folded into `text` by `toSemanticAnswer` so the marking
   * also reaches the wire-only channels that have no provenance slot. Built
   * OUTSIDE the LLM's output stream — a model cannot suppress or reword it.
   *
   * Present on every turn the disclosure is active, EVEN when the line was not
   * folded into `text` this turn (folding is first-turn-per-scope; the
   * structured field is every-turn). Same rationale as `directLineSession`: a
   * field that appears only when folded cannot tell a client the marking is
   * still in force. Omitted only when an operator turned it `'off'`. Sidecar —
   * does NOT short-circuit the answer.
   */
  aiDisclosure?: AiDisclosure;
}

/**
 * #445 — which specialist, if any, this conversation is currently bound to.
 * `transition` describes what THIS turn did, so a channel can narrate the
 * change ("now talking to X") without diffing against its own prior state.
 */
export interface DirectLineSessionState {
  /** True while a binding is live at the END of this turn. */
  readonly active: boolean;
  /** Stable agent id of the bound specialist. Omitted when inactive. */
  readonly agentId?: string;
  /** Human label of the bound specialist. Omitted when inactive. */
  readonly label?: string;
  /** What this turn did to the binding. */
  readonly transition?:
    | 'entered'
    | 'switched'
    | 'continued'
    | 'left'
    | 'unavailable'
    | 'refused';
  /** Why a requested binding was refused — only with `transition: 'refused'`. */
  readonly refusedReason?: 'no-scope' | 'shared-scope' | 'synthetic-scope';
}

/**
 * #332 Layer 1 — one curated entry per sub-agent invocation this turn.
 * Derived from the deterministic `runTrace.agentInvocations` (the choke-point
 * record), NEVER from the orchestrator's prose. Carries only what a footer
 * needs; the raw run-trace stays behind the connector boundary.
 */
export interface AgentConsultation {
  /** Stable agent id when resolvable (e.g. `de.byte5.agent.strategist`). */
  agentId?: string;
  /** Human label for the footer (e.g. `Strategist`). Always present. */
  label: string;
  /** Deterministic outcome of the invocation. */
  status: 'success' | 'error';
  /** Wall-clock duration of the invocation, when recorded. */
  durationMs?: number;
  /** COUNT of tool calls the sub-agent made — never the orchestrator's prose. */
  toolCalls?: number;
}

/**
 * #332 Layer 2 — the harness-owned verbatim sub-agent segment for a
 * direct-line turn. Rendered attributed and visually separate from the
 * orchestrator's `text`. `status: 'error'` carries a faithful failure message
 * in `text` (never a cover-up or hallucinated answer).
 */
export interface DelegatedAnswer {
  /** Stable agent id the directive resolved to. */
  agentId: string;
  /** Human label for attribution (e.g. `Strategist`). */
  label: string;
  /** The sub-agent's verbatim answer (PII-masked), or a faithful error line. */
  text: string;
  status: 'success' | 'error';
}

/** Image/file side-channel. `url` must be reachable by the channel. */
export interface OutgoingAttachment {
  kind: 'image' | 'file';
  /** URL the channel fetches / displays. May be signed + TTL-bound. */
  url: string;
  /** Human-readable name. Connectors display this when rendering inline. */
  altText: string;
  mediaType?: string;
  sizeBytes?: number;
  /**
   * Connector-agnostic producer hint (e.g. `'diagram.mermaid'`,
   * `'odoo.report.pdf'`). Connectors may use this for icon/badging but
   * MUST NOT branch on it for rendering correctness.
   */
  producer?: string;
  /** Producer-specific cache-hit signal — for observability only. */
  cacheHit?: boolean;
}

/** Verifier result the connector renders as a visual badge. */
export interface VerifierBadge {
  status: 'verified' | 'partial' | 'corrected' | 'failed';
  /** Optional short tooltip / long-press hint. */
  hint?: string;
}

/** Suggested follow-up prompt, typically rendered as a button. */
export interface FollowUpOption {
  /** Short label (<=40 chars). */
  label: string;
  /**
   * Full user-message submitted when the user clicks. MUST stand alone —
   * the LLM should be able to answer it without the prior turn's context.
   */
  prompt: string;
}

/** Discriminated union of interactive elements a connector may render. */
export type OutgoingInteractive =
  | OutgoingChoiceCard
  | OutgoingSlotPicker
  | OutgoingTopicAsk
  | OutgoingRoutineList
  | OutgoingMcpInputForm;

/**
 * Mid-call input request from an MCP tool (#544 W2-1). Connector renders a form
 * of free-text fields; the submitted values ride back as the next user message
 * in the `MCP_INPUT_REPLY_PREFIX` envelope, which the orchestrator resolves.
 *
 * Distinct from {@link OutgoingChoiceCard} because the shapes genuinely differ:
 * N free-text fields demanded by a third party, versus 2-4 mutually exclusive
 * options the model chose.
 *
 * `serverName` MUST be rendered. A server can put arbitrary prose in `prompt`
 * and collect arbitrary text; a card that does not name the asker lets a hostile
 * server phish credentials behind omadia's own chrome. Connectors that cannot
 * render a form MUST still show the plain-text prompt `toSemanticAnswer` folds
 * into `text` — never silently drop the request.
 */
export interface OutgoingMcpInputForm {
  kind: 'mcp_input';
  /** Opaque single-use id the answer must carry back. */
  correlationId: string;
  /** Display name of the MCP server making the request. Mandatory on screen. */
  serverName: string;
  serverId: string;
  toolName: string;
  /** Server-supplied prose, when it sent any. Untrusted text — render as text. */
  prompt?: string;
  fields: Array<{
    name: string;
    label?: string;
    description?: string;
    /** Advisory masking hint; the value still reaches the server verbatim. */
    secret?: boolean;
    required?: boolean;
  }>;
}

/**
 * Multi-option question card. Connector renders as buttons / select / radio.
 * Value is echoed back as the user's next message; `label` is user-visible.
 */
export interface OutgoingChoiceCard {
  kind: 'choice';
  question: string;
  rationale?: string;
  options: Array<{ label: string; value: string }>;
}

/**
 * Calendar-slot selection. Connector renders slots as tappable rows.
 * Each slot carries a stable id the connector echoes back when the user
 * picks it. Time-strings are ISO-8601, tz is IANA.
 */
export interface OutgoingSlotPicker {
  kind: 'slots';
  question: string;
  subjectHint?: string;
  slots: Array<{
    slotId: string;
    start: string;
    end: string;
    timeZone: string;
    label: string;
    /** 0..1 ranking hint. Connectors MAY visualise (bold for >=0.8). */
    confidence: number;
  }>;
}

/**
 * Topic-scope disambiguation. Used when the orchestrator wants the user
 * to confirm which subject the answer should target (e.g. multiple matches
 * in company enrichment). Semantically a choice-card with a topic context.
 */
export interface OutgoingTopicAsk {
  kind: 'topic';
  question: string;
  topics: Array<{ label: string; value: string; hint?: string }>;
}

/**
 * Routine-list smart card. Rendered when the agent answers a "show me my
 * routines" intent via `manage_routine.list` — the tool stores this on
 * its instance, the orchestrator drains it at turn end, and the channel
 * renders one row per routine with inline Pause/Resume/Löschen actions.
 *
 * `filter` is the active server-applied filter (the card lets the user
 * flip it via filter-pills that re-invoke the tool with a new value).
 * `routines` is the already-filtered list — the channel doesn't need to
 * filter again.
 *
 * Sidecar: this DOES NOT short-circuit the turn — the agent may still
 * narrate around it ("Hier deine 3 aktiven Routinen"). Connectors that
 * cannot render rich cards (Telegram, plain HTTP) ignore this and the
 * model's `text` answer carries the same information.
 */
export interface OutgoingRoutineList {
  kind: 'routine_list';
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
