import { randomUUID } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import type { Pool } from 'pg';
import {
  toSemanticAnswer,
  type ChatStreamEvent,
  type ChatTurnInput,
  type ChatTurnResult,
  type DiagramAttachment,
  type OutgoingFileAttachment,
  type PendingRoutineList,
  type SemanticAnswer,
} from '@omadia/channel-sdk';
import type { EmbeddingClient } from '@omadia/embeddings';
import type {
  ContextRetriever,
  FactExtractor,
  RecalledContext,
} from '@omadia/orchestrator-extras';
import { promoteTurnIfSignificant } from '@omadia/orchestrator-extras';
import type { AskObserver, DomainTool } from './tools/domainQueryTool.js';
import type {
  TurnAnnotation,
  TurnHookPayload,
  TurnHookPoint,
  TurnHookRunner,
} from './turnHooks.js';
import {
  KnowledgeGraphTool,
  KNOWLEDGE_GRAPH_TOOL_NAME,
  knowledgeGraphToolSpec,
} from './knowledgeGraphTool.js';
import type { MemoryToolHandler } from '@omadia/memory';
import type { ChatParticipantsTool } from './tools/chatParticipantsTool.js';
import {
  CHAT_PARTICIPANTS_TOOL_NAME,
  chatParticipantsToolSpec,
} from './tools/chatParticipantsTool.js';
import type {
  AskUserChoiceTool,
  PendingUserChoice,
} from './tools/askUserChoiceTool.js';
import {
  ASK_USER_CHOICE_TOOL_NAME,
  askUserChoiceToolSpec,
} from './tools/askUserChoiceTool.js';
import type {
  FollowUpOption,
  SuggestFollowUpsTool,
} from './tools/suggestFollowUpsTool.js';
import {
  SUGGEST_FOLLOW_UPS_TOOL_NAME,
  suggestFollowUpsToolSpec,
} from './tools/suggestFollowUpsTool.js';
import type { FindFreeSlotsTool, PendingSlotCard, TurnAuthContext } from './tools/findFreeSlotsTool.js';
import {
  FIND_FREE_SLOTS_TOOL_NAME,
  findFreeSlotsToolSpec,
} from './tools/findFreeSlotsTool.js';
import type { BookMeetingTool } from './tools/bookMeetingTool.js';
import {
  BOOK_MEETING_TOOL_NAME,
  bookMeetingToolSpec,
} from './tools/bookMeetingTool.js';
import type {
  EntityRefBus,
  KnowledgeGraph,
  NudgeRegistry,
  NudgeStateStore,
  PalaiaExcerpt,
  PalaiaExcerptExtractor,
  PrivacyGuardService,
  ProcessMemoryService,
  ResponseGuardService,
  SessionBriefingService,
} from '@omadia/plugin-api';
import {
  agentScopePrefix,
  PRIVACY_BYPASS_SCOPES_CONFIG_KEY,
  PRIVACY_MODE_CONFIG_KEY,
  resolveEffectivePrivacyMode,
} from '@omadia/plugin-api';
import {
  createNudgeTurnCounter,
  runNudgePipeline,
  type NudgeTurnCounter,
} from './nudgePipeline.js';
import { LoopGuard } from './loopGuard.js';
import {
  createPrivacyTurnHandle,
  ensureWellFormedParams,
} from './privacyHandle.js';
import { RunTraceCollector, type InvocationHandle } from './runTraceCollector.js';
import type { NativeToolRegistry } from './nativeToolRegistry.js';
import { isInternExemptTool } from './privacyInternPolicy.js';
import { graphScopeFor, type SessionLogger } from './sessionLogger.js';
import { streamMessageEvents } from './streaming.js';
import { steeringBus } from './steeringBus.js';
import { buildDateHeader, today, turnContext } from './turnContext.js';

// S+10-2 back-compat re-exports: kernel-side callers that still
// `import { … } from './orchestrator.js'` (verifierService.ts, routes/chat.ts,
// services/sessionLogger.ts, plugins/dynamicAgentRuntime.ts and a few others)
// keep working unchanged. Sub-Commit S+10-3 flips those import paths to
// `@omadia/channel-sdk` and these re-exports go away.
export type {
  ChatAgent,
  ChatStreamEvent,
  ChatTurnAttachment,
  ChatTurnInput,
  ChatTurnResult,
  DiagramAttachment,
  RunTracePayload,
  VerifierResultSummary,
} from '@omadia/channel-sdk';
export { toSemanticAnswer } from '@omadia/channel-sdk';

/**
 * Kernel-owned native-tool names. Registered into the Orchestrator's
 * NativeToolRegistry at construction time. Plugin-provided native tools
 * will append to the same registry in later phases — the dispatch paths
 * (isNative checks) use `this.nativeTools.has(name)`, not this list.
 */
const KERNEL_NATIVE_TOOL_NAMES: readonly string[] = [
  'memory',
  'query_knowledge_graph',
  CHAT_PARTICIPANTS_TOOL_NAME,
  ASK_USER_CHOICE_TOOL_NAME,
  SUGGEST_FOLLOW_UPS_TOOL_NAME,
  FIND_FREE_SLOTS_TOOL_NAME,
  BOOK_MEETING_TOOL_NAME,
];

// `DiagramAttachment` was moved to `@omadia/channel-sdk` in S+10-2; see
// the import block at the top. Re-exported below from this module's barrel
// for back-compat with kernel-side callers that still import it from
// `services/orchestrator.js`.

export interface OrchestratorOptions {
  /**
   * The Agent (orchestrator instance) this build belongs to. Optional for
   * back-compat with direct constructions; the per-Agent factory
   * (`buildOrchestratorForAgent`) always sets it. Defaults to `'default'`.
   */
  agentId?: string;
  client: Anthropic;
  model: string;
  maxTokens: number;
  maxToolIterations: number;
  /**
   * Round-loop guard thresholds (see {@link LoopGuard}). When the model
   * re-emits an identical tool batch with identical results `loopRepeatSoft`
   * times it is nudged; at `loopRepeatHard` the turn force-finalises with a
   * best-effort answer instead of burning the full iteration budget. Both
   * default to LoopGuard's own defaults (3 / 5) when omitted.
   */
  loopRepeatSoft?: number;
  loopRepeatHard?: number;
  /**
   * Optional wall-clock budget per turn, in seconds. When > 0 the tool loop
   * stops at the next iteration boundary once exceeded and force-finalises a
   * best-effort answer. `0` / omitted → no time budget (iteration cap and the
   * loop guard are the only bounds). Default off so genuinely long multi-step
   * turns are not truncated.
   */
  maxTurnSeconds?: number;
  /** One delegation tool per Managed Agent domain (accounting, hr, …). */
  domainTools: DomainTool[];
  /** Kernel-shared native-tool registry. Created once at boot and shared
   *  between the orchestrator and the plugin-activation pipeline so plugin-
   *  contributed tools land in the same dispatch map as the kernel's own. */
  nativeToolRegistry: NativeToolRegistry;
  /**
   * Optional. #133 (plan-as-data) slice E0 — side-channel turn-hook runner.
   * When set, the orchestrator fires `onBeforeTurn` / `onAfterToolCall` /
   * `onAfterTurn` during the turn. Absent → hooks are simply never fired.
   */
  turnHookRegistry?: TurnHookRunner;
  sessionLogger?: SessionLogger;
  /** Optional. When set, EntityRefs observed during a turn are attached to the session log. */
  entityRefBus?: EntityRefBus;
  /** Optional. When set, exposes the `query_knowledge_graph` tool so Claude
   * can look up prior turns and entity context before delegating. */
  knowledgeGraph?: KnowledgeGraph;
  /**
   * Per-orchestrator memory isolation — a `MemoryToolHandler` bound to THIS
   * Agent's scoped (+ namespaced) MemoryStore. When set, the orchestrator
   * dispatches the model-facing `memory` tool through it INSTEAD of the
   * globally-registered handler, so every `view`/`create`/`str_replace`/…
   * lands under `/memories/orchestrators/<slug>/` and can never read or write
   * another Agent's memory. Absent (legacy direct construction) → the global
   * handler is used exactly as before. Wired by `buildOrchestratorForAgent`.
   */
  memoryToolHandler?: MemoryToolHandler;
  /**
   * Optional. When set, retrieves conversational context (verbatim tail of
   * the active chat + entity-anchored and full-text hits from other chats of
   * the same user) and injects it as a cacheable system block on every turn.
   * Callers that don't want context-retrieval just omit this.
   */
  contextRetriever?: ContextRetriever;
  /**
   * OB-75 (Palaia Phase 6) — Session-Continuity Briefings. When set,
   * the orchestrator prepends a session-summary + open-tasks block to
   * the existing prior-context whenever the BriefingService returns
   * mode='briefing'. mode='resume' is skipped to avoid duplicating the
   * tail that priorContext already carries; mode='empty' is ignored.
   */
  sessionBriefing?: SessionBriefingService;
  /**
   * Optional. When set, the `query_knowledge_graph` tool's
   * `search_turns_semantic` operation is available (embedding-based turn
   * recall). Without a client, the tool still works for FTS + entity lookups.
   */
  embeddingClient?: EmbeddingClient;
  /**
   * Optional. When set, every successful turn triggers a fire-and-forget
   * Haiku-based fact extraction; the resulting `Fact` nodes land in the
   * graph with `DERIVED_FROM` + `MENTIONS` edges. Missing extractor → turn
   * still persists cleanly, just without facts.
   */
  factExtractor?: FactExtractor;
  /**
   * Optional. When set, exposes the `get_chat_participants` tool so Claude
   * can fetch the active Teams chat's roster (display names + Teams user
   * ids) for @-mention rendering. Requires a chat-participants provider
   * to be installed in the turn's AsyncLocalStorage scope by the channel
   * adapter — without it, the tool returns an error string and the model
   * recovers by not using mentions.
   */
  chatParticipantsTool?: ChatParticipantsTool;
  /**
   * Optional. When set, exposes the `ask_user_choice` tool so Claude can
   * schedule a Smart-Card clarification question with 2–4 button options.
   * A tool invocation terminates the current turn early; the button click
   * arrives as a normal user message in the next turn.
   */
  askUserChoiceTool?: AskUserChoiceTool;
  /**
   * Optional. When set, exposes the `suggest_follow_ups` tool — non-blocking
   * 1-click refinement buttons attached below the answer. Used for Top-N,
   * aggregates, and trend questions where the user typically wants to
   * re-run the same report with different parameters.
   */
  suggestFollowUpsTool?: SuggestFollowUpsTool;
  /**
   * Optional. When set, exposes `find_free_slots` + `book_meeting` so the
   * orchestrator can answer "wann hat X Zeit?" / "buche Termin …" using
   * delegated Microsoft Graph access to the calling user's M365 calendar.
   * Both tools share the same per-turn SSO context set by the Teams bot
   * adapter via `ChatTurnInput.ssoAssertion`. Omitted on channels that
   * can't supply an SSO assertion (dev UI, HTTP route).
   */
  findFreeSlotsTool?: FindFreeSlotsTool;
  bookMeetingTool?: BookMeetingTool;
  /**
   * Optional `responseGuard@1` provider lookup — Phase-1 of the Kemia
   * integration. Late-bound: the orchestrator calls the getter once per
   * turn and uses whatever provider is currently registered. This sidesteps
   * the activation-order dance (the orchestrator plugin generally activates
   * BEFORE most tool plugins, so an `at-construct` lookup would always miss
   * a freshly-installed responseGuard provider until the host restarts).
   * Caller passes either `undefined` (pre-plugin behaviour) or a thunk that
   * runs `ctx.services.get(RESPONSE_GUARD_SERVICE_NAME)` per call.
   */
  responseGuard?: () => ResponseGuardService | undefined;
  /**
   * Optional `privacy.redact@1` provider lookup — Privacy-Proxy Slice 2.1.
   * Late-bound for the same reason as `responseGuard`: the orchestrator
   * plugin generally activates BEFORE most tool plugins, so an at-construct
   * lookup would always miss a freshly-installed privacy provider until
   * the host restarts. Caller passes either `undefined` (pre-plugin
   * behaviour, byte-identical cache shape) or a thunk that runs
   * `ctx.services.get(PRIVACY_REDACT_SERVICE_NAME)` per call.
   *
   * When set, every `messages.create` / `messages.stream` site in the
   * call tree (main agent + sub-agents) tokenises outbound payloads and
   * restores tokens on inbound text. The aggregated PII-free receipt is
   * attached to the returned `ChatTurnResult.privacyReceipt`.
   */
  privacyGuard?: () => PrivacyGuardService | undefined;
  /**
   * Slice 2.5 — cross-plugin runtime-config lookup for the privacy
   * dispatch hook. Given `(agentId, configKey)` returns the operator-set
   * value stored on that installed plugin's registry entry. Used by the
   * bypass resolver to look up `_privacy_mode` on:
   *   - a domain tool's owning agent plugin (via DomainTool.agentId)
   *   - a sub-agent's owning agent plugin (via
   *     turnContext.subAgentOwnerPluginId)
   * neither of which is reachable through the per-tool `readConfig`
   * closure attached to NativeToolRegistry entries.
   *
   * Caller (the harness runtime) wires this as
   * `(agentId, key) => installedRegistry.get(agentId)?.config?.[key]`.
   * Absent ⇒ only kernel-tool bypass works (pre-Slice-2.5-extension
   * behaviour), domain/sub-agent tools always run guarded.
   */
  pluginConfigGet?: (
    agentId: string,
    configKey: string,
  ) => unknown | undefined;
  /**
   * Palaia Phase 8 (OB-77) — Nudge-Pipeline registry. Plugin-contributed
   * `NudgeProvider`s register against this registry; the orchestrator
   * iterates them after every tool_result. Absent → pipeline is a no-op
   * (byte-identical pre-plugin behaviour, no `<nudge>` blocks).
   */
  nudgeRegistry?: NudgeRegistry;
  /**
   * Palaia Phase 8 (OB-77) — durable lifecycle store. Pairs with
   * `nudgeRegistry`. Absent (e.g. in-memory KG) → providers can't read
   * suppress/retire state; the orchestrator falls back to the no-op store
   * so providers keep working with no lifecycle persistence.
   */
  nudgeStateStore?: NudgeStateStore;
  /**
   * Palaia Phase 8 (OB-77) — `processMemory@1` handle exposed to nudge
   * providers (read-only). Optional: when absent, the lead heuristic
   * (`palaia.process-promote`) skips its canonical-hash dedup check.
   */
  nudgeProcessMemory?: ProcessMemoryService;
  /**
   * KG-ACL Slice 4a — Palaia-Excerpt-Extractor. When set, the
   * orchestrator runs a single Haiku call inside `chatStreamInner`
   * (between `sessionLogger.log()` and the `done` yield) to produce a
   * {kind, summary, rationale?, excerpts[]} suggestion, then ships it
   * to the chat UI via the `done` event so the save-as-memory modal
   * can pre-fill. Absent → no enrichment, the modal falls back to its
   * 240-char prefix and (Slice 4b) auto-promotion is a no-op.
   */
  excerptExtractor?: PalaiaExcerptExtractor;
  /**
   * KG-ACL Slice 4b — Auto-Promotion at significance ≥ threshold.
   * When `autoPromote=true` AND `graphPool`+`graphTenantId` are set,
   * the orchestrator fires `promoteTurnIfSignificant` after
   * `sessionLogger.log()`. Requires `capture_level >= normal` so the
   * scorer actually writes a significance value — otherwise every
   * promotion attempt skips with reason='no-significance'.
   *
   * Default OFF. The `KG_ACL_AUTO_PROMOTE` env-var opts in;
   * `KG_ACL_AUTO_PROMOTE_THRESHOLD` (default 0.7) tunes the gate.
   */
  autoPromote?: boolean;
  autoPromoteThreshold?: number;
  graphPool?: Pool;
  graphTenantId?: string;
  /**
   * Operator-configurable assistant persona — the opening line(s) of the
   * system prompt. Supplied via the `assistant_identity` setup field. When
   * empty/undefined the orchestrator falls back to
   * `DEFAULT_ASSISTANT_IDENTITY`, a generic integration-agnostic persona.
   * This keeps the harness free of a hardcoded "byte5 / Odoo" identity —
   * the concrete agent roster is still rendered live from `domainTools`.
   */
  assistantIdentity?: string;
}

// `ChatTurnInput` and `ChatTurnAttachment` were lifted to
// `@omadia/channel-sdk` in S+10-2 (see top-of-file import block).
// `ChatTurnAttachment` mirrors the SDK's `IncomingAttachment` by structure;
// the channel-side shape flows in via the channel-plugin DI, not by
// importing the SDK into the kernel runtime.

// `ChatTurnResult`, `ChatAgent`, `VerifierResultSummary` and `ChatStreamEvent`
// were lifted to `@omadia/channel-sdk` in S+10-2 (see top-of-file
// import block). Re-exported below from this module's barrel for
// back-compat with kernel-side callers that still import them from
// `services/orchestrator.js`.

// Types are kept minimal at the SDK seam to avoid tight coupling to beta type packages.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContentBlock = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Message = any;

/**
 * Build the user-message content for the Anthropic API. When the channel
 * supplied image attachments with `bytesBase64`, return a multimodal
 * content array (image source-blocks first, then text); otherwise just
 * pass the plain string for the simple text case (so existing callers
 * without attachments don't pay an array allocation).
 *
 * S+7.7+ — wired in for Telegram channel's photo/image-document path.
 * Teams calendar/diagram channels don't populate `attachments` today,
 * so this stays a no-op for them.
 */
function buildUserContent(input: ChatTurnInput): ContentBlock[] | string {
  const imageAtts = (input.attachments ?? []).filter(
    (a) => a.kind === 'image' && typeof a.bytesBase64 === 'string',
  );
  if (imageAtts.length === 0) return input.userMessage;
  const blocks: ContentBlock[] = [];
  for (const att of imageAtts) {
    blocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: att.mediaType,
        data: att.bytesBase64,
      },
    });
  }
  if (input.userMessage.trim().length > 0) {
    blocks.push({ type: 'text', text: input.userMessage });
  }
  return blocks;
}

const MEMORY_TOOL_NAME = 'memory';
const MEMORY_TOOL_TYPE = 'memory_20250818';
const MEMORY_BETA_HEADER = 'context-management-2025-06-27';

/**
 * Build the `system` argument for Anthropic as an array of text blocks:
 *   [0] stable domain prompt — marked cache-eligible
 *   [1] per-turn date header — read from the turn context so every
 *       `messages.create` site in a single turn speaks the same "today"
 *
 * Splitting these lets the stable block stay in the prompt cache across
 * turns while the volatile date block invalidates independently (at most
 * once per day). The SDK accepts both string and array forms for `system`.
 */
function buildSystemBlocks(
  stableSystemPrompt: string,
  priorContext?: string,
  extraSystemHint?: string,
): ContentBlock[] {
  // Ordering matters: the prior-context block comes FIRST when present, so
  // the model sees it before wading through the longer stable prompt + the
  // `_rules` memory-read convention. Previously it landed last and the bot
  // reliably read memory rules before noticing the verbatim tail, then
  // answered by those rules instead of the prior turn (hallucinated a
  // different time range on follow-ups like "das Gleiche ohne Gutschriften").
  const blocks: ContentBlock[] = [];

  if (priorContext && priorContext.trim().length > 0) {
    // Trust tiers (important — get this wrong and the bot re-fetches data
    // it just delivered, or hallucinates facts from unrelated chats):
    //   - "Letzte Turns in diesem Chat" = your own recent replies. Trust.
    //     Follow-ups like "das gleiche als Line-Chart" / "ohne Gutschriften"
    //     refer *directly* to these turns. Don't re-query Odoo for the base
    //     numbers, don't speculate about different time ranges — build on
    //     what's already here.
    //   - "Früher besprochene Entitäten" + "Inhaltlich ähnliche Turns" come
    //     from OTHER chats of the same user. Treat as working hypothesis;
    //     if the current question hinges on a concrete number from there,
    //     re-verify via the domain agent.
    blocks.push({
      type: 'text',
      text: `# Vorheriger Gesprächskontext — ZUERST lesen

Dieser Block enthält die letzten Turns dieses Chats und relevante Rückbezüge aus früheren Chats des Users. Er hat **Vorrang** vor der allgemeinen Memory-Lese-Konvention weiter unten: wenn die aktuelle Nutzerfrage eine Follow-up auf einen der hier gelisteten Turns ist, brauchst du KEINEN Memory-Read, keine neue Fach-Agent-Query für Basis-Daten, und keinen anderen Zeitraum zu erfinden.

**Vertrauensregeln:**
- \`## Letzte Turns in diesem Chat\` — das sind deine eigenen letzten Antworten in diesem Chat. Vertraue diesen Daten vollständig. Follow-ups wie "das gleiche nochmal als Line", "ohne Gutschriften", "und für Q4?", "zeig das als Chart" beziehen sich DIREKT auf diese Turns. Hole die Basis-Daten NICHT erneut über einen Fach-Agenten. Bereinigungen/Varianten gehen entweder per \`render_diagram\` (Chart-Variante mit angepassten Werten) oder per direkter Neu-Formulierung.
- \`## Früher besprochene Entitäten\` und \`## Inhaltlich ähnliche Turns\` — aus anderen Chats des gleichen Users. Arbeitshypothese; bei konkreten Zahlen via Fach-Agent verifizieren.

${priorContext}`,
      cache_control: { type: 'ephemeral' },
    });
  }

  blocks.push({
    type: 'text',
    text: stableSystemPrompt,
    cache_control: { type: 'ephemeral' },
  });
  blocks.push({
    type: 'text',
    text: buildDateHeader(turnContext.currentTurnDate()),
  });
  // Per-turn hint (e.g. verifier correction on retry). Not cache-eligible —
  // this block is exactly what should INVALIDATE the cache for the retry.
  if (extraSystemHint && extraSystemHint.trim().length > 0) {
    blocks.push({
      type: 'text',
      text: extraSystemHint,
    });
  }
  return blocks;
}

/**
 * Combines the caller-supplied `extraSystemHint` with a turn-scoped
 * fresh-check instruction when the user clicked "🔄 Fresh Check" on the
 * previous card. The fresh-check hint tells the model to bypass the
 * memory-read convention for this turn — both hints (verifier correction
 * + fresh-check bypass) can coexist.
 */
function composeExtraSystemHint(input: ChatTurnInput): string | undefined {
  const parts: string[] = [];
  if (input.freshCheck) {
    parts.push(
      `# FRESH CHECK MODE (von User per Card-Button aktiviert)

Für diesen EINEN Turn: Ignoriere die Memory-Lese-Konvention aus dem stabilen System-Prompt (Regeln §8-13, Memory-Namensräume, /memories/_rules/-Lesegewohnheit). Der Kontext-Block mit früheren Turns steht DIESMAL NICHT zur Verfügung (bewusst weggelassen), und du sollst auch KEINEN \`memory\`-Tool-Call absetzen außer zum Schreiben, falls sich aus dem aktuellen Turn ein Brand-Asset oder ein verifizierter Fakt ergibt.

Stattdessen:
- Beantworte die aktuelle User-Frage ausschließlich mit dem, was in ihrer Nachricht steht (inkl. eventuellem \`[attachments-info]\`-Block) + frischen Fach-Agent-Calls.
- Wenn du Daten brauchst, die du sonst aus \`/memories/\` zögen würdest, MACH jetzt direkt den passenden Fach-Agent-Tool-Call.
- Keine Referenz auf frühere Gespräche. Keine "wie eben erwähnt". Behandle den Turn als isoliert.

Der Grund für diesen Modus: der User vermutet, dass dich ein früherer Memory-Eintrag oder ein FTS-Treffer auf eine falsche Antwort gelockt hat. Jetzt ist die Chance, unabhängig von diesem Altlast-Pfad zu antworten.`,
    );
  }
  if (input.extraSystemHint && input.extraSystemHint.trim().length > 0) {
    parts.push(input.extraSystemHint);
  }
  return parts.length > 0 ? parts.join('\n\n---\n\n') : undefined;
}

/**
 * Generic, integration-agnostic fallback persona. Used when the operator
 * has not set the `assistant_identity` setup field. Deliberately mentions
 * no specific integration (Odoo, Confluence, …) — the concrete agent
 * roster is rendered live from `domainTools` further down in the prompt.
 */
const DEFAULT_ASSISTANT_IDENTITY =
  'Du bist ein KI-Assistent, der Anfragen beantwortet, indem er an spezialisierte Fach-Agenten delegiert und Lernpunkte über Sessions hinweg persistent merkt.';

function buildSystemPrompt(
  assistantIdentity: string,
  domainTools: DomainTool[],
  hasGraph: boolean,
  hasDiagramTool: boolean,
  hasChatParticipants: boolean,
  hasAskUserChoice: boolean,
  hasSuggestFollowUps: boolean,
  hasCalendar: boolean,
  hasPrivacyV4: boolean,
  extraToolDocs: readonly string[] = [],
): string {
  const domainList = domainTools.length
    ? domainTools.map((t) => `- \`${t.name}\`: ${t.spec.description}`).join('\n')
    : '- (keine Fach-Agenten konfiguriert)';

  const askUserChoiceBlock = hasAskUserChoice
    ? '\n- `ask_user_choice`: Stellt dem User eine Rückfrage mit 2–4 vordefinierten Button-Optionen als Smart Card. Nur aufrufen, wenn die User-Eingabe **genuin mehrdeutig** ist UND es eine **endliche, kleine Menge plausibler Interpretationen** gibt (z.B. zwei Module tracken Umsatz, zwei Kunden haben ähnlichen Namen). **NICHT** nutzen für: offene "was meinst du?"-Fragen, Trivial-Bestätigungen, oder wenn der Kontext die Intention bereits eindeutig macht. Max 1× pro Turn — der Turn endet direkt nach dem Call; die Auswahl kommt im nächsten Turn als normale User-Nachricht.\n'
    : '';
  const calendarBlock = hasCalendar
    ? '\n- `find_free_slots` + `book_meeting`: **M365-Kalender-Integration.** Wenn der User Termin/Meeting/Sprechstunde/Slot/Zeit-mit-<Person> anfragt — egal wie die Formulierung lautet ("schicke X drei Vorschläge", "wann hat Y Zeit?", "buche Termin mit Z", "finde Slot morgen") — **RUFE `find_free_slots`**. NICHT als Email interpretieren, NICHT nur HR-Kontakt nachschlagen und Prose zurückschreiben. Der Tool-Output liefert klickbare Slot-Buttons; der User wählt, dann folgt automatisch `book_meeting`.\n  **Host-Logik (wichtig):**\n  - Die Slots kommen aus dem Kalender des **Hosts** (Meeting-Organizers). Default = Caller selbst.\n  - Wenn der Caller eigene Zeit anbietet ("schicke Tita 3 Vorschläge", "biete Max Termine", "finde Slot morgen") → **hostEmail NICHT setzen** (Caller ist Host).\n  - Wenn der Caller im Auftrag einer anderen Person sucht ("such bei John Termin", "wann hat die GF Zeit?") → `hostEmail` auf die Ziel-Email setzen.\n  **Pflicht-Schritte bei jedem Termin-Intent:**\n  1. Teilnehmer-Emails resolven (ggf. über einen Personen-/HR-Fach-Agenten nach Vorname/Nachname → email).\n  2. `find_free_slots({durationMinutes, attendees, hostEmail?, windowDays?})` aufrufen — Default 5 Tage, Default 30 min wenn User keine Dauer nennt.\n  3. Die gefundenen Slots im Antwort-Text in **1 Satz** zusammenfassen ("Hier 3 freie Slots für …"). Die Buttons erscheinen automatisch als Card darunter.\n  4. Bei `consent_required` / `sso_unavailable` Fehler: kurz erklären dass einmalig Zustimmung nötig ist — die OAuthCard wird automatisch vom System angehängt.\n  **NICHT nutzen:** wenn der User nach bereits gebuchten Terminen fragt (nicht implementiert).\n'
    : '';

  const suggestFollowUpsBlock = hasSuggestFollowUps
    ? '\n- `suggest_follow_ups`: Hängt 2–4 1-Klick-Refinement-Buttons unter deine Antwort. **Nicht-blockierend** — Du antwortest ganz normal zu Ende; die Buttons erscheinen zusätzlich. Nutze das bei **Top-N / Ranking / Trend / Aggregat**-Fragen, wo der User plausibel eine Variante will (anderer Zeitraum, andere Basis Brutto/Netto/DB, offene Posten statt Umsatz). Jedes `prompt` muss eine **vollständige, eigenständige Frage** sein — bei Klick wird es als neue User-Nachricht gesendet. **NICHT** nutzen für: Trivial-Antworten, Ja/Nein-Lookups, oder zusammen mit `ask_user_choice`. Max 1× pro Turn.\n'
    : '';
  const chatParticipantsBlock = hasChatParticipants
    ? '\n- `get_chat_participants`: Liefert die Teilnehmer des aktuellen Teams-Chats. Nur aufrufen, wenn du jemanden im Antworttext **per @-Mention ansprechen** willst — Handoff, Rückfrage, Zuständigkeits-Tag. Max 1× pro Turn. In 1:1-Chats nicht nutzen.\n' +
      '\n  **PFLICHT nach dem Tool-Call — sonst war der Call umsonst:**\n' +
      '  1. Den Namen im Antworttext in der Form `<at>EXAKTER_DISPLAY_NAME</at>` schreiben.\n' +
      '  2. `EXAKTER_DISPLAY_NAME` muss byte-für-byte dem `displayName`-Feld aus der Tool-Response entsprechen — inklusive Firmensuffix, Bindestriche, Großschreibung.\n' +
      '  3. Ohne diese `<at>…</at>`-Tags wird KEINE Mention gerendert und die Person NICHT benachrichtigt — das Schreiben des Namens allein reicht NICHT.\n' +
      '  4. Beispiel: wenn der Roster `displayName: "Jane Doe - ACME"` zurückgibt und du sie ansprechen willst, schreibst du `Hey <at>Jane Doe - ACME</at>, kannst du das übernehmen?` — nicht `Hey Jane Doe` und auch nicht `Hey @Jane`.\n'
    : '';

  const graphBlock = hasGraph
    ? `\n- \`query_knowledge_graph\`: Lokaler Wissens-Graph über vergangene Sessions/Turns + Entitäten aus angebundenen Integrationen. **Bei Fragen nach dem Chat-Verlauf** ("haben wir schon mal über X gesprochen?", "gab es eine Diskussion zu Y?", "welche Themen hatten wir zuletzt?") **nutze \`search_turns\` (FTS, Keyword) oder \`search_turns_semantic\` (Embedding, für Paraphrasen)**. \`find_entity\` matcht NUR Entity-Namen/IDs (z.B. Kunden, Mitarbeiter, Dokumente), NICHT Turn-Text — verwende es für "wer ist Kunde Z?". Bei Rückbezügen auf spezifische Personen/Dinge ("wie bei Müller letztens") zuerst \`find_entity\` oder \`session_summary\`. **Wichtig:** Wenn du eine inhaltliche Frage zu früheren Chats mit \`find_entity\` beantwortest und leer rauskommst, probiere unbedingt zusätzlich \`search_turns\` — dort durchsuchst du tatsächlich die Turn-Texte.\n`
    : '';

  // Diagrams moved out of the kernel in Phase 1.2b-iii. The diagram plugin
  // now contributes its own promptDoc via ctx.tools.register and the text
  // surfaces through `extraToolDocs` below. Kept the parameter name so the
  // caller signature stays stable during the transition.
  void hasDiagramTool;

  // Privacy Shield v4 — turn-start directive. The digest header + tool
  // descriptions only reach the model AFTER it has already interned a tool
  // result; by then it has finished planning which tools to fetch. This
  // block puts the data-plane contract in front of the model before the
  // first tool call so it knows to (a) always terminate a data answer with
  // `v4_render_answer` and (b) fetch the entity directory it needs for the
  // join-back that re-attaches a masked identity column to an aggregate.
  const privacyV4Block = hasPrivacyV4
    ? `
**Datenschutz-Datenschicht (Privacy Shield v4) — PFLICHT bei jeder Datenfrage:**

Fach-Agent-Ergebnisse durchlaufen eine Datenschutz-Grenze: statt der Rohdaten erhältst du einen **Digest** (identitätsfreie Strukturbeschreibung). Felder mit \`"classification":"sensitive-masked"\` zeigen dir nur den Platzhalter \`[masked]\` — **nicht weil der User sie nicht sehen darf, sondern nur weil DU sie nicht sehen sollst.** Der angemeldete User IST berechtigt, diese Werte (Namen, E-Mails, …) zu sehen.

a) **Jede Datenantwort (Tabelle, Liste, Ranking, Einzelwert) endet zwingend mit einem \`v4_render_answer\`-Aufruf.** Schreibe die Daten-Tabelle/-Liste NIEMALS selbst in den Antworttext und kopiere NIEMALS \`[masked]\` in eine Antwort. Der Server füllt in \`v4_render_answer\` die echten Werte ein — auch die maskierten — und stellt sie dem User zu. Nimm die Identitäts-Spalte (\`employee\`, \`name\`, …) immer in \`columns\` mit auf.

b) **Behaupte NIEMALS, Daten seien „gefiltert", „maskiert" oder „aus Datenschutzgründen nicht verfügbar".** Kein „⚠️ Datenschutzfilter aktiv", kein „wende dich an einen Administrator". Du siehst \`[masked]\` — der User bekommt den echten Wert. Erfinde maskierte Werte niemals selbst.

c) **Join-Back-Rezept für Rankings/Aggregate mit Namen:** \`v4_aggregate\`/\`v4_group\`/\`v4_join\` arbeiten nur über **safe (nicht-maskierte)** Schlüssel — Gruppieren nach einem maskierten Namen ist nicht möglich, ein Aggregat verliert daher die Namens-Spalte. Um sie zurückzuholen:
   1. Hole **beide** Datasets: die Transaktionsdaten (z.B. Urlaubsanträge) UND das Stammdaten-Directory (z.B. Mitarbeiterliste mit \`employee_id\` + Name) — das sind in der Regel zwei Fach-Agent-Aufrufe.
   2. \`v4_aggregate\` die Transaktionen über den safe Schlüssel (z.B. \`employee_id\`).
   3. \`v4_join\` das Aggregat mit dem Directory auf \`employee_id\` → jede Zeile trägt wieder den Namen.
   4. \`v4_sort\`/\`v4_top_n\`, dann \`v4_render_answer\` mit \`columns: ["employee", …]\`.
`
    : '';

  return `${assistantIdentity}

Sprache: Antworte immer auf Deutsch, außer der Nutzer wechselt explizit die Sprache.

Werkzeuge:
- \`memory\` (virtuelles /memories-Verzeichnis): Persistiere Domänen-Learnings, Nutzer-Präferenzen, Geschäfts-Konventionen und häufige Anfragen. Der Memory wird über Sessions hinweg geteilt und ist global für diesen Agent. Lies zu Beginn jeder neuen Aufgabe einmal den Verzeichnisinhalt, bevor du antwortest, damit du auf relevante Learnings zurückgreifen kannst. Lege neue Learnings in themenbezogenen Dateien ab (z.B. /memories/customers/kundenname.md, /memories/observations/2026-q2.md).
${graphBlock}${chatParticipantsBlock}${askUserChoiceBlock}${suggestFollowUpsBlock}${calendarBlock}${extraToolDocs.length > 0 ? '\n' + extraToolDocs.map((doc) => `- ${doc.trim()}`).join('\n') + '\n' : ''}
Fach-Agenten (Routing-Regel: wähle anhand der Fragedomäne; bei Mischfragen beide/mehrere aufrufen und Ergebnisse zusammenführen):
${domainList}

Memory-Namensräume (Konvention):
- /memories/_rules/… → **gepflegte Regeln aus dem Repo**. Nicht eigenständig überschreiben oder löschen. Nur ergänzen, wenn der Nutzer es ausdrücklich bestätigt.
- /memories/customers/… → stabile Fakten zu einzelnen Kunden.
- /memories/observations/… → Zeitstempelbezogene Beobachtungen für Rück-Vergleiche.
- /memories/sessions/<scope>/YYYY-MM-DD.md → **chronologische Q&A-Transkripte**, von der Middleware geschrieben (nicht von dir). Diese enthalten echte vorangegangene Konversationen. Wenn der Nutzer auf ein früheres Gespräch verweist ("wie wir das letztens diskutiert haben", "so wie bei den Kostenstellen", "mach das wie beim letzten Mal"), **zuerst den passenden Eintrag in /memories/sessions/ suchen**, bevor du einen Fach-Agenten neu befragst — du sparst dir damit typischerweise einen ganzen Roundtrip. Aber: lies nicht standardmäßig alle Sessions, das wäre Token-Verschwendung. Nur auf Rückbezug gezielt nachschlagen.

**Regel für /memories/_rules/ lesen:**
- Bei einer **neuen fachlichen Frage** (Erstfrage zu einer Domäne in dieser Session, oder Wechsel der Domäne) zuerst die relevanten Regel-Dateien unter /memories/_rules/ lesen und die Konventionen strikt befolgen.
- Bei einem **Follow-up** im selben Chat (Variante, Bereinigung, Klarifikation, Nachfrage zum letzten Turn wie "und das Ganze nochmal ohne X", "und für Q4?", "zeig das als Line-Chart") **NICHT erneut** die Regeln lesen — der Verbatim-Tail im Gesprächskontext hat bereits den relevanten Stand. Direkt antworten (ggf. mit \`render_diagram\` für Chart-Varianten). Regel erneut lesen nur, wenn die Follow-up eine fachlich neue Dimension einführt (z. B. "jetzt das Gleiche auf HR-Ebene").
- Heuristik: enthält der Kontext-Block einen \`## Letzte Turns in diesem Chat\`-Abschnitt und bezieht sich die aktuelle Frage auf einen dieser Turns → Memory-Read überspringen.

**Antwort-Verzicht (NO_REPLY):**

Wenn du nichts beizutragen hast, antworte mit dem **alleinigen, exakten** Token \`NO_REPLY\` (keine Erklärung, kein Präfix, kein Suffix). Das System fängt das Token ab und sendet **keine Nachricht** an den User. Anwendungsfälle:
- Der User hat explizit gebeten, nicht zu antworten ("antworte nicht", "still bleiben", "keine Antwort nötig", "halt einfach den Mund").
- Eine **Routine** (zeitgesteuerter Trigger ohne aktive User-Frage) hat **kein berichtenswertes Ergebnis** — z.B. "heute hat niemand Geburtstag", "keine offenen Tickets", "alles im grünen Bereich". Bei Routinen ist **Schweigen der Default**: sprich nur, wenn es wirklich etwas Berichtenswertes gibt. Schreibe NICHT "Heute nichts zu berichten" oder "Gemäß Anweisung sende ich keine Nachricht" — beides wird trotzdem als Nachricht zugestellt. Schreibe nur \`NO_REPLY\`.
- Reine FYI-Nachricht im Chat ohne Frage oder Aufforderung, auf die keine Reaktion erwartet wird.

**Pflicht-Form**: \`NO_REPLY\` muss die **vollständige** Antwort sein — nichts davor, nichts danach, keine Anführungszeichen, keine Begründung. "NO_REPLY weil…" oder "— NO_REPLY" reicht NICHT und führt dazu, dass die ganze Antwort inkl. Begründung an den User rausgeht.
${privacyV4Block}
Regeln:
1. Erfinde keine Daten. Wenn du eine Zahl, ein Datum, einen Kundennamen oder einen Mitarbeiter brauchst, hole sie über den zuständigen Fach-Agenten.
2. Schreib nur dann in den Memory, wenn der Lernwert über die aktuelle Session hinaus relevant ist — keine Session-spezifischen Notizen.
3. **Persistiere Learnings früh, nicht erst am Ende.** Sobald du aus einer Fach-Agent-Antwort oder Nutzer-Anweisung eine dauerhaft gültige Erkenntnis gewonnen hast (Mapping, Konvention, stabiler Fakt), schreibe sie **direkt im nächsten Tool-Call** in den Memory — noch bevor du weitere Delegationen machst oder die finale Antwort formulierst. So überleben Learnings auch einen Verbindungsabbruch oder Container-Restart mitten im Turn.
4. Zitiere im Memory Quellen knapp (z.B. "beobachtet am 2026-04-17 bei Rechnung RE-2026-0042").
5. Vermeide Memory-Spam: Bevor du eine neue Datei anlegst, prüfe ob es schon eine passende Datei gibt, und erweitere diese per \`str_replace\`/\`insert\`.
6. Persönliche Daten (Ansprechpartner-Namen etc.) nur speichern, wenn sie für die fachliche Arbeit notwendig sind. Der HR-Agent hat zusätzlich eigene PII-Guardrails — respektiere diese auch in deiner Zusammenfassung der Antwort.
7. Am Ende jeder Antwort: Schreibe KEIN Zwischenstand-Update in den Memory, wenn sich nichts Neues ergeben hat.

**Kritische Integritäts-Regeln (Verifier-Härtung):**

8. **Keine Selbst-Verifizierung im Antworttext.** Schreibe NIEMALS Wörter wie "verifiziert", "geprüft", "bestätigt", "live", "live-verifiziert", "nachgeschlagen", "aus Odoo geholt" in deine Antwort, um Daten als frisch zu kennzeichnen. Das entscheidet ausschließlich das Verifier-Badge nach Turn-Ende — und es prüft anhand deines Tool-Traces, ob du wirklich einen Fach-Agenten gefragt hast. Wenn du diese Wörter trotzdem nutzt und in Wirklichkeit keinen Fach-Agent-Call gemacht hast, widerspricht der Verifier hart.

9. **Zahlen aus dem Kontext-Block sind NICHT live.** Konkret: Zahlen unter \`## Früher besprochene Entitäten\`, \`## Inhaltlich ähnliche Turns\`, \`## Letzte Turns in diesem Chat\` stammen aus der Vergangenheit. Präsentiere sie NICHT als aktuellen Stand. Wenn der User nach aktuellen Zahlen fragt (Umsatz, offene Rechnungen, Urlaubstage, Teamleistung), musst du im selben Turn mindestens EINEN passenden Fach-Agent-Call machen — sonst widerspricht der Verifier automatisch und erzwingt einen Retry.

10. **Gültiger Rückbezug:** Wenn der User explizit auf einen früheren Turn verweist ("wie eben berichtet", "die Zahl von gestern"), darfst du die Kontext-Zahl zitieren — aber formuliere dann klar als Rückbezug ("laut Stand vom <Datum>, keine Neu-Abfrage in diesem Turn"), niemals als "verifiziert/geprüft". Für Aggregate über mehrere Dimensionen (Team × Kunde × Zeitraum) immer einen Plausibilitäts-Check gegen bekannte Muster aus \`/memories/\`: wenn die Zahl >50 % vom Erwartungsband abweicht, EXPLIZIT als Auffälligkeit markieren und nachfragen statt bestätigen.

**Dateianhänge (Teams-Uploads):**

11. **Anhang-Hinweis erkennen.** Wenn am Ende einer User-Nachricht ein Block \`[attachments-info] …\` auftaucht, hat der User Dateien hochgeladen — sie sind bereits persistiert (storage_key + signed_url im Block). Behandle die Metadaten wie Zusatzkontext, nicht wie Text der Anfrage.

12. **Brand-Asset-Intent erkennen.** Formulierungen wie "das ist unser Logo", "unser Firmenlogo", "nimm das als Banner", "das ist unser Team-Icon" → **jetzt sofort** die Memory-Datei \`/memories/_brand/<asset-name>.md\` (z.B. \`logo.md\`, \`banner.md\`) schreiben/aktualisieren mit YAML-Frontmatter aus dem attachments-info-Block (storage_key, signed_url, file_name, content_type, uploaded_at, asset_role). Danach kurz bestätigen. Wenn der User die Datei **nicht** als Asset markiert ("schau dir das an", "hier ein Screenshot"), **nicht** in \`/memories/_brand/\` schreiben.

13. **Brand-Asset in Diagrammen einsetzen.** Beim \`render_diagram\`-Aufruf: wenn der User "mit Branding", "mit unserem Logo", "mit Corporate Design" anfragt, lies \`/memories/_brand/logo.md\`. Schreibe im Spec **nicht** die signed_url direkt (Kroki hat keinen Public-Egress), sondern den Platzhalter-URL \`brand://logo\` UND übergib den \`storage_key\` als Tool-Parameter \`brand_logo_storage_key\`. Die Middleware base64-inlined das Bild automatisch bevor es zu Kroki geht — funktioniert zuverlässig, auch bei ausgelaufenen signed_urls. Beispiele:
    - **Vega-Lite**: Layer \`{"mark":"image","encoding":{"url":{"value":"brand://logo"},"x":{...},"y":{...},"width":{"value":80},"height":{"value":80}}}\`
    - **Graphviz**: \`node [image="brand://logo", label=""]\`
    - **PlantUML**: \`<img src="brand://logo" width="120">\` in Note/Header
    - **Mermaid**: eingeschränkt, im Zweifel ohne Logo rendern.
    Tool-Call-Shape: \`render_diagram({kind: "vegalite", source: "<spec mit brand://logo>", brand_logo_storage_key: "<aus memory>"})\`. Ohne den Parameter bleibt \`brand://logo\` ungeändert — Kroki rendert das Bild-Feld dann leer.

**Konvergenz — keine Tool-Schleifen:** Rufe denselben Tool **nicht** wiederholt mit identischen Argumenten auf, wenn das Ergebnis sich nicht ändert. Bringt ein Tool-Aufruf keinen neuen Erkenntnisgewinn, wechsle die Strategie (andere Argumente, anderer Tool) oder gib mit den vorhandenen Informationen die bestmögliche Endantwort. Du hast pro Turn ein begrenztes Tool-Budget — arbeite zielgerichtet darauf hin, die Frage zu beantworten, statt im Kreis zu laufen.

**Datei-Erzeugung (Excel/Word) — höchste Priorität bei Datei-Anfragen:**

14. **Datei statt Chat-Antwort.** Will der User Daten als **Datei/Download** (Excel/.xlsx, Word/.docx, "exportier", "als Excel", "schick mir eine Datei"), erzeuge sie mit \`create_xlsx\`/\`create_docx\` — bei Fach-Agent-Daten mit der \`datasetId\` aus dem Digest. **NICHT \`v4_render_answer\`** verwenden: die Datenschicht-Regel "Datenantwort endet mit v4_render_answer" gilt für Datei-Anfragen **ausdrücklich NICHT** (\`v4_render_answer\` erzeugt nur Chat-Text, keine Datei).

15. **Ankündigen heißt ausführen — im selben Turn.** Sätze wie "ich baue jetzt die Excel…", "ich erstelle die Datei…", "jetzt generiere ich…" MÜSSEN im selben Turn vom \`create_xlsx\`/\`create_docx\`-Tool-Call begleitet sein. **Beende einen Turn NIEMALS mit einer bloßen Ankündigung** ohne den dazugehörigen Tool-Call — eine beschriebene, aber nicht gebaute Datei ist für den User wertlos. Wenn du sagst, du baust eine Datei, dann RUF das Tool im selben Turn auf. Gelingt der Build nicht (Tool gibt \`Error:\` zurück), behaupte KEINEN Erfolg und verspreche keinen Download — sag dem User knapp, dass und warum die Datei nicht erzeugt werden konnte.`;
}

/**
 * Per-slot state for the parallel tool-dispatch loop in chatStreamInner.
 * Each slot owns its dispatch promise, observer event queue, optional
 * invocation handle (sub-agent timing), and per-slot heartbeat clock.
 * `settled` flips when the promise resolves; `output`, `isError`, and
 * `durationMs` are populated at that point.
 */
interface ParallelSlot {
  readonly idx: number;
  readonly use: ContentBlock;
  readonly subEvents: ChatStreamEvent[];
  readonly invocation: InvocationHandle | undefined;
  readonly promise: Promise<string>;
  readonly started: number;
  lastHeartbeat: number;
  settled: boolean;
  output?: string;
  isError?: boolean;
  durationMs?: number;
}

/**
 * OB-29-4 — parse a plugin-tool result string for an in-band
 * `_pendingUserChoice` payload. Returns the parsed shape or `undefined`
 * for malformed / missing payloads. Tolerant of both bare-object and
 * stringified JSON in the `content` slot.
 */
export function parseToolEmittedChoice(
  content: string,
): PendingUserChoice | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const raw = (parsed as { _pendingUserChoice?: unknown })[
    '_pendingUserChoice'
  ];
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as {
    question?: unknown;
    rationale?: unknown;
    options?: unknown;
  };
  if (typeof r.question !== 'string' || r.question.length === 0) {
    return undefined;
  }
  if (!Array.isArray(r.options) || r.options.length === 0) return undefined;
  const options: PendingUserChoice['options'] = [];
  for (const opt of r.options) {
    if (typeof opt !== 'object' || opt === null) continue;
    const o = opt as { label?: unknown; value?: unknown };
    if (typeof o.label !== 'string' || typeof o.value !== 'string') continue;
    options.push({ label: o.label, value: o.value });
  }
  if (options.length === 0) return undefined;
  return {
    question: r.question,
    ...(typeof r.rationale === 'string' ? { rationale: r.rationale } : {}),
    options,
  };
}

/**
 * Parse a plugin-tool result string for an in-band `_pendingRoutineList`
 * sidecar payload. Mirror of `parseToolEmittedChoice` for the routine
 * list smart-card emitted by `manage_routine.list`. Sidecar — does NOT
 * terminate the turn; the caller stores the parsed payload for inclusion
 * in the next `done` block.
 */
export function parseToolEmittedRoutineList(
  content: string,
): PendingRoutineList | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const raw = (parsed as { _pendingRoutineList?: unknown })[
    '_pendingRoutineList'
  ];
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as {
    filter?: unknown;
    totals?: unknown;
    routines?: unknown;
  };
  if (
    r.filter !== 'all' &&
    r.filter !== 'active' &&
    r.filter !== 'paused'
  ) {
    return undefined;
  }
  if (typeof r.totals !== 'object' || r.totals === null) return undefined;
  const t = r.totals as Record<string, unknown>;
  if (
    typeof t['all'] !== 'number' ||
    typeof t['active'] !== 'number' ||
    typeof t['paused'] !== 'number'
  ) {
    return undefined;
  }
  if (!Array.isArray(r.routines)) return undefined;
  const routines: PendingRoutineList['routines'] = [];
  for (const item of r.routines) {
    if (typeof item !== 'object' || item === null) continue;
    const ri = item as Record<string, unknown>;
    if (
      typeof ri['id'] !== 'string' ||
      typeof ri['name'] !== 'string' ||
      typeof ri['cron'] !== 'string' ||
      typeof ri['prompt'] !== 'string' ||
      (ri['status'] !== 'active' && ri['status'] !== 'paused')
    ) {
      continue;
    }
    const lastRunStatus = ri['lastRunStatus'];
    routines.push({
      id: ri['id'],
      name: ri['name'],
      cron: ri['cron'],
      prompt: ri['prompt'],
      status: ri['status'],
      lastRunAt: typeof ri['lastRunAt'] === 'string' ? ri['lastRunAt'] : null,
      lastRunStatus:
        lastRunStatus === 'ok' ||
        lastRunStatus === 'error' ||
        lastRunStatus === 'timeout'
          ? lastRunStatus
          : null,
    });
  }
  return {
    filter: r.filter,
    totals: { all: t['all'], active: t['active'], paused: t['paused'] },
    routines,
  };
}

export class Orchestrator {
  /** The Agent (orchestrator instance) this object serves. */
  readonly agentId: string;
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly maxIterations: number;
  /** Round-loop guard thresholds (see {@link LoopGuard}). */
  private readonly loopRepeatSoft: number | undefined;
  private readonly loopRepeatHard: number | undefined;
  /** Per-turn wall-clock budget in ms; 0 = disabled. */
  private readonly maxTurnMs: number;
  /** Per-Agent scoped memory-tool handler; overrides the global one. */
  private readonly memoryToolHandler: MemoryToolHandler | undefined;
  private readonly domainToolsByName: Map<string, DomainTool>;
  // systemPrompt is rebuilt live per turn from `buildSystemPrompt()` —
  // so hot-registered DomainTools show up in the preamble. Prompt caching
  // still applies within stable phases (between two register/unregister
  // events); right after an install/uninstall exactly one cache miss
  // occurs, then the new prompt is cached.
  private readonly sessionLogger: SessionLogger | undefined;
  private readonly entityRefBus: EntityRefBus | undefined;
  private readonly knowledgeGraphTool: KnowledgeGraphTool | undefined;
  private readonly contextRetriever: ContextRetriever | undefined;
  private readonly sessionBriefing: SessionBriefingService | undefined;
  private readonly factExtractor: FactExtractor | undefined;
  /** #133 E0 — optional side-channel turn-hook runner (see OrchestratorOptions). */
  private readonly turnHookRegistry: TurnHookRunner | undefined;
  private readonly askUserChoiceTool: AskUserChoiceTool | undefined;
  private readonly suggestFollowUpsTool: SuggestFollowUpsTool | undefined;
  private readonly chatParticipantsTool: ChatParticipantsTool | undefined;
  private readonly findFreeSlotsTool: FindFreeSlotsTool | undefined;
  private readonly bookMeetingTool: BookMeetingTool | undefined;
  private readonly responseGuard: (() => ResponseGuardService | undefined) | undefined;
  private readonly privacyGuard: (() => PrivacyGuardService | undefined) | undefined;
  /** Slice 2.5 — cross-plugin runtime-config lookup (see OrchestratorOptions). */
  private readonly pluginConfigGet:
    | ((agentId: string, configKey: string) => unknown | undefined)
    | undefined;
  private readonly nudgeRegistry: NudgeRegistry | undefined;
  private readonly nudgeStateStore: NudgeStateStore | undefined;
  private readonly nudgeProcessMemory: ProcessMemoryService | undefined;
  private readonly excerptExtractor: PalaiaExcerptExtractor | undefined;
  /** Raw KnowledgeGraph handle — kept for Slice 4b auto-promotion to
   *  call `createMemorableKnowledge` directly. The wrapped
   *  `knowledgeGraphTool` is a different abstraction (tool-spec adapter)
   *  that doesn't expose the underlying create-write path. */
  private readonly knowledgeGraph: KnowledgeGraph | undefined;
  private readonly autoPromote: boolean;
  private readonly autoPromoteThreshold: number;
  private readonly graphPool: Pool | undefined;
  private readonly graphTenantId: string | undefined;
  /** Operator persona — first line(s) of the system prompt. See
   *  `OrchestratorOptions.assistantIdentity` / `DEFAULT_ASSISTANT_IDENTITY`. */
  private readonly assistantIdentity: string;
  private readonly nativeTools: NativeToolRegistry;
  /**
   * Per-turn scratchpad for the routine list smart-card emitted in-band by
   * `manage_routine.list`. Set by `extractToolEmittedRoutineList` when a
   * `_pendingRoutineList` marker is seen on a tool_result; drained into
   * the `done` block at turn end. Sidecar — does NOT short-circuit the
   * turn.
   */
  private pendingRoutineList: PendingRoutineList | undefined;

  constructor(options: OrchestratorOptions) {
    this.agentId = options.agentId ?? 'default';
    this.client = options.client;
    this.model = options.model;
    this.maxTokens = options.maxTokens;
    this.maxIterations = options.maxToolIterations;
    this.loopRepeatSoft = options.loopRepeatSoft;
    this.loopRepeatHard = options.loopRepeatHard;
    this.maxTurnMs =
      options.maxTurnSeconds && options.maxTurnSeconds > 0
        ? Math.trunc(options.maxTurnSeconds * 1000)
        : 0;
    this.memoryToolHandler = options.memoryToolHandler;
    this.domainToolsByName = new Map(options.domainTools.map((t) => [t.name, t]));
    this.knowledgeGraph = options.knowledgeGraph;
    this.knowledgeGraphTool = options.knowledgeGraph
      ? new KnowledgeGraphTool(options.knowledgeGraph, options.embeddingClient)
      : undefined;
    this.factExtractor = options.factExtractor;
    this.chatParticipantsTool = options.chatParticipantsTool;
    this.askUserChoiceTool = options.askUserChoiceTool;
    this.suggestFollowUpsTool = options.suggestFollowUpsTool;
    this.findFreeSlotsTool = options.findFreeSlotsTool;
    this.bookMeetingTool = options.bookMeetingTool;
    this.responseGuard = options.responseGuard;
    this.privacyGuard = options.privacyGuard;
    this.pluginConfigGet = options.pluginConfigGet;
    this.nudgeRegistry = options.nudgeRegistry;
    this.nudgeStateStore = options.nudgeStateStore;
    this.nudgeProcessMemory = options.nudgeProcessMemory;
    this.excerptExtractor = options.excerptExtractor;
    this.autoPromote = options.autoPromote ?? false;
    this.autoPromoteThreshold = options.autoPromoteThreshold ?? 0.7;
    this.graphPool = options.graphPool;
    this.graphTenantId = options.graphTenantId;
    this.assistantIdentity =
      options.assistantIdentity?.trim() || DEFAULT_ASSISTANT_IDENTITY;
    this.sessionLogger = options.sessionLogger;
    this.entityRefBus = options.entityRefBus;
    this.contextRetriever = options.contextRetriever;
    this.sessionBriefing = options.sessionBriefing;
    this.turnHookRegistry = options.turnHookRegistry;

    this.nativeTools = options.nativeToolRegistry;
    for (const name of KERNEL_NATIVE_TOOL_NAMES) {
      if (!this.nativeTools.has(name)) {
        this.nativeTools.register(name);
      }
    }
  }

  /** Fresh {@link LoopGuard} for one turn, wired to this Agent's thresholds. */
  private newLoopGuard(): LoopGuard {
    return new LoopGuard({
      ...(this.loopRepeatSoft !== undefined
        ? { softRepeat: this.loopRepeatSoft }
        : {}),
      ...(this.loopRepeatHard !== undefined
        ? { hardRepeat: this.loopRepeatHard }
        : {}),
    });
  }

  /** True once the optional per-turn wall-clock budget is spent (0 = off). */
  private turnBudgetExceeded(startedAtMs: number): boolean {
    return this.maxTurnMs > 0 && Date.now() - startedAtMs >= this.maxTurnMs;
  }

  /**
   * Slice 4b/4c — auto-promotion call. Awaited (not fire-and-forget)
   * since 4c so the chat-side `done` event can carry the resulting
   * `autoPromotedMkId` and the UI can render an inline banner with
   * Edit/Discard affordances immediately.
   *
   * No-op when `autoPromote=false` (default) or the required handles
   * are absent — returns undefined in microseconds, no DB touch.
   *
   * Significance lives on `graph_nodes.significance` (column). At
   * `capture_level=minimal` the scorer is off and significance stays
   * null — the helper then skips with reason='no-significance' and the
   * orchestrator returns undefined. That's intentional: auto-saves
   * require an explicit signal — operator opts into BOTH
   * `capture_level>=normal` AND `KG_ACL_AUTO_PROMOTE=true`.
   *
   * Never throws. Failures inside promoteTurnIfSignificant are caught
   * and logged there; we still defend against unexpected throws with
   * a try/catch so the `done` yield always fires.
   */
  private async maybePromoteTurn(opts: {
    turnId: string | undefined;
    userId: string | undefined;
    palaiaExcerpt: PalaiaExcerpt | undefined;
    fallbackAssistantAnswer: string;
  }): Promise<string | undefined> {
    if (!this.autoPromote) return undefined;
    if (!this.graphPool || !this.graphTenantId) return undefined;
    if (!opts.turnId || !opts.userId) return undefined;
    if (!this.knowledgeGraph) return undefined;
    const promotionInput = {
      pool: this.graphPool,
      tenantId: this.graphTenantId,
      kg: this.knowledgeGraph,
      turnId: opts.turnId,
      userId: opts.userId,
      threshold: this.autoPromoteThreshold,
      fallbackAssistantAnswer: opts.fallbackAssistantAnswer,
      // Per-orchestrator isolation: stamp the producing Agent so auto-promoted
      // MK default-isolates to it (team/public promotion stays cross-agent).
      originAgent: this.agentId,
      ...(opts.palaiaExcerpt ? { palaiaExcerpt: opts.palaiaExcerpt } : {}),
    };
    try {
      const result = await promoteTurnIfSignificant(promotionInput);
      return result.mkId;
    } catch (err) {
      console.error(
        '[orchestrator] auto-promote unexpected throw (continuing):',
        err instanceof Error ? err.message : err,
      );
      return undefined;
    }
  }

  /**
   * Slice 4a — fetch a Palaia-Excerpt for the save-as-memory modal. No-op
   * when the extractor isn't installed. All failure paths return
   * `undefined` so the `done` yield never throws on an enrichment miss.
   *
   * Note: we currently pass the raw user message + assistant answer
   * directly. Hint precedence (`<palaia-hint type=…>`) is supported by
   * the extractor API but not yet wired here — that requires surfacing
   * the capture-filter's parseHints output, which is hidden behind the
   * sessionLogger.log pipeline today. Slice 4c can revisit when the
   * decision becomes reachable from this scope.
   */
  private async maybeExtractExcerpt(
    userMessage: string,
    answer: string,
  ): Promise<PalaiaExcerpt | undefined> {
    if (!this.excerptExtractor) return undefined;
    try {
      return await this.excerptExtractor.extract({
        cleanedUserMessage: userMessage,
        cleanedAssistantAnswer: answer,
      });
    } catch (err) {
      console.error(
        '[orchestrator] palaia-excerpt extraction failed (continuing without enrichment):',
        err instanceof Error ? err.message : err,
      );
      return undefined;
    }
  }

  /**
   * Palaia Phase 8 (OB-77) — run the nudge pipeline against this iteration's
   * tool_results. Mutates the `content` field of each `tool_result` block
   * in-place when a provider emits a `<nudge>`; persists the emission via
   * the configured `NudgeStateStore` (best-effort, errors logged).
   *
   * Skips entirely when the registry isn't installed (byte-identical
   * pre-plugin behaviour). Read-only against the per-turn `counter` from
   * the caller — that counter enforces the `NUDGE_MAX_PER_TURN` cap across
   * all tool-calls of the turn.
   */
  private async applyNudgePipeline(
    toolUses: ContentBlock[],
    toolResults: ContentBlock[],
    counter: NudgeTurnCounter,
    cumulativeTrace: Array<{
      toolName: string;
      args: unknown;
      result: string;
      status: 'ok' | 'error';
      domain?: string;
    }>,
    input: ChatTurnInput,
    turnId: string,
    onNudge?: (event: {
      id: string;
      nudgeId: string;
      text: string;
      cta?: {
        label: string;
        toolName: string;
        arguments: Record<string, unknown>;
      };
    }) => void,
  ): Promise<void> {
    if (!this.nudgeRegistry) return;
    const registry = this.nudgeRegistry;
    const stateStore = this.nudgeStateStore;
    if (!stateStore) return;

    const sessionScope = input.sessionScope ?? '';
    const agentId = 'orchestrator';
    // OB-77 — append THIS iteration's entries onto the turn-cumulative
    // trace BEFORE running the pipeline so the multi-domain trigger sees
    // every tool the agent has used so far in this turn (sub-agents
    // typically run one tool per iteration, so a per-iteration view of
    // the trace would never reach ≥2 distinct domains in turns where
    // they're called sequentially — exactly the lead-use-case shape).
    for (let i = 0; i < toolUses.length; i++) {
      const use = toolUses[i];
      if (!use) continue;
      const r = toolResults[i];
      const content = r?.content;
      const result = typeof content === 'string' ? content : '';
      const isError = r?.is_error === true;
      const toolName = String(use.name ?? '');
      const domain =
        this.domainToolsByName.get(toolName)?.domain ??
        this.nativeTools.getDomain(toolName);
      cumulativeTrace.push({
        toolName,
        args: use.input,
        result,
        status: isError ? 'error' : 'ok',
        ...(domain !== undefined ? { domain } : {}),
      });
    }
    const toolTrace = cumulativeTrace as ReadonlyArray<typeof cumulativeTrace[number]>;

    for (let i = 0; i < toolResults.length; i++) {
      const r = toolResults[i];
      if (!r || r.type !== 'tool_result') continue;
      const use = toolUses[i];
      if (!use) continue;
      const content = typeof r.content === 'string' ? r.content : '';
      const errored = r.is_error === true;
      const toolName = String(use.name ?? '');

      try {
        const out = await runNudgePipeline({
          turnContext: {
            turnId,
            agentId,
            userMessage: input.userMessage,
            toolTrace,
            sessionScope,
          },
          toolName,
          toolArgs: use.input,
          toolResult: content,
          registry,
          stateStore,
          turnCounter: counter,
          ...(this.nudgeProcessMemory
            ? { processMemory: this.nudgeProcessMemory }
            : {}),
          toolErrored: errored,
        });
        if (out.emission) {
          r.content = out.content;
          stateStore.recordEmission(out.emission).catch((err: unknown) => {
            console.error(
              `[nudge-pipeline] recordEmission failed for "${out.emission?.nudgeId ?? '?'}": ${err instanceof Error ? err.message : String(err)}`,
            );
          });
          // OB-77 — surface the nudge as a dedicated stream event so the
          // channel UI can render a consolidated list under the tool
          // trace (not inside the individual tool row, which gets
          // collapsed by default and hides the coaching from the
          // operator). The XML block in `r.content` stays intact for
          // the agent's next API call.
          if (onNudge) {
            const useId = String(use.id ?? '');
            onNudge({
              id: useId,
              nudgeId: out.emission.nudgeId,
              text: out.emission.hintText,
              ...(out.emission.cta
                ? {
                    cta: {
                      label: out.emission.cta.label,
                      toolName: out.emission.cta.toolCall.name,
                      arguments: out.emission.cta.toolCall.arguments,
                    },
                  }
                : {}),
            });
          }
        }
      } catch (err) {
        console.error(
          `[nudge-pipeline] runNudgePipeline threw for tool "${toolName}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * Collect diagram renders produced during the current turn and reset the
   * tool's buffer. Idempotent: returns undefined if the tool wasn't invoked.
   *
   * Today the orchestrator allows at most one diagram per turn (the LLM rarely
   * needs more), but the return type is an array so multi-diagram turns just
   * work once the tool starts returning multiple RenderOutputs.
   */
  private drainAttachments(): {
    diagrams: DiagramAttachment[];
    files: OutgoingFileAttachment[];
  } {
    const diagrams: DiagramAttachment[] = [];
    const files: OutgoingFileAttachment[] = [];
    // Plugin-contributed sinks. Each native tool returns its pending
    // attachments (if any) and resets its internal buffer; an empty or
    // undefined return is the common case and cheap. The sink can only be
    // drained ONCE per turn (it clears on read), so we partition by kind in
    // this single pass: `diagram` → inline image (render_diagram), `file` →
    // downloadable document (@omadia/plugin-office).
    for (const entry of this.nativeTools.listWithHandler()) {
      if (!entry.attachmentSink) continue;
      const payloads = entry.attachmentSink();
      if (!payloads?.length) continue;
      for (const p of payloads) {
        if (p.kind === 'diagram') {
          diagrams.push(p.payload as DiagramAttachment);
        } else if (p.kind === 'file') {
          const f = p.payload as {
            url: string;
            altText: string;
            mediaType: string;
            sizeBytes?: number;
            producer?: string;
          };
          files.push({
            kind: 'file',
            url: f.url,
            altText: f.altText,
            mediaType: f.mediaType,
            ...(f.sizeBytes !== undefined ? { sizeBytes: f.sizeBytes } : {}),
            ...(f.producer ? { producer: f.producer } : {}),
          });
        }
        // Unknown kinds flow nowhere today — a future adapter can add a branch.
      }
    }
    return { diagrams, files };
  }

  /**
   * Deterministic guard for the "announced a file but never built it" failure.
   * The model sometimes ends a turn saying "ich baue jetzt die Excel…" and
   * stops, without ever calling create_xlsx/create_docx — leaving the user
   * empty-handed (prompt rules alone don't reliably prevent it). True when the
   * final answer announces a file build, an office file tool is registered, and
   * NO file attachment was produced this turn. The caller then forces exactly
   * one continuation so the model actually calls the tool (or declines).
   */
  private fileAnnouncedButNotBuilt(answer: string, filesProduced: number): boolean {
    if (filesProduced > 0) return false;
    if (
      !this.nativeTools.has('create_xlsx') &&
      !this.nativeTools.has('create_docx')
    ) {
      return false;
    }
    return FILE_ANNOUNCE_RE.test(answer);
  }

  /**
   * Collect a pending `ask_user_choice` request scheduled during the current
   * tool batch and clear the tool's buffer. Called once per iteration after
   * the tool loop; a non-undefined return terminates the turn early so the
   * channel adapter can render a Smart-Card instead of issuing another
   * Anthropic request. Mirrors `drainAttachments`.
   */
  private drainPendingChoice(): PendingUserChoice | undefined {
    return this.askUserChoiceTool?.takePending();
  }

  /**
   * OB-29-4 — scan plugin-tool result strings for an in-band
   * `_pendingUserChoice` payload. Plugins (which have no kernel-internal
   * `askUserChoiceTool` to invoke) can short-circuit a turn by returning a
   * JSON tool-result like:
   *
   *     {"ok":true,"_pendingUserChoice":{
   *        "question":"Welcher John?",
   *        "options":[{"label":"...","value":"..."}]}}
   *
   * The first plugin-tool in the batch that emits a valid payload wins;
   * subsequent ones in the same batch are ignored (deterministic with
   * submission order). Built-in tools never reach this path because their
   * pending state already flows through `askUserChoiceTool.takePending()`.
   *
   * Defensive: malformed JSON or shape-mismatch silently yields `undefined`
   * — a plugin that emits non-JSON tool-results stays a regular plain-text
   * tool call.
   */
  private extractToolEmittedChoice(
    toolResults: ContentBlock[],
  ): PendingUserChoice | undefined {
    for (const block of toolResults) {
      if (block.type !== 'tool_result') continue;
      // is_error blocks are returned verbatim to the model; never short-
      // circuit on a failed tool call.
      const blockShape = block as {
        type: string;
        content?: unknown;
        is_error?: boolean;
      };
      if (blockShape.is_error) continue;
      const content = blockShape.content;
      if (typeof content !== 'string') continue;
      const parsed = parseToolEmittedChoice(content);
      if (parsed) return parsed;
    }
    return undefined;
  }

  /**
   * Collect follow-up suggestions scheduled during the current turn and
   * clear the tool's buffer. Called once per turn alongside
   * `drainAttachments`. Unlike `drainPendingChoice`, this does NOT
   * short-circuit the turn — follow-ups are a sidecar on a normal answer.
   */
  private drainFollowUps(): FollowUpOption[] | undefined {
    const pending = this.suggestFollowUpsTool?.takePending();
    if (!pending || pending.length === 0) return undefined;
    return pending;
  }

  /**
   * Collect a pending slot-picker card scheduled by `find_free_slots` during
   * the current turn and clear the tool's buffer. Sidecar pattern — does
   * NOT terminate the turn. Mirrors `drainFollowUps`.
   */
  private drainPendingSlotCard(): PendingSlotCard | undefined {
    return this.findFreeSlotsTool?.takePendingCard();
  }

  /**
   * Scan tool_result content blocks for an in-band `_pendingRoutineList`
   * sidecar payload (emitted by the routines plugin's `manage_routine.list`
   * action). The most recent payload wins if multiple tool_results carry
   * one (deterministic with submission order). Sidecar — never aborts the
   * turn loop; the routine list flows out alongside the natural-language
   * answer at done time.
   */
  private extractToolEmittedRoutineList(
    toolResults: Array<{ type: string; content?: unknown; is_error?: boolean }>,
  ): void {
    for (const block of toolResults) {
      if (block.type !== 'tool_result') continue;
      if (block.is_error) continue;
      const content = block.content;
      if (typeof content !== 'string') continue;
      const parsed = parseToolEmittedRoutineList(content);
      if (parsed) {
        this.pendingRoutineList = parsed;
      }
    }
  }

  /** Return + clear the routine-list scratchpad. */
  private drainPendingRoutineList(): PendingRoutineList | undefined {
    const out = this.pendingRoutineList;
    this.pendingRoutineList = undefined;
    return out;
  }

  /**
   * Return `true` when either calendar tool hit `consent_required` during
   * the current turn. Drains both tools so a subsequent turn starts clean.
   */
  private drainConsentRequired(): boolean {
    const a = this.findFreeSlotsTool?.takeConsentRequired() ?? false;
    const b = this.bookMeetingTool?.takeConsentRequired() ?? false;
    return a || b;
  }

  /**
   * Install the per-turn SSO context on the calendar tools before the tool
   * loop, and remove it after — so a tool invocation on a subsequent turn
   * without an assertion can't accidentally reuse a stale token.
   */
  private applyTurnAuthContext(input: ChatTurnInput): void {
    if (!input.ssoAssertion) {
      this.findFreeSlotsTool?.clearTurnContext();
      this.bookMeetingTool?.clearTurnContext();
      return;
    }
    const ctx: TurnAuthContext = {
      ssoAssertion: input.ssoAssertion,
      ...(input.userTimeZone ? { userTimeZone: input.userTimeZone } : {}),
    };
    this.findFreeSlotsTool?.setTurnContext(ctx);
    this.bookMeetingTool?.setTurnContext(ctx);
  }

  private clearTurnAuthContext(): void {
    this.findFreeSlotsTool?.clearTurnContext();
    this.bookMeetingTool?.clearTurnContext();
  }

  /**
   * Retrieve conversational context for the current turn. Returns undefined
   * on any retriever failure so a transient graph hiccup never blocks the
   * user-facing answer. Called exactly once per turn; the result is passed
   * to every `buildSystemBlocks` call inside the tool loop so the content is
   * byte-identical across iterations and hits the prompt cache on iteration 2+.
   */
  private async retrievePriorContext(
    input: ChatTurnInput,
  ): Promise<{ text: string | undefined; recalled: RecalledContext | undefined }> {
    // Use console.error so the trace lands on stderr — Fly's log aggregator
    // has been observed to drop some stdout INFO lines under load, and this
    // is the one pathway we cannot afford to lose visibility on.
    if (input.freshCheck) {
      console.error('[context] SKIP fresh-check');
      return { text: undefined, recalled: undefined };
    }
    if (!this.contextRetriever) {
      console.error('[context] SKIP no-retriever');
      return { text: undefined, recalled: undefined };
    }
    if (!input.sessionScope && !input.userId) {
      console.error('[context] SKIP no-scope-no-user');
      return { text: undefined, recalled: undefined };
    }
    try {
      // OB-74 (Palaia Phase 5) — switch to the token-budget assembler. The
      // recall legs are unchanged (tail + entity + hybrid-FTS); the
      // assembler adds per-agent block/boost (when the KG provider
      // publishes agentPriorities@1) + manual_authored × 1.3 + greedy
      // fill against a configured token budget. agentId='orchestrator-default'
      // for the main chat path; sub-agents that consume the retriever
      // directly should pass their manifest identity.id so per-agent
      // priorities apply.
      const result = await this.contextRetriever.assembleForBudget({
        userMessage: input.userMessage,
        // Per-orchestrator isolation: the real Agent identity drives the KG
        // scope-prefix filter (and agent_priorities). The retriever expects
        // the sessionScope already agent-qualified — `graphScopeFor` is the
        // SAME formula SessionLogger writes with, so `turnNodeId`/`getSession`
        // agree on both the ingest and recall sides.
        agentId: this.agentId,
        agentScopePrefix: agentScopePrefix(this.agentId),
        ...(input.sessionScope
          ? { sessionScope: graphScopeFor(this.agentId, input.sessionScope) }
          : {}),
        ...(input.userId ? { userId: input.userId } : {}),
      });
      console.error(
        `[context] assembled scope=${input.sessionScope ?? '-'} user=${input.userId ?? '-'} pool=${String(result.stats.candidatePool)} included=${String(result.included.length)} excluded=${String(result.excluded.length)} compact=${String(result.stats.compactMode)} tokens=${String(result.stats.tokensUsed)} rendered=${String(result.text.length)}B`,
      );

      // OB-75 (Palaia Phase 6) — session-continuity briefing. Only
      // 'briefing' mode adds value here: 'resume' mode would duplicate
      // the tail that the assembler already includes. The briefing
      // service short-circuits cheaply when there's no scope, no
      // session, or the existing summary is fresh.
      let briefingText = '';
      if (this.sessionBriefing && input.sessionScope) {
        try {
          const briefing = await this.sessionBriefing.loadSessionBriefing({
            // Qualified scope so the briefing reads THIS Agent's turns only.
            scope: graphScopeFor(this.agentId, input.sessionScope),
            agentId: this.agentId,
            ...(input.userId ? { userId: input.userId } : {}),
          });
          if (briefing.mode === 'briefing' && briefing.text.length > 0) {
            briefingText = briefing.text;
            console.error(
              `[briefing] mode=${briefing.mode} regenerated=${String(briefing.stats.summaryRegenerated)} openTasks=${String(briefing.stats.openTasks)} tokens=${String(briefing.stats.tokensUsed)}`,
            );
          }
        } catch (err) {
          // Non-fatal — chat continues without the briefing block.
          console.error(
            '[briefing] load FAILED — continuing without:',
            err instanceof Error ? err.message : err,
          );
        }
      }

      const merged =
        briefingText.length > 0 && result.text.length > 0
          ? `${briefingText}\n\n---\n\n${result.text}`
          : briefingText.length > 0
            ? briefingText
            : result.text;
      return {
        text: merged.length > 0 ? merged : undefined,
        recalled: result.recalled,
      };
    } catch (err) {
      console.error(
        '[context] retrieval FAILED — continuing without:',
        err instanceof Error ? err.message : err,
      );
      return { text: undefined, recalled: undefined };
    }
  }

  /** Cross-session recall probe — map the assembled `recalled` payload to a
   *  `kg_recall` turn-annotation event when it carries anything. Returns []
   *  (no event) when every leg was empty so cold-start turns stay quiet. */
  private toRecallAnnotationEvents(
    recalled: RecalledContext | undefined,
  ): ChatStreamEvent[] {
    if (
      !recalled ||
      (recalled.plans.length === 0 &&
        recalled.processes.length === 0 &&
        recalled.insights.length === 0)
    ) {
      return [];
    }
    return [
      {
        type: 'turn_annotation' as const,
        channel: 'kg_recall',
        payload: recalled,
      },
    ];
  }

  /**
   * Public ChatAgent.chat — channel-facing. Delegates to the full-state
   * `runTurn()` and converts the internal `ChatTurnResult` to the
   * channel-agnostic `SemanticAnswer` at the boundary. Callers that need the
   * internal shape (currently: `VerifierService` for `runTrace` access) use
   * `runTurn()` directly.
   */
  async chat(input: ChatTurnInput): Promise<SemanticAnswer> {
    const result = await this.runTurn(input);
    return toSemanticAnswer(result);
  }

  async runTurn(input: ChatTurnInput): Promise<ChatTurnResult> {
    const turnId = randomUUID();
    // Inherit optional fields the channel adapter (e.g. Teams bot) set in an
    // outer ALS scope. The new child scope replaces turnId/turnDate for this
    // turn; carry-through fields like `chatParticipants` must be threaded
    // explicitly or the tool handlers would see them as undefined.
    const parent = turnContext.current();

    // Privacy-Proxy Slice 2.1 hook. When a `privacy.redact@1` provider is
    // registered, mint a per-turn handle scoped to (sessionScope, turnId)
    // and thread it through the AsyncLocalStorage so every `messages.create`
    // / `messages.stream` site in the call tree (main + sub-agents) picks
    // it up implicitly. After `chatInContext` returns we drain the
    // turn-aggregated receipt and attach it to the result.
    const sessionId = input.sessionScope ?? turnId;
    const privacyService = this.privacyGuard?.();
    const privacyHandle = privacyService
      ? this.buildPrivacyHandle(privacyService, sessionId, turnId)
      : undefined;

    return turnContext.run(
      {
        turnId,
        turnDate: today(),
        // Per-orchestrator isolation: expose THIS Agent's identity to the
        // per-call MemoryAccessor (plugin/sub-agent memory namespacing).
        agentSlug: this.agentId,
        ...(parent?.chatParticipants
          ? { chatParticipants: parent.chatParticipants }
          : {}),
        ...(privacyHandle ? { privacyHandle } : {}),
        ...(parent?.captureRawToolResult
          ? { captureRawToolResult: parent.captureRawToolResult }
          : {}),
      },
      async () => {
        let result = await this.chatInContext(input, turnId);
        // Privacy Shield v4 — when a v4_render_answer call produced the
        // answer this turn it is final and already safe (real values
        // materialized server-side from ground truth). Swap it in.
        if (privacyHandle) {
          const v4Rendered = await privacyHandle.takeRenderedAnswerV4();
          if (v4Rendered !== undefined) {
            result = {
              ...result,
              answer: v4Rendered.text,
              ...(v4Rendered.maskedValues.length > 0
                ? { maskedValues: v4Rendered.maskedValues }
                : {}),
            };
          }
        }
        if (privacyHandle) {
          try {
            const receipt = await privacyHandle.finalize(input.userMessage);
            if (receipt) {
              return { ...result, privacyReceipt: receipt };
            }
          } catch (err) {
            console.warn(
              '[orchestrator] privacyGuard.finalizeTurn threw — receipt dropped:',
              err,
            );
          }
        }
        return result;
      },
    );
  }

  /**
   * Fire a turn-hook side-channel (#133 E0). No-op when no runner is
   * injected. Never throws — the runner swallows hook errors, and we add a
   * defensive try/catch so a misbehaving runner cannot abort the turn.
   */
  private async fireTurnHook(
    point: TurnHookPoint,
    turnId: string,
    input: ChatTurnInput,
    payload: TurnHookPayload,
    /**
     * Optional cap (ms). The post-turn observer hooks (onAfterToolCall /
     * onAfterTurn) MUST NOT gate the turn: a slow or hung consumer (e.g. a
     * stalled KG write) would otherwise block the streamed answer forever.
     * When set, we stop waiting after `timeoutMs` and let the turn proceed;
     * the hook keeps running detached. `onBeforeTurn` is left UNBOUNDED — its
     * plan must be materialised before the turn executes.
     */
    timeoutMs?: number,
  ): Promise<TurnAnnotation[]> {
    const runner = this.turnHookRegistry;
    if (!runner) return [];
    const onFail = (err: unknown): TurnAnnotation[] => {
      console.error(
        `[orchestrator] turn-hook ${point} runner threw (continuing):`,
        err instanceof Error ? err.message : err,
      );
      return [];
    };
    try {
      // Self-catching so a rejecting hook can never surface as an unhandled
      // rejection once we stop awaiting it on timeout.
      const run = Promise.resolve(
        runner.run(
          point,
          {
            turnId,
            ...(input.sessionScope ? { sessionScope: input.sessionScope } : {}),
            ...(input.userId ? { userId: input.userId } : {}),
            // Per-orchestrator isolation: hooks that persist scope-keyed KG
            // artefacts (plan-runner) qualify their scope with this.
            agentSlug: this.agentId,
          },
          payload,
        ),
      ).catch(onFail);
      if (timeoutMs && timeoutMs > 0) {
        // Bounded: a slow observer must not gate the stream. If it times out we
        // return no annotations (this emit is skipped; a later one catches up).
        let timer: ReturnType<typeof setTimeout> | undefined;
        const guard = new Promise<TurnAnnotation[]>((resolve) => {
          timer = setTimeout(() => resolve([]), timeoutMs);
        });
        return await Promise.race([
          run.finally(() => {
            if (timer) clearTimeout(timer);
          }),
          guard,
        ]);
      }
      return await run;
    } catch (err) {
      return onFail(err);
    }
  }

  /** #133 (E9) — map turn-hook annotations to `turn_annotation` stream events.
   *  The orchestrator forwards them opaquely; only the streaming path emits. */
  private toAnnotationEvents(annotations: TurnAnnotation[]): ChatStreamEvent[] {
    return annotations.map((a) => ({
      type: 'turn_annotation' as const,
      channel: a.channel,
      payload: a.payload,
    }));
  }

  private async chatInContext(
    input: ChatTurnInput,
    turnId: string,
  ): Promise<ChatTurnResult> {
    this.applyTurnAuthContext(input);
    try {
      const result = await this.chatInContextInner(input, turnId);
      await this.fireTurnHook(
        'onAfterTurn',
        turnId,
        input,
        {
          assistantAnswer: result.answer,
          // #133 (E8) — surface the persisted Turn node id so observers can
          // link to the graph Turn (plan-runner PLAN_OF). Absent if the log failed.
          ...(result.turnId ? { turnExternalId: result.turnId } : {}),
        },
        2000,
      );
      return result;
    } finally {
      this.clearTurnAuthContext();
    }
  }

  private async chatInContextInner(
    input: ChatTurnInput,
    turnId: string,
  ): Promise<ChatTurnResult> {
    await this.fireTurnHook('onBeforeTurn', turnId, input, {
      userMessage: input.userMessage,
    });
    // Non-streaming path: `priorContext` is injected into the prompt; the
    // structured `recalled` payload rides out on the ChatTurnResult so
    // non-streaming channels (Teams) can render a recall card (the streaming
    // path emits it as a `kg_recall` annotation instead).
    const { text: priorContext, recalled } =
      await this.retrievePriorContext(input);
    const effectiveExtraSystemHint = composeExtraSystemHint(input);
    // Palaia Phase 8 (OB-77) — per-turn nudge counter (shared across all
    // tool-call iterations of this turn so NUDGE_MAX_PER_TURN is enforced).
    const nudgeCounter = createNudgeTurnCounter();
    // Palaia Phase 8 (OB-77) — turn-cumulative tool trace. Each iteration
    // appends its tool-uses; the pipeline's multi-domain trigger reads the
    // cumulative array, NOT just the current iteration. Sub-agents tend to
    // run one tool per iteration, so a per-iteration view would never see
    // the cross-domain shape the lead heuristic looks for.
    const nudgeTrace: Array<{
      toolName: string;
      args: unknown;
      result: string;
      status: 'ok' | 'error';
      domain?: string;
    }> = [];

    const messages: Array<{ role: 'user' | 'assistant'; content: ContentBlock[] | string }> = [
      // Live chat history first. Each turn becomes a (user, assistant) pair —
      // same shape the Anthropic API expects for a multi-turn conversation.
      // Empty pairs are filtered so a failed prior turn can't poison context.
      ...(input.priorTurns ?? []).flatMap<{
        role: 'user' | 'assistant';
        content: ContentBlock[] | string;
      }>((t) => {
        const pair: Array<{
          role: 'user' | 'assistant';
          content: ContentBlock[] | string;
        }> = [];
        if (t.userMessage.trim().length > 0) {
          pair.push({ role: 'user', content: t.userMessage });
        }
        if (t.assistantAnswer.trim().length > 0) {
          pair.push({ role: 'assistant', content: t.assistantAnswer });
        }
        return pair;
      }),
      { role: 'user', content: buildUserContent(input) },
    ];

    // Open an EntityRef collection keyed to this turn. Tool handlers that
    // publish during the turn will be matched by turnId via AsyncLocalStorage.
    // Always drain — on success, iteration-overrun throw, or upstream error.
    const entityCollection = this.entityRefBus?.beginCollection(turnId);

    let toolCalls = 0;
    // Claude may emit natural-language text alongside tool_use in the same assistant
    // turn. We accumulate text across all turns so the final answer isn't truncated to
    // whatever happens to be in the last response alone.
    const textParts: string[] = [];
    // One forced file-build retry per turn (see fileAnnouncedButNotBuilt).
    let fileForceRetried = false;

    const traceCollector = input.sessionScope
      ? new RunTraceCollector({
          scope: input.sessionScope,
          ...(input.userId ? { userId: input.userId } : {}),
        })
      : undefined;

    // Phase-1 Kemia hook — resolved ONCE at turn start. Empty when no
    // `responseGuard@1` provider is installed; identical cache shape then.
    const prependRules = await this.resolvePrependRules(messages);

    // Round-loop guard + optional wall-clock budget. `forceFinalize` latches
    // once the guard (or the time budget) decides the turn must wrap up; the
    // next iteration then runs tools-disabled and produces a best-effort
    // answer instead of throwing the raw "exceeded maxToolIterations" error.
    const loopGuard = this.newLoopGuard();
    const turnStartedAt = Date.now();
    let forceFinalize = false;

    try {
      for (let iteration = 0; iteration < this.maxIterations; iteration++) {
        // Final pass: the loop guard stopped, the wall-clock budget is spent,
        // or this is the last allowed iteration. Disable tools so the model
        // MUST answer in text, and append the finalize directive.
        const finalizeThisIter =
          forceFinalize ||
          iteration === this.maxIterations - 1 ||
          this.turnBudgetExceeded(turnStartedAt);
        const baseParams = {
          model: this.model,
          max_tokens: this.maxTokens,
          system: buildSystemBlocks(
            this.composeStableSystemPrompt(prependRules),
            priorContext,
            withFinalizeHint(effectiveExtraSystemHint, finalizeThisIter),
          ),
          tools: finalizeThisIter ? [] : this.buildToolsList(),
          messages,
        };
        // Last-resort guard: repair any lone UTF-16 surrogate before the
        // SDK serialises the body — the Anthropic API rejects it as
        // invalid JSON. See ensureWellFormedParams.
        const safeParams = ensureWellFormedParams(baseParams);

        const response: Message = await this.client.messages.create(
          safeParams,
          { headers: { 'anthropic-beta': MEMORY_BETA_HEADER } },
        );

        messages.push({ role: 'assistant', content: response.content });
        textParts.push(...collectTextBlocks(response.content));

        if (response.stop_reason !== 'tool_use') {
          const answer = textParts.join('\n\n').trim();
          const drainedAttachments = this.drainAttachments();
          // Only force a retry on a PURE-TEXT end (no tool_use block). A
          // tool_use present with a non-'tool_use' stop_reason means the model
          // was mid-call (e.g. max_tokens truncation) — injecting a user
          // message after it orphans the tool_use and the API 400s the next
          // request. In that case finalize normally instead.
          const responseHasToolUse = response.content.some(
            (b: ContentBlock) => b.type === 'tool_use',
          );
          if (
            !finalizeThisIter &&
            !fileForceRetried &&
            !responseHasToolUse &&
            this.fileAnnouncedButNotBuilt(answer, drainedAttachments.files.length)
          ) {
            fileForceRetried = true;
            messages.push({ role: 'user', content: FILE_RETRY_NUDGE });
            textParts.length = 0;
            console.error(
              '[orchestrator] file announced but not built — forcing one retry to call create_xlsx/create_docx',
            );
            continue;
          }
          const iterations = iteration + 1;
          const runTrace = traceCollector?.finish({
            iterations,
            status: 'success',
          });
          const attachments =
            drainedAttachments.diagrams.length > 0
              ? drainedAttachments.diagrams
              : undefined;
          const fileAttachments =
            drainedAttachments.files.length > 0
              ? drainedAttachments.files
              : undefined;
          // Hoisted so the return payload can carry the KG turn id back to
          // the chat UI (powers the save-as-memory affordance). Stays
          // undefined when session-logging is disabled or threw.
          let persistedTurnId: string | undefined;
          if (this.sessionLogger && input.sessionScope) {
            // Await the log write: previous fire-and-forget let follow-ups
            // race ahead of the session persisting their prior turn, so the
            // verbatim tail came back empty and the bot "forgot" the last
            // chart / answer. The write is fast (~sub-second against Neon);
            // the latency cost is worth the retrieval guarantee.
            const entityRefs = entityCollection?.drain() ?? [];
            const answerForGraph = appendToolDigest(
              answer,
              attachments,
              fileAttachments,
            );
            try {
              const logged = await this.sessionLogger.log({
                scope: input.sessionScope,
                userMessage: input.userMessage,
                assistantAnswer: answerForGraph,
                toolCalls,
                iterations,
                entityRefs,
                ...(input.userId ? { userId: input.userId } : {}),
                ...(runTrace ? { runTrace } : {}),
              });
              persistedTurnId = logged.turnExternalId;
            } catch (err) {
              console.error(
                '[orchestrator] session log failed (continuing with answer):',
                err instanceof Error ? err.message : err,
              );
            }
            // Fact extraction: fire-and-forget against Haiku, after the
            // session log lands in the graph (so the Fact → Turn
            // DERIVED_FROM edge finds its anchor). Never awaited — a slow
            // or failing extractor must not delay the user reply.
            if (this.factExtractor && persistedTurnId) {
              void this.factExtractor.extractAndIngest({
                turnId: persistedTurnId,
                userMessage: input.userMessage,
                assistantAnswer: answerForGraph,
                entityRefs,
              });
            }
          }
          const followUpOptions = this.drainFollowUps();
          const pendingSlotCard = this.drainPendingSlotCard();
          const pendingRoutineList = this.drainPendingRoutineList();
          const pendingOAuthConsent = this.drainConsentRequired();
          return {
            answer,
            toolCalls,
            iterations,
            ...(persistedTurnId ? { turnId: persistedTurnId } : {}),
            ...(runTrace ? { runTrace } : {}),
            ...(attachments ? { attachments } : {}),
            ...(fileAttachments ? { fileAttachments } : {}),
            ...(followUpOptions ? { followUpOptions } : {}),
            ...(pendingSlotCard ? { pendingSlotCard } : {}),
            ...(pendingRoutineList ? { pendingRoutineList } : {}),
            ...(pendingOAuthConsent ? { pendingOAuthConsent: true } : {}),
            ...(recalled ? { recalled } : {}),
          };
        }

        const toolUses = response.content.filter(
          (block: ContentBlock) => block.type === 'tool_use',
        );

        // Dispatch all tools of this iteration in parallel. Non-streaming
        // path: no observer queue, no heartbeats, no tick-loop — just race
        // every dispatch in one Promise.allSettled and assemble results in
        // submission order. Mirror of the streaming-side parallelisation in
        // chatStreamInner.
        toolCalls += toolUses.length;
        const startedTimes = toolUses.map(() => Date.now());
        const invocations = toolUses.map((use: ContentBlock) => {
          const isNative = this.nativeTools.has(use.name);
          return !isNative && traceCollector
            ? traceCollector.beginInvocation(use.name)
            : undefined;
        });
        const settled = await Promise.allSettled(
          toolUses.map((use: ContentBlock, i: number) =>
            this.dispatchTool(use.name, use.input, invocations[i]?.observer),
          ),
        );
        const toolResults: ContentBlock[] = toolUses.map((use: ContentBlock, i: number) => {
          const r = settled[i]!;
          let output: string;
          let isError: boolean;
          if (r.status === 'fulfilled') {
            output = r.value;
            isError = output.startsWith('Error:');
          } else {
            output = `Error: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`;
            isError = true;
          }
          const durationMs = Date.now() - startedTimes[i]!;
          const inv = invocations[i];
          if (inv) {
            inv.finish({
              durationMs,
              status: isError ? 'error' : 'success',
            });
          } else if (traceCollector) {
            traceCollector.recordOrchestratorToolCall({
              callId: use.id,
              toolName: use.name,
              durationMs,
              isError,
            });
          }
          return {
            type: 'tool_result',
            tool_use_id: use.id,
            content: output,
            ...(isError ? { is_error: true } : {}),
          };
        });
        // #133 E0 — fire onAfterToolCall once per top-level tool invocation.
        for (let i = 0; i < toolUses.length; i++) {
          const use = toolUses[i]!;
          const name = (use as { name?: unknown }).name;
          const resultBlock = toolResults[i] as { content?: unknown };
          await this.fireTurnHook(
            'onAfterToolCall',
            turnId,
            input,
            {
              ...(typeof name === 'string' ? { toolName: name } : {}),
              ...(typeof resultBlock.content === 'string'
                ? { toolResult: resultBlock.content }
                : {}),
            },
            2000,
          );
        }
        await this.applyNudgePipeline(
          toolUses,
          toolResults,
          nudgeCounter,
          nudgeTrace,
          input,
          turnId,
        );
        // Round-loop guard. A `nudge` steer is appended to THIS iteration's
        // tool-result user message (keeping a single well-formed user turn);
        // a `stop` latches finalize so the next pass answers tools-disabled.
        const loopDecision = loopGuard.record(toolUses, toolResults);
        const userContent: ContentBlock[] = [...toolResults];
        if (loopDecision.action === 'nudge' && loopDecision.nudge) {
          userContent.push({ type: 'text', text: loopDecision.nudge });
          console.error(`[orchestrator] loop guard nudge: ${loopDecision.reason}`);
        } else if (loopDecision.action === 'stop') {
          forceFinalize = true;
          console.error(`[orchestrator] loop guard stop: ${loopDecision.reason}`);
        }
        messages.push({ role: 'user', content: userContent });

        // Short-circuit after ask_user_choice. The turn ends here so the
        // channel adapter can render a Smart-Card; the button click fires a
        // fresh turn. Any pending diagram from the same batch is dropped.
        // OB-29-4 — same short-circuit applies when a plugin-tool returns
        // an in-band `_pendingUserChoice` payload (cf. extractToolEmittedChoice).
        // Sidecar scan: routine list smart-card may piggyback on any
        // plugin-tool result this batch. Stored on the orchestrator until
        // the done block drains it. Doesn't affect short-circuit decisions.
        this.extractToolEmittedRoutineList(toolResults);
        const pendingUserChoice =
          this.drainPendingChoice() ??
          this.extractToolEmittedChoice(toolResults);
        if (pendingUserChoice) {
          this.drainAttachments();
          // Follow-up suggestions are incompatible with a blocking choice
          // card — the user hasn't clarified the request yet, so offering
          // refinements of a non-existent answer would be confusing.
          this.drainFollowUps();
          // Ditto for the slot-picker card — if the model still wants
          // clarification, booking is clearly not ready yet.
          this.drainPendingSlotCard();
          // Same logic for the routine list — discard so it doesn't leak
          // into the next clarification answer. User can ask again after
          // resolving the choice.
          this.drainPendingRoutineList();
          const answer = textParts.join('\n\n').trim();
          const iterations = iteration + 1;
          const runTrace = traceCollector?.finish({
            iterations,
            status: 'success',
          });
          let persistedTurnId: string | undefined;
          if (this.sessionLogger && input.sessionScope) {
            const entityRefs = entityCollection?.drain() ?? [];
            const loggedAnswer = answer.length > 0
              ? `${answer}\n\n[Rückfrage] ${pendingUserChoice.question}`
              : `[Rückfrage] ${pendingUserChoice.question}`;
            try {
              const logged = await this.sessionLogger.log({
                scope: input.sessionScope,
                userMessage: input.userMessage,
                assistantAnswer: loggedAnswer,
                toolCalls,
                iterations,
                entityRefs,
                ...(input.userId ? { userId: input.userId } : {}),
                ...(runTrace ? { runTrace } : {}),
              });
              persistedTurnId = logged.turnExternalId;
            } catch (err) {
              console.error(
                '[orchestrator] session log failed (continuing with choice card):',
                err instanceof Error ? err.message : err,
              );
            }
          }
          return {
            answer,
            toolCalls,
            iterations,
            pendingUserChoice,
            ...(persistedTurnId ? { turnId: persistedTurnId } : {}),
            ...(runTrace ? { runTrace } : {}),
            ...(recalled ? { recalled } : {}),
          };
        }
      }

      throw new Error(
        `Orchestrator exceeded maxToolIterations (${this.maxIterations}) without reaching a final answer.`,
      );
    } finally {
      // Guard against listener leaks on any non-happy exit (throw, iteration
      // overrun). On the success path this is a no-op because `drain()` is
      // idempotent.
      entityCollection?.drain();
    }
  }

  /**
   * Streaming variant of `chat`. Yields events as the tool loop progresses:
   * text deltas stream live, tool calls surface as they're invoked, tool
   * results carry wall-clock duration. Terminates with exactly one `done`
   * (or `error`) event — callers should not expect further events after
   * either. Session-logging + EntityRef capture work identically to `chat`.
   */
  async *chatStream(
    input: ChatTurnInput,
    observer?: AskObserver,
  ): AsyncGenerator<ChatStreamEvent> {
    const turnId = randomUUID();
    // `enter` (not `run`) because AsyncLocalStorage.run doesn't compose with
    // async generators. `enter` binds turnId to the current async resource,
    // which the generator's awaits inherit; scope ends when the HTTP request
    // resource is cleaned up.
    const parent = turnContext.current();

    // Privacy-Proxy Slice 2.1: same handle pattern as `runTurn`. The handle
    // is bound to the AsyncLocalStorage-scoped context here; every
    // `streamMessageEvents` site downstream picks it up implicitly. After
    // `chatStreamInner` yields its `done` event we intercept and decorate
    // with the aggregated receipt.
    const sessionId = input.sessionScope ?? turnId;
    const privacyService = this.privacyGuard?.();
    const privacyHandle = privacyService
      ? this.buildPrivacyHandle(privacyService, sessionId, turnId)
      : undefined;

    turnContext.enter({
      turnId,
      turnDate: today(),
      // Per-orchestrator isolation: see the matching `turnContext.run` above.
      agentSlug: this.agentId,
      ...(parent?.chatParticipants
        ? { chatParticipants: parent.chatParticipants }
        : {}),
      ...(privacyHandle ? { privacyHandle } : {}),
      ...(parent?.captureRawToolResult
        ? { captureRawToolResult: parent.captureRawToolResult }
        : {}),
    });

    this.applyTurnAuthContext(input);
    // #133 E0 — streaming-path turn hooks. tool_result events carry only the
    // tool-use id, so track id→name from tool_use events to label
    // onAfterToolCall.
    const toolNameById = new Map<string, string>();
    // #133 (E9) — onBeforeTurn is unbounded, so the plan-runner's plan snapshot
    // is emitted as the FIRST stream event, before any answer tokens.
    yield* this.toAnnotationEvents(
      await this.fireTurnHook('onBeforeTurn', turnId, input, {
        userMessage: input.userMessage,
      }),
    );
    // Mid-turn steering — register this turn as live so `/chat/steer` can
    // inject extra user messages keyed by the same session scope. The inner
    // loop drains them at each iteration boundary; `endTurn` clears the buffer.
    steeringBus.beginTurn(sessionId);
    try {
      for await (const event of this.chatStreamInner(input, turnId, observer)) {
        if (event.type === 'tool_use') {
          toolNameById.set(event.id, event.name);
        } else if (event.type === 'tool_result') {
          const toolName = toolNameById.get(event.id);
          // Live step updates: emit the refreshed plan snapshot after each tool.
          yield* this.toAnnotationEvents(
            await this.fireTurnHook(
              'onAfterToolCall',
              turnId,
              input,
              {
                ...(toolName ? { toolName } : {}),
                toolResult: event.output,
              },
              2000,
            ),
          );
        }
        if (event.type === 'done' && privacyHandle) {
          // Privacy-Shield v4 — swap in the server-materialized answer
          // (real values, never round-tripped through the LLM) before the
          // turn's privacy state is finalized.
          const v4Rendered = await privacyHandle.takeRenderedAnswerV4();
          let doneEvent =
            v4Rendered !== undefined
              ? {
                  ...event,
                  answer: v4Rendered.text,
                  ...(v4Rendered.maskedValues.length > 0
                    ? { maskedValues: v4Rendered.maskedValues }
                    : {}),
                }
              : event;
          try {
            const receipt = await privacyHandle.finalize(input.userMessage);
            if (receipt) {
              doneEvent = { ...doneEvent, privacyReceipt: receipt };
            }
          } catch (err) {
            console.warn(
              '[orchestrator] privacyGuard.finalizeTurn threw — receipt dropped:',
              err,
            );
          }
          yield* this.toAnnotationEvents(
            await this.fireTurnHook(
              'onAfterTurn',
              turnId,
              input,
              {
                assistantAnswer: doneEvent.answer,
                // #133 (E8) — persisted Turn node id for graph-linking observers.
                ...(doneEvent.turnId ? { turnExternalId: doneEvent.turnId } : {}),
              },
              2000,
            ),
          );
          yield doneEvent;
          continue;
        }
        if (event.type === 'done') {
          yield* this.toAnnotationEvents(
            await this.fireTurnHook(
              'onAfterTurn',
              turnId,
              input,
              {
                assistantAnswer: event.answer,
                ...(event.turnId ? { turnExternalId: event.turnId } : {}),
              },
              2000,
            ),
          );
        }
        yield event;
      }
    } finally {
      steeringBus.endTurn(sessionId);
      this.clearTurnAuthContext();
    }
  }

  private async *chatStreamInner(
    input: ChatTurnInput,
    turnId: string,
    observer: AskObserver | undefined,
  ): AsyncGenerator<ChatStreamEvent> {
    const { text: priorContext, recalled } =
      await this.retrievePriorContext(input);
    // Cross-session recall probe — surface plans/processes/insights pulled
    // from prior sessions as a visible `kg_recall` card before the answer
    // streams in. No-op when every recall leg was empty.
    yield* this.toRecallAnnotationEvents(recalled);
    const effectiveExtraSystemHint = composeExtraSystemHint(input);
    // Palaia Phase 8 (OB-77) — see chatInContextInner for rationale.
    const nudgeCounter = createNudgeTurnCounter();
    const nudgeTrace: Array<{
      toolName: string;
      args: unknown;
      result: string;
      status: 'ok' | 'error';
      domain?: string;
    }> = [];

    const messages: Array<{ role: 'user' | 'assistant'; content: ContentBlock[] | string }> = [
      // Same in-memory history injection as chat() — see chatInContext().
      ...(input.priorTurns ?? []).flatMap<{
        role: 'user' | 'assistant';
        content: ContentBlock[] | string;
      }>((t) => {
        const pair: Array<{
          role: 'user' | 'assistant';
          content: ContentBlock[] | string;
        }> = [];
        if (t.userMessage.trim().length > 0) {
          pair.push({ role: 'user', content: t.userMessage });
        }
        if (t.assistantAnswer.trim().length > 0) {
          pair.push({ role: 'assistant', content: t.assistantAnswer });
        }
        return pair;
      }),
      { role: 'user', content: buildUserContent(input) },
    ];

    const entityCollection = this.entityRefBus?.beginCollection(turnId);
    let toolCalls = 0;
    const textParts: string[] = [];
    // One forced file-build retry per turn (see fileAnnouncedButNotBuilt).
    let fileForceRetried = false;

    const traceCollector = input.sessionScope
      ? new RunTraceCollector({
          scope: input.sessionScope,
          ...(input.userId ? { userId: input.userId } : {}),
        })
      : undefined;

    // Phase-1 Kemia hook — see chatInContextInner for rationale.
    const prependRules = await this.resolvePrependRules(messages);

    // Round-loop guard + optional wall-clock budget — see chatInContextInner.
    const loopGuard = this.newLoopGuard();
    const turnStartedAt = Date.now();
    let forceFinalize = false;

    // Mid-turn steering — same key the route enqueues under (see chatStream:
    // `sessionId`). Drained at the top of every iteration below.
    const steerKey = input.sessionScope ?? turnId;
    try {
      for (let iteration = 0; iteration < this.maxIterations; iteration++) {
        yield { type: 'iteration_start', iteration };
        // Mirror BuilderAgent: the per-iteration boundary is also when the
        // observer's iteration counter resets, so its consumers (heartbeat
        // emitter etc.) can clear their per-iteration state.
        try {
          observer?.onIteration?.({ iteration });
        } catch (err) {
          console.warn('[orchestrator] observer.onIteration threw:', err);
        }

        // Final pass: loop guard stopped, wall-clock budget spent, or last
        // allowed iteration → answer tools-disabled (best-effort finalize).
        const finalizeThisIter =
          forceFinalize ||
          iteration === this.maxIterations - 1 ||
          this.turnBudgetExceeded(turnStartedAt);

        // Fold any messages the user injected via `/chat/steer` since the
        // previous iteration into the conversation, so the model sees them on
        // this iteration's call. Merging into the trailing user message (when
        // present — at iteration ≥1 it's the tool_results turn) keeps roles
        // strictly alternating; otherwise we append a fresh user turn.
        for (const steerText of steeringBus.drain(steerKey)) {
          const steerBlock = {
            type: 'text' as const,
            text: `[Live user steering — added mid-turn]: ${steerText}`,
          };
          const last = messages[messages.length - 1];
          if (last && last.role === 'user') {
            last.content =
              typeof last.content === 'string'
                ? `${last.content}\n\n${steerBlock.text}`
                : [...last.content, steerBlock];
          } else {
            messages.push({ role: 'user', content: [steerBlock] });
          }
          yield { type: 'steer_applied', iteration, message: steerText };
        }

        let finalMessage: Message | undefined;
        for await (const ev of streamMessageEvents({
          client: this.client,
          params: {
            model: this.model,
            max_tokens: this.maxTokens,
            system: buildSystemBlocks(
              this.composeStableSystemPrompt(prependRules),
              priorContext,
              withFinalizeHint(effectiveExtraSystemHint, finalizeThisIter),
            ),
            tools: finalizeThisIter ? [] : this.buildToolsList(),
            messages,
          },
          observer,
          iteration,
          streamLabel: 'orchestrator',
          requestOptions: {
            headers: { 'anthropic-beta': MEMORY_BETA_HEADER },
          },
        })) {
          if (ev.type === 'text_delta') {
            yield { type: 'text_delta', text: ev.text };
          } else {
            finalMessage = ev.message;
          }
        }
        if (!finalMessage) {
          throw new Error(
            '[orchestrator] streamMessageEvents ended without a final message',
          );
        }
        messages.push({ role: 'assistant', content: finalMessage.content });
        textParts.push(...collectTextBlocks(finalMessage.content));

        if (finalMessage.stop_reason !== 'tool_use') {
          const answer = textParts.join('\n\n').trim();
          const drainedAttachments = this.drainAttachments();
          // See the non-streaming path: only force a retry on a pure-text end,
          // never when a (possibly truncated) tool_use block is present.
          const responseHasToolUse = finalMessage.content.some(
            (b: ContentBlock) => b.type === 'tool_use',
          );
          if (
            !finalizeThisIter &&
            !fileForceRetried &&
            !responseHasToolUse &&
            this.fileAnnouncedButNotBuilt(answer, drainedAttachments.files.length)
          ) {
            fileForceRetried = true;
            messages.push({ role: 'user', content: FILE_RETRY_NUDGE });
            textParts.length = 0;
            console.error(
              '[orchestrator] file announced but not built — forcing one retry to call create_xlsx/create_docx',
            );
            continue;
          }
          const iterations = iteration + 1;
          const attachments =
            drainedAttachments.diagrams.length > 0
              ? drainedAttachments.diagrams
              : undefined;
          const fileAttachments =
            drainedAttachments.files.length > 0
              ? drainedAttachments.files
              : undefined;
          // Hoisted out of the sessionLogger branch so the verifier wrapper
          // can read the trace from the `done` event even when no session
          // logger is configured (dev calls, tests).
          const runTrace = traceCollector?.finish({
            iterations,
            status: 'success',
          });
          let persistedTurnId: string | undefined;
          if (this.sessionLogger && input.sessionScope) {
            const entityRefs = entityCollection?.drain() ?? [];
            // See chat(): we await the session log so the next turn's
            // verbatim-tail retrieval can see this turn. Streaming callers
            // are already committed to waiting for the final `done` event,
            // so the extra ~sub-second is paid by the client already.
            const answerForGraph = appendToolDigest(
              answer,
              attachments,
              fileAttachments,
            );
            try {
              const logged = await this.sessionLogger.log({
                scope: input.sessionScope,
                userMessage: input.userMessage,
                assistantAnswer: answerForGraph,
                toolCalls,
                iterations,
                entityRefs,
                ...(input.userId ? { userId: input.userId } : {}),
                ...(runTrace ? { runTrace } : {}),
              });
              persistedTurnId = logged.turnExternalId;
            } catch (err) {
              console.error(
                '[orchestrator] session log failed (continuing with answer):',
                err instanceof Error ? err.message : err,
              );
            }
          }
          const followUpOptions = this.drainFollowUps();
          const pendingSlotCard = this.drainPendingSlotCard();
          const pendingRoutineList = this.drainPendingRoutineList();
          const pendingOAuthConsent = this.drainConsentRequired();
          // Slice 4a — Haiku-backed enrichment for the save-as-memory
          // modal. Inline because the `done` event is the natural
          // carrier and the chat UI wants the suggestion immediately;
          // accept the 300-800ms latency cost. Failure → undefined,
          // modal falls back to its 240-char prefill.
          const palaiaExcerpt = await this.maybeExtractExcerpt(
            input.userMessage,
            answer,
          );
          // Slice 4b/4c — auto-promotion. Awaited so the resulting
          // mkId rides the same `done` event and the UI can render an
          // inline banner immediately. No-op (returns undefined fast)
          // when autoPromote is off / capture-scorer disabled /
          // threshold not met / required handles missing.
          const autoPromotedMkId = await this.maybePromoteTurn({
            turnId: persistedTurnId,
            userId: input.userId,
            palaiaExcerpt,
            fallbackAssistantAnswer: answer,
          });
          yield {
            type: 'done',
            answer,
            toolCalls,
            iterations,
            ...(persistedTurnId ? { turnId: persistedTurnId } : {}),
            ...(palaiaExcerpt ? { palaiaExcerpt } : {}),
            ...(autoPromotedMkId ? { autoPromotedMkId } : {}),
            ...(attachments ? { attachments } : {}),
            ...(fileAttachments ? { fileAttachments } : {}),
            ...(runTrace ? { runTrace } : {}),
            ...(followUpOptions ? { followUpOptions } : {}),
            ...(pendingSlotCard ? { pendingSlotCard } : {}),
            ...(pendingRoutineList ? { pendingRoutineList } : {}),
            ...(pendingOAuthConsent ? { pendingOAuthConsent: true } : {}),
          };
          return;
        }

        const toolUses = finalMessage.content.filter(
          (block: ContentBlock) => block.type === 'tool_use',
        );

        // Yield tool_use blocks upfront so the UI can render every pill
        // immediately, even before any tool has resolved.
        for (const use of toolUses) {
          toolCalls++;
          yield { type: 'tool_use', id: use.id, name: use.name, input: use.input };
        }

        // Dispatch all tools in parallel. Each slot owns its own observer
        // queue, invocation handle, and heartbeat clock — so the race-loop
        // multiplexes sub-events across all in-flight tools without a shared
        // bottleneck. tool_result events stream in completion order (whichever
        // finishes first surfaces first); the messages.push at the end uses
        // submission order to keep the API request convention readable.
        const HEARTBEAT_MS = 5_000;
        const TICK_MS = 1_000;
        const slots: ParallelSlot[] = toolUses.map((use: ContentBlock, idx: number) =>
          this.prepareStreamSlot(use, idx, traceCollector),
        );

        while (slots.some((s: ParallelSlot) => !s.settled)) {
          let tickTimer: ReturnType<typeof setTimeout> | null = null;
          const tickPromise = new Promise<{ kind: 'tick' }>((resolve) => {
            tickTimer = setTimeout(() => {
              resolve({ kind: 'tick' });
            }, TICK_MS);
          });
          const racers = slots
            .filter((s: ParallelSlot) => !s.settled)
            .map((s: ParallelSlot) =>
              s.promise.then((out: string) => ({
                kind: 'done' as const,
                idx: s.idx,
                output: out,
              })),
            );
          const winner = await Promise.race<
            | { kind: 'done'; idx: number; output: string }
            | { kind: 'tick' }
          >([...racers, tickPromise]);
          if (tickTimer !== null) clearTimeout(tickTimer);

          // Drain all slots' queues in slot-index order — deterministic,
          // independent of which tool finished or ticked.
          for (const s of slots) {
            while (s.subEvents.length > 0) {
              const next = s.subEvents.shift();
              if (next) yield next;
            }
          }

          if (winner.kind === 'done') {
            const s = slots[winner.idx];
            // Promise.race may re-deliver the same already-resolved winner
            // on subsequent iterations; the settled-flag guards against
            // double-yielding the tool_result.
            if (!s || s.settled) continue;
            s.settled = true;
            s.output = winner.output;
            s.isError = winner.output.startsWith('Error:');
            s.durationMs = Date.now() - s.started;
            this.finishSlotInvocation(s, traceCollector);
            yield {
              type: 'tool_result',
              id: s.use.id,
              output: s.output,
              durationMs: s.durationMs,
              isError: s.isError,
            };
          } else {
            const now = Date.now();
            for (const s of slots) {
              if (!s.settled && now - s.lastHeartbeat >= HEARTBEAT_MS) {
                yield {
                  type: 'tool_progress',
                  id: s.use.id,
                  elapsedMs: now - s.started,
                };
                s.lastHeartbeat = now;
              }
            }
          }
        }

        // Final drain: catch any sub-events that landed between the last
        // race-loop iteration and now.
        for (const s of slots) {
          while (s.subEvents.length > 0) {
            const next = s.subEvents.shift();
            if (next) yield next;
          }
        }

        // Submission-order tool_result blocks for the next API request.
        // Anthropic matches by `tool_use_id`, but submission order keeps the
        // message log readable and matches the order the model emitted.
        const toolResults: ContentBlock[] = slots.map((s: ParallelSlot) => ({
          type: 'tool_result',
          tool_use_id: s.use.id,
          content: s.output ?? '',
          ...(s.isError ? { is_error: true } : {}),
        }));
        const stagedNudgeEvents: Array<
          Extract<ChatStreamEvent, { type: 'nudge' }>
        > = [];
        await this.applyNudgePipeline(
          slots.map((s: ParallelSlot) => s.use),
          toolResults,
          nudgeCounter,
          nudgeTrace,
          input,
          turnId,
          (event) => {
            stagedNudgeEvents.push({ type: 'nudge', ...event });
          },
        );
        for (const ev of stagedNudgeEvents) {
          yield ev;
        }
        // Round-loop guard — mirror of chatInContextInner. On `nudge` the steer
        // is appended to this iteration's tool-result user message AND surfaced
        // to the UI as a `nudge` event; on `stop` finalize latches.
        const loopDecision = loopGuard.record(
          slots.map((s: ParallelSlot) => s.use),
          toolResults,
        );
        const userContent: ContentBlock[] = [...toolResults];
        if (loopDecision.action === 'nudge' && loopDecision.nudge) {
          userContent.push({ type: 'text', text: loopDecision.nudge });
          const anchorId = slots[0]?.use.id;
          if (anchorId) {
            yield {
              type: 'nudge',
              id: anchorId,
              nudgeId: 'loop-guard',
              text: loopDecision.nudge,
            };
          }
          console.error(`[orchestrator] loop guard nudge: ${loopDecision.reason}`);
        } else if (loopDecision.action === 'stop') {
          forceFinalize = true;
          console.error(`[orchestrator] loop guard stop: ${loopDecision.reason}`);
        }
        messages.push({ role: 'user', content: userContent });

        // Short-circuit after ask_user_choice. Mirror of chatInContext: the
        // turn ends here so the channel adapter can render a Smart-Card;
        // diagram attachments from the same batch are dropped.
        // OB-29-4 — same short-circuit applies when a plugin-tool returns
        // an in-band `_pendingUserChoice` payload (cf. extractToolEmittedChoice).
        // Sidecar scan: routine list smart-card may piggyback on any
        // plugin-tool result this batch. Stored on the orchestrator until
        // the done block drains it. Doesn't affect short-circuit decisions.
        this.extractToolEmittedRoutineList(toolResults);
        const pendingUserChoice =
          this.drainPendingChoice() ??
          this.extractToolEmittedChoice(toolResults);
        if (pendingUserChoice) {
          this.drainAttachments();
          // Follow-up suggestions are incompatible with a blocking choice
          // card — the user hasn't clarified the request yet, so offering
          // refinements of a non-existent answer would be confusing.
          this.drainFollowUps();
          this.drainPendingSlotCard();
          const answer = textParts.join('\n\n').trim();
          const iterations = iteration + 1;
          const runTrace = traceCollector?.finish({
            iterations,
            status: 'success',
          });
          let persistedTurnId: string | undefined;
          if (this.sessionLogger && input.sessionScope) {
            const entityRefs = entityCollection?.drain() ?? [];
            const loggedAnswer = answer.length > 0
              ? `${answer}\n\n[Rückfrage] ${pendingUserChoice.question}`
              : `[Rückfrage] ${pendingUserChoice.question}`;
            try {
              const logged = await this.sessionLogger.log({
                scope: input.sessionScope,
                userMessage: input.userMessage,
                assistantAnswer: loggedAnswer,
                toolCalls,
                iterations,
                entityRefs,
                ...(input.userId ? { userId: input.userId } : {}),
                ...(runTrace ? { runTrace } : {}),
              });
              persistedTurnId = logged.turnExternalId;
            } catch (err) {
              console.error(
                '[orchestrator] session log failed (continuing with choice card):',
                err instanceof Error ? err.message : err,
              );
            }
          }
          yield {
            type: 'done',
            answer,
            toolCalls,
            iterations,
            pendingUserChoice,
            ...(persistedTurnId ? { turnId: persistedTurnId } : {}),
            ...(runTrace ? { runTrace } : {}),
          };
          return;
        }
      }

      yield {
        type: 'error',
        message: `Orchestrator exceeded maxToolIterations (${String(this.maxIterations)}) without reaching a final answer.`,
      };
    } catch (err) {
      // This catch did not log before — a turn failing on a transient
      // provider error (e.g. Anthropic `overloaded_error` / HTTP 529) was
      // invisible in the server logs. Log the technical detail here. The
      // user-facing error-message wording is handled separately (Privacy
      // Shield v4).
      console.error(
        '[orchestrator] turn failed:',
        err instanceof Error ? (err.stack ?? err.message) : err,
      );
      yield {
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      };
    } finally {
      entityCollection?.drain();
    }
  }

  /**
   * Build a {@link ParallelSlot} for one tool_use block: starts the dispatch
   * promise, sets up the per-slot sub-event queue and observer, opens an
   * invocation timer if the tool is non-native (i.e. delegated to a
   * sub-agent that emits its own iterations + tool calls).
   */
  private prepareStreamSlot(
    use: ContentBlock,
    idx: number,
    traceCollector: RunTraceCollector | undefined,
  ): ParallelSlot {
    const subEvents: ChatStreamEvent[] = [];
    const isNative = this.nativeTools.has(use.name);
    const invocation =
      !isNative && traceCollector
        ? traceCollector.beginInvocation(use.name)
        : undefined;
    const observer = this.makeSlotObserver(use.id, subEvents, invocation);
    const started = Date.now();
    const promise = this.dispatchTool(use.name, use.input, observer);
    return {
      idx,
      use,
      subEvents,
      invocation,
      promise,
      started,
      lastHeartbeat: started,
      settled: false,
    };
  }

  /**
   * Build the per-slot {@link AskObserver} that buffers sub-agent events
   * into the slot's queue. The race-loop drains the queue on each tick
   * (since generators can't yield from inside callbacks). Each event is
   * also forwarded to the run-trace collector's observer when present.
   */
  private makeSlotObserver(
    parentId: string,
    queue: ChatStreamEvent[],
    invocation: InvocationHandle | undefined,
  ): AskObserver {
    return {
      onIteration(ev: { iteration: number }): void {
        invocation?.observer.onIteration?.(ev);
        queue.push({
          type: 'sub_iteration',
          parentId,
          iteration: ev.iteration,
        });
      },
      onSubToolUse(ev: { id: string; name: string; input: unknown }): void {
        invocation?.observer.onSubToolUse?.(ev);
        queue.push({
          type: 'sub_tool_use',
          parentId,
          id: ev.id,
          name: ev.name,
          input: ev.input,
        });
      },
      onSubToolResult(ev: {
        id: string;
        output: string;
        durationMs: number;
        isError: boolean;
      }): void {
        invocation?.observer.onSubToolResult?.(ev);
        queue.push({
          type: 'sub_tool_result',
          parentId,
          id: ev.id,
          output: ev.output,
          durationMs: ev.durationMs,
          isError: ev.isError,
        });
      },
    };
  }

  /**
   * Close out a slot's invocation timer (or record a flat orchestrator-tool
   * trace entry) once the dispatch promise has resolved.
   */
  private finishSlotInvocation(
    slot: ParallelSlot,
    traceCollector: RunTraceCollector | undefined,
  ): void {
    const durationMs = slot.durationMs ?? 0;
    const isError = slot.isError ?? false;
    if (slot.invocation) {
      slot.invocation.finish({
        durationMs,
        status: isError ? 'error' : 'success',
      });
    } else if (traceCollector) {
      traceCollector.recordOrchestratorToolCall({
        callId: slot.use.id,
        toolName: slot.use.name,
        durationMs,
        isError,
      });
    }
  }

  private async dispatchTool(
    name: string,
    input: unknown,
    observer?: AskObserver,
  ): Promise<string> {
    // Privacy Shield v4 — Data-Plane Boundary. The privacy handle is
    // threaded through `turnContext.privacyHandle`; absent ⇒ no privacy
    // provider installed and the tool result flows through unchanged.
    const ctx = turnContext.current();
    const privacy = ctx?.privacyHandle;
    // Verb tools + the terminal render tool are served by the privacy
    // provider's per-turn data-plane engine, not by a tool handler.
    if (privacy !== undefined && name.startsWith('v4_')) {
      const v4Tool = await privacy.runV4Tool({ toolName: name, input });
      return v4Tool.resultText;
    }
    // Privacy Shield v4 — sub-agent data-plane bridge. A domain tool wraps a
    // LocalSubAgent that runs its own LLM loop behind the SAME v4 boundary:
    // every result it fetches is interned, so its LLM only ever sees
    // `[masked]` and the prose answer it returns has `[masked]` baked in.
    // Re-interning that prose would destroy the real values for good. So for
    // a domain tool we run the dispatch in a nested scope carrying a fresh
    // `subAgentDatasetSink`; the sub-agent pushes every datasetId it interns
    // into it, and below we hand the parent agent the digests of those REAL
    // datasets by reference instead of re-interning the prose.
    const subAgentSink: string[] = [];
    // Slice 2.5 — mutable flag that captures whether any tool call inside
    // a domain-tool dispatch honored the operator's per-plugin `bypass`
    // setting. Read after the sub-agent loop returns so we can decide
    // whether to pass the narration through raw (sub-agent already saw
    // real values, its synthesis carries them) or intern as before.
    const subAgentBypassFlag = { value: false };
    let result: string;
    if (
      privacy !== undefined &&
      ctx !== undefined &&
      this.domainToolsByName.has(name)
    ) {
      // Slice 2.5 — stash the domain tool's owning agent plugin id so
      // the sub-agent's inner tool calls can resolve bypass via the
      // same plugin's `_privacy_mode` setting.
      const domainToolAgentId = this.domainToolsByName.get(name)?.agentId;
      result = await turnContext.run(
        {
          ...ctx,
          subAgentDatasetSink: subAgentSink,
          subAgentBypassFlag,
          ...(domainToolAgentId !== undefined
            ? { subAgentOwnerPluginId: domainToolAgentId }
            : {}),
        },
        () => this.dispatchToolInner(name, input, observer),
      );
    } else {
      result = await this.dispatchToolInner(name, input, observer);
    }
    // Phase C.2 — Raw tool-result capture. Outer scope (routine runner)
    // may install a callback that stashes the raw result keyed by tool
    // name; later template rendering uses it as the source of truth for
    // data sections. Absent callback ⇒ no capture.
    const capture = turnContext.current()?.captureRawToolResult;
    if (capture !== undefined && typeof result === 'string') {
      try {
        capture(name, result);
      } catch (err) {
        console.warn(
          `[orchestrator.dispatchTool:${name}] captureRawToolResult threw — continuing without capture:`,
          err,
        );
      }
    }
    if (privacy !== undefined && typeof result === 'string') {
      // Interning-exemption: the agent's own infrastructure/self tools
      // (memory, stored-process CRUD, self-produced meta output) are never
      // interned — masking them blinds the agent to its own operational
      // state. See `privacyInternPolicy.ts` for the auditable allowlist and
      // rationale. Checked first so it wins over every other branch.
      if (isInternExemptTool(name)) {
        return result;
      }
      // Slice 2.5 — Operator-owned per-plugin bypass. If the originating
      // plugin's `_privacy_mode` is `bypass` (or per-tool whitelist hits
      // this name), pass the raw result through unmasked AND record an
      // entry on the receipt for transparency. Org-policy override
      // (`OMADIA_PRIVACY_FORCE_GUARDED=true`) clamps every plugin back
      // to `guarded` inside the resolver.
      const bypass = privacy.checkBypass(name);
      if (bypass !== undefined) {
        // Mark the enclosing sub-agent scope (if any) so the parent
        // dispatch knows the sub-agent saw real values.
        const flag = turnContext.current()?.subAgentBypassFlag;
        if (flag) flag.value = true;
        try {
          await privacy.recordBypassedTool({
            toolName: name,
            pluginId: bypass.pluginId,
            reason: 'operator_setting',
            bytes: Buffer.byteLength(result, 'utf8'),
          });
        } catch (err) {
          console.warn(
            `[orchestrator.dispatchTool:${name}] privacy.recordBypassedTool threw — bypass still applied:`,
            err,
          );
        }
        return result;
      }
      // Sub-agent bridge: the sub-agent interned ≥1 dataset this dispatch —
      // pass those REAL datasets up by reference so the parent agent's
      // `v4_render_answer` resolves ground truth, not the `[masked]` prose.
      if (subAgentSink.length > 0) {
        try {
          const bridged = await privacy.subAgentResultV4({
            narration: result,
            datasetIds: subAgentSink,
          });
          return bridged.resultText;
        } catch (err) {
          console.warn(
            `[orchestrator.dispatchTool:${name}] privacy.subAgentResultV4 threw — interning prose instead:`,
            err,
          );
        }
      }
      // Slice 2.5 — sub-agent ran in bypass mode for at least one of its
      // tool calls. Its narration already carries real values (the sub-
      // agent's LLM read them directly), so re-interning the prose would
      // mask the synthesis the user actually asked for. Pass raw.
      if (subAgentBypassFlag.value && subAgentSink.length === 0) {
        return result;
      }
      // Intern the raw result server-side and hand the LLM only the
      // identity-free digest — the raw rows never reach the LLM wire.
      try {
        const v4 = await privacy.internToolResultV4({
          toolName: name,
          rawResult: result,
        });
        return v4.digestText;
      } catch (err) {
        console.warn(
          `[orchestrator.dispatchTool:${name}] privacy.internToolResultV4 threw — sending raw result:`,
          err,
        );
      }
    }
    return result;
  }

  /**
   * Slice 2.5 — build the per-turn `PrivacyTurnHandle` with the bypass
   * resolver baked in. Shared by both `runTurn` and `chatStream` so the
   * resolver wiring lives in one place.
   *
   * The resolver consults the native-tool registration for `(agentId,
   * readConfig)` — both set by `ToolsAccessor.register` from the
   * activating plugin's context. Marker-only kernel registrations carry
   * neither, so they always go through `guarded`. The readConfig closure
   * routes through the plugin's own ConfigAccessor chain, so an
   * operator setting saved via the install UI is visible to the very
   * next dispatch (no restart).
   */
  private buildPrivacyHandle(
    service: PrivacyGuardService,
    sessionId: string,
    turnId: string,
  ): ReturnType<typeof createPrivacyTurnHandle> {
    const nativeTools = this.nativeTools;
    const domainTools = this.domainToolsByName;
    const pluginConfigGet = this.pluginConfigGet;

    // Slice 2.5 — three-tier bypass lookup:
    //   1. kernel tools (via `ctx.tools.register`) carry their own
    //      `(agentId, readConfig)` closure on the NativeToolRegistry entry
    //   2. domain tools (delegation wrappers for sub-agents) carry an
    //      `agentId` set by `dynamicAgentRuntime` — resolved via
    //      `pluginConfigGet(agentId, key)` against the kernel registry
    //   3. sub-agent INNER tool calls (LocalSubAgentTools fetched from a
    //      `*.toolkit` service) — the orchestrator stashes the owning
    //      agent plugin id in turnContext before running the sub-agent;
    //      the resolver reads it back via turnContext and looks up the
    //      same `_privacy_mode` setting as path #2
    //
    // The org-policy override (`OMADIA_PRIVACY_FORCE_GUARDED=true`) is
    // honoured inside `resolveEffectivePrivacyMode` for all three paths.
    const lookupByAgentId = (
      agentId: string,
      toolName: string,
    ): { pluginId: string } | undefined => {
      if (pluginConfigGet === undefined) return undefined;
      const storedMode = pluginConfigGet(agentId, PRIVACY_MODE_CONFIG_KEY);
      const storedScopes = pluginConfigGet(
        agentId,
        PRIVACY_BYPASS_SCOPES_CONFIG_KEY,
      );
      const effective = resolveEffectivePrivacyMode({
        storedMode,
        storedScopes,
        toolName,
        env: process.env,
      });
      return effective === 'bypass' ? { pluginId: agentId } : undefined;
    };

    const resolveBypass = (
      toolName: string,
    ): { pluginId: string } | undefined => {
      // Path 1 — kernel tool with attached config closure.
      const reg = nativeTools.get(toolName);
      if (reg?.agentId !== undefined && reg.readConfig !== undefined) {
        const storedMode = reg.readConfig(PRIVACY_MODE_CONFIG_KEY);
        const storedScopes = reg.readConfig(PRIVACY_BYPASS_SCOPES_CONFIG_KEY);
        const effective = resolveEffectivePrivacyMode({
          storedMode,
          storedScopes,
          toolName,
          env: process.env,
        });
        if (effective === 'bypass') return { pluginId: reg.agentId };
        // Kernel tool with explicit guarded — don't fall through to other
        // paths (kernel registration is authoritative for kernel tools).
        return undefined;
      }
      // Path 2 — domain tool with attached agent plugin id.
      const domainTool = domainTools.get(toolName);
      if (domainTool?.agentId !== undefined) {
        const hit = lookupByAgentId(domainTool.agentId, toolName);
        if (hit) return hit;
      }
      // Path 3 — sub-agent inner tool. The orchestrator's domain-tool
      // dispatch installs `subAgentOwnerPluginId` in the nested turn
      // scope before running the sub-agent loop; every inner tool call
      // reads back here.
      const subAgentOwner = turnContext.current()?.subAgentOwnerPluginId;
      if (subAgentOwner !== undefined) {
        const hit = lookupByAgentId(subAgentOwner, toolName);
        if (hit) return hit;
      }
      return undefined;
    };
    return createPrivacyTurnHandle({
      service,
      sessionId,
      turnId,
      resolveBypass,
    });
  }

  private async dispatchToolInner(
    name: string,
    input: unknown,
    observer?: AskObserver,
  ): Promise<string> {
    // Per-orchestrator memory isolation: when this Agent has a scoped
    // memory-tool handler, it MUST shadow the globally-registered `memory`
    // handler (which wraps the unscoped FilesystemMemoryStore). Checked
    // before the generic `reg?.handler` dispatch below, since `memory` is a
    // plugin-registered native tool and would otherwise win here unscoped.
    if (name === MEMORY_TOOL_NAME && this.memoryToolHandler) {
      return this.memoryToolHandler.handle(input);
    }
    // Plugin-contributed handlers win first. Kernel branches below are the
    // legacy path for tools that have not yet been converted to
    // plugin-registration (memory, knowledge_graph, …). As each kernel tool
    // migrates, its hardcoded branch disappears.
    const reg = this.nativeTools.get(name);
    if (reg?.handler) {
      return reg.handler(input);
    }
    if (name === KNOWLEDGE_GRAPH_TOOL_NAME && this.knowledgeGraphTool) {
      return this.knowledgeGraphTool.handle(input);
    }
    if (name === CHAT_PARTICIPANTS_TOOL_NAME && this.chatParticipantsTool) {
      return this.chatParticipantsTool.handle();
    }
    if (name === ASK_USER_CHOICE_TOOL_NAME && this.askUserChoiceTool) {
      return this.askUserChoiceTool.handle(input);
    }
    if (name === SUGGEST_FOLLOW_UPS_TOOL_NAME && this.suggestFollowUpsTool) {
      return this.suggestFollowUpsTool.handle(input);
    }
    if (name === FIND_FREE_SLOTS_TOOL_NAME && this.findFreeSlotsTool) {
      return this.findFreeSlotsTool.handle(input);
    }
    if (name === BOOK_MEETING_TOOL_NAME && this.bookMeetingTool) {
      return this.bookMeetingTool.handle(input);
    }
    const domainTool = this.domainToolsByName.get(name);
    if (domainTool) return domainTool.handle(input, observer);
    return `Error: unknown tool \`${name}\`.`;
  }

  /**
   * Builds the system prompt from the current DomainTool map. Called per
   * turn; stable feature flags come from the readonly fields, the
   * DomainTool list is live.
   */
  private getSystemPrompt(): string {
    // Plugin-contributed prompt docs, collected from the registry. The
    // kernel's hardcoded blocks (graph/diagram/…) remain in buildSystemPrompt
    // for their tools; plugin docs land in a separate bullet list so both
    // paths coexist cleanly during the extraction transition.
    const extraDocs = this.nativeTools
      .listWithHandler()
      .map((e) => e.promptDoc)
      .filter((doc): doc is string => typeof doc === 'string' && doc.length > 0);
    return buildSystemPrompt(
      this.assistantIdentity,
      Array.from(this.domainToolsByName.values()),
      this.knowledgeGraphTool !== undefined,
      // Diagrams is now plugin-contributed — its doc ships via extraDocs.
      false,
      this.chatParticipantsTool !== undefined,
      this.askUserChoiceTool !== undefined,
      this.suggestFollowUpsTool !== undefined,
      this.findFreeSlotsTool !== undefined && this.bookMeetingTool !== undefined,
      this.privacyGuard?.() !== undefined,
      extraDocs,
    );
  }

  /**
   * Phase-1 Kemia hook: ask the `responseGuard@1` provider for a rules
   * block to splice ahead of the body system prompt. Empty string when
   * no provider is installed OR the provider returns no rules — the
   * caller then uses the unmodified system prompt and the cache shape
   * stays identical to pre-plugin behaviour.
   *
   * Called once at turn-start; the same rules apply to every iteration of
   * the tool-loop within the turn so prompt-cache hits are preserved.
   */
  private async resolvePrependRules(
    messages: ReadonlyArray<{
      role: 'user' | 'assistant';
      content: ContentBlock[] | string;
    }>,
  ): Promise<string> {
    if (!this.responseGuard) return '';
    const provider = this.responseGuard();
    if (!provider) return '';
    try {
      const flat = messages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: typeof m.content === 'string' ? m.content : '',
      }));
      const result = await provider.getRules({
        systemPrompt: this.getSystemPrompt(),
        messages: flat,
      });
      const rules = result.prependRules ?? '';
      return rules.trim().length > 0 ? rules : '';
    } catch (err) {
      console.warn(
        '[orchestrator] responseGuard.getRules threw — proceeding without rules:',
        err,
      );
      return '';
    }
  }

  /**
   * Combine the Phase-1 prependRules with the body system prompt. Empty
   * rules → returns the body unchanged so the prompt-cache key is byte-
   * identical to pre-plugin runs.
   */
  private composeStableSystemPrompt(prependRules: string): string {
    const body = this.getSystemPrompt();
    if (prependRules.length === 0) return body;
    return `${prependRules}\n\n---\n\n${body}`;
  }

  /**
   * Hot-Register a DomainTool (e.g. after install of an uploaded agent).
   * The tool name MUST be unique — if it already exists the new entry
   * silently overrides the old one.
   *
   * The system prompt is NOT rebuilt — it contains the tool descriptions
   * only as a hint for the model. New tools are still callable from the
   * next iteration onwards because `buildToolsList()` iterates the map
   * live. The Orchestrator simply does not mention them in the preamble.
   */
  registerDomainTool(tool: DomainTool): void {
    // Hard collision check. Silent last-wins was the previous behavior and
    // it made two uploaded agents with the same shortName (last dot-segment
    // of agentId) clobber each other's top-level tool. Caller — typically
    // DynamicAgentRuntime.activate — is expected to probe first via
    // `hasDomainTool(name)` and surface a clearer error with agent context.
    if (this.nativeTools.has(tool.name)) {
      throw new Error(
        `registerDomainTool: name '${tool.name}' is already reserved by a native tool`,
      );
    }
    if (this.domainToolsByName.has(tool.name)) {
      throw new Error(
        `registerDomainTool: duplicate domain-tool name '${tool.name}'`,
      );
    }
    this.domainToolsByName.set(tool.name, tool);
  }

  /** Probe used by DynamicAgentRuntime for pre-flight collision messages. */
  hasDomainTool(name: string): boolean {
    return this.domainToolsByName.has(name);
  }

  /**
   * Hot-Unregister. Idempotent: calling it with an unknown name does
   * nothing. Returns whether an entry was actually removed.
   */
  unregisterDomainTool(name: string): boolean {
    return this.domainToolsByName.delete(name);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private buildToolsList(): any[] {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools: any[] = [{ type: MEMORY_TOOL_TYPE, name: MEMORY_TOOL_NAME }];
    if (this.knowledgeGraphTool) tools.push(knowledgeGraphToolSpec);
    // Diagrams + enrich_company tool specs come from nativeTools registry (plugin-contributed).
    if (this.chatParticipantsTool) tools.push(chatParticipantsToolSpec);
    if (this.askUserChoiceTool) tools.push(askUserChoiceToolSpec);
    if (this.suggestFollowUpsTool) tools.push(suggestFollowUpsToolSpec);
    if (this.findFreeSlotsTool) tools.push(findFreeSlotsToolSpec);
    if (this.bookMeetingTool) tools.push(bookMeetingToolSpec);
    // Plugin-contributed native tools (registered via ctx.tools.register).
    // Live-ingested: activating a tool-kind plugin makes its spec appear on
    // the next iteration without requiring an orchestrator rebuild.
    for (const entry of this.nativeTools.listWithHandler()) {
      if (entry.spec) tools.push(entry.spec);
    }
    // DomainTools dynamically from the map — so hot-registered uploaded
    // agents become visible from the next iteration without reboot.
    for (const tool of this.domainToolsByName.values()) {
      tools.push(tool.spec);
    }
    // Privacy-Shield v4 — verb + render tools, offered only when the v4
    // data-plane boundary is active for this turn.
    const v4ToolSpecs = turnContext.current()?.privacyHandle?.v4ToolSpecs();
    if (v4ToolSpecs) {
      for (const spec of v4ToolSpecs) tools.push(spec);
    }
    // Prompt-cache the full tool-spec block. Anthropic caches every prior
    // content up to and including the tool that carries `cache_control` —
    // marking the final tool makes the whole list a single cacheable chunk.
    // 5-minute TTL comfortably covers a multi-iteration orchestrator turn,
    // so iter 2..N skip re-reading the tool definitions on the server side.
    const last = tools[tools.length - 1];
    if (last) {
      tools[tools.length - 1] = {
        ...last,
        cache_control: { type: 'ephemeral' },
      };
    }
    return tools;
  }
}


/**
 * Returns `answer` with a short machine-readable line tagged onto the end
 * that summarises orchestrator-tool side effects worth preserving in the
 * session graph. Today only diagram renders — giving the next turn's
 * retriever a signal that "a chart was produced here" so follow-ups like
 * "ohne Gutschriften" don't re-query for base data.
 *
 * Never shown to end users — only persisted. The user-facing `answer`
 * returned to Teams / the web UI is unchanged.
 */
/**
 * Matches a future/present-tense announcement of building a FILE (not an inline
 * table) — the signature of the "announced but didn't build" failure. Noun list
 * is restricted to unambiguous file words so it does not fire on inline tables.
 */
const FILE_ANNOUNCE_RE =
  /\b(baue|erstelle|erzeuge|generiere|exportiere)\b[^.!?\n]{0,100}\b(excel|xlsx|datei|word|docx|arbeitsmappe|workbook)\b/i;

/** Injected as a user turn to force the model to actually call the file tool. */
const FILE_RETRY_NUDGE =
  'Du hast angekündigt, eine Datei (Excel/Word) zu bauen, aber das Tool `create_xlsx`/`create_docx` NICHT aufgerufen — der User hat dadurch nichts erhalten. Beschreibe den Plan NICHT erneut. Rufe JETZT in diesem Schritt das passende Tool auf und baue die Datei wirklich. Wenn du sie nicht bauen kannst, sag dem User in EINEM Satz klar, dass und warum nicht.';

/**
 * Appended to the per-turn system hint on the FINAL, tools-disabled iteration
 * (iteration cap reached, loop guard stopped, or wall-clock budget exceeded).
 * With no tools offered the model must produce text, so this turns what used to
 * be a raw "exceeded maxToolIterations" error into a best-effort answer.
 */
const FINALIZE_DIRECTIVE =
  'Du hast das Tool-Budget für diesen Turn aufgebraucht und kannst KEINE weiteren Tools aufrufen. Fasse zusammen, was du bereits herausgefunden hast, und gib JETZT die bestmögliche Antwort mit den vorhandenen Informationen. Wenn etwas unklar oder unvollständig bleibt, sag dem User in einem Satz klar, was noch offen ist. Beschreibe keine weiteren geplanten Tool-Aufrufe.';

/** Compose the per-iteration system hint, appending the finalize directive on
 *  the final tools-disabled pass. Kept as a free function so both tool loops
 *  build the hint identically. */
function withFinalizeHint(baseHint: string | undefined, finalize: boolean): string | undefined {
  if (!finalize) return baseHint;
  return baseHint && baseHint.trim().length > 0
    ? `${baseHint}\n\n${FINALIZE_DIRECTIVE}`
    : FINALIZE_DIRECTIVE;
}

function appendToolDigest(
  answer: string,
  attachments: DiagramAttachment[] | undefined,
  fileAttachments?: OutgoingFileAttachment[] | undefined,
): string {
  const lines: string[] = [];
  for (const a of attachments ?? []) {
    if (a.kind === 'image') {
      lines.push(
        `  - kind=${a.diagramKind} alt=${JSON.stringify(a.altText)} cached=${String(a.cacheHit)}`,
      );
    }
  }
  for (const f of fileAttachments ?? []) {
    lines.push(
      `  - kind=file producer=${f.producer ?? 'file'} name=${JSON.stringify(f.altText)} bytes=${String(f.sizeBytes ?? 0)}`,
    );
  }
  if (lines.length === 0) return answer;
  const digest = ['', '<!-- orchestrator:rendered_attachments', ...lines, '-->'].join('\n');
  return `${answer}${digest}`;
}

function collectTextBlocks(content: ContentBlock[]): string[] {
  const parts: string[] = [];
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) {
      parts.push(block.text);
    }
  }
  return parts;
}

// `toSemanticAnswer` was lifted to `@omadia/channel-sdk` in S+10-2.
// It's imported at the top of this file and re-exported via the back-compat
// barrel so `import { toSemanticAnswer } from '../orchestrator.js'` callers
// (verifier wrapper today, channel adapters until S+11) keep working.
