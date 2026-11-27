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
export { activate, DEFAULT_MAX_TOKENS } from './plugin.js';
export { HUMAN_NAMES_SERVICE } from './plugin.js';
export type {
  ChatAgentBundle,
  HumanNamesProvider,
  OrchestratorPluginHandle,
} from './plugin.js';

// Per-turn Sonnet/Opus routing config (attached to AgentRuntimeConfig).
export { routeTurnModel } from './modelRouter.js';
export type {
  ModelRoutingConfig,
  RouteResult,
  RoutingBucket,
} from './modelRouter.js';

// #2051 — per-turn working-mode selection (twin of modelRouter); the mode is
// composed beneath the agent's identity, never in its place.
export { routeTurnWorkingMode, withWorkingMode } from './workingModes.js';
export type {
  SelectedWorkingMode,
  WorkingModeBucket,
  WorkingModeCandidate,
  WorkingModeRouteResult,
} from './workingModes.js';
// #2060 — a working mode never replaces who speaks (spec 2043 §2.3).
export { findWorkingModeIdentityReplacement } from './workingModeIdentity.js';
export type { WorkingModeIdentityFinding, WorkingModeText } from './workingModeIdentity.js';

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
export { ReloadBus, directDatabaseUrl, isPooledDatabaseUrl } from './registry/reloadBus.js';
export type { ReloadBusOptions } from './registry/reloadBus.js';
// US7 — channel routing.
export { ChannelResolver } from './routing/channelResolver.js';
export type {
  ChannelResolverOptions,
  ResolveContext,
  SystemNoticeRequest,
  ResolveDecision,
  ResolveResult,
} from './routing/channelResolver.js';
// #2055 — the management layer: deterministic routing, routing tables,
// plain-text agent selection, system notices.
export {
  ADDRESSABLE_STATUS,
  ManagementRouter,
  defaultEntryFor,
  setRoleMembership,
} from './routing/managementRouter.js';
export type {
  RoleMembership,
  RouteMatch,
  RouteOutcome,
  RouteRequest,
  RoutingAgentRecord,
  RoutingView,
} from './routing/managementRouter.js';
export { RoutingTables } from './registry/routingTables.js';
export type {
  AgentSelectionRow,
  AvailabilityPrincipalRow,
  DefaultAgentEntryInput,
  DefaultAgentEntryRow,
} from './registry/routingTables.js';
export { SnapshotRoutingView } from './registry/routingView.js';
export { KernelAgentSelectionService } from './management/agentSelection.js';
export { buildSystemNotice, noticeLocale, systemEmission } from './management/systemNotices.js';
export { agentAvatarUrl, speakerFor } from './management/speakerFor.js';
export { emitterOf, speakerOf, stampAnswer, stampEvent, withSpeaker } from './management/speakingChatAgent.js';
export { AgentAnswerEmitter, TemplateRegistry } from './management/answerEmitter.js';
export type { TemplateValueType } from './management/answerEmitter.js';
export {
  DEFAULT_AGENT_IDENTITY,
  identityRules,
  withIdentityRules,
} from './management/agentIdentityPrompt.js';
export { IdentityGuard, SentenceGate, IDENTITY_GUARD_JUDGE_TIMEOUT_MS } from './identityGuard/guard.js';
export type { IdentityGuardResult, IdentityJudge } from './identityGuard/guard.js';
export { checkIdentityDeterministic } from './identityGuard/deterministic.js';
export type { GuardDirectoryEntry } from './identityGuard/deterministic.js';
export { maskRestoredValues, withIdentityGuard } from './identityGuard/guardedChatAgent.js';
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
  membersIndexRoot,
  membersTierRoot,
  orchestratorMemoryScope,
} from './registry/scopedMemoryStore.js';
// W3 — `members` notes: one tier per owner set, recorded in an index.
export {
  MEMBERS_SHARED_SEGMENT_PREFIX,
  MembersIndex,
  membersTierKey,
} from './membersMemory.js';
export type { MembersIndexEntry } from './membersMemory.js';
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
// #2088 — tombstones: a deleted agent's row stays; readers say what they mean.
export { liveAgentRow, ofLiveAgent, tombstoneSlug } from './registry/tombstones.js';
export type { AgentTombstone } from './registry/tombstones.js';
// #2088 — archetypes: the registry and the one question call sites ask.
export {
  ARCHETYPE_ADDITIONS,
  ARCHETYPE_AGENT_SETTING_TYPES,
  ARCHETYPE_OMISSIONS,
  ARCHETYPE_REQUIREMENTS,
  ArchetypeOmissionError,
  FACILITATOR_ARCHETYPE,
  STANDARD_ARCHETYPE,
  archetypeAdds,
  archetypeOf,
  archetypeOmits,
  archetypeRequires,
  assertArchetypeAllows,
  effectiveArchetypeAgentSettings,
  getArchetype,
  isArchetype,
  isArchetypeId,
  listArchetypes,
  parseArchetype,
  registerArchetype,
  validateArchetypeAgentSettings,
} from './registry/archetype.js';
export type {
  ArchetypeAddition,
  ArchetypeAgentSetting,
  ArchetypeAgentSettingIssue,
  ArchetypeAgentSettingOption,
  ArchetypeAgentSettingType,
  ArchetypeAgentSettingValue,
  ArchetypeBearer,
  ArchetypeDescriptor,
  ArchetypeRequirement,
  ArchetypeText,
  ArchetypeId,
  ArchetypeOmission,
} from './registry/archetype.js';
// #2043 — kernel-side seams of the facilitator runtime. `runAsEngineTurn` is
// for the kernel's `agentTurn` service only; it is not a plugin surface.
export { channelConversationId, conversationIdCandidates } from './channelConversationId.js';
export {
  currentEngineTurn,
  facilitationNotSetUpText,
  facilitatorRefusalText,
  isGroupTurn,
  runAsEngineTurn,
  wrapFacilitatorAgent,
} from './facilitatorAgent.js';
export type {
  EngineDrivenConversationLookup,
  EngineTurnScope,
  FacilitatorRuntimeLookup,
  OwnPostCountLookup,
  PrivateTurnLookup,
  AddressedTurnLookup,
} from './facilitatorAgent.js';
export { conversationPrincipal } from './conversationPrincipal.js';
export {
  buildToolCallContext,
  currentToolCallContext,
  runWithToolCallContext,
} from './toolCallContext.js';
export {
  FACILITATOR_NEUTRALITY_BLOCK,
  FACILITATOR_NEUTRALITY_HEADING,
  applyArchetypeContract,
  roleContractOf,
  withFacilitatorNeutrality,
} from './registry/facilitatorNeutrality.js';
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
  DEFAULT_MODEL_POLICY,
  describeModelPolicyRuntime,
  isModelRef,
  MODEL_POLICY_TOOL_INCOMPATIBLE,
  ModelPolicyRefusedError,
  parseModelPolicy,
  parseModelRef,
  resolveModelPolicyRuntime,
  sameRef,
  validateModelPolicy,
} from './registry/modelPolicy.js';
export type {
  ModelPolicyReadout,
  ModelPolicyReadoutContext,
  ModelPolicyValidation,
  ModelPolicyValidationContext,
  ResolvedModelPolicy,
} from './registry/modelPolicy.js';
export {
  AGENT_CONFIG_RESOURCES,
  AGENT_SLUG_RE,
  AgentConfigRevisionConflictError,
  ConfigStore,
  ConfigValidationError,
  validateModelRef,
  validateModelRoutingShape,
} from './registry/configStore.js';
export type {
  AgentConfigResource,
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
  McpOAuthTokenInvalidReason,
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
  mcpNativeToolNameCollision,
  MCP_NATIVE_TOOL_NAME_PATTERN,
  // Exported so the no-collateral-invalidation rule of `McpManager.close(id)`
  // can be unit tested and reused by ops tooling (issue #563).
  mcpPoolScopeMatches,
  // The Discover route needs the same reading of a failed connect as a tool call.
  looksUnauthorized,
  // #1923 — the narrower reading: did the transport itself refuse the token.
  isTransportUnauthorized,
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
  mcpOutcomeUnknownError,
  mcpAuthUnattendedError,
  mcpInputUnattendedError,
  auditCaller,
} from './mcp/mcpClient.js';
export { captureMcpStructured } from './mcp/mcpStructuredCapture.js';
// #2306 / ADR-0270 — stdio MCP children: scrubbed env, optional own OS user.
export {
  MCP_STDIO_CHILD_SHIM,
  MCP_STDIO_LOCALE_ENV_KEYS,
  MCP_STDIO_RUN_AS_PATTERN,
  MCP_STDIO_SUDO_COMMAND,
  stdioCacheKey,
  stdioChildEnv,
  stdioLaunch,
  stdioRunAsPrefix,
} from './mcp/stdioIsolation.js';
export type { McpStdioIsolation, McpStdioLaunch } from './mcp/stdioIsolation.js';
export type {
  DeprecatedMcpTransport,
  McpAuthProvider,
  McpCallerKind,
  McpCallGuard,
  McpCallLogEntry,
  McpCallObserver,
  McpCallOutcome,
  McpCallOptions,
  McpCallResult,
  McpCallStatus,
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
// #2050 — DB sub-agents as the agent's internal helpers: shared write-time and
// runtime rules (names, model policy, capability subset).
export {
  HelperRefusalError,
  INTERNAL_HELPER_CONTRACT,
  assertHelperModelAllowed,
  assertHelperNameFree,
  helperDefaultModelRef,
  helperModelVerdict,
  helperToolName,
  helperToolNameConflicts,
  helpersOutOfService,
  mcpGrantHeldBy,
} from './registry/internalHelpers.js';
export type {
  GrantLike,
  HelperModelVerdict,
  HelperOutOfService,
  HelperNameConflict,
  HelperRefusalCode,
  NamedHelper,
} from './registry/internalHelpers.js';
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
  resolveConfiguredModel,
  resolveModelIdForProvider,
} from './registry/agentRuntime.js';
export type { ResolvedAgentRuntime } from './registry/agentRuntime.js';

// Per-Agent Orchestrator factory (US3) — re-exported so US4-style external
// callers (CLI, tests) can build Orchestrators without going through the
// plugin's activate path.
export { buildOrchestratorForAgent, rosterAgentNames } from './buildOrchestrator.js';
export {
  CLAUDE_PERSONA_TIERS,
  VENDOR_PERSONA_FAMILIES,
  UNKNOWN_PERSONA_FAMILY,
  inferPersonaFamily,
} from './personaFamily.js';
export type {
  ClaudePersonaTier,
  PersonaModelFamily,
  VendorPersonaFamily,
} from './personaFamily.js';
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
  // `stop_reason: "refusal"` → explicit notice instead of an empty answer.
  MODEL_REFUSAL_NOTICE,
  localizeRefusalNotice,
  finalAnswerText,
  // #2241 — the prompt-mask refusal delivered as answer text.
  isPromptMaskBlockedNotice,
} from './orchestrator.js';
// #1500 — answer text across tool-loop iterations, preamble dropped.
export { AnswerTextAccumulator } from './answerTextAccumulator.js';
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
export { subAgentEffortFor, type SubAgentEffortFor } from './subAgentEffort.js';
// #1219 — a declined sub-agent run, and the parent-facing notice for it.
export { SubAgentRefusalError, subAgentRefusalNotice } from './subAgentRefusal.js';
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
  ToolReplayAbortError,
  ToolReplayLedger,
  replayMissNotice,
  runDetachedFromRequestLedger,
} from './toolReplayLedger.js';
export type {
  ToolReplayDecision,
  ToolReplayRecord,
  ToolReplaySeam,
} from './toolReplayLedger.js';
export { RequestReceipts, mergePrivacyReceipts } from './requestReceipts.js';
export { RequestTurnRecord } from './requestTurnRecord.js';
export type {
  CommittedTurn,
  RequestAfterTurn,
  TurnRecordDraft,
  WrittenTurn,
} from './requestTurnRecord.js';
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
export type { PrivacyTurnHandle, PromptMaskOptions } from './privacyHandle.js';
// Verifier privacy hand-over: the continuation a held turn hands to the
// answer-verifier wrapper (see privacyEgress.ts).
export type { PrivacyEgressContinuation } from './privacyEgress.js';
export {
  INTERN_EXEMPT_OPERATIONS,
  INTERN_EXEMPT_TOOLS,
  INTERN_FIELD_EXEMPT_TOOLS,
  PROMPT_MASKED_UPLOAD_TOOLS,
  fieldExemptModelCopy,
  hasInternFieldExemption,
  isInternExemptCall,
  isInternExemptTool,
  isPromptMaskedUploadCall,
  runsOnModelInput,
} from './privacyInternPolicy.js';
// Tool errors on their way to a model: the one helper every dispatch seam
// routes a thrown exception or a returned `Error:` text through. The MCP
// connect prompt passes on per-dispatch provenance (`McpAuthPromptMint`).
export { McpAuthPromptMint, runWithMcpAuthPromptMint } from './mcp/mcpAuthPromptMint.js';
export {
  MAX_REDACTABLE_TOOL_ERROR_CHARS,
  guardControlFlowResult,
  isGuardedControlFlowResult,
  looksExceptionShaped,
  returnedToolErrorWithheldNotice,
  thrownToolErrorForModel,
  toolErrorRef,
  withholdThrownToolError,
} from './toolErrorRedaction.js';
export type {
  ThrownToolErrorOutcome,
  ToolErrorWithholdReason,
} from './toolErrorRedaction.js';
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
  // OM-85 — version-gated `--restricted` and the "CLI too old" classification.
  CLI_RESTRICTED_ENV_KEY,
  CliIncompatibleError,
  RESTRICTED_FLAG_MIN_CLI_VERSION,
  classifyUnknownOptionFailure,
  clearCliVersionCache,
  parseCliVersion,
  resolveCliVersion,
  supportsRestrictedFlag,
} from './cliSpawnGate.js';
export type {
  CliToolGateOptions,
  CliVersionExec,
  CompletionCliArgvOptions,
} from './cliSpawnGate.js';
// Spec 2042 §5.10 — every agent's chat agent runs its turns as the model
// gateway's agent-turn context.
export { innerChatAgent, withAgentTurnExecution } from './agentTurnExecution.js';
// Spec 2042 §5.10 — the isolated profile of every CLI spawn.
export {
  CLI_PROFILE_INSTRUCTION_FILES,
  CliProfileNotCleanError,
  applyCliProfile,
  assertCliProfileClean,
  cliProfileDir,
  cliProfileInstructionFiles,
  decideCliProfile,
  setCliProfileDir,
  type CliProfileDecision,
  type CliProfileMode,
} from './cliProfile.js';
export type {
  CliChatAgentDeps,
  CliChatHooks,
  CliSpawnLogger,
  CliUsage,
} from './cliChatAgent.js';
export { resolveCliSpawnTimeoutMs, CLI_SPAWN_TIMEOUT_ENV_KEY } from './cliChatAgent.js';
/** #2241 — a CLI privacy refusal delivered as answer text. */
export { isCliPrivacyRefusal } from './cliChatAgent.js';
export type {
  CliTurnPrivacy,
  CliReleasedAnswer,
  CliPrivacyReceiptFields,
} from './cliTurnPrivacy.js';
/** #1085 — the binary name the kernel's `resolveCliBin` is asked to resolve. */
export { DEFAULT_CLI_BINARY } from './cliChatAgent.js';
export { createCliSubAgent } from './cliSubAgent.js';
export type { CliSubAgentOptions } from './cliSubAgent.js';

// Knowledge-graph native tool (moved from harness-knowledge-graph in S+12.5-1)
export {
  KnowledgeGraphTool,
  KNOWLEDGE_GRAPH_TOOL_NAME,
  knowledgeGraphToolSpec,
} from './knowledgeGraphTool.js';
export {
  boundKgWalk,
  currentGraphNodeViewer,
  graphNodeFilter,
  graphSessionAccess,
  type GraphNodeViewer,
} from './graphNodeAccess.js';
export { WEB_ACCOUNT_CHANNEL_TYPE, isWebAccountTurn, webAccountOrigin } from './webAccountOrigin.js';
export {
  currentProcessBoundary,
  currentProcessReadFilter,
  creatorOfCurrentTurn,
  processWriteScope,
  type ProcessBoundary,
} from './tools/processMemoryTool.js';

// Native-tool registry — kernel-shared dispatch table
export { NativeToolRegistry, isOfferedThisTurn } from './nativeToolRegistry.js';
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
export {
  ANSWER_VERBOSITY_LEVELS,
  DEFAULT_ANSWER_VERBOSITY,
  buildAnswerVerbosityBlock,
  buildAnswerVerbosityTurnBlock,
  parseAnswerVerbosity,
} from './answerVerbosity.js';
export type { AnswerVerbosity } from './answerVerbosity.js';
export {
  ANSWER_LANGUAGES,
  DEFAULT_ANSWER_LANGUAGE,
  buildAnswerLanguageRule,
  detectAnswerLocale,
  parseAnswerLanguage,
  type AnswerLanguage,
} from './answerLanguage.js';

// Session logger + chat-session store
export {
  SessionLogger,
  graphScopeFor,
  graphScopeKeysFor,
  isChatSessionScope,
  sessionTranscriptDir,
} from './sessionLogger.js';
export type { SessionLogEntry } from './sessionLogger.js';

// #684 — run-trace outcome tallies. Exported so an operator surface can read
// how often the trace was dropped without SessionLogger growing a reporting
// responsibility of its own.
export {
  RunTraceOutcomeStats,
  recordRunTraceOutcome,
  RUN_TRACE_RECORDED,
  RUN_TRACE_STATS_SERVICE,
} from './runTraceObservability.js';
export type {
  RunTraceOutcome,
  RunTraceOutcomeCounts,
} from './runTraceObservability.js';
export {
  ChatSessionNotOwnedError,
  ChatSessionStore,
  InvalidSessionIdError,
  chatSessionOwnedBy,
  chatSessionOwner,
  ServerMirroredSessionError,
  isServerMirroredSession,
  isWebChatSessionId,
  isValidSessionId,
  scrubMcpInputEnvelopes,
} from './chatSessionStore.js';
export type {
  ChatSubAgentEvent,
  ChatToolEvent,
  ChatMessage,
  ChatProactiveMarker,
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
  GraphReadScope,
} from './turnContext.js';
// #2085 — a data action run on the agent's behalf passes the same audience
// floor as a tool the model dispatches.
export { guardToolEgress } from './audienceFloorGuard.js';
// #2085 — the agent's boundary check of a data plan (spec 2042 §5.13 1a).
export { createDataPlanGuard, createLlmDataPlanJudge, type DataPlanJudge } from './dataPlanGuard.js';
// #2085 — per-turn side-channel data collector (spec 2042 §5.13).
export {
  MAX_DATA_PAYLOADS_PER_TURN,
  TurnDataCollector,
  type CollectOutcome,
} from './turnDataCollector.js';
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
  ChatPeerAgentsProvider,
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
  MAX_RECORDING_BYTES,
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
// #2048 — the audience floor on by default: the member baseline every resolved
// person holds, and the room classification the per-turn provider uses.
export {
  MEMBER_BASELINE_CAPABILITIES,
  MemberBaselineGrantStore,
} from './memberBaselineGrantStore.js';
export { CHANNEL_KIND_BY_ORIGIN, turnChannelKind } from './resolveTurnOwnerIdentity.js';
export {
  audienceRoomFor,
  chatParticipantsFromRoster,
  createAudienceFloorProvider,
  type AudienceRoom,
} from './audienceFloorProvider.js';
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
export type { BuildDatasetOptions, LinkKeyReport } from './datasetImport.js';
export {
  createDatasetLinkKeyer,
  isLinkKeyColumn,
  linkKeyColumnName,
  normalizeLinkValue,
  resolveDatasetLinkKeySecret,
  setDatasetVaultKeyFallback,
  LINK_KEY_COLUMN_PREFIX,
  LINK_KEY_LENGTH,
  LINK_KEY_SECRET_ENV,
} from './datasetLinkKey.js';
export type { DatasetLinkKeyer } from './datasetLinkKey.js';
export {
  decryptCell,
  decryptRows,
  encryptCell,
  isEncryptedCell,
  resolveDatasetCellKey,
  ENCRYPTED_CELL_PREFIX,
  UNAVAILABLE_CELL,
} from './datasetCellCrypto.js';
export type { DatasetCellKey } from './datasetCellCrypto.js';
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
  SubAgentToolHandle,
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
  TASK_CONTEXT_KEY,
  TASK_LEASE_UUID_RE,
  carryTaskContext,
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
export {
  createScopedChatAgent,
  NO_ORCHESTRATOR_MESSAGE,
  resolveScopedBundle,
} from './scopedChatAgent.js';
export type { ScopedRegistryView } from './scopedChatAgent.js';

// Spec 2042 §5.11 (#2079) — discretion: labels, flow rule, disclosure levels.
export * from './discretion/labels.js';
export * from './discretion/flowRule.js';
export * from './discretion/disclosure.js';
export * from './discretion/port.js';
export * from './discretion/turnLabels.js';
export * from './discretion/turnSetup.js';
export * from './discretion/seededTurn.js';
export * from './discretion/fieldRights.js';
export * from './privacyAudience.js';
// Spec 2042 §5.4 (#2047) — consultation instead of delegation.
export * from './consultation/consultationScope.js';
export * from './consultation/consultTool.js';
export * from './discretion/toolFlow.js';
export * from './discretion/labelledProcessMemory.js';
export * from './discretion/bulkPromotionGate.js';
// #1881 — a deleted agent's memory moves with its discretion labels.
export { LabelledMemoryStore } from './discretion/labelledMemoryStore.js';

// #1983 / #1987 — stored form of transcript entries (marker + chunking).
export {
  RECORDING_TRANSCRIPT_MARKER,
  TRANSCRIPT_CHUNK_CHARS,
  chunkTranscriptText,
  markRecordingText,
  replayUserLine,
} from './recordingTranscript.js';

// #1976 — is this turn one that can carry an upload (channel turn)?
export { turnMayCarryUploads } from './attachmentToolAvailability.js';
export { wrapChatAgentWithConversationContext } from './conversationContextAgent.js';
export type { ConversationContextLookup } from './conversationContextAgent.js';
