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
  // #679 / I5 — exported so a locale-aware surface can recognise the
  // server-written seed prose and render its own copy instead.
  FALLBACK_AGENT_SEED_NAME,
  FALLBACK_AGENT_SEED_DESCRIPTION,
} from './registry/onboarding.js';
export type { OnboardingOptions } from './registry/onboarding.js';
// US8 — per-Agent memory scope.
export { computeMemoryScope } from './registry/index.js';
export {
  MemoryScopeViolation,
  ScopedMemoryStore,
} from './registry/scopedMemoryStore.js';
export type { ScopedMemoryStoreOptions } from './registry/scopedMemoryStore.js';
// W5 (#860) — chat-context memory ACL. The scope resolver and the tier-root
// helper are exported because they are the contract the promote service, the
// purge service and the tests all have to agree on: a second spelling of
// `/memories/contexts/<slug>/<axis>/<key>` anywhere would be a partition the
// compiled scope does not grant.
export {
  CONTEXT_AXES,
  contextTierRoot,
  effectiveMemoryScope,
  orchestratorMemoryScope,
} from './registry/scopedMemoryStore.js';
export type {
  ContextAxis,
  ContextMemoryEnforcement,
  EffectiveMemoryScopeOptions,
  MemoryAxes,
  MemoryAxis,
} from './registry/scopedMemoryStore.js';
export { ContextMemoryNamespacer } from './orchestratorMemoryNamespacer.js';
export type { ContextMemoryNamespacerOptions } from './orchestratorMemoryNamespacer.js';
export {
  DEFAULT_BINDER_CACHE_CAP,
  MemoryBinder,
  memoryBindingCacheKey,
} from './memoryBinder.js';
export type {
  BoundTurnMemory,
  ContextMemoryMode,
  MemoryBinderOptions,
} from './memoryBinder.js';
export {
  AGENT_TO_AGENT_MODES,
  isAgentToAgentEnabled,
  parseAgentToAgentMode,
} from './registry/agentToAgent.js';
export type {
  AgentChannelPolicyInput,
  AgentChannelPolicyRow,
  AgentToAgentMode,
} from './registry/agentToAgent.js';
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
  ChannelIdentityRow,
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
  McpDelegation,
  McpOAuthClientAcquisition,
  McpRegistryRow,
  McpServerInput,
  McpServerRow,
  McpToolVerdictAckRow,
  McpToolVerdictRow,
  PersonaSkillRow,
  PluginMcpGrantRow,
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
  DEPRECATED_MCP_TRANSPORTS,
  isDeprecatedMcpTransport,
  McpManager,
  MCP_RESULT_TYPE_INPUT_REQUIRED,
  REPLAY_ARG_KEY,
  planMcpInputReplay,
  extractStructured,
  isInputRequiredResult,
  mcpNativeHandler,
  mcpNativeToolName,
  // Exported so the no-collateral-invalidation rule of `McpManager.close(id)`
  // can be unit tested and reused by ops tooling (issue #563).
  mcpPoolScopeMatches,
  // #545 — the tool-list cache rules (TTL normalisation + scope keying) are
  // the contract, unit-tested as pure functions like `mcpPoolScopeMatches`.
  mcpToolListTtlMs,
  mcpToolListCacheKey,
  MCP_TOOLLIST_DEFAULT_TTL_MS,
  MCP_TOOLLIST_MAX_TTL_MS,
  mcpToolToLocalSubAgentTool,
  mcpToolToNativeSpec,
  renderToolResult,
  // W3-A — the inner half of the timeout hierarchy; see the ORDERING INVARIANT
  // block next to `DEFAULT_MCP_CALL_MAX_TOTAL_TIMEOUT_MS`.
  resolveMcpCallTimeouts,
  // W4 — attempts per `callTool`. The timeout hierarchy reasons about the
  // retry-inclusive worst case, so the real number has to be readable.
  MCP_CALL_MAX_ATTEMPTS,
} from './mcp/mcpClient.js';
export type {
  DeprecatedMcpTransport,
  McpAuthProvider,
  McpCallerKind,
  McpCallGuard,
  McpCallLogEntry,
  McpCallObserver,
  McpCallOutcome,
  McpInputRequiredSidecar,
  McpManagerOptions,
  McpServerConfig,
  McpSidecarIdentity,
  McpSidecarKind,
  McpSidecarPayload,
  McpStructuredOutputSidecar,
  McpStructuredSink,
  McpToolDescriptor,
  McpTransportKind,
} from './mcp/mcpClient.js';
// W2-1 (#544) — MRTR mid-call user input.
export {
  InMemoryPendingMcpInputStore,
  MCP_INPUT_MAX_REPLAY_DEPTH,
  MCP_INPUT_REPLY_PREFIX,
  MCP_INPUT_REQUEST_MAX_FIELDS,
  MCP_INPUT_REQUIRED_SENTINEL_PREFIX,
  PENDING_MCP_INPUT_MAX_ENTRIES,
  PENDING_MCP_INPUT_TTL_MS,
  claimMcpInputFromResults,
  extractMcpInputPrompt,
  formatMcpInputReply,
  isOwnMintedSentinel,
  mcpInputMalformedError,
  mcpInputReplayCappedError,
  mcpInputRequiredSentinel,
  mcpInputUnsupportedError,
  mcpInputReplyLabel,
  parseMcpInputReply,
  parseMcpInputRequests,
  parseMcpInputSentinel,
  resetSharedMcpInputWiring,
  setSharedMcpInputReplayer,
  sharedMcpInputReplayer,
  sharedPendingMcpInputStore,
} from './mcp/pendingMcpInput.js';
export type {
  InMemoryPendingMcpInputStoreOptions,
  McpInputField,
  McpInputParseFailure,
  McpInputParseOutcome,
  McpInputReplayer,
  McpInputReply,
  McpInputSentinelMint,
  PendingMcpInput,
  PendingMcpInputKey,
  PendingMcpInputOwner,
  PendingMcpInputStore,
  PutPendingMcpInputResult,
} from './mcp/pendingMcpInput.js';
export {
  buildSubAgentDomainTools,
  mcpToolNameFromRef,
  subAgentToolName,
} from './registry/subAgentTools.js';
export type {
  SubAgentGraph,
  SubAgentToolDeps,
} from './registry/subAgentTools.js';
// #904 — the scoped `memory` tool a granted sub-agent gets, and the tool name
// both the orchestrator's dispatch and the grant adapter key on.
export {
  createScopedMemorySubAgentTool,
  MEMORY_TOOL_NAME,
  SUB_AGENT_MEMORY_UNBOUND_ERROR,
} from './registry/subAgentMemoryTool.js';
export type { SubAgentMemoryResolver } from './registry/subAgentMemoryTool.js';
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
export {
  Orchestrator,
  parseToolEmittedChoice,
  // W3-A — the outer half of the timeout hierarchy; see the ORDERING INVARIANT
  // block next to `DEFAULT_TOOL_DISPATCH_TIMEOUT_MS`.
  resolveToolDispatchTimeoutMs,
  // …and its production enforcement. Call at boot: a deployment whose timeout
  // knobs invert the hierarchy must not start quietly.
  assertTimeoutHierarchy,
} from './orchestrator.js';
export type { OrchestratorOptions, AiDisclosureSetup } from './orchestrator.js';

// #579 — org security postures + provenance-labelled inbound screening. The
// screener backends + per-turn outcome resolution; the shared primitives live
// in `@omadia/channel-sdk`.
export {
  type ScreenOutcomeKind,
  type SecurityScreenMetrics,
  UNSCREENABLE_STREAK_ALERT,
  getSecurityScreenMetrics,
  recordScreenOutcome,
  resetSecurityScreenMetrics,
} from './securityScreenMetrics.js';

export {
  type ScreenFailureCause,
  ScreenerFailure,
  screenFailureCause,
  LlmScreener,
  HttpProxyScreener,
  screenProvenance,
  resolveEffectivePosture,
  parseVerdict,
  chunkString,
} from './securityScreener.js';
export type {
  SecurityScreener,
  SecurityVerdict,
  SecurityScreenMode,
  SecurityPostureSetup,
  ScreenOutcome,
  SecurityAuditEvent,
  FetchLike,
} from './securityScreener.js';

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
  ToolDispatchContentOrigin,
  ToolDispatchResult,
  ToolDispatchCallerContext,
  ToolDispatchOptions,
} from './toolDispatchService.js';
export {
  ToolIdempotencyStore,
  currentIdempotencyScope,
  runWithIdempotencyScope,
  fingerprintToolInput,
  idempotencyCacheKey,
  idempotencyConflictMessage,
  DEFAULT_IDEMPOTENCY_TTL_MS,
  DEFAULT_IDEMPOTENCY_MAX_ENTRIES,
} from './toolIdempotency.js';
export type {
  ToolIdempotencyScope,
  ToolIdempotencyResult,
  ToolIdempotencyOutcome,
} from './toolIdempotency.js';
export {
  currentDispatchCaller,
  runWithDispatchCaller,
} from './toolCallerContext.js';
// W2-3 (#542) — the public MCP endpoint dispatches OUTSIDE any turn, so it must
// build and supply a privacy handle explicitly (the ambient `turnContext`
// fallback is `undefined` there). It also needs the intern-exemption allowlist:
// an exempt tool's result is handed over IN CLEAR by design, which is correct
// for the agent's own infra tools inside a turn and unacceptable for an
// internet-facing caller — so the endpoint refuses to serve those names at all.
export { createPrivacyTurnHandle } from './privacyHandle.js';
export type { PrivacyTurnHandle } from './privacyHandle.js';
export { INTERN_EXEMPT_TOOLS, isInternExemptTool } from './privacyInternPolicy.js';
export { LoopbackMcpServer } from './loopbackMcpServer.js';
export type {
  LoopbackMcpServerDeps,
  LoopbackMcpServerHandle,
} from './loopbackMcpServer.js';
export { CLI_ENV_SCRUB_KEYS, CliChatAgent, StreamJsonParser } from './cliChatAgent.js';
// #1007 — the CLI spawn gate, shared with `platform/claudeCliAdapter.ts`.
export {
  CLI_BUILTIN_TOOL_DENYLIST,
  CLI_ENV_ALLOWLIST_KEYS,
  OMADIA_MCP_TOOL_PREFIX,
  buildCliToolGateArgv,
  buildCompletionCliArgv,
  buildGatedCliEnv,
  cliEnvAllowlistFor,
} from './cliSpawnGate.js';
export type { CliToolGateOptions, CompletionCliArgvOptions } from './cliSpawnGate.js';
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

// #648 — resolved AI-Act marking posture, published to the ServiceRegistry and
// projected onto `/health` + the operator dashboard.
export {
  AI_DISCLOSURE_CHANNEL_KINDS,
  AI_DISCLOSURE_POSTURE_SERVICE,
  describeAiDisclosurePosture,
  formatDisclosureBootWarning,
  resolveDisclosureLevelForChannel,
} from './aiDisclosurePosture.js';
export type {
  AiDisclosureChannelKind,
  AiDisclosurePosture,
  ChannelPosture,
} from './aiDisclosurePosture.js';

// Session logger + chat-session store
export { SessionLogger, graphScopeFor } from './sessionLogger.js';
export type { SessionLogEntry } from './sessionLogger.js';

// #684 — run-trace outcome tallies. Exported so an operator surface can read
// how often the trace was dropped without SessionLogger growing a reporting
// responsibility of its own.
export {
  RunTraceOutcomeStats,
  recordRunTraceOutcome,
  RUN_TRACE_RECORDED,
} from './runTraceObservability.js';
export type {
  RunTraceOutcome,
  RunTraceOutcomeCounts,
} from './runTraceObservability.js';
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
  // Teardown failures are reported, never thrown — see `runGeneratorInContext`.
  onTurnTeardownError,
} from './turnContext.js';
export type {
  SubAgentMemoryHandler,
  TurnContextValue,
} from './turnContext.js';
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
// #584 WS I — batch ingestion of recorded audio via transcription@1.
export {
  TRANSCRIBE_RECORDING_TOOL_NAME,
  TranscribeRecordingTool,
  transcribeRecordingToolSpec,
} from './tools/transcribeRecordingTool.js';
export type { TranscribeRecordingToolDeps } from './tools/transcribeRecordingTool.js';
export { createAttachmentReader } from './attachmentReaderFactory.js';
export type { AttachmentByteStore } from './attachmentReaderFactory.js';
// #575 — the handle→room binding contract. Exported so the kernel can supply a
// Postgres implementation; the enforcement itself stays inside the reader
// wrapper, where every resolution path is covered by construction.
export {
  bindingForRawScope,
  bindingForScope,
  bindingsEqual,
} from './attachmentBinding.js';
export type {
  AttachmentBindingStore,
  AttachmentScopeBinding,
} from './attachmentBinding.js';
export {
  QUERY_DATASET_TOOL_NAME,
  QueryDatasetTool,
  queryDatasetToolSpec,
} from './tools/queryDatasetTool.js';
export {
  isCsvAttachment,
  isTabularAttachment,
  detectTabularFormat,
} from './attachmentExtract.js';
export type { TabularFormat } from './attachmentExtract.js';
export {
  buildDatasetFromCsv,
  buildDatasetFromTable,
  importCsvDataset,
  parseCsv,
  MAX_CELL_CHARS,
  MAX_DATASET_ROWS,
} from './datasetImport.js';
export {
  parseXlsx,
  parseXlsxFirstSheet,
  cellToString,
  MAX_SHEETS,
  MAX_XLSX_BYTES,
} from './datasetImportXlsx.js';
export type { XlsxParseResult, XlsxSheetParse } from './datasetImportXlsx.js';
export { importTabularDataset } from './datasetImportTabular.js';
export type {
  ImportTabularDatasetInput,
  ImportTabularDatasetResult,
  ImportedTable,
} from './datasetImportTabular.js';
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
// Deferred sub-agent dispatch is the in-package implementor
// (`tasks/subAgentTaskTool.ts`); consumers supply their own `TaskStore`.
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
  // W4 — a terminal outcome a runner produced but could not record, because the
  // reaper had already written its own row. The only place it survives.
  TaskOutcomeLostRecord,
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
  DEFAULT_TASK_RESUME_INTERVAL_MS,
  DEFAULT_TASK_RESUME_MAX_PER_SWEEP,
  runTaskResumeOnce,
  startTaskResumeDriver,
} from './tasks/taskResumeDriver.js';
export type {
  ResumableTaskSource,
  TaskResumeDriverOptions,
} from './tasks/taskResumeDriver.js';
export {
  SUB_AGENT_TASK_KIND_PREFIX,
  createLongRunningSubAgentTool,
} from './tasks/subAgentTaskTool.js';
export type { LongRunningSubAgentToolOptions } from './tasks/subAgentTaskTool.js';
