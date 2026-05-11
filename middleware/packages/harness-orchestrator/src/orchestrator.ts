import { randomUUID } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import {
  toSemanticAnswer,
  type ChatStreamEvent,
  type ChatTurnInput,
  type ChatTurnResult,
  type DiagramAttachment,
  type PendingRoutineList,
  type SemanticAnswer,
} from '@omadia/channel-sdk';
import type { EmbeddingClient } from '@omadia/embeddings';
import type {
  ContextRetriever,
  FactExtractor,
} from '@omadia/orchestrator-extras';
import type { AskObserver, DomainTool } from './tools/domainQueryTool.js';
import {
  KnowledgeGraphTool,
  KNOWLEDGE_GRAPH_TOOL_NAME,
  knowledgeGraphToolSpec,
} from './knowledgeGraphTool.js';
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
  PrivacyGuardService,
  ProcessMemoryService,
  ResponseGuardService,
  SessionBriefingService,
} from '@omadia/plugin-api';
import {
  createNudgeTurnCounter,
  runNudgePipeline,
  type NudgeTurnCounter,
} from './nudgePipeline.js';
import {
  applyPrivacyOutboundToParams,
  createPrivacyTurnHandle,
  restorePrivacyInResponse,
} from './privacyHandle.js';
import { RunTraceCollector, type InvocationHandle } from './runTraceCollector.js';
import type { NativeToolRegistry } from './nativeToolRegistry.js';
import type { SessionLogger } from './sessionLogger.js';
import { streamMessageEvents } from './streaming.js';
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
  client: Anthropic;
  model: string;
  maxTokens: number;
  maxToolIterations: number;
  /** One delegation tool per Managed Agent domain (accounting, hr, …). */
  domainTools: DomainTool[];
  /** Kernel-shared native-tool registry. Created once at boot and shared
   *  between the orchestrator and the plugin-activation pipeline so plugin-
   *  contributed tools land in the same dispatch map as the kernel's own. */
  nativeToolRegistry: NativeToolRegistry;
  sessionLogger?: SessionLogger;
  /** Optional. When set, EntityRefs observed during a turn are attached to the session log. */
  entityRefBus?: EntityRefBus;
  /** Optional. When set, exposes the `query_knowledge_graph` tool so Claude
   * can look up prior turns and entity context before delegating. */
  knowledgeGraph?: KnowledgeGraph;
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
    //     Follow-ups like "das gleiche als Line-Chart" / "ohne X" refer
    //     *directly* to these turns. Don't re-query the source for the
    //     base numbers, don't speculate about different time ranges —
    //     build on what's already here.
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
- Wenn du Daten brauchst, die du sonst aus \`/memories/\` zögen würdest, MACH jetzt direkt den passenden Tool-Call (z. B. einen domain-spezifischen Sub-Agenten).
- Keine Referenz auf frühere Gespräche. Keine "wie eben erwähnt". Behandle den Turn als isoliert.

Der Grund für diesen Modus: der User vermutet, dass dich ein früherer Memory-Eintrag oder ein FTS-Treffer auf eine falsche Antwort gelockt hat. Jetzt ist die Chance, unabhängig von diesem Altlast-Pfad zu antworten.`,
    );
  }
  if (input.extraSystemHint && input.extraSystemHint.trim().length > 0) {
    parts.push(input.extraSystemHint);
  }
  return parts.length > 0 ? parts.join('\n\n---\n\n') : undefined;
}

function buildSystemPrompt(
  domainTools: DomainTool[],
  hasGraph: boolean,
  hasDiagramTool: boolean,
  hasChatParticipants: boolean,
  hasAskUserChoice: boolean,
  hasSuggestFollowUps: boolean,
  hasCalendar: boolean,
  extraToolDocs: readonly string[] = [],
): string {
  const domainList = domainTools.length
    ? domainTools.map((t) => `- \`${t.name}\`: ${t.spec.description}`).join('\n')
    : '- (keine Fach-Agenten konfiguriert)';

  const askUserChoiceBlock = hasAskUserChoice
    ? '\n- `ask_user_choice`: Stellt dem User eine Rückfrage mit 2–4 vordefinierten Button-Optionen als Smart Card. Nur aufrufen, wenn die User-Eingabe **genuin mehrdeutig** ist UND es eine **endliche, kleine Menge plausibler Interpretationen** gibt (z.B. zwei Module tracken Umsatz, zwei Kunden haben ähnlichen Namen). **NICHT** nutzen für: offene "was meinst du?"-Fragen, Trivial-Bestätigungen, oder wenn der Kontext die Intention bereits eindeutig macht. Max 1× pro Turn — der Turn endet direkt nach dem Call; die Auswahl kommt im nächsten Turn als normale User-Nachricht.\n'
    : '';
  const calendarBlock = hasCalendar
    ? '\n- `find_free_slots` + `book_meeting`: **Calendar integration.** When the user asks for an appointment / meeting / time-with-<person> in any phrasing ("send X three options", "when does Y have time?", "book meeting with Z", "find slot tomorrow") — **call `find_free_slots`**. Do NOT interpret as email, do NOT just look up the contact and write prose. The tool output ships clickable slot buttons; the user picks one, then `book_meeting` follows automatically.\n  **Host logic:**\n  - Slots come from the **host\'s** (meeting organiser\'s) calendar. Default = caller themselves.\n  - When the caller offers their own time ("send Tita 3 options", "offer Max times") → **do NOT set hostEmail** (caller is host).\n  - When the caller searches on behalf of someone else ("find a slot in Marcel\'s calendar") → set `hostEmail` to the target.\n  **Required steps for every appointment intent:**\n  1. Resolve attendee emails (e.g. via a directory sub-agent if available).\n  2. Call `find_free_slots({durationMinutes, attendees, hostEmail?, windowDays?})` — default 5 days, default 30 min if the user doesn\'t specify.\n  3. Summarise the found slots in **one sentence** ("Here are 3 free slots for …"). The buttons render automatically as a card.\n  4. On `consent_required` / `sso_unavailable` errors: briefly explain that one-time consent is needed — the OAuth card is attached automatically.\n  **Do NOT use** for queries about already-booked appointments (not implemented).\n'
    : '';

  const suggestFollowUpsBlock = hasSuggestFollowUps
    ? '\n- `suggest_follow_ups`: Hängt 2–4 1-Klick-Refinement-Buttons unter deine Antwort. **Nicht-blockierend** — Du antwortest ganz normal zu Ende; die Buttons erscheinen zusätzlich. Nutze das bei **Top-N / Ranking / Trend / Aggregat**-Fragen, wo der User plausibel eine Variante will (anderer Zeitraum, andere Basis Brutto/Netto/DB, offene Posten statt Umsatz). Jedes `prompt` muss eine **vollständige, eigenständige Frage** sein — bei Klick wird es als neue User-Nachricht gesendet. **NICHT** nutzen für: Trivial-Antworten, Ja/Nein-Lookups, oder zusammen mit `ask_user_choice`. Max 1× pro Turn.\n'
    : '';
  const chatParticipantsBlock = hasChatParticipants
    ? '\n- `get_chat_participants`: Returns the participants of the current chat. Call this only when you want to address someone in the answer text **via @-mention** — handoff, follow-up question, ownership tag. Max 1× per turn. Do not use in 1:1 chats.\n' +
      '\n  **REQUIRED after the tool call — otherwise the call was wasted:**\n' +
      '  1. Write the name in the answer text as `<at>EXACT_DISPLAY_NAME</at>`.\n' +
      '  2. `EXACT_DISPLAY_NAME` must match the `displayName` field from the tool response byte-for-byte — including any suffix, hyphens, capitalisation.\n' +
      '  3. Without these `<at>…</at>` tags NO mention is rendered and the person is NOT notified — writing the name alone is NOT enough.\n' +
      '  4. Example: if the roster returns `displayName: "Alex Example"` and you want to address them, write `Hey <at>Alex Example</at>, can you take this?` — not `Hey Alex Example` and not `Hey @Alex`.\n'
    : '';

  const graphBlock = hasGraph
    ? `\n- \`query_knowledge_graph\`: Local knowledge graph over past sessions/turns + domain entities (whatever the active integration plugins have ingested). **For questions about the chat history** ("did we already discuss X?", "was there a debate about Y?", "which topics did we cover recently?") **use \`search_turns\` (FTS, keyword) or \`search_turns_semantic\` (embedding, for paraphrases)**. \`find_entity\` matches ONLY entity names/IDs, NOT turn text — use it for "who is customer Z?". For back-references to specific people/things ("like with X recently") try \`find_entity\` or \`session_summary\` first. **Important:** if you answer a content question about earlier chats with \`find_entity\` and get an empty result, also try \`search_turns\` — that searches the actual turn text.\n`
    : '';

  // Diagrams moved out of the kernel in Phase 1.2b-iii. The diagram plugin
  // now contributes its own promptDoc via ctx.tools.register and the text
  // surfaces through `extraToolDocs` below. Kept the parameter name so the
  // caller signature stays stable during the transition.
  void hasDiagramTool;

  return `You are the Omadia orchestrator. You answer the user's questions by delegating to specialised sub-agents and persisting durable learnings to memory.

Language: match the user's language. The default is the language of the most recent user message.

Tools:
- \`memory\` (virtual /memories directory): persist domain learnings, user preferences, business conventions, and recurring patterns. Memory is shared across sessions and global for this agent. At the start of each new task read the directory listing once before answering, so you can draw on relevant learnings. Place new learnings in topical files (e.g. /memories/customers/<name>.md, /memories/observations/<period>.md).
${graphBlock}${chatParticipantsBlock}${askUserChoiceBlock}${suggestFollowUpsBlock}${calendarBlock}${extraToolDocs.length > 0 ? '\n' + extraToolDocs.map((doc) => `- ${doc.trim()}`).join('\n') + '\n' : ''}
Sub-agents (routing rule: pick by question domain; for mixed questions call several and merge results):
${domainList}

Memory namespaces (convention):
- /memories/_rules/… → **curated rules from the repo**. Don't overwrite or delete on your own. Only extend if the user explicitly confirms.
- /memories/customers/… → stable facts about individual customers.
- /memories/observations/… → time-stamped observations for back-comparisons.
- /memories/sessions/<scope>/YYYY-MM-DD.md → **chronological Q&A transcripts**, written by the middleware (not by you). These contain real prior conversations. When the user references an earlier conversation ("like we discussed last time", "the way we did it before"), **first look up the matching entry in /memories/sessions/** before re-querying a sub-agent — that typically saves a full roundtrip. But: don't read all sessions by default, that's token waste. Look up only when there's an actual back-reference.

**Rule for reading /memories/_rules/:**
- For a **new domain question** (first question on a domain in this session, or domain switch) read the relevant rule files under /memories/_rules/ first and follow the conventions strictly.
- For a **follow-up** in the same chat (variant, refinement, clarification, "and the same without X", "and for Q4?", "show as a line chart") **do NOT re-read** the rules — the verbatim tail in the conversation context already has the relevant state. Answer directly (with \`render_diagram\` for chart variants). Re-read rules only when the follow-up introduces a substantively new dimension.
- Heuristic: if the context block contains a \`## Letzte Turns in diesem Chat\` section and the current question relates to one of those turns → skip the memory read.

Rules:
1. Don't invent data. When you need a number, a date, a customer name, or an employee, fetch it through the responsible sub-agent.
2. Only write to memory when the learning is relevant beyond the current session — no session-specific notes.
3. **Persist learnings early, not at the end.** As soon as you've gained a durable insight from a sub-agent answer or user instruction (mapping, convention, stable fact), write it to memory **on the very next tool call** — before further delegations or the final answer. This way the learning survives a connection drop or container restart mid-turn.
4. Cite sources briefly in memory (e.g. "observed 2026-04-17 in record X-2026-0042").
5. Avoid memory spam: before creating a new file, check whether a fitting one exists and extend it via \`str_replace\` / \`insert\`.
6. Personal data (contact names etc.) only when needed for the actual work. Domain-specific privacy rules (e.g. HR red lines) are enforced server-side by the responsible sub-agent — respect them in your summary too.
7. At the end of an answer: do NOT write a status update to memory if nothing new emerged.

**Critical integrity rules (verifier-hardening):**

8. **No self-verification in the answer text.** Never write words like "verified", "checked", "confirmed", "live", "looked up" to mark data as fresh. The verifier badge after turn-end decides that based on the tool trace. If you use those words without an actual sub-agent call, the verifier will hard-contradict.

9. **Numbers from the context block are NOT live.** Numbers under \`## Früher besprochene Entitäten\`, \`## Inhaltlich ähnliche Turns\`, \`## Letzte Turns in diesem Chat\` are from the past. Don't present them as current. When the user asks for current figures, you must make at least one sub-agent call in the same turn — otherwise the verifier will auto-contradict and force a retry.

10. **Valid back-reference:** when the user explicitly refers to an earlier turn ("as just reported", "yesterday's number"), you may quote the context number — but phrase it clearly as a back-reference ("as of <date>, no fresh query this turn"), never as "verified/checked". For aggregates spanning multiple dimensions (team × customer × period) always do a plausibility check against known patterns from \`/memories/\`: if a number deviates >50 % from the expected band, mark it explicitly as an anomaly and ask back rather than confirm.

**File attachments (channel uploads):**

11. **Recognise the attachment hint.** When a user message ends with an \`[attachments-info] …\` block, the user has uploaded files — they're already persisted (storage_key + signed_url in the block). Treat the metadata as additional context, not as text of the request.

12. **Recognise brand-asset intent.** Phrasings like "this is our logo", "use that as a banner", "this is our team icon" → **right now** write/update the memory file \`/memories/_brand/<asset-name>.md\` (e.g. \`logo.md\`, \`banner.md\`) with YAML frontmatter from the attachments-info block (storage_key, signed_url, file_name, content_type, uploaded_at, asset_role). Then briefly confirm. When the user does NOT mark the file as an asset ("look at this", "here's a screenshot"), do NOT write to \`/memories/_brand/\`.

13. **Use brand asset in diagrams.** On \`render_diagram\` calls, if the user requests "with branding", "with our logo", "with corporate design", read \`/memories/_brand/logo.md\`. Don't write the signed_url directly into the spec (Kroki has no public egress) — use the placeholder URL \`brand://logo\` AND pass the \`storage_key\` as the tool parameter \`brand_logo_storage_key\`. The middleware base64-inlines the image automatically before it reaches Kroki — works reliably even with expired signed_urls. Examples:
    - **Vega-Lite**: layer \`{"mark":"image","encoding":{"url":{"value":"brand://logo"},"x":{...},"y":{...},"width":{"value":80},"height":{"value":80}}}\`
    - **Graphviz**: \`node [image="brand://logo", label=""]\`
    - **PlantUML**: \`<img src="brand://logo" width="120">\` in note/header
    - **Mermaid**: limited; render without logo if in doubt.
    Tool call shape: \`render_diagram({kind: "vegalite", source: "<spec with brand://logo>", brand_logo_storage_key: "<from memory>"})\`. Without the parameter the \`brand://logo\` placeholder stays unchanged — Kroki renders an empty image cell.`;
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
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly maxIterations: number;
  private readonly domainToolsByName: Map<string, DomainTool>;
  // systemPrompt wird pro Turn live neu aus `buildSystemPrompt()` gebaut —
  // so tauchen hot-registrierte DomainTools im Preamble auf. Prompt-Caching
  // greift innerhalb stabiler Phasen (zwischen zwei register/unregister-
  // Events) weiterhin; direkt nach einem Install/Uninstall fällt genau ein
  // Cache-Miss an, dann ist der neue Prompt gecached.
  private readonly sessionLogger: SessionLogger | undefined;
  private readonly entityRefBus: EntityRefBus | undefined;
  private readonly knowledgeGraphTool: KnowledgeGraphTool | undefined;
  private readonly contextRetriever: ContextRetriever | undefined;
  private readonly sessionBriefing: SessionBriefingService | undefined;
  private readonly factExtractor: FactExtractor | undefined;
  private readonly askUserChoiceTool: AskUserChoiceTool | undefined;
  private readonly suggestFollowUpsTool: SuggestFollowUpsTool | undefined;
  private readonly chatParticipantsTool: ChatParticipantsTool | undefined;
  private readonly findFreeSlotsTool: FindFreeSlotsTool | undefined;
  private readonly bookMeetingTool: BookMeetingTool | undefined;
  private readonly responseGuard: (() => ResponseGuardService | undefined) | undefined;
  private readonly privacyGuard: (() => PrivacyGuardService | undefined) | undefined;
  private readonly nudgeRegistry: NudgeRegistry | undefined;
  private readonly nudgeStateStore: NudgeStateStore | undefined;
  private readonly nudgeProcessMemory: ProcessMemoryService | undefined;
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
    this.client = options.client;
    this.model = options.model;
    this.maxTokens = options.maxTokens;
    this.maxIterations = options.maxToolIterations;
    this.domainToolsByName = new Map(options.domainTools.map((t) => [t.name, t]));
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
    this.nudgeRegistry = options.nudgeRegistry;
    this.nudgeStateStore = options.nudgeStateStore;
    this.nudgeProcessMemory = options.nudgeProcessMemory;
    this.sessionLogger = options.sessionLogger;
    this.entityRefBus = options.entityRefBus;
    this.contextRetriever = options.contextRetriever;
    this.sessionBriefing = options.sessionBriefing;

    this.nativeTools = options.nativeToolRegistry;
    for (const name of KERNEL_NATIVE_TOOL_NAMES) {
      if (!this.nativeTools.has(name)) {
        this.nativeTools.register(name);
      }
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
  private drainAttachments(): DiagramAttachment[] | undefined {
    const out: DiagramAttachment[] = [];
    // Plugin-contributed sinks. Each native tool returns its pending
    // attachments (if any) and resets its internal buffer; an empty or
    // undefined return is the common case and cheap. The diagram plugin
    // contributes its takeLastRender() output here via this pathway.
    for (const entry of this.nativeTools.listWithHandler()) {
      if (!entry.attachmentSink) continue;
      const payloads = entry.attachmentSink();
      if (!payloads?.length) continue;
      for (const p of payloads) {
        if (p.kind === 'diagram') {
          // Channel adapters recognise the diagram shape; anything else
          // flows through as an opaque attachment for future adapters.
          out.push(p.payload as DiagramAttachment);
        }
      }
    }
    return out.length > 0 ? out : undefined;
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
   *        "question":"Welcher Marcel?",
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
  ): Promise<string | undefined> {
    // Use console.error so the trace lands on stderr — Fly's log aggregator
    // has been observed to drop some stdout INFO lines under load, and this
    // is the one pathway we cannot afford to lose visibility on.
    if (input.freshCheck) {
      console.error('[context] SKIP fresh-check');
      return undefined;
    }
    if (!this.contextRetriever) {
      console.error('[context] SKIP no-retriever');
      return undefined;
    }
    if (!input.sessionScope && !input.userId) {
      console.error('[context] SKIP no-scope-no-user');
      return undefined;
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
        agentId: 'orchestrator-default',
        ...(input.sessionScope ? { sessionScope: input.sessionScope } : {}),
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
            scope: input.sessionScope,
            agentId: 'orchestrator-default',
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
      return merged.length > 0 ? merged : undefined;
    } catch (err) {
      console.error(
        '[context] retrieval FAILED — continuing without:',
        err instanceof Error ? err.message : err,
      );
      return undefined;
    }
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
      ? createPrivacyTurnHandle({
          service: privacyService,
          sessionId,
          turnId,
        })
      : undefined;

    return turnContext.run(
      {
        turnId,
        turnDate: today(),
        ...(parent?.chatParticipants
          ? { chatParticipants: parent.chatParticipants }
          : {}),
        ...(privacyHandle ? { privacyHandle } : {}),
      },
      async () => {
        const result = await this.chatInContext(input, turnId);
        if (privacyHandle) {
          try {
            const receipt = await privacyHandle.finalize();
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

  private async chatInContext(
    input: ChatTurnInput,
    turnId: string,
  ): Promise<ChatTurnResult> {
    this.applyTurnAuthContext(input);
    try {
      return await this.chatInContextInner(input, turnId);
    } finally {
      this.clearTurnAuthContext();
    }
  }

  private async chatInContextInner(
    input: ChatTurnInput,
    turnId: string,
  ): Promise<ChatTurnResult> {
    const priorContext = await this.retrievePriorContext(input);
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

    const traceCollector = input.sessionScope
      ? new RunTraceCollector({
          scope: input.sessionScope,
          ...(input.userId ? { userId: input.userId } : {}),
        })
      : undefined;

    // Phase-1 Kemia hook — resolved ONCE at turn start. Empty when no
    // `responseGuard@1` provider is installed; identical cache shape then.
    const prependRules = await this.resolvePrependRules(messages);

    try {
      for (let iteration = 0; iteration < this.maxIterations; iteration++) {
        // Privacy-Proxy Slice 2.1: tokenise outbound payload + restore
        // inbound text blocks. Pulls the per-turn handle off
        // `turnContext.current()`. No-op when no provider is registered.
        const privacy = turnContext.current()?.privacyHandle;
        const baseParams = {
          model: this.model,
          max_tokens: this.maxTokens,
          system: buildSystemBlocks(
            this.composeStableSystemPrompt(prependRules),
            priorContext,
            effectiveExtraSystemHint,
          ),
          tools: this.buildToolsList(),
          messages,
        };
        const outboundParams = privacy
          ? await applyPrivacyOutboundToParams(baseParams, privacy, 'orchestrator')
          : baseParams;

        const response: Message = await this.client.messages.create(
          outboundParams,
          { headers: { 'anthropic-beta': MEMORY_BETA_HEADER } },
        );

        if (privacy) {
          await restorePrivacyInResponse(response, privacy);
        }

        messages.push({ role: 'assistant', content: response.content });
        textParts.push(...collectTextBlocks(response.content));

        if (response.stop_reason !== 'tool_use') {
          const answer = textParts.join('\n\n').trim();
          const iterations = iteration + 1;
          const runTrace = traceCollector?.finish({
            iterations,
            status: 'success',
          });
          const attachments = this.drainAttachments();
          if (this.sessionLogger && input.sessionScope) {
            // Await the log write: previous fire-and-forget let follow-ups
            // race ahead of the session persisting their prior turn, so the
            // verbatim tail came back empty and the bot "forgot" the last
            // chart / answer. The write is fast (~sub-second against Neon);
            // the latency cost is worth the retrieval guarantee.
            const entityRefs = entityCollection?.drain() ?? [];
            const answerForGraph = appendToolDigest(answer, attachments);
            let persistedTurnId: string | undefined;
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
            ...(runTrace ? { runTrace } : {}),
            ...(attachments ? { attachments } : {}),
            ...(followUpOptions ? { followUpOptions } : {}),
            ...(pendingSlotCard ? { pendingSlotCard } : {}),
            ...(pendingRoutineList ? { pendingRoutineList } : {}),
            ...(pendingOAuthConsent ? { pendingOAuthConsent: true } : {}),
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
        await this.applyNudgePipeline(
          toolUses,
          toolResults,
          nudgeCounter,
          nudgeTrace,
          input,
          turnId,
        );
        messages.push({ role: 'user', content: toolResults });

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
          if (this.sessionLogger && input.sessionScope) {
            const entityRefs = entityCollection?.drain() ?? [];
            const loggedAnswer = answer.length > 0
              ? `${answer}\n\n[Rückfrage] ${pendingUserChoice.question}`
              : `[Rückfrage] ${pendingUserChoice.question}`;
            try {
              await this.sessionLogger.log({
                scope: input.sessionScope,
                userMessage: input.userMessage,
                assistantAnswer: loggedAnswer,
                toolCalls,
                iterations,
                entityRefs,
                ...(input.userId ? { userId: input.userId } : {}),
                ...(runTrace ? { runTrace } : {}),
              });
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
            ...(runTrace ? { runTrace } : {}),
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
      ? createPrivacyTurnHandle({
          service: privacyService,
          sessionId,
          turnId,
        })
      : undefined;

    turnContext.enter({
      turnId,
      turnDate: today(),
      ...(parent?.chatParticipants
        ? { chatParticipants: parent.chatParticipants }
        : {}),
      ...(privacyHandle ? { privacyHandle } : {}),
    });

    this.applyTurnAuthContext(input);
    try {
      for await (const event of this.chatStreamInner(input, turnId, observer)) {
        if (event.type === 'done' && privacyHandle) {
          try {
            const receipt = await privacyHandle.finalize();
            if (receipt) {
              yield { ...event, privacyReceipt: receipt };
              continue;
            }
          } catch (err) {
            console.warn(
              '[orchestrator] privacyGuard.finalizeTurn threw — receipt dropped:',
              err,
            );
          }
        }
        yield event;
      }
    } finally {
      this.clearTurnAuthContext();
    }
  }

  private async *chatStreamInner(
    input: ChatTurnInput,
    turnId: string,
    observer: AskObserver | undefined,
  ): AsyncGenerator<ChatStreamEvent> {
    const priorContext = await this.retrievePriorContext(input);
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

    const traceCollector = input.sessionScope
      ? new RunTraceCollector({
          scope: input.sessionScope,
          ...(input.userId ? { userId: input.userId } : {}),
        })
      : undefined;

    // Phase-1 Kemia hook — see chatInContextInner for rationale.
    const prependRules = await this.resolvePrependRules(messages);

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

        let finalMessage: Message | undefined;
        for await (const ev of streamMessageEvents({
          client: this.client,
          params: {
            model: this.model,
            max_tokens: this.maxTokens,
            system: buildSystemBlocks(
              this.composeStableSystemPrompt(prependRules),
              priorContext,
              effectiveExtraSystemHint,
            ),
            tools: this.buildToolsList(),
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
          const iterations = iteration + 1;
          const attachments = this.drainAttachments();
          // Hoisted out of the sessionLogger branch so the verifier wrapper
          // can read the trace from the `done` event even when no session
          // logger is configured (dev calls, tests).
          const runTrace = traceCollector?.finish({
            iterations,
            status: 'success',
          });
          if (this.sessionLogger && input.sessionScope) {
            const entityRefs = entityCollection?.drain() ?? [];
            // See chat(): we await the session log so the next turn's
            // verbatim-tail retrieval can see this turn. Streaming callers
            // are already committed to waiting for the final `done` event,
            // so the extra ~sub-second is paid by the client already.
            const answerForGraph = appendToolDigest(answer, attachments);
            try {
              await this.sessionLogger.log({
                scope: input.sessionScope,
                userMessage: input.userMessage,
                assistantAnswer: answerForGraph,
                toolCalls,
                iterations,
                entityRefs,
                ...(input.userId ? { userId: input.userId } : {}),
                ...(runTrace ? { runTrace } : {}),
              });
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
          yield {
            type: 'done',
            answer,
            toolCalls,
            iterations,
            ...(attachments ? { attachments } : {}),
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
        messages.push({ role: 'user', content: toolResults });

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
          if (this.sessionLogger && input.sessionScope) {
            const entityRefs = entityCollection?.drain() ?? [];
            const loggedAnswer = answer.length > 0
              ? `${answer}\n\n[Rückfrage] ${pendingUserChoice.question}`
              : `[Rückfrage] ${pendingUserChoice.question}`;
            try {
              await this.sessionLogger.log({
                scope: input.sessionScope,
                userMessage: input.userMessage,
                assistantAnswer: loggedAnswer,
                toolCalls,
                iterations,
                entityRefs,
                ...(input.userId ? { userId: input.userId } : {}),
                ...(runTrace ? { runTrace } : {}),
              });
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
    // Slice 2.2 — privacy-proxy tool roundtrip.
    //
    // Restore tokens in the input BEFORE the handler runs so domain tools
    // (domain integrations, Calendar, KG) see real user data instead of `tok_<hex>`
    // placeholders that the downstream system would not be able to
    // resolve. Re-scan the result text AFTER the handler returns so any
    // fresh PII the tool surfaced (e.g. "Jane Example" from a directory-sub-agent)
    // is tokenised before it flows back to the LLM as a `tool_result`
    // block — the public LLM never sees the plaintext.
    //
    // The privacy handle is threaded through `turnContext.privacyHandle`
    // (Slice 2.1). Absent ⇒ no privacy provider installed; we degrade
    // to pre-Slice-2.2 byte-identical behaviour.
    const privacy = turnContext.current()?.privacyHandle;
    let dispatchInput = input;
    if (privacy !== undefined) {
      try {
        const restored = await privacy.processToolInput({
          toolName: name,
          input,
        });
        dispatchInput = restored.input;
      } catch (err) {
        console.warn(
          `[orchestrator.dispatchTool:${name}] privacy.processToolInput threw — proceeding with original input:`,
          err,
        );
      }
    }
    const result = await this.dispatchToolInner(name, dispatchInput, observer);
    if (privacy !== undefined && typeof result === 'string' && result.length > 0) {
      try {
        const tokenised = await privacy.processToolResult({
          toolName: name,
          text: result,
        });
        return tokenised.text;
      } catch (err) {
        console.warn(
          `[orchestrator.dispatchTool:${name}] privacy.processToolResult threw — sending original result:`,
          err,
        );
      }
    }
    return result;
  }

  private async dispatchToolInner(
    name: string,
    input: unknown,
    observer?: AskObserver,
  ): Promise<string> {
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
   * Baut den System-Prompt aus der aktuellen DomainTool-Map. Wird pro Turn
   * aufgerufen; stabile Feature-Flags kommen aus den readonly-Feldern, die
   * DomainTool-Liste ist live.
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
      Array.from(this.domainToolsByName.values()),
      this.knowledgeGraphTool !== undefined,
      // Diagrams is now plugin-contributed — its doc ships via extraDocs.
      false,
      this.chatParticipantsTool !== undefined,
      this.askUserChoiceTool !== undefined,
      this.suggestFollowUpsTool !== undefined,
      this.findFreeSlotsTool !== undefined && this.bookMeetingTool !== undefined,
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
   * Hot-Register eines DomainTools (z.B. nach Install eines Uploaded-Agents).
   * Der Tool-Name MUSS eindeutig sein — existiert er schon, überschreibt der
   * neue Eintrag still den alten.
   *
   * Der System-Prompt wird dabei NICHT neu gebaut — er enthält die
   * Tool-Beschreibungen nur als Hilfe fürs Modell. Neue Tools sind trotzdem
   * ab der nächsten Iteration callable, weil `buildToolsList()` die Map live
   * iteriert. Der Orchestrator erwähnt sie nur nicht mehr im Preamble.
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
   * Hot-Unregister. Idempotent: ruft man es für einen unbekannten Namen auf,
   * passiert nichts. Gibt zurück, ob tatsächlich ein Eintrag entfernt wurde.
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
    // DomainTools dynamisch aus der Map — so werden hot-registrierte
    // Uploaded-Agents ab der nächsten Iteration sichtbar, ohne neu zu booten.
    for (const tool of this.domainToolsByName.values()) {
      tools.push(tool.spec);
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
function appendToolDigest(
  answer: string,
  attachments: DiagramAttachment[] | undefined,
): string {
  if (!attachments || attachments.length === 0) return answer;
  const lines = attachments
    .filter((a) => a.kind === 'image')
    .map(
      (a) =>
        `  - kind=${a.diagramKind} alt=${JSON.stringify(a.altText)} cached=${String(a.cacheHit)}`,
    );
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
