/**
 * @omadia/orchestrator — public barrel.
 *
 * **S+10-3**: file moves landed. The Orchestrator class itself, six native-
 * tool factories (chat_participants/ask_user_choice/suggest_follow_ups/
 * find_free_slots/book_meeting/query_knowledge_graph), VerifierService
 * wrapper, NativeToolRegistry, RunTraceCollector, the SessionLogger +
 * ChatSessionStore + turnContext + chatParticipants cluster, and the
 * LocalSubAgent + DomainTool contract are plugin-owned. (S+12.5-1 moved
 * `query_knowledge_graph` here from the deprecated kg shell — consumer-
 * owns-tool, since multi-provider kg made provider-owns-tool ambiguous.)
 *
 * S+10-4 wires this barrel into `activate()` via late-resolve and
 * publishes `chatAgent@1` as a bundle; the kernel boot consumes
 * `ctx.services.get('chatAgent')` instead of building the Orchestrator
 * by hand.
 */

// Plugin entry point
export { activate } from './plugin.js';
export type {
  ChatAgentBundle,
  OrchestratorPluginHandle,
} from './plugin.js';

// Multi-orchestrator registry (US4) — read by US7 channel routing and US9 UI.
export {
  OrchestratorRegistry,
  validateSnapshot,
} from './registry/index.js';
export type {
  ActiveAgent,
  OrchestratorRegistryOptions,
  PluginCapabilityLookup,
} from './registry/index.js';
// US5 — hot-reload diff + LISTEN/NOTIFY bus.
export { diffSnapshots, buildForAgent } from './registry/applyDiff.js';
export type { DiffAction, DiffPlan } from './registry/applyDiff.js';
export { ReloadBus } from './registry/reloadBus.js';
export type { ReloadBusOptions } from './registry/reloadBus.js';
// US7 — channel routing + first-boot onboarding.
export { ChannelResolver } from './routing/channelResolver.js';
export type {
  ChannelResolverOptions,
  ResolveDecision,
  ResolveResult,
} from './routing/channelResolver.js';
export {
  ensureFallbackAgent,
  attachAllPlugins,
  FALLBACK_AGENT_SLUG,
} from './registry/onboarding.js';
export type { OnboardingOptions } from './registry/onboarding.js';
// US8 — per-Agent memory scope.
export { computeMemoryScope } from './registry/index.js';
export {
  MemoryScopeViolation,
  ScopedMemoryStore,
} from './registry/scopedMemoryStore.js';
export type { ScopedMemoryStoreOptions } from './registry/scopedMemoryStore.js';
export {
  ConfigStore,
  ConfigValidationError,
} from './registry/configStore.js';
export type {
  AgentInput,
  AgentPatch,
  AgentPluginInput,
  AgentPluginRow,
  AgentRow,
  AgentStatus,
  ChannelBindingInput,
  ChannelBindingRow,
  ConfigSnapshot,
  PlatformSettingsRow,
  PrivacyProfile,
} from './registry/configStore.js';
export { runMultiOrchestratorMigrations } from './registry/migrator.js';

// Per-Agent Orchestrator factory (US3) — re-exported so US4-style external
// callers (CLI, tests) can build Orchestrators without going through the
// plugin's activate path.
export { buildOrchestratorForAgent } from './buildOrchestrator.js';
export type {
  AgentRuntimeConfig,
  BuiltOrchestrator,
  OrchestratorDeps,
} from './buildOrchestrator.js';

// Orchestrator class + options
export { Orchestrator, parseToolEmittedChoice } from './orchestrator.js';
export type { OrchestratorOptions } from './orchestrator.js';

// Streaming retry predicate (exported for unit coverage)
export { isRetryableStreamError } from './streaming.js';

// Verifier wrapper (couples verifier@1 pipeline + Orchestrator + toSemanticAnswer)
export { VerifierService } from './verifierService.js';

// Sub-agent runtime
export { LocalSubAgent } from './localSubAgent.js';
export type {
  LocalSubAgentTool,
  LocalSubAgentToolResult,
  AskOptions,
} from './localSubAgent.js';

// Knowledge-graph native tool (moved from harness-knowledge-graph in S+12.5-1)
export {
  KnowledgeGraphTool,
  KNOWLEDGE_GRAPH_TOOL_NAME,
  knowledgeGraphToolSpec,
} from './knowledgeGraphTool.js';

// Native-tool registry — kernel-shared dispatch table
export { NativeToolRegistry } from './nativeToolRegistry.js';
export type {
  NativeToolRegistration,
  NativeToolRegistrationOptions,
  NativeToolHandlerRegistrationOptions,
} from './nativeToolRegistry.js';

// Run-trace collector + payload re-export
export { RunTraceCollector } from './runTraceCollector.js';
export type {
  RunTraceCollectorOptions,
  InvocationHandle,
} from './runTraceCollector.js';
export type { RunTracePayload } from '@omadia/channel-sdk';

// Session logger + chat-session store
export { SessionLogger } from './sessionLogger.js';
export type { SessionLogEntry } from './sessionLogger.js';
export {
  ChatSessionStore,
  InvalidSessionIdError,
  isValidSessionId,
} from './chatSessionStore.js';
export type {
  ChatSubAgentEvent,
  ChatToolEvent,
  ChatMessage,
  ChatSession,
  ChatSessionSummary,
  SessionConfigSnapshot,
} from './chatSessionStore.js';

// Per-turn AsyncLocalStorage context
export {
  turnContext,
  today,
  buildDateHeader,
} from './turnContext.js';
export type { TurnContextValue } from './turnContext.js';

// Chat-participants contract (Teams roster provider seam)
export type {
  ChatParticipant,
  ChatParticipantsProvider,
} from './chatParticipants.js';

// Native tools — channel-coupled UI cards + calendar + roster
export {
  ChatParticipantsTool,
  CHAT_PARTICIPANTS_TOOL_NAME,
  chatParticipantsToolSpec,
} from './tools/chatParticipantsTool.js';
export {
  AskUserChoiceTool,
  ASK_USER_CHOICE_TOOL_NAME,
  askUserChoiceToolSpec,
} from './tools/askUserChoiceTool.js';
export type { PendingUserChoice } from './tools/askUserChoiceTool.js';
export {
  SuggestFollowUpsTool,
  SUGGEST_FOLLOW_UPS_TOOL_NAME,
  suggestFollowUpsToolSpec,
} from './tools/suggestFollowUpsTool.js';
export type { FollowUpOption } from './tools/suggestFollowUpsTool.js';
export {
  FindFreeSlotsTool,
  FIND_FREE_SLOTS_TOOL_NAME,
  findFreeSlotsToolSpec,
} from './tools/findFreeSlotsTool.js';
export type {
  PendingSlotCard,
  TurnAuthContext,
} from './tools/findFreeSlotsTool.js';
export {
  BookMeetingTool,
  BOOK_MEETING_TOOL_NAME,
  bookMeetingToolSpec,
} from './tools/bookMeetingTool.js';

// Sub-agent / domain-tool contract — consumed by uploaded agents and the
// orchestrator's domainTools registry.
export {
  createDomainTool,
} from './tools/domainQueryTool.js';
export type {
  DomainTool,
  DomainToolSpec,
  AskObserver,
  Askable,
} from './tools/domainQueryTool.js';

// Surface-types pass-through from channel-sdk (S+10-2 lift). Re-exported
// here so kernel-side callers that already imported these from
// `services/orchestrator.js` keep working with `@omadia/orchestrator`
// after the file move.
export type {
  ChatAgent,
  ChatStreamEvent,
  ChatTurnAttachment,
  ChatTurnInput,
  ChatTurnResult,
  DiagramAttachment,
  VerifierResultSummary,
} from '@omadia/channel-sdk';
export { toSemanticAnswer } from '@omadia/channel-sdk';
