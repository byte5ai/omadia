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

// Per-turn Sonnet/Opus routing config (attached to AgentRuntimeConfig).
export { routeTurnModel } from './modelRouter.js';
export type {
  ModelRoutingConfig,
  RouteResult,
  RoutingBucket,
} from './modelRouter.js';

// Wave 8 — per-turn direct-answer persona routing (twin of modelRouter).
export { routeTurnPersona } from './personaRouter.js';
export type {
  PersonaCandidate,
  PersonaRouteResult,
  PersonaRoutingBucket,
} from './personaRouter.js';

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
  validateModelRef,
  validateModelRoutingShape,
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

// Agent Builder — editable graph store, MCP client, sub-agent materialisation,
// and the persisted-routing → runtime mapping.
export { AgentGraphStore } from './registry/agentGraphStore.js';
export { computeSkillHash } from './registry/skillHash.js';
export type {
  CanvasPos,
  McpCallLogRow,
  McpConfigField,
  McpRegistryRow,
  McpServerInput,
  McpServerRow,
  McpToolVerdictAckRow,
  McpToolVerdictRow,
  PersonaSkillRow,
  ScheduleInput,
  ScheduleRow,
  SkillInput,
  SkillPatch,
  SkillResourceInput,
  SkillResourceRow,
  SkillToolBindingRow,
  SkillVerdictRow,
  SkillRow,
  SubAgentInput,
  SubAgentPatch,
  SubAgentRow,
  ToolGrantInput,
  ToolGrantRow,
} from './registry/agentGraphStore.js';
export {
  McpManager,
  mcpNativeHandler,
  mcpNativeToolName,
  mcpToolToLocalSubAgentTool,
  mcpToolToNativeSpec,
} from './mcp/mcpClient.js';
export type {
  McpAuthProvider,
  McpCallerKind,
  McpCallGuard,
  McpCallLogEntry,
  McpCallObserver,
  McpManagerOptions,
  McpServerConfig,
  McpToolDescriptor,
  McpTransportKind,
} from './mcp/mcpClient.js';
export {
  buildSubAgentDomainTools,
  mcpToolNameFromRef,
  subAgentToolName,
} from './registry/subAgentTools.js';
export type {
  SubAgentGraph,
  SubAgentToolDeps,
} from './registry/subAgentTools.js';
export {
  DEFAULT_ORCHESTRATOR_MODEL,
  resolveAgentModelRouting,
} from './registry/agentRuntime.js';
export type { ResolvedAgentRuntime } from './registry/agentRuntime.js';

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

// #332 Layer 2 — Direct Line directive parsing & target resolution (exported
// for unit coverage and reuse by deterministic routers / the Conductor).
export {
  parseDirectLineDirective,
  resolveDirectLineTarget,
  directLineLabel,
  DEFAULT_DIRECTIVE_PREFIX,
} from './directLine.js';
export type {
  DirectLineDirective,
  DirectLineCandidate,
  DirectLineResolution,
  DirectLineMode,
} from './directLine.js';

// #445 — sticky Direct Line: the pure target-selection layer. Exported so the
// decision table, the scope allow-gate and the binding store can be unit-tested
// without an Orchestrator, and so the store can be constructed once at boot and
// injected (it must outlive any single Orchestrator instance).
export {
  classifyStickyScope,
  decideDirectLineTurn,
  isDirectLineExitMessage,
  stickyKeyFor,
  InMemoryDirectLineStickyStore,
  DIRECT_LINE_EXIT_TOKENS,
  SHARED_SCOPES,
  SYNTHETIC_SCOPE_PREFIXES,
  STICKY_IDLE_TTL_MS,
  STICKY_MAX_BINDINGS,
} from './directLineSticky.js';
export type {
  DirectLineBinding,
  DirectLineDecision,
  DirectLineStickyStore,
  StickyScopeClassification,
  StickyScopeRefusal,
} from './directLineSticky.js';

// Round-loop guard — exported so it can be unit-tested in isolation and reused
// by other agentic loops (e.g. the Builder).
export { LoopGuard, canonicalize } from './loopGuard.js';
export type {
  LoopGuardOptions,
  LoopGuardDecision,
  LoopGuardAction,
  ToolUseLike,
  ToolResultLike,
} from './loopGuard.js';

// Omadia UI canvas sentinels (PR-7a) — pure parsers + the canvas-output gate.
// Not yet wired into the tool loop; the canvas orchestrator (PR-9) consumes them.
export {
  CANVAS_OUTPUT_CAPABILITY,
  isCanvasOutputAuthorized,
  parseToolEmittedStructuredPayload,
  parseToolEmittedCanvasTree,
  parseToolEmittedSurfacePatch,
  parseToolEmittedMutation,
} from './canvasSentinels.js';
export type {
  PendingStructuredPayload,
  PendingCanvasTree,
  PendingSurfacePatch,
  PendingMutation,
} from './canvasSentinels.js';

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
export { ToolDispatchService } from './toolDispatchService.js';
export type {
  DispatchableToolSpec,
  ToolDispatchResult,
} from './toolDispatchService.js';
export { LoopbackMcpServer } from './loopbackMcpServer.js';
export type {
  LoopbackMcpServerDeps,
  LoopbackMcpServerHandle,
} from './loopbackMcpServer.js';
export { CLI_ENV_SCRUB_KEYS, CliChatAgent, StreamJsonParser } from './cliChatAgent.js';
export type { CliChatAgentDeps, CliUsage } from './cliChatAgent.js';
export { createCliSubAgent } from './cliSubAgent.js';
export type { CliSubAgentOptions } from './cliSubAgent.js';

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

// Mid-turn steering bus — out-of-band user-message injection into a live turn.
export { SteeringBus, steeringBus, MAX_STEER_LENGTH } from './steeringBus.js';
export type { SteerEnqueueResult } from './steeringBus.js';

// Session logger + chat-session store
export { SessionLogger, graphScopeFor } from './sessionLogger.js';
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
export {
  setMcpPrivacyBypassServers,
  isMcpServerPrivacyBypassed,
} from './mcpPrivacyBypass.js';
export {
  setMcpKgIngestServers,
  isMcpServerKgIngest,
} from './mcpKgIngest.js';
export type {
  TurnAnnotation,
  TurnHook,
  TurnHookContext,
  TurnHookPayload,
  TurnHookPoint,
  TurnHookRegistrar,
  TurnHookRegistration,
  TurnHookRunner,
} from './turnHooks.js';

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
  READ_ATTACHMENT_TOOL_NAME,
  ReadAttachmentTool,
  readAttachmentToolSpec,
} from './tools/readAttachmentTool.js';
export type { AttachmentReader } from './tools/readAttachmentTool.js';
export { createAttachmentReader } from './attachmentReaderFactory.js';
export type { AttachmentByteStore } from './attachmentReaderFactory.js';
export {
  QUERY_DATASET_TOOL_NAME,
  QueryDatasetTool,
  queryDatasetToolSpec,
} from './tools/queryDatasetTool.js';
export { isCsvAttachment } from './attachmentExtract.js';
export {
  buildDatasetFromCsv,
  importCsvDataset,
  parseCsv,
  MAX_DATASET_ROWS,
} from './datasetImport.js';
export type {
  CsvParseResult,
  ImportCsvDatasetInput,
  ImportCsvDatasetResult,
  PrivacyScanStats,
} from './datasetImport.js';
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

// W2-2 (issue #543, rescoped) — the generic long-running task seam: any tool can
// be marked `longRunning` and get the non-blocking `<tool>_start`/`_status`/
// `_list` triple plus a streaming status card, instead of blocking a chat turn.
// `dev_job` is the first implementor (see `devplatform/devJobTaskStore.ts`);
// deferred sub-agent dispatch is the second (`tasks/subAgentTaskTool.ts`).
export {
  TASK_LIFECYCLE_STATUSES,
  TERMINAL_TASK_STATUSES,
  TASK_LEASE_UUID_RE,
  TaskLeaseLostError,
  isTaskLifecycleStatus,
  isTerminalTaskStatus,
} from './tasks/taskTypes.js';
export type {
  NewTaskInput,
  TaskCardPayload,
  TaskDescriptor,
  TaskEventRecord,
  TaskLifecycleStatus,
  TaskListFilter,
  TaskReadStore,
  TaskReapOptions,
  TaskReapResult,
  TaskStore,
  TerminalTaskPatch,
} from './tasks/taskTypes.js';
export { InMemoryTaskStore } from './tasks/inMemoryTaskStore.js';
export type { InMemoryTaskStoreOptions } from './tasks/inMemoryTaskStore.js';
export {
  defineLongRunningTool,
  describeDeferredPrivacyPosture,
  longRunningToolNames,
} from './tasks/longRunningTool.js';
export type {
  LongRunningToolDefinition,
  LongRunningToolHandle,
  LongRunningToolRegistration,
  TaskExecutionHandle,
  TaskExecutor,
} from './tasks/longRunningTool.js';
export {
  DEFAULT_TASK_PURGE_TERMINAL_AFTER_MS,
  DEFAULT_TASK_REAP_INTERVAL_MS,
  DEFAULT_TASK_STALE_AFTER_MS,
  runTaskReaperOnce,
  startTaskReaper,
} from './tasks/taskReaper.js';
export type { TaskReaperOptions } from './tasks/taskReaper.js';
export {
  SUB_AGENT_TASK_KIND_PREFIX,
  createLongRunningSubAgentTool,
} from './tasks/subAgentTaskTool.js';
export type { LongRunningSubAgentToolOptions } from './tasks/subAgentTaskTool.js';
