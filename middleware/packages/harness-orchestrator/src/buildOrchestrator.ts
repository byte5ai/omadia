/**
 * Per-Agent Orchestrator construction (US3).
 *
 * `buildOrchestratorForAgent` is the parameterized factory that builds one
 * `Orchestrator` — plus its optional verifier wrapper and its `chatAgent`
 * bundle — for a named Agent. The orchestrator plugin's `activate()` calls it
 * once for the default Agent; the multi-orchestrator registry (US4) calls it
 * once per configured Agent.
 *
 * The process-shared services are resolved once by the caller and passed in
 * via `OrchestratorDeps`; only the per-Agent knobs in `AgentRuntimeConfig`
 * differ between calls. The factory is pure construction — no service
 * registration, no process-global side effects — so it is safe to call more
 * than once in one process.
 */

import type { DataPlanGuard } from '@omadia/plugin-api';
import { turnContext } from './turnContext.js';
import { createDataPlanGuard, createLlmDataPlanJudge } from './dataPlanGuard.js';
import { createLlmSummaryJudge, createSummaryBoundaryGuard } from './summaryBoundaryGuard.js';
import type { ConsultationPort } from './consultation/consultTool.js';
import type { DiscretionPort } from './discretion/port.js';
import { LabelledMemoryStore } from './discretion/labelledMemoryStore.js';
import { labelSubjectWithTurn } from './discretion/toolFlow.js';

import type {
  ChatAgent,
  ChatTurnInput,
  DisclosureMarkerStore,
  DisclosureSeenStore,
  GrantStore,
} from '@omadia/channel-sdk';
import type { EmbeddingClientSource } from '@omadia/embeddings';
import type { EffortLevel, LlmProvider, LlmProviderPool } from '@omadia/llm-provider';
import type { ModelRef, ProfileQualityConfig } from '@omadia/plugin-api';
import type {
  ContextRetriever,
  FactExtractor,
} from '@omadia/orchestrator-extras';
import type {
  EntityRefBus,
  KnowledgeGraph,
  MemorableKind,
  MemoryStore,
  NudgeRegistry,
  NudgeStateStore,
  PalaiaExcerptExtractor,
  PrivacyGuardService,
  ProcessMemoryService,
  ResponseGuardService,
  SessionBriefingService,
  TurnReceiptStore,
} from '@omadia/plugin-api';
import type { VerifierBundle } from '@omadia/verifier';
import type { Pool } from 'pg';

import { MemoryToolHandler } from '@omadia/memory';

import { withAgentTurnExecution } from './agentTurnExecution.js';
import { ChatSessionStore, chatSessionTailTurns } from './chatSessionStore.js';
import {
  wrapChatAgentWithConversationContext,
  type ConversationContextLookup,
} from './conversationContextAgent.js';
import { wrapChatAgentWithFastPath, type FastPathTriagePort } from './fastPathAgent.js';
import type { Microsoft365Accessor } from './microsoft365-shim.js';
import type { NativeToolRegistry } from './nativeToolRegistry.js';
import type { ModelRoutingConfig } from './modelRouter.js';
import {
  Orchestrator,
  type OrchestratorPersonaSkill,
  type AiDisclosureSetup,
} from './orchestrator.js';
import type { AnswerVerbosity } from './answerVerbosity.js';
import type { AnswerLanguage } from './answerLanguage.js';
import {
  LlmScreener,
  HttpProxyScreener,
  type SecurityScreener,
  type SecurityPostureSetup,
  type SecurityAuditEvent,
} from './securityScreener.js';
import type {
  McpInputReplayer,
  PendingMcpInputStore,
} from './mcp/pendingMcpInput.js';
import { CliChatAgent } from './cliChatAgent.js';
import { ToolDispatchService } from './toolDispatchService.js';
import {
  OrchestratorMemoryNamespacer,
  TURN_NOTE_PROVENANCE,
} from './orchestratorMemoryNamespacer.js';
import { DurableRulesMemoryStore } from './durableRulesMemoryStore.js';
import { MemoryBinder, type ContextMemoryMode } from './memoryBinder.js';
import {
  ScopedMemoryStore,
  orchestratorMemoryScope,
} from './registry/scopedMemoryStore.js';
import type { TurnHookRunner } from './turnHooks.js';
import type { ChatAgentBundle } from './plugin.js';
import { SessionLogger, isChatSessionScope } from './sessionLogger.js';
import { isPrivacyForceGuarded } from './privacyPolicy.js';
import type { RunTraceOutcomeStats } from './runTraceObservability.js';
import { AskUserChoiceTool } from './tools/askUserChoiceTool.js';
import { BookMeetingTool } from './tools/bookMeetingTool.js';
import type { ChatPeerAgentsProvider } from './chatParticipants.js';
import { ChatParticipantsTool } from './tools/chatParticipantsTool.js';
import { FindFreeSlotsTool } from './tools/findFreeSlotsTool.js';
import { SuggestFollowUpsTool } from './tools/suggestFollowUpsTool.js';
import type { AttachmentReader } from './tools/readAttachmentTool.js';
import { VerifierService } from './verifierService.js';
import {
  wrapFacilitatorAgent,
  type EngineDrivenConversationLookup,
  type OwnPostCountLookup,
  type PrivateTurnLookup,
  type AddressedTurnLookup,
} from './facilitatorAgent.js';
import {
  FACILITATOR_ARCHETYPE,
  STANDARD_ARCHETYPE,
  archetypeOmits,
  type ArchetypeId,
  type ArchetypeOmission,
} from './registry/archetype.js';
import { findWorkingModeIdentityReplacement } from './workingModeIdentity.js';
import type { AgentSpeaker } from '@omadia/plugin-api';
import type { GuardDirectoryEntry } from './identityGuard/deterministic.js';
import { IdentityGuard } from './identityGuard/guard.js';
import { AnswerDetailsMemory, withAnswerDetailsNote, withAnswerDetailsRecall } from './answerDetailsRecall.js';
import { maskRestoredValues, withIdentityGuard } from './identityGuard/guardedChatAgent.js';
import { createLlmIdentityJudge } from './identityGuard/llmJudge.js';
import { assembleAgentIdentity, identityPreamble } from './agentIdentityLayers.js';
import { AgentAnswerEmitter } from './management/answerEmitter.js';
import { withSpeaker } from './management/speakingChatAgent.js';

/** A guard check slower than this is logged even when it passes (trace). */
const IDENTITY_GUARD_SLOW_MS = 1_500;

/**
 * The per-Agent knobs — everything that differs between two Agents built in
 * the same process.
 */
export interface AgentRuntimeConfig {
  /** Stable id of the Agent (orchestrator instance) being built. */
  readonly agentId: string;
  /**
   * #2045 — who this agent's answers are from (its `agents.id`, slug, the name
   * it wears, its avatar), stamped on every answer. Set by the registry from
   * the agent row; absent (legacy single-agent boot, fixtures) = derived from
   * `agentId` and `identityName`.
   */
  readonly speaker?: AgentSpeaker;
  /**
   * #2046 — the directory of every agent's names and aliases the identity
   * guard checks this agent's prose against, read per turn. Absent = only the
   * agent itself (human claims are still checked).
   */
  readonly agentDirectory?: () => readonly GuardDirectoryEntry[];
  /**
   * Names of known humans, read per turn: the display, first and last names
   * of the install's active users (kernel `humanNames@1`). An own name of
   * this agent that equals one is masked like any person's name
   * (`agentOwnNames`). `null` = not known yet (directory not loaded, load
   * failed): fail safe, the turn exempts no own name at all. Absent = no
   * known humans (hosts without a users table).
   */
  readonly humanNames?: () => readonly string[] | null;
  /**
   * #2056 — the colleagues this agent may consult, by name (directed
   * consultation grants, #2047), named in its prompt. Absent = none.
   */
  readonly consultableColleagues?: readonly string[];
  readonly model: string;
  /** Optional per-turn Sonnet/Opus routing (see {@link OrchestratorOptions}). */
  readonly modelRouting?: ModelRoutingConfig;
  /** #1033 — reasoning effort the agent's model policy pins; absent = vendor default. */
  readonly effort?: EffortLevel;
  /** #1033 W3 — see the matching {@link OrchestratorOptions} fields. */
  readonly primaryRef?: ModelRef;
  readonly fallbackRef?: ModelRef;
  readonly identityByFamily?: Readonly<Record<string, string>>;
  readonly fallbackVisionSupported?: boolean;
  readonly maxTokens: number;
  readonly maxToolIterations: number;
  /** Optional round-loop guard thresholds (see {@link OrchestratorOptions}). */
  readonly loopRepeatSoft?: number;
  readonly loopRepeatHard?: number;
  /** Optional per-turn wall-clock budget in seconds (0 / omitted = off). */
  readonly maxTurnSeconds?: number;
  /**
   * OM-104 — wall-clock budget of one CLI-owned turn, in seconds. Only the
   * subscription (`claude-cli`) runtime reads it; the in-process runtime is
   * bounded by {@link maxTurnSeconds} instead. Omitted / 0 means "not set by
   * the operator", which leaves the `OMADIA_CLI_SPAWN_TIMEOUT_MS` environment
   * override and then the 600 s default in charge. Setting beats environment
   * beats default, so an operator who raises it on the LLM-access page is not
   * silently overruled by a stale deployment variable.
   */
  readonly cliTurnSeconds?: number;
  /** #2051 — this Agent's working-mode candidates, resolved by the caller
   *  from `agent_persona_skills` (see {@link OrchestratorOptions}). A mode is
   *  composed beneath the identity for one turn; it never replaces it.
   *  Per-agent, unlike the platform-shared `OrchestratorDeps` fields below. */
  readonly personaSkills?: readonly OrchestratorPersonaSkill[];
  /**
   * #914 — this Agent's authored behaviour text (`agent_identities.
   * instructions`, migration 0052), which REPLACES the platform-wide
   * `OrchestratorDeps.assistantIdentity` for this Agent.
   *
   * Same slot, not an additional block: `assistantIdentity` is the opening
   * section of the system prompt, and an agent whose operator wrote its
   * behaviour down means that text, not that text appended to a generic
   * one. Absent/blank → the platform identity, exactly as before.
   *
   * A per-turn working mode (#2051) never touches this slot: it is composed
   * beneath whichever identity applies, for one turn.
   */
  readonly identityInstructions?: string;
  /**
   * #1878 — whether {@link identityInstructions} contains authored behaviour
   * text. `false`: it holds only the compiled character/limits sections and
   * is appended to the platform identity instead of replacing it. Absent =
   * `true` (the text replaces the platform identity, as before #1878).
   */
  readonly identityReplacesBase?: boolean;
  /**
   * #1569 — the Agent's own response-quality settings
   * (`agent_identities.quality`), for the `responseGuard` provider. Absent =
   * the agent set none; the provider then uses its `agent_overrides` and
   * default.
   */
  readonly quality?: ProfileQualityConfig;
  /**
   * #967 — the name this Agent answers to (`agent_identities.display_name`),
   * already trimmed and non-empty when present.
   *
   * A LAYER, NOT A SLOT. Unlike {@link identityInstructions}, this does not
   * replace the assistant identity — it is appended to whichever identity text
   * ends up applying. The name is one fact about the Agent; the identity is
   * everything else it should do, and an operator who only typed a name into
   * the Teams provisioning form has not asked to discard the platform's
   * behaviour text along with its name.
   *
   * Absent → the identity text is used verbatim, exactly as before.
   */
  readonly identityName?: string;
  /**
   * #967 follow-up — this Agent's authored SELF-DESCRIPTION
   * (`agent_identities.short_description` / `.long_description`, the operator's
   * "Steckbrief" tab), already trimmed and non-empty when present.
   *
   * LAYERS, LIKE THE NAME, NOT SLOTS. They say what the Agent IS; they never
   * replace what it was told to DO. See `withAgentIdentity` for the full
   * precedence and for why the accent colour and avatar are excluded.
   *
   * Absent → nothing is added and the prompt is byte-identical, which is what
   * keeps every Agent that predates the Steckbrief exactly where it was.
   */
  readonly identityShortDescription?: string;
  readonly identityLongDescription?: string;
  /**
   * This Agent's own answer-size contract (`agent_identities.verbosity`).
   * A SLOT over the platform-wide `OrchestratorDeps.answerVerbosity`: when
   * set it replaces the installation default for this Agent, so exactly ONE
   * verbosity block ever reaches the prompt. Absent → the platform value
   * (and with that unset, `standard`, no block).
   */
  readonly answerVerbosity?: AnswerVerbosity;
  /**
   * W5 memory-ACL — per-Agent rollout switch for chat-context-scoped memory.
   * Read from the `agents.context_memory` column (migration 0050).
   *
   *  - `'off'` (DEFAULT, and what every existing row reports) — byte-identical
   *    to today: every turn gets the agent-private memory stack, whether or not
   *    its channel plugin sends a `TurnOrigin`.
   *  - `'enforce'` — context turns write into their own tier and READ the
   *    agent tier read-only, so existing knowledge stays quotable.
   *  - `'enforce-strict'` — full quarantine: a context turn cannot even read
   *    the agent tier.
   *
   * Off-by-default plus an optional `origin` is what makes this a no-flag-day
   * change: every combination of old/new middleware and old/new channel plugin
   * behaves exactly as it does today until an operator flips this.
   */
  readonly contextMemory?: ContextMemoryMode;
  /**
   * The plugin ids this Agent is actually granted (`agent_plugins`, enabled
   * only) — the authorisation set, enforced at DISPATCH time.
   *
   * WHY AT DISPATCH AND NOT ONLY AT REGISTRATION. The per-Agent tool surface
   * is assembled by withholding un-granted tools when an orchestrator is
   * hydrated (`scopeDomainToolsToPlugins`, removed with the agent plugin
   * runtime in S3c). That was one place, reached by
   * several paths — boot hydrate, post-boot install reconcile, rebuild,
   * sub-agent hydration — and any path that forgets to scope turns a
   * registration bug into a PERMISSION bug: the tool is simply there, and the
   * model will use it. An agent granted nothing answered with the HR
   * integration that way.
   *
   * So the grant is re-checked where the tool is actually invoked. A tool that
   * should never have been registered on this instance still cannot run.
   * Registration decides what the model is OFFERED; this decides what it may
   * ACTUALLY DO, and only the second one is a security boundary.
   *
   * ABSENT MEANS UNGATED, deliberately: the legacy single-Agent boot path has
   * no per-Agent grant set and is the whole deployment's orchestrator. Adding
   * an empty array there would disable every tool it has. Only the registry,
   * which knows each Agent's rows, passes this.
   */
  readonly grantedPluginIds?: readonly string[];
  /**
   * #2088 — the agent's archetype (`agents.archetype`). This factory wires
   * NOTHING the archetype's descriptor omits (`archetypeOmits`). For a
   * `facilitator` that is everything that would make a moderator partial: no
   * memory tool or binder, no recall, capture or learning, no knowledge
   * graph, no calendar tools, no persona skills, no fast path. Its identity
   * ends with the neutrality contract, its tools are exactly those of its
   * granted plugins, and outside a group or an engine-run turn its
   * `ChatAgent` answers with a fixed refusal. Absent = `standard`.
   */
  readonly archetype?: ArchetypeId;
  /** #1876 — `false`: the operator switched this agent's fast lane off. */
  readonly fastLane?: boolean;
  /** #2043 — the agent's own language (BCP 47), when its identity names one. */
  readonly identityLanguage?: string;
}

/**
 * Process-shared dependencies — resolved once by the caller and reused across
 * every Agent built in the process. The required services are guaranteed
 * present by the caller (the plugin's `activate()` guards them before
 * building).
 */
export interface OrchestratorDeps {
  readonly provider: LlmProvider;
  /** #1033 W3 — resolves any provider a model policy names (primary on
   *  another provider, fallback). Absent ⇒ every agent runs on `provider`
   *  and no policy hop is possible, the pre-W3 behaviour. */
  readonly providerPool?: Pick<LlmProviderPool, 'get' | 'health'>;
  readonly knowledgeGraph: KnowledgeGraph;
  readonly memoryStore: MemoryStore;
  readonly entityRefBus: EntityRefBus;
  readonly nativeToolRegistry: NativeToolRegistry;
  readonly nudgeRegistry: NudgeRegistry;
  /**
   * #1082 — process-shared run-trace / capture tallies, handed to every
   * `SessionLogger` this factory builds. Deps, not per-Agent config, because
   * the registry REPLACES an Orchestrator instance on any config diff: a
   * per-instance tally would split the counts per Agent and reset whenever a
   * config diff rebuilt one. Absent ⇒ each logger keeps its own.
   */
  readonly runTraceStats?: RunTraceOutcomeStats;
  /**
   * W2-1 (#544) — process-shared MCP pending-input store + replayer.
   *
   * Deps, not per-Agent config, for the SAME reason as `runTraceStats`: the
   * registry replaces an Orchestrator instance on
   * any config diff, and a per-instance store would drop every parked call
   * whenever an operator changed something unrelated — after the user had
   * already seen the card. Must be the same store instance the kernel's
   * `McpManager` writes to.
   */
  readonly pendingMcpInput?: PendingMcpInputStore;
  readonly mcpInputReplay?: McpInputReplayer;
  /** Late-bound `responseGuard@1` lookup (see `OrchestratorOptions`). */
  readonly responseGuard: () => ResponseGuardService | undefined;
  /** Late-bound `privacy.redact@1` lookup (see `OrchestratorOptions`). */
  readonly privacyGuard: () => PrivacyGuardService | undefined;
  /** #757 — late-bound persistent per-turn receipt store lookup (see
   *  `OrchestratorOptions.turnReceiptStore`). Optional: absent ⇒ receipts
   *  stay ephemeral. */
  readonly turnReceiptStore?: () => TurnReceiptStore | undefined;
  /**
   * Slice 2.5 — cross-plugin runtime-config lookup for the privacy bypass
   * resolver (see `OrchestratorOptions.pluginConfigGet`). Wired from the
   * harness runtime that owns the installed-plugin registry. Optional —
   * when absent, only kernel-tool bypass works.
   */
  readonly pluginConfigGet?: (
    agentId: string,
    configKey: string,
  ) => unknown | undefined;
  /**
   * Issue #474 — per-plugin tool-readiness gate (see
   * `OrchestratorOptions.isPluginToolsReady`). Wired from the harness
   * runtime's `PluginStatusRegistry`. Optional — when absent every
   * plugin's tools are always available (pre-#474 behaviour).
   */
  readonly isPluginToolsReady?: (agentId: string) => boolean;
  /**
   * The deterministic fast path (`fastPath@1`, `@omadia/fast-path`), resolved
   * LAZILY per turn. When present, every bundle agent is wrapped in
   * {@link wrapChatAgentWithFastPath} — outside the verifier — so every
   * non-canvas channel gets the one-call triage. Absent → no wrapper.
   */
  readonly fastPath?: () => FastPathTriagePort | undefined;
  /**
   * #2043 — does the facilitation engine drive this conversation for this
   * agent (it holds the agent's message subscription there)? Then a
   * facilitator's own chat turn is suppressed; see `facilitatorAgent.ts`.
   */
  readonly isEngineDrivenConversation?: EngineDrivenConversationLookup;
  /**
   * #2316 (ADR-0279) — the conversation's data block by session scope (a
   * channel chat's recent routine deliveries). Fills
   * `ChatTurnInput.conversationContextHint` outside the fast path when the
   * caller set none. Absent = no lookup. Not for facilitators.
   */
  readonly conversationContext?: ConversationContextLookup;
  /** #2043 — is the facilitation engine usable for this agent right now?
   *  Absent = no (then a facilitator says that facilitation is not set up). */
  readonly isFacilitationEngineUsable?: (agentSlug: string) => boolean;
  /** #2043 — see `FacilitatorAgentDeps.ownPostCount`. */
  readonly facilitatorOwnPostCount?: OwnPostCountLookup;
  /** #2089 — see `FacilitatorAgentDeps.privateTurn`. */
  readonly facilitatorPrivateTurn?: PrivateTurnLookup;
  /** #2089 — see `FacilitatorAgentDeps.addressedTurn`. */
  readonly facilitatorAddressedTurn?: AddressedTurnLookup;
  /**
   * #1018 — resolves the peer AGENTS the calling agent may see in the current
   * chat, merged into `get_chat_participants` as `kind: 'agent'` entries.
   * Kernel-published (`chatPeerAgents@1`); absent ⇒ the roster stays
   * humans-only, the pre-#1018 behaviour.
   */
  readonly chatPeerAgents?: ChatPeerAgentsProvider;
  /**
   * #1016 — per-turn owner guard for the subscription-CLI runtime, published
   * by the kernel as `routineTurnOwnerGuard`.
   *
   * Only the CLI agent runtime uses it: that is the one path where a tool call
   * arrives from another process and has its async context restored, so a
   * stale `enterWith` chain could dispatch under the previous principal.
   * Absent (legacy hosts, unit tests) ⇒ the context is restored without a
   * cross-check, which is the pre-#1016 behaviour.
   */
  readonly turnOwnerGuard?: (
    input: ChatTurnInput,
  ) => (() => void) | undefined;
  /**
   * #1085 — resolves the `claude` binary the CLI runtime spawns, called once
   * per turn. Wired from the kernel's `cliBinaryResolver` service, which
   * carries `resolveCliBin` (runtime install dir first, PATH second) — the
   * same rule the version badge, the login flow and the "Install now" button
   * already use. Absent (legacy hosts, unit tests) ⇒ the bare name from PATH,
   * the pre-#1085 behaviour.
   */
  readonly resolveCliBinary?: () => string;
  readonly contextRetriever?: ContextRetriever;
  readonly sessionBriefing?: SessionBriefingService;
  readonly factExtractor?: FactExtractor;
  readonly excerptExtractor?: PalaiaExcerptExtractor;
  /** #1815 / ADR-0194 — a fixed client or a per-call resolver. */
  readonly embeddingClient?: EmbeddingClientSource;
  readonly microsoft365?: Microsoft365Accessor;
  readonly verifierBundle?: VerifierBundle;
  readonly nudgeStateStore?: NudgeStateStore;
  readonly processMemory?: ProcessMemoryService;
  /** Merged from main 2026-05-26: KG-ACL auto-promotion env flags. */
  readonly autoPromote?: boolean;
  readonly autoPromoteThreshold?: number;
  /** Trigger T3 — durable auto-promotion. Threaded here so dynamic / registry
   *  agents self-curate the durable tier too (not just the static chatAgent@1).
   *  Undefined → durable auto-promotion off for this agent. */
  readonly autoPromoteDurableMinSignificance?: number;
  readonly autoPromoteDurableKinds?: MemorableKind[];
  /** Shared Postgres pool the Orchestrator may use for direct KG writes. */
  readonly graphPool?: Pool;
  readonly graphTenantId?: string;
  /** Operator-set assistant identity (overrides the built-in default). */
  readonly assistantIdentity?: string;
  /**
   * Operator's target answer size (`answer_verbosity` setup field), shared by
   * every Agent this process builds. Absent → `standard`, no prompt block. See
   * `OrchestratorOptions.answerVerbosity`.
   */
  readonly answerVerbosity?: AnswerVerbosity;
  /**
   * #1992 / ADR-0220 — fallback answer language (`answer_language`), shared by
   * every Agent this process builds. Absent → German. See
   * `OrchestratorOptions.answerLanguage`.
   */
  readonly answerLanguage?: AnswerLanguage;
  /**
   * AI-Act Art. 50 (#644) — resolved operator disclosure config. Absent → the
   * shipping default (standard, active) on every channel. See
   * `OrchestratorOptions.aiDisclosure`.
   */
  readonly aiDisclosure?: AiDisclosureSetup;
  /**
   * #644 — process-shared first-turn-per-scope fold-dedup store. Deps, not
   * per-Agent config, for the SAME reason as `runTraceStats`: the
   * registry replaces an Orchestrator instance on any config diff, and a
   * per-instance store would re-fold the marking into every live conversation
   * whenever an operator changed something unrelated.
   */
  readonly aiDisclosureSeenStore?: DisclosureSeenStore;
  /**
   * #2087 — process-shared `per_conversation` marker state, for the same
   * reason: a speaker change is only visible to a store that sees every agent
   * of the conversation.
   */
  readonly aiDisclosureMarkerStore?: DisclosureMarkerStore;
  /**
   * #579 — resolved org security posture (org floor + optional scope tighten +
   * shadow/enforce mode + optional external screen URL). Absent → the shipping
   * default (`auto`, enforce). The SCREENER and AUDIT SINK are built here (they
   * need the provider + session logger), keyed off this setup — see
   * `OrchestratorOptions.securityScreener` / `securityAuditSink`.
   */
  readonly securityPosture?: SecurityPostureSetup;
  /**
   * #575 — durable capability grants for the audience floor.
   *
   * Present ONLY when the operator enabled the floor: the kernel publishes the
   * `audienceGrants` service behind `AUDIENCE_FLOOR_ENABLED`. Absent ⇒ the
   * orchestrator installs no audience provider and the three guards
   * short-circuit, which is the "not enforced ≠ closed" rule they are built on.
   * Passing a store is therefore the switch, and the reason it is a switch
   * rather than a default is that the floor fails closed — an empty grant table
   * bounds every room to nothing.
   */
  readonly audienceGrants?: GrantStore;
  /** Spec 2042 §5.4 — the kernel's consultation broker (`consult` tool). */
  readonly consultation?: ConsultationPort;
  /** Spec 2042 §5.11 — the kernel's discretion stores. */
  readonly discretion?: DiscretionPort;
  /** #133 E0 — side-channel turn-hook runner, fired during each turn. */
  readonly turnHookRegistry?: TurnHookRunner;
  /**
   * #268 — byte source for user-uploaded attachments. When present, the
   * orchestrator auto-ingests document text and exposes `read_attachment`.
   * Built kernel-side over the shared S3/Tigris bucket. Optional — absent →
   * both attachment-reading mechanisms stay inert.
   */
  readonly attachmentReader?: AttachmentReader;
}

/** What one `buildOrchestratorForAgent` call produces. */
export interface BuiltOrchestrator {
  readonly orchestrator: Orchestrator;
  /** The `chatAgent` bundle — verifier-wrapped agent + raw orchestrator. */
  readonly bundle: ChatAgentBundle;
  /**
   * The resolved orchestrator model after the per-Agent overlay was applied —
   * i.e. the actual id the turn loop will send to the provider for this Agent.
   * Mirrors `config.model`; carried out so callers (registry log, /admin UI)
   * can read it without re-computing the overlay. Issue #296 acceptance #4.
   */
  readonly effectiveModel: string;
  /** Same as `config.modelRouting` — surfaced so callers can describe the
   *  per-turn routing the Agent is on without inspecting the orchestrator. */
  readonly effectiveModelRouting?: ModelRoutingConfig;
  /**
   * #1890 — the head of this agent's stable system prompt as the turn loop
   * sends it: the identity section ({@link assembleAgentIdentity}), the
   * language line and the answer-size block ({@link identityPreamble}). What
   * the operator's Prompt tab shows, read from the built agent so the preview
   * cannot drift from the runtime. Excludes the per-turn parts (working mode,
   * Quality Guard rules before it, tool docs and context after it).
   */
  readonly identityPrompt: string;
  /**
   * #2085 — this agent's boundary check of a data plan (spec 2042 §5.13 1a):
   * the fast lane, `deliver_data` and trigger data actions run a plan only
   * when it passes.
   */
  readonly dataPlanGuard: DataPlanGuard;
}

/*
 * Comparison key of a name: the privacy guard's `normalizeOwnName`
 * (harness-plugin-privacy-guard/src/ownNames.ts), repeated here because the
 * orchestrator cannot import the guard. Both sides must agree: an agent
 * "„Karen“" whose key kept the quotes would survive the human veto below and
 * then exempt a plain "Karen" in the guard.
 */
const NAME_QUOTES = `"'„“”‚‘’«»`;
const NAME_LEADING_NOISE = new RegExp(`^[\\s${NAME_QUOTES}]+`, 'u');
const NAME_TRAILING_NOISE = new RegExp(`[\\s.,;:!?${NAME_QUOTES}]+$`, 'u');

function nameKey(name: string): string {
  return name.replace(NAME_LEADING_NOISE, '').replace(NAME_TRAILING_NOISE, '').toLocaleLowerCase();
}

/**
 * The names an agent answers as — only operator-set agent identity: the
 * display name and slug of the speaker the identity guard checks, and the
 * name it signs with (its identity name, else the platform assistant name,
 * the precedence of the AI-disclosure line). Deduplicated, blanks dropped.
 * A name that equals a known human's (`humanNames`, case-insensitive) is
 * dropped: a namesake employee "Max" stays masked. `humanNames: null` (not
 * known yet) drops every name — masking wins. The privacy shield never masks
 * the rest in the agent's own turn.
 */
export function agentOwnNames(input: {
  readonly speaker: Pick<AgentSpeaker, 'displayName' | 'slug'>;
  readonly identityName?: string | undefined;
  readonly assistantName?: string | undefined;
  readonly humanNames?: readonly string[] | null | undefined;
}): readonly string[] {
  // Fail safe: the known humans are not known yet — exempt no own name.
  if (input.humanNames === null) return [];
  const signingName = input.identityName?.trim() || input.assistantName?.trim();
  const humans = new Set((input.humanNames ?? []).map(nameKey));
  const names = [input.speaker.displayName, input.speaker.slug, signingName]
    .map((n) => n?.trim() ?? '')
    .filter((n) => n.length > 0 && !humans.has(nameKey(n)));
  return [...new Set(names)];
}

/**
 * Spec 2042 (#2191, #2192) — the names of the roster's agents for
 * `agentNames@1`: every given name (slugs, display names, identity names of
 * the agents that exist), trimmed and deduplicated, minus every name a
 * known human bears (`humanNames`, case-insensitive), the rule of
 * {@link agentOwnNames}. `humanNames: null` (not known yet) yields `null`:
 * no agent name is exempt, masking wins.
 */
export function rosterAgentNames(input: {
  readonly names: readonly (string | null | undefined)[];
  readonly humanNames: readonly string[] | null;
}): readonly string[] | null {
  if (input.humanNames === null) return null;
  const humans = new Set(input.humanNames.map(nameKey));
  const names = input.names
    .map((n) => n?.trim() ?? '')
    .filter((n) => n.length > 0 && !humans.has(nameKey(n)));
  return [...new Set(names)];
}

/**
 * Build one Agent's `Orchestrator`, its optional verifier wrapper, and its
 * `chatAgent` bundle. Each call produces a fully independent instance set —
 * no mutable state is shared between two calls.
 */
export function buildOrchestratorForAgent(
  config: AgentRuntimeConfig,
  deps: OrchestratorDeps,
): BuiltOrchestrator {
  // Per-orchestrator memory isolation. The shared kernel `MemoryStore` is
  // wrapped so this Agent can only touch its own tree (`orchestrator:<slug>:*`)
  // plus the shared `core` namespace — enforced by `ScopedMemoryStore`.
  //   - ChatSessionStore + SessionLogger are KERNEL writers of the shared
  //     `sessions`/`chat-sessions` trees (session transcripts stay common,
  //     decision A3a). Those trees are read-only for agents, so the two get
  //     the unscoped store; only the model-facing stack below is scoped.
  //   - The model-facing `memory` tool additionally goes through the
  //     namespacer, which rewrites its arbitrary `/memories/<x>` notes into
  //     the Agent-private `/memories/orchestrators/<slug>/<x>` tree.
  // Spec 2042 §5.11 — a transcript keeps the labels of every turn written
  // into it, so a `memory` read of it (same physical path) carries them.
  const transcriptStore: MemoryStore = deps.discretion
    ? new LabelledMemoryStore(deps.memoryStore, deps.discretion, config.agentId, { labelReads: false })
    : deps.memoryStore;
  const scopedStore = new ScopedMemoryStore({
    agentSlug: config.agentId,
    scope: orchestratorMemoryScope(config.agentId),
    inner: transcriptStore,
  });
  const chatSessionStore = new ChatSessionStore(transcriptStore);
  const sessionLogger = new SessionLogger(
    transcriptStore,
    deps.knowledgeGraph,
    chatSessionStore,
    config.agentId,
    deps.runTraceStats,
  );
  // Fast path for every non-canvas channel — outermost, outside the verifier
  // (fastPathAgent.ts says why a hit may bypass it). A hit is recorded
  // through THIS bundle's session logger like any other turn.
  // #2060 — a facilitator takes no fast path (it would answer for someone)
  // and is wrapped by the refusal gate instead; see `facilitatorAgent.ts`.
  // #2088 — one question per thing left out, answered by the descriptor.
  const omits = (omission: ArchetypeOmission): boolean => archetypeOmits(config, omission);
  // The facilitator's own runtime (refusal gate, engine-driven turns,
  // neutrality contract) is what the archetype ADDS, not an omission.
  const isFacilitator = config.archetype === FACILITATOR_ARCHETYPE;
  const workingModes = omits('persona_skill')
    ? []
    : workingModesKeepingIdentity(config.personaSkills ?? [], config.archetype, config.agentId);
  // #1876 — the fast lane is the agent's own, switchable per agent.
  const fastPathDeps =
    isFacilitator || omits('fast_path') || config.fastLane === false ? undefined : deps.fastPath;
  // #2085 — the agent's boundaries over its data plans: presets checked
  // deterministically, free-text rules by its classifier model.
  const dataPlanGuard = createDataPlanGuard({
    boundaries: config.quality?.boundaries,
    ...(deps.provider
      ? {
          judge: createLlmDataPlanJudge({
            provider: deps.provider,
            model: config.modelRouting?.classifierModel ?? config.model,
          }),
        }
      : {}),
  });
  // Criterion 33 — the same boundaries over the planner's summary.
  const summaryGuard = createSummaryBoundaryGuard({
    boundaries: config.quality?.boundaries,
    ...(deps.provider
      ? {
          judge: createLlmSummaryJudge({
            provider: deps.provider,
            model: config.modelRouting?.classifierModel ?? config.model,
          }),
        }
      : {}),
  });
  const withFastPath = (agent: ChatAgent): ChatAgent =>
    isFacilitator
      ? wrapFacilitatorAgent(agent, {
          agentSlug: config.agentId,
          name: config.identityName,
          locale: config.identityLanguage ?? deps.aiDisclosure?.locale,
          ...(deps.isEngineDrivenConversation
            ? { isEngineDriven: deps.isEngineDrivenConversation }
            : {}),
          ...(deps.isFacilitationEngineUsable
            ? { isEngineUsable: deps.isFacilitationEngineUsable }
            : {}),
          ...(deps.facilitatorOwnPostCount ? { ownPostCount: deps.facilitatorOwnPostCount } : {}),
          ...(deps.facilitatorPrivateTurn ? { privateTurn: deps.facilitatorPrivateTurn } : {}),
          ...(deps.facilitatorAddressedTurn ? { addressedTurn: deps.facilitatorAddressedTurn } : {}),
          // The fixed answers are marked by this Agent's own disclosure rule.
          disclose: (answer, input) => orchestrator.discloseCliAnswer(answer, input),
          log: (m) => console.log(m),
        })
      : fastPathDeps === undefined
      ? agent
      : wrapChatAgentWithFastPath(agent, {
          fastPath: fastPathDeps,
          // the tools THIS Agent's orchestrator offers — the fast path runs
          // nothing else (a per-Agent tool set is respected)
          permittedTools: () => orchestrator.offeredToolNames(),
          // …and their definitions: read tools of every plugin get a generic
          // planner spec (@omadia/fast-path genericToolSpecs.ts). #1876 —
          // only the agent's OWN read tools: a sub-agent's inner tools
          // (`via`) reach the agent only through their domain tool.
          toolDefinitions: () => orchestrator.offeredToolDefinitions().filter((d) => d.via === undefined),
          // #1876 — the fast lane answers under this agent's identity, with
          // its AI disclosure (spec 2042 INV-2).
          disclose: (answer, input) => orchestrator.discloseCliAnswer(answer, input),
          // #1876 — learned plans and the answer cache are this agent's.
          agentSlug: config.agentId,
          // #2085 — every plan, new or cached, passes this agent's boundaries.
          checkPlan: dataPlanGuard,
          // Criterion 33 — and every summary, new or cached, before release.
          checkSummary: summaryGuard,
          logSession: (entry) => sessionLogger.log(entry),
          privacyGuarded: () => deps.privacyGuard() !== undefined,
          log: (m) => console.log(m),
        });
  // Trigger T1 — durable-rules live hook. Wrap the (shared-passthrough)
  // namespacer so writes to `/memories/_rules/` auto-promote into curated
  // durable MemorableKnowledge. Needs the graph pool; gated off when absent or
  // via KG_DURABLE_RULES_HOOK=false. Decorator sits OUTSIDE the namespacer so
  // it sees the model-facing `_rules/` path (namespacer passes `_` through).
  // #1534 — under a Privacy Shield the `memory` tool may not read the session
  // transcripts: they hold every turn's real values. The org policy counts
  // too, so a turn that slips past the fail-closed gate (#1535) still cannot.
  const shieldActive = (): boolean =>
    deps.privacyGuard() !== undefined || isPrivacyForceGuarded(process.env);
  // #1540 — notes written in an unprotected turn are marked, and refused to
  // a turn the shield masks.
  const namespacedStore: MemoryStore = new OrchestratorMemoryNamespacer(
    config.agentId,
    scopedStore,
    shieldActive,
    TURN_NOTE_PROVENANCE,
  );
  const durableRulesHookEnabled =
    process.env['KG_DURABLE_RULES_HOOK'] !== 'false' && !!deps.graphPool;
  const memoryToolStore: MemoryStore = durableRulesHookEnabled
    ? new DurableRulesMemoryStore(namespacedStore, {
        pool: deps.graphPool!,
        kg: deps.knowledgeGraph,
        tenantId: deps.graphTenantId ?? 'default',
        ...(deps.embeddingClient
          ? { embeddingClient: deps.embeddingClient }
          : {}),
        log: (msg): void => {
          console.error(msg);
        },
      })
    : namespacedStore;
  const memoryToolHandler = new MemoryToolHandler(memoryToolStore);

  // #2045 / #2046 — the outermost layers of every agent, whatever produced
  // its answer: the mandatory identity guard on its prose, then the speaker
  // stamp from routing (spec 2042 INV-3, INV-4).
  const agentSpeaker: AgentSpeaker = config.speaker ?? {
    kind: 'agent',
    agentId: config.agentId,
    slug: config.agentId,
    displayName: config.identityName ?? config.agentId,
  };
  const emitter = new AgentAnswerEmitter({
    speaker: agentSpeaker,
    guard: (restoredValues) =>
      new IdentityGuard({
        speaker: agentSpeaker,
        directory: config.agentDirectory?.() ?? [],
        judge: createLlmIdentityJudge({
          provider: deps.provider,
          // An internal helper on the agent's own policy: its classifier
          // model when it routes per turn, else its model.
          model: config.modelRouting?.classifierModel ?? config.model,
        }),
        mask: (text) => Promise.resolve(maskRestoredValues(text, restoredValues)),
      }),
    locale: () => config.identityLanguage ?? deps.aiDisclosure?.locale,
    onGuardResult: (result) => {
      if (result.outcome !== 'pass' || result.latencyMs > IDENTITY_GUARD_SLOW_MS) {
        console.log(
          `[identity-guard] agent=${agentSpeaker.slug} outcome=${result.outcome} latencyMs=${String(result.latencyMs)}` +
            (result.outcome === 'unavailable' ? ` cause=${result.cause}${result.detail ? ` detail=${result.detail}` : ''}` : ''),
        );
      }
    },
  });
  // #2316 (ADR-0279) — outside the fast path, so its triage keeps the turn
  // and a turn it hands on carries the block.
  const withConversationContext = (agent: ChatAgent): ChatAgent =>
    isFacilitator || deps.conversationContext === undefined
      ? agent
      : wrapChatAgentWithConversationContext(agent, config.agentId, deps.conversationContext);
  // Spec 2042 §5.10 — the outermost layer: everything this agent's chat
  // agent runs (fast lane, loop, verifier, identity guard) is this agent's
  // turn for the model gateway.
  // Criterion 29 — one record per conversation of this agent's last answer.
  const answerDetails = new AnswerDetailsMemory();
  const finalize = (agent: ChatAgent): ChatAgent =>
    withAgentTurnExecution(
      withSpeaker(
        // Criterion 29 — outside the guard: only what the user received is
        // recalled when they ask "how do you know?".
        withAnswerDetailsRecall(
          withIdentityGuard(
            withConversationContext(withFastPath(withAnswerDetailsNote(agent, answerDetails))),
            emitter,
          ),
          answerDetails,
        ),
        agentSpeaker,
        emitter,
      ),
      config.agentId,
    );

  // W5 memory-ACL — the per-CHAT-CONTEXT binder. `memoryToolHandler` above is
  // resolved once, here, for the whole process lifetime; the binder resolves a
  // stack per turn from the turn's `TurnOrigin` instead, so what an Agent
  // learns in team A is not quotable in team B.
  //
  // It is built unconditionally and gated by MODE, not by presence: with
  // `contextMemory: 'off'` — the default, and what every existing agent row
  // reports until an operator changes it — `forOrigin` ignores the origin and
  // returns the context-free stack, which is the same ScopedMemoryStore +
  // OrchestratorMemoryNamespacer + DurableRulesMemoryStore composition the
  // lines above build. One code path, so the rollout switch cannot drift away
  // from the thing it is switching.
  //
  // The binder takes `deps.memoryStore` UNDECORATED on purpose: it owns the
  // whole decorator chain, because the scope it enforces is what decides which
  // wrappers apply. `chatSessionStore` / `sessionLogger` keep the unscoped
  // `transcriptStore` — session transcripts stay shared under `sessions`
  // (decision A3a) and must not be partitioned by chat context.
  const memoryBinder = new MemoryBinder({
    agentSlug: config.agentId,
    // Spec 2042 §5.11 — notes keep the labels of the turn that wrote them,
    // keyed by physical path (below the binder's scoping).
    root: deps.discretion
      ? new LabelledMemoryStore(deps.memoryStore, deps.discretion, config.agentId)
      : deps.memoryStore,
    // The members index is read across rooms: never through the label layer.
    indexStore: deps.memoryStore,
    mode: config.contextMemory ?? 'off',
    shieldActive,
    noteProvenance: TURN_NOTE_PROVENANCE,
    ...(durableRulesHookEnabled
      ? {
          durableRules: {
            pool: deps.graphPool!,
            kg: deps.knowledgeGraph,
            tenantId: deps.graphTenantId ?? 'default',
            ...(deps.embeddingClient
              ? { embeddingClient: deps.embeddingClient }
              : {}),
            log: (msg: string): void => {
              console.error(msg);
            },
            // Spec 2042 §5.11 — a promoted rule keeps the writing turn's labels.
            ...(deps.discretion
              ? {
                  onPromoted: (mkId: string) =>
                    labelSubjectWithTurn(deps.discretion, 'memorable', mkId, config.agentId),
                }
              : {}),
          },
        }
      : {}),
    log: (msg, fields): void => {
      // #1832 — some callers already carry the prefix; write it once.
      const line = msg.startsWith('[security-audit]') ? msg : `[security-audit] ${msg}`;
      console.error(`${line}${fields ? ` ${JSON.stringify(fields)}` : ''}`);
    },
  });

  // Native-tool instances (channel-coupled UI cards + calendar). The calendar
  // tools are present only when the Microsoft 365 accessor is available.
  const chatParticipantsTool = new ChatParticipantsTool(
    deps.chatPeerAgents ? { peerAgents: deps.chatPeerAgents } : {},
  );
  const askUserChoiceTool = new AskUserChoiceTool();
  const suggestFollowUpsTool = new SuggestFollowUpsTool();
  // #2060 — calendar tools act for a user (delegated tokens); never for a facilitator.
  const findFreeSlotsTool = deps.microsoft365 && !omits('tool_grant')
    ? new FindFreeSlotsTool(
        deps.microsoft365.obo,
        deps.microsoft365.calendar,
        deps.microsoft365.slots,
      )
    : undefined;
  const bookMeetingTool = deps.microsoft365 && !omits('tool_grant')
    ? new BookMeetingTool(
        deps.microsoft365.obo,
        deps.microsoft365.calendar,
        deps.microsoft365.slots,
      )
    : undefined;

  // #579 — security screener + audit sink, keyed off the resolved posture.
  // Late-bound thunks (see `OrchestratorOptions`): resolved once per turn, so a
  // screen-URL change on rebuild takes effect without touching this closure.
  // The screener is the external HTTP proxy when the operator set a URL, else
  // the default LLM judge over THIS agent's provider + model (temperature 0).
  const securityScreener = (): SecurityScreener => {
    const url = deps.securityPosture?.screenUrl;
    return url
      ? new HttpProxyScreener({ url })
      : new LlmScreener({ provider: deps.provider, model: config.model });
  };
  // The audit sink is fire-and-forget. `SessionLogger.log` is turn-shaped (it
  // records a user/assistant exchange), so a security event does not fit it;
  // the default sink writes a structured operational log line — the same idiom
  // the codebase uses for the privacy-receipt drop and the override warnings.
  // The injectable `securityAuditSink` option is the extension point for a
  // durable audit store when one lands (there is no central audit bus today).
  const securityAuditSink =
    () =>
    (event: SecurityAuditEvent): void => {
      console.warn(`[security-audit] ${JSON.stringify(event)}`);
    };

  // #914 / #967 / #2056 / #2060 — this Agent's identity section: the platform
  // identity (else the default one), replaced by authored behaviour text or —
  // #1878 — extended by the compiled character/limits sections when nothing
  // was authored; then the Steckbrief, the name, the identity rules and, last,
  // the archetype's role contract. `assembleAgentIdentity` owns the order; the
  // operator's Prompt preview (#1890) reads the same result from the built
  // agent, so the two cannot drift.
  const assistantIdentityWithName = assembleAgentIdentity(deps.assistantIdentity, config);
  const identityPrompt = identityPreamble(
    assistantIdentityWithName,
    config.answerVerbosity ?? deps.answerVerbosity,
    deps.answerLanguage,
  ).trimEnd();
  // #1033 — each per-family variant runs through the same layering, so a
  // cross-family fallback keeps the base identity, the name and the
  // description instead of speaking the bare compiled text.
  const identityByFamily = config.identityByFamily
    ? Object.fromEntries(
        Object.entries(config.identityByFamily).map(([family, text]) => [
          family,
          assembleAgentIdentity(deps.assistantIdentity, config, text),
        ]),
      )
    : config.identityByFamily;
  // What a facilitator is built WITHOUT (spec 2043 §2.3). One object so the
  // list is readable in one place; each key is simply not handed to the
  // Orchestrator, which treats absence as "not wired".
  const memoryAndLearning = omits('memory')
    ? {}
    : {
        memoryToolHandler,
        memoryBinder,
        sessionLogger,
        knowledgeGraph: deps.knowledgeGraph,
        ...(deps.contextRetriever ? { contextRetriever: deps.contextRetriever } : {}),
        ...(deps.sessionBriefing ? { sessionBriefing: deps.sessionBriefing } : {}),
        ...(deps.factExtractor ? { factExtractor: deps.factExtractor } : {}),
        ...(deps.excerptExtractor ? { excerptExtractor: deps.excerptExtractor } : {}),
        ...(deps.embeddingClient ? { embeddingClient: deps.embeddingClient } : {}),
        ...(deps.processMemory ? { nudgeProcessMemory: deps.processMemory } : {}),
        ...(deps.autoPromote !== undefined ? { autoPromote: deps.autoPromote } : {}),
        ...(deps.graphPool ? { graphPool: deps.graphPool } : {}),
      };

  // domainTools is intentionally empty at construct — the kernel registers an
  // Agent's DB-defined sub-agent tools once the registry exists.
  const orchestrator = new Orchestrator({
    agentId: config.agentId,
    // Spec 2042 §6 criterion 1 — every run trace names the agent that answers.
    traceAgentId: agentSpeaker.agentId,
    // Never masked by the privacy shield in this agent's own turn; read per
    // turn so a human added to the directory masks a namesake right away.
    ownNames: () =>
      agentOwnNames({
        speaker: agentSpeaker,
        identityName: config.identityName,
        assistantName: deps.aiDisclosure?.assistantName,
        humanNames: config.humanNames?.(),
      }),
    provider: deps.provider,
    model: config.model,
    ...(config.modelRouting ? { modelRouting: config.modelRouting } : {}),
    ...(config.effort !== undefined ? { effort: config.effort } : {}),
    // #1033 W3 — the policy's providers, resolved through the shared pool.
    ...(deps.providerPool ? { providerPool: deps.providerPool } : {}),
    ...(config.primaryRef ? { primaryRef: config.primaryRef } : {}),
    ...(config.fallbackRef ? { fallbackRef: config.fallbackRef } : {}),
    ...(identityByFamily ? { identityByFamily } : {}),
    archetypeOmissions: { memory: omits('memory'), toolGrant: omits('tool_grant') },
    // Who a channel user is, even for an archetype built without memory: the
    // audience floor and the turn owner need it in every group conversation.
    identityGraph: deps.knowledgeGraph,
    ...(config.fallbackVisionSupported !== undefined
      ? { fallbackVisionSupported: config.fallbackVisionSupported }
      : {}),
    ...(workingModes.length > 0 ? { personaSkills: workingModes } : {}),
    maxTokens: config.maxTokens,
    maxToolIterations: config.maxToolIterations,
    ...(config.loopRepeatSoft !== undefined
      ? { loopRepeatSoft: config.loopRepeatSoft }
      : {}),
    ...(config.loopRepeatHard !== undefined
      ? { loopRepeatHard: config.loopRepeatHard }
      : {}),
    ...(config.maxTurnSeconds !== undefined
      ? { maxTurnSeconds: config.maxTurnSeconds }
      : {}),
    domainTools: [],
    ...(config.grantedPluginIds
      ? { grantedPluginIds: config.grantedPluginIds }
      : {}),
    nativeToolRegistry: deps.nativeToolRegistry,
    ...memoryAndLearning,
    entityRefBus: deps.entityRefBus,
    // #2060 — a facilitator's tools are the engine's and nothing else, on
    // both tool loops: no choice cards, follow-up chips, roster or attachment
    // tool of the kernel (the engine has its own, bound to the facilitation).
    ...(omits('tool_grant') ? {} : { chatParticipantsTool, askUserChoiceTool }),
    // W2-1 (#544) — both or neither: a store with no replayer would park calls
    // the user can answer but nothing can deliver.
    ...(deps.pendingMcpInput && deps.mcpInputReplay
      ? {
          pendingMcpInput: deps.pendingMcpInput,
          mcpInputReplay: deps.mcpInputReplay,
        }
      : {}),
    ...(omits('tool_grant') ? {} : { suggestFollowUpsTool }),
    ...(findFreeSlotsTool ? { findFreeSlotsTool } : {}),
    ...(bookMeetingTool ? { bookMeetingTool } : {}),
    responseGuard: deps.responseGuard,
    ...(config.quality ? { agentQuality: config.quality } : {}),
    privacyGuard: deps.privacyGuard,
    ...(deps.turnReceiptStore
      ? { turnReceiptStore: deps.turnReceiptStore }
      : {}),
    ...(deps.pluginConfigGet
      ? { pluginConfigGet: deps.pluginConfigGet }
      : {}),
    ...(deps.isPluginToolsReady
      ? { isPluginToolsReady: deps.isPluginToolsReady }
      : {}),
    nudgeRegistry: deps.nudgeRegistry,
    ...(deps.nudgeStateStore ? { nudgeStateStore: deps.nudgeStateStore } : {}),
    ...(deps.autoPromoteThreshold !== undefined
      ? { autoPromoteThreshold: deps.autoPromoteThreshold }
      : {}),
    ...(deps.autoPromoteDurableMinSignificance !== undefined
      ? {
          autoPromoteDurableMinSignificance:
            deps.autoPromoteDurableMinSignificance,
        }
      : {}),
    ...(deps.autoPromoteDurableKinds !== undefined
      ? { autoPromoteDurableKinds: deps.autoPromoteDurableKinds }
      : {}),
    ...(deps.graphTenantId ? { graphTenantId: deps.graphTenantId } : {}),
    // #914 — the Agent's own behaviour text wins over the platform-wide one.
    // Resolved once, here, so the two call sites below cannot disagree about
    // which identity this Agent speaks with. #967 folds the Agent's name into
    // that same resolved value for the same reason.
    ...(assistantIdentityWithName
      ? { assistantIdentity: assistantIdentityWithName }
      : {}),
    // #967 — the SAME authored name, handed over separately as well. The
    // prompt is not the only place an Agent states who it is: the Art. 50
    // marking names the assistant too and is resolved behind the model, where
    // the prompt is deliberately out of reach. Without this it had only the
    // platform-wide `ai_disclosure_assistant_name` — one string for every
    // Agent — so each provisioned bot signed its answers with whichever single
    // name the operator had typed there.
    ...(config.identityName?.trim()
      ? { identityName: config.identityName.trim() }
      : {}),
    // Agent's own setting beats the installation default (one block, never two).
    ...((config.answerVerbosity ?? deps.answerVerbosity)
      ? { answerVerbosity: config.answerVerbosity ?? deps.answerVerbosity }
      : {}),
    ...(deps.answerLanguage ? { answerLanguage: deps.answerLanguage } : {}),
    ...(deps.aiDisclosure ? { aiDisclosure: deps.aiDisclosure } : {}),
    ...(deps.aiDisclosureSeenStore
      ? { aiDisclosureSeenStore: deps.aiDisclosureSeenStore }
      : {}),
    ...(deps.aiDisclosureMarkerStore
      ? { aiDisclosureMarkerStore: deps.aiDisclosureMarkerStore }
      : {}),
    // #579 — org security posture + its screener/audit sink. Posture absent →
    // orchestrator applies the shipping default (`auto`); the screener + sink
    // are always wired (inert unless screening is enabled for the posture).
    ...(deps.securityPosture ? { securityPosture: deps.securityPosture } : {}),
    // #575 — supplying this is what makes the audience guards non-inert.
    ...(deps.audienceGrants ? { audienceGrants: deps.audienceGrants } : {}),
    ...(deps.consultation ? { consultation: deps.consultation } : {}),
    ...(deps.discretion ? { discretion: deps.discretion } : {}),
    securityScreener,
    securityAuditSink,
    ...(deps.turnHookRegistry
      ? { turnHookRegistry: deps.turnHookRegistry }
      : {}),
    ...(deps.attachmentReader && !omits('tool_grant')
      ? { attachmentReader: deps.attachmentReader }
      : {}),
  });

  // #309 Shape 3: a tool-less subscription-CLI provider (`claude-cli`) CANNOT
  // drive the in-process tool loop (its `stream()`/`complete()` reject any
  // request carrying tools). Swap the agent for the CLI agent-runtime, where the
  // official `claude` CLI owns the loop and reaches omadia's tools via the
  // loopback MCP server. Done HERE — the single factory the default chatAgent
  // path AND the US4 registry both call — so every chat surface (web-ui canvas,
  // channels) routes to the CLI runtime, not just the default service. The raw
  // Orchestrator is still built + returned (sub-agents attach to it post-activate;
  // exposing those to the CLI dispatch is a follow-up — native tools work now).
  if (deps.provider?.id === 'claude-cli') {
    // Security note (P2-2): the subscription CLI sees the native tool registry
    // via the loopback MCP server, filtered by readiness and (#1598) by this
    // Agent's plugin assignment.
    const dispatch = new ToolDispatchService({
      nativeTools: deps.nativeToolRegistry,
      // Live read: sub-agents (ask_<slug>) attach to `orchestrator` post-activate,
      // so the CLI reaches them over the loopback bridge. A sub-agent's own loop
      // still runs in-process on the tool-less claude-cli provider, so tool-using
      // sub-agents fail GRACEFULLY (dispatch returns an error result) until they
      // also run on the CLI (recursive Shape 3 — follow-up); tool-less ones work.
      domainToolsProvider: () => orchestrator.listDomainTools(),
      // #1585 — kernel natives (ask_user_choice, …) dispatch to THIS build's
      // instances, the ones `drainCliTurnCards` below reads.
      kernelNativeHandler: (name) => orchestrator.kernelNativeHandler(name),
      // Issue #474 — this dispatcher bypasses `Orchestrator.dispatchTool`
      // entirely (the CLI reaches tools over the loopback MCP server), so
      // the readiness gate must be repeated here too.
      ...(deps.isPluginToolsReady
        ? { isPluginToolsReady: deps.isPluginToolsReady }
        : {}),
      // #1598 — and the per-Agent plugin assignment, for the same reason.
      isToolGranted: (name, agentId, scope) => orchestrator.isToolGranted(name, agentId, scope),
      // A channel turn's routine has to name this Agent, see `initRoutines`.
      agentSlug: config.agentId,
      // #1763 — a templated routine run captures raw tool results here too:
      // CLI tool calls run inside the caller's restored turn context, so the
      // routine runner's capture hook is reachable through it.
      captureRawToolResult: (name, result) => {
        turnContext.current()?.captureRawToolResult?.(name, result);
      },
    });
    const cliModel = config.model.replace(/-cli$/, '') || 'sonnet';
    return {
      orchestrator,
      bundle: {
        agent: finalize(new CliChatAgent({
          dispatch,
          // #1102 — surface the choice card / follow-up chips / slot picker a
          // kernel-native tool scheduled this turn on the `done` event, so the
          // subscription-CLI path renders them like the API-key path.
          drainTurnCards: () => orchestrator.drainCliTurnCards(),
          // #2303 (ADR-0177) — and the files and diagrams its tools produced.
          drainTurnAttachments: () => orchestrator.drainCliTurnAttachments(),
          // #1582 — the AI disclosure, resolved and folded like an API-key turn.
          discloseAnswer: (answer, input) => orchestrator.discloseCliAnswer(answer, input),
          // A refusal under OMADIA_PRIVACY_FORCE_GUARDED is worded in the
          // turn's language, by the same rule as the in-process notices.
          noticeLocale: (input) => orchestrator.noticeLocale(input),
          // ADR-0195 — a guarded turn runs through its own privacy handle
          // (masks, interning, v4 tools, restore, receipt); one that gets no
          // handle is refused (fail closed), as under the org policy.
          privacyGuarded: () => deps.privacyGuard() !== undefined,
          turnPrivacy: (input, turnId) => orchestrator.cliTurnPrivacy(input, turnId, cliModel),
          model: cliModel,
          // #1391 — persist every successful CLI turn like an in-process one
          // (session log + graph nodes, facts, excerpt, auto-promotion,
          // `onAfterTurn`), so Memory and recall stop being blank here.
          recordTurn: (input, turn) => orchestrator.recordCliTurn(input, turn),
          // #1391 — and recall from the graph before the spawn, as the
          // in-process turn does before it calls the model.
          recallContext: (input) => orchestrator.recallCliContext(input),
          // #1102 — `memory` from the stack this turn is bound to, served by a
          // per-turn dispatch rather than the shared registry.
          bindTurnMemory: (input) => orchestrator.bindCliTurnMemory(input),
          // Spec 2042 §5.11 / #2194 — the in-process turn's discretion state
          // and the people-egress check of its answer, for this path too.
          discretionTurnFields: (input) => orchestrator.cliDiscretionTurnFields(input),
          ...(deps.attachmentReader?.bindToCurrentConversation
            ? {
                bindStatedUpload: (key: string) =>
                  deps.attachmentReader!.bindToCurrentConversation!(key),
              }
            : {}),
          guardAnswer: (answer, input) => orchestrator.guardCliAnswer(answer, input),
          answerMayBeWithheld: () => orchestrator.answerMayBeWithheld(),
          // #1087 — the CLI child is stateless by design, so the composed
          // prompt is the only memory a turn has. Feed it from the RAW chat
          // session, not the ContextRetriever tail: that one reads Session
          // nodes from the knowledge graph, whose capture filter drops turns
          // below its significance threshold — the short turns a chat is full
          // of — so a KG-backed tail would be lossy. Same depth as that tail:
          // the operator's `context_tail_size` when the retriever is wired.
          ...(deps.contextRetriever
            ? { sessionTailSize: deps.contextRetriever.tailSize }
            : {}),
          sessionTail: async (sessionScope: string, limit: number) => {
            // Channel and ad-hoc HTTP scopes are not chat-session ids; the
            // store would reject them, and nothing ever wrote them. `undefined`
            // (not `[]`) so the agent discloses the gap instead of treating a
            // Teams conversation as a brand-new chat.
            if (!isChatSessionScope(sessionScope)) return undefined;
            const session = await chatSessionStore.get(sessionScope);
            // Absent session ⇒ unreadable, NOT an empty chat. The store is
            // written by the browser's fire-and-forget PUT (`chatSessions.ts`,
            // `putRemoteSession`) and, since #1391, by the session logger's
            // mirror after each recorded CLI turn; the web UI already PUTs
            // when the tab is created — so a missing document means the
            // write was lost, not that the chat is new. Reading it as "new"
            // would reproduce #1087 silently; the cost of the other reading is
            // a disclosure note on the rare first turn that races the PUT.
            if (session === null || !Array.isArray(session.messages)) {
              // Logged, because the system-prompt note is otherwise the only
              // trace of the lost write (thrown and timed-out reads log too).
              console.warn(
                `[cli-chat-agent] session tail unreadable: chat-session document missing or malformed ${JSON.stringify({ sessionScope })}`,
              );
              return undefined;
            }
            const turns = chatSessionTailTurns(session.messages, limit);
            // Messages exist but none of them form a replayable turn (a first
            // question that errored or was never answered): that is a gap the
            // agent must disclose, not the empty chat `[]` would claim. A
            // session with NO messages (fresh or cleared tab) is the genuine
            // first turn and falls through to `[]`. #1071 — routine deliveries
            // (`proactive`) are no conversation either: a chat holding only
            // those (cleared, then a routine delivered) is empty, not a gap.
            if (turns.length === 0 && session.messages.some((m) => !m.proactive)) {
              return undefined;
            }
            return turns;
          },
          ...(assistantIdentityWithName
            ? { systemPrompt: assistantIdentityWithName }
            : {}),
          // #1016 — without this forward the guard exists but nothing installs
          // it, and a stale routine context dispatches under the previous
          // principal instead of being refused.
          ...(deps.turnOwnerGuard
            ? { turnOwnerGuard: deps.turnOwnerGuard }
            : {}),
          // #1085 — without this forward the kernel publishes the rule and
          // the turn still spawns whatever PATH resolves, which is the whole
          // bug: an operator's runtime install moves the version badge and
          // nothing else.
          ...(deps.resolveCliBinary
            ? { resolveCliBinary: deps.resolveCliBinary }
            : {}),
          // OM-104 — operator-set turn budget. Only forwarded when actually
          // configured, so an unset field leaves the ENV override reachable.
          ...(config.cliTurnSeconds !== undefined && config.cliTurnSeconds > 0
            ? { spawnTimeoutMs: Math.trunc(config.cliTurnSeconds * 1000) }
            : {}),
        })),
        raw: orchestrator,
        externalToolLoop: true,
        sessionLogger,
        chatSessionStore,
      },
      effectiveModel: config.model,
      ...(config.modelRouting ? { effectiveModelRouting: config.modelRouting } : {}),
      identityPrompt,
      dataPlanGuard,
    };
  }

  // Verifier wrapper — only when the `verifier@1` capability is published.
  // Without it the bare Orchestrator IS the chatAgent.
  let agent: ChatAgent = orchestrator;
  if (deps.verifierBundle) {
    agent = new VerifierService({
      orchestrator,
      pipeline: deps.verifierBundle.pipeline,
      ...(deps.verifierBundle.store
        ? { store: deps.verifierBundle.store }
        : {}),
      enabled: true,
      mode: deps.verifierBundle.mode,
      maxRetries: deps.verifierBundle.maxRetries,
      // The operator's switch for the borderline resample
      // (`verifier_resample_on_borderline`); absent → the service default (on).
      ...(deps.verifierBundle.resampleOnBorderline !== undefined
        ? { resampleOnBorderline: deps.verifierBundle.resampleOnBorderline }
        : {}),
      ...(deps.turnHookRegistry
        ? { turnHookRegistry: deps.turnHookRegistry }
        : {}),
      // The notice for an answer `enforce` withholds is worded in the turn's
      // disclosure locale; this is the fallback when the operator turned the
      // disclosure off (same rule as the turn-incomplete notice).
      ...(deps.aiDisclosure?.locale ? { locale: deps.aiDisclosure.locale } : {}),
    });
  }

  return {
    orchestrator,
    bundle: { agent: finalize(agent), raw: orchestrator, sessionLogger, chatSessionStore },
    effectiveModel: config.model,
    ...(config.modelRouting ? { effectiveModelRouting: config.modelRouting } : {}),
    identityPrompt,
    dataPlanGuard,
  };
}

/**
 * #2060 — the working modes an agent is built with. A `standard` agent keeps
 * every attached mode (each is composed beneath its identity anyway). An agent
 * of any other archetype has a fixed identity: a mode written as an identity
 * of its own is left out here as well, so a skill edited after it was
 * attached cannot bring back what the route refused (fail closed).
 */
export function workingModesKeepingIdentity(
  modes: readonly OrchestratorPersonaSkill[],
  archetype: string | undefined,
  agentId: string,
): readonly OrchestratorPersonaSkill[] {
  if (archetype === undefined || archetype === STANDARD_ARCHETYPE) return modes;
  return modes.filter((mode) => {
    const findings = findWorkingModeIdentityReplacement(mode);
    if (findings.length === 0) return true;
    console.warn(
      `[working-modes] agent ${agentId}: mode "${mode.slug}" left out, it replaces who speaks (${findings.map((f) => f.path).join(', ')})`,
    );
    return false;
  });
}
