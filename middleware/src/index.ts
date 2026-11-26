import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createAnthropicClient,
  createAnthropicProvider,
  registerAnthropicAdapter,
  type AnthropicClient,
} from '@omadia/llm-adapter-anthropic';
import { registerOpenAiAdapter } from '@omadia/llm-adapter-openai';
import { registerOpenAiResponsesAdapter } from '@omadia/llm-adapter-openai-responses';
import {
  defaultLlmAdapters,
  listModels,
  LlmProviderCatalog,
  createLlmProviderPool,
  readProviderApiKey,
  resolveModelRef,
  readProviderOAuthTokens,
  readProviderOAuthUpdatedAt,
  registerProviderOAuthStoreBinding,
  resolveLlmProvider,
  writeProviderOAuthTokens,
  type OAuthTokens,
} from '@omadia/llm-provider';
import express from 'express';
import type { RequestHandler } from 'express';
import cookieParser from 'cookie-parser';
import { config, registrySeedFromEnv } from './config.js';
import { LLM_SETUP_HINT } from './llmSetupHint.js';
import { attachmentStoreHealth, selectAttachmentStore } from './platform/attachmentStore.js';
import type { MemoryStore } from '@omadia/plugin-api';
import type { AttachmentBindingStore } from '@omadia/orchestrator';
import { ADMIN_TOKEN_PATH, mountAdminTokenSurface } from './routes/adminTokenMount.js';
import { adminTokenThrottleWarnings, createAdminTokenThrottle } from './routes/adminTokenThrottle.js';
import { parseClientAddressPolicy } from './auth/clientAddress.js';
import { createMemoryPurgeRouter } from './routes/memoryPurge.js';
import { createMemoryOwnerlessRouter } from './routes/memoryOwnerless.js';
import { runDurableRulesSync } from './services/durableRulesSync.js';
import { createMemoryPromoteRouter } from './routes/memoryPromote.js';
import { createAdminUpdateRouter } from './routes/adminUpdate.js';
import { createUpdateAuditStore } from './update/auditStore.js';
import { createReleaseLookup } from './update/releaseLookup.js';
import { createUpdaterClient } from './update/updaterClient.js';
import { resolvePlatform } from './update/platform.js';
import { resolveAppVersion } from './update/version.js';
import { createMemoryBackendRouter } from './routes/memoryBackend.js';
import {
  createChatRouter,
  WEB_CHANNEL_TYPE,
  type WebRouteRequest,
  type WebRouteResult,
} from './routes/chat.js';
import { createOperatorAgentChannelIdentitiesRouter } from './routes/operatorAgentChannelIdentities.js';
import { createAgentChannelIdentityStore } from './platform/agentChannelIdentityStore.js';
import {
  createAgentChannelIdentityService,
  type AgentChannelIdentityService,
} from './platform/agentChannelIdentityService.js';
import {
  createOperatorAgentsRouter,
  type OperatorAgentIdentityStore,
  type OperatorTeamsIdentityDeps,
  type OperatorTeamsIdentityStore,
  type OperatorTeamsEventStore,
  type OperatorTeamsInstallStore,
  type OperatorTeamsProvisioningRunner,
} from './routes/operatorAgents.js';
import { AgentTeamsIdentityStore } from './platform/agentTeamsIdentityStore.js';
import { AgentIdentityStore } from './platform/agentIdentityStore.js';
import { recomposeStaleIdentities } from './services/agentIdentityPrompt.js';
import { AgentTeamsInstallStore } from './platform/agentTeamsInstallStore.js';
import { TeamsProvisioningEventStore } from './platform/teamsProvisioningEventStore.js';
import { TeamsDelegatedTokenStore } from './platform/teamsDelegatedTokenStore.js';
import type { DelegatedTokenSet } from './platform/teamsDelegatedSignIn.js';
import type { TeamsResetEventSink } from './services/teamsIdentityReset.js';
import { TeamsDelegatedSignInService } from './services/teamsDelegatedSignInService.js';
import { createOperatorTeamsSignInRouter } from './routes/operatorTeamsSignIn.js';
import { TeamsProvisioningJobRunner } from './services/teamsProvisioningJob.js';
import {
  dropTeamsBotConfig,
  syncTeamsBotConfig,
} from './services/teamsBotsConfigSync.js';
import {
  buildTeamsBotMessagingEndpoint,
  getTeamsProvisioner,
  requireTeamsProvisioner,
  supportsTeamLookup,
  TeamsProvisionerUnavailableError,
} from './platform/teamsProvisionerService.js';
import {
  CHANNEL_TEAMS_PLUGIN_ID,
  createTeamsAppPackageAssetLoader,
} from './services/teamsAppPackageAssets.js';
import { createBotPresenceStore } from './conductor/botPresenceStore.js';
import { defaultChannelBotKeyFrom } from './conductor/channelBotOwnership.js';
import { createChatPeerAgentsProvider, createPeerGate } from './conductor/peerPolicy.js';
import { wireConductor, AwaitNotFoundError, AwaitNotPendingError, AwaitResponderNotHolderError, ConductorRoleStore, ConductorEphemeralAttachmentsStore, ambientTurnFrom, createDiscussionsCapability, bindEphemeralRunsToCaller } from './conductor/index.js';
import { createMissReportRoutes } from './privacy/missReportRoutes.js';
import { readNonPersonalFieldsConfig } from './privacy/fieldClassification/guardConfig.js';
import {
  createFieldClassificationScheduler,
  recomputeFieldClassification,
} from './privacy/fieldClassification/recompute.js';
import { createFieldClassificationRoutes } from './privacy/fieldClassification/routes.js';
import { createNonPersonalFieldsEditor } from './privacy/fieldClassification/configEditor.js';
import { PgFieldClassificationStore } from './privacy/fieldClassification/store.js';
import {
  BATCH_JOB_REGISTRY_SERVICE,
  MAINTENANCE_RUN_SERVICE_NAME,
  MODEL_PASSTHROUGH_SERVICE_NAME,
  AGENT_DIRECTORY_SERVICE_NAME,
  AGENT_NAMES_SERVICE_NAME,
  AGENT_ENVELOPE_SERVICE_NAME,
  OPERATOR_JOBS_SERVICE_NAME,
  TRANSCRIPTION_SERVICE_NAME,
  TURN_RECEIPT_STORE_SERVICE_NAME,
  nativeToolDispatchText,
  perCallerService,
  type AgentNamesProvider,
  type MaintenanceRunService,
} from '@omadia/plugin-api';
import { createModelPassthrough, systemModuleOnlyService } from './platform/modelPassthrough.js';
import { archetypeProcessesServiceName, SYSTEM_SPEAKER, type ArchetypeProcessesService } from '@omadia/plugin-api';
import type { ProcessMemoryService, TranscriptionService } from '@omadia/plugin-api';
import { PgTurnReceiptStore, startTurnReceiptReaper } from './receipts/store.js';
import { createReceiptRoutes } from './receipts/routes.js';
import { ChainWitness } from './receipts/anchor.js';
import { loadCheckpointSigner, startCheckpointWorker } from './receipts/checkpoints.js';
import { createProvenanceRoutes } from './receipts/verifyRoutes.js';
import { bindingKeyForTurn } from './conductor/principalId.js';
import { createOperatorChannelsRouter } from './routes/operatorChannels.js';
import {
  createAgentDirectoryRouter,
  createOperatorDefaultAgentsRouter,
} from './routes/managementLayer.js';
import { createOperatorMemoryContextsRouter } from './routes/operatorMemoryContexts.js';
import { createMemberNameResolver } from './services/memberNames.js';
import { createAgentBuilderRouter } from './routes/agentBuilder.js';
import {
  isMcpGrantBlocked,
  mcpDispatchDenial,
  refreshMcpGrantPolicy,
} from './services/mcpGrantPolicy.js';
import { rescanAllMcpServers } from './services/mcpRescan.js';
import { createMcpConnectGuard } from './services/mcpOutboundHostGuard.js';
import { createLlmVerifier, type LlmVerifier } from './services/skillVerdictLlmVerifier.js';
import { HttpSkillSpectorScanner } from './services/pluginScanner.js';
import {
  createPluginScanScheduler,
  createPluginVerdictLookup,
  type PluginVerdictLookup,
} from './services/pluginVerdict.js';
import { archetypeAdds, CHANNEL_KIND_BY_ORIGIN, archetypeOf, archetypeOmits, getArchetype, directDatabaseUrl, isPooledDatabaseUrl, labelProcessMemory, MemberBaselineGrantStore, resolveScopedBundle, type SystemNoticeRequest } from '@omadia/orchestrator';
import {
  buildSystemNotice,
  ChannelResolver as ManagementChannelResolver,
  KernelAgentSelectionService,
  emitterOf,
  setRoleMembership,
  speakerFor,
  speakerOf,
} from '@omadia/orchestrator';
import type {
  ConfigStore as MultiOrchestratorConfigStore,
  OrchestratorRegistry as MultiOrchestratorRegistry,
  RunTraceOutcomeStats,
} from '@omadia/orchestrator';
import {
  HUMAN_NAMES_SERVICE,
  RUN_TRACE_STATS_SERVICE,
  setDatasetVaultKeyFallback,
} from '@omadia/orchestrator';
import type { HumanNamesProvider } from '@omadia/orchestrator';
import { createMemoryRouter } from './routes/memory.js';
import { createDatasetsRouter } from './routes/datasets.js';
import { createBulkPromotionRouter } from './routes/bulkPromotion.js';
import { createSkillPromotionRouter } from './routes/skillPromotion.js';
import { PgSkillOwnershipLifecycleStore } from './services/skillLifecycleStore.js';
import { resolveSkillManifestSigningKey } from './services/skillManifestSigningKey.js';
import { createCredentialAskRouter } from './routes/credentialAsks.js';
import { InMemoryCredentialAskStore } from './credentials/asks.js';
import { PostgresCredentialAskStore } from './credentials/postgresCredentialAskStore.js';
import {
  credentialKeychainDevKeyPath,
  resolveCredentialMasterKey,
} from './credentials/crypto.js';
import { createCredentialStore } from './credentials/credentialStoreFactory.js';
import { createInconsistenciesRouter } from './routes/inconsistencies.js';
import { createDuplicatesRouter } from './routes/duplicates.js';
import { createTopicsRouter } from './routes/topics.js';
import { createUsageRouter } from './routes/usage.js';
import { createAgentResolver } from './agents/resolveAgentForTool.js';
import { createClassDefaultRebuilder } from './platform/classDefaultRebuild.js';
import {
  createOrchestratorToolRebinder,
  hydrateAgentRegistry,
} from './agents/runtimeToolPropagation.js';
// `/attachments/<signed-key>` is now mounted by the de.byte5.channel.teams
// plugin via ctx.routes.register (see packages/harness-channel-teams/src/plugin.ts,
// phase-3.1-4). No kernel-side attachment router import needed anymore.
import { createChatSessionsRouter } from './routes/chatSessions.js';
import { soleAccountLegacyOwner, type LegacyChatOwner } from './routes/chatSessionAccess.js';
import {
  DEV_GRAPH_PATH,
  DEV_PATH_PREFIX,
  KG_LIFECYCLE_ADMIN_PATH,
  KG_PRIORITIES_ADMIN_PATH,
  PLUGIN_DOMAINS_ADMIN_PATH,
  mountDevGraph,
  mountDevLoopbackGuard,
  mountKnowledgeGraphAdmin,
} from './routes/graphRouterMounts.js';
import type { LifecycleService } from '@omadia/knowledge-graph-neon/dist/lifecycleService.js';
import type {
  AgentPrioritiesStore,
  BulkExcerptMergeDetectService,
  BulkInconsistencyService,
  BulkMergeDetectService,
  BulkPromotionService,
  InconsistencyDetectorService,
  MergeCandidateDetectorService,
  TopicClusteringService,
} from '@omadia/plugin-api';
import { createHarnessAdminUiRouter } from './routes/harnessAdminUi.js';
import { createPluginUiStaticRouter } from './routes/pluginUiStatic.js';
import { createStoreRouter } from './routes/store.js';
import { createInstallRouter } from './routes/install.js';
import { readGrantSnapshot } from './routes/runtimeGrants.js';
import { createAdminRegistriesRouter } from './routes/adminRegistries.js';
import { RegistryClient } from './plugins/registryClient.js';
import { addRegistryCapabilityProviders } from './plugins/registryCapabilityProviders.js';
import type { InstallChainResolution } from './plugins/capabilityResolver.js';
import {
  VaultBackedRegistryConfigStore,
  InMemoryRegistrySettings,
  seedRegistriesOnFirstBoot,
  type RegistrySettingsKV,
} from './plugins/registryConfigStore.js';
import { createProfilesRouter } from './routes/profiles.js';
import { createPackagesRouter } from './routes/packages.js';
import { createRegistryInstallRouter } from './routes/registryInstall.js';
import { createRuntimeRouter } from './routes/runtime.js';
import { createAdminSettingsRouter } from './routes/adminSettings.js';
import { createAdminProvidersRouter } from './routes/adminProviders.js';
import {
  createAdminEmbeddingProviderRouter,
  type LocalEmbeddingModelFetcher,
  type MemoryFeatureStatusView,
} from './routes/adminEmbeddingProvider.js';
import { createAdminTranscriptionProviderRouter } from './routes/adminTranscriptionProvider.js';
import { createAdminCliBackendsRouter } from './routes/adminCliBackends.js';
import { createAdminLastTurnRouter } from './routes/adminLastTurn.js';
import { setCliLoginAuthorizedHook } from './platform/cliAuthService.js';
import { exitAfterShutdown } from './platform/exitAfterShutdown.js';
import {
  autoAssignSubscriptionCli,
  handOffExistingCliLogin,
  SUBSCRIPTION_CLI_PROVIDER,
} from './platform/providerAssignment.js';
import {
  CLI_BINARY_RESOLVER_SERVICE_NAME,
  detectCliBackends,
  resolveCliBin,
} from './platform/cliBackendDetector.js';
import { registerClaudeCliAdapter } from './platform/claudeCliAdapter.js';
import {
  memoizeRuntimeReadinessCause,
  resolvePluginLlmReadiness,
  resolveProviderVerification,
  resolveRuntimeReadinessCause,
  type RuntimeReadinessCause,
} from './platform/pluginLlmReadiness.js';
import { createServiceRegistryBackedSqlGrantStore } from './platform/pluginSqlGrantStore.js';
import { createVaultStatusRouter } from './routes/vaultStatus.js';
import { buildPlatformChecks } from './health/platformHealth.js';
import { createBuilderRouter } from './routes/builder.js';
import {
  OperatorGate,
  SelfExtendRegistry,
  ExtensionStore,
  createRequestSelfExtensionTool,
} from './plugins/selfExtension/index.js';
import { DraftStore } from './plugins/builder/draftStore.js';
import { buildDraftStorageMirrorHook } from './plugins/builder/draftStorageBridge.js';
import { DraftQuota } from './plugins/builder/draftQuota.js';
import { PreviewRuntime } from './plugins/builder/previewRuntime.js';
import { PreviewCache } from './plugins/builder/previewCache.js';
import { PreviewSecretBuffer } from './plugins/builder/previewSecretBuffer.js';
import { PreviewRebuildScheduler } from './plugins/builder/previewRebuildScheduler.js';
import { warmPreview } from './plugins/builder/previewWarmBuild.js';
import { PreviewChatService } from './plugins/builder/previewChatService.js';
import { PreviewDraftAgents } from './plugins/builder/previewDraftAgents.js';
import {
  BuilderAgent,
  type BuilderProviderResolver,
} from './plugins/builder/builderAgent.js';
import { BuilderLlmAccessError } from './plugins/builder/builderLlmAccess.js';
import { BuilderTriageLog } from './plugins/builder/builderTriageLog.js';
import { GithubIssueCache } from './plugins/builder/githubIssueCache.js';
import { GithubIssueCreator } from './plugins/builder/githubIssueCreator.js';
import { createGitHubDeviceProvider } from './issues/githubOAuthProvider.js';
import { createIssuesRouter } from './issues/issuesRouter.js';
import { GitHubAppTokenProvider } from './plugins/builder/githubAppAuth.js';
import { UserChoiceCoordinator } from './plugins/builder/userChoiceCoordinator.js';
import {
  isUpstreamAllowlisted,
  loadGitHubAppConfig,
  loadUpstreamIssueConfig,
} from './plugins/builder/upstreamIssueConfig.js';
import { WorkaroundStateStore } from './plugins/builder/workaroundStateStore.js';
import { SpecEventBus } from './plugins/builder/specEventBus.js';
import { BuilderTurnRingBuffer } from './plugins/builder/turnRingBuffer.js';
import { DraftTurnLock } from './plugins/builder/draftTurnLock.js';
import {
  ensureBuildTemplate,
  linkWorkspacePackageIntoTemplate,
} from './plugins/builder/buildTemplate.js';
import { loadBuildTemplateConfig } from './plugins/builder/buildTemplateConfig.js';
import {
  registerServiceType,
  unregisterServiceType,
} from './plugins/builder/serviceTypeRegistry.js';
import { BuildPipeline } from './plugins/builder/buildPipeline.js';
import { RuntimeSmokeOrchestrator } from './plugins/builder/runtimeSmokeOrchestrator.js';
import { AutoFixOrchestrator } from './plugins/builder/autoFixOrchestrator.js';
import { BuilderModelRegistry } from './plugins/builder/modelRegistry.js';
import { SlotTypecheckPipeline } from './plugins/builder/slotTypecheckPipeline.js';
import { BuildQueue } from './plugins/builder/buildQueue.js';
import { createAuthRouter } from './routes/auth.js';
import { createLoginGuard } from './routes/authLogin.js';
import {
  buildPairingDescriptor,
  CANVAS_WS_PATH,
  WELL_KNOWN_PATH,
  PAIRING_PROTOCOL_VERSION,
  type ProviderSummaryLike,
} from './pairing/discovery.js';
import {
  startMdnsAdvertiser,
  type MdnsAdvertisement,
} from './pairing/mdns.js';
import { publicPaths } from './auth/publicPaths.js';
import { recordRawBodyBytes } from './http/rawBodySize.js';
import { createAppServer, createTerminalHandler } from './http/terminalHandler.js';
import { redactAuditError } from './services/secretRedaction.js';
import { isApiKeyActive } from '@omadia/api-key-auth';
import { createVerifyOnlyApiKeyStore, mountPublicMcp } from './mcp/wirePublicMcp.js';
// W5-1 — the WRITE half of `public_mcp_key_bindings`. Imported for the
// OPERATOR router only. `mountPublicMcp` above must never be handed this: the
// internet-facing endpoint gets `createPublicMcpKeyBindingStore` (read-only)
// and nothing else.
import { createPublicMcpKeyBindingAdminStore } from './mcp/publicMcpKeyBindingsAdmin.js';
import {
  PRIVACY_REDACT_SERVICE_NAME,
  type PrivacyGuardService,
} from '@omadia/plugin-api';
import {
  createOptionalSession,
  createRequireAuth,
  createSessionGate,
  evaluateSessionToken,
} from './auth/requireAuth.js';
import { createOperatorAuthAccessor, LateBoundAdminAudit } from './auth/operatorAuthAccessor.js';
import {
  createConductorWebhooksInboundRouter,
  type ConductorWebhookInboundDeps,
} from './routes/conductorWebhooksInbound.js';
import { WEBHOOK_POST_ACTION_ID, invokeWebhookPostAction } from './conductor/webhookPostAction.js';
import { parseMcpActionId } from './conductor/mcpActionId.js';
import { mcpRowToConfig } from './agents/subAgentToolHydration.js';
import { createMcpActionInvoker, listMcpActions } from './conductor/mcpActionInvoker.js';
import { OAuthClient } from './auth/oauthClient.js';
import { RefreshStore } from './auth/refreshStore.js';
import { EmailWhitelist } from './auth/whitelist.js';
import { resolveSessionSigningKey } from './auth/sessionSigningKey.js';
import { SessionRevocationGuard } from './auth/sessionRevocation.js';
import { runAuthMigrations } from './auth/migrator.js';
import { runCoreMigrations } from './platform/coreMigrations.js';
import { runProfileStorageMigrations } from './profileStorage/migrator.js';
import { LiveProfileStorageService } from './profileStorage/liveProfileStorageService.js';
import { runProfileSnapshotMigrations } from './profileSnapshots/migrator.js';
import { makeBuilderAwareProfileLoader } from './profileSnapshots/builderAwareProfileLoader.js';
import { SnapshotService } from './profileSnapshots/snapshotService.js';
import {
  DRIFT_DETECTOR_AGENT_ID,
  DRIFT_DETECTOR_CRON,
  DRIFT_DETECTOR_JOB_NAME,
  DRIFT_DETECTOR_TIMEOUT_MS,
  runDriftSweep,
} from './profileSnapshots/driftWorker.js';
import { UserStore } from './auth/userStore.js';
import { HumanNameDirectory } from './auth/humanNameDirectory.js';
import {
  ProviderCatalog,
  ProviderRegistry,
  parseAuthProvidersEnv,
  resolveActiveProviderIds,
  shouldWarnEmptyAdminAllowlist,
} from './auth/providerRegistry.js';
import { LocalPasswordProvider } from './auth/providers/LocalPasswordProvider.js';
import {
  ENTRA_PROVIDER_ID,
  EntraProvider,
} from './auth/providers/EntraProvider.js';
import { runAuthBootstrap } from './auth/bootstrap.js';
import { AdminAuditLog, auditActorFromLabel, roleChangeAuditEntry, systemAuditActor, webhookChangeAuditEntry, type AuditEntryInput } from './auth/adminAuditLog.js';
import {
  PlatformSettingsStore,
  SETTING_AUTH_ACTIVE_PROVIDERS,
} from './auth/platformSettings.js';
import { initSetupToken, isDesktopLoopbackKernel, PgSetupTokenStore } from './auth/setupToken.js';
import {
  describeTrustedProxies,
  parseTrustedProxies,
  PUBLIC_SCHEME_SETTING,
  requestIsSecure,
} from './http/requestTrust.js';
import { createAdminUsersRouter } from './routes/adminUsers.js';
import { createAdminAuditRouter } from './routes/adminAudit.js';
import { createAdminAuthRouter } from './routes/adminAuth.js';
import { PluginCatalog } from './plugins/manifestLoader.js';
import {
  EMBEDDING_GATE_STATUS_SERVICE,
  buildKgHealth,
  probeGraphPool,
  type EmbeddingGateStatus,
} from './health/kgHealth.js';
import {
  AI_DISCLOSURE_POSTURE_SERVICE,
  buildDisclosureHealth,
  type AiDisclosurePostureStatus,
} from './health/disclosureHealth.js';
import { FileInstalledRegistry } from './plugins/fileInstalledRegistry.js';
import { InstallService } from './plugins/installService.js';
import { registerInstalledPluginTemplates } from './plugins/pluginTemplates.js';
import type { PluginTemplateRegistrar } from './plugins/pluginTemplates.js';
import {
  OAuthBrokerService,
  PendingFlowStore,
} from './plugins/oauth/index.js';
import { blockRetiredAgentPlugins, noRuntimeError } from './plugins/retiredAgentPlugins.js';
import { invokePluginTool, pluginToolOwner } from './platform/pluginToolInvoker.js';
import { JobScheduler } from './plugins/jobScheduler.js';
import { MigrationRunner } from './plugins/migrationRunner.js';
import { PackageUploadService } from './plugins/packageUploadService.js';
import { ToolPluginRuntime } from './plugins/toolPluginRuntime.js';
import {
  UploadedPackageStore,
  ensureHostNodeModulesLink,
} from './plugins/uploadedPackageStore.js';
import {
  retryErroredPlugins,
  runLegacyBootstrap,
} from './plugins/bootstrap.js';
import { hasPackage, warnPackagelessEntries } from './plugins/packagelessEntries.js';
import { createPendingBindingPurge } from './plugins/pendingBindingPurge.js';
import {
  builtInOptOutsPathFor,
  FileBuiltInOptOutStore,
} from './plugins/builtInOptOuts.js';
import {
  facilitatorGrantablePluginIds,
  resolveFacilitationEngine,
  type FacilitationEngineSources,
} from './platform/facilitatorGuard.js';
import {
  createFacilitatorRuntimeLookup,
  FACILITATOR_CONVERSATIONS_SERVICE,
} from './platform/facilitatorRuntimeService.js';
import { publishSendServices } from './channels/sendServicesWiring.js';
import { publishAgentTurnService } from './agents/agentTurnWiring.js';
import { ChannelProviderRegistry } from './channels/sessionCapabilities/providerRegistry.js';
import { wireSessionCapabilities } from './channels/sessionCapabilities/wiring.js';
import {
  attachEngineToFacilitators,
  revokeForeignArchetypeGrants,
  syncArchetypesAndAttachEngine,
} from './platform/facilitatorEngineAttach.js';
import { createArchetypeRegistrySync } from './platform/archetypeRegistrySync.js';
import { wireExecutionAuthorization, type ExecutionWiring } from './execution/wiring.js';
import { AddressedMessageRouter } from './channels/addressedMessageRouter.js';
import { LinkRequestRouter } from './channels/linkRequestRouter.js';
import { PrivateMessageRouter } from './channels/privateMessageRouter.js';
import { createArchetypeDatabase } from './platform/archetypeDatabase.js';
import { pluginRuntimeOf } from './plugins/pluginRuntimeOf.js';
import { createAgentEndOfService } from './platform/agentEndOfService.js';
import { createSystemNoticeOutbox } from './platform/systemNoticeOutbox.js';
import { guardArchetypePluginUninstall } from './platform/archetypeUninstallGuard.js';
import { createOperatorArchetypesRouter } from './routes/operatorArchetypes.js';
import { createOperatorAgentArchetypeSettingsRouter } from './routes/operatorAgentArchetypeSettings.js';
import { createAgentArchetypeSettingsStore } from './platform/agentArchetypeSettingsStore.js';
import { createOperatorExecutionRouter } from './routes/operatorExecution.js';
import { createModelCallHaltMirror } from './execution/modelCallHalts.js';
import { createModelWorkRuns } from './platform/modelWorkRuns.js';
import { createModelWorkRouter } from './routes/modelWork.js';
import { createOperatorTriggersRouter } from './routes/operatorTriggers.js';
import { createConversationReaders } from './triggers/conversationReaders.js';
import { OPERATOR_JOB_ROUTES } from './platform/operatorJobRoutes.js';
import { createAgentTemplatesRouter } from './routes/agentTemplates.js';
import { createSetupOptionsResolver } from './plugins/setupOptionsResolver.js';
import { createModelGatewayStatusRouter } from './routes/modelGatewayStatus.js';
import { agentDirectoryService } from './platform/agentDirectoryService.js';
import { createAgentNamesProvider } from './platform/agentNamesService.js';
import { agentEnvelopeService } from './platform/agentEnvelopeService.js';
import {
  EMBEDDING_BACKFILL,
  FIELD_CLASSIFICATION,
  GRAPH_BACKFILL,
  MEMORY_EDIT,
  PLUGIN_BUILDER_AUTOFIX,
  PLUGIN_BUILDER_PREVIEW,
} from './platform/modelWorkKinds.js';
import { onUncoveredModelCall, setModelGatewayMode } from '@omadia/usage-telemetry';
import { decideCliProfile, setCliProfileDir } from '@omadia/orchestrator';
import type { ConductorDiscussionAdmin } from './conductor/discussionAdmin.js';
import {
  wireConversationMessages,
  type ConversationMessagesWiring,
} from './channels/conversationMessages/wiring.js';
import { warmPatternWorker } from './plugins/setupFieldPattern.js';
import { BuiltInPackageStore } from './plugins/builtInPackageStore.js';
import { LocalDevPackageStore } from './plugins/localDevPackageStore.js';
import { FileSecretVault, resolveMasterKey } from './secrets/fileVault.js';
import { VaultBackupService } from './secrets/vaultBackup.js';
import { createAnthropicLlmProvider } from './platform/anthropicLlmProvider.js';
import {
  pluginLlmProviderId,
  registerPluginLlmProvider,
  unregisterPluginLlmProvider,
} from './platform/llmProviderManifest.js';
import {
  BUILTIN_LLM_PROVIDERS,
  EXPERIMENTAL_LLM_PROVIDERS,
  registerBuiltinLlmProviders,
} from './platform/builtinLlmProviders.js';
import {
  createModelCatalogSync,
  type ModelCatalogSync,
} from './platform/modelCatalogSync.js';
import {
  classifyProviderCredentialKey,
  createProviderPoolCredentialListener,
} from './platform/providerPoolInvalidation.js';
import {
  providerCredentialPurgeBlocker,
  purgeProviderCredentials,
} from './platform/providerCredentialPurge.js';
import { createSharedAnthropicClientRefresher } from './platform/sharedAnthropicClientRefresher.js';
import { BackgroundJobRegistry } from './platform/backgroundJobRegistry.js';
import { ChatAgentWrapRegistry } from './platform/chatAgentWrapRegistry.js';
import { PromptContributionRegistry } from './platform/promptContributionRegistry.js';
import { installProcessGuards } from './platform/processGuards.js';
import { PluginRouteRegistry } from './platform/pluginRouteRegistry.js';
import { PublicPathGrantRegistry } from './platform/publicPathGrants.js';
import { createLazyPublicPathGrantStore } from './platform/publicPathGrantStore.js';
import { createPluginRawBodyMount } from './platform/pluginRawBodyMount.js';
import { createPublicPathMount } from './platform/publicPathMount.js';
import { buildResolutionChain } from './platform/pluginContext.js';
import { installPluginEgressGuard } from './platform/pluginEgressGuard.js';
import { createPluginEgressSource } from './platform/pluginEgressSource.js';
import { createPreviewEgressRoots } from './platform/previewEgressRoots.js';
import { createTeamsSsoAudienceSource } from './platform/teamsSsoAudiences.js';
import { createTeamsSsoGate } from './auth/teamsSsoGate.js';
import { createTeamsSsoVerifier } from './auth/teamsSsoVerifier.js';
import { NotificationRouter } from './platform/notificationRouter.js';
import { PluginStatusRegistry } from './platform/pluginStatusRegistry.js';
import { OAuthReadinessTracker } from './plugins/oauth/oauthReadinessTracker.js';
import { UiRouteCatalog } from './platform/uiRouteCatalog.js';
import { createUiNavigationRouter } from './routes/uiNavigation.js';
import { CanvasOutputRegistry } from './platform/canvasOutputRegistry.js';
import { EventCatalogRegistry } from './platform/eventCatalogRegistry.js';
import { DeterministicActionRegistry } from './platform/deterministicActionRegistry.js';
import { ServiceRegistry, KERNEL_SERVICE_CALLER } from './platform/serviceRegistry.js';
import {
  createLateBoundAttachmentBindingStore,
  createLateBoundGrantStore,
} from './audience/lateBoundGrantStore.js';
import {
  InMemoryAttachmentBindingStore,
  PostgresAttachmentBindingStore,
} from './audience/postgresAttachmentBindingStore.js';
import { PostgresGrantStore } from './audience/postgresGrantStore.js';
import { createAudienceGrantRouter } from './audience/routes.js';
import { TurnHookRegistry } from './platform/turnHookRegistry.js';
import { NativeToolRegistry } from '@omadia/orchestrator';
// W3-A / W4 — boot-time enforcement of the tool-timeout ordering invariant.
import { assertTimeoutHierarchy } from '@omadia/orchestrator';
// W2-2 (issue #543) — generic long-running task seam.
// Issue #560 — durable backing + boot resume driver for it.
import {
  InMemoryTaskStore,
  startTaskReaper,
  startTaskResumeDriver,
  type ResumableTaskSource,
} from '@omadia/orchestrator';
import { DurableTaskStore } from './tasks/durableTaskStore.js';
import {
  McpManager,
  type McpCallLogEntry,
  type McpServerConfig,
  type McpSidecarPayload,
  type McpStructuredSink,
} from '@omadia/orchestrator';
// W2-1 (#544) — MRTR mid-call user input: the process-shared park store and the
// replayer registration. See `mcp/pendingMcpInput.ts` for why these are shared.
import {
  planMcpInputReplay,
  setSharedMcpInputReplayer,
  sharedPendingMcpInputStore,
} from '@omadia/orchestrator';
import {
  SERVICE_USER_KEY,
  auditIdentity,
  delegationBlockedMessage,
  resolveMcpUserKey,
} from './services/mcpDelegation.js';
import { McpOAuthService } from './services/mcpOAuthService.js';
import { CIMD_METADATA_PATH, cimdMetadataUrl } from './services/mcpCimd.js';
import { createMcpClientMetadataRouter } from './routes/mcpClientMetadata.js';
import { McpConfigService } from './services/mcpConfigService.js';
import {
  McpRegistrySecretService,
  backfillMcpRegistryTokens,
} from './services/mcpRegistrySecretService.js';
import { AgentGraphStore } from '@omadia/orchestrator';
import { registerDbSubAgentTools } from './agents/subAgentToolHydration.js';
import {
  DATA_DIR,
  DEV_VAULT_KEY_PATH,
  DRAFTS_DB_PATH,
  INSTALLED_REGISTRY_PATH,
  VAULT_PATH,
  BUILDER_BUILD_TEMPLATE_DIR,
  BUILDER_PREVIEWS_DIR,
  BUILDER_STAGING_DIR,
} from './platform/paths.js';
import { ASSETS, verifyAssetBundles } from './platform/assets.js';
import { resolveBuilderReferenceCatalog } from './plugins/builder/builderReferenceCatalog.js';
import {
  ROUTINE_TURN_OWNER_GUARD_SERVICE_NAME,
  createRoutineTurnOwnerGuard,
  createRoutinesIntegration,
  createWebChatProactiveSender,
  initRoutines,
  routineTurnContext,
  type RoutinesHandle,
} from './plugins/routines/index.js';
import {
  ROUTINES_INTEGRATION_SERVICE_NAME,
  type RoutinesIntegration,
} from '@omadia/plugin-api';
import { createRoutinesRouter } from './routes/routines.js';
import { createUiPrefsRouter } from './routes/uiPrefs.js';
import { ExpressRouteRegistry } from './channels/routeRegistry.js';
import { WebSocketRegistry } from './channels/webSocketRegistry.js';
import { createCoreApi } from './channels/coreApi.js';
import { createCoreRoutineTurnScope } from './plugins/routines/coreRoutineTurnScope.js';
import { ChannelDirectoryRegistry } from './channels/channelDirectoryRegistry.js';
import { ConversationRosterRegistry } from './channels/rosterRegistry.js';
import { PeopleDirectoryRegistry } from './channels/peopleDirectoryRegistry.js';
import { ConversationEventHub } from './channels/conversationEventHub.js';
import { wireTriggers, type TriggerWiring } from './triggers/wiring.js';
import { ownBotRefusal } from './triggers/ownBot.js';
import { parseQuietHours } from './triggers/proactiveGate.js';
import { DEFAULT_TRIGGER_LIMITS } from './triggers/triggerPolicy.js';
import { createRoutineTriggerScheduler } from './triggers/routineTriggers.js';
import { createScheduleTriggerScheduler } from './triggers/scheduleTriggers.js';
import { KernelBatchJobRegistry } from './triggers/batchJobs.js';
import { TargetedSendRegistry } from './channels/targetedSendRegistry.js';
import { createTargetedDeliveryService } from './channels/targetedDeliveryService.js';
import { ConversationSendRegistry } from './channels/conversationSendRegistry.js';
import { createConversationSendService } from './channels/conversationSendService.js';
import { createOwnIdentityPostLog } from './channels/ownIdentityPostLog.js';
import { publishConversationRostersService } from './channels/rosterService.js';
import { ObservedConversationInvites } from './platform/observedConversationInvites.js';
import { PgObservedInvitePersistence } from './platform/observedInvitePersistence.js';
import { startEphemeralAttachmentSweep } from './platform/ephemeralAttachmentSweep.js';
import { DefaultChannelRegistry } from './channels/channelRegistry.js';
import type { AggregateHolderLookup, ChannelRegistry, ChannelBindingResolver } from '@omadia/channel-sdk';
import type {
  AgentIdentityProvider,
  ChannelReadinessProvider,
  DefaultChannelKeyProvider,
  MeetingSourceProvider,
} from '@omadia/channel-sdk';
import { InMemoryDisclosureSeenStore, normalizeAgentIdentityKey, RoleSourceRegistry, type GrantStore } from '@omadia/channel-sdk';
import { DynamicChannelPluginResolver } from './channels/dynamicChannelResolver.js';
import type { TurnDispatcher } from './channels/coreApi.js';
import { createOrchestratorDispatcher } from './channels/orchestratorDispatcher.js';
import { deriveChannelType } from './channels/channelType.js';
import type { FactExtractor } from '@omadia/orchestrator-extras';
import { backfillGraph } from '@omadia/orchestrator-extras';
import { turnContext } from '@omadia/orchestrator';
import { ConsultationStore } from './consultation/consultationStore.js';
import { createConsultationBroker } from './consultation/consultationBroker.js';
import { DiscretionStore } from './discretion/discretionStore.js';
import { createOperatorConsultationRouter } from './routes/operatorConsultation.js';
import type {
  EmbeddingClient,
  EntityRefBus,
  KnowledgeGraph,
} from '@omadia/plugin-api';
import type { Pool } from 'pg';
import { scramOnlyPoolOptions } from '@omadia/knowledge-graph-neon';
import type {
  ChatAgent,
  ChatAgentBundle,
  ChatSessionStore,
  DomainTool,
} from '@omadia/orchestrator';

/** Escape a value for safe inclusion inside a double-quoted XML/HTML attribute
 *  (used for the <mcp-auth-required> chat block, #459 W9). */
/**
 * Locales the operator web UI ships message catalogues for
 * (`web-ui/messages/*.json`). Used to validate `?locale=` on the
 * navigation endpoint before it reaches label resolution — an unknown
 * locale renders English chrome rather than an error. Keep in sync with
 * web-ui's catalogue; a missing entry here only costs a fallback to
 * English, never a failure.
 */
const WEB_UI_LOCALES = ['en', 'de'] as const;
/** How often the model gateway re-reads the kill switches (spec 2042 §5.10). */
const MODEL_CALL_HALT_REFRESH_MS = 10_000;
const WEB_UI_DEFAULT_LOCALE = 'en';

/**
 * The running build's identity (#432). Resolved once at module load — the
 * value is stamped into the image at build time and cannot change while the
 * process lives. Reported by `/health` and by the admin update surface.
 */
const appVersion = resolveAppVersion();

/**
 * Where this instance runs (#432 follow-up). Resolved once — the platform of a
 * running process does not change. Used only to make the manual update
 * instructions concrete on a deployment that has no executor.
 */
const appPlatform = resolvePlatform();

function xmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function main(): Promise<void> {
  // Install process-level guards FIRST — before any plugin code runs. Keeps
  // the host alive when a plugin's detached async (timers, resolved promises,
  // fire-and-forget I/O) throws.
  installProcessGuards();

  // W3-A / W4 — refuse to boot on an incoherent tool-timeout hierarchy. The
  // ordering (dispatch deadline > MCP worst case > per-request idle budget) used
  // to be asserted only inside a test helper that nothing shipped ever called,
  // so `OMADIA_TOOL_DISPATCH_TIMEOUT_MS=90000` inverted it with green CI and the
  // symptom surfaced much later as MCP calls dying on a generic
  // dispatch-deadline error. Config errors belong at startup.
  assertTimeoutHierarchy();

  // Plugin-api registries. Created empty at boot; populated as plugins
  // register into them during the activation sequence further down. Today
  // only the ServiceRegistry participates in the happy path (plumbed into
  // every createPluginContext call) — the others are infrastructure waiting
  // for Phase 1+ consumers (KG, Verifier, uploaded tool/extension packages).
  const serviceRegistry = new ServiceRegistry();
  const turnHookRegistry = new TurnHookRegistry();
  const backgroundJobRegistry = new BackgroundJobRegistry();
  const chatAgentWrapRegistry = new ChatAgentWrapRegistry<ChatAgent>();
  const promptContributionRegistry = new PromptContributionRegistry();
  // Shared NativeToolRegistry + PluginRouteRegistry — created once here so
  // that both the orchestrator and the plugin-activation pipeline mutate the
  // same instance. The orchestrator would previously construct its own
  // NativeToolRegistry; hoisting it lets plugin-contributed tools be visible
  // before the orchestrator is built.
  //
  // S+10-4a: published into the ServiceRegistry under `nativeToolRegistry`
  // so the @omadia/orchestrator plugin's activate() can late-resolve
  // it. Plugin can't construct its own NativeToolRegistry — tool plugins
  // (diagrams, etc.) write into THIS instance via their PluginContext during
  // their own activate(), and a fresh registry inside the orchestrator-
  // plugin would miss those registrations.
  const nativeToolRegistry = new NativeToolRegistry();
  serviceRegistry.provide('nativeToolRegistry', nativeToolRegistry);
  // Spec 2042 §5.10 — the model gateway refuses every model call outside an
  // execution context (the contract step; set before any plugin can make a
  // model call). Each refused call site is logged once.
  setModelGatewayMode('enforce');
  // Spec 2042 §5.10 — every Claude CLI spawn runs in an isolated profile
  // (HOME and CLAUDE_CONFIG_DIR = a directory holding only the login).
  try {
    const cliProfile = decideCliProfile({
      mode: config.OMADIA_CLI_PROFILE,
      configuredDir: process.env['CLAUDE_CONFIG_DIR'],
      home: process.env['HOME'],
      dataDir: DATA_DIR,
    });
    setCliProfileDir(cliProfile.dir);
    console.log(`[cli-profile] ${cliProfile.reason}`);
  } catch (err) {
    setCliProfileDir(undefined);
    console.warn(
      `[cli-profile] the isolated CLI profile could not be prepared, spawns inherit the environment: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  onUncoveredModelCall((report) => {
    console.warn(
      `[model-gateway] refused a '${report.operation}' call outside any execution context at ${report.site}`,
    );
  });
  // W2-2 (issue #543) — the store + orphan reaper backing deferred sub-agent
  // dispatch. Process-local by design: this unit ships no migration (0031/0032
  // are taken by parallel units), so a restart drops in-flight deferred tasks
  // and a poll answers "not found" rather than something wrong. The reaper is
  // what stops an unpolled task leaking a `working` row forever.
  const longRunningSubAgentTools = config.LONG_RUNNING_SUBAGENT_TOOLS.split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  // Issue #560 — deferred sub-agent tool handles are collected into this sink
  // during hydration so the resume driver (started after the hydrate loop) can
  // re-drive their tasks with no task-id hint (#560 criterion 3). The task store
  // itself is constructed once `graphPool` resolves, far below.
  const deferredTaskToolHandles: ResumableTaskSource[] = [];
  // LLM provider catalog: kernel-owned registry of plugin-contributed providers
  // (e.g. @omadia/plugin-llm-minimax). Published pre-activate and populated from
  // installed plugins' `llm_provider` manifest blocks below, so the orchestrator
  // can resolve a plugin-contributed provider at its own activation.
  const llmProviderCatalog = new LlmProviderCatalog();
  serviceRegistry.provide('llmProviderCatalog', llmProviderCatalog);
  // Bundled wire-format adapters (issue #298): the llm-provider runtime resolves
  // a provider by looking up the adapter for its wire format. The concrete
  // adapters + their SDKs live in @omadia/llm-adapter-*; register them into the
  // process-default registry HERE, before any provider is resolved, so the core
  // package itself imports no vendor SDK. A third-party wire format would add
  // another register*Adapter call here (or a plugin registering at activate).
  registerAnthropicAdapter(defaultLlmAdapters);
  registerOpenAiAdapter(defaultLlmAdapters);
  // #294 — the OpenAI Responses (SSE) wire the ChatGPT/Codex subscription
  // backend speaks (experimental "Sign in with ChatGPT"). Registered
  // unconditionally (cheap, SDK-free); the PROVIDER that uses it is env-gated.
  registerOpenAiResponsesAdapter(defaultLlmAdapters);
  // #309 Shape 2 — the local `claude` CLI as a keyless, tool-less completion
  // provider on the operator's subscription (not an HTTP wire format).
  registerClaudeCliAdapter(defaultLlmAdapters);
  console.log(
    `[middleware] ${String(defaultLlmAdapters.list().length)} LLM wire-format adapter(s) registered: ${defaultLlmAdapters
      .list()
      .map((a) => a.wireFormat)
      .join(', ')}`,
  );
  // Bundled built-in providers (anthropic/openai/mistral). The llm-provider
  // package ships ZERO static models now; these register into the catalog +
  // overlay HERE — before plugin activation and before the builder/orchestrator
  // resolve a model — so a fresh install is functional out of the box. Installed
  // provider PLUGINS (e.g. MiniMax) register additionally, further below.
  registerBuiltinLlmProviders(llmProviderCatalog, {
    includeExperimental: config.CHATGPT_SUBSCRIPTION_EXPERIMENTAL,
  });
  console.log(
    `[middleware] ${String(llmProviderCatalog.list().length)} built-in LLM provider(s) registered: ${llmProviderCatalog
      .list()
      .map((p) => p.id)
      .join(', ')}`,
  );
  // Canvas-output autodiscovery (declare → resolve → derive): plugins declare
  // `canvas_output: true` per manifest capability, the agent runtime resolves
  // those into this registry on (de)activation, and the ui-orchestrator
  // derives its sentinel allow-set from it lazily — no re-activation needed
  // when a new plugin is installed. The orchestrator's `canvas_output_tools`
  // config field remains as an operator override on top.
  const canvasOutputRegistry = new CanvasOutputRegistry();
  serviceRegistry.provide('canvasOutputRegistry', canvasOutputRegistry);
  // Deterministic-action autodiscovery (sibling of canvas-output): tools
  // declaring `deterministic_action: true` resolve into this registry on
  // (de)activation; the ui-orchestrator derives its LLM-free dispatch set from
  // it lazily. The `deterministic_action_tools` config field stays as override.
  const deterministicActionRegistry = new DeterministicActionRegistry();
  serviceRegistry.provide('deterministicActionRegistry', deterministicActionRegistry);
  // Event-catalog autodiscovery (US4 Conductor Surface): plugins declaring `event_emit: true`
  // capabilities resolve into this registry on (de)activation from BOTH runtimes (dynamic + tool),
  // so the Designer can list emittable events and ctx.events.emit enforces deny-by-default.
  const eventCatalogRegistry = new EventCatalogRegistry();
  serviceRegistry.provide('eventCatalogRegistry', eventCatalogRegistry);
  // #2082 — plugins register learning/consolidation jobs here; they run as
  // bounded agent batch triggers (deadline, budget, breaker), never as a
  // free-running plugin interval.
  const batchJobRegistry = new KernelBatchJobRegistry();
  serviceRegistry.provide(
    BATCH_JOB_REGISTRY_SERVICE,
    // A batch job spends every agent's trigger budget: built-in plugins only.
    perCallerService((caller) =>
      batchJobRegistry.forCaller(
        caller.pluginId,
        caller.pluginId === KERNEL_SERVICE_CALLER.pluginId || builtInPackageStore.has(caller.pluginId),
      ),
    ),
  );
  // #133 E0 — expose the kernel turn-hook registry to the orchestrator plugin
  // so it can fire onBeforeTurn / onAfterToolCall / onAfterTurn during turns.
  serviceRegistry.provide('turnHookRegistry', turnHookRegistry);
  // Epic #470 C6 / G2 — forward reference to the kernel's `requireAuth`.
  //
  // The route registry has to exist here (ToolPluginRuntime and half a dozen
  // wiring blocks below take it as a dependency) but `createRequireAuth` needs
  // the session signing key, which is built much further down. The resolver is
  // called ONCE PER REGISTRATION, not per request, and registrations happen at
  // `toolPluginRuntime.activateAllInstalled()` — long after the assignment
  // below — so every `auth: 'session'` route binds the real middleware. If that
  // ordering is ever broken, `register()` throws rather than quietly serving a
  // route with no gate.
  const kernelRequireAuthRef: { current?: RequestHandler } = {};
  // #1620 — same forward-reference pattern for `auth: 'teams-sso'`: the
  // audiences come from the installed registry, which is built further down.
  const teamsSsoGateRef: {
    current?: (source: string) => RequestHandler;
  } = {};
  const pluginRouteRegistry = new PluginRouteRegistry({
    sessionAuth: () => kernelRequireAuthRef.current,
    teamsSsoAuth: (source) => teamsSsoGateRef.current?.(source),
  });
  // Epic #470 C4 / H1 — who owns which unauthenticated URL prefix, and which of
  // those the operator has consented to. The registry decides routing; the
  // store holds the durable consent. Both are wired into ToolPluginRuntime
  // (claim on activate, release on deactivate) and into the terminating mount
  // installed BEFORE the `/api` requireAuth line far below.
  //
  // The store is late-bound because `graphPool` is published into the service
  // registry after plugins activate — see createLazyPublicPathGrantStore.
  const publicPathGrants = new PublicPathGrantRegistry();
  const publicPathGrantStore = createLazyPublicPathGrantStore(() =>
    serviceRegistry.get<Pool>('graphPool'),
  );
  // Epic #470 C16 (#817) — ONE SQL grant store, shared by all four consumers:
  // `toolPluginRuntime` reads it at activate, the runtime router writes it when
  // the operator consents, `installService` purges it on uninstall (B6), and
  // the grants view reads it back. Constructing a second one per consumer would
  // work — they are all thin wrappers over the same late-bound pool — but it
  // would also make "which store did that write go to?" a question with more
  // than one answer, which is the wrong property for a consent record.
  //
  // Late-bound for the same reason as the public-path store: `graphPool` is
  // published by a PLUGIN, well after this line runs.
  const sqlGrantStore = createServiceRegistryBackedSqlGrantStore(() =>
    serviceRegistry.get<Pool>('graphPool'),
  );
  const notificationRouter = new NotificationRouter();

  // Phase B+ — directory aggregator for the /operator/channels dashboard.
  // Channel-kind plugins register their ChannelKeyDirectory contributions
  // during activate(); the kernel exposes the union over REST.
  const registryLog = (msg: string, fields?: Record<string, unknown>): void =>
    console.log(`[middleware] ${msg}${fields ? ' ' + JSON.stringify(fields) : ''}`);
  const channelDirectoryRegistry = new ChannelDirectoryRegistry(registryLog);
  serviceRegistry.provide('channelDirectoryRegistry', channelDirectoryRegistry);

  // #330 B1 — group-conversation registries. Constructed here (dep-free) so
  // both the conductor block below and the channel runtime at the bottom can
  // reference them; wired into createCoreApi + the channel registry there.
  const conversationRosterRegistry = new ConversationRosterRegistry(registryLog);
  // People directory — channel plugins' searchable "who is <name>?" for Conductor human steps.
  const peopleDirectoryRegistry = new PeopleDirectoryRegistry(registryLog);
  const targetedSendRegistry = new TargetedSendRegistry(registryLog);
  const conversationSendRegistry = new ConversationSendRegistry(registryLog);
  const conversationEventHub = new ConversationEventHub(registryLog);
  // #2043 — set once the message hub is wired (database block, further down).
  // A holder, because the plugin install / uninstall hooks defined before
  // that block ask it to re-check subscriptions.
  const conversationMessagesRef: { current?: ConversationMessagesWiring } = {};
  // #2090 — set once the database pool exists (execution scopes, reservations).
  const executionRef: { current?: ExecutionWiring } = {};
  // #2082 — agent-owned triggers; wired once the pool and the registry exist.
  const triggersRef: { current?: TriggerWiring } = {};
  // Channel plugins' ids, known once the channel registry exists: their
  // events are offered to every agent's hooks.
  const channelPluginIdsRef: { current: () => readonly string[] } = { current: () => [] };
  // #2067 — set once the Conductor is wired; the operator routes mount earlier.
  const discussionAdminRef: { current?: ConductorDiscussionAdmin } = {};
  // #2089 — private messages of a running process's participants to its
  // agent. Without a database nobody is listed by a scope, so nothing routes.
  const privateMessageRouter = new PrivateMessageRouter({
    processesListingPerson: async (input) =>
      (await executionRef.current?.store.processesListingPerson(input)) ?? [],
    executionFor: (pluginId) => executionRef.current?.serviceFor(pluginId),
    log: (m) => console.log(m),
  });
  // #2089 — who answers a message that addresses a facilitator while one of
  // its processes listens for such messages (follow-up): the turn asks the
  // process's plugin first.
  const addressedMessageRouter = new AddressedMessageRouter({
    listeners: (scope) => conversationMessagesRef.current?.hub.addressedListeners(scope) ?? [],
    eventIdOf: async (scope, pluginId, messageId) => {
      const record = await conversationMessagesRef.current?.hub.getProcessEvent(scope, pluginId, messageId, 0);
      // Only the message itself: a card answer shares its card's message id.
      return record?.kind === 'created' ? record.eventId : undefined;
    },
    log: (m) => console.log(m),
  });
  // #2089 — a request to link a conversation no process of the facilitator
  // reads (the chat of a scheduled meeting) as a session conversation: the
  // turn asks the archetype plugin, the kernel records the request.
  const linkRequestRouter = new LinkRequestRouter({
    sessions: () => executionRef.current?.sessions,
    isRead: (scope) =>
      (conversationMessagesRef.current?.hub.subscriptionsIn(scope.channelType, scope.conversationId) ?? []).some(
        (s) => s.agentSlug === scope.agentSlug && s.mode !== 'none',
      ),
    log: (m) => console.log(m),
  });
  // #2043 — channel readiness providers and meeting sources (same lifecycle).
  const readinessProviderRegistry = new ChannelProviderRegistry<ChannelReadinessProvider>(
    'readiness',
    registryLog,
  );
  const meetingSourceRegistry = new ChannelProviderRegistry<MeetingSourceProvider>(
    'meetingSource',
    registryLog,
  );
  // Spec 2042 §5.3 — channel plugins that run one bot per agent.
  const agentIdentityProviderRegistry = new ChannelProviderRegistry<AgentIdentityProvider>(
    'agentIdentity',
    registryLog,
  );
  // The default bot of a channel that runs no identity provider (Teams, whose
  // agent bots the kernel provisions into `agent_teams_identities`).
  const defaultChannelKeyRegistry = new ChannelProviderRegistry<DefaultChannelKeyProvider>(
    'defaultChannelKey',
    registryLog,
  );
  // #330 C2a — kernel-side invite index: subscribes directly at the hub (before
  // any plugin) and is the scope guard for plugin auto-binds. A plugin can only
  // bind conversations the transport actually reported a group bot_added for.
  const observedInvites = new ObservedConversationInvites({ log: (m) => console.log(`[middleware] ${m}`) });
  observedInvites.attach(conversationEventHub);
  // #2082 — membership changes reach the agents' hooks as kernel events.
  conversationEventHub.subscribe((event) => {
    if (event.kind !== 'members_added' && event.kind !== 'members_removed') return;
    triggersRef.current?.onEvent(
      event.kind === 'members_added' ? 'conversation.members.added' : 'conversation.members.removed',
      {
        channelType: event.channelType ?? event.channelId,
        conversationId: event.conversationId,
        members: event.members.map((member) => member.id),
      },
      `${event.kind}:${event.occurredAt}:${event.members.map((member) => member.id).join(',')}`,
    );
  });
  // #2043 — per caller: only the facilitation engine may read a roster as an
  // agent (`{ agentSlug }`), and the kernel resolves that agent's identity.
  publishConversationRostersService({
    serviceRegistry,
    registry: conversationRosterRegistry,
    identityFor: (agentSlug, channelType) =>
      serviceRegistry
        .get<MultiOrchestratorRegistry>('orchestratorRegistry')
        ?.channelIdentityFor(agentSlug, channelType),
    isEngine: (pluginId) => {
      const engine = resolveFacilitationEngine(facilitationEngineSources());
      return engine.state === 'bound' && engine.pluginId === pluginId;
    },
    log: (m) => console.log(m),
  });
  // Subscribe-only facade: agent plugins may LISTEN for membership events, but
  // emitting stays a channel-adapter privilege (CoreApi). A service-published
  // emit() would let any granted plugin spoof `bot_added` — the Facilitator's
  // handshake trigger — for conversations nobody invited it into.
  serviceRegistry.provide('conversationEvents', {
    subscribe: (fn: Parameters<ConversationEventHub['subscribe']>[0]) => conversationEventHub.subscribe(fn),
  });

  const uiRouteCatalog = new UiRouteCatalog();
  // Publish the catalogue so plugin code (notably channel-teams' Hub +
  // Tab-Config) can read it via `ctx.services.get<UiRouteCatalog>(
  // 'uiRouteCatalog')`. Published BEFORE any plugin activates so the
  // service is available the moment a consumer asks for it.
  serviceRegistry.provide('uiRouteCatalog', uiRouteCatalog);

  // Spec 004 — kernel store of plugin action statuses (ctx.status). Read by the
  // admin API to surface "Aktion erforderlich" badges/banners in the store UI.
  const pluginStatusRegistry = new PluginStatusRegistry();

  // Issue #474 (round 5) — automatic OAuth-connection readiness signal,
  // separate from pluginStatusRegistry above. See OAuthReadinessTracker's
  // doc comment for why the two stay separate caches ANDed at the gate.
  const oauthConnectionTracker = new OAuthReadinessTracker();

  // Shared Anthropic client used by sub-agents (LocalSubAgent inner Claude
  // calls) and the Teams channel (anthropicClient dep). The orchestrator-
  // plugin constructs ITS OWN client from `anthropic_api_key` setup-field —
  // they're functionally equivalent but separate instances.
  //
  // maxRetries: the Anthropic SDK auto-retries 408/409/429/500/529 with
  // exponential backoff. The SDK default is 2; bumped to 5 so a transient
  // `overloaded_error` (HTTP 529) burst is far more likely to ride out
  // inside the SDK instead of surfacing as a failed turn.
  //
  // OB-61: apiKey may be empty when the operator boots without ENV and
  // hasn't completed /setup yet. The orchestrator + verifier + extras
  // plugins each build their own per-plugin client from the vault, so
  // the path that would actually hit this shared client (LocalSubAgent
  // inner calls / Teams) is only reachable AFTER the orchestrator has
  // activated — which in turn requires the key. Falling back to '' here
  // keeps the SDK constructor happy on cold boots.
  const client = createAnthropicClient({
    apiKey: config.ANTHROPIC_API_KEY ?? '',
    maxRetries: 5,
  });

  // Phase 5B: publish the raw Anthropic client so dynamic-imported channel
  // plugins (Teams, future) can late-resolve it via ctx.services.get(...)
  // instead of constructor-injected Deps. The whitelist-wrapped variant
  // stays under 'llm' for plugins that go through the budget/model gate.
  serviceRegistry.provide('anthropicClient', client);

  // Customer bug (builder.ask_failed / "Could not resolve authentication
  // method"): on installs where the key arrives via the LLM access page (vault)
  // and not via ENV, the boot-time `client` above is unauthenticated forever —
  // `sharedAnthropicClientRefresher` only swaps the REGISTRY providers,
  // never this const. Host-side consumers (BuilderAgent, PreviewChatService)
  // therefore take this accessor and re-resolve the current client per turn
  // instead of capturing the boot instance.
  const currentAnthropicClient = (): AnthropicClient =>
    serviceRegistry.get<AnthropicClient>('anthropicClient') ?? client;

  // OB-29-3 — wrap the Anthropic client as an `llm` ServiceRegistry
  // provider so plugins that declare `permissions.llm.models_allowed`
  // can reach it via `ctx.llm.complete()`. The accessor wrapper applies
  // the model-whitelist + per-invocation budget + max-tokens-clamp on
  // top of this provider. Boot-time registration → process-lifetime;
  // no dispose handle captured.
  serviceRegistry.provide(
    'llm',
    createAnthropicLlmProvider({
      client,
      log: (...args) => console.log('[llm]', ...args),
    }),
  );

  // MemoryStore is now provided by the @omadia/memory plugin. It lands
  // in `serviceRegistry` during toolPluginRuntime.activateAllInstalled() below.
  // Kernel consumers (chatSessionStore, sessionLogger, graphBackfill, admin
  // router) retrieve it after that activation step.

  // S+9.1 sub-commit 2b: embedding client is plugin-owned. The
  // @omadia/embeddings plugin's activate() reads its config
  // (ollama_base_url / ollama_model / ollama_timeout_ms / max_concurrent)
  // and publishes the wrapped EmbeddingClient via
  // `ctx.services.provide('embeddingClient', client)`. Kernel pulls it
  // via late-resolve below, after `toolPluginRuntime.activateAllInstalled()`.
  // The Pre-S+8.5 bridge that used to live here is gone.

  // Pre-S+8 bridge: publish the kernel-owned `turnContext` AsyncLocalStorage
  // accessor so the KG plugin's EntityRefBus can read the active turn id
  // (per-turn EntityRef correlation). Plugin uses a narrow shim — only
  // currentTurnId() is consumed. Bridge goes away when turnContext itself
  // moves into a shared platform package.
  serviceRegistry.provide('turnContext', turnContext);

  // KG + EntityRefBus + embedding-backfill construction moved into
  // @omadia/knowledge-graph's activate() (S+8 sub-commit 2b). The
  // plugin owns the Pool lifetime (created in activate, drained in close)
  // and provides the runtime instances via ctx.services.provide. Kernel
  // late-resolves them after `toolPluginRuntime.activateAllInstalled()`.

  // ────────────────────────────────────────────────────────────────────────
  // Harness Platform runtime — catalog, vault, installed registry, install
  // service. Lives before any sub-agent construction so every sub-agent can
  // read its credentials from the vault via ctx instead of from .env.
  // ────────────────────────────────────────────────────────────────────────
  // Uploaded package store — must exist before the catalog load, because the
  // catalog merges the extracted manifests from this store.
  const uploadedPackagesDir = config.UPLOADED_PACKAGES_DIR;
  const uploadedPackageStore = new UploadedPackageStore(
    path.join(uploadedPackagesDir, 'index.json'),
    uploadedPackagesDir,
  );
  await uploadedPackageStore.load();
  // So that dynamic imports from uploaded packages can find their peerDependencies
  // (Node-Resolver walks up the dir hierarchy until it hits `node_modules/`),
  // we place a symlink at the packages-root pointing to the host node_modules.
  try {
    const linkPath = await ensureHostNodeModulesLink(uploadedPackagesDir);
    console.log(
      `[middleware] uploaded packages peer-link ready: ${linkPath} → host node_modules`,
    );
  } catch (err) {
    console.warn(
      `[middleware] ⚠ could not create peer-link for uploaded packages: ${err instanceof Error ? err.message : err}. Uploaded agents with peerDependencies will fail to import.`,
    );
  }
  console.log(
    `[middleware] uploaded package store loaded (${uploadedPackageStore.list().length} packages at ${uploadedPackagesDir})`,
  );

  // Built-in packages (shipped in the middleware image under
  // middleware/packages/*/manifest.yaml). Same activation pipeline as
  // uploaded packages — only the package source differs.
  const builtInPackageStore = new BuiltInPackageStore(
    config.BUILT_IN_PACKAGES_DIR,
  );
  await builtInPackageStore.load();
  console.log(
    `[middleware] built-in package store loaded (${builtInPackageStore.list().length} packages at ${config.BUILT_IN_PACKAGES_DIR})`,
  );

  // Optional Local-Dev source (PLUGIN_DEV_DIR) — opt-in for plugin authors
  // iterating outside the workspace. Disabled by default: OSS users get a
  // clean state with no implicit dev override.
  const localDevPackageStore = new LocalDevPackageStore(config.PLUGIN_DEV_DIR);
  await localDevPackageStore.load();
  if (localDevPackageStore.enabled()) {
    console.log(
      `[middleware] local-dev package store loaded (${localDevPackageStore.list().length} packages at ${localDevPackageStore.rootPath()})`,
    );
  }

  // Resolution order on ID collision (PluginCatalog.load applies last-set-
  // wins): Local-Dev > Uploaded > Built-in > PLUGIN_MANIFEST_DIR (examples).
  // Local-Dev wins so authors can shadow without packing/zipping. Uploaded
  // wins over Built-in (matches the manifestLoader.PluginCatalogOptions
  // contract — the previous order had built-in inadvertently overriding
  // uploaded).
  // OB-41: fail-fast asset-bundle verification BEFORE the catalog load. A
  // missing boilerplate dir or entity registry surfaces as a single boot-
  // abort with the failing path + a "set ENV or COPY ..." hint, instead of
  // letting the first plugin that touches the asset crashloop the process.
  await verifyAssetBundles();
  console.log(
    `[middleware] asset bundles verified (${Object.values(ASSETS)
      .map((b) => `${b.id}=${b.source}`)
      .join(', ')})`,
  );

  const pluginCatalog = new PluginCatalog({
    extraSources: () => [
      // #794 — `bundled` is asserted HERE and nowhere else. These packages
      // ship inside the middleware image under `middleware/packages/*`, which
      // is what makes them eligible for the dated built-in SQL ramp in
      // `platform/pluginSqlGrants.ts`. Uploaded and local-dev packages are
      // deliberately left at the default `installed`: an upload must never be
      // able to inherit a bundled plugin's ramp by claiming its id.
      ...builtInPackageStore
        .list()
        .map((p) => ({ packageRoot: p.path, origin: 'bundled' as const })),
      ...uploadedPackageStore.list().map((p) => ({ packageRoot: p.path })),
      ...localDevPackageStore.list().map((p) => ({ packageRoot: p.path })),
    ],
  });
  await pluginCatalog.load();
  console.log(
    `[middleware] plugin catalog loaded (${pluginCatalog.list().length} plugins, incl. ${uploadedPackageStore.list().length} uploaded, ${builtInPackageStore.list().length} built-in${localDevPackageStore.enabled() ? `, ${localDevPackageStore.list().length} local-dev` : ''})`,
  );

  const masterKey = await resolveMasterKey(
    process.env['VAULT_KEY'],
    DEV_VAULT_KEY_PATH,
    process.env['NODE_ENV'] === 'production',
  );
  if (masterKey.source === 'env') {
    console.log('[middleware] vault master key loaded from VAULT_KEY env');
  } else if (masterKey.source === 'dev-file-existed') {
    console.log(
      `[middleware] ⚠ vault master key loaded from dev file (${DEV_VAULT_KEY_PATH}) — set VAULT_KEY for production`,
    );
  } else {
    console.warn(
      `[middleware] ⚠ vault master key GENERATED at ${DEV_VAULT_KEY_PATH} — DEV ONLY. Set VAULT_KEY for production.`,
    );
  }

  // #1546 — without VAULT_KEY the dataset import found no secret and stored
  // irreversible surrogates (every e-mail of a column became one address).
  // It now derives its cell and link keys from the dev key the vault runs on.
  if (masterKey.source !== 'env') setDatasetVaultKeyFallback(masterKey.key);

  const secretVault = new FileSecretVault(VAULT_PATH, masterKey.key);
  await secretVault.load();

  // Session signing key lives in the vault (`core:auth` scope). First boot
  // generates; every subsequent boot reuses the same key so outstanding
  // cookies stay valid across deploys. Resolved here (before the plugin
  // runtimes are constructed) because it doubles as the key the `ctx.flows`
  // toolkit signs plugin-flow state with (spec 004 FR-B3).
  const sessionSigningKey = await resolveSessionSigningKey(secretVault);
  // Server-side session revocation (`users.session_version`): ONE guard for
  // every session consumer — requireAuth, ctx.operatorAuth, the auth and
  // admin-users routers and the channel WebSocket upgrade. Late-bound: the
  // users table lives in graphPool, which exists only much further down, so
  // the account source is attached right after the UserStore is built (still
  // before app.listen, so no request is ever evaluated without it).
  const sessionRevocation = new SessionRevocationGuard();
  // #778 W1 — HMAC key `promoteSkillOwnerScope` (#577 P3) re-signs a skill's
  // manifest with. Resolved here alongside the session key: same vault,
  // same "generate once, persist, reuse every boot" pattern — see
  // `services/skillManifestSigningKey.ts`.
  const skillManifestSigningKey = await resolveSkillManifestSigningKey(secretVault);
  // #778 W1 — the credential keychain's own master key (#578 Phase 1),
  // resolved but never actually used anywhere until now. Same
  // `resolveMasterKey` call `credentials/crypto.ts`'s module doc documents
  // (`CREDENTIAL_KEYCHAIN_KEY` env, deliberately a DIFFERENT key/env var than
  // `VAULT_KEY` — different trust domain). Needed here because
  // `InMemoryCredentialAskStore` (the no-Postgres fallback) holds a live
  // `CredentialStore` reference to validate an ask's `credentialId` in
  // process, the same way `PostgresCredentialAskStore` validates it via SQL.
  const credentialMasterKey = await resolveCredentialMasterKey(
    DATA_DIR,
    process.env['NODE_ENV'] === 'production',
  );
  if (credentialMasterKey.source === 'env') {
    console.log('[middleware] credential-keychain master key loaded from CREDENTIAL_KEYCHAIN_KEY env');
  } else if (credentialMasterKey.source === 'dev-file-existed') {
    console.log(`[middleware] ⚠ credential-keychain master key loaded from dev file (${credentialKeychainDevKeyPath(DATA_DIR)}) — set CREDENTIAL_KEYCHAIN_KEY for production`);
  } else {
    console.warn('[middleware] ⚠ credential-keychain master key GENERATED (dev file) — DEV ONLY. Set CREDENTIAL_KEYCHAIN_KEY for production.');
  }
  // Spec 004 (FR-B5) — origin plugin flow callbacks resolve against.
  const flowPublicBaseUrl =
    config.FLOW_PUBLIC_BASE_URL ?? config.PUBLIC_BASE_URL;

  // Admin email whitelist — resolved here (ahead of its original A.1 spot
  // below) because it's now ALSO a dependency of `operatorAuth`
  // (`ctx.operatorAuth`, issue #438 follow-up), which the plugin runtimes
  // constructed further down need at construction time. The `requireAuth`
  // Express middleware built at the original A.1 site still uses this same
  // instance — nothing there changes.
  const emailWhitelist = new EmailWhitelist(config.ADMIN_ALLOWED_EMAILS);
  // Issue #438 follow-up — kernel-published `ctx.operatorAuth`. Wraps the
  // EXACT SAME session-verification logic `requireAuth` uses (see
  // `operatorAuthAccessor.ts`), so a plugin's admin-only HTTP surface (e.g.
  // `@omadia/channel-api`'s `/admin/keys`) can check the real operator
  // session without re-implementing it. Threaded into every plugin runtime
  // below so any plugin — not just channel plugins — can use it.
  // #1329 — `admin_audit` for plugin-originated admin actions (API-key
  // lifecycle). Late-bound: the AdminAuditLog needs the Postgres pool, which
  // exists only further down; attached right where it is constructed.
  const pluginAdminAudit = new LateBoundAdminAudit();
  const operatorAuth = createOperatorAuthAccessor({
    signingKey: sessionSigningKey,
    whitelist: emailWhitelist,
    sessions: sessionRevocation,
    audit: pluginAdminAudit,
  });

  const installedRegistry = new FileInstalledRegistry(
    INSTALLED_REGISTRY_PATH,
  );
  await installedRegistry.load();
  // Spec 2042 §5.10 — the network sandbox of installed plugins, before any
  // of them activates: their own requests through the global `fetch` and
  // `node:http(s)` are refused outside their network permission, and model
  // providers are reached only through the gateway (enforced since S3b).
  // ADR-0017 — Builder previews run in-process too; their extracts are
  // guarded like installed packages (`previewEgressRoots.ts`).
  const previewEgressRoots = createPreviewEgressRoots(BUILDER_PREVIEWS_DIR);
  installPluginEgressGuard({
    mode: 'enforce',
    source: createPluginEgressSource({
      catalog: pluginCatalog,
      installedRegistry,
      llmProviderCatalog,
      previews: previewEgressRoots,
    }),
    onObservation: (o) => {
      console.warn(
        `[plugin-egress] ${o.mode === 'enforce' ? 'refused' : 'observed'}: plugin '${o.pluginId}' reached '${o.host}' (${o.reason})`,
      );
    },
  });
  const ownIdentityPostLog = createOwnIdentityPostLog();
  // #2088 — an installed plugin of kind `archetype` registers the archetype
  // its manifest describes; see `platform/archetypeRegistrySync.ts`.
  const archetypeRegistry = createArchetypeRegistrySync({
    sources: () => ({ installedRegistry, catalog: pluginCatalog }),
    rows: () => serviceRegistry.get<Pool>('graphPool'),
    log: (m) => console.log(m),
  });
  // #2088 — end of service: what ends before an agent is disabled or deleted
  // and before its archetype plugin is removed. Each affected home
  // conversation gets one `system` notice through the channel's shared bot,
  // kept in an outbox so a restart still delivers it (criterion 37).
  const systemNoticeOutbox = createSystemNoticeOutbox({
    pool: () => serviceRegistry.get<Pool>('graphPool'),
    send: async (channelType, conversationId, message) => {
      const provider = conversationSendRegistry.get(channelType);
      // Not up yet (boot, a plugin that starts late): no attempt spent.
      if (!provider) return { delivered: false, reason: `no conversation sender for channel '${channelType}'`, deferred: true };
      const out = await provider.sendToConversation(conversationId, message);
      return out.outcome === 'delivered' ? { delivered: true } : { delivered: false, reason: `${out.code}: ${out.message}` };
    },
    locale: () => {
      const raw = installedRegistry.get('@omadia/orchestrator')?.config?.['ai_disclosure_locale'];
      return typeof raw === 'string' ? raw : undefined;
    },
    log: (m) => console.log(m),
  });
  systemNoticeOutbox.start(60_000);
  const emitSystemNotice = (notice: SystemNoticeRequest): Promise<void> => systemNoticeOutbox.emit(notice);
  const agentEndOfService = createAgentEndOfService({
    // Only the plugin that delivers the archetype is asked; the same service
    // name provided by anybody else is not its process service.
    processesFor: (archetypeId) => {
      const source = getArchetype(archetypeId)?.source;
      const name = archetypeProcessesServiceName(archetypeId);
      if (!source || source === 'kernel' || !serviceRegistry.providedBy(source, name)) return undefined;
      return serviceRegistry.get<ArchetypeProcessesService>(name);
    },
    endSubscriptionsOf: async (agentSlug, reason) =>
      (await conversationMessagesRef.current?.hub.endAllOf(agentSlug, reason)) ?? [],
    // #2090 — no scope of the agent authorizes anything after this, and no
    // conversation stays reserved for it.
    revokeExecution: async (agentId, reason) => {
      const revoked = await executionRef.current?.store.revokeAll({ agentId }, reason);
      return {
        scopesEnded: revoked?.scopes.length ?? 0,
        reservationsReleased: revoked?.reservations ?? [],
      };
    },
    audit: async (entry) => {
      await adminAudit?.record(entry);
    },
    emitSystemNotice,
    log: (m) => console.log(m),
  });
  const facilitationEngineSources = (): FacilitationEngineSources => ({
    installedRegistry,
    catalog: pluginCatalog,
  });
  // #1620 — Teams SSO for `auth: 'teams-sso'` plugin routes. One verifier for
  // the process, so the per-tenant JWKS cache and its refetch throttle are
  // shared by every route; audiences = the bots of the active channel-teams.
  const teamsSsoVerifier = createTeamsSsoVerifier({
    audiences: createTeamsSsoAudienceSource({
      registry: () => installedRegistry,
      configChain: (pluginId) => buildResolutionChain(pluginId, pluginCatalog),
    }),
    // The host the Teams app package names in `webApplicationInfo.resource`
    // (`api://<host>/<appId>`, teamsAppPackageAssets.ts) — v1 tokens carry it.
    identifierUriHosts: () =>
      [config.TEAMS_PUBLIC_BASE_URL, config.PUBLIC_BASE_URL].flatMap((url) => {
        if (!url) return [];
        try {
          return [new URL(url).host];
        } catch {
          return [];
        }
      }),
  });
  teamsSsoGateRef.current = (source) =>
    createTeamsSsoGate(source, { verifier: teamsSsoVerifier });
  // #1481 — built-ins the operator uninstalled; the boot seeders skip them.
  const builtInOptOuts = new FileBuiltInOptOutStore(
    builtInOptOutsPathFor(INSTALLED_REGISTRY_PATH),
  );
  await builtInOptOuts.load();

  // Register/unregister a plugin's `llm_provider` block into the catalog (which
  // also overlays its models into the model-registry the admin Providers page
  // reads). Thin wrappers over the shared platform helpers — they add the
  // config-scope lookup, logging, and never-fatal error handling. Used by BOTH
  // the boot loop AND the hot-install path (InstallService.onInstalled/
  // onUninstall) so a provider plugin installed at runtime appears WITHOUT a
  // restart.
  // Live model discovery: the catalog's static model lists are only seeds.
  // Created here (the vault exists, the catalog holds the built-ins) so the
  // hot-install path below can refresh a runtime-installed provider through
  // it; the boot refresh + timer start further down, once installed provider
  // plugins are in the catalog too.
  // #1359 — a discovery run that moves a provider's class defaults rebuilds
  // the LLM plugins that resolved a class ref against the older catalog (at
  // boot: the seed). It waits for `bootWired` (resolved once the domain-tool
  // re-bind is installed), and reactivates through `reactivateAgent`, which is
  // defined further below — hence the forward reference.
  let resolveBootWired: () => void = () => undefined;
  const bootWired = new Promise<void>((resolve) => {
    resolveBootWired = resolve;
  });
  // eslint-disable-next-line prefer-const -- assigned further below; closures read it first
  let reactivateAgentRef: ((agentId: string) => Promise<void>) | undefined;
  const classDefaultRebuilder = createClassDefaultRebuilder({
    installedRegistry,
    reactivate: async (agentId) => {
      await reactivateAgentRef?.(agentId);
    },
    ready: bootWired,
  });
  const modelCatalogSync: ModelCatalogSync = createModelCatalogSync({
    catalog: llmProviderCatalog,
    getSecret: (k) => secretVault.get('@omadia/orchestrator', k),
    onDefaultsChanged: (providerId) => {
      void classDefaultRebuilder.onDefaultsChanged(providerId);
    },
  });
  // #1033 W1 — the kernel's own provider pool: same credentials source as the
  // orchestrator plugin (the vault scope `@omadia/orchestrator`), same
  // catalog, memoised per provider id. Consumed by the dynamic sub-agent
  // runtime today; the model-policy validation (W2) reads `usable()` from it.
  // #1080 — created here, before the provider-plugin boot loop below, so the
  // catalog register/unregister helpers can invalidate it.
  const kernelProviderPool = createLlmProviderPool({
    getSecret: (k) => secretVault.get('@omadia/orchestrator', k),
    catalog: llmProviderCatalog,
    // The orchestrator's own retry budget (see harness-orchestrator plugin.ts);
    // the pool is shared with it from W3 on, so both sides agree.
    maxRetries: 5,
  });
  // #1033 W3 — published for the orchestrator plugin (`llmProviderPool@1`,
  // optional_requires) so the fallback circuit breaker has ONE state for the
  // turn loop and the providers admin page. Provided here, before any plugin
  // activates, like `llmProviderCatalog`.
  serviceRegistry.provide('llmProviderPool', kernelProviderPool);
  // #1080 — the pool memoises per provider id, including a negative "no key"
  // answer, so it must hear about every credential write. Subscribing on the
  // vault (not on the reactivate helper) covers every write path: admin
  // settings, the runtime-secrets PATCH, install-time seeding, uninstall
  // purge, the OAuth token-store binding and the Spec-005 OAuth broker. The
  // listener runs before the write's promise settles, i.e. before any caller
  // reactivates the orchestrator.
  secretVault.onWrite(
    createProviderPoolCredentialListener({
      pool: kernelProviderPool,
      scope: '@omadia/orchestrator',
    }),
  );
  const registerProviderFromPlugin = (pluginId: string): void => {
    try {
      const descriptor = registerPluginLlmProvider(
        pluginCatalog.get(pluginId)?.manifest,
        installedRegistry.get(pluginId)?.config,
        llmProviderCatalog,
      );
      if (descriptor !== undefined) {
        console.log(
          `[middleware] llm provider '${descriptor.id}' registered from ${pluginId} (${String(descriptor.models.length)} seed model(s), baseURL ${descriptor.baseURL}, discovery ${descriptor.discovery !== undefined ? 'on' : 'off'})`,
        );
        // #1451 — registering under a BUNDLED id replaces the built-in
        // descriptor wholesale (baseURL, wire format, models) while the stored
        // credentials stay keyed on the id. That was silent; say it out loud,
        // so a deployment whose traffic suddenly runs through a plugin's
        // baseURL can see why.
        if (llmProviderCatalog.isBundled(descriptor.id)) {
          console.warn(
            `[middleware] llm provider '${descriptor.id}' from ${pluginId} SHADOWS the bundled provider of the same id — its baseURL (${descriptor.baseURL}) and models now serve that id, with the stored '${descriptor.id}' credentials; uninstalling the plugin restores the built-in`,
          );
        }
        // #1080 — the descriptor decides keyless/oauth/baseURL/wire format;
        // a cached resolution against the previous one is stale.
        kernelProviderPool.invalidate(descriptor.id);
        if (descriptor.discovery !== undefined) {
          void modelCatalogSync.refresh(descriptor.id);
        }
      }
    } catch (err) {
      console.warn(
        `[middleware] skipped llm_provider block in ${pluginId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  };
  // Returns the provider id when the plugin contributed one and no provider of
  // that id is left afterwards (#1468 — its stored credentials are orphaned
  // then); `undefined` otherwise, including when a bundled one was restored.
  const unregisterProviderFromPlugin = (pluginId: string): string | undefined => {
    let id: string | undefined;
    try {
      id = unregisterPluginLlmProvider(
        pluginCatalog.get(pluginId)?.manifest,
        llmProviderCatalog,
      );
    } catch (err) {
      // A MALFORMED block never registered — nothing to clean up, and that is
      // the ordinary case here. A throw from the catalog itself (#1451: the
      // base-layer restore re-registers the bundled models) is not, and it
      // leaves the id unregistered with no invalidate/refresh/rebuild — so say
      // so instead of swallowing it.
      console.warn(
        `[middleware] llm provider cleanup for ${pluginId} did not complete:`,
        err instanceof Error ? err.message : err,
      );
      return undefined;
    }
    if (id === undefined) return undefined;
    kernelProviderPool.invalidate(id);
    // #1451 — the catalog restores a BUNDLED descriptor the plugin had
    // shadowed, so the id is a live provider again. Heal the consumers the way
    // the install path does: the restored models are an offline seed (discovery
    // ran against the plugin's catalog), and orchestrator, verifier and extras
    // still hold what they resolved while the plugin was installed. Kept
    // OUTSIDE the catch above so a throw in the healing itself is visible
    // rather than read as "malformed manifest".
    const restored = llmProviderCatalog.get(id);
    console.log(
      `[middleware] llm provider '${id}' unregistered (plugin ${pluginId} uninstalled)${
        restored !== undefined
          ? ` — bundled provider restored (${String(restored.models.length)} seed model(s), baseURL ${restored.baseURL})`
          : ''
      }`,
    );
    if (restored === undefined) return id;
    if (restored.discovery !== undefined) {
      void modelCatalogSync.refresh(id);
    }
    void classDefaultRebuilder.onDefaultsChanged(id);
    return undefined;
  };

  // Populate the LLM provider catalog from INSTALLED plugins at boot. Done
  // BEFORE `toolPluginRuntime.activateAllInstalled()` so the orchestrator
  // resolves a plugin-contributed provider at its own activate().
  for (const entry of pluginCatalog.list()) {
    if (!installedRegistry.has(entry.plugin.id)) continue;
    registerProviderFromPlugin(entry.plugin.id);
  }

  // #575 / #2048 — the audience floor's grant store. Published HERE, before
  // `activateAllInstalled()`, because the orchestrator plugin reads the
  // services it consumes at its own activate(); the Postgres part is
  // LATE-BOUND because the pool it needs is itself published by the
  // knowledge-graph plugin during that same activation pass and is only
  // readable afterwards. `audienceGrantStoreRef` is filled in below, where
  // `graphPool` resolves — the same forward-reference shape the conductor's
  // template registrar uses.
  //
  // Since #2048 the floor is on by default. `MemberBaselineGrantStore` gives
  // every resolved person the member baseline (`AUDIENCE_BASELINE_GRANTS`) on
  // top of the stored grants, so an instance without a seeded grant table
  // keeps working while unresolvable participants and explicit prohibitions
  // still bind the room. Without Postgres only the baseline applies.
  //
  // Nothing is published when the operator switched the floor off, and that
  // absence is what keeps the three guards inert ("not enforced ≠ closed").
  let audienceGrantStoreRef: PostgresGrantStore | undefined;
  // #575 pins each attachment handle to the room that minted it. Since #1960
  // (ADR-0178) this is chat isolation, not an audience rule: it applies with
  // the floor on or off, and a read needs a binding written when a channel
  // adapter stated the upload. Postgres keeps the pins; without it they live
  // in memory for the process lifetime (dev / single-instance desktop).
  let attachmentBindingStoreRef: AttachmentBindingStore | undefined = config.DATABASE_URL
    ? undefined
    : new InMemoryAttachmentBindingStore();
  serviceRegistry.provide(
    'attachmentBindings',
    createLateBoundAttachmentBindingStore(() => attachmentBindingStoreRef),
  );
  if (config.AUDIENCE_FLOOR_ENABLED) {
    const storedGrants = config.DATABASE_URL
      ? createLateBoundGrantStore(() => audienceGrantStoreRef)
      : undefined;
    const audienceGrants =
      config.AUDIENCE_BASELINE_GRANTS === 'member'
        ? new MemberBaselineGrantStore(storedGrants)
        : storedGrants;
    if (!audienceGrants) {
      throw new Error(
        '[middleware] AUDIENCE_BASELINE_GRANTS=none requires Postgres (DATABASE_URL) — ' +
          'without stored grants the floor would refuse every tool call in every room.',
      );
    }
    serviceRegistry.provide('audienceGrants', audienceGrants);
    console.log(
      `[middleware] audience floor ENABLED (baseline=${config.AUDIENCE_BASELINE_GRANTS}, grants=${
        config.DATABASE_URL ? 'Postgres' : 'baseline only'
      }) — rooms are limited to what every participant may do`,
    );
  }

  // Spec 2042 §5.4 / §5.11 (#2047, #2079) — the consultation broker behind the
  // `consult` tool and the discretion stores. Published HERE, before plugin
  // activation, for the same reason as `audienceGrants` above: the orchestrator
  // reads them at its own activate(). Both are late-bound to `graphPool`; a
  // call before the pool exists fails (the broker refuses the consultation, a
  // label lookup fails closed). The broker re-reads its offering snapshot in
  // the background; operator writes refresh it at once.
  const discretionStore = new DiscretionStore(
    () => serviceRegistry.get<Pool>('graphPool'),
    (m) => console.warn(m),
    // Criterion 17 — what a plugin's tools declare in its manifest.
    (system) => pluginCatalog.get(system)?.plugin.tool_side_effects,
  );
  const consultationStore = new ConsultationStore(() => serviceRegistry.get<Pool>('graphPool'));
  const consultationBroker = createConsultationBroker({
    store: consultationStore,
    getRegistry: () => serviceRegistry.get<MultiOrchestratorRegistry>('orchestratorRegistry'),
    audit: (entry) => discretionStore.audit(entry),
    log: (m) => console.log(m),
  });
  serviceRegistry.provide('discretion', discretionStore);
  // #2194 — a stored process keeps the labels of the turns that wrote it and
  // hands them to every turn that reads it (process tools, plan-runner reuse,
  // context recall), whoever provides `processMemory`.
  serviceRegistry.decorateOnProvide<ProcessMemoryService>('processMemory', (inner) =>
    labelProcessMemory(inner, discretionStore),
  );
  serviceRegistry.provide('consultation', consultationBroker);
  // The offering snapshot is read once the pool exists (after plugin
  // activation, below); until then `consult` is simply not offered.

  // Phase B (B1) — publish `pluginCapabilities@1` so the registry's snapshot
  // validation has manifest metadata (multi_instance / installed /
  // memory-scope) to reject impossible configurations. (#2054: it no longer
  // lists installed plugins for a first-boot attach — the seed holds none.)
  //
  // Sourced from the freshly-loaded PluginCatalog + InstalledRegistry —
  // published BEFORE `toolPluginRuntime.activateAllInstalled()` further
  // down so the orchestrator plugin sees it at consume-time.
  serviceRegistry.provide('pluginCapabilities', {
    isMultiInstance(pluginId: string): boolean | undefined {
      const entry = pluginCatalog.get(pluginId);
      if (!entry) return undefined;
      return entry.plugin.multi_instance !== false;
    },
    isInstalled(pluginId: string): boolean | undefined {
      const entry = pluginCatalog.get(pluginId);
      if (!entry) return undefined;
      return installedRegistry.has(pluginId);
    },
    getMemoryScope(pluginId: string): readonly string[] | undefined {
      const entry = pluginCatalog.get(pluginId);
      if (!entry) return undefined;
      const summary = entry.plugin.permissions_summary;
      const reads = Array.isArray(summary?.memory_reads)
        ? summary.memory_reads
        : [];
      const writes = Array.isArray(summary?.memory_writes)
        ? summary.memory_writes
        : [];
      return Array.from(new Set([...reads, ...writes]));
    },
    // #2060 — the one plugin a facilitator-kind agent may be granted.
    facilitatorGrantable(): readonly string[] {
      return facilitatorGrantablePluginIds(facilitationEngineSources());
    },
  });

  // Slice 2.5 — cross-plugin runtime-config reader. Published as a kernel
  // service so the orchestrator plugin (which activates BEFORE most tool
  // plugins) can resolve any other installed plugin's `_privacy_mode`
  // setting at dispatch time without having to import the installed
  // registry directly. Reads only the non-secret config bag; secrets are
  // never exposed via this surface. Returns `undefined` for both unknown
  // plugins and unknown keys — the caller treats both as "no override".
  serviceRegistry.provide(
    'installedPluginConfigReader',
    (agentId: string, configKey: string): unknown => {
      return installedRegistry.get(agentId)?.config?.[configKey];
    },
  );

  // Issue #474 — per-plugin tool-readiness gate for the orchestrator. Two
  // independent signals are ANDed, either can withhold readiness:
  //   (a) PluginStatusRegistry (spec 004) — the plugin's own, explicit
  //       `ctx.status.report(...)`: `needs_action` / `error` means a
  //       required setup/connection step is pending per the plugin's OWN
  //       code.
  //   (b) OAuthReadinessTracker (round 5) — automatic: a `type:'oauth'`
  //       setup field whose Connect flow has not completed yet, derived
  //       from the same vault state `ctx.oauthTokens` reads, WITHOUT
  //       requiring the plugin author to write an explicit status.report()
  //       call for the common OAuth case (installService.ts installs and
  //       activates a `type:'oauth'` plugin — registering its tools —
  //       before the operator has clicked Connect).
  // Either "not ready" keeps the plugin's `ctx.tools.register()`-contributed
  // tools out of the orchestrator's tool list and refuses them at dispatch.
  // Deliberately separate from the MCP-server-specific auth flow
  // (mcpOAuthService) — this only gates native-plugin tool registrations.
  serviceRegistry.provide(
    'installedPluginToolsReadyReader',
    (agentId: string): boolean =>
      pluginStatusRegistry.isReady(agentId) &&
      oauthConnectionTracker.isConnected(agentId),
  );

  // #1016 — per-turn owner guard for the subscription-CLI runtime. Published
  // here, and not defaulted inside the orchestrator package, because the store
  // it has to read (`routineTurnContext`) lives in this layer. The orchestrator
  // plugin resolves it as `routineTurnOwnerGuard` and forwards it into
  // `CliChatAgent`, where it runs inside the restored async context immediately
  // before a loopback dispatch. Unconditional: `routineTurnContext.enter` is
  // installed by channel adapters regardless of which backends are configured,
  // so the staleness this refuses does not depend on a pg pool.
  serviceRegistry.provide(
    ROUTINE_TURN_OWNER_GUARD_SERVICE_NAME,
    createRoutineTurnOwnerGuard(),
  );

  // #1085 — the ONE rule for resolving a CLI binary, published so the spawn
  // sites in `@omadia/orchestrator` use it too. The detector, the login flow
  // and the "Install now" button already resolve through `resolveCliBin`
  // (runtime install dir first, PATH second); the CLI chat agent spawned the
  // bare name, so a runtime install changed the version badge and nothing
  // else — including the probe that decides whether `--restricted` is passed.
  // Provided as the rule itself, not a resolved path: `resolveCliBin` checks
  // the filesystem per call, which is what makes an install visible on the
  // next turn instead of the next restart.
  serviceRegistry.provide(
    CLI_BINARY_RESOLVER_SERVICE_NAME,
    (bin: string): string => resolveCliBin(bin),
  );

  // Kernel-wide background-job scheduler. Plugin-contributed jobs (cron or
  // interval) register here via `ctx.jobs.register(...)`. Bulk teardown on
  // plugin deactivate is owned by each runtime, so a leaked dispose handle
  // still cannot outlive its plugin's lifecycle.
  const jobScheduler = new JobScheduler({
    log: (msg) => console.log(msg),
  });

  // Live model discovery, boot run: every connected provider with discovery
  // rules is asked for its current model list here (fire-and-forget — boot
  // never waits on a vendor), again after a key verifies, on the admin
  // "refresh models" action, and on the periodic timer. Built-ins AND
  // installed provider plugins are already in the catalog at this point.
  void modelCatalogSync.refreshAll().then((results) => {
    const summary = results
      .map((r) => `${r.providerId}=${r.status}${r.status === 'discovered' ? `(${String(r.models)})` : ''}`)
      .join(', ');
    console.log(`[middleware] model discovery at boot: ${summary || 'no provider with discovery rules'}`);
  });
  modelCatalogSync.start(config.LLM_MODEL_DISCOVERY_INTERVAL_MS);

  // agentToolInvoker — the kernel half of the deterministic-action fast-path.
  // Lets the ui-orchestrator run ONE plugin tool by id directly (no model
  // loop) when a canvas action names a deterministic tool. This deliberately
  // does NOT add these tools to the main orchestrator's offered-tool list.
  // Spec 2042 §5.10 — the tools are the ones capability plugins registered
  // with the kernel; plugin tools have no streaming variant.
  //
  // #1598 — the canvas runs on the standard orchestrator (chatAgent@1), so a
  // tool reached here must belong to a plugin assigned to it. Without a
  // registry (Postgres-less boot) there is no assignment to check.
  const standardOrchestratorGrants = (toolId: string): boolean => {
    const owner = pluginToolOwner(nativeToolRegistry, toolId);
    if (owner === undefined) return true; // nothing to run — invoke answers undefined
    const registry =
      serviceRegistry.get<MultiOrchestratorRegistry>('orchestratorRegistry');
    if (!registry) return true;
    // #2055 — the canvas runs on the instance's default agent.
    const slug = registry.instanceDefaultSlug();
    const standard = slug ? registry.get(slug)?.built.orchestrator : undefined;
    return standard?.isToolGranted(toolId, owner) === true;
  };
  serviceRegistry.provide('agentToolInvoker', {
    invoke: (toolId: string, input: unknown): Promise<string | undefined> =>
      standardOrchestratorGrants(toolId)
        ? invokePluginTool(nativeToolRegistry, toolId, input)
        : Promise.resolve(undefined),
    hasStream: (): boolean => false,
    invokeStream: (): AsyncGenerator<string> => (async function* () {})(),
  });

  // Runtime for capability, model, archetype and system-module plugins
  // (`pluginRuntimeOf` → `tool`). Their activate() registers directly into
  // the kernel's native-tool / route registries.
  // Service-type auto-discovery (no-restart): tracks which `serviceTypeRegistry`
  // names each plugin registered at activation, so deactivation can
  // unregister EXACTLY those — independent of whether the catalog entry still
  // exists (uninstall may have reloaded the catalog and dropped it first).
  const registeredServiceTypesByPlugin = new Map<string, string[]>();
  // Plugin self-extension (Theme A + B). The gate holds the in-memory proposal
  // store (shared by the agent-in-loop `request_self_extension` tool and the
  // operator routes); the registry holds plugins' declared extension templates;
  // the store persists operator-approved extensions, replayed on each activate.
  const selfExtensionGate = new OperatorGate();
  const selfExtendRegistry = new SelfExtendRegistry();
  const extensionStore = new ExtensionStore(
    path.join(DATA_DIR, 'self-extensions.json'),
  );
  await extensionStore.load();

  // Agent-in-loop auto-author tool — a kernel native tool available to every
  // agent; submits proposals as `pending` (never auto-approved).
  {
    const reqTool = createRequestSelfExtensionTool({
      gate: selfExtensionGate,
      pluginCatalog,
      selfExtendRegistry,
      notificationRouter,
    });
    nativeToolRegistry.register(reqTool.name, {
      handler: reqTool.handler,
      spec: reqTool.spec,
      promptDoc: reqTool.promptDoc,
    });
  }

  // Forward reference: re-bind every domain tool after a POST-BOOT
  // re-activation of the orchestrator plugin (provider switch, secret save,
  // reactivate), which publishes a fresh chat Orchestrator and a fresh
  // per-Agent registry — both without domain tools. Assigned in the
  // orchestrator-wiring block far below (it needs the hydration closures) and
  // called from `onActivated` here; the boot activation runs before the
  // assignment and stays a no-op, since the boot block hydrates itself.
  // eslint-disable-next-line prefer-const -- assigned further below; closures read it first
  let rebindOrchestratorToolsRef: (() => void) | undefined;
  // The shared Anthropic client refresher, defined further below. Awaited
  // before the re-bind so DB-defined sub-agents are hydrated with the client
  // that holds the key just saved, not the one before it.
  // eslint-disable-next-line prefer-const -- assigned further below; closures read it first
  let refreshSharedAnthropicClientRef: (() => Promise<void>) | undefined;

  // #1556 follow-up — field-classification recompute trigger. Assigned once
  // Postgres is known (far below); plugin activations/deactivations before
  // that (the boot pass) stay no-ops — the wiring schedules its own first pass.
  let fieldClassificationTriggerRef: ((reason: string) => void) | undefined;

  const toolPluginRuntime = new ToolPluginRuntime({
    catalog: pluginCatalog,
    registry: installedRegistry,
    vault: secretVault,
    uploadedStore: uploadedPackageStore,
    builtInStore: builtInPackageStore,
    serviceRegistry,
    // Epic #470 C7 / G4 — resolved per call, not captured: `graphPool` is
    // published by a plugin THIS runtime activates, ~600 lines below where the
    // runtime is built, so a store bound here would be permanently null.
    sqlGrantStore,
    // #2088 — an archetype plugin's database: own schema, own login roles,
    // never the pool above. The roles connect to the address the kernel
    // itself uses (through the pooler when that is a pooled address).
    archetypeDatabase: createArchetypeDatabase({
      adminPool: () => serviceRegistry.get<Pool>('graphPool'),
      connectionString: config.DATABASE_URL,
      secret: masterKey.key,
      poolOptions: scramOnlyPoolOptions(),
      log: (msg) => {
        console.log(msg);
      },
    }),
    nativeToolRegistry,
    pluginRouteRegistry,
    // Epic #470 C4 / H1 — declared public-path prefixes are claimed here on
    // activate and released on deactivate. `corePublicPaths` is the SAME array
    // requireAuth runs against, so a plugin can never declare a prefix that is
    // already a static core exemption.
    publicPathGrants,
    publicPathGrantStore,
    corePublicPaths: publicPaths(),
    notificationRouter,
    uiRouteCatalog,
    jobScheduler,
    flowSigningKey: sessionSigningKey,
    flowPublicBaseUrl,
    pluginStatusRegistry,
    operatorAuth,
    oauthConnectionTracker,
    selfExtendRegistry,
    extensionStore,
    canvasOutputRegistry,
    deterministicActionRegistry,
    eventCatalogRegistry,
    // When an integration plugin activates — at boot OR via a live hot-
    // install — register every `manifest.service_types` entry into the
    // agent-builder's `serviceTypeRegistry`, and link its package into the
    // shared build template so generated agents that `external_reads`
    // against it typecheck. `lookupServiceType()` is read live by the
    // manifest-linter and codegen, so a newly-online platform becomes
    // buildable immediately, with no middleware restart.
    // #1359 — stamped when the activation STARTS: a discovery run landing
    // while the plugin's activate() runs must still count as newer than what
    // it resolved.
    onActivating: (agentId) => classDefaultRebuilder.noteActivated(agentId),
    onActivated: async (entry, packagePath) => {
      // Debounced; never per chat turn. Covers the privacy guard itself and
      // every tool plugin whose fields it may observe.
      fieldClassificationTriggerRef?.(`activated ${entry.plugin.id}`);
      if (entry.plugin.id === '@omadia/orchestrator') {
        try {
          await refreshSharedAnthropicClientRef?.();
          rebindOrchestratorToolsRef?.();
        } catch (err) {
          console.error(
            '[middleware] re-binding domain tools after orchestrator re-activation FAILED:',
            err instanceof Error ? err.message : String(err),
          );
        }
      }
      const serviceTypes = entry.plugin.service_types ?? [];
      if (serviceTypes.length === 0) return;
      for (const st of serviceTypes) {
        registerServiceType(st.service, {
          providedBy: entry.plugin.id,
          typeImport: { from: st.type.from, name: st.type.name },
        });
      }
      registeredServiceTypesByPlugin.set(
        entry.plugin.id,
        serviceTypes.map((st) => st.service),
      );
      // The type packages a consumer imports `from` are — by the manifest
      // convention — exported by the activating plugin's own package, whose
      // on-disk root is `packagePath`. Link each unique `from` so tsc
      // resolves `import type { X } from '<from>'`. A no-op before the build
      // template exists (boot ordering) — the boot reconciliation below then
      // links it once node_modules is provisioned.
      const uniqueFroms = new Set(serviceTypes.map((st) => st.type.from));
      for (const from of uniqueFroms) {
        const res = await linkWorkspacePackageIntoTemplate(
          BUILDER_BUILD_TEMPLATE_DIR,
          from,
          packagePath,
        );
        if (!res.linked) {
          console.log(
            `[builder] service-type package '${from}' not linked into build ` +
              `template (${res.reason ?? 'unknown'}); boot pass will cover it.`,
          );
        }
      }
      console.log(
        `[builder] registered ${serviceTypes.length} service-type(s) from ${entry.plugin.id}`,
      );
    },
    onDeactivated: (agentId) => {
      fieldClassificationTriggerRef?.(`deactivated ${agentId}`);
      const names = registeredServiceTypesByPlugin.get(agentId);
      if (!names) return;
      for (const service of names) unregisterServiceType(service);
      registeredServiceTypesByPlugin.delete(agentId);
    },
    log: (msg) => console.log(msg),
  });

  // Forward reference for the channel registry — constructed later in boot
  // (after the channel-SDK adapters are wired up). The install hooks below
  // close over this variable so post-install activations dispatched to a
  // channel-kind plugin reach the right runtime once it exists.
  // `prefer-const` cannot see the late assignment at the
  // `channelRegistryRef = channelRegistry` line ~1400 LOC down — the rule
  // treats the unconditional initialiser-less declaration as "single
  // assignment". The forward-reference pattern is intentional: the
  // closures capture the binding so post-install activations dispatched
  // before the registry exists still hit the right runtime once it's wired.
  // eslint-disable-next-line prefer-const
  let channelRegistryRef: ChannelRegistry | undefined;

  // Forward reference for the conductor's composite template catalog (#478) —
  // wired inside the graphPool block far below, long after the install service
  // is constructed. The install service resolves it lazily so plugin-borne
  // workflow templates registered at runtime land in the catalog. Stays
  // undefined on the in-memory backend (conductor inert); the install-time
  // template VALIDATION gate runs regardless.
  let conductorTemplateRegistrarRef: PluginTemplateRegistrar | undefined;

  // Forward reference for the Conductor inbound-webhook router deps (issue #437) —
  // same pattern as the template registrar above. The router itself is mounted
  // further down, BEFORE express.json() (raw-body HMAC verification needs the
  // untouched bytes); the real deps (endpoint store, event router, vault) are only
  // built later inside the graphPool block's `wireConductor` call. By the time a real
  // request arrives, the assignment there has already run.
  let conductorWebhookInboundDepsRef: ConductorWebhookInboundDeps | undefined;

  // --- Runtime plugin activation propagation ------------------------
  // A plugin activated AFTER boot (operator install, Hub/registry install,
  // package re-upload, self-extension) may be the facilitation engine or carry
  // conversation subscriptions; `propagatePluginInstall` reconciles both. It
  // resolves its services LIVE from the serviceRegistry on every call, so it
  // works on a chat-disabled (key-less) boot too. Spec 2042 §5.10 — there are
  // no per-plugin domain tools to reconcile any more: a capability plugin's
  // tools are in the kernel-wide native tool registry, gated per agent.
  const ORCHESTRATOR_PLUGIN_ID = '@omadia/orchestrator';

  // #2054 / INV-8 (spec 2042) — no install path attaches a plugin to any
  // agent. Hub install, upload, store reinstall, profile apply and the
  // built-ins the boot seeds used to attach every plugin to the default agent
  // (#1491 / #1498), which made it a master key to every connected system.
  // The operator grants a capability plugin to the agents they pick (the
  // store's "grant to agents" step, `PATCH /api/v1/operator/agents/:slug/plugins`).
  // The one exception is archetype-specific, not a default-agent attach: the
  // facilitation engine goes to the facilitators (`attachFacilitationEngine`).

  /** #2043 — see `platform/facilitatorEngineAttach.ts`. Never throws. */
  const attachFacilitationEngine = (): Promise<void> =>
    syncArchetypesAndAttachEngine({
      // Which archetypes are delivered, and by whom: always, also without a
      // config store (no LLM access yet), before anything is attached.
      sync: () => archetypeRegistry.sync(),
      getStore: () => serviceRegistry.get<MultiOrchestratorConfigStore>('configStore'),
      attach: async (store) => {
        // S3c — first drop grants of an archetype plugin held by an agent of
        // another archetype (rows from before #2088), each with a warning.
        // Runs at boot too, before the admin audit log exists.
        await revokeForeignArchetypeGrants(store, pluginCatalog, (m) => console.warn(m));
        await attachEngineToFacilitators(store, facilitationEngineSources(), (m) => console.log(m));
      },
      reload: () => serviceRegistry.get<MultiOrchestratorRegistry>('orchestratorRegistry')?.reload(),
      log: (m) => console.error(m),
    });

  const propagatePluginInstall = async (pluginId: string): Promise<void> => {
    if (pluginId === ORCHESTRATOR_PLUGIN_ID) return;
    // #2043 — an engine installed (or replaced) while facilitators exist is
    // attached to them; nothing else ever is.
    await attachFacilitationEngine();
    void conversationMessagesRef.current?.reconcileNow();
    console.log(`[middleware] runtime plugin install propagated: ${pluginId}`);
  };

  // OM-95 / #1070 — one lazy getter for the `agent_plugins` binding store,
  // shared by uninstall (InstallService) and the bootstrap auto-removals. The
  // store only exists once `@omadia/orchestrator` has activated, so bootstrap
  // removals are queued here and flushed after the tool runtime is up, and
  // again whenever the orchestrator is (re)activated.
  const agentPluginBindingStore = (): MultiOrchestratorConfigStore | undefined =>
    serviceRegistry.get<MultiOrchestratorConfigStore>('configStore');
  const pendingBindingPurge = createPendingBindingPurge({
    getStore: agentPluginBindingStore,
    hasDatabase: Boolean(config.DATABASE_URL),
    isInstalled: (pluginId) => installedRegistry.has(pluginId),
  });

  const installService = new InstallService({
    catalog: pluginCatalog,
    registry: installedRegistry,
    vault: secretVault,
    // #478 — lazily resolved: the conductor's composite template catalog is
    // wired ~1400 LOC below (graphPool block). Undefined until then / on the
    // in-memory backend; the install-time template gate validates regardless.
    conductorTemplates: () => conductorTemplateRegistrarRef,
    // Epic #470 C16 / B6 — operator consent is purged with the plugin, so a
    // reinstall under the same id starts un-granted instead of inheriting the
    // previous package's database and unauthenticated routes.
    publicPathGrantStore,
    sqlGrantStore,
    agentPluginBindingStore,
    builtInOptOuts,
    // #1860 — orchestrator-extras wraps `knowledgeGraph` with `replace`; a hot
    // restart of the graph plugin then fails with "duplicate provider" and
    // leaves it `errored`, which crash-loops the next boot. Its new values
    // wait for the restart instead.
    reactivationBlocker: (agentId) => {
      const shadowed = serviceRegistry.shadowedServicesOf(agentId);
      return shadowed.length > 0
        ? `another plugin wraps its service(s) ${shadowed.map((n) => `'${String(n)}'`).join(', ')}`
        : undefined;
    },
    onInstalled: async (agentId) => {
      // A plugin may contribute an `llm_provider` block regardless of its kind
      // (provider plugins ship as `extension`). Register it FIRST — mirroring
      // the boot-time loop — so a runtime-installed provider lands in the
      // catalog + model registry and appears on the admin Providers page
      // without a restart. No-ops when the manifest declares no provider.
      registerProviderFromPlugin(agentId);
      // Dispatch by manifest.identity.kind. Built-ins return early from each
      // runtime's activate() when the plugin isn't in their store, so the
      // dispatch is safe.
      const kind = pluginCatalog.get(agentId)?.plugin.kind;
      switch (pluginRuntimeOf(kind)) {
        case 'channel':
          if (!channelRegistryRef) {
            console.warn(
              `[install] channel '${agentId}' installed before channelRegistry was wired — activation will run at next boot`,
            );
            return;
          }
          await channelRegistryRef.activate(agentId);
          await propagatePluginInstall(agentId);
          return;
        case 'tool':
          if (kind === 'archetype') {
            // #2088 — its archetype is registered BEFORE the activation and
            // whatever the activation's outcome: the descriptor says what
            // agents of the archetype never get, and that holds for a plugin
            // that did not start (it usually has no database grant yet at
            // this point).
            await archetypeRegistry.sync();
            await toolPluginRuntime.activate(agentId);
            // Attached to no agent; only to its own archetype's agents.
            await propagatePluginInstall(agentId);
            return;
          }
          await toolPluginRuntime.activate(agentId);
          // #1070 — a key-less boot activates the orchestrator without its
          // `configStore`; the store appears on this (re)activation, so drain
          // the bootstrap removals that were still waiting for it.
          if (agentId === ORCHESTRATOR_PLUGIN_ID) {
            await pendingBindingPurge.flush();
          }
          await propagatePluginInstall(agentId);
          return;
        case 'none':
          // Spec 2042 §5.10 — the retired kind `agent` has no runtime. A new
          // one is refused at install; this is a reactivation (setup save) of
          // one installed before. The caller records the error's
          // `kind_retired` (another code for a plugin the catalog lacks).
          throw noRuntimeError(agentId, kind);
      }
    },
    // #2088 — an uninstalled archetype plugin no longer delivers its archetype:
    // the kernel's own descriptor (where it has one) applies again.
    onUninstalled: async () => {
      await archetypeRegistry.sync();
    },
    onUninstall: async (agentId, reason) => {
      // #2088 — FIRST, while the plugin is still installed and running: the
      // agents of an archetype plugin go out of service and are disabled.
      // Not on a reactivation (the plugin comes straight back).
      if (reason === 'uninstall') {
        await guardArchetypePluginUninstall(agentId, {
          sources: () => ({ installedRegistry, catalog: pluginCatalog }),
          agents: () => {
            const store = serviceRegistry.get<MultiOrchestratorConfigStore>('configStore');
            return store
              ? {
                  list: () => store.listAgents(),
                  disable: async (id) => {
                    await store.updateAgent(id, { status: 'disabled' });
                  },
                }
              : undefined;
          },
          endOfService: agentEndOfService,
          audit: async (entry) => {
            await adminAudit?.record(entry);
          },
          reload: async () => serviceRegistry.get<MultiOrchestratorRegistry>('orchestratorRegistry')?.reload(),
          revokeExecutionOfPlugin: async (pluginId, reason) => ({
            scopesEnded: (await executionRef.current?.store.revokeAll({ pluginId }, reason))?.scopes.length ?? 0,
          }),
          log: (m) => console.log(m),
        });
      }
      // Symmetric to onInstalled: drop a contributed provider + its models so
      // an uninstalled provider plugin disappears from the admin Providers page
      // without a restart. Runs BEFORE runtime deactivation/registry removal.
      const goneProviderId = unregisterProviderFromPlugin(agentId);
      // #1468 — on a real uninstall the provider's key, verify stamp and OAuth
      // leaves leave the LLM scopes with it, as the uninstall dialog promises;
      // a reinstall then starts without a key. Not on reactivate (the plugin
      // comes straight back), and not when a bundled provider of the same id
      // was restored (it owns that key, #1451).
      const purgeBlocker =
        reason === 'uninstall' && goneProviderId !== undefined
          ? providerCredentialPurgeBlocker(goneProviderId, {
              builtinIds: new Set(
                [...BUILTIN_LLM_PROVIDERS, ...EXPERIMENTAL_LLM_PROVIDERS].map((d) => d.id),
              ),
              otherPluginsDeclaring: installedRegistry
                .list()
                .map((e) => e.id)
                .filter(
                  (id) =>
                    id !== agentId &&
                    pluginLlmProviderId(pluginCatalog.get(id)?.manifest) === goneProviderId,
                ),
            })
          : undefined;
      if (purgeBlocker !== undefined) {
        console.log(
          `[install] kept the stored credentials of provider '${String(goneProviderId)}' — ${purgeBlocker}`,
        );
      }
      if (reason === 'uninstall' && goneProviderId !== undefined && purgeBlocker === undefined) {
        const removed = await purgeProviderCredentials(secretVault, goneProviderId, {
          onError: (scope, err) => {
            console.error(
              `[install] could not purge provider '${goneProviderId}' credentials from ${scope}:`,
              err instanceof Error ? err.message : err,
            );
          },
        });
        if (removed.length > 0) {
          console.log(
            `[install] removed ${String(removed.length)} stored credential(s) of provider '${goneProviderId}' (${removed.join(', ')})`,
          );
        }
      }
      switch (pluginRuntimeOf(pluginCatalog.get(agentId)?.plugin.kind)) {
        case 'channel':
          if (channelRegistryRef?.isActive(agentId)) {
            await channelRegistryRef.deactivate(agentId);
          }
          return;
        case 'tool':
          // #2088 — includes kind `archetype`. It used to fall through to the
          // agent runtime, which knows no such plugin: its tools, routes and
          // services stayed registered after an uninstall.
          await toolPluginRuntime.deactivate(agentId);
          return;
        case 'none':
          // The retired kind `agent` runs no code: nothing to stop.
          return;
      }
    },
  });
  console.log(
    `[middleware] plugin runtime wired (installed registry + secret vault, persistent) — ${installedRegistry.list().length} installed`,
  );

  // OB-61 fix — the shared `llm` + `anthropicClient` ServiceRegistry providers
  // are registered ONCE at boot (above) from `config.ANTHROPIC_API_KEY`. On a
  // cold boot without that env var the key is '' and those providers capture an
  // unauthenticated Anthropic client for the whole process lifetime. The LLM
  // access page and the admin-secrets editor seed the real key into each
  // consumer plugin's vault and reactivate the plugin — but those plugins build
  // their OWN clients, so the SHARED providers stayed broken. Any plugin that
  // reaches the host LLM via `ctx.llm` (e.g. plan-runner's Haiku planning gate,
  // which swallows the resulting 401 and silently skips planning) then never
  // worked after a key entry.
  //
  // Fix: funnel every reactivation through `reactivateAgent`. When the
  // reactivated agent is the canonical host-key holder (@omadia/orchestrator),
  // re-read its freshly-seeded vault key and hot-swap the shared providers via
  // ServiceRegistry.replace(). Covers the LLM access page, a PATCH to
  // /api/v1/admin/runtime/installed/:id/secrets, the back-compat /setup seed,
  // and any future reactivate path. Idempotent: replacing with an equivalent client is
  // harmless when the key was already present via env. `ctx.llm` resolves the
  // 'llm' provider at call time, so already-active plugins pick up the swap on
  // their next call without re-activation.
  const ORCHESTRATOR_SECRET_SOURCE = '@omadia/orchestrator';
  // #1080 — the refresher also REVOKES: when the vault key is removed the
  // shared providers fall back to the env key, or to an unauthenticated ''
  // client (exactly what a keyless boot builds). Serialized, so the reactivate
  // path and the vault listener below cannot apply a stale read last.
  const sharedAnthropicClientRefresher = createSharedAnthropicClientRefresher({
    readVaultKey: () =>
      readProviderApiKey(
        (k) => secretVault.get(ORCHESTRATOR_SECRET_SOURCE, k),
        'anthropic',
      ),
    envKey: config.ANTHROPIC_API_KEY,
    apply: (apiKey) => {
      const refreshed = createAnthropicClient({ apiKey, maxRetries: 5 });
      serviceRegistry.replace('anthropicClient', refreshed);
      serviceRegistry.replace(
        'llm',
        createAnthropicLlmProvider({
          client: refreshed,
          log: (...args) => console.log('[llm]', ...args),
        }),
      );
    },
  });
  // Path-independent trigger: any write of an Anthropic key leaf in the host
  // scope (or a purge of it) re-sources the shared client, even on write paths
  // that never call `reactivateAgent` (install seeding, the OAuth broker).
  secretVault.onWrite((event) => {
    if (event.scope !== ORCHESTRATOR_SECRET_SOURCE) return;
    const touchesAnthropicKey =
      'purged' in event ||
      event.keys.some(
        (k) => classifyProviderCredentialKey(k)?.providerId === 'anthropic',
      );
    if (touchesAnthropicKey) void sharedAnthropicClientRefresher.refresh();
  });
  const reactivateAgent = async (agentId: string): Promise<void> => {
    await installService.reactivate(agentId);
    // Live key-entry path (LLM access page, or a PATCH to
    // /api/v1/admin/runtime/installed/:id/secrets): the consumer plugin's
    // vault was just (re)seeded. Re-source the shared providers so any
    // plugin reaching the host LLM via `ctx.llm` picks up the real key without
    // a restart. (The orchestrator's `onActivated` already awaited one refresh
    // before the domain-tool re-bind; this second one is a cheap, serialized
    // no-op then, and stays for any path where that hook did not run.)
    if (agentId === ORCHESTRATOR_SECRET_SOURCE) {
      await sharedAnthropicClientRefresher.refresh();
    }
  };
  reactivateAgentRef = reactivateAgent;
  refreshSharedAnthropicClientRef = () => sharedAnthropicClientRefresher.refresh();

  // ── Vault off-site backup ─────────────────────────────────────────────────
  // Only starts when VAULT_BACKUP_ENABLED=true AND Tigris/SeaweedFS credentials
  // are present. Uploads ciphertext only; the master key never leaves the
  // machine. Disabled state is still observable via /api/v1/admin/vault-status.
  let vaultBackupService: VaultBackupService | null = null;
  let vaultBackupDisabledReason: string | undefined;
  if (!config.VAULT_BACKUP_ENABLED) {
    vaultBackupDisabledReason = 'VAULT_BACKUP_ENABLED=false';
  } else if (
    !config.BUCKET_NAME ||
    !config.AWS_ENDPOINT_URL_S3 ||
    !config.AWS_ACCESS_KEY_ID ||
    !config.AWS_SECRET_ACCESS_KEY
  ) {
    vaultBackupDisabledReason =
      'S3 credentials missing (BUCKET_NAME / AWS_ENDPOINT_URL_S3 / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY)';
    console.warn(
      `[middleware] ⚠ vault backup disabled — ${vaultBackupDisabledReason}`,
    );
  } else {
    vaultBackupService = new VaultBackupService({
      endpoint: config.AWS_ENDPOINT_URL_S3,
      accessKeyId: config.AWS_ACCESS_KEY_ID,
      secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
      bucket: config.BUCKET_NAME,
      prefix: config.VAULT_BACKUP_PREFIX,
      retention: config.VAULT_BACKUP_RETENTION,
      intervalHours: config.VAULT_BACKUP_INTERVAL_HOURS,
      files: [
        {
          localPath: VAULT_PATH,
          name: 'vault',
          contentType: 'application/json',
        },
        {
          localPath: INSTALLED_REGISTRY_PATH,
          name: 'installed-registry',
          contentType: 'application/json',
        },
        {
          localPath: builtInOptOutsPathFor(INSTALLED_REGISTRY_PATH),
          name: 'builtin-uninstalls',
          contentType: 'application/json',
        },
      ],
    });
    vaultBackupService.start();
  }

  // One-time legacy migration: .env → vault + registry. Idempotent.
  // Plus: seed built-in packages into the registry so they auto-activate on
  // first boot (respects operator removals on subsequent boots).
  await runLegacyBootstrap({
    config,
    catalog: pluginCatalog,
    registry: installedRegistry,
    vault: secretVault,
    builtInStore: builtInPackageStore,
    // #1070 — queue only; the binding store does not exist yet at this point.
    onPluginRemoved: (pluginId) => {
      pendingBindingPurge.enqueue(pluginId);
    },
    builtInOptOuts,
  });

  // S+8.5 sub-commit-3 — Auto-reset errored plugins whose root cause has
  // been addressed since the last boot (manifest mtime newer than the
  // recorded error timestamp, or every persisted unresolved capability
  // now provided by an active installed plugin). Runs after the legacy
  // bootstrap so newly-seeded built-ins can be reset; runs before
  // `toolPluginRuntime.activateAllInstalled()` so the reset takes effect
  // on this very boot rather than the next one.
  await retryErroredPlugins({
    catalog: pluginCatalog,
    registry: installedRegistry,
    builtInStore: builtInPackageStore,
    uploadedStore: uploadedPackageStore,
  });

  // Spec 2042 §5.10 — the kernel runs no plugin of the retired kind `agent`.
  // One still installed is recorded `errored` (`kind_retired`) so the store
  // shows it as not started; the boot goes on. Right after the retry above
  // (which may have lifted it to `active`) and before any runtime or the
  // capability resolution reads the registry.
  await blockRetiredAgentPlugins({
    registry: installedRegistry,
    catalog: pluginCatalog,
    log: (m) => console.warn(m),
  });

  // ── Admin auth (A.1) ──────────────────────────────────────────────────────
  // `sessionSigningKey` (and `emailWhitelist`) are resolved earlier (right
  // after the vault loads) so the plugin runtimes can also use them —
  // `sessionSigningKey` for `ctx.flows` state signing, both together for
  // `ctx.operatorAuth` (issue #438 follow-up).
  // OM-92 — the empty-allowlist warning is scoped to the provider that
  // actually reads the allowlist (entra). On a local-password-only install it
  // used to claim "every sign-in will 403" while the very next boot line
  // reported a healthy `1 active: local` registry.
  if (
    shouldWarnEmptyAdminAllowlist({
      authProviders: config.AUTH_PROVIDERS,
      hasMicrosoftCredentials: Boolean(
        config.MICROSOFT_APP_ID &&
          config.MICROSOFT_APP_PASSWORD &&
          config.MICROSOFT_APP_TENANT_ID,
      ),
      whitelistIsEmpty: emailWhitelist.isEmpty(),
    })
  ) {
    console.warn(
      '[middleware] ⚠ ADMIN_ALLOWED_EMAILS is empty — every Entra sign-in will 403 until the secret is set',
    );
  } else if (!emailWhitelist.isEmpty()) {
    console.log(
      `[middleware] admin whitelist ready (${emailWhitelist.size()} email(s))`,
    );
  }
  const authRefreshStore = new RefreshStore(secretVault);
  const authRedirectUri =
    config.AUTH_REDIRECT_URI ??
    `${config.PUBLIC_BASE_URL}/api/v1/auth/login/entra/cb`;
  const oauthClient =
    config.MICROSOFT_APP_ID &&
    config.MICROSOFT_APP_PASSWORD &&
    config.MICROSOFT_APP_TENANT_ID
      ? new OAuthClient({
          tenantId: config.MICROSOFT_APP_TENANT_ID,
          clientId: config.MICROSOFT_APP_ID,
          clientSecret: config.MICROSOFT_APP_PASSWORD,
          redirectUri: authRedirectUri,
        })
      : null;
  if (!oauthClient) {
    // #1323 — only Entra is off here. The auth router is mounted regardless,
    // and local sign-in works; the real 503 fallback (no graph pool) logs its
    // own warning further down.
    console.warn(
      '[middleware] ⚠ Entra sign-in disabled (MICROSOFT_APP_* missing). Local login is unaffected.',
    );
  } else {
    console.log(
      `[middleware] admin OAuth wired (redirect=${authRedirectUri})`,
    );
  }
  const sessionDeps = {
    signingKey: sessionSigningKey,
    whitelist: emailWhitelist,
    sessions: sessionRevocation,
  };
  const requireAuth = createRequireAuth({
    ...sessionDeps,
    // OB-106 mounted requireAuth at /api which collaterally gated the
    // public auth endpoints (login providers, login, setup) AND every
    // channel-plugin webhook mounted under /api/* (Teams Bot Framework
    // POSTs /api/messages with its own JWT — the middleware session
    // cookie is meaningless there). The public-paths list short-circuits
    // those so the channel plugins can run their own auth downstream —
    // same protection as before for `/api/chat`, `/api/v1/operator/*`,
    // `/api/v1/admin/*`, etc. since none of them match these regexes.
    publicPaths: publicPaths(),
  });
  // Epic #470 C6 / G2 — the plugin route registry's `auth: 'session'` gate.
  // Same deps object as `requireAuth`, so both agree on what a valid operator
  // session is, but WITHOUT the `publicPaths` short-circuit: issue #1596 — the
  // short-circuit let every `/p/<plugin>/…` "session" route answer anonymous
  // callers. A plugin route is reached without a session only through the
  // operator-granted public-path mount, never through the static allowlist.
  kernelRequireAuthRef.current = createSessionGate(sessionDeps);

  // ContextRetriever + FactExtractor construction moved to AFTER
  // `toolPluginRuntime.activateAllInstalled()` below — they consume
  // `knowledgeGraph` published by @omadia/knowledge-graph's activate()
  // (S+8 sub-commit 2b). Mirrors the post-activate consumption pattern used
  // by `memoryStore`, `microsoft365.graph`, `confluence.client`, etc.

  // --- Attachment store (S3 / Tigris / SeaweedFS, or a local directory) ---------
  // The render_diagram tool + /diagrams route are contributed by the
  // @omadia/diagrams plugin (middleware/packages/harness-diagrams), which
  // builds its own S3 client. The kernel's store is a separate consumer of the
  // same bucket: Teams-attachment persistence and the orchestrator's attachment
  // reader. Without a bucket, ATTACHMENT_STORE_DIR selects a local directory
  // (the desktop app's "Attachments" switch); see platform/attachmentStore.ts.
  const attachmentStore = selectAttachmentStore(config);
  if (attachmentStore.store) {
    // Phase 5B: publish so dynamic-imported channel plugins (Teams) can
    // late-resolve the attachment store via ctx.services.get('tigrisStore')
    // instead of constructor-injected Deps.
    serviceRegistry.provide('tigrisStore', attachmentStore.store);
  }
  console.log(attachmentStore.message);

  // enrich_company tool is now contributed by the Odoo integration plugin's
  // activate() via ctx.tools.register — construction moved in phase-2.2-iii.
  // The Orchestrator consumes the tool through NativeToolRegistry's generic
  // dispatch + promptDoc aggregation (same path as render_diagram).

  // S+10-4a: the five kernel-side native tools (chatParticipants /
  // askUserChoice / suggestFollowUps / findFreeSlots / bookMeeting) are
  // now constructed inside the @omadia/orchestrator plugin's
  // activate() — they're orchestrator-internal concerns, no kernel-side
  // consumer left them.
  // #796 (epic #470 C9 / G3) — core's own base schema, applied by core,
  // BEFORE any plugin activates and independent of every provider key.
  //
  // This used to be a side effect of the harness-orchestrator plugin
  // activating, which returns early when no LLM provider is configured — so a
  // deployment without an Anthropic key had no `_multi_orchestrator_migrations`
  // ledger, no `plugin_public_path_grants` and no `plugin_sql_grants`, and
  // therefore no way to record either operator consent. Nothing logged it,
  // because no migration was ever attempted.
  //
  // Ordering is load-bearing, not tidiness: `ToolPluginRuntime` reads a plugin's
  // SQL-grant row while building its context, so the grant tables have to exist
  // by the time the line below runs. See `platform/coreMigrations.ts` for why it
  // opens its own connection instead of waiting for `graphPool`.
  const coreMigrations = await runCoreMigrations({
    databaseUrl: process.env['DATABASE_URL'],
    log: (m) => { console.log(m); },
  });
  console.log(
    coreMigrations === 'no-database'
      ? '[middleware] core migrations SKIPPED — no DATABASE_URL (in-memory backend)'
      : '[middleware] core migrations applied (middleware/migrations)',
  );

  // Activate tool / extension / integration plugins FIRST. Their
  // activate() populates nativeToolRegistry + pluginRouteRegistry +
  // serviceRegistry (incl. the MemoryStore provided by @omadia/memory
  // and the Microsoft365Accessor provided by @omadia/integration-microsoft365).
  // Agents below consume these services through ctx, so the tool runtime
  // must run before the agent runtime.
  // #2042 — `humanNames@1`: the active users' names, so an agent's own name a
  // colleague bears stays masked in its own turn. Published before plugin
  // activation; the users table is attached once the database is up (UserStore
  // below). Unknown until the first load, which exempts no own name. Names are
  // never logged.
  const humanNameDirectory = new HumanNameDirectory({ log: (m) => console.warn(m) });
  serviceRegistry.provide<HumanNamesProvider>(HUMAN_NAMES_SERVICE, () =>
    humanNameDirectory.snapshot(),
  );
  // #2191 / #2192 — `agentNames@1`: the roster's agent names minus every name
  // an active user bears, never masked by the privacy guard. Published before
  // plugin activation like `humanNames@1`; `null` until the registry is up.
  serviceRegistry.provide<AgentNamesProvider>(
    AGENT_NAMES_SERVICE_NAME,
    createAgentNamesProvider({
      registry: () => serviceRegistry.get<MultiOrchestratorRegistry>('orchestratorRegistry'),
      humanNames: () => humanNameDirectory.snapshot(),
    }),
  );
  await toolPluginRuntime.activateAllInstalled();
  console.log(
    `[middleware] tool plugin runtime: ${toolPluginRuntime.activeIds().length} tool/extension/integration package(s) active`,
  );
  // Entries of the registry whose package is gone are visited by no runtime
  // (each walks the packages), so nothing ever reports them. Once per boot.
  warnPackagelessEntries(installedRegistry, [uploadedPackageStore, builtInPackageStore], (message) => {
    console.warn(message);
  });
  // #1070 — the orchestrator (an extension) has now had its chance to provide
  // `configStore`; purge the bindings of plugins bootstrap removed above.
  await pendingBindingPurge.flush();
  // #2043 — and the facilitation engine to facilitators that predate it.
  await attachFacilitationEngine();

  // OB-61 fix (boot path) — when the operator completed /setup in a PRIOR
  // session, the anthropic key lives in the orchestrator's VAULT, not in ENV.
  // On this boot the shared `llm`/`anthropicClient` providers were built from
  // the (empty) ENV key at line ~288, so host-LLM plugins (plan-runner's Haiku
  // gate, LocalSubAgent inner calls) would be broken until the next live
  // reactivate. Re-source them from the vault now. No-op when ENV already
  // carried the key (vault key equals the applied one) or no key is stored.
  await sharedAnthropicClientRefresher.refresh();

  // S+8 sub-commit 2b: late-resolve services published by
  // @omadia/knowledge-graph's activate(). The plugin owns Pool +
  // Graph + Bus lifetime; close() drains everything.
  // - graphPool may be undefined when the in-memory backend is active
  //   (no DATABASE_URL — used by tests + zero-config dev).
  // - graphTenantId here is the ENV-derived value only. The knowledge-graph
  //   plugin resolves its own tenant as `ctx.config.get('graph_tenant_id') ??
  //   GRAPH_TENANT_ID ?? 'default'`, and `graph_tenant_id` is an
  //   operator-settable setup field — so the two are NOT "read at the same
  //   place", which an earlier version of this comment claimed. Anything that
  //   must price or address the plugin's own corpus has to consult the
  //   registry config first (see `resolveGraphTenantId` in
  //   routes/adminEmbeddingProvider.ts); the consumers below use this value as
  //   the deployment-wide default, which is what they have always done.
  const knowledgeGraph = serviceRegistry.get<KnowledgeGraph>('knowledgeGraph');
  if (!knowledgeGraph) {
    throw new Error(
      '[middleware] knowledgeGraph service missing after tool-plugin activation — @omadia/knowledge-graph must be built-in and active',
    );
  }
  const entityRefBus = serviceRegistry.get<EntityRefBus>('entityRefBus');
  if (!entityRefBus) {
    throw new Error(
      '[middleware] entityRefBus service missing after tool-plugin activation — @omadia/knowledge-graph must be built-in and active',
    );
  }
  const graphPool = serviceRegistry.get<Pool>('graphPool');
  // #2066 — per-agent archetype settings (migration 0106); none without a database.
  const agentArchetypeSettingsStore = graphPool ? createAgentArchetypeSettingsStore(graphPool) : undefined;
  const graphTenantId = process.env['GRAPH_TENANT_ID'] ?? 'default';

  // Spec 2042 §5.10 — operator jobs and maintenance runs of the model
  // gateway: budget, deadline and (operator jobs) cancel per run, a daily
  // budget per context, recorded in `model_work_runs` (migration 0089).
  const modelWork = createModelWorkRuns({
    ...(graphPool ? { pool: graphPool } : {}),
    operatorDailyCalls: config.OPERATOR_TOOLS_DAILY_MODEL_CALLS,
    maintenanceDailyCalls: config.MAINTENANCE_DAILY_MODEL_CALLS,
    log: (m) => console.log(m),
  });
  // A plugin's index upkeep runs as a maintenance run through this narrow
  // service (embed only, maintenance budget); the run is named after the
  // plugin that asked.
  serviceRegistry.provide(
    MAINTENANCE_RUN_SERVICE_NAME,
    perCallerService(
      (caller): MaintenanceRunService => ({
        run: (name, work) =>
          modelWork.run(
            { ...EMBEDDING_BACKFILL, kind: `${caller.pluginId}:${String(name).slice(0, 60)}` },
            undefined,
            () => work(),
          ),
      }),
    ),
  );

  // Spec 2042 §5.10 — a system module running a model loop of its own (the
  // dev platform's coding jobs) opens an operator job and forwards its model
  // requests through the kernel, which holds the credentials. Only plugins
  // of kind `system-module` get either service.
  const modelPassthrough = createModelPassthrough({
    runs: modelWork,
    anthropic: () => {
      const current = currentAnthropicClient();
      return { apiKey: current.apiKey, baseURL: current.baseURL };
    },
  });
  const kindOfPlugin = (pluginId: string) => pluginCatalog.get(pluginId)?.plugin.kind;
  serviceRegistry.provide(
    OPERATOR_JOBS_SERVICE_NAME,
    systemModuleOnlyService(OPERATOR_JOBS_SERVICE_NAME, kindOfPlugin, modelPassthrough.operatorJobsFor),
  );
  serviceRegistry.provide(
    MODEL_PASSTHROUGH_SERVICE_NAME,
    systemModuleOnlyService(MODEL_PASSTHROUGH_SERVICE_NAME, kindOfPlugin, modelPassthrough.passthroughFor),
  );
  // Spec 2042 §5.2 — one agent's envelope for a system module working on its
  // behalf (the canvas presentation helper): a lookup in the live agent
  // registry, resolved per call (the registry is rebuilt on reactivation).
  serviceRegistry.provide(
    AGENT_ENVELOPE_SERVICE_NAME,
    agentEnvelopeService(kindOfPlugin, () =>
      serviceRegistry.get<MultiOrchestratorRegistry>('orchestratorRegistry'),
    ),
  );
  // Spec 2042 §5.3 / criterion 40 — the agents a person may address in a
  // channel (the canvas channel's picker): the same view as
  // `GET /api/v1/agents/directory`, from the same function, for channel
  // plugins that cannot call the session-authenticated route.
  serviceRegistry.provide(
    AGENT_DIRECTORY_SERVICE_NAME,
    agentDirectoryService(kindOfPlugin, () =>
      serviceRegistry.get<MultiOrchestratorRegistry>('orchestratorRegistry'),
    ),
  );

  // Spec 2042 §5.4 — the pool exists now: read the consultation offering
  // once, so `consult` is offered from the first turn (not only after the
  // first background refresh). A failure keeps the empty snapshot.
  if (graphPool) await consultationBroker.refresh();

  // #575 — hydrate the forward reference published before activation.
  //
  // Refusing to boot without Postgres is deliberate, and it is the kinder
  // failure. The floor fails closed, so an enabled floor with no durable store
  // would not degrade to "unenforced" — every lookup would throw, every room
  // would refuse every tool, recall nothing and read no attachment, and the
  // operator would see a system that looks configured and behaves as though
  // someone had forbidden everything. A boot refusal names the cause once,
  // at the only moment it is still cheap to fix.
  //
  // The store is built whenever Postgres is present, NOT only when the floor is
  // enabled — the admin surface has to be usable before enforcement starts, or
  // the only way to seed grants would be to switch the floor on against an
  // empty table first.
  const audienceGrantStore = graphPool ? new PostgresGrantStore(graphPool) : undefined;
  if (config.AUDIENCE_FLOOR_ENABLED) {
    // The strict reading (`AUDIENCE_BASELINE_GRANTS=none`) has no answer
    // without stored grants: every room would refuse every tool, recall
    // nothing and read no attachment, while looking configured.
    if (config.AUDIENCE_BASELINE_GRANTS === 'none' && (!graphPool || !audienceGrantStore)) {
      throw new Error(
        '[middleware] AUDIENCE_BASELINE_GRANTS=none requires Postgres (DATABASE_URL) — ' +
          'the in-memory backend has nowhere to store grants, and the floor fails closed, ' +
          'so booting like this would silently refuse every tool call in every room.',
      );
    }
    if (graphPool && audienceGrantStore) {
      audienceGrantStoreRef = audienceGrantStore;
    }
  }
  attachmentBindingStoreRef = graphPool
    ? new PostgresAttachmentBindingStore(graphPool)
    : (attachmentBindingStoreRef ?? new InMemoryAttachmentBindingStore());

  /**
   * Team display-name lookup, feature-detected per call against whatever
   * connector is installed RIGHT NOW: `getTeam` arrived in
   * `@omadia/integration-microsoft365` 0.5.0, so an older one simply yields
   * `null` and every screen keeps showing the bare team id. Declared out here
   * because both consumers need it — the provisioning runner (names a binding
   * as it is created) and the operator router (backfills names on read).
   */
  const resolveTeamName = async (teamId: string): Promise<string | null> => {
    const provisioner = getTeamsProvisioner(serviceRegistry);
    if (!supportsTeamLookup(provisioner)) return null;
    const getTeam = provisioner?.getTeam;
    if (!getTeam) return null;
    const result = await getTeam.call(provisioner, { teamId });
    return result.found ? result.displayName : null;
  };

  // W1a (#860) — agent factory: Teams identity provisioning. Registers the
  // two kernel boot services the operator teams-identity routes resolve
  // late-bound (see the /api/v1/operator/agents mount): the identity store
  // (`agentTeamsIdentityStore`, migration 0049) and the provisioning job
  // runner (`teamsProvisioningJobRunner`). Requires Postgres — without
  // DATABASE_URL the routes answer their own 503
  // (teams_identity_unavailable). The `teamsProvisioner@1` capability itself
  // is published by the M365 connector plugin (>= 0.3.1) and resolved
  // lazily PER RUN through the accessor choke point, so installing the
  // connector after boot is picked up without a restart; until then runs
  // fail retryable, never crash. No Graph/ARM call happens in this process.
  if (graphPool) {
    const agentTeamsIdentityStore = new AgentTeamsIdentityStore(graphPool);
    serviceRegistry.provide('agentTeamsIdentityStore', agentTeamsIdentityStore);
    // #914 — the agent's own identity (migration 0052): what it is called,
    // says about itself and looks like. Registered next to the provisioning
    // store because the app-package loader below reads it, but deliberately
    // NOT part of it: an identity is editable whether or not this agent has
    // a Teams bot at all.
    const agentIdentityStore = new AgentIdentityStore(graphPool);
    serviceRegistry.provide('agentIdentityStore', agentIdentityStore);
    // #1100 — `composed_prompt` is a write-time cache, so a compiler change
    // (the boundary precedence clause) would otherwise reach a stored agent
    // only on its next save. One idempotent pass per boot recompiles what is
    // stale; the orchestrator plugin activated above, so its agent store and
    // registry are reachable here, and nothing listens for HTTP yet. Never
    // throws — see `recomposeStaleIdentities`.
    await recomposeStaleIdentities({
      identityStore: agentIdentityStore,
      agentStore: serviceRegistry.get<MultiOrchestratorConfigStore>('configStore'),
      registry: serviceRegistry.get<MultiOrchestratorRegistry>('orchestratorRegistry'),
      log: (m) => {
        console.log(m);
      },
    });
    // Migration 0051 — the PERSISTED team↔agent bindings. Registered next to
    // the identity store because both the operator routes and the job runner
    // consume it; without it the pair degrades to the single-column era
    // (one team per agent, overwritten on re-target).
    const agentTeamsInstallStore = new AgentTeamsInstallStore(graphPool);
    serviceRegistry.provide('agentTeamsInstallStore', agentTeamsInstallStore);
    // Migration 0053 (#915) — the per-step progress log. Provisioning takes
    // minutes and used to persist only the five chain-state transitions, so
    // the operator UI polled every three seconds and had nothing new to say
    // while the runner sat in an Entra replication poll or an ARM backoff.
    // Decoration, never authority: the runner swallows every write failure
    // here and the route reports an empty timeline rather than 500ing.
    const teamsProvisioningEventStore = new TeamsProvisioningEventStore(graphPool);
    serviceRegistry.provide(
      'teamsProvisioningEventStore',
      teamsProvisioningEventStore,
    );
    // #924 — custody of the TENANT's delegated Teams token set. Vault-backed
    // (AES-256-GCM at rest), one record for the whole install, following the
    // `@omadia/mcp-registry` namespace precedent. The catalog upload is the
    // one provisioning step Microsoft refuses app-only, so without this an
    // admin would have to upload a package by hand for every single agent.
    const teamsDelegatedTokenStore = new TeamsDelegatedTokenStore(secretVault);
    serviceRegistry.provide('teamsDelegatedTokenStore', teamsDelegatedTokenStore);
    // The device-code flow itself. Holds the `flowHandle` — which carries the
    // OAuth `device_code` — in this process only; nothing hands it to a
    // browser, and the poll endpoint takes no handle at all.
    const teamsDelegatedSignIn = new TeamsDelegatedSignInService({
      tokens: teamsDelegatedTokenStore,
      getProvisioner: () => getTeamsProvisioner(serviceRegistry),
    });
    serviceRegistry.provide('teamsDelegatedSignInService', teamsDelegatedSignIn);
    // TEAMS_PUBLIC_BASE_URL ?? PUBLIC_BASE_URL — the binding contract of
    // config.ts; resolved per call so a config reload wins over boot state.
    const teamsPublicBaseUrl = (): string =>
      config.TEAMS_PUBLIC_BASE_URL ?? config.PUBLIC_BASE_URL;
    // Named rather than inlined into the runner options since #924: the
    // download endpoint renders a package through the SAME loader the chain
    // uploads through. Two loaders would be two answers to "what does this
    // agent's package contain", and the operator would be diffing against a
    // second implementation's opinion.
    const loadTeamsPackageAssets = createTeamsAppPackageAssetLoader({
      getChannelTeamsPackageRoot: () => {
        const entry = pluginCatalog.get(CHANNEL_TEAMS_PLUGIN_ID);
        return entry ? path.dirname(entry.source_path) : undefined;
      },
      getPublicBaseUrl: teamsPublicBaseUrl,
      // #914 — the agent's authored identity feeds the manifest (name,
      // descriptions, accent colour, package version) and the icons. Read
      // per run, never cached: an identity edited between two runs must
      // reach the package the second one builds.
      loadIdentity: async (agentId) => {
        const record = await agentIdentityStore.getByAgentId(agentId);
        if (!record) return undefined;
        const icons = await agentIdentityStore.getIcons(agentId);
        return {
          displayName: record.displayName,
          shortDescription: record.shortDescription,
          longDescription: record.longDescription,
          accentColor: record.accentColor,
          revision: record.revision,
          icons: icons ?? null,
        };
      },
    });
    serviceRegistry.provide('teamsAppPackageAssetLoader', loadTeamsPackageAssets);
    const teamsProvisioningRunner = new TeamsProvisioningJobRunner({
      store: agentTeamsIdentityStore,
      // The runner records a binding only AFTER Graph confirmed the install,
      // and decorates it with the team's name when the connector can resolve
      // one. Both are best-effort: neither can fail a run that succeeded.
      installs: agentTeamsInstallStore,
      resolveTeamName,
      // #915 — where the runner writes what it is doing between two chain
      // states. Best-effort by contract: a failed note never fails a run.
      events: teamsProvisioningEventStore,
      // #924 — the tenant sign-in the catalog upload rides on. The runner
      // feature-detects `uploadToCatalogDelegated` on the connector, so
      // binding this against an older connector is harmless: it keeps doing
      // the app-only upload it always did.
      delegatedTokens: teamsDelegatedTokenStore,
      getProvisioner: () => requireTeamsProvisioner(serviceRegistry),
      // The accessor module's URL builder, bound to the public base — the
      // runner never composes the messaging endpoint itself.
      buildMessagingEndpoint: (botSlug) =>
        buildTeamsBotMessagingEndpoint(teamsPublicBaseUrl(), botSlug),
      loadPackageAssets: loadTeamsPackageAssets,
      // #910 — the finishing move: after `installed`, write the identity's
      // `teams_bots` entry into the channel-teams plugin config and reactivate
      // the plugin, so the provisioned bot has an adapter and a route without
      // an operator pasting JSON between two screens. `reactivateAgent` is the
      // same funnel every other live config change goes through (it also
      // re-sources host credentials); the write itself is idempotent by
      // botSlug and never touches an entry it does not own. A failure here is
      // a WARNING on an identity that is already valid in Azure — the runner
      // records it and keeps the run `installed`.
      syncBotConfig: (identity) =>
        syncTeamsBotConfig(
          {
            getInstalledRegistry: () => installedRegistry,
            reactivate: reactivateAgent,
          },
          identity,
        ),
    });
    serviceRegistry.provide('teamsProvisioningJobRunner', teamsProvisioningRunner);
    backgroundJobRegistry.register(teamsProvisioningRunner.asBackgroundJob());
    // Resume interrupted provisioning: rows that recorded an install target
    // but neither completed nor terminally failed re-enqueue once at boot.
    // Idempotent — the runner re-enters at the persisted state and leans on
    // the provisioner's already-existed signals. Fire-and-forget: a scan
    // failure logs and never blocks boot.
    void agentTeamsIdentityStore
      .listResumable()
      .then((rows) => {
        for (const row of rows) {
          if (!row.teamId) continue;
          void teamsProvisioningRunner.enqueue({
            agentId: row.agentId,
            teamId: row.teamId,
          });
        }
        if (rows.length > 0) {
          console.log(
            `[middleware] teams-identity provisioning: resumed ${rows.length} interrupted job(s)`,
          );
        }
      })
      .catch((err: unknown) => {
        console.warn(
          '[middleware] teams-identity provisioning resume scan failed:',
          err,
        );
      });
    console.log(
      '[middleware] agent factory ready: agentTeamsIdentityStore + teamsProvisioningJobRunner registered (teamsProvisioner@1 resolved per run)',
    );
  }

  // Issue #560 — now that graphPool is known, back the long-running task seam
  // durably when Postgres is present (tasks survive a restart; the `tasks` table
  // ships in migration 0034), else keep the process-local store. The reaper is
  // started here rather than at declaration so it sweeps the store actually in
  // use. The resume driver is started later, after the hydrate loop populates
  // `deferredTaskToolHandles`.
  const subAgentTaskStore = graphPool
    ? new DurableTaskStore(graphPool)
    : new InMemoryTaskStore();
  if (longRunningSubAgentTools.length > 0) {
    startTaskReaper(subAgentTaskStore, {
      staleAfterMs: config.LONG_RUNNING_TASK_STALE_MS,
      purgeTerminalAfterMs: config.LONG_RUNNING_TASK_RETAIN_MS,
      onError: (err: unknown) =>
        console.warn('[middleware] long-running task reaper sweep failed:', err),
    });
    console.log(
      `[middleware] deferred sub-agent dispatch enabled (${
        graphPool ? 'durable' : 'in-memory'
      } store) for: ${longRunningSubAgentTools.join(', ')}`,
    );
  }

  // Generic MCP OAuth service (epic #459 W9) — outer scope so both the
  // McpManager (auth provider) and the operator router (begin/callback routes)
  // reference the same instance.
  //
  // W0-1: this is now ONLY the shared key for servers whose `delegation` is
  // `service`. It is no longer a fallback for unresolved identities — see
  // services/mcpDelegation.ts.
  const mcpOAuthUserKey = SERVICE_USER_KEY;
  // Redirect URI the OAuth callback lands on: explicit override, else derived
  // from the public base. The service activates when either is configured.
  const mcpOAuthRedirectUri =
    config.MCP_OAUTH_REDIRECT_URI ??
    (flowPublicBaseUrl ? `${flowPublicBaseUrl}/api/v1/operator/mcp-oauth/callback` : undefined);
  // W2-4 (issue #546) — the CIMD metadata-document URL, i.e. the `client_id` a
  // CIMD-capable authorization server dereferences.
  //
  // Derived from `FLOW_PUBLIC_BASE_URL` ALONE — deliberately NOT the
  // `?? PUBLIC_BASE_URL` fallback the redirect URI uses. CIMD needs the IdP to
  // reach IN to this deployment, and `PUBLIC_BASE_URL` defaults to
  // `http://localhost:3979`, which is exactly the shape that is not inbound
  // reachable. Requiring the operator to declare the public origin explicitly
  // means an unconfigured install lands in the clean degraded state (CIMD off,
  // manual client path fully working) instead of publishing a `client_id` no
  // provider can fetch.
  const mcpCimdMetadataUrl = cimdMetadataUrl(config.FLOW_PUBLIC_BASE_URL);
  const mcpOAuthService =
    graphPool && mcpOAuthRedirectUri
      ? new McpOAuthService({
          graph: new AgentGraphStore(graphPool),
          vault: secretVault,
          redirectUri: mcpOAuthRedirectUri,
          cimdMetadataUrl: mcpCimdMetadataUrl,
          log: (m) => console.log(`[middleware] ${m}`),
        })
      : undefined;
  // Schema-driven MCP config with Vault-backed secrets (epic #459).
  const mcpConfigService = graphPool
    ? new McpConfigService({ graph: new AgentGraphStore(graphPool), vault: secretVault })
    : undefined;
  // Issue #563 — the runtime MCP connection pool, hoisted out of the
  // `if (orchestrator)` block below so the operator router (which invalidates a
  // changed server) and `shutdownBuilder` (which must terminate the pooled
  // stdio children) can both reach it. Stays `undefined` when chat is disabled.
  let runtimeMcpManager: McpManager | undefined;

  // Plugin code scanning (issue #453) — SkillSpector sidecar behind the
  // PluginScanner seam. Requires the Postgres graph backend for the verdict
  // table; without it (in-memory dev/tests) scanning is simply absent.
  // Second-review fix: with SKILLSPECTOR_URL unset no scheduler is wired at
  // all — no verdict row is written on ingest, so store pages show no badge
  // on unconfigured deployments. `scan_failed` is reserved for REAL sidecar
  // failures. Advisory-only v1: verdicts decorate the store/detail
  // responses, nothing reads them to block an install.
  const pluginVerdictStore = graphPool ? new AgentGraphStore(graphPool) : undefined;
  const pluginScanScheduler =
    pluginVerdictStore && config.SKILLSPECTOR_URL
      ? createPluginScanScheduler({
          store: pluginVerdictStore,
          scanner: new HttpSkillSpectorScanner({
            baseUrl: config.SKILLSPECTOR_URL,
            timeoutMs: config.SKILLSPECTOR_TIMEOUT_MS,
            log: (m) => console.log(m),
          }),
          log: (m) => console.log(m),
        })
      : undefined;
  const pluginVerdictLookup: PluginVerdictLookup | undefined = pluginVerdictStore
    ? createPluginVerdictLookup({
        store: pluginVerdictStore,
        packages: uploadedPackageStore,
      })
    : undefined;
  if (config.SKILLSPECTOR_URL && !graphPool) {
    console.warn(
      '[middleware] SKILLSPECTOR_URL is set but the graph backend is in-memory — plugin code scanning disabled (verdicts need Postgres)',
    );
  }

  // MCP registry bearer tokens live in the vault, never on the DB row
  // (issue #463 item 5). Move any legacy plaintext token (pre-0020) into the
  // vault on boot — idempotent, a no-op once the column is NULL.
  const mcpRegistrySecrets = graphPool
    ? new McpRegistrySecretService({ vault: secretVault })
    : undefined;
  if (graphPool && mcpRegistrySecrets) {
    await backfillMcpRegistryTokens({
      store: new AgentGraphStore(graphPool),
      secrets: mcpRegistrySecrets,
      log: (m) => console.log(m),
    }).catch((e: unknown) =>
      console.error('[middleware] mcp registry token backfill failed:', e),
    );
  }

  // Phase 5B: publish so dynamic-imported channel plugins can late-resolve
  // the tenant id via ctx.services.get('graphTenantId') instead of being
  // threaded through constructor Deps.
  serviceRegistry.provide('graphTenantId', graphTenantId);

  // S+9.1 sub-commit 2b: the embedding client published by
  // @omadia/embeddings's activate() is consumed by the orchestrator-
  // plugin (ContextRetriever, FactExtractor's optional ingest,
  // TopicDetector) and by channel plugins via ctx.services. Phase 5B
  // dropped the kernel-side late-resolve since no kernel callsite
  // remains — the variable would only document the plugin contract.

  // S+9.2 sub-commit 2b: orchestrator-extras tool-set (ContextRetriever,
  // FactExtractor, TopicDetector) is plugin-owned. The
  // @omadia/orchestrator-extras plugin's activate() constructs
  // each class against the live capabilities (knowledgeGraph,
  // embeddingClient, memoryStore + its setup-fields anthropic_api_key /
  // topic_* / fact_extractor_model) and publishes them via
  // ctx.services.provide. Kernel late-resolves them here. Each is
  // optional: contextRetriever requires KG, factExtractor + topicDetector
  // also need ANTHROPIC_API_KEY.
  //
  // S+10-4a: contextRetriever + factExtractor are no longer kernel-side
  // consumers — the orchestrator-plugin's activate() late-resolves them
  // independently. The kernel still LOGS factExtractor status because the
  // log line was useful for boot diagnostics; contextRetriever logs ship
  // from the plugin.
  const factExtractor = serviceRegistry.get<FactExtractor>('factExtractor');
  if (factExtractor) {
    console.error(
      `[middleware] fact extractor ready (model=${config.TOPIC_CLASSIFIER_MODEL})`,
    );
  } else {
    // OM-102 — the old text named `anthropic_api_key` as the only cause, which
    // sent abo-only operators hunting for a key they deliberately do not have.
    // The extractor now runs on ANY provider the extras plugin can resolve
    // (its own assignment, the orchestrator's, then an Anthropic key), so the
    // honest remaining causes are "plugin missing" or "no provider at all".
    console.log(
      '[middleware] fact extractor DISABLED (orchestrator-extras plugin missing, or no LLM provider assigned to the orchestrator / this plugin and no anthropic_api_key)',
    );
  }

  const memoryStore = serviceRegistry.get<MemoryStore>('memoryStore');
  if (!memoryStore) {
    throw new Error(
      '[middleware] MemoryStore service missing after tool-plugin activation — @omadia/memory must be built-in and active',
    );
  }

  // S+9.2 sub-commit 2b: backfillGraph lives in @omadia/orchestrator-
  // extras (moved in 2a). Kernel still ORCHESTRATES the call here because the
  // 88-turn replay routinely exceeds the 10s plugin-activate budget; running
  // it inside activate() would flap the plugin into errored-state on every
  // boot. The function itself is plugin-owned (sessionTranscriptParser is
  // bundled with it).
  //
  // 2026-05-26: Default-OFF — the 500+ turn replay was the dominant boot
  // delay (~10 min on prod), and the data it produces is already
  // persistent in KG from the original turn ingestion. Set
  // BACKFILL_AT_STARTUP=1 to re-enable for one-off corpus-import boots.
  if (process.env['BACKFILL_AT_STARTUP'] === '1') {
    try {
      // Spec 2042 §5.10 — the replay embeds every turn it ingests: one
      // maintenance run (embed only), started by the boot.
      const backfill = await modelWork.run(GRAPH_BACKFILL, 'system:boot', () =>
        backfillGraph(memoryStore, knowledgeGraph),
      );
      console.log(
        `[graph] backfill: scopes=${String(backfill.scopes)} files=${String(backfill.files)} turns=${String(backfill.turns)} skipped=${String(backfill.skippedFiles.length)}`,
      );
    } catch (err) {
      console.error(
        '[graph] backfill failed:',
        err instanceof Error ? err.message : err,
      );
    }
  } else {
    console.log(
      '[graph] backfill SKIPPED — set BACKFILL_AT_STARTUP=1 to enable (the 500-turn replay was the dominant boot delay; KG already holds the data)',
    );
  }

  // S+10-4a: capability-flip — the @omadia/orchestrator plugin's
  // activate() owns Orchestrator + 5 native-tools + ChatSessionStore +
  // SessionLogger + (optional) VerifierService construction and publishes
  // the bundle as `chatAgent@1`. Kernel late-resolves it here.
  //
  // Without `anthropic_api_key` set in the orchestrator-plugin's setup,
  // the plugin returns a no-op handle and chatAgent@1 is NOT published —
  // boot fails fast with a clear error so the operator wires up the key.
  // Graceful degradation: chatAgent@1 is published by @omadia/orchestrator
  // only once `anthropic_api_key` is set. That key is entered post-boot on
  // the LLM access page, so a missing key must NOT fail the boot — otherwise
  // the very admin UI that captures the key never comes up. We boot
  // "chat-disabled": the admin UI and every non-chat endpoint run; the chat
  // route returns 503 until the key is configured. Saving the key there
  // reactivates the orchestrator plugin (PATCH
  // /installed/:id/secrets → reactivate → activate()), which publishes
  // chatAgent@1 + orchestratorRegistry@1. The chat / session / operator
  // routes below resolve those services LIVE from the registry per request,
  // so chat goes live the moment the key is saved — no restart needed.
  //
  // The tool wiring below (hydration of the per-Agent orchestrators) runs at
  // boot, and again on every later re-activation of the orchestrator plugin
  // (provider switch, secret save, model assignment, reactivate —
  // `rebindOrchestratorToolsRef`). It is installed on a key-less first boot
  // too (#1358): there the first key save publishes the registry and the
  // re-bind hydrates it. Routines follow the same live-resolution pattern as
  // chat (issue #473): the runner resolves chatAgent per run.
  const chatAgentBundle = serviceRegistry.get<ChatAgentBundle>('chatAgent');
  if (!chatAgentBundle) {
    console.warn(
      `[middleware] ⚠ chat DISABLED — chatAgent@1 not published — ${LLM_SETUP_HINT}; chat goes live on save. Admin UI + all other endpoints are up.`,
    );
  }
  // Live resolver for the plugin-published chat bundle. Every chat/session
  // consumer reads through this so a post-boot reactivation (key entry on the
  // LLM access page) is picked up without a restart.
  const getChatAgentBundle = (): ChatAgentBundle | undefined =>
    serviceRegistry.get<ChatAgentBundle>('chatAgent');
  // #1598 — the chat bundle a request without its own orchestrator gets.
  //
  // The legacy `chatAgent@1` bundle is built with no per-Agent plugin grants,
  // so it offers and runs every plugin's tools. On a registry-less boot it IS
  // the deployment's only orchestrator and stays the answer. Once the
  // orchestrator registry exists, the answer is the standard (fallback)
  // orchestrator, which has grants — and `undefined` when none is set, never
  // the ungated bundle. `slug` picks a specific orchestrator (a routine's
  // creator); `'default'` and `null` mean the standard one.
  const getScopedChatAgentBundle = (
    slug: string | null = null,
  ): ChatAgentBundle | undefined =>
    resolveScopedBundle(
      serviceRegistry.get<MultiOrchestratorRegistry>('orchestratorRegistry'),
      getChatAgentBundle(),
      slug,
    );
  const getChatSessionStore = (): ChatSessionStore | undefined =>
    getChatAgentBundle()?.chatSessionStore;
  // sessionLogger is exposed on the bundle for future channel/route
  // consumers but no longer threaded through the kernel — graphBackfill
  // doesn't need it (uses memoryStore + KG directly), and the chat-API
  // route resolves the orchestrator live from the registry.
  // Re-run the registry hydration below on every later re-activation of the
  // orchestrator plugin (fired from `toolPluginRuntime.onActivated` via
  // `rebindOrchestratorToolsRef`), which publishes a fresh registry whose
  // orchestrators start without their sub-agent tools. Resolved LIVE.
  const orchestratorToolRebinder = createOrchestratorToolRebinder({
    getRegistry: () =>
      serviceRegistry.get<MultiOrchestratorRegistry>('orchestratorRegistry'),
    log: (m) => console.log(`[middleware] ${m}`),
  });
  rebindOrchestratorToolsRef = (): void => orchestratorToolRebinder.rebind();

  // The multi-orchestrator registry built one Orchestrator per Agent earlier
  // in boot (inside the orchestrator plugin's activate, during
  // `toolPluginRuntime.activateAllInstalled`), before the MCP pool behind
  // the Agents' sub-agent tools existed. Hydrate every registry-built
  // Orchestrator now.
  const registryForHydrate =
    serviceRegistry.get<MultiOrchestratorRegistry>('orchestratorRegistry');
  // Installed on a key-less boot too: with a database the per-Agent registry
  // is published on the first key save, and it needs the same hydration (and
  // the MCP pool behind its sub-agent tools) as one that existed at boot.
  if (registryForHydrate !== undefined || graphPool !== undefined) {
    // Agent Builder P2/P4 — shared MCP connection pool + a closure that
    // materialises each agent's DB-defined sub-agents into DomainTools and
    // registers them on its orchestrator. Called on initial hydrate AND
    // from `onAgentBuilt` so a rebuilt agent re-acquires its sub-agents.
    // Audit observer (issue #462): every callTool lands one row in
    // mcp_call_log, fire-and-forget so the tool-call path never blocks on
    // the database. Identity comes from turnContext inside the manager.
    const mcpAuditStore = graphPool ? new AgentGraphStore(graphPool) : undefined;
    // #547 / #569 — the structured-output sidecar's first consumer: privacy
    // ACCOUNTING, not rendering. The payload is emitted out-of-band from
    // `McpManager.callTool` and never reaches the model wire (the model sees
    // only the interned digest of the TEXT result), so nothing here is
    // masked — but the sidecar fired beneath every dispatcher, so structured
    // content appeared in no turn receipt at all. This records a PII-free
    // entry (tool + server + byte count + schema flag) into the turn's
    // privacy receipt so an operator audit accounts for it. Deliberately does
    // NOT forward the payload anywhere a renderer could consume it — that is
    // #547's remaining half, unblocked by this accounting decision but out of
    // scope here. Fail-closed: an accounting failure must never break a tool
    // call, and a payload with no turn identity is skipped (there is no
    // receipt to attribute it to) rather than mis-filed.
    const mcpStructuredSink: McpStructuredSink = (payload: McpSidecarPayload) => {
      if (payload.kind !== 'structured_output') return;
      if (payload.turnId === null) {
        console.warn(
          `[middleware] structured sidecar for '${payload.toolName}' has no turnId — not accounted`,
        );
        return;
      }
      const privacy = serviceRegistry.get<PrivacyGuardService>(
        PRIVACY_REDACT_SERVICE_NAME,
      );
      // Feature-detected: a privacy provider that predates #569 (or none
      // installed at all) makes the sink a no-op — no receipt entry, no side
      // effect. (Not byte-identical at the manager: wiring this sink means
      // `emitStructured` now runs its body per structured result where before
      // it early-returned on the absent sink. The work is a turnContext read
      // and a Map lookup, and produces nothing observable without a provider.)
      if (privacy?.recordStructuredPayload === undefined) return;
      // Fail closed on our OWN terms, not on the manager's `emitStructured`
      // try/catch: `structuredContent` is a post-`JSON.parse` value so
      // re-serialising it cannot realistically throw, but a byte count that
      // could take down accounting is not worth trusting a caller's guard
      // for. An unmeasurable payload is still worth accounting — record it
      // with `bytes: 0` rather than dropping the entry.
      let bytes = 0;
      try {
        bytes = Buffer.byteLength(JSON.stringify(payload.structured), 'utf8');
      } catch {
        /* leave bytes at 0 — the entry still records that structured output
           was received, which is the load-bearing accounting fact */
      }
      void privacy
        .recordStructuredPayload({
          turnId: payload.turnId,
          toolName: payload.toolName,
          serverName: payload.serverName,
          bytes,
          hasOutputSchema: payload.outputSchema !== undefined,
        })
        .catch((err: unknown) => {
          console.warn(
            `[middleware] structured sidecar accounting failed for '${payload.toolName}': ${String(err)}`,
          );
        });
    };
    // Generic MCP OAuth (epic #459 W9) wired as the manager's auth provider;
    // the service instance is created at outer scope (shared with the router).
    const mcpManager: McpManager = new McpManager({
      // #547 / #569 — see `mcpStructuredSink` above (accounting only).
      structuredSink: mcpStructuredSink,
      // Issues #1341 / #1342 — runtime tool calls and the periodic rescan
      // pass the operator outbound host rule and the stdio switch before
      // any transport is built.
      connectGuard: createMcpConnectGuard({ stdioEnabled: config.MCP_STDIO_ENABLED }),
      // W2-1 (#544) — where a `resultType: "input_required"` call is parked.
      // The process-shared instance, so the Orchestrator's turn drain reads
      // exactly what this manager wrote.
      pendingInput: sharedPendingMcpInputStore(),
      ...(mcpAuditStore
        ? {
            onToolCall: (entry: McpCallLogEntry) => {
              // `entry.error` is upstream text — a remote MCP server's own
              // protocol/transport message. The orchestrator bounds it to 300
              // characters, but truncation is not redaction: a server that
              // echoes `refresh_token=…`, an `Authorization: Bearer …`, or a
              // secret-shaped JSON field puts that credential into an
              // append-only table, and the operator audit API returns the
              // stored string verbatim.
              //
              // Redacted HERE rather than in the orchestrator because
              // `secretRedaction` lives in this package and `onToolCall` is
              // the injected seam — the alternative was a second copy of the
              // patterns inside `@omadia/orchestrator`, and two copies of a
              // redaction rule is one that drifts loose.
              //
              // LIMIT, deliberately not papered over: this removes
              // CREDENTIALS, not PII. An upstream error quoting a customer
              // name or address still lands in `mcp_call_log`. Masking that
              // would mean running the privacy pipeline inside the audit
              // writer, which is a design decision rather than a patch.
              void mcpAuditStore.insertMcpCallLog(redactAuditError(entry)).catch((err: unknown) => {
                console.warn(`[middleware] mcp call audit write failed: ${String(err)}`);
              });
            },
          }
        : {}),
      // Dispatch-time policy gate (issue #454): fail-closed on unscanned or
      // unacknowledged-risk tools, evaluated on every call.
      guard: mcpDispatchDenial,
      ...(mcpOAuthService && mcpAuditStore
        ? {
            auth: {
              getToken: async (cfg: McpServerConfig) => {
                const server = (await mcpAuditStore.listMcpServers()).find((s) => s.id === cfg.id);
                if (!server) return null;
                // Per-user token (codex W9 fold): the turn's authenticated
                // user when the entry point set it.
                //
                // W0-1 (D2) — THE confused-deputy fix. This used to end in
                // `?? mcpOAuthUserKey`, i.e. `'operator'`. A Teams/Telegram
                // turn whose user has no mapped identity therefore reached
                // the customer's MCP server holding the OPERATOR's token.
                // Now a `per_user` server with no identity gets no token and
                // the call fails closed through onAuthFailure below;
                // `service` delegation is the explicit shared-identity
                // opt-in.
                const userKey = resolveMcpUserKey(
                  server,
                  turnContext.current()?.mcpUserKey,
                  mcpOAuthUserKey,
                );
                if (userKey === null) return null;
                return mcpOAuthService.getValidAccessToken(server, userKey);
              },
              resolveIdentity: async (cfg: McpServerConfig) => {
                const server = (await mcpAuditStore.listMcpServers()).find((s) => s.id === cfg.id);
                if (!server) return null;
                // W0-1: every audit row names the identity it acted as —
                // `unresolved` when there was none.
                return auditIdentity(server, turnContext.current()?.mcpUserKey, mcpOAuthUserKey);
              },
              // #1923 — the server answered 401 to the stored token. Recorded
              // so the MCP Control Center stops calling it authorized.
              onTokenRejected: async (cfg: McpServerConfig, token: string) => {
                const server = (await mcpAuditStore.listMcpServers()).find((s) => s.id === cfg.id);
                if (!server) return;
                const userKey = resolveMcpUserKey(
                  server,
                  turnContext.current()?.mcpUserKey,
                  mcpOAuthUserKey,
                );
                if (userKey !== null) {
                  await mcpOAuthService.markTokenRejected(server.id, userKey, token);
                }
              },
              onAuthFailure: async (cfg: McpServerConfig) => {
                const server = (await mcpAuditStore.listMcpServers()).find((s) => s.id === cfg.id);
                if (!server) return null;
                // W0-1 (D2): fail closed FIRST. A `per_user` server with no
                // caller identity must never be "fixed" by starting an OAuth
                // flow — that flow would bind a token to whoever happens to
                // click through, which is the same confused deputy one step
                // removed. Explain instead, and send nothing upstream.
                const userKey = resolveMcpUserKey(
                  server,
                  turnContext.current()?.mcpUserKey,
                  mcpOAuthUserKey,
                );
                if (userKey === null) return delegationBlockedMessage(server.name);
                // Only OAuth-protected servers get an auth prompt (cached
                // discovery keeps this cheap per call). With the metadata
                // unreadable there is nothing to prompt for: the raw failure
                // is more honest than "isn't set up yet".
                const desc = await mcpOAuthService.describeAuth(server);
                if (!desc.protected || desc.discoveryUnavailable) return null;
                // Machine block the chat parses into an in-line "Connect" card
                // + modal (web-ui McpAuthRequiredCard). Mirrors the <nudge>
                // block contract: human text stays readable for the model and
                // the raw <pre>; the block is stripped from the UI output.
                const authBlock = (needsClient: boolean): string =>
                  `\n<mcp-auth-required serverId="${xmlAttr(server.id)}" server="${xmlAttr(server.name)}"${desc.issuerHost ? ` host="${xmlAttr(desc.issuerHost)}"` : ''} needsClient="${needsClient ? 'true' : 'false'}"></mcp-auth-required>`;
                // #1908 (ADR-0175): no flow is started here and no authorize
                // URL goes into the text. That URL carried a live `state`, and
                // the text reaches the model, run contexts and group channels:
                // whoever opened it could connect their provider account under
                // this user. The Connect card starts the flow from the user's
                // own session instead.
                // Same rule as the auth-status route: only an issuer with no
                // broker AND no stored client needs the one-time setup.
                const storedClient =
                  desc.issuer !== null ? await mcpAuditStore.getMcpOAuthClient(desc.issuer) : undefined;
                if (!desc.brokered && desc.issuer !== null && storedClient === undefined) {
                  // Delegating server with no registered client yet — point
                  // the user at the one-time setup instead of a raw error.
                  return `🔒 The MCP server "${server.name}" needs authorization, but it isn't set up yet. Click Connect to register it${desc.issuerHost ? ` — it delegates OAuth to ${desc.issuerHost}, which needs a one-time app registration` : ''}.${authBlock(true)}`;
                }
                return `🔒 The MCP server "${server.name}" needs authorization before it can be used. Ask the user to click Connect in the chat (this opens the provider's login), then retry.${authBlock(false)}`;
              },
              // Vault-resolved config: secret headers (http) + env (stdio).
              ...(mcpConfigService
                ? {
                    getConfigHeaders: (cfg: McpServerConfig) =>
                      mcpConfigService.getConfigHeaders(cfg),
                    getConfigEnv: (cfg: McpServerConfig) =>
                      mcpConfigService.getConfigEnv(cfg),
                  }
                : {}),
            },
          }
        : {}),
    });
    // Publish the handle so the operator router can invalidate a changed
    // server and `shutdownBuilder` can close the pooled stdio children.
    runtimeMcpManager = mcpManager;
    // W2-1 (#544) — the replayer. Registered here because this is the only
    // place that holds BOTH the manager and the server registry: a replay is
    // a fresh `tools/call`, so it needs the server's live config (endpoint,
    // headers, Vault-resolved env) re-resolved rather than a snapshot taken
    // when the call was parked.
    //
    // A server the operator deleted (or renamed away) between the two turns
    // returns `undefined`, which the orchestrator surfaces to the user as
    // "no longer reachable" instead of silently dropping their input.
    if (mcpAuditStore) {
      setSharedMcpInputReplayer({
        replay: async (record, inputResponses) => {
          const server = (await mcpAuditStore.listMcpServers()).find(
            (s) => s.id === record.serverId,
          );
          if (!server) return undefined;
          const cfg: McpServerConfig = {
            id: server.id,
            name: server.name,
            transport: server.transport,
            endpoint: server.endpoint,
            ...(server.privacyBypass ? { privacyBypass: true } : {}),
          };
          // #562 phase 3 — the RECORD decides which dialect the retry
          // speaks: omadia's flat `inputResponses` argument for a 2025-era
          // peer, the spec's per-request `inputResponses` param plus a
          // verbatim `requestState` echo for a 2026-07-28 one. See
          // `planMcpInputReplay` for why that is derived from the card
          // rather than from the connection.
          const plan = planMcpInputReplay(record, inputResponses);
          return mcpManager.callTool(cfg, record.toolName, plan.args, plan.replay);
        },
      });
    }
    // Host MCP service for plugin ctx.mcp (epic #459 W5, issue #458):
    // resolved lazily by createPluginContext, exactly like the 'llm'
    // provider. Grants are read live per call (deny-by-default).
    serviceRegistry.provide('mcp', {
      listTools: (cfg: McpServerConfig) => mcpManager.listTools(cfg),
      callTool: (cfg: McpServerConfig, toolName: string, args: Record<string, unknown>) =>
        mcpManager.callTool(cfg, toolName, args),
      listServers: async () => (mcpAuditStore ? mcpAuditStore.listMcpServers() : []),
      listGrantedServerIds: async (pluginId: string) =>
        mcpAuditStore ? mcpAuditStore.listGrantedServerIdsForPlugin(pluginId) : [],
    });
    // Scan-verdict grant policy (issue #454): load once before the initial
    // hydration below so blocked (server, tool) pairs never materialize.
    // The Builder routes refresh it after discover/ack and trigger reloads.
    if (graphPool) {
      try {
        await refreshMcpGrantPolicy(new AgentGraphStore(graphPool));
      } catch (err) {
        console.warn(
          `[middleware] mcp grant policy initial load failed (continuing warn-only): ${String(err)}`,
        );
      }
    }
    // A class ref: resolved per sub-agent against the active provider's
    // live catalog (`resolveSubAgentModel`), never sent raw.
    const SUBAGENT_DEFAULT_MODEL = 'class:balanced';
    // Read the orchestrator provider from LIVE installed config on each
    // hydrate so a runtime switch to/from the CLI provider is picked up on
    // the next agent build without a process restart.
    const orchestratorProviderId = (): string => {
      const raw = installedRegistry.get('@omadia/orchestrator')?.config?.[
        'llm_provider'
      ];
      return typeof raw === 'string' && raw.trim().length > 0
        ? raw.trim()
        : 'anthropic';
    };
    const hydrateSubAgentTools = (
      reg: MultiOrchestratorRegistry,
      slug: string,
      built: { orchestrator: { hasDomainTool(n: string): boolean; registerDomainTool(t: DomainTool): void } },
    ): number => {
      const entry = reg.get(slug);
      if (!entry) return 0;
      const snapshot = reg.currentSnapshot();
      const mcpServers = snapshot?.mcpServers ?? [];
      // Persona skills + operator bindings for skill capability contracts
      // (issue #456) — resolved from the same snapshot the registry built
      // this agent from, so tool surface and signature stay consistent.
      const skillsById = new Map((snapshot?.skills ?? []).map((s) => [s.id, s]));
      // #2060 — an archetype without tool grants (the facilitator) may have
      // working modes, but a mode never brings tools to it: no skill-bound
      // capability is hydrated for such an agent.
      const personaSkills = (archetypeOmits(entry.agent, 'tool_grant') ? [] : (snapshot?.personaSkillLinks ?? []))
        .filter((l) => l.agentId === entry.agent.id)
        .map((l) => skillsById.get(l.skillId))
        .filter((s): s is NonNullable<typeof s> => s !== undefined);
      const providerId = orchestratorProviderId();
      return registerDbSubAgentTools(
        {
          subAgents: entry.subAgents,
          toolGrants: entry.toolGrants,
          skills: entry.skills,
        },
        built,
        {
          // The CURRENT shared client, not the boot-time env one: on a
          // vault-keyed install the boot client is unauthenticated forever.
          client: currentAnthropicClient(),
          nativeToolRegistry,
          mcpManager,
          mcpServers,
          personaSkills,
          skillToolBindings: snapshot?.skillToolBindings ?? [],
          defaultModel: SUBAGENT_DEFAULT_MODEL,
          ...(config.SUB_AGENT_EFFORT !== undefined ? { defaultEffort: config.SUB_AGENT_EFFORT } : {}),
          hostIsCliProvider: providerId === 'claude-cli',
          cliModelAlias: (model: string): string =>
            model.replace(/-cli$/, '') || 'sonnet',
          blockedMcpGrant: isMcpGrantBlocked,
          // W2-2 (issue #543) — deferred sub-agent dispatch. Empty allowlist
          // (the default) leaves every sub-agent on today's inline path.
          longRunningSubAgentTools: longRunningSubAgentTools,
          taskStore: subAgentTaskStore,
          // Issue #560 — collect each deferred tool's handle so the resume
          // driver can re-drive its tasks (`resumeOne`) with no id hint.
          deferredTaskToolHandles,
          // #2050 — helpers are internal to their agent: model within its
          // policy, capabilities checked against the agent as it is NOW (the
          // registry's live entry, refreshed on every Builder write), so a
          // revoked agent grant removes the helper's access on the next call.
          ...(entry.agent.modelPolicy ? { parentModelPolicy: entry.agent.modelPolicy } : {}),
          liveParent: () => {
            const live = reg.get(slug);
            return live
              ? {
                  toolGrants: live.toolGrants,
                  holdsNativeTool: (name: string): boolean =>
                    live.built.orchestrator.holdsNativeTool(name),
                }
              : undefined;
          },
          log: (m: string) => console.log(`[middleware] ${m}`),
        },
      );
    };

    // Hydrate every per-Agent orchestrator of `reg` and keep its rebuilds
    // hydrated. Runs at boot and again on each re-activation of the
    // orchestrator plugin (provider switch, secret save, reactivate): that
    // publishes a NEW registry whose orchestrators start with
    // `domainTools: []` and carry no `onAgentBuilt` hook, so without this
    // every agent lost its sub-agents until the next restart.
    const hydrateRegistry = (reg: MultiOrchestratorRegistry): void => {
      hydrateAgentRegistry(reg, {
        hydrateSubAgentTools: (slug, built) => hydrateSubAgentTools(reg, slug, built),
        log: (m: string) => console.log(`[middleware] ${m}`),
      });
    };
    if (registryForHydrate) hydrateRegistry(registryForHydrate);

    orchestratorToolRebinder.setRegistryHydrator(hydrateRegistry);
    // Issue #560 — start the boot resume driver once the deferred tool handles
    // exist. It claims and re-drives any `working` task with no lease (a
    // durable row a restart orphaned before its runner claimed it, or a task a
    // later turn un-parked via `provideInput`), calling `claimNextPending` with
    // no task-id hint — the boot claim loop criterion 3 asks for. A no-op
    // against the in-memory store (its rows die with the process) and against
    // an empty handle set.
    // Gated on the feature, not on handles being present yet: the sink is a
    // shared array a later agent rebuild may append to, and each sweep re-reads
    // it, so a handle registered after boot is still driven.
    if (longRunningSubAgentTools.length > 0) {
      startTaskResumeDriver(deferredTaskToolHandles, {
        onError: (err: unknown) =>
          console.warn('[middleware] long-running task resume sweep failed:', err),
      });
    }

    // Periodic MCP re-scan (epic #459 W6, #455 Phase 3): re-discovers and
    // re-scans every enabled server so post-import drift surfaces without
    // operator action. Default every 6h; MCP_RESCAN_INTERVAL_MS=0 disables.
    const rescanIntervalMs = Number(
      process.env['MCP_RESCAN_INTERVAL_MS'] ?? String(6 * 60 * 60 * 1000),
    );
    if (graphPool && Number.isFinite(rescanIntervalMs) && rescanIntervalMs > 0) {
      const rescanStore = new AgentGraphStore(graphPool);
      const rescanTimer = setInterval(() => {
        void rescanAllMcpServers(rescanStore, mcpManager, (m) =>
          console.log(`[middleware] ${m}`),
        )
          .then(() =>
            serviceRegistry
              .get<MultiOrchestratorRegistry>('orchestratorRegistry')
              ?.reload(),
          )
          .catch((err: unknown) => {
            console.warn(`[middleware] periodic mcp re-scan failed: ${String(err)}`);
          });
      }, rescanIntervalMs);
      rescanTimer.unref();
      console.log(
        `[middleware] periodic mcp re-scan armed (every ${String(Math.round(rescanIntervalMs / 60000))}min)`,
      );
    }

  }

  // The domain-tool re-bind is installed: a class-default rebuild (#1359) may
  // reactivate plugins from here on.
  resolveBootWired();

  console.log('[middleware] context retriever ready (tail + entity-anchor + FTS)');

  // Routines feature (OB-NEW): persistent user-created scheduled agent
  // invocations. Requires Postgres for persistence; skipped in zero-config
  // dev (in-memory KG backend, no DATABASE_URL). The chat agent is NOT
  // required at wiring time — the runner resolves chatAgent@1 live per run
  // (same pattern as the chat routes above), so routines hot-enable the
  // moment the LLM-access-page key save publishes it; keyless fires record an
  // `error` run naming the missing key (issue #473). Channel adapters that
  // want proactive delivery register their `ProactiveSender` into
  // `routinesHandle.senderRegistry` after this call (Teams: wrap a
  // long-lived `CloudAdapter.continueConversationAsync` via
  // `createProactiveSender('teams', sendFn)`). The browser chat's own sender
  // (`channel: 'web'`, #1071) is passed in below: it appends the routine's
  // output to the originating chat session. The per-turn principal the
  // `manage_routine` tool needs is installed by the core (#1086) only for
  // turns driven through `CoreApi.handleTurnStream` (in-tree: public API,
  // canvas). An adapter that calls the `chatAgent` capability directly —
  // Teams, Telegram, Slack, Discord, WhatsApp — still has to install it
  // itself via `captureRoutineTurn` / `beginRoutineTurn`; without one the
  // tool is not offered on that turn (#1346 `isAvailable`), and a call that
  // still arrives refuses with `ROUTINE_NO_CONTEXT_ERROR`.
  let routinesHandle: RoutinesHandle | undefined;
  // #1086 — held in a variable (not only in the service registry) so the
  // channel CoreApi below can wire the channel-agnostic routine-turn producer.
  let routinesIntegration: RoutinesIntegration | undefined;
  // #2082 — routines are user-requested triggers: the trigger engine decides
  // when one fires (durable, once per occurrence, deadline, budget, kill
  // switch); the routine runner keeps owner, controls, templates and history.
  const routineTriggerScheduler = createRoutineTriggerScheduler({
    service: () => triggersRef.current?.service,
    routines: () => routinesHandle?.store,
    resolveAgent: (slug) => {
      // #2055 — no fallback agent: a routine runs as the agent it names.
      const registry = serviceRegistry.get<MultiOrchestratorRegistry>('orchestratorRegistry');
      const agent = slug !== null && slug !== 'default' ? registry?.get(slug)?.agent : undefined;
      return agent ? { id: agent.id, slug: agent.slug } : undefined;
    },
    askOwner: async (routine, text) => {
      const sender = routinesHandle?.senderRegistry.get(routine.channel);
      if (!sender) throw new Error(`no proactive sender for channel '${routine.channel}'`);
      // The renewal question is a harness template, not the agent's words (INV-4).
      await sender.send({ conversationRef: routine.conversationRef, message: { text, speaker: SYSTEM_SPEAKER } });
    },
    limits: () => triggersRef.current?.service.limits ?? DEFAULT_TRIGGER_LIMITS,
    language: () => {
      const raw = installedRegistry.get('@omadia/orchestrator')?.config?.['ai_disclosure_locale'];
      return typeof raw === 'string' ? raw : undefined;
    },
    timeZone: config.PROACTIVE_TIMEZONE,
    log: (m) => console.log(m),
  });
  // #2082 — Agent Builder schedules (P6) fire through bounded triggers too:
  // one per enabled schedule, with deadline, budget and breaker, replacing
  // the minute poller that ran unbounded model turns.
  const scheduleGraphPool = graphPool;
  const scheduleTriggerScheduler = scheduleGraphPool
    ? createScheduleTriggerScheduler({
        service: () => triggersRef.current?.service,
        schedules: () => new AgentGraphStore(scheduleGraphPool),
        agentById: (agentId) => {
          const registry = serviceRegistry.get<MultiOrchestratorRegistry>('orchestratorRegistry');
          const agent = registry?.list().find((a) => a.agent.id === agentId)?.agent;
          return agent ? { id: agent.id, slug: agent.slug } : undefined;
        },
        limits: () => triggersRef.current?.service.limits ?? DEFAULT_TRIGGER_LIMITS,
        notice: (scheduleId, message) => {
          console.log(`[schedules/triggers] NOTICE ${message}`);
          void adminAudit
            ?.record({
              actor: systemAuditActor('system:triggers'),
              action: 'trigger.notice',
              target: `schedule:${scheduleId}`,
              after: { reason: 'expired', message },
            })
            .catch(() => undefined);
        },
        log: (m) => console.log(m),
      })
    : undefined;
  if (graphPool) {
    routinesHandle = await initRoutines({
      pool: graphPool,
      scheduler: routineTriggerScheduler,
      // Spec 2042 §5.3 — a routine set on an agent's own bot delivers only
      // while that bot is still the routine's agent's.
      deliveryRefusal: ({ agentSlug, channel, conversationRef }) =>
        ownBotRefusal(conversationRef, agentSlug, channel, (slug, type) =>
          serviceRegistry.get<MultiOrchestratorRegistry>('orchestratorRegistry')?.channelIdentityFor(slug, type)?.channelKey,
        ),
      // #1598 — the routine's own orchestrator, with its plugin grants.
      // #2045 / #2046 — with the agent's emitter and speaker, so a routine's
      // answer passes the same identity guard and carries the same speaker.
      getOrchestrator: (agentSlug) => {
        const bundle = getScopedChatAgentBundle(agentSlug);
        const raw = bundle?.raw;
        if (!bundle || !raw) return undefined;
        const emitter = emitterOf(bundle.agent);
        const speaker = speakerOf(bundle.agent);
        return {
          runTurn: (input) => raw.runTurn(input),
          ...(emitter ? { emitter } : {}),
          ...(speaker ? { speaker } : {}),
        };
      },
      requiresAgentSlug: () =>
        serviceRegistry.get('orchestratorRegistry') !== undefined,
      registerNativeTool: (name, handler, options) =>
        nativeToolRegistry.register(name, {
          handler,
          spec: options.spec,
          ...(options.promptDoc !== undefined
            ? { promptDoc: options.promptDoc }
            : {}),
          ...(options.isAvailable !== undefined
            ? { isAvailable: options.isAvailable }
            : {}),
        }),
      // #1071 — the browser chat's sender: a routine created from the web
      // chat delivers into that chat's persisted session. Resolved live so it
      // survives the LLM-key hot-enable that publishes the store.
      proactiveSenders: [
        createWebChatProactiveSender({
          getStore: getChatSessionStore,
          warn: (msg) => console.warn(msg),
        }),
      ],
      log: (msg) => console.log(msg),
    });
    // Phase 5B: publish the channel-facing surface so dynamic-imported
    // channel plugins can late-resolve all routines callbacks (capture-
    // turn, proactive-send registration, action handler, smart-card
    // builders) without constructor-injected Deps.
    routinesIntegration = createRoutinesIntegration(routinesHandle, (info) => {
      // US5: persist a Conductor channel binding per inbound turn so awaits can be reminded.
      // Lazy-resolve the store (Conductor wires later in boot); fire-and-forget — a turn must
      // never be blocked or broken by it.
      const bindings = serviceRegistry.get<{ upsert(u: string, c: string, r: unknown, scope?: string): Promise<void> }>(
        'conductorChannelBindings',
      );
      // Key the binding by the operator-addressable principalRef (Teams: the user's email) when the
      // channel supplied one, so it matches a human-step principal / role holder; otherwise fall back
      // to the channel-native userId (e.g. AAD object id). The store canonicalizes the key on write.
      if (bindings) {
        void bindings
          // The channel's tenant/workspace (Teams: AAD tenant) rides along so a scope-aware
          // resolver can tell two tenants' bindings of the same email apart (migration 0012).
          .upsert(bindingKeyForTurn(info), String(info.channel), info.conversationRef, info.tenant)
          .catch(() => undefined);
      }
    }, graphTenantId);
    serviceRegistry.provide(ROUTINES_INTEGRATION_SERVICE_NAME, routinesIntegration);
    console.log(
      '[middleware] routines feature ready (manage_routine tool registered, routinesIntegration published, chat agent resolved live per run)',
    );
  } else {
    console.log(
      '[middleware] routines feature SKIPPED — no graphPool (in-memory KG backend; set DATABASE_URL to enable)',
    );
  }

  const app = express();
  // #1310 / §10o — the request trust boundary. `trust proxy` used to be
  // `true`, which trusts every hop and so made `req.secure` (and with it the
  // auth cookies' `Secure` flag) a value the sender of the request chose. It
  // is now the operator's list of proxy ADDRESSES, empty by default; a hop
  // count would not help, because Express counts the immediate peer as a
  // trusted hop. `PUBLIC_SCHEME` is the escape hatch for a TLS-terminating
  // proxy that sets no `X-Forwarded-Proto`, read per request by
  // `requestIsSecure` — for the cookie flags and for the pairing descriptor's
  // scheme alike.
  const trustedProxies = parseTrustedProxies(config.TRUSTED_PROXY_ADDRESSES);
  app.set('trust proxy', trustedProxies);
  app.set(PUBLIC_SCHEME_SETTING, config.PUBLIC_SCHEME);
  console.log(
    `[middleware] request trust boundary: trusted proxies=${describeTrustedProxies(trustedProxies)}, public scheme=${config.PUBLIC_SCHEME}`,
  );
  // Bumped 1mb → 10mb (Step #4): the agent-builder PATCH /spec and
  // /clone-from-installed paths can ship full slot bodies + spec JSON
  // serialised in one request; one production turn was hitting 1mb hard
  // (PayloadTooLargeError in the log). 10mb is well below the
  // turn-loop's risk profile (the agent's own per-tool input is bounded
  // by Anthropic-SDK token limits) but gives slot-heavy clones room.
  // ── Epic #470 C6 / G3 — plugin raw-body slot ─────────────────────────────
  //
  // THE POSITION OF THIS LINE IS THE FEATURE, for the same reason C4's mount
  // further down says so: it is the last place a plugin route can still see
  // untouched request bytes.
  //
  // The hand-rolled raw router just below (`/api/hooks/:endpointId`) sits in
  // this same window precisely because a router mounted
  // after `express.json` cannot recover the bytes it needs — body-parser marks
  // the request `_body` and every later parser, including a route-local
  // `express.raw()`, short-circuits. This mount generalises that placement: a
  // plugin that registered a prefix with `body: 'raw'` gets its parser run
  // HERE, before the global JSON parser, and nowhere else. Everything else
  // falls straight through.
  //
  // It never routes, never authenticates and never answers — it parses and
  // calls next(). The plugin's router is still reached through the ordinary
  // paths (C4's terminating public mount, or the boot-time flush behind
  // requireAuth), so this adds no reachable surface. See pluginRawBodyMount.ts
  // for why `express.json`'s `verify` hook is NOT the mechanism.
  app.use(createPluginRawBodyMount({ routes: pluginRouteRegistry }));

  // Issue #437 — Conductor's generic inbound webhook route. Mounted unconditionally
  // (mirrors the forward-reference pattern, not the `if (graphPool)` gate above): on
  // the in-memory backend `conductorWebhookInboundDepsRef` never gets assigned, so the
  // handler's `getDeps()` resolves undefined and every call answers 503 — the router
  // itself must still be registered here, before express.json(), for the raw-body HMAC
  // verification to ever see real request bytes once Conductor IS wired.
  app.use(createConductorWebhooksInboundRouter(() => conductorWebhookInboundDepsRef));
  // #1707 — the mount line used to print identically whether or not the kill switch
  // was on, so a `CONDUCTOR_WEBHOOKS_ENABLED=false` install looked healthy in the log
  // while every inbound delivery was being dropped. State goes in the line.
  console.log(
    `[middleware] conductor webhook inbound router mounted at /api/hooks/:endpointId (raw-body, before express.json) — inbound deliveries ${
      config.CONDUCTOR_WEBHOOKS_ENABLED ? 'ENABLED' : 'DISABLED (CONDUCTOR_WEBHOOKS_ENABLED=false; every request answers 503)'
    }`,
  );

  // `verify` records the RAW byte count (see `http/rawBodySize.ts`). Route-level
  // size gates downstream can only measure `JSON.stringify(req.body)`, which is
  // a different number: 9 MB of insignificant whitespace re-serialises to a
  // handful of bytes and walks through a cap written against it.
  app.use(express.json({ limit: '10mb', verify: recordRawBodyBytes }));
  app.use(cookieParser());

  // Each admin function that calls a model is one operator job. Mounted
  // ahead of the routers that implement them: the job wraps the rest of the
  // request, and only POSTs start one.
  for (const [route, kind] of OPERATOR_JOB_ROUTES) {
    app.post(route, requireAuth, modelWork.middleware(kind));
  }
  // Memory REST writes embed the entry and run the review detectors: an
  // operator job with the writing user as its actor.
  app.post('/api/v1/memory', requireAuth, modelWork.middleware(MEMORY_EDIT));
  app.patch('/api/v1/memory/:id', requireAuth, modelWork.middleware(MEMORY_EDIT));
  app.patch('/api/v1/memory/:id/excerpts/:position', requireAuth, modelWork.middleware(MEMORY_EDIT));
  app.use('/api/v1/admin/model-work', requireAuth, createModelWorkRouter({ runs: modelWork }));
  app.use('/api/v1/admin/model-gateway', requireAuth, createModelGatewayStatusRouter());
  // Spec 2042 §5.10 — agent templates of the installed plugins, as prefills
  // for the Agent Builder. Read-only: the Builder creates the agent.
  app.use(
    '/api/v1/admin/agent-templates',
    requireAuth,
    createAgentTemplatesRouter({
      listPlugins: () => pluginCatalog.list().map((entry) => entry.plugin),
      isInstalled: (pluginId) => installedRegistry.has(pluginId),
      isArchetypeRegistered: (archetypeId) => getArchetype(archetypeId) !== undefined,
    }),
  );

  app.get('/health', (_req, res) => {
    // `kg` surfaces the recall capability picture (backend durability +
    // embeddings/semantic-recall/durable-tier/process-reuse availability) so a
    // silently-degraded deployment is observable here instead of only in boot
    // logs. Non-sensitive: capability states only, no secrets/URLs.
    //
    // #440 — the installed registry alone cannot see whether the embedding
    // model/dimension gate actually let the knowledge-graph write vectors, so
    // the gate outcome is read here too. Resolved per request rather than
    // captured at boot: plugins can be toggled at runtime.
    //
    // #665 — everything above is a projection of the REGISTRY, so it could not
    // see the instance being dead: the KG plugin ended the process-wide pg
    // pool, every query started failing, and this endpoint still answered
    // `ok` because the registry entry said `active`. The pool is now asked
    // directly. Async because that is a query; it is bounded by its own
    // timeout and never throws, so /health cannot hang or 500 on it.
    void (async (): Promise<void> => {
      const gate = serviceRegistry.get<EmbeddingGateStatus>(
        EMBEDDING_GATE_STATUS_SERVICE,
      );
      const probe = await probeGraphPool(serviceRegistry.get('graphPool'));
      const kg = buildKgHealth(installedRegistry, gate, probe);
      // #648 (epic #642) — the resolved AI-Act marking posture per channel.
      // Read per request for the same reason the embedding gate is: a config
      // change re-activates the orchestrator and re-publishes, and a boot-time
      // capture would keep reporting the old posture until a restart.
      // Non-sensitive by construction: levels, sources and booleans only, no
      // assistant name, operator note or composed line — see disclosureHealth.ts.
      const disclosure = buildDisclosureHealth(
        serviceRegistry.get<AiDisclosurePostureStatus>(
          AI_DISCLOSURE_POSTURE_SERVICE,
        ),
      );
      // A dead pool is not a degradation to report at 200 — nothing in the
      // process can serve a request. 503 is what a load balancer needs to see.
      // A deviating marking posture deliberately does NOT change the status:
      // it is a legitimate operator decision, and #648 is explicit that the
      // hint informs rather than blocks.
      const status = kg.pool === 'dead' ? 'error' : 'ok';
      // #1385 / #1384 — the database verdict as its own field, so the web UI
      // can name a Postgres outage while every authenticated route answers
      // 503. Additive: `status` and the HTTP code keep their meaning, because
      // the updater's health gate and the desktop supervisor key on them.
      // Master-key posture is NOT here on purpose (see platformHealth.ts).
      const checks = buildPlatformChecks({
        kg,
        databaseConfigured: Boolean(process.env['DATABASE_URL']?.trim()),
      });
      // #432 — the build stamp (`unknown` when the image was built without
      // one). Load-bearing beyond display: the updater sidecar's health gate
      // polls THIS field to decide whether the new image is actually serving,
      // and rolls the stack back when the requested version never appears.
      // Non-sensitive: a release tag that is public on GitHub anyway.
      // `attachments` — which store backs `tigrisStore` ('s3' | 'filesystem' |
      // 'none'), so a caller that asked for one (the desktop "Attachments"
      // switch) can check it took. Backend only, never a bucket or a path.
      res
        .status(kg.pool === 'dead' ? 503 : 200)
        .json({
          status,
          version: appVersion.version,
          checks,
          kg,
          disclosure,
          attachments: attachmentStoreHealth(attachmentStore),
        });
    })();
  });

  // Friction-free pairing discovery (#293). Public-by-design (lives outside
  // the `/api` requireAuth mount): a desktop client GETs this on whatever
  // origin the user knows and gets back a source-agnostic descriptor with an
  // ABSOLUTE canvas `wsUrl` and the auth providers — no scheme juggling, no
  // `/omadia-ui/canvas` suffix to hand-type. `pairingProviders` is populated
  // once the auth registry is ready during boot (well before `listen`); the
  // handler reads it at request time, so a `let` capture is sufficient and
  // the route still answers (`auth.mode: 'none'`) when auth is disabled.
  let pairingProviders: ProviderSummaryLike[] | undefined;
  let mdnsAdvertisement: MdnsAdvertisement | undefined;
  app.get(WELL_KNOWN_PATH, (req, res) => {
    res.json(
      buildPairingDescriptor(
        {
          headers: req.headers,
          // The connection's TLS state (or `PUBLIC_SCHEME`), not the client's
          // `x-forwarded-proto` (#1310): express applies that header only for
          // a hop `TRUSTED_PROXY_ADDRESSES` names.
          secure: requestIsSecure(req),
        },
        {
          instanceName: config.OMADIA_UI_INSTANCE_NAME,
          publicWsUrl: config.OMADIA_UI_PUBLIC_WS_URL,
          providers: pairingProviders,
        },
      ),
    );
  });
  console.log(`[middleware] pairing discovery at GET ${WELL_KNOWN_PATH}`);

  // W2-4 (issue #546) — MCP Client ID Metadata Document. Public by necessity:
  // an authorization server fetches it uncredentialed to resolve the CIMD
  // `client_id`. Mounted here, outside the `/api` requireAuth mount, AND listed
  // in auth/publicPaths.ts via the shared `CIMD_METADATA_PATH` constant so the
  // two can never drift. `redirectUri` is the SAME variable McpOAuthService
  // holds — if these diverge, every code exchange fails at the provider.
  app.use(
    createMcpClientMetadataRouter({
      metadataUrl: mcpCimdMetadataUrl,
      redirectUri: mcpOAuthRedirectUri ?? null,
    }),
  );
  console.log(
    mcpCimdMetadataUrl && mcpOAuthRedirectUri
      ? `[middleware] MCP client-ID metadata document at GET ${CIMD_METADATA_PATH} (client_id ${mcpCimdMetadataUrl})`
      : `[middleware] MCP client-ID metadata document at GET ${CIMD_METADATA_PATH} answers 501 — FLOW_PUBLIC_BASE_URL unset, so CIMD is off and issuers use the manual client path`,
  );

  // Shared assets for plugin-authored UI: the generated design-system
  // stylesheet (epic #470 C8) plus any `@font-face` sources. No auth — the
  // bytes are static and operator-agnostic. `admin-ui.css` remains an alias
  // so shipped plugin admin UIs keep resolving.
  app.use('/api/_harness', await createHarnessAdminUiRouter());
  console.log(
    '[middleware] plugin UI stylesheet ready at /api/_harness/plugin-ui.css (alias: /admin-ui.css)',
  );

  // Static serving for a plugin's compiled SPA bundle, at
  // `/p/<pluginId>/ui/...` — under the plugin's own prefix, so the nav
  // contribution API, the `publicPaths` entry and the web-ui `/p/*` proxy all
  // apply unchanged. Mounted BEFORE the plugin route flush so core owns the
  // `ui/` segment; every other path under `/p` falls through to the plugin's
  // own router. Read-only, extension-allowlisted, traversal-checked — and the
  // allowlist has no `.css` in it, which is what keeps the Tailwind
  // vocabulary the only styling channel a plugin has.
  app.use(
    '/p',
    createPluginUiStaticRouter({
      resolvePackageRoot: (pluginId) => {
        const entry = pluginCatalog.get(pluginId);
        if (!entry) return undefined;
        return path.dirname(entry.source_path);
      },
    }),
  );
  console.log('[middleware] plugin UI bundles served at /p/<pluginId>/ui/');

  const agentResolver = createAgentResolver({
    toolOwner: (toolName) => pluginToolOwner(nativeToolRegistry, toolName),
  });
  // Phase A — Chat router resolves per-Agent via the registry. Falls
  // back to the legacy default `chatAgent@1` for two cases:
  //   1. Boot with no registry (no DATABASE_URL) — only the default
  //      bundle exists, gets reachable via slug "default".
  //   2. Registry has Agents but the requested slug is "default" —
  //      same shortcut for back-compat.
  // Otherwise the slug must map to a registered Agent (registry.get).
  // Resolve orchestratorRegistry@1 + chatAgent@1 LIVE per request. Both are
  // published by the orchestrator plugin's activate(); after a key entry on
  // the LLM access page the plugin reactivates and (re)publishes them, so
  // capturing a
  // boot-time value would pin the chat-disabled state forever.
  const getRegistry = (): MultiOrchestratorRegistry | undefined =>
    serviceRegistry.get<MultiOrchestratorRegistry>('orchestratorRegistry');
  // #2055 — the management layer decides who answers a web chat turn: the
  // agent the conversation is pinned to or the sender chose, else the
  // sender's default agent for the web channel; otherwise a `system` notice.
  // No fallback agent, never another agent in the named one's place.
  const routeWebTurn = (request: WebRouteRequest): WebRouteResult => {
    const reg = getRegistry();
    const locale = request.locale;
    if (!reg) {
      // #1598 — registry-less boot (no database): the legacy bundle IS the
      // deployment's one agent, reachable as `default` or unaddressed.
      const legacy = getChatAgentBundle()?.agent;
      if (legacy && (request.explicitSlug === undefined || request.explicitSlug === 'default')) {
        return {
          kind: 'agent',
          chatAgent: legacy,
          slug: 'default',
          speaker: { kind: 'agent', agentId: 'default', slug: 'default', displayName: 'omadia' },
        };
      }
      return {
        kind: 'notice',
        notice: request.explicitSlug
          ? buildSystemNotice('agent_unknown', {
              agent: { slug: request.explicitSlug, displayName: request.explicitSlug },
              ...(locale ? { locale } : {}),
            })
          : buildSystemNotice('no_agent', locale ? { locale } : {}),
      };
    }
    const resolver =
      serviceRegistry.get<ManagementChannelResolver>('channelResolver') ??
      new ManagementChannelResolver({ registry: reg });
    const result = resolver.resolve(WEB_CHANNEL_TYPE, request.conversationKey, {
      ...(request.principal ? { principal: request.principal } : {}),
      ...(request.explicitSlug ? { explicitSlug: request.explicitSlug } : {}),
      ...(locale ? { locale } : {}),
    });
    if (result.decision === 'bound' && result.agent && result.chatAgent) {
      return {
        kind: 'agent',
        chatAgent: result.chatAgent,
        slug: result.agent.agent.slug,
        speaker: speakerFor(result.agent.agent),
      };
    }
    return {
      kind: 'notice',
      notice: result.notice ?? buildSystemNotice('no_agent', locale ? { locale } : {}),
    };
  };

  // The ADMIN_TOKEN break-glass surface. Like the public-path mount it must sit
  // BEFORE the `/api` session gate below: mounted after it, a bearer request
  // met the gate's `auth.missing` 401 before the token was compared. It claims
  // only requests that present a bearer credential (terminal: 401/404/served)
  // and passes every other request on to the gate untouched.
  if (
    mountAdminTokenSurface(app, {
      token: config.ADMIN_TOKEN,
      store: memoryStore,
      audit: () => adminAudit,
      // The password limiter's client rule: per vouched address, never the
      // shared TCP peer.
      throttle: createAdminTokenThrottle({
        clientAddress: parseClientAddressPolicy(config.AUTH_LOGIN_CLIENT_ADDRESS),
        ipv6PrefixBits: config.AUTH_LOGIN_IPV6_PREFIX,
      }),
      // #1082 — per request: the orchestrator plugin publishes the tally
      // on activate, possibly after this router is mounted.
      runTraceStats: () =>
        serviceRegistry.get<RunTraceOutcomeStats>(RUN_TRACE_STATS_SERVICE),
    })
  ) {
    console.log(`[middleware] admin token endpoints enabled at ${ADMIN_TOKEN_PATH} (bearer, before the session gate)`);
    for (const warning of adminTokenThrottleWarnings(
      config.ADMIN_TOKEN,
      parseClientAddressPolicy(config.AUTH_LOGIN_CLIENT_ADDRESS),
    )) {
      console.warn(warning);
    }
  } else {
    console.log('[middleware] admin endpoints DISABLED (ADMIN_TOKEN not set)');
  }

  // ── Epic #470 C4 / H1 — the terminating public-path mount ────────────────
  //
  // THE POSITION OF THIS LINE IS THE FEATURE. It sits immediately before the
  // OB-106 `/api` requireAuth mount below, and everything about the design
  // follows from that:
  //
  //   * A request under a prefix that is manifest-declared, exclusively owned
  //     AND operator-granted is dispatched to the owning plugin's router right
  //     here, before any authentication runs.
  //   * If that router does not handle it, this mount answers 404. It does NOT
  //     call next(). A granted prefix is a closed world owned by one plugin —
  //     an unhandled subpath must never travel on into the authenticated stack
  //     with no session attached. That is the hole a plain `publicPaths` entry
  //     leaves open, and the reason `auth/publicPaths.ts` stays a frozen
  //     core-owned literal instead of becoming a dynamic set.
  //   * Anything else calls next() and meets the ordinary stack exactly as
  //     before: requireAuth's 401 under `/api`, and outside `/api` the
  //     terminal JSON 404 (#1349 — a session does not open such a path).
  //
  // Fail-closed by construction: no grants, no store, no registry, no live
  // plugin — every one of those is a next(), i.e. a 401 or 404. There is no failure
  // mode of this mount that produces LESS authentication than a build without
  // it. Mounted after express.json/cookieParser so plugin handlers see the
  // same parsed request they see through the ordinary boot-time mount.
  app.use(
    createPublicPathMount({
      grants: publicPathGrants,
      routes: pluginRouteRegistry,
    }),
  );

  // #1762 (ADR-0180) — the owner of web chats written before owners existed:
  // the instance's only account. Bound once the users table is wired below;
  // until then (and without Postgres) such chats belong to nobody.
  let resolveLegacyChatOwner: LegacyChatOwner = () => Promise.resolve(undefined);
  const legacyChatOwner: LegacyChatOwner = () => resolveLegacyChatOwner();

  // OB-106: gate the chat-inference endpoints (`POST /api/chat`,
  // `POST /api/chat/stream`) behind `requireAuth`. Without this, anonymous
  // callers could trigger LLM inference (cost) and reach the tool surface
  // (KG-lookups, RAG, Memory-Reads). createChatRouter does not register
  // any public-by-design routes — every route is inference-tied.
  app.use(
    '/api',
    requireAuth,
    createChatRouter({
      agentResolver,
      legacyChatOwner,
      routeTurn: routeWebTurn,
      // #2055 — `/agent …` in the web chat, the same management-layer
      // handling every other channel gets from its resolver.
      handleAgentCommand: async (command, request) => {
        const registry = getRegistry();
        const store = serviceRegistry.get<MultiOrchestratorConfigStore>('configStore');
        if (!registry || !store) return buildSystemNotice('no_agent', request.locale ? { locale: request.locale } : {});
        if (!request.principal && command.kind !== 'list') {
          return buildSystemNotice('no_agent', request.locale ? { locale: request.locale } : {});
        }
        return new KernelAgentSelectionService({ registry, tables: store.routing }).handle(command, {
          channelType: WEB_CHANNEL_TYPE,
          conversationKey: request.conversationKey,
          principal: request.principal ?? 'user:anonymous',
          ...(request.locale ? { locale: request.locale } : {}),
        });
      },
      // OM-76 — "no orchestrator at all" vs "this one is gone". With a registry
      // it is the live agent count; on a no-DB boot the legacy default bundle
      // is the only agent there can be.
      hasActiveAgents: () => {
        const reg = getRegistry();
        if (reg) return reg.size() > 0;
        return getChatAgentBundle() !== undefined;
      },
      getChatSessionStore,
      snapshotForAgent: (slug) => getRegistry()?.snapshotForAgent(slug),
    }),
  );

  // W2-3 (issue #542) — the public, stateless MCP endpoint.
  //
  // Mounted AFTER the `/api` requireAuth line above ON PURPOSE. That mount runs
  // for every `/api/*` request whichever router answers it, so being listed in
  // `auth/publicPaths.ts` is what makes this route reachable at all — and
  // losing that entry makes it go DARK (401) rather than open. `requireApiKey`
  // inside the router is the actual authentication; the per-key tool allowlist
  // and the per-tool write scopes are the actual authorization.
  mountPublicMcp(app, requireAuth, {
    enabled: config.PUBLIC_MCP_ENABLED,
    allowWithoutPrivacyMasking: config.PUBLIC_MCP_ALLOW_WITHOUT_PRIVACY_MASKING,
    vault: secretVault,
    graphPool,
    getRegistry,
    nativeToolRegistry,
    // Resolved LIVE from the service registry, the same late-bound pattern the
    // orchestrator plugin uses: installing the privacy-guard plugin takes effect
    // without a restart, and — the direction that matters here — uninstalling it
    // closes the endpoint's tool calls immediately rather than on next boot.
    getPrivacyService: () =>
      serviceRegistry.get<PrivacyGuardService>(PRIVACY_REDACT_SERVICE_NAME),
  });

  // Chat-sessions CRUD behind `requireAuth` — sessions may contain
  // PII / tool outputs / code snippets and must not be readable anonymously.
  // The `/api` mount above already gates this, but the explicit middleware
  // here is defence-in-depth: if a future refactor splits mounts or moves
  // the sessions router to a different base path, the auth guarantee
  // travels with it.
  app.use(
    '/api/chat',
    requireAuth,
    createChatSessionsRouter({ getStore: getChatSessionStore, legacyOwner: legacyChatOwner }),
  );

  // Plugin-contributed navigation. The web-ui shell renders a static nav for
  // its own compiled surfaces and merges this for everything a plugin adds,
  // which is what makes a feature genuinely installable: deactivate its
  // plugin and the menu entry is gone without a frontend rebuild.
  // `requireAuth` is defence-in-depth over the `/api` mount — the entry list
  // discloses which features an operator has installed.
  app.use(
    '/api',
    requireAuth,
    createUiNavigationRouter({
      catalog: uiRouteCatalog,
      supportedLocales: WEB_UI_LOCALES,
      defaultLocale: WEB_UI_DEFAULT_LOCALE,
    }),
  );
  console.log('[middleware] ui navigation endpoint ready at /api/v1/ui/navigation');

  // In-app "Create Issue" button: operator connects their own GitHub
  // account via the device flow (only a public client id, no secret — so
  // omadia ships the OAuth App baked in), the primary LLM reformulates the
  // note into a clean English issue, and it is filed to byte5ai/omadia as
  // the operator. No public callback — every route stays behind requireAuth.
  app.use(
    '/api/v1/issues',
    requireAuth,
    createIssuesRouter({
      vault: secretVault,
      installedRegistry,
      llmProviderCatalog,
      githubProvider: createGitHubDeviceProvider(config.GITHUB_OAUTH_CLIENT_ID),
      createIssueCreator: (getToken) =>
        new GithubIssueCreator({ tokenProvider: { getToken } }),
    }),
  );
  console.log('[middleware] chat-sessions endpoint ready at /api/chat/sessions (auth-gated)');

  // Slice 3b — MemorableKnowledge REST surface. `requireAuth` gates the
  // whole router, consistent with the `/api` OB-106 line and the
  // `/api/chat` defence-in-depth mount above. Mutating endpoints
  // additionally call `requireSessionUserId` internally; the ACL filter
  // scopes reads to the viewer's owned / involved memories.
  app.use(
    '/api/v1/memory',
    requireAuth,
    createMemoryRouter({ graph: knowledgeGraph }),
  );
  console.log('[middleware] memory endpoint ready at /api/v1/memory (auth-gated)');

  // #430 — structured dataset ingestion (CSV import) REST surface. Same
  // requireAuth + per-route session-user ACL pattern as /api/v1/memory.
  app.use(
    '/api/v1/datasets',
    requireAuth,
    createDatasetsRouter({ graph: knowledgeGraph }),
  );
  console.log('[middleware] datasets endpoint ready at /api/v1/datasets (auth-gated)');

  // Slice 8 — bulk score + promote admin endpoint. Mounted only when
  // the orchestrator-extras plugin published the bulkPromotion service
  // (which requires a graphPool capability — i.e. the Neon backend).
  // `requireAuth` gates the router, consistent with /api/v1/memory; the
  // router's `requireSessionUserId` guard runs per-route on top.
  const bulkPromotionService =
    serviceRegistry.get<BulkPromotionService>('bulkPromotion');
  if (bulkPromotionService) {
    app.use(
      '/api/v1/admin/bulk-promote',
      requireAuth,
      createBulkPromotionRouter({ service: bulkPromotionService }),
    );
    console.log(
      '[middleware] bulk-promotion endpoint ready at /api/v1/admin/bulk-promote',
    );
  } else {
    console.log(
      '[middleware] bulk-promotion endpoint skipped — service not published (Neon backend missing?)',
    );
  }

  // #778 W1 — #577 P3's admin-gated skill promotion route. Deliberately
  // deferred by #771 to keep that PR's blast radius to new files only (see
  // its "Not in this PR" section) — this is the mount. `PgSkillOwnershipLifecycleStore`
  // needs a real Postgres pool (raw SQL over the `skills` table's #577
  // columns), so it is only constructed/mounted when `graphPool` is
  // available, the same gate `bulkPromotionService` above uses. `requireAuth`
  // gates the router; the router's own `requireSessionUserId` check replicates
  // the `routes/bulkPromotion.ts` auth chain exactly (single-tenant byte5 —
  // every authenticated session is an operator).
  if (graphPool) {
    const skillLifecycleStore = new PgSkillOwnershipLifecycleStore(graphPool);
    app.use(
      '/api/v1/admin/skills',
      requireAuth,
      createSkillPromotionRouter({ store: skillLifecycleStore, signingKey: skillManifestSigningKey }),
    );
    console.log(
      '[middleware] skill-promotion endpoint ready at /api/v1/admin/skills/:skillId/promote',
    );
  } else {
    console.log(
      '[middleware] skill-promotion endpoint skipped — no graphPool (Neon backend missing?)',
    );
  }

  // #778 W1 — #578 Phase 3's keychain-asks HTTP surface. Built and
  // route-tested by #774 but deliberately left unmounted (same "new files
  // only" blast-radius discipline as #577 P3) — this is the mount.
  // `CredentialAskStore` follows the exact backend-choice precedent
  // `credentials/credentialStoreFactory.ts` documents for the credential
  // keychain itself: Postgres when a pool is configured, in-memory
  // otherwise (works within one process; asks do not survive a restart).
  // `requireAuth` gates the router, per that file's own module doc
  // ("behind `requireAuth` like every other `/api/v1/admin/*` router").
  const { store: credentialStoreForAsks } = createCredentialStore(graphPool, credentialMasterKey.key);
  const credentialAskStore = graphPool
    ? new PostgresCredentialAskStore(graphPool)
    : new InMemoryCredentialAskStore(credentialStoreForAsks);
  app.use(
    '/api/v1/admin/credential-asks',
    requireAuth,
    createCredentialAskRouter({ store: credentialAskStore }),
  );
  console.log(
    `[middleware] credential-asks endpoint ready at /api/v1/admin/credential-asks (backend=${graphPool ? 'postgres' : 'in-memory'})`,
  );

  // Slice 9 — inconsistency detection workflow. Always mount (the
  // routes work without a detector — manual /detect 503s, list/get/
  // resolve work because they only touch the KG). Resolve hits the
  // CURRENT registry entry (= the inconsistency-triggering wrapper
  // when orchestrator-extras is active) so a_wins/b_wins re-fire
  // detection on the surviving MK automatically. `requireAuth` gates
  // the router, consistent with the other /api/v1/admin/* mounts;
  // Werkstatt optionalAuth dropped per OB-106.
  const inconsistencyDetectorSvc =
    serviceRegistry.get<InconsistencyDetectorService>('inconsistencyDetector');
  const wrappedKgForRoutes =
    serviceRegistry.get<typeof knowledgeGraph>('knowledgeGraph') ??
    knowledgeGraph;
  // Slice 9.5 — bulk-detect service is optional; the route 503s when
  // it's not published, so the UI can render the panel uniformly.
  const bulkInconsistencyService =
    serviceRegistry.get<BulkInconsistencyService>('bulkInconsistencyDetect');
  app.use(
    '/api/v1/admin/inconsistencies',
    requireAuth,
    createInconsistenciesRouter({
      graph: wrappedKgForRoutes,
      ...(inconsistencyDetectorSvc ? { detector: inconsistencyDetectorSvc } : {}),
      ...(bulkInconsistencyService ? { bulkDetect: bulkInconsistencyService } : {}),
    }),
  );
  console.log(
    `[middleware] inconsistencies endpoint ready at /api/v1/admin/inconsistencies (detector=${inconsistencyDetectorSvc ? 'on' : 'off'}, bulk=${bulkInconsistencyService ? 'on' : 'off'})`,
  );

  // Danger Zone — bulk memory purge (scratch + KG). Cookie-auth admin
  // surface, consistent with the other /api/v1/admin/* routers the admin
  // UI calls (NOT the machine ADMIN_TOKEN surface). `requireAuth` gates
  // the router; type-to-confirm is enforced per-route.
  // #1831 (ADR-0185) — the rule entries follow the seeded `_rules/` files.
  // Runs once at boot (the memory plugin seeded during activation) and after
  // a purge that removed memorable knowledge. Needs the Postgres graph: the
  // rule entries are matched by SQL.
  const syncDurableRules = graphPool
    ? () =>
        runDurableRulesSync({
          store: memoryStore,
          kg: knowledgeGraph,
          pool: graphPool,
          tenantId: graphTenantId,
          embeddingClient: () => serviceRegistry.get<EmbeddingClient>('embeddingClient'),
        })
    : undefined;
  if (syncDurableRules) void syncDurableRules();

  app.use(
    '/api/v1/admin/memory/purge',
    requireAuth,
    createMemoryPurgeRouter({
      store: memoryStore,
      ...(knowledgeGraph ? { knowledgeGraph } : {}),
      ...(graphPool ? { graphPool } : {}),
      seedDir: config.MEMORY_SEED_DIR,
      tenantId: graphTenantId,
      ...(syncDurableRules ? { syncDurableRules } : {}),
      processMemory: () => serviceRegistry.get<ProcessMemoryService>('processMemory'),
    }),
  );

  // ADR-0185 (#1829, #1831) — list and delete memorable knowledge without an
  // owner. Same gate as the purge: a signed-in operator, audited.
  app.use(
    '/api/v1/admin/memory/ownerless',
    requireAuth,
    createMemoryOwnerlessRouter({
      knowledgeGraph,
      ...(graphPool ? { adminAudit: new AdminAuditLog(graphPool) } : {}),
    }),
  );
  console.log(
    '[middleware] memory-purge endpoint ready at /api/v1/admin/memory/purge',
  );

  // W5 (#860) — operator memory promotion: the ONE way knowledge crosses a
  // chat-context boundary, since a context turn can no longer write into the
  // agent tier itself. Deliberately on the SAME gate and the SAME prefix as
  // the purge router above (`requireAuth`, cookie session JWT), not on the
  // machine-to-machine ADMIN_TOKEN surface in `admin.ts`: promotion is an
  // operator judgement call that has to be attributable to a person, and the
  // audit line records that person as its actor. The spec's
  // `/api/agents/:slug/memory/promotions` would have been a third auth surface
  // for a Danger-Zone-class action; the deviation is deliberate.
  app.use(
    '/api/v1/admin/memory/promotions',
    requireAuth,
    createMemoryPromoteRouter({ store: memoryStore }),
  );
  console.log(
    '[middleware] memory-promote endpoint ready at /api/v1/admin/memory/promotions/:slug',
  );

  // #575 — audience-floor grants. Cookie-auth admin surface like the routers
  // above. Mounted whenever Postgres is present, INDEPENDENTLY of whether the
  // floor is enforcing: an operator has to be able to seed and review the grant
  // table before enforcement starts, because the floor fails closed and
  // switching it on against an empty table bounds every room to nothing.
  if (audienceGrantStore) {
    app.use(
      '/api/v1/admin/audience-grants',
      requireAuth,
      createAudienceGrantRouter({
        store: audienceGrantStore,
        actor: (req) => req.session?.email ?? 'unknown',
      }),
    );
    console.log(
      `[middleware] audience-grants endpoint ready at /api/v1/admin/audience-grants (enforcement ${
        config.AUDIENCE_FLOOR_ENABLED ? 'ON' : 'off'
      })`,
    );
  }

  // Rolling self-update (#432). Cookie-auth admin surface like the Danger Zone
  // above. Three capability tiers, and the endpoint reports honestly which one
  // is active rather than hiding the difference:
  //   - always:                  version surface + newer-release check
  //   - with a Postgres graph:   the `update_audit` trail
  //   - with the update overlay: actually executing a version bump
  app.use(
    '/api/v1/admin/update',
    requireAuth,
    createAdminUpdateRouter({
      currentVersion: appVersion,
      platform: appPlatform,
      releaseLookup: createReleaseLookup({
        repo: config.OMADIA_RELEASE_REPO,
        ...(config.OMADIA_RELEASE_TOKEN
          ? { token: config.OMADIA_RELEASE_TOKEN }
          : {}),
      }),
      ...(config.OMADIA_UPDATER_URL && config.OMADIA_UPDATER_TOKEN
        ? {
            updater: createUpdaterClient({
              baseUrl: config.OMADIA_UPDATER_URL,
              token: config.OMADIA_UPDATER_TOKEN,
            }),
          }
        : {}),
      ...(graphPool ? { audit: createUpdateAuditStore(graphPool) } : {}),
    }),
  );
  console.log(
    `[middleware] update endpoint ready at /api/v1/admin/update (version=${appVersion.version}, executor=${config.OMADIA_UPDATER_URL ? 'on' : 'notify-only'})`,
  );

  // Memory-storage backend switch (postgres ↔ inmemory). Cookie-auth admin
  // surface, consistent with the memory-purge router above. Reads/writes the
  // persisted `memory_backend` choice on the active memoryStore provider's
  // registry entry; the swap is applied by bootstrapMemoryFromEnv on the NEXT
  // restart (no live hot-swap).
  app.use(
    '/api/v1/admin/memory/backend',
    requireAuth,
    createMemoryBackendRouter({
      registry: installedRegistry,
      config,
    }),
  );
  console.log(
    '[middleware] memory-backend endpoint ready at /api/v1/admin/memory/backend',
  );

  // OM-75 / OM-78 (#1000, #1001) — the readiness verdict the operator-agents
  // 503 carries. Hoisted out of the mount so the wiring-pin tests' lazy
  // `createOperatorAgentsRouter\(\{…\}\)` match still spans every option.
  // `async` so a synchronous throw from `listModels()` / the registry lands in
  // the router's `.catch` instead of escaping the handler. Memoised for a few
  // seconds: a fresh dashboard fires several 503-probing widgets at once, and
  // each would otherwise re-run the credential lookup and CLI detection.
  const resolveOperatorRuntimeReadinessCause = memoizeRuntimeReadinessCause(
    async (): Promise<RuntimeReadinessCause> =>
      resolveRuntimeReadinessCause({
        providerIds: [...new Set(listModels().map((m) => m.provider))],
        orchestratorConfig: installedRegistry.get('@omadia/orchestrator')?.config,
        vault: secretVault,
        llmProviderCatalog,
      }),
  );

  // #1033 W2 — what the model-policy write path validates against: the live
  // model catalogue (built-in adapters + manifest-installed provider plugins,
  // via `resolveModelRef`) and the kernel provider pool (keyed = usable).
  // Nothing about models is hard-coded here; the catalogue is the source.
  // `orchestratorActiveProviderId` is declared further down and read lazily
  // per request, long after boot.
  const modelPolicyContextFor = () => ({
    resolveModel: (provider: string, model: string) =>
      resolveModelRef(`${provider}:${model}`),
    usable: (provider: string) => kernelProviderPool.usable(provider),
    activeProvider: orchestratorActiveProviderId(),
  });

  // #1018 — the chats an agent's bot is actually in (kernel table from graph
  // migration 0031), so the peer-chat picker offers only those instead of a
  // typed-in id. Same store the conductor's presence check reads; created
  // once, no DATABASE_URL means no candidates. Named here, not inline, for
  // the wiring-pin tests' lazy regex.
  const peerChatDirectory = graphPool
    ? createBotPresenceStore(graphPool, (msg) => console.log(msg))
    : undefined;
  const peerChatDirectoryFor = () => peerChatDirectory;

  // Spec 2042 §5.3 — an agent's own bot on Telegram, Discord, Slack: the
  // channel plugin runs it (`agentIdentities@1`), the kernel stores the key.
  const agentChannelIdentities: AgentChannelIdentityService | undefined = graphPool
    ? createAgentChannelIdentityService({
        providers: agentIdentityProviderRegistry,
        store: createAgentChannelIdentityStore(graphPool),
        reload: async () => {
          await serviceRegistry.get<MultiOrchestratorRegistry>('orchestratorRegistry')?.reload();
        },
        log: (m) => console.log(m),
      })
    : undefined;
  // The channel types a channel plugin acts for, as routing knows them: what
  // it claimed while active (`discord`), else what the dispatcher derives for
  // its id (the API channel binds under its own id). Late-bound: the channel
  // registry is created further down. Named here for the wiring pins.
  const channelTypesOfPlugin = (pluginId: string): readonly string[] => {
    const claimed = (channelRegistryRef as DefaultChannelRegistry | undefined)?.channelTypesOf?.(pluginId) ?? [];
    return claimed.length > 0
      ? claimed
      : [deriveChannelType(pluginId, { manifest: pluginCatalog.get(pluginId)?.plugin.channel })];
  };
  // Named here, not inline, for the wiring-pin tests' lazy
  // `createOperatorAgentsRouter\(\{…\}\)` match.
  const releaseAgentChannelBots = agentChannelIdentities
    ? (agentId: string) => agentChannelIdentities.releaseAll(agentId)
    : undefined;
  app.use(
    '/api/v1/operator/agents',
    requireAuth,
    createOperatorAgentChannelIdentitiesRouter({
      getService: () =>
        serviceRegistry.get<MultiOrchestratorRegistry>('orchestratorRegistry') ? agentChannelIdentities : undefined,
      findAgent: async (slug) => {
        const agent = await serviceRegistry.get<MultiOrchestratorConfigStore>('configStore')?.getAgentBySlug(slug);
        return agent ? { id: agent.id, slug: agent.slug, name: agent.name ?? agent.slug } : undefined;
      },
      recordAudit: async (entry) => {
        await adminAudit?.record(entry);
      },
    }),
  );

  // US9 / T037 — operator-facing Agents dashboard backend. Mounts at
  // /api/v1/operator/agents/*. 503s when the orchestratorRegistry@1
  // service is not published (no DATABASE_URL / orchestrator plugin not
  // active). Writes route through ConfigStore → trigger → reload bus →
  // registry.reload(), so the next request already sees the new config.
  // #2066 — per-agent archetype settings (a facilitator's default methods and
  // reminder policy). Mounted before the main agents router on the same path.
  app.use(
    '/api/v1/operator/agents',
    requireAuth,
    createOperatorAgentArchetypeSettingsRouter({
      getAgent: async (slug) =>
        (await serviceRegistry.get<MultiOrchestratorConfigStore>('configStore')?.getAgentBySlug(slug)) ?? undefined,
      getStore: () => agentArchetypeSettingsStore,
      recordAudit: async (entry) => {
        await adminAudit?.record(entry);
      },
      log: (m) => console.warn(m),
    }),
  );
  app.use(
    '/api/v1/operator/agents',
    requireAuth,
    createOperatorAgentsRouter({
      getConfigStore: () =>
        serviceRegistry.get<MultiOrchestratorConfigStore>('configStore'),
      // (#1033 W2 — `getModelPolicyContext` is passed further down.)
      getRegistry: () =>
        serviceRegistry.get<MultiOrchestratorRegistry>('orchestratorRegistry'),
      getChatSessionStore,
      // Spec 2042 §5.3 — a purged agent's own bots are stopped first.
      releaseChannelIdentities: releaseAgentChannelBots,
      channelTypesOf: channelTypesOfPlugin,
      getFacilitationEngineState: () => serviceRegistry.get<unknown>('facilitationEngine'),
      getPluginCatalog: () => pluginCatalog,
      getInstalledRegistry: () => installedRegistry,
      // #2088 — end of service before a disable or a delete; the audit of both.
      endOfService: agentEndOfService,
      recordAudit: async (entry) => {
        await adminAudit?.record(entry);
      },
      tombstoneRetentionDays: config.AGENT_TOMBSTONE_RETENTION_DAYS,
      getPeerChatDirectory: peerChatDirectoryFor,
      // …and how those chats get a name: the plugin's directory (topic /
      // member-derived label) and the live roster as post-restart fallback.
      getChannelDirectory: () => channelDirectoryRegistry,
      getConversationRosters: () => conversationRosterRegistry,
      // OM-75 / OM-78 (#1000, #1001) — decorate the 503 with WHY the runtime
      // is down, so the readiness banner can tell "no access at all" from
      // "access exists, orchestrator not assigned to it". Same credential
      // verdicts the providers admin renders; no network probe. Kept above
      // the closure-heavy options so the wiring-pin tests' lazy regex, which
      // ends at the first closing paren-brace pair, still sees it.
      getReadinessCause: resolveOperatorRuntimeReadinessCause,
      // #1033 W2 — see `modelPolicyContextFor` above. Kept out of line so the
      // wiring-pin tests' lazy regex is not cut short by an inline object.
      getModelPolicyContext: modelPolicyContextFor,
      // W0c (#861) — the per-agent grant read model needs the graph store.
      // Same graphPool-guarded shape as the other AgentGraphStore sites; when
      // no DATABASE_URL is set the route degrades to its own 503.
      getAgentGraphStore: () =>
        graphPool ? new AgentGraphStore(graphPool) : undefined,
      // W1a (#860) — Teams identity provisioning. Resolved live through the
      // service registry: the agent-factory boot wiring registers the
      // identity store ('agentTeamsIdentityStore', backed by migration 0049)
      // and the provisioning job runner ('teamsProvisioningJobRunner',
      // services/teamsProvisioningJob.ts) once DATABASE_URL is set; the M365
      // connector publishes 'teamsProvisioner' when installed. Until both
      // kernel pieces are registered the routes degrade to their own 503,
      // same shape as the graph-store fallback above. Kernel-side resolution
      // via serviceRegistry.get carries KERNEL_SERVICE_CALLER, so the
      // plugin-facing SERVICE grant gate is not involved here.
      getTeamsIdentity: () => {
        const identityStore = serviceRegistry.get<OperatorTeamsIdentityStore>(
          'agentTeamsIdentityStore',
        );
        const provisioningRunner =
          serviceRegistry.get<OperatorTeamsProvisioningRunner>(
            'teamsProvisioningJobRunner',
          );
        if (!identityStore || !provisioningRunner) return undefined;
        // Migration 0051 — optional on purpose: a middleware whose migrations
        // have not reached 0051 keeps serving the single-binding read model
        // and reports `multi_team: false` with its reason, instead of 500ing
        // against a table that is not there yet.
        const installStore = serviceRegistry.get<OperatorTeamsInstallStore>(
          'agentTeamsInstallStore',
        );
        const teamsDeps: OperatorTeamsIdentityDeps = {
          store: identityStore,
          runner: provisioningRunner,
          resolveTeamName,
          isProvisionerInstalled: () => serviceRegistry.has('teamsProvisioner'),
          // #2043 D8 — the picker's default list: what the bots already know.
          ...(peerChatDirectory
            ? { recentConversations: (limit: number) => peerChatDirectory.recentConversations(limit) }
            : {}),
          // Resolved per call, never cached: the connector can be installed,
          // upgraded or removed while the process runs, and the team-uninstall
          // capability (#900) has to follow it.
          getProvisioner: () => getTeamsProvisioner(serviceRegistry),
          // #924 — the download fallback. Rendered PER REQUEST through the
          // same asset loader and the same connector `buildAppPackage` the
          // chain uses, so what an operator downloads is byte-for-byte what
          // provisioning would upload. Resolved live: without a connector
          // there is nothing to render with, and the route reports that as a
          // capability rather than failing.
          buildAppPackage: async (record) => {
            const provisioner = getTeamsProvisioner(serviceRegistry);
            if (!provisioner) {
              throw new TeamsProvisionerUnavailableError();
            }
            const loader = serviceRegistry.get<
              ReturnType<typeof createTeamsAppPackageAssetLoader>
            >('teamsAppPackageAssetLoader');
            if (!loader) {
              throw new Error(
                'teams app package asset loader is not registered — Postgres-backed agent-factory wiring did not run',
              );
            }
            const assets = await loader({
              agentId: record.agentId,
              botSlug: record.botSlug,
              displayName: record.displayName,
              state: record.state as never,
              appId: record.appId,
              appObjectId: record.appObjectId ?? null,
              tenantId: record.tenantId,
              teamsAppId: record.teamsAppId,
              teamsAppExternalId: record.teamsAppExternalId,
              lastError: record.lastError,
            });
            return provisioner.buildAppPackage({
              manifestTemplate: assets.manifestTemplate,
              params: assets.params,
              icons: assets.icons,
            });
          },
        };
        // Migration 0053 (#915) — same optional posture as 0051: a middleware
        // whose migrations have not reached 0053 serves a status response
        // without a timeline instead of 500ing against a missing table.
        const eventStore = serviceRegistry.get<OperatorTeamsEventStore>(
          'teamsProvisioningEventStore',
        );
        // The teardown writes to the SAME table the runner does, so it lands
        // on the operator's existing timeline instead of a second screen. The
        // WRITE side is bound separately from the read side above: this
        // router has been a pure reader of that log since #915, and the reset
        // is the one thing it does that an operator watches happen.
        const eventWriter = serviceRegistry.get<TeamsResetEventSink>(
          'teamsProvisioningEventStore',
        );
        // #924/#949 — withdrawing the app from the tenant catalog is
        // delegated-only at Microsoft, exactly like uploading it. Resolved
        // live for the same reason as the provisioner: an admin can sign in
        // (or out) while the process runs.
        // WRITE included, and that is what lets both routes refresh a spent
        // access token instead of telling a signed-in admin to sign in
        // (#949). `TeamsDelegatedTokenStore` has always had it; the router's
        // port simply never asked, which is why the target listing had no way
        // to recover and reported the expiry as a missing sign-in.
        const delegatedTokens = serviceRegistry.get<{
          read(): Promise<DelegatedTokenSet | undefined>;
          write(tokens: DelegatedTokenSet): Promise<void>;
        }>('teamsDelegatedTokenStore');
        const withEvents: OperatorTeamsIdentityDeps = {
          ...teamsDeps,
          ...(eventStore === undefined ? {} : { events: eventStore }),
          ...(eventWriter === undefined ? {} : { eventWriter }),
          ...(delegatedTokens === undefined ? {} : { delegatedTokens }),
          // The teardown half of #910. Same registry, same reactivation
          // funnel and the same serialized write queue as the chain's
          // `syncBotConfig` above — a reset and a run that finish at the same
          // moment must not read-modify-write the same config value in
          // parallel, and they cannot, because both go through the module's
          // single queue.
          unsyncBotConfig: (botSlug: string) =>
            dropTeamsBotConfig(
              {
                getInstalledRegistry: () => installedRegistry,
                reactivate: reactivateAgent,
              },
              botSlug,
            ),
        };
        if (installStore === undefined) return withEvents;
        return { ...withEvents, installs: installStore };
      },
      // #914 — the agent identity routes. Registered by the same
      // graphPool-guarded boot block as the provisioning stack, but resolved
      // on its own: identity editing does not depend on Teams being wired.
      getAgentIdentity: () => {
        const store =
          serviceRegistry.get<OperatorAgentIdentityStore>('agentIdentityStore');
        return store ? { store } : undefined;
      },
    }),
  );
  // Spec 2042 §5.4 / §5.11 (#2047, #2079) — consultation switches and grants,
  // integration readerships. Same auth gate; a separate router so the agents
  // router stays the agents router.
  app.use(
    '/api/v1/operator',
    requireAuth,
    createOperatorConsultationRouter({
      getConfigStore: () => serviceRegistry.get<MultiOrchestratorConfigStore>('configStore'),
      consultationStore,
      discretionStore,
      refreshBroker: () => consultationBroker.refresh(),
      recordAudit: async (entry) => {
        await adminAudit?.record(entry);
      },
    }),
  );
  console.log(
    '[middleware] operator-agents endpoints ready at /api/v1/operator/agents/* (auth-gated, incl. teams-identity provisioning)',
  );

  // #924 — the TENANT-wide Teams sign-in. A sibling of /operator/agents, not a
  // route under it: one admin signs in once for the whole directory and every
  // agent provisioned afterwards uses that sign-in, so hanging it off an agent
  // slug would have said the opposite in the URL — and made "sign in before
  // you create your first agent" unrepresentable.
  app.use(
    '/api/v1/operator/teams',
    requireAuth,
    createOperatorTeamsSignInRouter({
      getSignIn: () =>
        serviceRegistry.get<TeamsDelegatedSignInService>(
          'teamsDelegatedSignInService',
        ),
    }),
  );
  console.log(
    '[middleware] tenant Teams sign-in ready at /api/v1/operator/teams/sign-in (auth-gated, device-code flow held server-side)',
  );

  // Phase B+ — operator channels dashboard.
  // #2088 — the archetypes agents can be created of, for the agent directory.
  app.use(
    '/api/v1/operator/archetypes',
    requireAuth,
    createOperatorArchetypesRouter({
      sources: () => ({ installedRegistry, catalog: pluginCatalog }),
      listAgentArchetypes: async () => {
        const store = serviceRegistry.get<MultiOrchestratorConfigStore>('configStore');
        if (!store) return undefined;
        return (await store.listAgents()).map((agent) => archetypeOf(agent));
      },
    }),
  );
  // Spec 2042 §5.10 — the kill switches halt model calls at the gateway's
  // gate: right after an operator sets one here, and every few seconds for
  // one set through another machine.
  const modelCallHaltMirror = createModelCallHaltMirror({
    store: () => executionRef.current?.store,
    agentSlugs: async () => {
      const store = serviceRegistry.get<MultiOrchestratorConfigStore>('configStore');
      return new Map((store ? await store.listAgents() : []).map((agent) => [agent.id, agent.slug]));
    },
    log: (m) => console.log(m),
  });
  modelCallHaltMirror.start(MODEL_CALL_HALT_REFRESH_MS);
  // #2090 — open execution scopes of archetype plugins and the kill switch.
  app.use(
    '/api/v1/operator/execution',
    requireAuth,
    createOperatorExecutionRouter({
      store: () => executionRef.current?.store,
      onKillSwitchesChanged: () => modelCallHaltMirror.refresh(),
      agentBySlug: async (slug) => {
        const agent = await serviceRegistry.get<MultiOrchestratorConfigStore>('configStore')?.getAgentBySlug(slug);
        return agent ? { id: agent.id, slug: agent.slug } : undefined;
      },
      agentSlugs: async () => {
        const store = serviceRegistry.get<MultiOrchestratorConfigStore>('configStore');
        return new Map((store ? await store.listAgents() : []).map((agent) => [agent.id, agent.slug]));
      },
      discussions: () => discussionAdminRef.current,
      onAccessChanged: () => {
        void conversationMessagesRef.current?.reconcileNow().catch((err: unknown) => {
          console.log(
            `[conversation-messages] reconcile after a released reservation failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      },
      audit: async (entry) => {
        await adminAudit?.record(entry);
      },
    }),
  );
  // #2082 — every agent's triggers, their spend and the operator's controls.
  app.use(
    '/api/v1/operator/triggers',
    requireAuth,
    createOperatorTriggersRouter({
      triggers: () => triggersRef.current,
      // Criterion 24 — a Teams conversation needs its stored reference: the
      // shared bot's (`bot_app_id = ''`), never an agent's own bot's, since
      // the shared sender delivers it with the shared bot's credentials.
      knownConversationRef: async (channel, conversationId) => {
        if (channel !== 'teams' || !graphPool) return undefined;
        const { rows } = await graphPool.query<{ ref: unknown }>(
          "SELECT ref FROM teams_conversation_refs WHERE conversation_id = $1 AND bot_app_id = '' ORDER BY updated_at DESC LIMIT 1",
          [conversationId],
        );
        return rows[0]?.ref;
      },
      jobs: () => jobScheduler.list(),
      batchJobs: () => batchJobRegistry.list(),
      audit: async (entry) => {
        await adminAudit?.record(entry);
      },
    }),
  );
  app.use(
    '/api/v1/operator/channels',
    requireAuth,
    createOperatorChannelsRouter({
      getAudit: () => adminAudit,
      getConfigStore: () =>
        serviceRegistry.get<MultiOrchestratorConfigStore>('configStore'),
      getRegistry: () =>
        serviceRegistry.get<MultiOrchestratorRegistry>('orchestratorRegistry'),
      getDirectoryRegistry: () => channelDirectoryRegistry,
    }),
  );
  console.log(
    '[middleware] operator-channels endpoints ready at /api/v1/operator/channels/* (auth-gated)',
  );
  // #2055 — the management layer: the default-agent table (operator) and the
  // agent directory a signed-in user sees per channel (pickers).
  const managementLayerOptions = {
    getConfigStore: () => serviceRegistry.get<MultiOrchestratorConfigStore>('configStore'),
    getRegistry: () => serviceRegistry.get<MultiOrchestratorRegistry>('orchestratorRegistry'),
    // #2054 — the broad-reach check of a default-agent entry.
    reachSources: () => ({
      catalog: pluginCatalog,
      installed: installedRegistry,
      graph: graphPool ? new AgentGraphStore(graphPool) : undefined,
    }),
    audit: async (entry: AuditEntryInput) => {
      await adminAudit?.record(entry);
    },
  };
  app.use(
    '/api/v1/operator/default-agents',
    requireAuth,
    createOperatorDefaultAgentsRouter(managementLayerOptions),
  );
  app.use('/api/v1/agents', requireAuth, createAgentDirectoryRouter(managementLayerOptions));
  console.log(
    '[middleware] management-layer endpoints ready at /api/v1/operator/default-agents and /api/v1/agents/directory (auth-gated)',
  );

  // W2a (#860) — read-only operator browser for the chat-context memory trees.
  // Same gate and same prefix as its operator siblings above (`requireAuth`,
  // cookie session JWT), NOT the machine-to-machine ADMIN_TOKEN surface in
  // `admin.ts`: the memory browser in web-ui authenticates as a logged-in
  // admin user. It replaces `/bot-api/dev/memory/*` (the @omadia/memory dev
  // router), which exposes the WHOLE `/memories` tree to any logged-in session
  // and is dev scaffolding only — so before this mount the browser had no
  // production endpoint at all.
  //
  // The ROOT (undecorated) `memoryStore` is handed in on purpose: the router's
  // own `createRootedMemoryAccessor` is the scope choke point and cannot emit
  // a path outside `/memories/contexts`. It re-checks the session itself too,
  // so a future re-mount that drops `requireAuth` cannot silently open the
  // tree.
  app.use(
    '/api/v1/operator/memory/contexts',
    requireAuth,
    createOperatorMemoryContextsRouter({
      store: memoryStore,
      ...(graphPool ? { resolveMemberNames: createMemberNameResolver(graphPool, graphTenantId) } : {}),
    }),
  );
  console.log(
    '[middleware] operator memory-contexts endpoints ready at /api/v1/operator/memory/contexts/{list,file} (auth-gated, read-only)',
  );

  // The orchestrator's single configured LLM provider id, live-read from the
  // installed `@omadia/orchestrator` config so a runtime provider switch is
  // picked up without a restart (mirrors `hostProviderId` / the sub-agent
  // hydrate reader). Default `anthropic`. Shared by the operator model-write
  // scoping and the builder model picker (issue #296).
  const orchestratorActiveProviderId = (): string => {
    const raw = installedRegistry.get('@omadia/orchestrator')?.config?.[
      'llm_provider'
    ];
    return typeof raw === 'string' && raw.trim().length > 0
      ? raw.trim()
      : 'anthropic';
  };

  // Phase 1b (issue #436) — resolves the skill-verdict LLM instruction-intent
  // verifier lazily, on each explicit-trigger request, so a runtime provider
  // switch (or a not-yet-configured API key) is picked up without a restart.
  // Mirrors `defaultResolveLlm` in issues/issuesRouter.ts (resolved fresh per
  // call, no caching, same as that router). Returns undefined (never throws)
  // when no provider is configured — the route surfaces that as 503
  // `llm_verifier_unavailable`, not a 500.
  const getSkillVerdictLlmVerifier = async (): Promise<LlmVerifier | undefined> => {
    const providerId = orchestratorActiveProviderId();
    const provider = await resolveLlmProvider({
      providerId,
      getSecret: (k) => secretVault.get('@omadia/orchestrator', k),
      catalog: llmProviderCatalog,
      maxRetries: 3,
    });
    if (!provider) {
      console.warn(
        `[middleware] skill-verdict LLM verifier unavailable (providerId=${providerId}) — is the primary provider's API key set?`,
      );
      return undefined;
    }
    const model =
      providerId === 'openai'
        ? 'gpt-4o-mini'
        : providerId === 'mistral'
          ? 'mistral-small-latest'
          : 'claude-haiku-4-5';
    return createLlmVerifier({ provider, model });
  };

  // Agent Builder canvas backend (P1/P2). Mounted at the /api/v1/operator
  // parent so the /agents/:slug/graph|subagents|… subpaths fall through here
  // after the operator-agents router. 503s without a graphPool (in-memory KG
  // backend). Writes route through ConfigStore/AgentGraphStore → notify →
  // registry.reload(), and we reload inline so the response reflects the diff.
  //
  // #1908 (ADR-0175): the MCP OAuth callback is a public path, so `requireAuth`
  // waves it through without reading the cookie. Attach the session best-effort
  // so the callback can refuse a completer other than the flow's starter.
  app.use('/api/v1/operator/mcp-oauth/callback', createOptionalSession(sessionDeps));
  app.use(
    '/api/v1/operator',
    requireAuth,
    createAgentBuilderRouter({
      // #2082 — a schedule change arms or ends its trigger right away.
      onSchedulesChanged: () => {
        void scheduleTriggerScheduler?.sync().catch((err: unknown) => {
          console.log(`[schedules/triggers] sync failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      },
      renewSchedule: scheduleTriggerScheduler
        ? (id, by) => scheduleTriggerScheduler.renew(id, by)
        : undefined,
      getConfigStore: () =>
        serviceRegistry.get<MultiOrchestratorConfigStore>('configStore'),
      // #2054 — the broad-reach confirmation on MCP grants sees plugins too.
      getReachPluginSources: () => ({ catalog: pluginCatalog, installed: installedRegistry }),
      // Closure: adminAudit is constructed further down (undefined = log only).
      recordAudit: async (entry) => {
        if (adminAudit) await adminAudit.record(entry);
        else console.log(`[security-audit] ${entry.action} ${entry.target}`);
      },
      getGraphStore: () =>
        graphPool ? new AgentGraphStore(graphPool) : undefined,
      getRegistry: () =>
        serviceRegistry.get<MultiOrchestratorRegistry>('orchestratorRegistry'),
      // Live-read the orchestrator's single configured provider so per-Agent /
      // sub-agent model writes are scoped to it (issue #296 — a cross-provider
      // pick is rejected instead of silently dropped at build).
      getActiveProvider: orchestratorActiveProviderId,
      getLlmVerifier: getSkillVerdictLlmVerifier,
      // Epic #459 W6 (issue #463): the router's manager gets the same audit
      // observer + dispatch guard as the runtime pool, so sandbox test-calls
      // are policy-enforced and audit-logged.
      ...(graphPool
        ? {
            mcpCallObserver: (entry: McpCallLogEntry) => {
              // Same redaction as the runtime observer — this sink writes to the
              // same `mcp_call_log` table from sandbox test-calls, and was the
              // half that had none. Shared helper, not a second copy of the
              // expression: one redacting sink and one not is exactly what a
              // copy-pasted transform produces.
              void new AgentGraphStore(graphPool)
                .insertMcpCallLog(redactAuditError(entry))
                .catch((err: unknown) => {
                  console.warn(`[middleware] mcp sandbox audit write failed: ${String(err)}`);
                });
            },
          }
        : {}),
      mcpCallGuard: mcpDispatchDenial,
      // Issue #563 — a server deleted / reconfigured / disconnected through the
      // operator UI must also drop out of the RUNTIME pool, not just the
      // router's own. Fire-and-forget: an invalidation failure must never
      // reject inside a request handler.
      onMcpServerChanged: (serverId: string) => {
        void runtimeMcpManager?.close(serverId).catch((err: unknown) => {
          console.warn(`[middleware] mcp pool invalidation failed: ${String(err)}`);
        });
      },
      // W7 UX (issue #458): MCP-capable plugins + their manifest servers_hint,
      // for the operator grant surface. Read live from the catalog so a
      // freshly-installed plugin shows up without a restart.
      listMcpPluginCandidates: () =>
        pluginCatalog.list().map((e) => ({
          id: e.plugin.id,
          name: e.plugin.name,
          mcp: e.plugin.permissions_summary.mcp === true,
          serversHint: e.plugin.permissions_summary.mcp_servers_hint ?? [],
        })),
      // Generic MCP OAuth (epic #459 W9) — begin/callback/manual-client routes.
      ...(mcpOAuthService
        ? {
            mcpOAuth: mcpOAuthService,
            mcpOAuthUserKey,
            // #1908 (ADR-0175) — desktop only: the OS browser that finishes the
            // flow has no session; the loopback kernel's caller is its user.
            mcpOAuthSessionlessCallback: isDesktopLoopbackKernel({
              desktopEmbedded: config.OMADIA_DESKTOP_EMBEDDED,
              host: config.HOST,
            }),
          }
        : {}),
      ...(mcpConfigService ? { mcpConfig: mcpConfigService } : {}),
      ...(mcpRegistrySecrets ? { mcpRegistrySecrets } : {}),
      // Issue #1342 — stdio switch + durable trace of saved stdio servers.
      // Closure: adminAudit is constructed
      // further down, and stays undefined without Postgres (log line only).
      mcpStdioEnabled: config.MCP_STDIO_ENABLED,
      auditMcpStdioServerSaved: async (entry) => {
        // #775 lesson — the SUB is an email and must NEVER land in the uuid
        // actor_id column; the uuid rides separately when the session has one.
        await adminAudit?.record({
          actor: {
            ...(entry.actorUserId ? { id: entry.actorUserId } : {}),
            ...(entry.actor ? { email: entry.actor } : {}),
          },
          action: 'mcp_server.stdio_create',
          target: `mcp-server:${entry.serverId}`,
          after: { name: entry.serverName, source: entry.source },
        });
      },
      // Issue #1925 — one row per removed MCP OAuth authorization.
      auditMcpOAuthDisconnect: async (entry) => {
        await adminAudit?.record({
          actor: {
            ...(entry.actorUserId ? { id: entry.actorUserId } : {}),
            ...(entry.actor ? { email: entry.actor } : {}),
          },
          action: 'mcp_server.oauth_disconnect',
          target: `mcp-server:${entry.serverId}`,
          after: {
            name: entry.serverName,
            identity: entry.identity,
            cause: entry.cause,
            revocation: entry.revocation,
          },
        });
      },
      // W5-1 — the operator surface for `public_mcp_key_bindings`, without
      // which the public MCP endpoint cannot be configured except by hand in
      // psql. A fresh store per call so a graphPool that arrives later is
      // picked up without a restart, matching `getGraphStore` above.
      getPublicMcpBindingStore: () =>
        graphPool ? createPublicMcpKeyBindingAdminStore(graphPool) : undefined,
      // Explicit gate on those routes, independent of the `requireAuth` that
      // sits in front of this mount.
      operatorAuth,
      // #571 — resolve the two ids a binding points at, so a one-character typo
      // is a 400 (agent) or a warning (key) rather than a
      // fully-configured-looking row that reaches zero tools forever. Both
      // sources are read LIVE and from the SAME places a real request resolves
      // against: `configStore` for registered agent slugs, and the verify-only
      // API-key store the public MCP endpoint itself authenticates through
      // (`createVerifyOnlyApiKeyStore` over the shared vault namespace). A read
      // that throws or finds no source returns `undefined` — "cannot tell",
      // which the router never treats as "unknown".
      publicMcpBindingExistence: {
        async knownAgentIds() {
          // Keyed on SLUG, not the agent uuid: `agent_id` stores the
          // orchestrator slug (migration `0033`, and the UI's agent picker sends
          // `option.value = slug`). A caller that sends a uuid is correctly
          // rejected — it is not a valid `agent_id`.
          const configStore =
            serviceRegistry.get<MultiOrchestratorConfigStore>('configStore');
          if (!configStore) return undefined;
          try {
            // ENABLED only. "Known" here has to mean "a real request would
            // resolve it", and dispatch resolves against the ACTIVE registry —
            // a disabled agent is not in it. Counting every configured row let
            // an operator bind to a disabled agent, see a clean green row, and
            // discover at call time that it reaches nothing: the same
            // dead-but-configured-looking state this check exists to prevent,
            // one layer along.
            return new Set(
              (await configStore.listAgents())
                // #2049 — `draft` is not addressable either.
                .filter((a) => a.status === 'enabled')
                .map((a) => a.slug),
            );
          } catch (err) {
            console.warn(
              `[middleware] public-mcp binding agent lister unavailable: ${String(err)}`,
            );
            return undefined;
          }
        },
        async knownKeyIds() {
          try {
            // O(keys) per call — enumerates the channel-api vault namespace and
            // parses each record. Fine at operator scale (one read per list-page
            // load, one per save); revisit with a cache if an install ever holds
            // thousands of keys. The store is a thin read-only adapter, cheap to
            // rebuild, but pinned here so the cost is one construction per call
            // rather than hidden in a closure.
            const keyStore = createVerifyOnlyApiKeyStore(secretVault);
            const keys = await keyStore.list();
            // NOT revoked or expired (#1328). Authentication skips both, so counting
            // one as "known" reports a binding as healthy that can only ever
            // 401. Same reasoning as the enabled-agent filter above: this set
            // answers "would a real request resolve this id", not "is there a
            // row somewhere".
            return new Set(keys.filter((k) => isApiKeyActive(k)).map((k) => k.id));
          } catch (err) {
            console.warn(
              `[middleware] public-mcp binding key lister unavailable: ${String(err)}`,
            );
            return undefined;
          }
        },
      },
    }),
  );
  console.log(
    `[middleware] agent-builder endpoints ready at /api/v1/operator/{agents/:slug/graph,skills,mcp-servers,…} (auth-gated, graphPool=${graphPool ? 'on' : 'off'})`,
  );

  // Agent Builder schedules (P6) fire through their triggers (#2082):
  // `scheduleTriggerScheduler` above, synced by the trigger wiring.

  // Slice 10 — near-duplicate MK workflow. Mirrors the Slice 9
  // mounting pattern: detector + bulk are optional, route 503s when
  // missing. `requireAuth` gates the router, consistent with the
  // other /api/v1/admin/* mounts (Werkstatt optionalAuth dropped).
  const mergeCandidateDetectorSvc =
    serviceRegistry.get<MergeCandidateDetectorService>('mergeCandidateDetector');
  const bulkMergeDetectService =
    serviceRegistry.get<BulkMergeDetectService>('bulkMergeDetect');
  const bulkExcerptMergeDetectService =
    serviceRegistry.get<BulkExcerptMergeDetectService>('bulkExcerptMergeDetect');
  app.use(
    '/api/v1/admin/duplicates',
    requireAuth,
    createDuplicatesRouter({
      graph: wrappedKgForRoutes,
      ...(mergeCandidateDetectorSvc ? { detector: mergeCandidateDetectorSvc } : {}),
      ...(bulkMergeDetectService ? { bulkDetect: bulkMergeDetectService } : {}),
      ...(bulkExcerptMergeDetectService
        ? { bulkExcerptDetect: bulkExcerptMergeDetectService }
        : {}),
    }),
  );
  console.log(
    `[middleware] duplicates endpoint ready at /api/v1/admin/duplicates (detector=${mergeCandidateDetectorSvc ? 'on' : 'off'}, bulk=${bulkMergeDetectService ? 'on' : 'off'}, excerptBulk=${bulkExcerptMergeDetectService ? 'on' : 'off'})`,
  );

  // Slice 11 — Topic clustering admin workflow. Service is always
  // published when orchestrator-extras is active; the route 503s
  // when the capability is missing. `requireAuth` gates the router,
  // consistent with the other /api/v1/admin/* mounts.
  const topicClusteringService =
    serviceRegistry.get<TopicClusteringService>('topicClustering');
  if (topicClusteringService) {
    app.use(
      '/api/v1/admin/topics',
      requireAuth,
      createTopicsRouter({ service: topicClusteringService }),
    );
    console.log(
      '[middleware] topics endpoint ready at /api/v1/admin/topics',
    );
  } else {
    console.log(
      '[middleware] topics endpoint skipped — topicClustering service not published',
    );
  }

  // Cost telemetry read API (web-ui dashboard). Only with a Neon graphPool —
  // in-memory mode persists no usage, so there is nothing to serve.
  if (graphPool) {
    app.use('/api/usage', requireAuth, createUsageRouter({ pool: graphPool }));
    console.log('[middleware] usage cost endpoint ready at /api/usage');
  } else {
    console.log(
      '[middleware] usage cost endpoint skipped — no graphPool (in-memory KG backend)',
    );
  }

  // ── OB-49 — provider-aware auth bootstrap ────────────────────────────────
  // graphPool is resolved above (line ~595). Auth schema + UserStore +
  // ProviderRegistry + first-user-bootstrap all live on the same Postgres.
  // If graphPool is undefined (in-memory backend, used by tests), the
  // local-password path is unavailable — we keep the legacy Entra-only
  // route mounted as a fallback so the in-memory test setup keeps booting.
  // adminAudit hoisted from inside the graphPool block so the profiles
  // router (Phase 2.2 Slice D) can pass it to its snapshot mutation paths.
  let adminAudit: AdminAuditLog | undefined;
  // #330 B3 — hoisted like adminAudit: filled inside the graphPool block once
  // the Conductor's role store exists, read when the targeted-delivery service
  // is constructed further down (before the channel runtime). On the
  // no-Postgres path both stay undefined and role sends degrade to a
  // 'role_resolution_unavailable' diagnostic while user sends keep working.
  let targetedRoleResolver: ((roleKey: string) => Promise<AggregateHolderLookup>) | undefined;
  let targetedBindingLookup: ((principalIds: string[], channelType: string) => Promise<Map<string, unknown>>) | undefined;
  // #330 C3b (review H1) — conversationSend scope authority: an agent may only
  // post into conversations it holds an ephemeral attachment for. Stays
  // undefined without Postgres → the service fails closed.
  // #2043 — authenticated inbound messages; needs the database, so it stays
  // undefined on the in-memory backend (adapters then keep their mention gate).
  let conversationMessages: ConversationMessagesWiring | undefined;
  // #2043 — readiness and session capabilities work without a database; only
  // their pushes follow message subscriptions.
  // Asked by the orchestrator on every group turn of a facilitator.
  serviceRegistry.provide(
    FACILITATOR_CONVERSATIONS_SERVICE,
    createFacilitatorRuntimeLookup({
      getRegistry,
      getMessages: () => conversationMessages?.hub,
      engineSources: facilitationEngineSources,
      reportedEngineState: () => serviceRegistry.get<unknown>('facilitationEngine'),
      ownPosts: ownIdentityPostLog,
      getPrivateMessages: () => privateMessageRouter,
      getAddressedMessages: () => addressedMessageRouter,
      getLinkRequests: () => linkRequestRouter,
    }),
  );
  const sessionCapabilityHub = wireSessionCapabilities({
    serviceRegistry,
    readiness: readinessProviderRegistry,
    meetingSources: meetingSourceRegistry,
    getRegistry,
    getMessages: () => conversationMessages?.hub,
    engineSources: facilitationEngineSources,
    log: (m) => console.log(m),
  });
  if (graphPool) {
    await runAuthMigrations(graphPool, (m) => console.log(m));
    await runProfileStorageMigrations(graphPool, (m) => console.log(m));
    await runProfileSnapshotMigrations(graphPool, (m) => console.log(m));

    // Conductor (Spec 005) — deterministic workflow engine. Migrations + stores +
    // run executor + operator API, all behind the graphPool (inert in-memory).
    // Agent steps run real turns on Agents (orchestrator instances) resolved by slug
    // from the registry; action steps invoke real connector tools.
    // #330 C2a — the full attachment-cleanup chain is built BEFORE wireConductor
    // (review H2b): the reaper's first tick fires inside wireConductor, and a
    // boot with expired ephemerals is the normal restart case. Everything here
    // is pool-backed or lazily resolved, so no wiring output is needed.
    const ephemeralAttachmentsStore = new ConductorEphemeralAttachmentsStore(graphPool);
    // #330 follow-up — the invite index survives restarts: a deploy between
    // the Teams invite and the start of a moderation must not force a
    // re-invite. Hydration is awaited (cheap, one bounded SELECT) so the
    // presence check is warm before the first message subscription asks;
    // writes stay fire-and-forget.
    observedInvites.attachPersistence(new PgObservedInvitePersistence(graphPool));
    try {
      await observedInvites.hydrate();
    } catch (err) {
      // Persistence is an upgrade, never a dependency: a missing table or a
      // flaky pool degrades to the old re-invite-after-restart behaviour —
      // it must not turn the boot into an outage (review H1).
      console.log(
        `[middleware] invite-index hydration skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const facilitationRoleStore = new ConductorRoleStore(graphPool);
    const auditBindingChange = async (entry: {
      actor: string;
      action: 'bind' | 'unbind';
      channelType: string;
      channelKey: string;
      agentSlug: string;
    }): Promise<void> => {
      await adminAudit?.record({
        actor: auditActorFromLabel(entry.actor),
        action: 'channel.binding_change',
        target: `channel-binding:${entry.channelType}/${entry.channelKey}`,
        before: { action: entry.action },
        after: { agentSlug: entry.agentSlug },
      });
    };
    // THE one disposal path (reap hook, guarded unbind, retry sweep): remove
    // the binding, close the role holders (audited), and only then delete the
    // row — a failure keeps the row, so the attachment sweep retries it.
    // #2090 — execution scopes, conversation reservations and the kill switch
    // of archetype plugins. Before the Conductor: its discussions share the
    // reservation.
    executionRef.current = wireExecutionAuthorization({
      pool: graphPool,
      serviceRegistry,
      getRegistry,
      configuringMaxHours: config.EXECUTION_SCOPE_CONFIGURING_MAX_HOURS,
      sweepIntervalMs: config.EXECUTION_SCOPE_SWEEP_INTERVAL_MS,
      // #2076 — a session goes live only where its conversation is ready.
      notReadyForAll: async (agentSlug, channelType, conversationId) => {
        const hub = conversationMessagesRef.current?.hub;
        if (!hub) return 'conversation messages are not available';
        return hub.readinessForAll(agentSlug, channelType, conversationId);
      },
      // #2089 — reading follows the reservation and the scopes at once.
      onAccessChanged: () => {
        void conversationMessagesRef.current?.reconcileNow().catch((err: unknown) => {
          console.log(
            `[conversation-messages] reconcile after an access change failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      },
      log: (m) => console.log(m),
    });
    // #2082 — agent-owned triggers (spec 2042 §5.12): hooks, wakeups and
    // timers with deadline, limits, budget and kill switch. The worker starts
    // after the channels registered their proactive senders.
    triggersRef.current = wireTriggers({
      pool: graphPool,
      limits: {
        ...DEFAULT_TRIGGER_LIMITS,
        oneShotMaxDays: config.TRIGGER_ONE_SHOT_MAX_DAYS,
        recurringMaxDays: config.TRIGGER_RECURRING_MAX_DAYS,
        minIntervalSeconds: config.TRIGGER_MIN_INTERVAL_MINUTES * 60,
        minIntervalSecondsLive: config.TRIGGER_MIN_INTERVAL_LIVE_MINUTES * 60,
        maxActivePerAgent: config.TRIGGER_MAX_ACTIVE_PER_AGENT,
        perFiringUsdMax: config.TRIGGER_MAX_USD_PER_FIRING,
        perFiringUsdDefault: Math.min(DEFAULT_TRIGGER_LIMITS.perFiringUsdDefault, config.TRIGGER_MAX_USD_PER_FIRING),
        perTriggerUsdMax: config.TRIGGER_MAX_USD_PER_TRIGGER,
        perTriggerUsdDefault: Math.min(DEFAULT_TRIGGER_LIMITS.perTriggerUsdDefault, config.TRIGGER_MAX_USD_PER_TRIGGER),
        monthlyAgentUsd: config.TRIGGER_MONTHLY_USD_PER_AGENT,
        monthlyInstanceUsd: config.TRIGGER_MONTHLY_USD_PER_INSTANCE,
      },
      recipientDefaults: {
        timezone: config.PROACTIVE_TIMEZONE,
        quiet: parseQuietHours(config.PROACTIVE_QUIET_HOURS),
        maxPerHour: config.PROACTIVE_MAX_PER_HOUR,
      },
      enabled: config.TRIGGERS_ENABLED,
      tickMs: config.TRIGGER_TICK_MS,
      leaseMs: config.TRIGGER_LEASE_MS,
      agentBySlug: (slug) => {
        const agent = getRegistry()?.get(slug)?.agent;
        return agent
          ? {
              id: agent.id,
              slug: agent.slug,
              enabled: agent.status === 'enabled',
              displayName: agent.identityName?.trim() || agent.slug,
            }
          : undefined;
      },
      agentChat: (slug) => getRegistry()?.get(slug)?.built.bundle.agent,
      // #2045 — the agent's own speaker and emitter, as its bundle stamps them.
      speakerOf: (slug) => {
        const agent = getRegistry()?.get(slug)?.built.bundle.agent;
        return agent ? speakerOf(agent) : undefined;
      },
      emitterOf: (slug) => {
        const agent = getRegistry()?.get(slug)?.built.bundle.agent;
        return agent ? emitterOf(agent) : undefined;
      },
      ownChannelKey: (slug, channel) => getRegistry()?.channelIdentityFor(slug, channel)?.channelKey,
      dataPlanGuardOf: (slug) => getRegistry()?.get(slug)?.built.dataPlanGuard,
      // The agent's OWN read tools: granted plugin tools without write
      // capabilities, never a sub-agent's inner tools (`via`), never MCP
      // tools (they need a person's identity a trigger firing lacks).
      readToolsOf: (slug) => {
        const entry = getRegistry()?.get(slug);
        if (!entry) return undefined;
        const tools = new Map<string, (input: unknown) => Promise<string>>();
        for (const def of entry.built.bundle.raw.offeredToolDefinitions()) {
          if (def.via !== undefined || def.invoke !== undefined) continue;
          const handler = nativeToolRegistry.get(def.name)?.handler;
          if (!handler) continue;
          // #2079 — what the read brought in labels the turn (S5 discretion):
          // an answer carrying these rows is checked against its readers.
          tools.set(def.name, async (input) => {
            const out = nativeToolDispatchText(await handler(input), def.name);
            await entry.built.bundle.raw.labelHarnessRead(def.name);
            return out;
          });
        }
        return tools;
      },
      grantedPluginIds: (slug) =>
        (getRegistry()?.get(slug)?.plugins ?? []).filter((p) => p.enabled).map((p) => p.pluginId),
      eventCatalog: () => eventCatalogRegistry.byPluginId(),
      channelPluginIds: () => channelPluginIdsRef.current(),
      senders: () => routinesHandle?.senderRegistry,
      routines: () => routineTriggerScheduler,
      schedules: () => scheduleTriggerScheduler,
      batchJobs: batchJobRegistry,
      enabledAgents: () =>
        (getRegistry()?.list() ?? [])
          .filter((a) => a.agent.status === 'enabled')
          .map((a) => ({ id: a.agent.id, slug: a.agent.slug })),
      registerNativeTool: (name, handler, options) =>
        nativeToolRegistry.register(name, { handler, spec: options.spec, isAvailable: options.isAvailable }),
      audit: () => async (entry) => {
        await adminAudit?.record(entry);
      },
      // Criterion 18 — a firing reads its room's field rights now, from the
      // same grants as the audience floor (none published = floor off). No
      // role sources are wired for the live floor either (the orchestrator
      // plugin passes an empty registry); wire them here too once it does.
      fieldRightSources: () => {
        const grants = serviceRegistry.get<GrantStore>('audienceGrants');
        return grants ? { grants, roles: new RoleSourceRegistry() } : undefined;
      },
      // Criterion 24 — a proactive message is checked against the room's
      // members when it goes out, read fresh from the channel's roster.
      conversationReaders: createConversationReaders({
        getRoster: (channel, conversationId, opts) => conversationRosterRegistry.getRoster(channel, conversationId, opts),
        knowledgeGraph: () => serviceRegistry.get<KnowledgeGraph>('knowledgeGraph'),
        channelKindOf: (channel) => CHANNEL_KIND_BY_ORIGIN[channel],
        log: (m) => console.log(m),
      }),
      log: (m) => console.log(m),
    });
    // Spec 2042 §5.12 — a meeting that ends ends its triggers (criterion 22).
    sessionCapabilityHub.observeLifecycle((event) => {
      void triggersRef.current?.onSessionEvent(event);
    });
    const disposeEphemeralAttachment = async (
      attachment: { id: string; agentSlug: string; channelType: string; channelKey: string; roleKey: string | null },
      actor: string,
    ): Promise<void> => {
      const lateConfigStore = serviceRegistry.get<MultiOrchestratorConfigStore>('configStore');
      const lateRegistry = serviceRegistry.get<MultiOrchestratorRegistry>('orchestratorRegistry');
      if (!lateConfigStore || !lateRegistry) {
        throw new Error('configStore/orchestratorRegistry not ready — attachment kept for retry');
      }
      await lateConfigStore.removeChannelBinding(attachment.channelType, attachment.channelKey);
      await lateRegistry.reload();
      // A row written by the plugin-era facilitation may still name a role
      // (nothing creates one any more). Its holders are closed with it, and
      // the change is audited like before.
      if (attachment.roleKey) {
        const roleKey = attachment.roleKey;
        for (const holderId of await facilitationRoleStore.resolve(roleKey)) {
          await facilitationRoleStore.removeHolder(roleKey, holderId);
          await adminAudit
            ?.record({
              // #775 class — a system label (the reaper) is not a uuid.
              actor: auditActorFromLabel(actor),
              action: 'conductor.role_holders_change',
              target: `conductor-role:${roleKey}`,
              before: { action: 'remove', holderId },
              after: { holders: await facilitationRoleStore.resolve(roleKey) },
            })
            .catch(() => undefined);
        }
      }
      await ephemeralAttachmentsStore.delete(attachment.id);
      // #2090 — the discussion is over: the conversation is free for the next
      // process (a discussion or a facilitation).
      await executionRef.current?.store
        .release({
          channelType: attachment.channelType,
          conversationId: attachment.channelKey,
          holderKind: 'agent_discussion',
          reason: `discussion ended (${actor})`,
        })
        .catch((err: unknown) => {
          console.log(
            `[conductor] releasing the reservation of ${attachment.channelType}/${attachment.channelKey} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      await auditBindingChange({
        actor,
        action: 'unbind',
        channelType: attachment.channelType,
        channelKey: attachment.channelKey,
        agentSlug: attachment.agentSlug,
      }).catch(() => undefined);
      console.log(`[conductor] disposed ephemeral attachment ${attachment.channelType}/${attachment.channelKey}${attachment.roleKey ? ` (role ${attachment.roleKey})` : ''} by ${actor}`);
    };
    const onEphemeralReaped = async (workflow: { id: string; slug: string }): Promise<void> => {
      const rows = await ephemeralAttachmentsStore.getByWorkflow(workflow.id);
      for (const row of rows) {
        try {
          await disposeEphemeralAttachment(row, 'conductor-ephemeral-reaper');
        } catch (err) {
          console.log(
            `[conductor] ephemeral attachment disposal for '${workflow.slug}' failed (sweep retries after expiry): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    };
    // Which bots hold a conversation reference where — the presence signal the
    // agent-discussion partner list is built on (graph migration 0031).
    const botPresence = createBotPresenceStore(graphPool, (msg) => console.log(msg));
    // Who can actually be heard in this chat: an agent needs its own bot AND
    // that bot needs a conversation reference here. Provisioning alone is
    // not enough — a partner whose bot was never added would have its turns
    // generated, paid for and dropped.
    //
    // Presence comes from the reference table, NOT the roster: Teams'
    // roster API returns people, never bots, so a roster-based check finds
    // nothing in a chat full of bots (which is exactly what it did on the
    // first live run).
    const AGENT_BOT_PRESENCE_TIMEOUT_MS = 3_000;
    // Spec 2042 §5.3 — other channels: the plugin knows which agent bots are
    // members of the group (`agentIdentities@1.presentIn`).
    const presentAgentBots = async (
      registry: MultiOrchestratorRegistry,
      channelType: string,
      conversationId: string,
    ): Promise<{ slug: string; name: string; channelKey: string }[]> => {
      const provider = agentIdentityProviderRegistry.get(channelType);
      if (!provider?.presentIn) return [];
      // A plugin that hangs here must not stall `get_chat_participants`.
      let timer: NodeJS.Timeout | undefined;
      const keys = await Promise.race([
        provider.presentIn(conversationId).catch(() => [] as readonly string[]),
        new Promise<readonly string[]>((resolve) => {
          timer = setTimeout(() => resolve([]), AGENT_BOT_PRESENCE_TIMEOUT_MS);
        }),
      ]).finally(() => clearTimeout(timer));
      const bots: { slug: string; name: string; channelKey: string }[] = [];
      for (const raw of keys) {
        const channelKey = normalizeAgentIdentityKey(raw);
        const owner = registry.identityForChannel(channelType, channelKey);
        if (!owner || bots.some((b) => b.slug === owner.agent.slug)) continue;
        bots.push({ slug: owner.agent.slug, name: owner.agent.name ?? owner.agent.slug, channelKey });
      }
      return bots;
    };
    const presentBots = async (
      channelType: string,
      conversationId: string,
    ): Promise<{ slug: string; name: string; channelKey: string }[]> => {
      const registry = getRegistry();
      if (!registry) return [];
      if (channelType !== 'teams') return presentAgentBots(registry, channelType, conversationId);
      const present = await botPresence.botAppIdsIn(conversationId);
      const seen = new Set<string>();
      const bots: { slug: string; name: string; channelKey: string }[] = [];
      for (const appId of present) {
        const channelKey = `28:${appId}`;
        const owner = registry.identityForChannel(channelType, channelKey);
        if (!owner || seen.has(owner.agent.slug)) continue;
        seen.add(owner.agent.slug);
        bots.push({ slug: owner.agent.slug, name: owner.agent.name ?? owner.agent.slug, channelKey });
      }
      return bots;
    };
    const listenUrl = directDatabaseUrl(config.DATABASE_URL, config.DATABASE_URL_DIRECT);
    if (isPooledDatabaseUrl(config.DATABASE_URL) && config.CONVERSATION_MESSAGES_LISTEN) {
      console.log(
        `[conversation-messages] DATABASE_URL is a pooled address; LISTEN connects directly (${config.DATABASE_URL_DIRECT ? 'DATABASE_URL_DIRECT' : 'the same host without -pooler'})`,
      );
    }
    conversationMessages = await wireConversationMessages({
      pool: graphPool,
      serviceRegistry,
      getRegistry,
      invites: observedInvites,
      botPresence,
      engineSources: facilitationEngineSources,
      getConfigStore: () => serviceRegistry.get<MultiOrchestratorConfigStore>('configStore'),
      listen: config.CONVERSATION_MESSAGES_LISTEN,
      // LISTEN needs one server session; a transaction-mode pooler (Neon's
      // `-pooler` host) accepts the statement and never delivers.
      ...(listenUrl ? { listenConnectionString: listenUrl } : {}),
      reconcileIntervalMs: config.CONVERSATION_MESSAGES_RECONCILE_INTERVAL_MS,
      checkReadiness: (channelType, conversationId, channelKey) =>
        sessionCapabilityHub.checkIdentity(channelType, conversationId, channelKey),
      graceMs: config.CONVERSATION_MESSAGES_GRACE_MS,
      maxAgeDays: config.CONVERSATION_MESSAGES_MAX_AGE_DAYS,
      purgeIntervalMs: config.CONVERSATION_MESSAGES_PURGE_INTERVAL_MS,
      // #2089 — a process reads a conversation by its execution scopes and
      // its reservation.
      privateMessages: privateMessageRouter,
      addressedMessages: addressedMessageRouter,
      linkRequests: linkRequestRouter,
      processAccess: (process) => {
        const store = executionRef.current?.store;
        if (!store) return Promise.reject(new Error('the execution store is not available'));
        return store.processAccess(process);
      },
      log: (m) => console.log(m),
    });
    conversationMessagesRef.current = conversationMessages;
    // #1018 W1 — THE peer gate: the agent's own switch AND the pair's policy
    // row (migration 0058), evaluated in one place for the discussion start,
    // every relayed utterance, and the roster the calling agent sees.
    const peerGate = createPeerGate({
      getRegistry,
      listChannelPeerPolicies: (channelType, channelKey) => {
        const store = serviceRegistry.get<MultiOrchestratorConfigStore>('configStore');
        return store ? store.listChannelPeerPolicies(channelType, channelKey) : Promise.resolve([]);
      },
      log: (msg) => console.log(msg),
    });
    // `chatPeerAgents@1` — what `get_chat_participants` merges in as
    // `kind: 'agent'`. Everything derives from the ambient turn; the caller
    // supplies nothing and therefore sees no chat but its own.
    serviceRegistry.provide(
      'chatPeerAgents',
      createChatPeerAgentsProvider({
        resolveTurn: () => ambientTurnFrom(routineTurnContext.current()),
        resolveOpener: (channelType, botChannelKey) =>
          getRegistry()?.identityForChannel(channelType, botChannelKey)?.agent.slug,
        listPresent: presentBots,
        peerGate,
      }),
    );
    // MCP tools as Conductor actions — own store handle on the same pool (the
    // McpManager's `mcpAuditStore` lives in the orchestrator block above).
    const conductorMcpServerStore = new AgentGraphStore(graphPool);
    const invokeMcpAction = createMcpActionInvoker({
      listServers: () => conductorMcpServerStore.listMcpServers(),
      getMcp: () => runtimeMcpManager,
      toConfig: mcpRowToConfig,
      // Same policy the orchestrator dispatch enforces (scan verdicts, acks, disabled servers).
      dispatchDenial: mcpDispatchDenial,
      log: (m) => console.log(m),
    });
    // Spec 2042 §5.4 / ADR-0018 — two agents may discuss only when each holds
    // a consultation grant for the other (same grants as `consult`). One check
    // for the chat capability, the operator route and every utterance.
    const discussionMutualGrant = async (a: string, b: string, channelType: string): Promise<boolean> => {
      const registry = getRegistry();
      const left = registry?.get(a)?.agent.id;
      const right = registry?.get(b)?.agent.id;
      return (
        left !== undefined &&
        right !== undefined &&
        consultationStore.hasMutualGrants(left, right, channelType)
      );
    };
    const conductorWiring = await wireConductor({
      pool: graphPool,
      mutualGrant: discussionMutualGrant,
      // #2090 — one reservation per conversation, shared by agent discussions
      // and native facilitations. A reservation left by a discussion whose
      // attachment is gone is stale and is taken over.
      conversationReservations: {
        reserve: async (channelType, conversationId) => {
          const store = executionRef.current?.store;
          if (!store) return true;
          const mine = { channelType, conversationId, holderKind: 'agent_discussion' as const, role: 'home' as const };
          const processId = `discussion:${randomUUID()}`;
          const first = await store.reserve({ ...mine, processId });
          if (first.ok) return true;
          if (first.heldBy?.holderKind !== 'agent_discussion') return false;
          await store.release({ ...mine, reason: 'stale discussion reservation' });
          return (await store.reserve({ ...mine, processId })).ok;
        },
        release: async (channelType, conversationId, reason) => {
          await executionRef.current?.store.release({ channelType, conversationId, holderKind: 'agent_discussion', reason });
        },
      },
      onEphemeralReaped,
      app,
      requireAuth,
      getRegistry,
      // The channel's own default bot, as its plugin names it per call
      // (`agentIdentities@1`, or the default-key provider of a channel without
      // one, Teams). Only this bot may route to its binding / the fallback
      // agent in the Conductor; any other unknown bot stays refused.
      defaultChannelBotKey: defaultChannelBotKeyFrom([agentIdentityProviderRegistry, defaultChannelKeyRegistry]),
      // People directory union for the builder's person suggestions + `GET /people`.
      searchPeople: (query, opts) => peopleDirectoryRegistry.search(query, opts),
      peopleChannelTypes: () => peopleDirectoryRegistry.types(),
      // Agent dialogue: a `say` step publishes an agent's turn into the chat.
      // The SAME registry the plugin-facing conversationSend uses — one owner
      // per channel type, so a discussion cannot be posted by a hijacked provider.
      conversationSendProviders: conversationSendRegistry,
      // #1018 — re-checked on every utterance, so an operator's flip bites at
      // the agent's next turn rather than at the end of the run.
      peerGate,
      // `webhook.post` (issue #437) is a built-in action, not a plugin tool — special-cased
      // ahead of the plugin-tool dispatch so a Designer action step can fire an
      // ad-hoc outbound webhook without an installed connector.
      // `mcp:<serverId>:<tool>` ids are connected MCP servers' tools — dispatched to the
      // McpManager in the operator trust class (same as the Control Center test-call),
      // service delegation only; see mcpActionInvoker.ts.
      invokeAction: (toolId, input) =>
        toolId === WEBHOOK_POST_ACTION_ID
          ? invokeWebhookPostAction(input)
          : parseMcpActionId(toolId)
            ? invokeMcpAction(toolId, input)
            : // S3c — only what `listActions` offers: a plugin tool that declares
              // `deterministic_action: true`. Any other id runs nothing.
              deterministicActionRegistry.has(toolId)
              ? invokePluginTool(nativeToolRegistry, toolId, input)
              : Promise.resolve(undefined),
      listActions: async () => [
        WEBHOOK_POST_ACTION_ID,
        ...deterministicActionRegistry.list().map((id) => {
          const requiredInputs = nativeToolRegistry.get(id)?.spec?.input_schema.required;
          return requiredInputs?.length ? { id, requiredInputs } : id;
        }),
        ...listMcpActions(await conductorMcpServerStore.listMcpServers(), mcpDispatchDenial),
      ],
      eventCatalog: eventCatalogRegistry,
      // US5 reminders: resolve a channel's proactive sender from the routines senderRegistry. Adapt
      // ProactiveSender → the worker's minimal shape ({ text } is a valid SemanticAnswer).
      getProactiveSender: (channel) => {
        const sender = routinesHandle?.senderRegistry.get(channel);
        return sender ? { send: (opts) => sender.send(opts) } : undefined;
      },
      // Issue #437 — inbound endpoint secrets + outbound subscription signing secrets
      // live in the same per-agent-scoped vault as every other subsystem's credentials.
      vault: secretVault,
      // #759 — baton changes land in the admin audit trail. Closure, not the
      // instance: `adminAudit` is constructed further down this block, and the
      // route handler only dereferences it at request time.
      auditRoleChange: async (entry) => {
        // #775 — the mapping lives in roleChangeAuditEntry so it is testable:
        // the previous inline version put an EMAIL into the uuid actor_id
        // column and every audit write failed.
        await adminAudit?.record(roleChangeAuditEntry(entry));
      },
      auditGovernanceChange: async (entry) => { await adminAudit?.record(entry); },
      webhooksEnabled: config.CONDUCTOR_WEBHOOKS_ENABLED,
      // #1707 — webhook administration lands in the admin trail. Closure, not the
      // instance, for the same reason as auditRoleChange: `adminAudit` is constructed
      // further down this block and the route only dereferences it at request time.
      auditWebhookChange: async (entry) => {
        // #775 — the mapping (and the "an email must never reach the uuid actor_id
        // column" rule) lives in webhookChangeAuditEntry so it is testable.
        await adminAudit?.record(webhookChangeAuditEntry(entry));
      },
      webhookTimestampToleranceMs: config.CONDUCTOR_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS * 1000,
      webhookRequireTimestamp: config.CONDUCTOR_WEBHOOK_REQUIRE_TIMESTAMP,
      webhookSecretGraceMs: config.CONDUCTOR_WEBHOOK_SECRET_GRACE_SECONDS * 1000,
      webhookPayloadRetentionDays: config.CONDUCTOR_WEBHOOK_PAYLOAD_RETENTION_DAYS,
      webhookDeliveryRetentionDays: config.CONDUCTOR_WEBHOOK_DELIVERY_RETENTION_DAYS,
      // #330 — guardrails for agent-generated ephemeral workflows (env-tunable).
      ephemeral: {
        defaultTtlMs: config.CONDUCTOR_EPHEMERAL_DEFAULT_TTL_MS,
        maxTtlMs: config.CONDUCTOR_EPHEMERAL_MAX_TTL_MS,
        maxActivePerAgent: config.CONDUCTOR_EPHEMERAL_MAX_ACTIVE_PER_AGENT,
        maxCreatesPerHour: config.CONDUCTOR_EPHEMERAL_MAX_CREATES_PER_HOUR,
        reaperIntervalMs: config.CONDUCTOR_EPHEMERAL_REAPER_INTERVAL_MS,
      },
      webhookInboundMaxPerMinute: config.CONDUCTOR_WEBHOOK_MAX_DELIVERIES_PER_MINUTE,
      // Review finding — the operator UI must display an inbound endpoint URL it can
      // actually reach; PUBLIC_BASE_URL alone isn't reliable here since it may
      // deliberately point at the Next.js dev-server origin (browser-facing), which
      // doesn't proxy /api/hooks/*. CONDUCTOR_WEBHOOK_PUBLIC_BASE_URL overrides it
      // when the two must differ.
      webhookInboundBaseUrl: config.CONDUCTOR_WEBHOOK_PUBLIC_BASE_URL ?? config.PUBLIC_BASE_URL,
      log: (m) => console.log(m),
    });
    // Issue #437 — resolve the inbound-webhook forward reference mounted earlier
    // (before express.json()); requests arriving from here on reach the real deps.
    conductorWebhookInboundDepsRef = conductorWiring.webhookInboundDeps;
    discussionAdminRef.current = conductorWiring.discussionAdmin;
    // Expose the event router so plugin contexts (ctx.events.emit) resolve it lazily — US4.
    serviceRegistry.provide('conductorEventRouter', conductorWiring.eventRouter);
    // #2082 — every domain event on the Conductor bus also reaches the
    // agents' hooks (spec 2042 §5.12: hooks use the same event bus).
    conductorWiring.eventRouter.addObserver((eventId, payload, eventKey) => {
      triggersRef.current?.onEvent(eventId, payload, eventKey);
    });
    // Expose the channel-binding store so the routines turn-capture hook can populate it — US5.
    serviceRegistry.provide('conductorChannelBindings', conductorWiring.channelBindingStore);
    // Expose await resolution so a channel plugin can resolve a human approval in-process when the
    // user clicks an approve/reject card button — no HTTP round-trip. `approved` maps to the engine's
    // fail-open response shape ({ approved }); resolveAwait records the response + resumes the run.
    serviceRegistry.provide('conductorAwaitResolver', {
      resolve: async (
        awaitId: string,
        responderId: string,
        approved: boolean,
      ): Promise<'resumed' | 'recorded' | 'already_resolved' | 'not_a_holder'> => {
        try {
          const run = await conductorWiring.executor.resolveAwait(awaitId, responderId, { approved });
          // 'waiting' ⇒ vote recorded but a quorum='all' await still needs other holders.
          return run.status === 'waiting' ? 'recorded' : 'resumed';
        } catch (err) {
          if (err instanceof AwaitResponderNotHolderError) return 'not_a_holder';
          // stale card / double-click. #1706 split the "no such await row" case out
          // of AwaitNotPendingError for the operator route's 404; from a card button
          // both still mean "nothing left to answer here".
          if (err instanceof AwaitNotFoundError || err instanceof AwaitNotPendingError) return 'already_resolved';
          throw err;
        }
      },
    });
    // #330 — agent-facing create+start seam for ephemeral (JIT) workflows.
    // Deny-by-default like every kernel service: a plugin only reaches it after
    // declaring the service name in its manifest (pluginServiceGrants catalog).
    // Per-caller since 0012: the owner-scoped methods (listOwnRuns/saveRunState/
    // cancelOwnRun) bind agentId to the kernel-known plugin id, so a granted
    // plugin cannot act as another agent. Core itself gets the unscoped service.
    serviceRegistry.provide(
      'conductorEphemeralRuns',
      perCallerService((caller) =>
        caller.pluginId === KERNEL_SERVICE_CALLER.pluginId
          ? conductorWiring.ephemeralRunService
          : bindEphemeralRunsToCaller(conductorWiring.ephemeralRunService, caller, (m) => console.warn(m)),
      ),
    );
    // Agent topic discussions, startable FROM A CHAT. No conversation id in the
    // signature on purpose: the kernel reads the conversation off the inbound
    // turn the calling plugin is answering, so a granted plugin can open a
    // discussion where it was addressed and nowhere else.
    serviceRegistry.provide(
      'conductorDiscussions',
      createDiscussionsCapability({
        discussions: conductorWiring.discussionService,
        resolveTurn: () => ambientTurnFrom(routineTurnContext.current()),
        // The opener is the bot that received the turn, mapped back through the
        // SAME provisioned-identity table inbound routing uses — so "who
        // opened it" and "who was addressed" can never be two different answers.
        resolveOpener: (channelType, botChannelKey) =>
          getRegistry()?.identityForChannel(channelType, botChannelKey)?.agent.slug,
        // Presence (see `presentBots` above) — the gate below decides who of
        // the present may actually take part.
        listPartners: presentBots,
        // #1018 — the opener must be enabled here, and so must every partner.
        peerGate,
        // Spec 2042 §5.4 — and every two of them hold consultation grants for
        // each other (same grants as `consult`).
        mutualGrant: discussionMutualGrant,
        log: (msg: string) => console.log(msg),
      }),
    );
    // The retry + expiry sweep over ephemeral attachments (discussions). The
    // plugin-era setup services that lived beside it are gone (#2043).
    startEphemeralAttachmentSweep({
      attachments: ephemeralAttachmentsStore,
      disposeAttachment: disposeEphemeralAttachment,
      log: (m) => console.log(m),
    });
    // #330 B3 — role fan-out + cached 1:1 conversation refs for targeted sends.
    // Deliberately THE SAME holder registry the executor resolves approvals
    // through: "who gets the report" and "who may approve" come from one
    // instance, so a future external holder source (Entra group, Odoo HR)
    // reaches both paths at once — no drift.
    targetedRoleResolver = (roleKey) => conductorWiring.roleHolderRegistry.resolveHolders(roleKey);
    // Spec 2042 §5.3 — availability entries `role:<key>` are answered by the
    // same registry, from the Conductor's role snapshot (every router asks it).
    setRoleMembership(conductorWiring.roleMembership.hasRole);
    targetedBindingLookup = (principalIds, channelType) =>
      conductorWiring.channelBindingStore.getMany(principalIds, channelType);
    // #478 — plugin-borne workflow templates: hand the composite catalog's
    // registrar to the install service (runtime installs/uninstalls) and
    // re-register templates of already-installed plugins (registrations are
    // in-memory and do not survive a restart). Boot sweep is fail-open per
    // template with a loud log — the fail-closed gate ran at install time.
    conductorTemplateRegistrarRef = conductorWiring.templateCatalog;
    await registerInstalledPluginTemplates({
      catalog: pluginCatalog,
      registry: installedRegistry,
      registrar: conductorWiring.templateCatalog,
      log: (m) => console.log(m),
    });
    console.log('[middleware] conductor wired at /api/v1/operator/conductors/* (auth-gated)');

    // #760 — privacy miss-report review queue (the catch basin for
    // prompt-masking non-detection). Postgres-only, auth-gated like every
    // operator surface; the table is created by the numbered-migration runner
    // at plugin activation.
    app.use(
      '/api/v1/operator/privacy/miss-reports',
      requireAuth,
      createMissReportRoutes(graphPool),
    );
    console.log('[middleware] privacy miss-report queue wired at /api/v1/operator/privacy/miss-reports (auth-gated)');

    // #757 — persistent per-turn privacy receipts. The store is published as
    // a service the orchestrator resolves late-bound at turn end (same shape
    // as `privacyRedact`); the read API mounts auth-gated next to the
    // Conductor's operator surface; retention is enforced by an unref'd
    // reaper (`RECEIPT_RETENTION_DAYS`). Postgres-only by construction —
    // on the in-memory backend none of this wiring runs and receipts stay
    // ephemeral, exactly the pre-#757 behaviour.
    serviceRegistry.provide(
      TURN_RECEIPT_STORE_SERVICE_NAME,
      new PgTurnReceiptStore(graphPool),
    );
    app.use('/api/v1/operator/receipts', requireAuth, createReceiptRoutes(graphPool));
    // Loaded before the reaper: it bounds the reap by signature-valid
    // checkpoints only (#1567, security review M2).
    const checkpointSigner = config.AUDIT_SIGNING_KEY
      ? loadCheckpointSigner(config.AUDIT_SIGNING_KEY)
      : undefined;
    startTurnReceiptReaper(graphPool, {
      retentionDays: config.RECEIPT_RETENTION_DAYS,
      ...(checkpointSigner ? { publicKey: checkpointSigner.publicKey } : {}),
    });
    console.log(
      `[middleware] turn receipts wired at /api/v1/operator/receipts (auth-gated, retention ${config.RECEIPT_RETENTION_DAYS}d)`,
    );

    // #758 — signed checkpoints over the receipt hash chain. The chain
    // itself always builds (the store appends chained rows unconditionally);
    // signing is the layer that needs the operator-held key. Absent key ⇒
    // loud boot log, not a silent no-op.
    // #1565 / #1566 — one per process, shared by the worker (refuses to sign
    // a rewound or rewritten head) and verify (reports it).
    const chainWitness = new ChainWitness();
    if (checkpointSigner) {
      startCheckpointWorker(graphPool, checkpointSigner, {
        intervalMs: config.AUDIT_CHECKPOINT_INTERVAL_MINUTES * 60_000,
        ...(config.AUDIT_ANCHOR_PATH ? { anchorPath: config.AUDIT_ANCHOR_PATH } : {}),
        witness: chainWitness,
      });
      console.log(
        `[middleware] audit checkpoints wired (every ${config.AUDIT_CHECKPOINT_INTERVAL_MINUTES}min, fingerprint ${checkpointSigner.publicKeyFingerprint.slice(0, 16)}…${config.AUDIT_ANCHOR_PATH ? ', external anchor on' : ''})`,
      );
    } else {
      console.warn(
        '[middleware] AUDIT_SIGNING_KEY not set — receipt chain builds WITHOUT signed checkpoints; generate a key with scripts/generate-audit-signing-key.mjs (#758)',
      );
    }
    // Always-on (review LOW): a keyless deployment answers `configured:false`
    // instead of an undifferentiated 404 — #761 tooling can discover the
    // posture either way.
    app.get('/api/v1/operator/provenance/public-key', requireAuth, (_req, res) => {
      res.json({
        configured: Boolean(checkpointSigner),
        ...(checkpointSigner
          ? {
              publicKeyPem: checkpointSigner.publicKeyPem,
              fingerprint: checkpointSigner.publicKeyFingerprint,
            }
          : {}),
        checkpointIntervalMinutes: config.AUDIT_CHECKPOINT_INTERVAL_MINUTES,
        anchorConfigured: Boolean(config.AUDIT_ANCHOR_PATH),
      });
    });

    // #761 — the verification surface over the chain: server-side verify
    // (incl. the #758 premature-deletion check against the checkpoint
    // timeline) and the signed JSONL export the zero-dependency offline
    // verifier (scripts/verify-audit-export.mjs) validates WITHOUT trusting
    // this server.
    app.use(
      '/api/v1/operator/provenance',
      requireAuth,
      createProvenanceRoutes(graphPool, {
        ...(checkpointSigner
          ? {
              publicKeyPem: checkpointSigner.publicKeyPem,
              publicKeyFingerprint: checkpointSigner.publicKeyFingerprint,
            }
          : {}),
        retentionDays: config.RECEIPT_RETENTION_DAYS,
        ...(config.AUDIT_ANCHOR_PATH ? { anchorPath: config.AUDIT_ANCHOR_PATH } : {}),
        checkpointIntervalMinutes: config.AUDIT_CHECKPOINT_INTERVAL_MINUTES,
        witness: chainWitness,
      }),
    );
    console.log('[middleware] provenance verify/export wired at /api/v1/operator/provenance (auth-gated)');

    const userStore = new UserStore(graphPool);
    sessionRevocation.attach(userStore);
    resolveLegacyChatOwner = soleAccountLegacyOwner((limit) => userStore.list({ limit }));
    // #2042 — `humanNames@1` (published before plugin activation) now reads
    // this users table; every user write reloads the snapshot.
    humanNameDirectory.attach(userStore);

    const bootstrapResult = await runAuthBootstrap({
      userStore,
      bootstrapEmail: config.ADMIN_BOOTSTRAP_EMAIL,
      bootstrapPassword: config.ADMIN_BOOTSTRAP_PASSWORD,
      bootstrapDisplayName: config.ADMIN_BOOTSTRAP_DISPLAY_NAME,
      log: (m) => console.log(m),
    });
    // Operator authorisation for the /setup wizard (auth/setupToken.ts):
    // ADMIN_SETUP_TOKEN, else a generated token shared via platform_settings
    // and printed once per boot. Only the desktop kernel on a loopback bind is
    // exempt.
    const setupToken = await initSetupToken({
      configured: config.ADMIN_SETUP_TOKEN,
      setupRequired: bootstrapResult.setupRequired,
      desktopEmbedded: config.OMADIA_DESKTOP_EMBEDDED,
      host: config.HOST,
      store: new PgSetupTokenStore(graphPool),
      log: (m) => console.log(m),
    });

    const requestedProviders = parseAuthProvidersEnv(config.AUTH_PROVIDERS);
    // OB-50: env-var becomes the **whitelist** (catalog of allowed
    // providers). The currently-active subset comes from a Postgres-stored
    // override the admin-UI manages — falls back to "all whitelisted"
    // when no override is present.
    const providerCatalog = new ProviderCatalog();
    for (const id of requestedProviders) {
      if (id === 'local') {
        providerCatalog.add(new LocalPasswordProvider(userStore));
      } else if (id === 'entra') {
        if (!oauthClient) {
          console.log(
            '[auth] entra requested but MICROSOFT_APP_* are unset — skipping entra registration (set MICROSOFT_APP_ID + MICROSOFT_APP_PASSWORD + MICROSOFT_APP_TENANT_ID to enable)',
          );
          continue;
        }
        providerCatalog.add(
          new EntraProvider({
            oauth: oauthClient,
            refreshStore: authRefreshStore,
            whitelist: emailWhitelist,
            uiLocale: 'de',
          }),
        );
      } else {
        console.warn(
          `[auth] AUTH_PROVIDERS contains unknown provider id "${id}" — skipped (no plugin loader yet, V1.x)`,
        );
      }
    }

    const platformSettings = new PlatformSettingsStore(graphPool);
    adminAudit = new AdminAuditLog(graphPool);
    pluginAdminAudit.attach(adminAudit);
    const storedActive = await platformSettings.get<string[]>(
      SETTING_AUTH_ACTIVE_PROVIDERS,
    );
    const activeIds = resolveActiveProviderIds(providerCatalog, storedActive);
    const providerRegistry = new ProviderRegistry();
    providerRegistry.replaceActive(
      activeIds
        .map((id) => providerCatalog.get(id))
        .filter((p): p is NonNullable<typeof p> => !!p),
    );
    console.log(
      `[auth] provider registry ready (${providerRegistry.size()} active: ${providerRegistry
        .summaries()
        .map((p) => p.id)
        .join(', ')}; whitelist: ${providerCatalog.ids().join(', ')})${
        bootstrapResult.setupRequired ? ' — /setup wizard unlocked' : ''
      }`,
    );
    // Surface the active providers to the public pairing descriptor (#293).
    pairingProviders = providerRegistry.summaries();

    // Password sign-in limiter (docs/security-architecture.md §10m): one per
    // process, shared by the login route, the setup wizard's argon2 slot and
    // the admin paths that unlock (reset password / re-enable) or revoke the
    // device cookies (reset, status change, delete).
    const loginGuard = createLoginGuard({
      clientAddress: config.AUTH_LOGIN_CLIENT_ADDRESS,
      maxInFlight: config.AUTH_LOGIN_MAX_INFLIGHT,
      ipv6PrefixBits: config.AUTH_LOGIN_IPV6_PREFIX,
      signingKey: sessionSigningKey,
      accounts: userStore,
      audit: adminAudit,
    });

    app.use(
      '/api/v1/auth',
      createAuthRouter({
        registry: providerRegistry,
        userStore,
        signingKey: sessionSigningKey,
        publicBaseUrl: config.PUBLIC_BASE_URL,
        defaultReturnPath: config.AUTH_DEFAULT_RETURN_PATH,
        setupAllowed: bootstrapResult.setupRequired,
        sessions: sessionRevocation,
        ...(setupToken.token !== undefined ? { setupToken: setupToken.token } : {}),
        loginLimiter: loginGuard,
        // #965 — explicit session renewal ("I'm still here"): re-checks the
        // principal, audits every renewal, bounded by an absolute cap from
        // the original sign-in.
        renewal: {
          whitelist: emailWhitelist,
          audit: adminAudit,
          refreshStore: authRefreshStore,
          maxLifetimeSeconds: config.AUTH_SESSION_MAX_LIFETIME_HOURS * 3600,
        },
        // OB-61 — the /setup ENDPOINT still seeds an operator-supplied
        // `anthropic_api_key` into each consumer plugin's vault and
        // reactivates the plugin so the LLM-bound capabilities go live
        // without a server restart. Kept for back-compat only: the wizard
        // UI stopped sending a key in S4, and the supported path is the
        // LLM access page (#1090).
        vault: secretVault,
        reactivate: reactivateAgent,
        anthropicKeyConsumers: [
          '@omadia/orchestrator',
          '@omadia/orchestrator-extras',
          '@omadia/verifier',
        ],
        // Slice 1b-channel-web — on each login (local + entra), resolve
        // (or create) the KG User-Cluster + ChannelIdentity and cache
        // the omadiaUserId in the session JWT so chat ingest can skip
        // the round-trip. Returns undefined if the users-row was just
        // created in the same request (post-OIDC-upsert + pre-commit
        // window — eventually consistent, next request will pick up).
        resolveChannelIdentity: async (input) => {
          const row = await userStore.findByProviderUserId(
            input.provider,
            input.providerUserId,
          );
          if (!row) return undefined;
          const isEntra = input.provider === ENTRA_PROVIDER_ID;
          // For entra, `providerUserId` IS the AAD object id (see
          // EntraProvider.handleCallback → providerUserId: claims.oid).
          // Setting it as `aadObjectId` makes the resolver merge the
          // Web Admin UI identity with any future Teams ChannelIdentity
          // that lands on the same oid — deterministic cross-channel
          // link without going through the email fallback.
          //
          // emailVerified=true regardless of provider: in this single-
          // tenant deployment `users.email` is either set by an admin
          // (`adminUsersRouter.create()`, gated by `users.role='admin'`)
          // or by an OIDC callback (Entra ships its own verified claim).
          // The `(provider, lower(email))` unique index already prevents
          // intra-provider email reuse, so the resolver's hybrid-email-
          // merge path can safely treat both sides as trusted and keep
          // a local-password login + Entra login on the same cluster.
          //
          // Multi-tenant SaaS deployments should replace this with a
          // per-tenant `localPasswordEmailTrusted` config (default false)
          // and a real verification-mail flow for local-password users.
          const result = await knowledgeGraph.resolveOrCreateChannelIdentity({
            channelKind: 'web',
            channelUserId: row.id,
            displayName: input.displayName,
            ...(input.email ? { email: input.email } : {}),
            emailVerified: true,
            ...(isEntra ? { aadObjectId: input.providerUserId } : {}),
            // #568 — record WHICH IdP subject just authenticated. This is
            // the session JWT's `sub`, and therefore the exact key
            // `/mcp-servers/:id/authorize` stores a `per_user` OAuth token
            // under. Persisting it here is what later lets a Teams or
            // Telegram turn — which knows only the canonical omadia user
            // id — find that token instead of failing closed.
            //
            // Safe to record because THIS call site sits behind a completed
            // login: the subject is authenticated, not asserted by a
            // channel payload.
            authSubject: {
              provider: input.provider,
              providerUserId: input.providerUserId,
            },
          });
          return result.omadiaUserId;
        },
      }),
    );
    console.log('[middleware] admin auth endpoints ready at /api/v1/auth');

    const findWebIdentity = knowledgeGraph.findOmadiaUserIdByChannelIdentity?.bind(knowledgeGraph);
    app.use(
      '/api/v1/admin/users',
      requireAuth,
      createAdminUsersRouter({
        userStore,
        audit: adminAudit,
        sessions: sessionRevocation,
        loginLimiter: loginGuard.limiter,
        loginDevices: loginGuard.devices,
        ...(findWebIdentity
          ? { findOmadiaUserId: (usersId: string) => findWebIdentity('web', usersId) }
          : {}),
      }),
    );
    // #1315 — the read side of the audit trail (admin UI: /admin/audit).
    app.use('/api/v1/admin/audit', requireAuth, createAdminAuditRouter({ audit: adminAudit }));
    app.use(
      '/api/v1/admin/auth',
      requireAuth,
      createAdminAuthRouter({
        registry: providerRegistry,
        catalog: providerCatalog,
        settings: platformSettings,
        audit: adminAudit,
      }),
    );
    console.log(
      '[middleware] admin user-management, audit-trail + auth-toggle endpoints ready at /api/v1/admin/users, /api/v1/admin/audit and /api/v1/admin/auth (auth: required)',
    );
  } else {
    console.warn(
      '[auth] graphPool unavailable — local-password auth disabled, /api/v1/auth/* returns 503',
    );
    // No users table → nothing to check a session against. Nothing can mint
    // one here either (the auth router answers 503), so only a cookie minted
    // by an earlier Postgres-backed boot could still arrive.
    console.warn(
      '[auth] server-side session revocation inactive without graphPool — sessions are verified by signature and expiry only',
    );
    app.use('/api/v1/auth', (_req, res) => {
      res.status(503).json({
        code: 'auth.not_configured',
        message:
          'no graph pool — neither Postgres-backed local auth nor Entra is wired',
      });
    });
  }

  // ── Plugin registries (the "store sources") ───────────────────────────────
  // Admin-managed, persistent: the non-secret list lives in platform_settings
  // (Postgres) when a graphPool is present, else an in-memory KV (DB-less boot
  // re-seeds the default each start). Bearer tokens live in the encrypted
  // vault. Seeded on first boot only (#1483) from REGISTRY_URLS ('[]' = none),
  // else the public default hub.omadia.ai. The live RegistryClient is reloaded from the store here and
  // again after every admin mutation, so changes apply without a restart.
  const registrySettings: RegistrySettingsKV = graphPool
    ? new PlatformSettingsStore(graphPool)
    : new InMemoryRegistrySettings();
  const registryConfigStore = new VaultBackedRegistryConfigStore({
    settings: registrySettings,
    vault: secretVault,
  });
  await seedRegistriesOnFirstBoot(
    registryConfigStore,
    registrySeedFromEnv(config.REGISTRY_URLS),
    (m) => console.log(m),
  );
  const registryClient = new RegistryClient({
    registries: await registryConfigStore.list(),
    timeoutMs: config.REGISTRY_FETCH_TIMEOUT_MS,
    log: (m) => console.log(m),
  });
  app.use(
    '/api/v1/admin/registries',
    requireAuth,
    createAdminRegistriesRouter({
      store: registryConfigStore,
      client: registryClient,
      // #1487 — registry changes belong in the admin audit trail.
      ...(adminAudit ? { audit: adminAudit } : {}),
      log: (m) => console.log(m),
    }),
  );
  console.log(
    `[middleware] registry admin endpoints ready at /api/v1/admin/registries (auth: required, sources: ${
      registryClient.registryNames().join(', ') || 'none'
    })`,
  );

  app.use(
    '/api/v1/store/plugins',
    requireAuth,
    createStoreRouter({
      catalog: pluginCatalog,
      registry: installedRegistry,
      client: registryClient,
      // #1490 — flags uploaded-but-not-installed packages as removable.
      // #1459 — and gives package provenance: only a hub download carries the
      // hub `source` tag, never an operator upload of the same id.
      uploadedPackages: uploadedPackageStore,
      pluginStatusRegistry,
      // OM-16 — key-name-only vault access so the store can report whether an
      // installed plugin is actually configured (never reads secret VALUES).
      vault: secretVault,
      // Issue #453 — read-only code-scan verdict on the detail response
      // plus the operator ack endpoint. Lookup only, never scans on GET.
      verdicts: pluginVerdictLookup,
      // #884 — the Hub's "X of Y ready" count called every plugin ready while
      // the LLM provider it routes through had no verified credential. This is
      // the probe that lets readiness see that dependency. Reuses the vault and
      // catalog already constructed above; a second instance of either would
      // read a different view of the same state.
      llmReadiness: {
        resolve: (pluginId, config) =>
          resolvePluginLlmReadiness(pluginId, config, {
            vault: secretVault,
            llmProviderCatalog,
          }),
      },
    }),
  );
  console.log('[middleware] plugin store endpoints ready at /api/v1/store/plugins (auth: required)');

  // Spec 005 — kernel OAuth broker. Drives standard authorization-code flows
  // for plugins that declare an `oauth_providers` descriptor + a `type:oauth`
  // field. Mounted on the install router; `/oauth/callback` is public (see
  // publicPaths) and self-secures via signed state.
  const oauthBroker = new OAuthBrokerService({
    catalog: pluginCatalog,
    registry: installedRegistry,
    vault: secretVault,
    pendingFlows: new PendingFlowStore(),
    signingKey: sessionSigningKey,
    publicBaseUrl: flowPublicBaseUrl,
    // Re-resolve the plugin's connection state (derived config + ctx.status)
    // immediately after a successful connect — same deactivate→activate the
    // install flow uses, so the status badge clears without a restart.
    // `reactivate` now reports the resulting status (#470 C16) — the broker has
    // no use for it and its own contract is `Promise<void>`, so it is dropped
    // explicitly here rather than by widening the broker's type.
    reactivatePlugin: async (pluginId) => {
      await installService.reactivate(pluginId);
    },
  });

  app.use(
    '/api/v1/install',
    requireAuth,
    createInstallRouter({
      service: installService,
      oauthBroker,
      // #1347 — install/uninstall rows; the uninstall row lists the grants
      // that leave with the plugin.
      ...(adminAudit ? { audit: adminAudit } : {}),
      grantsOf: (pluginId) =>
        readGrantSnapshot({ publicPathGrantStore, sqlGrantStore }, pluginId),
      // #1463 — a capability the local catalog cannot provide may be provided
      // by the Hub's newer version of an installed parent.
      // Only offered where the wizard can act on it: Hub installs go through
      // /api/v1/install/registry, which needs the package-upload subsystem.
      ...(registryClient.hasRegistries() && config.PACKAGE_UPLOAD_ENABLED
        ? {
            enrichMissingCapability: (chain: InstallChainResolution) =>
              addRegistryCapabilityProviders(chain, {
                listRegistryPlugins: async () =>
                  (await registryClient.listAll()).plugins.map((p) => p.entry),
                registry: installedRegistry,
                log: (m) => console.warn(m),
              }),
          }
        : {}),
    }),
  );
  console.log('[middleware] plugin install endpoints ready at /api/v1/install (auth: required)');
  console.log('[middleware] OAuth broker ready at /api/v1/install/oauth/{start,callback}');

  // Phase 2.1.5 — live profile storage (agent.md + knowledge bytes). Mounted
  // only when graphPool exists; tests/in-memory boot fall back to the
  // bootstrap-profile endpoints without the storage routes.
  const liveProfileStorage = graphPool
    ? new LiveProfileStorageService({
        pool: graphPool,
        log: (m) => console.log(m),
      })
    : undefined;

  // Phase 2.2 snapshot service + profile-router mount happen further
  // down — they need the DraftStore (Phase 2.2.5 builder-aware
  // profileLoader) which is created later in the boot sequence.

  // Operator-grade routines endpoint. Mounted iff initRoutines actually
  // ran (graphPool was available). v1 surface: list / pause / resume /
  // delete — chat-create flow lives behind the inbound channel adapter.
  if (routinesHandle) {
    app.use(
      '/api/v1/routines',
      requireAuth,
      createRoutinesRouter({
        store: routinesHandle.store,
        runsStore: routinesHandle.runsStore,
        runner: routinesHandle.runner,
        ...(adminAudit ? { audit: adminAudit } : {}),
        log: (msg) => console.log(msg),
      }),
    );
    console.log(
      '[middleware] routines endpoints ready at /api/v1/routines (auth: required)',
    );
  }

  // Per-user UI preferences (issue #287) — server-side home for the Lume
  // palette + appearance choice, backed by the MemoryStore. Replaces the
  // per-browser localStorage from #284 with a cross-device store.
  app.use(
    '/api/v1/ui-prefs',
    requireAuth,
    createUiPrefsRouter({ store: memoryStore, log: (m) => console.log(m) }),
  );
  console.log(
    '[middleware] ui-prefs endpoints ready at /api/v1/ui-prefs (auth: required)',
  );

  // `packageUploadService` is declared in the outer `main` scope so the
  // builder install endpoint (B.6-1) can reference it. When PACKAGE_UPLOAD_-
  // ENABLED is false the variable stays null and the install route is omitted
  // from the builder router (BuilderRouterDeps['install'] is optional).
  let packageUploadService: PackageUploadService | null = null;
  if (config.PACKAGE_UPLOAD_ENABLED) {
    const middlewarePkg = await import('../package.json', {
      with: { type: 'json' },
    }).then((m) => m.default as { dependencies?: Record<string, string> });
    // Merge workspace packages into hostDependencies so the upload-side
    // peer-dep validation knows the core @omadia/* packages (channel-sdk,
    // plugin-api, orchestrator, diagrams, embeddings, memory, verifier,
    // knowledge-graph-{inmemory,neon}, orchestrator-extras, …) are baked
    // into the image and resolve via /app/node_modules at runtime.
    // Without this, every ZIP upload that peer-depends on a kernel package
    // raises a false-positive "missing peer-dep" warning.
    const workspaceDependencies: Record<string, string> = {};
    try {
      const packagesDir = fileURLToPath(new URL('../packages', import.meta.url));
      const fsMod = await import('node:fs/promises');
      const pathMod = await import('node:path');
      const entries = await fsMod.readdir(packagesDir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        try {
          const pkgPath = pathMod.join(packagesDir, e.name, 'package.json');
          const raw = await fsMod.readFile(pkgPath, 'utf8');
          const parsed = JSON.parse(raw) as { name?: string; version?: string };
          if (parsed.name) {
            workspaceDependencies[parsed.name] = parsed.version ?? '*';
          }
        } catch {
          // Skip packages without a readable package.json (boilerplate
          // stubs, build artefacts). Failure here must not block boot.
        }
      }
    } catch {
      // packages/ may not exist in some configurations — degrade
      // gracefully, only the explicit dependencies field is used.
    }
    const hostDependencies: Record<string, string> = {
      ...(middlewarePkg.dependencies ?? {}),
      ...workspaceDependencies,
    };
    const migrationRunner = new MigrationRunner({
      vault: secretVault,
      registry: installedRegistry,
      catalog: pluginCatalog,
      serviceRegistry,
      nativeToolRegistry,
      pluginRouteRegistry,
      notificationRouter,
      uiRouteCatalog,
      jobScheduler,
      log: (msg) => console.log(msg),
    });
    packageUploadService = new PackageUploadService({
      store: uploadedPackageStore,
      catalog: pluginCatalog,
      packagesDir: uploadedPackagesDir,
      limits: {
        maxBytes: config.PACKAGE_UPLOAD_MAX_BYTES,
        maxExtractedBytes: config.PACKAGE_UPLOAD_MAX_EXTRACTED_BYTES,
        maxEntries: config.PACKAGE_UPLOAD_MAX_ENTRIES,
      },
      hostDependencies,
      registry: installedRegistry,
      migrationRunner,
      // Issue #453 — advisory SkillSpector scan, fire-and-forget after a
      // successful ingest. Absent without a Postgres graph backend.
      scanScheduler: pluginScanScheduler,
      // #1462 — an updated integration publishes new service objects; its
      // `depends_on` agents must re-resolve them instead of serving through
      // the previous version's client.
      onDependentsStale: (agentId) => installService.reactivateDependents(agentId),
      // After a re-upload onto an already installed agent (registry entry
      // still alive, package was deleted + re-uploaded) we activate the
      // runtime directly — otherwise the tool stays unknown until the user
      // un-/re-installs once. For a version upgrade with onMigrate this
      // re-activation runs with the already migrated config.
      //
      // Dispatch by `manifest.identity.kind` — symmetric to
      // InstallService.onInstalled.
      // #1452 — whether this hook runs at all is decided by the upload
      // service (`shouldReactivate`), not here. The gate used to sit on this
      // line as `status !== 'active'`, and it has to move because the service
      // now RECORDS the outcome: a plugin left `errored` by a failed update
      // must be reactivated by the next (fixed) version, and a second gate
      // here would turn the service's success write into a lie for every
      // entry this hook silently declined to touch.
      onPackageReady: async (agentId) => {
        const kind = pluginCatalog.get(agentId)?.plugin.kind;
        switch (pluginRuntimeOf(kind)) {
          case 'channel': {
            if (!channelRegistryRef) {
              // #1452 — a throw, not a warn-and-return. The caller records
              // this hook's verdict, so "returned normally" has to mean "the
              // plugin is running"; an early return here would be filed as a
              // successful activation. Reachable only for an ingest that
              // arrives before `channelRegistryRef` is assigned (boot is not
              // serving requests yet), and the next boot activates the
              // channel regardless of the `errored` this records.
              throw new Error(
                `channel '${agentId}' was re-uploaded before channelRegistry was wired — hot-swap skipped, will pick up at next boot`,
              );
            }
            // Unconditional, not `if (isActive)`: `deactivate` invalidates the
            // resolver's agentId-keyed module cache, and that cache can hold
            // the PRE-UPDATE `dist/plugin.js` for a channel that is currently
            // down (no handle → `isActive` false). Skipping the call there let
            // `activate()` re-activate the old module and, now that the caller
            // records the verdict, file it as a fresh success. `deactivate`
            // returns early for a channel without a handle, so this is cheap.
            await channelRegistryRef.deactivate(agentId);
            await channelRegistryRef.activate(agentId);
            // `channelRegistry.activate()` warns and returns when the resolver
            // yields no usable `ChannelPlugin` — a broken export in the new
            // package, which ingest does not check (it verifies the entry file
            // exists, not what it exports). "Returned normally" has to mean
            // "running", or the caller stamps `last_activated_at` and lifts a
            // genuine `errored` over a channel serving nothing.
            if (!channelRegistryRef.isActive(agentId)) {
              throw new Error(
                `channel '${agentId}' did not come up after activation — the package exports no usable ChannelPlugin`,
              );
            }
            return;
          }
          case 'tool': {
            if (toolPluginRuntime.isActive(agentId)) {
              await toolPluginRuntime.deactivate(agentId);
            }
            // #2088 — an update may be the version that turns the plugin into
            // an archetype plugin, or one that changes its descriptor. Same
            // order as a first install: the registry first, whatever the
            // activation's outcome. (Kind `archetype` used to fall through to
            // the agent runtime here: the old version kept running and the new
            // one failed on its duplicate services.)
            if (kind === 'archetype') await archetypeRegistry.sync();
            await toolPluginRuntime.activate(agentId);
            return;
          }
          case 'none':
            // Spec 2042 §5.10 — never reached by an upload (ingest refuses the
            // retired kind `agent`); a throw, so the caller records
            // `kind_retired` instead of a successful activation.
            throw noRuntimeError(agentId, kind);
        }
      },
      log: (msg) => console.log(msg),
    });
    app.use(
      '/api/v1/install/packages',
      requireAuth,
      createPackagesRouter({
        service: packageUploadService,
        store: uploadedPackageStore,
        registry: installedRegistry,
        catalog: pluginCatalog,
        maxBytes: config.PACKAGE_UPLOAD_MAX_BYTES,
        log: (msg) => console.log(msg),
        ...(adminAudit ? { audit: adminAudit } : {}),
      }),
    );
    console.log(
      `[middleware] package upload endpoints ready at /api/v1/install/packages (maxBytes=${config.PACKAGE_UPLOAD_MAX_BYTES}, auth: required)`,
    );

    // Remote-install: fetch a ZIP from a configured registry and feed it into
    // the same ingest pipeline. Gated by PACKAGE_UPLOAD_ENABLED because it
    // reuses packageUploadService.
    app.use(
      '/api/v1/install/registry',
      requireAuth,
      createRegistryInstallRouter({
        client: registryClient,
        packageUpload: packageUploadService,
        catalog: pluginCatalog,
        registry: installedRegistry,
        store: uploadedPackageStore,
        log: (msg) => console.log(msg),
      }),
    );
    console.log(
      '[middleware] registry install endpoint ready at /api/v1/install/registry (auth: required)',
    );
  } else {
    console.log('[middleware] package upload DISABLED (PACKAGE_UPLOAD_ENABLED=false)');
  }

  app.use(
    '/api/v1/admin/vault-status',
    requireAuth,
    createVaultStatusRouter({
      vault: secretVault,
      registry: installedRegistry,
      vaultPath: VAULT_PATH,
      dataDir: DATA_DIR,
      masterKeySource: masterKey.source,
      keychainKeySource: credentialMasterKey.source,
      backup: vaultBackupService,
      ...(vaultBackupDisabledReason
        ? { backupDisabledReason: vaultBackupDisabledReason }
        : {}),
    }),
  );
  console.log('[middleware] vault-status endpoint ready at /api/v1/admin/vault-status (auth: required)');

  // #1556 follow-up — field classification for the privacy guard's
  // `non_personal_fields`: candidates from the guard's field observations,
  // classified (Odoo schema + detector verdicts + schema-only model verdict)
  // and shown to admins, who confirm every entry. Recompute runs on plugin
  // (de)activation, every 6 h and on POST /recompute — never per chat turn —
  // and writes config only through the auto-approval step (privacy guard
  // setting `auto_approve_non_personal`, default on; migration 0066): the
  // narrow set of fields `autoApprove.ts` defines, audited per field as
  // `system:auto-classifier`. Postgres-only (migrations 0065/0066).
  const fieldClassificationStore = graphPool
    ? new PgFieldClassificationStore(graphPool)
    : undefined;
  if (fieldClassificationStore) {
    // ONE writer of `non_personal_fields` for the routes and the recompute,
    // so their read-modify-writes share the plugin lock.
    const nonPersonalFieldsEditor = createNonPersonalFieldsEditor({
      installedRegistry,
      catalog: pluginCatalog,
    });
    // Spec 2042 §5.10 — every pass (boot, plugin lifecycle, the 6 h
    // interval, the recompute route) is one operator job of the classifier,
    // so its model calls run in a context with a budget and a deadline.
    const fieldClassificationScheduler = createFieldClassificationScheduler({
      run: () =>
        modelWork.run(FIELD_CLASSIFICATION, 'system:auto-classifier', () => recomputeFieldClassification({
          store: fieldClassificationStore,
          serviceRegistry,
          readNonPersonalFields: () =>
            readNonPersonalFieldsConfig(installedRegistry, pluginCatalog),
          autoApprove: {
            editor: nonPersonalFieldsEditor,
            ...(adminAudit ? { audit: adminAudit } : {}),
          },
          log: (msg) => console.log(msg),
        })),
      log: (msg) => console.warn(msg),
    });
    fieldClassificationTriggerRef = (reason) => fieldClassificationScheduler.trigger(reason);
    fieldClassificationScheduler.start();
    fieldClassificationScheduler.trigger('boot');
    app.use(
      '/api/v1/admin/privacy/field-classification',
      requireAuth,
      createFieldClassificationRoutes({
        store: fieldClassificationStore,
        installedRegistry,
        catalog: pluginCatalog,
        serviceRegistry,
        ...(adminAudit ? { audit: adminAudit } : {}),
        recompute: () => fieldClassificationScheduler.runNow(),
        editor: nonPersonalFieldsEditor,
      }),
    );
    console.log(
      '[middleware] privacy field classification wired at /api/v1/admin/privacy/field-classification (auth-gated)',
    );
  }

  app.use(
    '/api/v1/admin/runtime',
    requireAuth,
    createRuntimeRouter({
      installedRegistry,
      serviceRegistry,
      turnHookRegistry,
      backgroundJobRegistry,
      chatAgentWrapRegistry,
      promptContributionRegistry,
      vault: secretVault,
      catalog: pluginCatalog,
      hasPackage: (id) => hasPackage(id, [uploadedPackageStore, builtInPackageStore]),
      reactivate: reactivateAgent,
      onGrantsChanged: () => attachFacilitationEngine(),
      restartPending: (agentId) => installService.restartPending(agentId),
      // Spec 2042 §5.10 — setup options come from the tool the plugin
      // registered with the kernel.
      setupOptions: createSetupOptionsResolver({ tools: nativeToolRegistry }),
      // #1453 — the operator-facing half of the credential check: `GET
      // /installed` reports what a plugin pushed through `ctx.status`, and
      // `POST /installed/:id/verify` re-runs that plugin's own probe.
      pluginStatusRegistry,
      // `undefined` means "this plugin declares no connection check", which
      // the route reports as such rather than as health.
      verifyConnection: async (agentId: string) => toolPluginRuntime.verifyConnectionNow(agentId),
      // Epic #470 C4 / H1 — operator consent for unauthenticated plugin path
      // prefixes. Behind requireAuth like every other runtime endpoint.
      publicPathGrantStore,
      publicPathGrants,
      // Epic #470 C16 (#817) — the half C7 shipped a gate for but no answer to.
      sqlGrantStore,
      // #1347 — who opened or closed which path lands in admin_audit.
      ...(adminAudit ? { audit: adminAudit } : {}),
      // #1556 follow-up — the posture banner's open field count.
      ...(fieldClassificationStore
        ? {
            countOpenFieldClassification: (visitor) => fieldClassificationStore.countOpen(visitor),
          }
        : {}),
    }),
  );
  console.log('[middleware] runtime introspection endpoint ready at /api/v1/admin/runtime (auth: required)');
  console.log('[middleware] plugin grant consent ready at /api/v1/admin/runtime/installed/:id/grants (auth: required)');

  // Operator settings overview — every .env-based value bootstrap writes into
  // the config-store / vault, editable with live re-activation. Reuses the
  // same installedRegistry + vault + reactivate plumbing as the runtime route.
  app.use(
    '/api/v1/admin/settings',
    requireAuth,
    createAdminSettingsRouter({
      installedRegistry,
      vault: secretVault,
      reactivate: reactivateAgent,
      llmProviderCatalog,
    }),
  );
  console.log('[middleware] settings overview endpoint ready at /api/v1/admin/settings (auth: required)');

  // Dedicated models/providers admin (S6) — providers + registry models +
  // per-plugin provider/model selection. Separate from the settings catalog so
  // many providers/models can be managed on their own page.
  app.use(
    '/api/v1/admin/providers',
    requireAuth,
    createAdminProvidersRouter({
      ...(adminAudit ? { audit: adminAudit } : {}),
      installedRegistry,
      vault: secretVault,
      reactivate: reactivateAgent,
      llmProviderCatalog,
      // #1033 W3 — the fallback breaker's state, so the page can show a
      // provider that is currently being skipped in favour of its fallback.
      providerHealth: kernelProviderPool.health,
      modelCatalogSync,
    }),
  );
  console.log('[middleware] providers admin endpoint ready at /api/v1/admin/providers (auth: required)');

  // #294 — bind the process-wide OAuth token store for the ChatGPT provider to
  // the vault: `load` reads every LLM-plugin scope newest-wins (rotation makes
  // divergent copies dangerous), `persist` fans a refreshed/rotated token back
  // out to all scopes with one shared stamp. Only wired when the experimental
  // provider is on; harmless otherwise (no provider resolves the bearer).
  if (config.CHATGPT_SUBSCRIPTION_EXPERIMENTAL) {
    const oauthVault = secretVault;
    const OAUTH_PROVIDER = 'openai-chatgpt';
    const LLM_SCOPES = [
      '@omadia/orchestrator',
      '@omadia/verifier',
      '@omadia/orchestrator-extras',
    ] as const;
    registerProviderOAuthStoreBinding(OAUTH_PROVIDER, {
      load: async () => {
        const copies: Array<{ tokens: OAuthTokens; updatedAt: number }> = [];
        for (const scope of LLM_SCOPES) {
          const tokens = await readProviderOAuthTokens(
            (k) => oauthVault.get(scope, k),
            OAUTH_PROVIDER,
          );
          if (tokens !== undefined) {
            const updatedAt = await readProviderOAuthUpdatedAt(
              (k) => oauthVault.get(scope, k),
              OAUTH_PROVIDER,
            );
            copies.push({ tokens, updatedAt });
          }
        }
        return copies;
      },
      persist: async (tokens, updatedAtMs) => {
        for (const scope of LLM_SCOPES) {
          await writeProviderOAuthTokens(
            (k, v) => oauthVault.setMany(scope, { [k]: v }),
            OAUTH_PROVIDER,
            tokens,
            updatedAtMs,
          );
        }
      },
    });
    console.log('[middleware] ChatGPT-subscription OAuth token store bound (experimental)');
  }

  // Embedding-provider switch (#440 follow-up) — pick which `embeddingClient@1`
  // adapter is active, LIVE. Unlike the memory-backend router next door this
  // one does not persist-and-ask-for-a-restart: it deactivates the outgoing
  // provider, activates the target, and asks the knowledge-graph's gate to
  // re-evaluate ITSELF against the new provider (rewriting the vector columns
  // when the width changed and the operator confirmed the discard), inside this
  // process.
  //
  // It deliberately does NOT get `reactivate`. Re-activating the knowledge
  // graph runs its `close()`, which ends `graphPool` — the pool captured once
  // right here and shared with ~40 subsystems below. Handing the router that
  // capability is what made every successful switch poison them all with
  // "Cannot use a pool after calling end on the pool".
  app.use(
    '/api/v1/admin/embedding-provider',
    requireAuth,
    createAdminEmbeddingProviderRouter({
      installedRegistry,
      catalog: pluginCatalog,
      getEmbeddingClient: () =>
        serviceRegistry.get<EmbeddingClient>('embeddingClient'),
      // OM-84 follow-up — the keyless adapter publishes this even while its
      // weights are missing, which is the only moment it is useful. Resolved
      // per request: it appears the moment that adapter activates and vanishes
      // when it is swapped out, and a captured copy would outlive both.
      getLocalModelFetcher: () =>
        serviceRegistry.get<LocalEmbeddingModelFetcher>(
          'localEmbeddingModelFetcher',
        ),
      // Resolved per request, never captured: `vectorWritesAllowed` flips
      // false→true in-process when a stale-vector clear drains, and the whole
      // point of the page is that the operator sees that without a reload.
      getGateStatus: () =>
        serviceRegistry.get<EmbeddingGateStatus>(EMBEDDING_GATE_STATUS_SERVICE),
      getGraphPool: () => graphPool,
      // OM-102 — resolved per request for the same reason as the gate above:
      // the extras plugin can be (de)activated without a restart, and the
      // dashboard card must not render a captured state.
      getMemoryFeatureStatus: () =>
        serviceRegistry.get<MemoryFeatureStatusView>('memoryFeatureStatus'),
      // Env-derived fallback. The router prefers the KG plugin's own
      // `graph_tenant_id` setup field when one is set.
      tenantId: graphTenantId,
      activate: (id) => toolPluginRuntime.activate(id),
      deactivate: (id) => toolPluginRuntime.deactivate(id),
    }),
  );
  console.log(
    '[middleware] embedding-provider switch ready at /api/v1/admin/embedding-provider (auth: required)',
  );

  // #584 WS T — operator surface for the `transcription@1` capability: list
  // installed providers, show the live one, switch with verified rollback.
  // The lean sibling of the embedding-provider router above — a transcription
  // switch destroys no corpus, so there is no confirm/discard step and no
  // gate re-evaluation. This page doubles as the consent surface: an active
  // provider means raw audio leaves the deployment for the configured
  // external endpoint.
  app.use(
    '/api/v1/admin/transcription-provider',
    requireAuth,
    createAdminTranscriptionProviderRouter({
      installedRegistry,
      catalog: pluginCatalog,
      getTranscription: () =>
        serviceRegistry.get<TranscriptionService>(TRANSCRIPTION_SERVICE_NAME),
      activate: (id) => toolPluginRuntime.activate(id),
      deactivate: (id) => toolPluginRuntime.deactivate(id),
    }),
  );
  console.log(
    '[middleware] transcription-provider switch ready at /api/v1/admin/transcription-provider (auth: required)',
  );

  // Subscription-CLI backends (#309) — detect installed/logged-in vendor CLIs
  // (Claude/Codex/Gemini) so the operator can run agents on a subscription.
  // Read-only host-capability probe; never triggers a login or consumes quota.
  // A CLI signed in outside omadia never passes the login hook below, so the
  // same hand-off also runs after the boot and on the operator's "re-check".
  const handOffCliLogin = (): Promise<unknown> =>
    handOffExistingCliLogin({
      installedRegistry,
      vault: secretVault,
      reactivate: reactivateAgent,
      llmProviderCatalog,
      log: (msg) => console.log(msg),
    });
  app.use(
    '/api/v1/admin/cli-backends',
    requireAuth,
    createAdminCliBackendsRouter({ onRecheck: handOffCliLogin }),
  );
  console.log('[middleware] CLI backends endpoint ready at /api/v1/admin/cli-backends (auth: required)');
  // OM-100b — the runtime half of the Systemstatus panel: whether the last
  // chat turn actually came back. Process-scoped and read-only.
  app.use('/api/v1/admin/last-turn', requireAuth, createAdminLastTurnRouter());
  // OM-79 (#994) — the hand-off the subscription path was missing. A successful
  // in-app login used to end with "signed in" while the orchestrator kept
  // asking the vault for an Anthropic key and never published chatAgent@1.
  // Point every credential-less LLM plugin at the CLI provider right here, so
  // the login IS the setup; the assignment section stays for overrides.
  setCliLoginAuthorizedHook(async () => {
    await autoAssignSubscriptionCli({
      installedRegistry,
      vault: secretVault,
      reactivate: reactivateAgent,
      llmProviderCatalog,
      log: (msg) => console.log(msg),
    });
  });

  // ── Agent-Builder drafts (B.0) ────────────────────────────────────────────
  // SQLite-backed draft store; persists alongside the vault so redeploys
  // preserve every user's in-flight agent drafts. Preview-runtime infra
  // (B.3) lands further down — same DraftStore feeds both surfaces.
  //
  // OB-83 — when liveProfileStorage is wired (i.e. DB-backed mode), the
  // store gets an `onUpdated` hook that mirrors every spec/name save into
  // `profile_agent_md`. That keeps Phase-2.2 snapshots populated without
  // touching every internal write site (BuilderAgent, PreviewChatService,
  // AutoFix, etc.). Hook failures are caught + logged inside DraftStore;
  // primary state stays in SQLite even when the mirror fails.
  const draftMirrorHook = buildDraftStorageMirrorHook({
    ...(liveProfileStorage ? { liveProfileStorage } : {}),
    log: (m) => console.log(m),
  });
  const draftStore = new DraftStore({
    dbPath: DRAFTS_DB_PATH,
    ...(draftMirrorHook ? { onUpdated: draftMirrorHook } : {}),
  });
  await draftStore.open();
  const draftQuota = new DraftQuota({ store: draftStore });

  // Phase 2.2 SnapshotService + /api/v1/profiles router mount happens
  // further down — after BuildPipeline is created so the builder-aware
  // profileLoader can call it for installable plugin-ZIP capture.

  // ── Agent-Builder preview-runtime infrastructure (B.3) ────────────────────
  // PreviewRuntime keeps ephemeral per-draft package extracts under
  // `data/builder/.previews/<agentSlug>-<rev>/`. Boot-time orphan cleanup
  // wipes leftovers from a prior process. A per-user LRU cache (cap=3) sits
  // on top so switching between recent drafts is sub-100ms; cold drafts
  // trigger a fresh build through the BuildPipeline → BuildQueue path.
  const previewRuntime = new PreviewRuntime({
    previewsRoot: BUILDER_PREVIEWS_DIR,
    egressRoots: previewEgressRoots,
    templateNodeModulesPath: path.join(BUILDER_BUILD_TEMPLATE_DIR, 'node_modules'),
    // Solution B: read through to the live kernel ServiceRegistry so an
    // integration-backed agent under test resolves the real services its
    // depends_on integrations provide (e.g. odoo.client) — preview goes green
    // and the agent is testable before install, no middleware restart.
    serviceRegistry,
    logger: () => {},
  });
  const orphanResult = await previewRuntime
    .cleanupOrphans()
    .catch((err: unknown) => {
      console.warn(
        '[builder] preview orphan cleanup failed (non-fatal):',
        err,
      );
      return { removed: 0 };
    });
  // Spec 2042 §5.10 — a preview turn is a turn of a draft agent (`agents`
  // row, status `draft`), removed when its preview closes. No preview
  // survives a restart, so the boot removes what a crash left behind.
  const previewDraftAgents = new PreviewDraftAgents(
    () => serviceRegistry.get<MultiOrchestratorConfigStore>('configStore'),
    (msg) => console.log(msg),
  );
  try {
    await previewDraftAgents.sweep();
  } catch (err) {
    console.error(
      '[preview-draft-agent] boot sweep FAILED; stale preview drafts stay until their preview closes:',
      err instanceof Error ? err.message : String(err),
    );
  }
  const previewCache = new PreviewCache({
    activate: previewRuntime.activate.bind(previewRuntime),
    warmSlots: 3,
    logger: () => {},
    onClosed: (_userEmail, draftId) => previewDraftAgents.remove(draftId),
  });
  // Vault-backed: test-credentials survive a middleware restart. The vault
  // is libsodium-sealed on disk under /data/secrets so values stay
  // encrypted at rest. Production plugins keep using their own per-agent
  // namespace via the RequiresWizard flow — this buffer is workspace-only.
  const previewSecretBuffer = new PreviewSecretBuffer({ vault: secretVault });

  // BuildQueue + BuildPipeline are shared by preview rebuilds (B.3) and
  // future install-commits (B.5).
  const builderBuildQueue = new BuildQueue({
    concurrency: 3,
    onStateChange: (draftId, phase) => {
      if (phase === 'failed' || phase === 'aborted') {
        console.log(`[builder] build phase=${phase} draft=${draftId}`);
      }
    },
  });
  // `templateReady` stays unset for now: the boilerplate's npmDeps +
  // B.4-5: wire ensureBuildTemplate at boot so the first preview build
  // doesn't die on "node_modules missing". The promise is awaited inside
  // BuildPipeline.run() before staging, NOT here at boot — let the rest
  // of the boot proceed in parallel with the npm install.
  const buildTemplateConfig = await loadBuildTemplateConfig();
  const templateReady: Promise<void> = ensureBuildTemplate({
    templateRoot: BUILDER_BUILD_TEMPLATE_DIR,
    npmDeps: buildTemplateConfig.npmDeps,
    workspaceDeps: buildTemplateConfig.workspaceDeps,
  })
    .then(async (result) => {
      if (!result.ready) {
        throw new Error(
          `[builder] build template not ready: ${result.reason ?? 'unknown reason'}`,
        );
      }
      console.log(
        `[builder] build template ready (reused=${String(result.reused)}, took ${String(result.durationMs)}ms, npmDeps=${String(Object.keys(buildTemplateConfig.npmDeps).length)}, workspaceDeps=${String(Object.keys(buildTemplateConfig.workspaceDeps).length)})`,
      );
      // Service-type auto-discovery — boot reconciliation. The activation
      // hook (toolPluginRuntime.onActivated) ran during
      // `activateAllInstalled()` ABOVE, before this template existed, so its
      // per-package link was a no-op. Now that node_modules is provisioned,
      // link every active integration's service-type packages by their REAL
      // on-disk path (path.dirname(source_path)) — this covers uploaded /
      // hot-installed integrations and name↔folder drift that
      // `loadBuildTemplateConfig`'s workspace-folder heuristic can't resolve.
      // Post-boot hot-installs are handled live by the activation hook
      // itself (template exists by then). Idempotent; failures are logged,
      // not fatal — a build that needs a missing link fails loudly at tsc.
      for (const entry of pluginCatalog.list()) {
        const serviceTypes = entry.plugin.service_types ?? [];
        if (serviceTypes.length === 0) continue;
        if (!toolPluginRuntime.isActive(entry.plugin.id)) continue;
        const packageRoot = path.dirname(entry.source_path);
        const uniqueFroms = new Set(serviceTypes.map((st) => st.type.from));
        for (const from of uniqueFroms) {
          try {
            await linkWorkspacePackageIntoTemplate(
              BUILDER_BUILD_TEMPLATE_DIR,
              from,
              packageRoot,
              { requireTemplate: true },
            );
          } catch (err) {
            console.error(
              `[builder] boot-reconcile: failed to link '${from}' (${entry.plugin.id}): ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
    })
    .catch((err: unknown) => {
      // Re-raise lazily — BuildPipeline.run awaits templateReady and any
      // build that needs it will surface this error then.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[builder] build template setup failed: ${message}`);
      throw err;
    });
  // Mark the same boot-time promise as observed so Node does not emit a
  // spurious unhandledRejection before BuildPipeline.run() awaits it later.
  void templateReady.catch(() => {});

  const builderBuildPipeline = new BuildPipeline({
    draftStore,
    buildQueue: builderBuildQueue,
    templateRoot: BUILDER_BUILD_TEMPLATE_DIR,
    stagingBaseDir: BUILDER_STAGING_DIR,
    templateReady,
    logger: (...args: unknown[]) => {
      console.log('[builder]', ...args);
    },
  });

  // Phase 2.2 SnapshotService + /api/v1/profiles router mount.
  //
  // Deferred to here (after BuildPipeline) because the builder-aware
  // profileLoader runs the BuildPipeline at snapshot-create time so the
  // captured bundle contains a fully installable plugin ZIP, not just
  // the spec source. Without that the operator's "Download" produces a
  // bundle that can't be re-installed elsewhere — defeats the
  // "snapshot = portable plugin" UX.
  const snapshotService =
    graphPool && liveProfileStorage
      ? new SnapshotService({
          pool: graphPool,
          zipperDeps: { store: uploadedPackageStore },
          profileLoader: makeBuilderAwareProfileLoader({
            liveProfileStorage,
            draftStore,
            installedRegistry,
            buildPipeline: builderBuildPipeline,
          }),
          log: (m) => console.log(m),
        })
      : undefined;

  // Phase 2.3 — drift-detector cron-job (OB-65). Daily 03:00 UTC sweep
  // over every profile with a deploy-ready snapshot, persists a 0-1
  // drift-score into `profile_health_score`. Same `runDriftSweep` is
  // exposed to the admin route for on-demand triggering — no public
  // `runNow` on JobScheduler needed.
  if (graphPool && snapshotService) {
    const driftPool = graphPool;
    const driftService = snapshotService;
    jobScheduler.register(
      DRIFT_DETECTOR_AGENT_ID,
      {
        name: DRIFT_DETECTOR_JOB_NAME,
        schedule: { cron: DRIFT_DETECTOR_CRON },
        timeoutMs: DRIFT_DETECTOR_TIMEOUT_MS,
        overlap: 'skip',
      },
      async () => {
        await runDriftSweep({
          pool: driftPool,
          snapshotService: driftService,
          log: (m) => console.log(m),
        });
      },
    );
    console.log(
      `[middleware] drift-detector cron registered (${DRIFT_DETECTOR_CRON}, timeout ${DRIFT_DETECTOR_TIMEOUT_MS}ms)`,
    );
  }

  app.use(
    '/api/v1/profiles',
    requireAuth,
    createProfilesRouter({
      catalog: pluginCatalog,
      registry: installedRegistry,
      builtInOptOuts,
      // #2054 — profile apply attaches nothing to any agent (INV-8); the
      // apply dialog offers the capability plugins it installed for a grant.
      ...(liveProfileStorage ? { liveStorage: liveProfileStorage } : {}),
      ...(snapshotService ? { snapshotService } : {}),
      ...(graphPool && snapshotService ? { driftSweepPool: graphPool } : {}),
      ...(adminAudit ? { auditLog: adminAudit } : {}),
      // Phase 2.4 — Profile-Bundle import (OB-66). DraftStore is always
      // present; uploadedPackageStore is the catalog-of-uploads index.
      // packageUploadService is required only when bundles vendor plugins
      // — the import path is happy without it for source-only imports.
      draftStore,
      uploadedPackageStore,
      ...(packageUploadService ? { packageUploadService } : {}),
    }),
  );
  console.log(
    `[middleware] bootstrap profile endpoints ready at /api/v1/profiles (auth: required, live-storage: ${liveProfileStorage ? 'on' : 'off'}, snapshots: ${snapshotService ? 'on' : 'off'})`,
  );

  /**
   * OM-101 — is a Claude subscription usable right now? Same verdict the
   * providers-admin page computes (a CLI-backed provider is keyless: its probe
   * is the login check, not a credential probe), just reached from here.
   * Never throws — detection failure means "no subscription", not an error.
   */
  const subscriptionCliLoggedIn = async (): Promise<boolean> => {
    const snapshot = await detectCliBackends().catch(() => undefined);
    const verification = await resolveProviderVerification(
      SUBSCRIPTION_CLI_PROVIDER,
      { llmProviderCatalog, ...(snapshot ? { cliSnapshot: snapshot } : {}) },
    );
    return verification.status === 'verified';
  };

  /**
   * OM-101 — map an Anthropic model id onto the CLI's alias vocabulary. The
   * CLI takes `opus` / `sonnet` / `haiku`, not `claude-opus-5`; the registry's
   * own CLI models carry a `-cli` suffix that has to come off either way.
   */
  const cliAliasFor = (modelId: string): string => {
    const bare = modelId.replace(/-cli$/, '');
    if (bare.includes('opus')) return 'opus';
    if (bare.includes('haiku')) return 'haiku';
    if (bare.includes('sonnet')) return 'sonnet';
    return bare || 'sonnet';
  };

  const resolveBuilderProvider: BuilderProviderResolver = async (modelRef) => {
    const { provider: providerId, modelId } =
      BuilderModelRegistry.resolve(modelRef);
    // A model the operator picked from the subscription section of the model
    // catalog. The in-process loop cannot serve it (the completion adapter
    // rejects tool-carrying requests), so it always takes the CLI path.
    if (providerId === SUBSCRIPTION_CLI_PROVIDER) {
      if (!(await subscriptionCliLoggedIn())) {
        throw new BuilderLlmAccessError(
          `Builder-Modell '${modelRef}' läuft über das Claude-Abo, aber die ` +
            `Claude-CLI ist nicht angemeldet. Verbinde das Abo unter ADMIN → ` +
            `LLM-Zugang.`,
        );
      }
      return { cliModel: cliAliasFor(modelId), modelId };
    }
    if (providerId === 'anthropic') {
      // OM-101 — the 401 the round-5 tester saw came from right here: the
      // builder built a metered API client unconditionally, so an install with
      // no Anthropic key (subscription-only, which the orchestrator has
      // supported since round 4) failed on a credential it never needed. Only
      // fall through to the subscription when there is genuinely no key —
      // an operator who configured one keeps the API path and its tool loop.
      const anthropicKey =
        (await readProviderApiKey(
          (k) => secretVault.get(ORCHESTRATOR_SECRET_SOURCE, k),
          'anthropic',
        )) ?? (config.ANTHROPIC_API_KEY ?? '').trim();
      if (anthropicKey) {
        return {
          provider: createAnthropicProvider({ client: currentAnthropicClient() }),
          modelId,
        };
      }
      if (await subscriptionCliLoggedIn()) {
        return { cliModel: cliAliasFor(modelId), modelId };
      }
      throw new BuilderLlmAccessError(
        `Builder-Modell '${modelRef}' braucht einen LLM-Zugang: entweder einen ` +
          `Anthropic-API-Key oder ein verbundenes Claude-Abo. Beides fehlt.`,
      );
    }
    const provider = await resolveLlmProvider({
      providerId,
      getSecret: (k) => secretVault.get(ORCHESTRATOR_SECRET_SOURCE, k),
      maxRetries: 5,
      catalog: llmProviderCatalog,
    });
    if (!provider) {
      throw new Error(
        `Builder-Modell '${modelRef}' nutzt Provider '${providerId}', für den kein ` +
          `API-Key hinterlegt ist. Konfiguriere den Provider auf der Modelle-Seite ` +
          `und versuche es erneut.`,
      );
    }
    return { provider, modelId };
  };

  const builderConnectedProviders = async (): Promise<ReadonlySet<string>> => {
    const providerIds = [
      ...new Set(BuilderModelRegistry.list().map((m) => m.provider)),
    ];
    const checks = await Promise.all(
      providerIds.map(async (providerId) => {
        const descriptor = llmProviderCatalog.get(providerId);
        if (descriptor?.policy?.requiresApiKey === false) return providerId;
        const key = await readProviderApiKey(
          (k) => secretVault.get(ORCHESTRATOR_SECRET_SOURCE, k),
          providerId,
        );
        if (key) return providerId;
        if (
          providerId === 'anthropic' &&
          (config.ANTHROPIC_API_KEY ?? '').trim().length > 0
        ) {
          return providerId;
        }
        return null;
      }),
    );
    return new Set(checks.filter((p): p is string => p !== null));
  };

  const previewChatService = new PreviewChatService({
    resolveProvider: resolveBuilderProvider,
    draftStore,
    draftAgents: previewDraftAgents,
    logger: () => {},
  });

  // Per-draft event bus shared between BuilderAgent (B.4-3) and the inline-
  // editor PATCH endpoints (B.4-4). Multi-tab sync rides on this bus.
  const builderSpecBus = new SpecEventBus();

  // Per-turn replay buffer (B.5-3) — records every NDJSON frame the chat
  // route emits so a reconnecting client can re-attach via
  // `GET /drafts/:id/turn/:turnId/resume?since=N` and pick up exactly where
  // it left off without spending a second LLM call.
  const builderTurnRingBuffer = new BuilderTurnRingBuffer();
  // #2214 — one running builder turn per draft (chat route + AutoFix), and
  // the abort behind `POST /drafts/:id/turn/:turnId/stop`.
  const builderTurnLock = new DraftTurnLock();

  const builderRebuildScheduler = new PreviewRebuildScheduler({
    debounceMs: 2_000,
    invalidate: (userEmail, draftId) => {
      previewCache.invalidate(userEmail, draftId);
    },
    rebuild: async (userEmail, draftId) => {
      // B.6-6: out-of-band rebuilds (PATCH /spec without a chat turn) report
      // their build status on the spec bus. `warmPreview` emits every
      // `build_status` exactly once (#1731/#1733/#1807/#1809); a thrown
      // error here is already reported and only logged by the scheduler.
      const handle = await warmPreview(
        {
          previewCache,
          buildPipeline: builderBuildPipeline,
          previewSecretBuffer,
          bus: builderSpecBus,
          logTag: 'auto-rebuild',
        },
        { userEmail, draftId },
      );
      // B.9-3: fire-and-forget runtime smoke. Dedup'd per (draftId, rev)
      // inside the orchestrator — no-op on an unchanged handle.
      builderRuntimeSmokeOrchestrator.attemptSmoke({
        handle,
        userEmail,
        draftId,
      });
    },
  });

  const builderSlotTypechecker = new SlotTypecheckPipeline({
    draftStore,
    templateRoot: BUILDER_BUILD_TEMPLATE_DIR,
    stagingBaseDir: BUILDER_STAGING_DIR,
    templateReady,
    bus: builderSpecBus,
    logger: (...args: unknown[]) => {
      console.log('[builder]', ...args);
    },
  });

  const builderRuntimeSmokeOrchestrator = new RuntimeSmokeOrchestrator({
    draftStore,
    bus: builderSpecBus,
    logger: (...args: unknown[]) => {
      console.log('[builder]', ...args);
    },
    // Spec 2042 §5.10 — a smoke run is a preview of the draft: one operator
    // job of the Plugin Builder's preview kind.
    runAsJob: (startedBy, work) => modelWork.run(PLUGIN_BUILDER_PREVIEW, startedBy, () => work()),
  });

  // ── Native issue-reporting wiring (concept plan) ─────────────────────────
  // The coordinator, triage log, and issue cache are constructed up-front
  // so both the BuilderAgent (tool context) and the issue-reporting routes
  // (operator-facing endpoints) share the same instances. All three are
  // backed by the v2 schema on `drafts.db`, so no extra storage backend
  // appears for this feature.
  const builderUserChoice = new UserChoiceCoordinator({ bus: builderSpecBus });
  const builderTriageLog = new BuilderTriageLog({ dbPath: DRAFTS_DB_PATH });
  await builderTriageLog.open();
  const builderGithubIssueCache = new GithubIssueCache({ dbPath: DRAFTS_DB_PATH });
  await builderGithubIssueCache.open();
  const builderWorkaroundStateStore = new WorkaroundStateStore({
    dbPath: DRAFTS_DB_PATH,
  });
  await builderWorkaroundStateStore.open();
  const upstreamIssueConfig = loadUpstreamIssueConfig();
  if (!isUpstreamAllowlisted(upstreamIssueConfig)) {
    console.warn(
      `[builder/issue-reporting] WARNING: configured upstream ${upstreamIssueConfig.owner}/${upstreamIssueConfig.repo} is NOT in the platform allowlist. ` +
        `Issues will land outside the canonical omadia repo — verify this is intentional (Fork operator). ` +
        `To suppress this warning, point GITHUB_UPSTREAM_OWNER/REPO at a registered allowlist entry.`,
    );
  } else {
    console.log(
      `[builder/issue-reporting] upstream ${upstreamIssueConfig.owner}/${upstreamIssueConfig.repo} ` +
        `(labels: ${upstreamIssueConfig.labels.join(', ')})`,
    );
  }

  // Issue #206 (v1.2) — optional GitHub-App direct-create path. Built only
  // when (a) App credentials are present in the environment AND (b) the
  // upstream is allowlisted. Both gates matter: the credentials are a
  // deployment secret, and the allowlist prevents a mis-pointed fork from
  // auto-filing into an arbitrary repo under the bot identity. When unbuilt
  // the agent transparently falls back to browser-submit.
  const githubAppConfig = loadGitHubAppConfig();
  let builderIssueCreator: GithubIssueCreator | undefined;
  if (githubAppConfig && isUpstreamAllowlisted(upstreamIssueConfig)) {
    builderIssueCreator = new GithubIssueCreator({
      tokenProvider: new GitHubAppTokenProvider({ config: githubAppConfig }),
    });
    console.log(
      `[builder/issue-reporting] direct-create enabled via GitHub App ` +
        `(app id ${githubAppConfig.appId}) → ${upstreamIssueConfig.owner}/${upstreamIssueConfig.repo}`,
    );
  } else if (githubAppConfig) {
    console.warn(
      `[builder/issue-reporting] GitHub App configured but upstream ` +
        `${upstreamIssueConfig.owner}/${upstreamIssueConfig.repo} is not allowlisted — ` +
        `direct-create stays OFF, falling back to browser-submit.`,
    );
  }

  // Issue #227 — platform-version banner for the Builder system prompt. The
  // boot timestamp is captured once here (server start); a redeploy bumps it,
  // letting the Builder notice the platform changed between turns and re-verify
  // earlier bug hypotheses (inspect_generated_artifact / get_build_status /
  // runtime_smoke_status) instead of asking the operator to drive a preview.
  const builderPlatformPkg = await import('../package.json', {
    with: { type: 'json' },
  }).then((m) => m.default as { name?: string; version?: string });
  const builderPlatformBanner =
    `omadia platform: ${builderPlatformPkg.name ?? 'omadia-middleware'} ` +
    `${builderPlatformPkg.version ?? '0.0.0'} (process booted ${new Date().toISOString()})`;

  const builderAgent = new BuilderAgent({
    resolveProvider: resolveBuilderProvider,
    draftStore,
    bus: builderSpecBus,
    rebuildScheduler: {
      schedule: (userEmail: string, draftId: string) =>
        builderRebuildScheduler.schedule(userEmail, draftId),
    },
    catalogToolNames: () => nativeToolRegistry.list(),
    knownPluginIds: () => pluginCatalog.list().map((entry) => entry.plugin.id),
    slotTypechecker: builderSlotTypechecker,
    // Theme G (2026-05-04): the catalog used to be a hardcoded map in
    // paths.ts. It is now data-driven from the live PluginCatalog so every
    // installed integration plugin auto-registers under
    // `integration-<tail>`. The LLM reads each one's `INTEGRATION.md` for
    // the canonical service surface — no more drift on integration patches.
    //
    // Passed as a per-turn thunk (not a boot snapshot) so an integration
    // hot-installed mid-session — the catalog is reloaded on upload — shows
    // up in `read_reference`/`list_references` immediately, retiring the old
    // "not visible until next restart" caveat.
    referenceCatalog: () => resolveBuilderReferenceCatalog(pluginCatalog),
    templateRoot: BUILDER_BUILD_TEMPLATE_DIR,
    // OB-31 follow-up: a single fill_slot routinely generates whole TS
    // slot bodies (5–15k tokens). The 4096 LocalSubAgent default hit
    // max_tokens mid-input-streaming; the SDK aggregator then drops the
    // truncated `source` field and zod parses `{"slotKey":"…"}` alone —
    // surfacing as the misleading "Required: source" error in the Builder
    // chat. See BUILDER_AGENT_MAX_TOKENS in config.ts.
    subAgentMaxTokens: config.BUILDER_AGENT_MAX_TOKENS,
    userChoice: builderUserChoice,
    triageLog: builderTriageLog,
    githubIssueCache: builderGithubIssueCache,
    upstreamIssueConfig,
    directIssueCreateAvailable: builderIssueCreator !== undefined,
    // Issue #227 — codegen / build / runtime observability accessors for the
    // get_build_status + runtime_smoke_status tools, plus the version banner.
    lastBuildStatus: (draftId: string) =>
      builderBuildPipeline.getLastBuildStatus(draftId),
    lastSmokeStatus: (draftId: string) =>
      builderRuntimeSmokeOrchestrator.getLastSmokeStatus(draftId),
    platformBanner: builderPlatformBanner,
    logger: (...args: unknown[]) => {
      console.log('[builder]', ...args);
    },
  });

  // Option-C, C-4: AutoFixOrchestrator. Listens on the SpecEventBus for
  // build_status:failed / runtime_smoke_status:failed and fires synthetic
  // Builder turns when `spec.builder_settings.auto_fix_enabled` is set.
  // 3-consecutive-identical-fingerprint cap prevents runaway loops.
  const builderAutoFixOrchestrator = new AutoFixOrchestrator({
    bus: builderSpecBus,
    draftStore,
    builderAgent,
    defaultModel: BuilderModelRegistry.default(),
    turnRingBuffer: builderTurnRingBuffer,
    turnLock: builderTurnLock,
    logger: (...args: unknown[]) => {
      console.log('[builder/auto-fix]', ...args);
    },
    // Spec 2042 §5.10 — each synthetic fix turn is one operator job.
    runAsJob: (startedBy, work) => modelWork.run(PLUGIN_BUILDER_AUTOFIX, startedBy, () => work()),
  });

  let stopMdnsAdvertiser: (() => Promise<void> | undefined) | undefined;
  const shutdownBuilder = async (): Promise<void> => {
    try {
      builderRebuildScheduler.cancelAll();
      // Well inside SHUTDOWN_TIMEOUT_MS: the rest of this function (stdio MCP
      // children above all) has to run before the process exits.
      await builderBuildQueue.drain(1_500).catch(() => {
        // best-effort
      });
      await previewCache.closeAll();
      // Issue #563 — terminate pooled MCP connections; for stdio servers those
      // are child processes that would otherwise outlive the middleware.
      await runtimeMcpManager?.closeAll();
      previewSecretBuffer.clear();
      // Wake any pending ask_user_choice promises so the turns waiting
      // on them resolve before we close the DB.
      builderUserChoice.cancelAll();
      await builderGithubIssueCache.close();
      await builderTriageLog.close();
      await builderWorkaroundStateStore.close();
      await draftStore.close();
      // Stop every active routine (drops scheduler entries; in-flight runs
      // see their AbortSignal). Idempotent if undefined.
      routinesHandle?.close();
      await stopMdnsAdvertiser?.();
    } catch {
      // ignore — process is exiting anyway
    }
  };
  const onShutdownSignal = exitAfterShutdown(shutdownBuilder);
  process.once('SIGTERM', onShutdownSignal);
  process.once('SIGINT', onShutdownSignal);

  app.use(
    '/api/v1/builder',
    requireAuth,
    createBuilderRouter({
      store: draftStore,
      quota: draftQuota,
      connectedProviders: builderConnectedProviders,
      // Scope the model picker to the orchestrator's active provider so a
      // cross-provider pick can't be offered (issue #296).
      activeProvider: orchestratorActiveProviderId,
      preview: {
        draftStore,
        previewCache,
        previewChatService,
        buildPipeline: builderBuildPipeline,
        previewSecretBuffer,
        rebuildScheduler: builderRebuildScheduler,
        bus: builderSpecBus,
        runtimeSmokeOrchestrator: builderRuntimeSmokeOrchestrator,
      },
      chat: {
        draftStore,
        builderAgent,
        turnRingBuffer: builderTurnRingBuffer,
        turnLock: builderTurnLock,
      },
      events: {
        draftStore,
        bus: builderSpecBus,
        autoFixOrchestrator: builderAutoFixOrchestrator,
        // An open event stream ends with its session: at the cookie's exp,
        // when `announce` reports a revocation, or when the check that runs
        // with every heartbeat refuses it. Same verdict path as requireAuth.
        sessions: {
          evaluate: (token) =>
            evaluateSessionToken(token, {
              signingKey: sessionSigningKey,
              whitelist: emailWhitelist,
              sessions: sessionRevocation,
            }),
          revocations: sessionRevocation,
        },
      },
      editing: {
        draftStore,
        bus: builderSpecBus,
        rebuildScheduler: {
          schedule: (userEmail: string, draftId: string) =>
            builderRebuildScheduler.schedule(userEmail, draftId),
        },
      },
      // Issue #56 — paginated audit-log surface
      audit: { draftStore },
      // Install endpoint is only wired when the package-upload subsystem is
      // enabled — otherwise the underlying ingest service does not exist.
      // BuilderRouterDeps.install is optional so the route stays absent.
      ...(packageUploadService
        ? {
            install: {
              draftStore,
              buildPipeline: builderBuildPipeline,
              packageUploadService,
              ...(adminAudit ? { adminAudit } : {}),
              quota: draftQuota,
              workaroundStateStore: builderWorkaroundStateStore,
            },
            // Self-extension shares the install dependency surface; an approved
            // proposal installs + reactivates through the same ingest →
            // onPackageReady seam as an operator upload.
            selfExtension: {
              gate: selfExtensionGate,
              draftStore,
              buildPipeline: builderBuildPipeline,
              packageUploadService,
              pluginCatalog,
              selfExtendRegistry,
              extensionStore,
              reactivate: reactivateAgent,
            },
          }
        : {}),
      // Native issue-reporting routes (concept plan). Always wired —
      // the routes are no-ops when no operator has triggered a triage
      // flow, but they need to exist so the UI can confirm browser-
      // submitted issues.
      issueReporting: {
        store: draftStore,
        userChoice: builderUserChoice,
        githubIssueCache: builderGithubIssueCache,
        ...(builderIssueCreator ? { issueCreator: builderIssueCreator } : {}),
        bus: builderSpecBus,
        upstream: {
          owner: upstreamIssueConfig.owner,
          repo: upstreamIssueConfig.repo,
          requiredLabels: upstreamIssueConfig.labels,
        },
      },
    }),
  );
  console.log(
    `[builder] preview cache initialized (cap=3/user, previews=${BUILDER_PREVIEWS_DIR}, orphans-cleared=${String(orphanResult.removed)})`,
  );
  console.log(
    `[middleware] agent-builder endpoints ready at /api/v1/builder (db=${DRAFTS_DB_PATH}, auth: required)`,
  );

  // The ADMIN_TOKEN surface is mounted further up, before the `/api` session
  // gate — see `mountAdminTokenSurface` there. S+7.7: Telegram admin endpoints
  // live inside the plugin (core.registerRouter at /api/telegram/admin/*).

  // `/diagrams/<signed-key>` is now mounted by the @omadia/diagrams
  // plugin via ctx.routes.register (see packages/harness-diagrams/src/plugin.ts).

  // `/attachments/<signed-key>` is now mounted by the de.byte5.channel.teams
  // plugin via ctx.routes.register (see packages/harness-channel-teams/src/plugin.ts,
  // phase-3.1-4).

  // `/api/dev/memory` is now mounted by the @omadia/memory plugin via
  // ctx.routes.register when its `dev_memory_endpoints_enabled` config is true.
  // It is authenticated by the same OB-106 `/api` requireAuth line as everything
  // else here — issue #669 removed the `/api/dev` entry from `publicPaths` — and
  // bound to loopback by `mountDevLoopbackGuard` below when
  // DEV_ENDPOINTS_LOOPBACK_ONLY is set (#1350).

  // Issue #669 — the operator surfaces (KG lifecycle, per-agent priorities,
  // plugin domains) no longer live behind DEV_ENDPOINTS_ENABLED. They are
  // authenticated admin routers; publishing the dev scaffolding was never a
  // supported price for reaching them. `graphLifecycle@1`/`agentPriorities@1`
  // are published by the Neon KG plugin only — the in-memory backend leaves
  // them unmounted because the lifecycle sweeps are Postgres-specific.
  const kgAdminMounted = mountKnowledgeGraphAdmin(app, requireAuth, {
    lifecycle: serviceRegistry.get<LifecycleService>('graphLifecycle'),
    priorities: serviceRegistry.get<AgentPrioritiesStore>('agentPriorities'),
    catalog: pluginCatalog,
  });
  console.log(
    `[middleware] KG admin endpoints ready (auth: required) — lifecycle=${
      kgAdminMounted.lifecycle ? KG_LIFECYCLE_ADMIN_PATH : 'unmounted (no graphLifecycle@1)'
    }, priorities=${
      kgAdminMounted.priorities ? KG_PRIORITIES_ADMIN_PATH : 'unmounted (no agentPriorities@1)'
    }, domains=${PLUGIN_DOMAINS_ADMIN_PATH}`,
  );

  // The flag is read inside `mountDevGraph`, not in an `if` here — see its doc
  // comment: one tested consumer, and an admin mount that cannot depend on it.
  // #1350 — the loopback guard covers the whole `/api/dev` prefix, including
  // the plugin routes `pluginRouteRegistry.mountAll(app)` mounts further down
  // (the `@omadia/memory` browser). It must stay ahead of both mounts.
  mountDevLoopbackGuard(app, { loopbackOnly: config.DEV_ENDPOINTS_LOOPBACK_ONLY });
  if (
    mountDevGraph(app, requireAuth, {
      graph: knowledgeGraph,
      enabled: config.DEV_ENDPOINTS_ENABLED,
    })
  ) {
    console.log(
      `[middleware] DEV endpoints enabled at ${DEV_GRAPH_PATH} (auth: required${
        config.DEV_ENDPOINTS_LOOPBACK_ONLY ? `, ${DEV_PATH_PREFIX}/* loopback-only` : ''
      })`,
    );
  }

  // Teams was previously an inline block here (MICROSOFT_APP_* gated, bot +
  // history + topic detector + attachments + roster + router all built in
  // one 135-line block). Ported to a ChannelPlugin in Slice 2.3 — see the
  // channel runtime wiring further below. The plugin reads MS App creds via
  // ctx from the Microsoft 365 integration, not from .env directly.

  // ────────────────────────────────────────────────────────────────────────
  // Channel runtime (Slice 2.2 scaffold — strict agnostic, no channel
  // plugin implementations registered yet; Teams & Telegram land in 2.3/2.4)
  // ────────────────────────────────────────────────────────────────────────
  const routeRegistry = new ExpressRouteRegistry(app);

  // Real TurnDispatcher: drive a ChatAgent (published as a ChatAgentBundle)
  // and stream its events straight back to the channel adapter. The orchestrator
  // service is resolved lazily per turn from the service registry so it always
  // uses the currently-active orchestrator. The service KEY is the channel's
  // configured `dispatch_service` (Omadia UI) — classic channels declare none
  // and resolve to the shared 'chatAgent', exactly as before. This makes
  // `CoreApi.handleTurnStream` real for EVERY channel — channels no longer have
  // to reach into the service registry themselves to answer a turn.
  // channelId == the channel plugin's catalog id; read its manifest `channel`
  // block (loaded into pluginCatalog at boot) to pick the dispatch service.
  // US7 — one resolver for the short binding type, shared by the dispatcher
  // (Agent routing) and the CoreApi (#1086: the key a routine is stored and
  // delivered under). Two derivations would let a manifest-declared
  // `channel_type` route the turn one way and file its routines another.
  const channelTypeFor = (channelId: string): string =>
    deriveChannelType(channelId, {
      manifest: pluginCatalog.get(channelId)?.plugin.channel,
    });

  const orchestratorDispatcher: TurnDispatcher = createOrchestratorDispatcher({
    getChannelBlock: (channelId) =>
      pluginCatalog.get(channelId)?.plugin.channel,
    // #1598 — the shared `chatAgent` is the grant-less legacy bundle; with a
    // registry, a turn that has no binding gets the standard orchestrator.
    getAgentBundle: (service) =>
      service === 'chatAgent'
        ? getScopedChatAgentBundle()
        : serviceRegistry.get<ChatAgentBundle>(service),
    // US7 — channelType autodiscovery: prefer the manifest's declared
    // channel_type, else derive it from the channel id's last dotted segment
    // (de.byte5.channel.teams → teams), the convention operators bind under.
    channelTypeFor,
    // US7 — per-binding routing: resolve the scoped ChatAgent the operator
    // bound to (channelType, channelKey) via the multi-orchestrator
    // channelResolver. Resolved lazily so hot config reloads take effect and
    // so a Postgres-less deployment (no resolver published) degrades to the
    // shared chatAgent via the static dispatch_service path.
    resolveBinding: (channelType, channelKey, context) => {
      const resolver =
        serviceRegistry.get<ChannelBindingResolver>('channelResolver');
      if (!resolver) return undefined;
      // #2055 — always a ChatAgent: the routed agent behind the management
      // layer, or the management layer answering with its `system` notice.
      return resolver.resolve(channelType, channelKey, context).chatAgent;
    },
    // #2059 — a turn that names an agent (canvas, agent picker) goes to that
    // agent's envelope; `undefined` when the resolver cannot address by id.
    resolveAgent: (agentId, target, context) =>
      serviceRegistry
        .get<ChannelBindingResolver>('channelResolver')
        ?.resolveAgent?.(agentId, target, context),
  });

  // Omadia UI canvas transport: a kernel-owned WebSocket registry mirroring
  // ExpressRouteRegistry. It authenticates each upgrade with the session
  // cookie BEFORE the handshake (same signing key as requireAuth) and backs
  // `CoreApi.registerWebSocket`. Inert for every non-WS channel; attached to
  // the http.Server once it exists (after app.listen, below). The same
  // revocation guard ends open channel sockets too: 4401 at the cookie's exp,
  // 4403 when `announce` reports a revocation, or when the check a frame
  // needs (verdict older than WS_SESSION_FRAME_RECHECK_MS) or the 60 s
  // idle-socket sweep finds one.
  const webSocketRegistry = new WebSocketRegistry({
    signingKey: sessionSigningKey,
    whitelist: emailWhitelist,
    sessions: sessionRevocation,
    channelFrameRecheckMs: config.WS_SESSION_FRAME_RECHECK_MS,
  });

  // #330 B3 — Principal-addressed targeted delivery ('targetedSend' service).
  // Constructed after the conductor block so the role resolver + binding
  // lookup are already set when Postgres is available; deny-by-default for
  // plugins like every other kernel service.
  // #2043 — sending as an agent's OWN identity: identity from the registry
  // (never the default bot). A post into a conversation is authorized by an
  // execution scope; the message subscriptions are where people are looked up.
  const ownIdentitySend = {
    identityFor: (agentSlug: string, channelType: string) =>
      getRegistry()?.channelIdentityFor(agentSlug, channelType),
    ...(conversationMessages ? { subscriptions: conversationMessages.hub } : {}),
    archetypeAddsOwnIdentitySend: (agentSlug: string) =>
      archetypeAdds(getRegistry()?.get(agentSlug)?.agent, 'own_identity_send'),
    getRoster: (
      channelType: string,
      conversationId: string,
      opts?: { readonly asChannelKey?: string },
    ) => conversationRosterRegistry.getRoster(channelType, conversationId, opts),
    // The AI marking of own-identity posts, by the rule of the agent's turn
    // answers; folded only where the channel has no AI label of its own.
    disclosure: {
      disclosureFor: (agentSlug: string, channelType: string) =>
        getRegistry()?.get(agentSlug)?.built.orchestrator.disclosureForChannel(channelType),
      seen: new InMemoryDisclosureSeenStore(),
    },
  };
  // #2043 — 'agentTurn@2': the engine runs a turn as a facilitator, as an
  // authorized action under an execution scope, and gets the text back unposted.
  publishAgentTurnService({
    serviceRegistry,
    getRegistry,
    ...(conversationMessages ? { messages: conversationMessages.hub } : {}),
    engineSources: facilitationEngineSources,
    executionFor: (pluginId) => executionRef.current?.serviceFor(pluginId),
    maxTurnsPerMinute: config.AGENT_TURN_MAX_PER_MINUTE,
    // #2048 — the audience of a facilitator's turn is the conversation, read
    // as the agent's OWN identity (never the default bot's view).
    roster: async (channelType, conversationId, agentSlug) => {
      const identity = getRegistry()?.channelIdentityFor(agentSlug, channelType);
      if (!identity) return undefined;
      return conversationRosterRegistry.getRoster(channelType, conversationId, {
        asChannelKey: identity.channelKey,
      });
    },
    language: () => {
      const raw = installedRegistry.get('@omadia/orchestrator')?.config?.['ai_disclosure_locale'];
      return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : undefined;
    },
    // #2066 — the facilitator's default methods and reminder policy.
    ...(agentArchetypeSettingsStore ? { archetypeSettings: (agentId: string) => agentArchetypeSettingsStore.get(agentId) } : {}),
    log: (m) => console.log(m),
  });
  publishSendServices({
    serviceRegistry,
    targeted: createTargetedDeliveryService({
      providers: targetedSendRegistry,
      ...(targetedRoleResolver ? { resolveRoleHolders: targetedRoleResolver } : {}),
      ...(targetedBindingLookup ? { lookupConversationRefs: targetedBindingLookup } : {}),
      ownIdentity: ownIdentitySend,
      log: (m) => console.log(m),
    }),
    // #330 C3b — conversation-addressed proactive send (group nudges).
    conversation: createConversationSendService({
      providers: conversationSendRegistry,
      ownIdentity: ownIdentitySend,
      ...(conversationMessages ? { openQuestions: conversationMessages.openQuestions } : {}),
      onOwnIdentityDelivered: ownIdentityPostLog.record,
      log: (m) => console.log(m),
    }),
    // #2091 — 'conversationSend@2': sends drawn from an execution scope.
    scoped: {
      executionFor: (pluginId) => executionRef.current?.serviceFor(pluginId),
      direct: {
        providers: targetedSendRegistry,
        ...(targetedBindingLookup ? { lookupConversationRefs: targetedBindingLookup } : {}),
        ownIdentity: ownIdentitySend,
        log: (m) => console.log(m),
      },
      messages: () => conversationMessages?.hub,
      readiness: (request) => sessionCapabilityHub.check(request),
      log: (m) => console.log(m),
    },
  });

  const channelCoreApi = createCoreApi({
    dispatcher: orchestratorDispatcher,
    routes: routeRegistry,
    webSockets: webSocketRegistry,
    rosterRegistry: conversationRosterRegistry,
    peopleDirectories: peopleDirectoryRegistry,
    targetedSends: targetedSendRegistry,
    conversationEvents: conversationEventHub,
    conversationSends: conversationSendRegistry,
    // #2082 — every message a channel reports reaches the agents' hooks as
    // `conversation.message.created`: ids and kind only, never the text.
    onConversationMessage: (event) => {
      if (event.kind !== 'created') return;
      triggersRef.current?.onEvent(
        'conversation.message.created',
        {
          channelType: event.channelType,
          conversationId: event.conversationId,
          messageId: event.messageId,
          authorId: event.author.id,
          authorKind: event.author.kind,
          // Which bot heard it (spec 2042 §5.3): a hook set on an agent's own
          // bot hears only that bot's conversation.
          receivedByChannelKey: event.receivedByChannelKey,
        },
        `${event.channelType}:${event.conversationId}:${event.messageId}`,
      );
    },
    ...(conversationMessages ? { conversationMessages: conversationMessages.hub } : {}),
    readinessProviders: readinessProviderRegistry,
    meetingSources: meetingSourceRegistry,
    agentIdentities: agentIdentityProviderRegistry,
    defaultChannelKeys: defaultChannelKeyRegistry,
    sessionCapabilities: sessionCapabilityHub,
    // #1086 — the channel-agnostic producer of the routines principal, for
    // every channel that drives its turn through `handleTurnStream` (in-tree:
    // public API, canvas). Adapters that call the `chatAgent` capability
    // directly never reach it. Absent when routines are off (no pg pool),
    // which leaves `handleTurnStream` byte-for-byte on its old behaviour.
    // Tenant default and the always-closed `canTargetOthers` live in
    // `createCoreRoutineTurnScope`, where they are tested.
    channelTypeFor,
    ...(routinesIntegration
      ? { routineTurn: createCoreRoutineTurnScope(routinesIntegration, graphTenantId) }
      : {}),
  });

  // Phase 5B: channel discovery flips to plugin-store-flow. The
  // DynamicChannelPluginResolver dynamic-imports `dist/plugin.js` from
  // each channel package's uploadedStore/builtInStore source and calls
  // its bare `activate(ctx, core)` export — same path
  // ToolPluginRuntime takes for tool/extension/integration plugins.
  // Each channel plugin sources every dependency it needs from
  // `ctx.services` (anthropicClient / tigrisStore / graphPool /
  // graphTenantId / embeddingClient / topicDetector / turnContext /
  // microsoft365.graph / chatAgent / routinesIntegration / memoryStore)
  // — no kernel-side instantiation, no constructor Deps. The legacy
  // FixedChannelPluginResolver and the manual `register()` calls for
  // Teams + Telegram are gone with this commit.
  const channelPluginResolver = new DynamicChannelPluginResolver({
    catalog: pluginCatalog,
    uploadedStore: uploadedPackageStore,
    builtInStore: builtInPackageStore,
  });
  const channelRegistry = new DefaultChannelRegistry({
    catalog: pluginCatalog,
    installedRegistry,
    vault: secretVault,
    serviceRegistry,
    nativeToolRegistry,
    pluginRouteRegistry,
    // S3-G — channel plugins claim their declared public paths too (Teams'
    // `/p/channel-teams`); same registry, store and core list as the runtimes.
    publicPathGrants,
    publicPathGrantStore,
    corePublicPaths: publicPaths(),
    notificationRouter,
    uiRouteCatalog,
    jobScheduler,
    flowSigningKey: sessionSigningKey,
    flowPublicBaseUrl,
    pluginStatusRegistry,
    operatorAuth,
    eventCatalogRegistry,
    resolver: channelPluginResolver,
    // omadia#838 — channels that declare `permissions.sql` get the grant
    // check and kernel-run migrations of ADR-0050, like the tool runtime.
    sqlGrantStore,
    packagePathOf: (agentId) => channelPluginResolver.packagePathOf(agentId),
    coreApi: channelCoreApi,
    routes: routeRegistry,
    webSockets: webSocketRegistry,
    rosterRegistry: conversationRosterRegistry,
    peopleDirectories: peopleDirectoryRegistry,
    targetedSends: targetedSendRegistry,
    conversationSends: conversationSendRegistry,
    readinessProviders: readinessProviderRegistry,
    meetingSources: meetingSourceRegistry,
    agentIdentities: agentIdentityProviderRegistry,
    defaultChannelKeys: defaultChannelKeyRegistry,
  });
  channelPluginIdsRef.current = () => channelRegistry.activeIds();
  channelRegistryRef = channelRegistry;
  await channelRegistry.activateAllInstalled();
  // #2043 — every plugin had its chance to activate: from here on the kernel
  // may end message subscriptions whose ground is gone (engine plugin not
  // active or replaced, agent disabled or deleted, identity lost).
  conversationMessagesRef.current?.enableReconcile();
  void conversationMessagesRef.current?.reconcileNow();
  console.log(
    `[middleware] channel runtime ready (${channelRegistry.activeIds().length} active via dynamic-resolver)`,
  );

  // Now that every channel plugin has activated and registered its
  // `ProactiveSender` (Teams: via publishProactiveSend), it's safe to
  // start the routines runner. start() runs the catch-up scan which can
  // immediately fire a runOnce — without senders being registered, that
  // would record a "no sender" error on the routine.
  if (routinesHandle) {
    await routinesHandle.runner.start();
  }
  // #2082 — triggers fire through the same proactive senders.
  triggersRef.current?.start();

  // Mount routers contributed by plugins (via ctx.routes.register). Must run
  // AFTER all plugin activate()'s have completed, otherwise late-registered
  // routers miss the mount. The PluginRouteRegistry is idempotent — calling
  // mountAll twice is a no-op.
  pluginRouteRegistry.mountAll(app);
  const pluginRoutesCount = pluginRouteRegistry.list().length;
  if (pluginRoutesCount > 0) {
    console.log(
      `[middleware] plugin routes mounted: ${pluginRoutesCount} (${pluginRouteRegistry
        .list()
        .map((r) => `${r.source}→${r.prefix}`)
        .join(', ')})`,
    );
  }

  // Fire background jobs registered by plugins. Today no plugin populates
  // this registry — built-in entity-syncers still start directly from this
  // file. The call is here so Phase 2 extractions can swap direct boot for
  // `ctx.jobs.register(...)` without touching the boot sequence.
  await backgroundJobRegistry.start();
  console.log(
    `[middleware] background jobs: ${backgroundJobRegistry.names().length} registered (turn hooks: before=${turnHookRegistry.counts().onBeforeTurn} afterTool=${turnHookRegistry.counts().onAfterToolCall} afterTurn=${turnHookRegistry.counts().onAfterTurn}, prompt contributors: ${promptContributionRegistry.count()}, agent wrappers: ${chatAgentWrapRegistry.count()})`,
  );
  const notificationChannels = notificationRouter.list();
  console.log(
    `[middleware] notification router: ${notificationChannels.length} channel(s) registered${notificationChannels.length > 0 ? ` (${notificationChannels.join(', ')})` : ''}`,
  );
  const uiRouteCount = uiRouteCatalog.size();
  console.log(
    `[middleware] ui-route catalog: ${uiRouteCount} descriptor(s) registered${uiRouteCount > 0 ? ` (${uiRouteCatalog.list().map((r) => `${r.pluginId}${r.path}`).join(', ')})` : ''}`,
  );

  // Bind dual-stack on :: so both IPv6 (Fly-Edge default + flycast) and
  // IPv4 (legacy + local dev) clients are served. Default `0.0.0.0` would
  // miss IPv6-only Fly-internal traffic — Stolperfalle #4 in
  // memory/feedback-fly-operational.
  // Boot the setup-field pattern worker now, so the first operator to save a
  // plugin credential does not pay thread creation inside their request's
  // match budget (#607). Fire-and-forget: the worker is created on demand
  // anyway, this only moves the cost off the critical path.
  void warmPatternWorker();

  // #1326 / #1318 / #1349 — answer whatever no router took (unknown path,
  // body-parser rejection, unhandled route error) with a JSON `{ code, message }`
  // and never a stack, instead of Express's HTML `finalhandler`. A terminal
  // callback rather than a trailing `app.use`, so routes plugins mount after
  // boot still come before it — see http/terminalHandler.ts.
  const terminalHandler = createTerminalHandler({
    ungrantedPublicPrefix: (path) => publicPathGrants.resolveUngranted(path)?.prefix ?? null,
  });
  const server = createAppServer(app, terminalHandler).listen(config.PORT, config.HOST, () => {
    console.log(`[middleware] listening on [${config.HOST}]:${config.PORT}`);
    console.log(`[middleware] skills dir: ${config.SKILLS_DIR}`);
    console.log(`[middleware] orchestrator model: ${config.ORCHESTRATOR_MODEL}`);
    console.log(`[middleware] sub-agent model:   ${config.SUB_AGENT_MODEL}`);
    void handOffCliLogin().catch((err: unknown) => {
      console.warn(
        `[providers] subscription hand-off at boot failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  });

  // Attach the canvas WebSocket transport to the same http.Server, so the
  // dual-stack '::' bind serves WS upgrades too. Idempotent; inert until a
  // channel registers a socket path via CoreApi.registerWebSocket.
  webSocketRegistry.attach(server);

  // LAN zero-config discovery (#293): advertise `_omadia._tcp` so a desktop
  // client on the same network can pair with zero typing. Best-effort — a host
  // with no LAN reachability (Fly) simply never gets discovered this way. The
  // desktop shell disables it via env (OM-70); the advertiser itself never
  // claims the machine's own host name (see pairing/mdns.ts).
  if (config.OMADIA_UI_MDNS_ENABLED) {
    const advertisedAuthMode: 'none' | 'password' | 'oidc' = pairingProviders
      ?.length
      ? pairingProviders.some((p) => p.kind === 'oidc')
        ? 'oidc'
        : 'password'
      : 'none';
    void startMdnsAdvertiser({
      port: config.PORT,
      name: config.OMADIA_UI_INSTANCE_NAME ?? 'omadia',
      canvasPath: CANVAS_WS_PATH,
      protocolVersion: PAIRING_PROTOCOL_VERSION,
      authMode: advertisedAuthMode,
      log: (msg) => console.log(msg),
    }).then((adv) => {
      mdnsAdvertisement = adv;
    });
    stopMdnsAdvertiser = () => mdnsAdvertisement?.stop();
  }

  // Fast-fail on EADDRINUSE: without this, hot-reload or a stale `npm run dev`
  // boots the whole stack silently while the port is held by a zombie tsx
  // process — HTTP traffic keeps hitting the older worker with old code, and
  // the new process appears alive but never serves anything. Saga reference:
  // HANDOFF-2026-05-04 (zombie-tsx on :3979 holding old boilerplate).
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      // Find the offending PID(s) so the operator does not have to guess.
      let holderInfo = '';
      try {
        const out = execSync(`lsof -nP -iTCP:${config.PORT} -sTCP:LISTEN`, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        if (out) holderInfo = `\n${out}`;
      } catch {
        // lsof might not be installed (e.g. minimal container); skip.
      }
      console.error(
        `[middleware] FATAL: port ${config.PORT} already in use (EADDRINUSE).${holderInfo}\n` +
          `[middleware] Hint: run \`lsof -i :${config.PORT}\` to inspect, or \`npm run dev:clean\` ` +
          `to terminate stale dev processes and restart cleanly.`,
      );
      process.exit(1);
    }
    // Re-throw any other listen() error so it surfaces in logs/crash handlers
    // — silently swallowing means a broken server with no diagnostic.
    throw err;
  });
}

// `buildSubAgentSystemPrompt` was removed in Phase 5B M3+M4 catch-up —
// the runtime-note prompt-partial now lives inside each extracted agent
// plugin (@omadia/agent-odoo-accounting, @omadia/agent-odoo-hr,
// @omadia/agent-confluence) under skills/runtime-note.md. The dynamic-
// runtime's loadSystemPrompt() concatenates those manifest-declared
// prompt-partials in front of the playbook body, replacing this helper.

// `buildVerifierService` (kernel-side) was removed in S+10-4a — the
// @omadia/orchestrator plugin's activate() now owns the wrap
// against the verifier@1 bundle and publishes the verifier-wrapped
// agent as `chatAgent@1.agent`.

main().catch((err) => {
  console.error('[middleware] fatal startup error:', err);
  process.exit(1);
});
