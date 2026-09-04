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
import { config, parseRegistries } from './config.js';
import { createTigrisStore } from '@omadia/diagrams';
import type { MemoryStore } from '@omadia/plugin-api';
import { createAdminRouter } from './routes/admin.js';
import { createMemoryPurgeRouter } from './routes/memoryPurge.js';
import { createMemoryPromoteRouter } from './routes/memoryPromote.js';
import { createAdminUpdateRouter } from './routes/adminUpdate.js';
import { createUpdateAuditStore } from './update/auditStore.js';
import { createReleaseLookup } from './update/releaseLookup.js';
import { createUpdaterClient } from './update/updaterClient.js';
import { resolvePlatform } from './update/platform.js';
import { resolveAppVersion } from './update/version.js';
import { createMemoryBackendRouter } from './routes/memoryBackend.js';
import { createChatRouter } from './routes/chat.js';
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
import { createChatPeerAgentsProvider, createPeerGate } from './conductor/peerPolicy.js';
import { wireConductor, AwaitNotPendingError, AwaitResponderNotHolderError, ConductorRoleStore, ConductorEphemeralAttachmentsStore, ambientTurnFrom, createDiscussionsCapability } from './conductor/index.js';
import { createMissReportRoutes } from './privacy/missReportRoutes.js';
import { TURN_RECEIPT_STORE_SERVICE_NAME } from '@omadia/plugin-api';
import { TRANSCRIPTION_SERVICE_NAME } from '@omadia/plugin-api';
import type { TranscriptionService } from '@omadia/plugin-api';
import { PgTurnReceiptStore, startTurnReceiptReaper } from './receipts/store.js';
import { createReceiptRoutes } from './receipts/routes.js';
import { loadCheckpointSigner, startCheckpointWorker } from './receipts/checkpoints.js';
import { createProvenanceRoutes } from './receipts/verifyRoutes.js';
import { bindingKeyForTurn } from './conductor/principalId.js';
import { createOperatorChannelsRouter } from './routes/operatorChannels.js';
import { createOperatorMemoryContextsRouter } from './routes/operatorMemoryContexts.js';
import { createAgentBuilderRouter } from './routes/agentBuilder.js';
import {
  isMcpGrantBlocked,
  mcpDispatchDenial,
  refreshMcpGrantPolicy,
} from './services/mcpGrantPolicy.js';
import { rescanAllMcpServers } from './services/mcpRescan.js';
import { createLlmVerifier, type LlmVerifier } from './services/skillVerdictLlmVerifier.js';
import { HttpSkillSpectorScanner } from './services/pluginScanner.js';
import {
  createPluginScanScheduler,
  createPluginVerdictLookup,
  type PluginVerdictLookup,
} from './services/pluginVerdict.js';
import { ScheduleWorker } from './scheduler/scheduleWorker.js';
import type {
  ConfigStore as MultiOrchestratorConfigStore,
  OrchestratorRegistry as MultiOrchestratorRegistry,
} from '@omadia/orchestrator';
import { createMemoryRouter } from './routes/memory.js';
import { createDatasetsRouter } from './routes/datasets.js';
import { createBulkPromotionRouter } from './routes/bulkPromotion.js';
import { createSkillPromotionRouter } from './routes/skillPromotion.js';
import { PgSkillOwnershipLifecycleStore } from './services/skillLifecycleStore.js';
import { resolveSkillManifestSigningKey } from './services/skillManifestSigningKey.js';
import { createCredentialAskRouter } from './routes/credentialAsks.js';
import { InMemoryCredentialAskStore } from './credentials/asks.js';
import { PostgresCredentialAskStore } from './credentials/postgresCredentialAskStore.js';
import { resolveCredentialMasterKey } from './credentials/crypto.js';
import { createCredentialStore } from './credentials/credentialStoreFactory.js';
import { createInconsistenciesRouter } from './routes/inconsistencies.js';
import { createDuplicatesRouter } from './routes/duplicates.js';
import { createTopicsRouter } from './routes/topics.js';
import { createUsageRouter } from './routes/usage.js';
import { createAgentResolver } from './agents/resolveAgentForTool.js';
import { scopeDomainToolsToPlugins } from './agents/scopeDomainTools.js';
import {
  mergeDomainTools,
  reconcileDomainToolAcrossAgents,
} from './agents/runtimeToolPropagation.js';
// `/attachments/<signed-key>` is now mounted by the de.byte5.channel.teams
// plugin via ctx.routes.register (see packages/harness-channel-teams/src/plugin.ts,
// phase-3.1-4). No kernel-side attachment router import needed anymore.
import { createChatSessionsRouter } from './routes/chatSessions.js';
import {
  DEV_GRAPH_PATH,
  KG_LIFECYCLE_ADMIN_PATH,
  KG_PRIORITIES_ADMIN_PATH,
  PLUGIN_DOMAINS_ADMIN_PATH,
  mountDevGraph,
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
import { createAdminRegistriesRouter } from './routes/adminRegistries.js';
import { RegistryClient } from './plugins/registryClient.js';
import {
  VaultBackedRegistryConfigStore,
  InMemoryRegistrySettings,
  seedRegistriesIfEmpty,
  type RegistrySettingsKV,
} from './plugins/registryConfigStore.js';
import { createProfilesRouter } from './routes/profiles.js';
import { createPackagesRouter } from './routes/packages.js';
import { createRegistryInstallRouter } from './routes/registryInstall.js';
import { createRuntimeRouter } from './routes/runtime.js';
import { createAdminSettingsRouter } from './routes/adminSettings.js';
import { createAdminProvidersRouter } from './routes/adminProviders.js';
import { createAdminEmbeddingProviderRouter } from './routes/adminEmbeddingProvider.js';
import { createAdminTranscriptionProviderRouter } from './routes/adminTranscriptionProvider.js';
import { createAdminCliBackendsRouter } from './routes/adminCliBackends.js';
import { setCliLoginAuthorizedHook } from './platform/cliAuthService.js';
import { autoAssignSubscriptionCli } from './platform/providerAssignment.js';
import { registerClaudeCliAdapter } from './platform/claudeCliAdapter.js';
import {
  memoizeRuntimeReadinessCause,
  resolvePluginLlmReadiness,
  resolveRuntimeReadinessCause,
  type RuntimeReadinessCause,
} from './platform/pluginLlmReadiness.js';
import { createServiceRegistryBackedSqlGrantStore } from './platform/pluginSqlGrantStore.js';
import { createVaultStatusRouter } from './routes/vaultStatus.js';
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
import { PreviewChatService } from './plugins/builder/previewChatService.js';
import {
  BuilderAgent,
  type BuilderProviderResolver,
} from './plugins/builder/builderAgent.js';
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
import { redactAuditError } from './services/secretRedaction.js';
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
import { createRequireAuth } from './auth/requireAuth.js';
import { createOperatorAuthAccessor } from './auth/operatorAuthAccessor.js';
import {
  createConductorWebhooksInboundRouter,
  type ConductorWebhookInboundDeps,
} from './routes/conductorWebhooksInbound.js';
import { WEBHOOK_POST_ACTION_ID, invokeWebhookPostAction } from './conductor/webhookPostAction.js';
import { OAuthClient } from './auth/oauthClient.js';
import { RefreshStore } from './auth/refreshStore.js';
import { EmailWhitelist } from './auth/whitelist.js';
import { resolveSessionSigningKey } from './auth/sessionSigningKey.js';
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
import {
  ProviderCatalog,
  ProviderRegistry,
  parseAuthProvidersEnv,
  resolveActiveProviderIds,
} from './auth/providerRegistry.js';
import { LocalPasswordProvider } from './auth/providers/LocalPasswordProvider.js';
import {
  ENTRA_PROVIDER_ID,
  EntraProvider,
} from './auth/providers/EntraProvider.js';
import { runAuthBootstrap } from './auth/bootstrap.js';
import { AdminAuditLog, roleChangeAuditEntry } from './auth/adminAuditLog.js';
import {
  PlatformSettingsStore,
  SETTING_AUTH_ACTIVE_PROVIDERS,
} from './auth/platformSettings.js';
import { createAdminUsersRouter } from './routes/adminUsers.js';
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
import { DynamicAgentRuntime } from './plugins/dynamicAgentRuntime.js';
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
import { warmPatternWorker } from './plugins/setupFieldPattern.js';
import { BuiltInPackageStore } from './plugins/builtInPackageStore.js';
import { LocalDevPackageStore } from './plugins/localDevPackageStore.js';
import { FileSecretVault, resolveMasterKey } from './secrets/fileVault.js';
import { VaultBackupService } from './secrets/vaultBackup.js';
import { createAnthropicLlmProvider } from './platform/anthropicLlmProvider.js';
import {
  registerPluginLlmProvider,
  unregisterPluginLlmProvider,
} from './platform/llmProviderManifest.js';
import { registerBuiltinLlmProviders } from './platform/builtinLlmProviders.js';
import { BackgroundJobRegistry } from './platform/backgroundJobRegistry.js';
import { ChatAgentWrapRegistry } from './platform/chatAgentWrapRegistry.js';
import { PromptContributionRegistry } from './platform/promptContributionRegistry.js';
import { installProcessGuards } from './platform/processGuards.js';
import { PluginRouteRegistry } from './platform/pluginRouteRegistry.js';
import { PublicPathGrantRegistry } from './platform/publicPathGrants.js';
import { createLazyPublicPathGrantStore } from './platform/publicPathGrantStore.js';
import { createPluginRawBodyMount } from './platform/pluginRawBodyMount.js';
import { createPublicPathMount } from './platform/publicPathMount.js';
import { NotificationRouter } from './platform/notificationRouter.js';
import { PluginStatusRegistry } from './platform/pluginStatusRegistry.js';
import { OAuthReadinessTracker } from './plugins/oauth/oauthReadinessTracker.js';
import { UiRouteCatalog } from './platform/uiRouteCatalog.js';
import { createUiNavigationRouter } from './routes/uiNavigation.js';
import { CanvasOutputRegistry } from './platform/canvasOutputRegistry.js';
import { EventCatalogRegistry } from './platform/eventCatalogRegistry.js';
import { DeterministicActionRegistry } from './platform/deterministicActionRegistry.js';
import { ServiceRegistry } from './platform/serviceRegistry.js';
import {
  createLateBoundAttachmentBindingStore,
  createLateBoundGrantStore,
} from './audience/lateBoundGrantStore.js';
import { PostgresAttachmentBindingStore } from './audience/postgresAttachmentBindingStore.js';
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
  initRoutines,
  routineTurnContext,
  type RoutinesHandle,
} from './plugins/routines/index.js';
import { ROUTINES_INTEGRATION_SERVICE_NAME } from '@omadia/plugin-api';
import { createRoutinesRouter } from './routes/routines.js';
import { createUiPrefsRouter } from './routes/uiPrefs.js';
import { ExpressRouteRegistry } from './channels/routeRegistry.js';
import { WebSocketRegistry } from './channels/webSocketRegistry.js';
import { createCoreApi } from './channels/coreApi.js';
import { ChannelDirectoryRegistry } from './channels/channelDirectoryRegistry.js';
import { ConversationRosterRegistry } from './channels/rosterRegistry.js';
import { ConversationEventHub } from './channels/conversationEventHub.js';
import { TargetedSendRegistry } from './channels/targetedSendRegistry.js';
import { createTargetedDeliveryService } from './channels/targetedDeliveryService.js';
import { ConversationSendRegistry } from './channels/conversationSendRegistry.js';
import { createConversationSendService } from './channels/conversationSendService.js';
import { ObservedConversationInvites } from './platform/observedConversationInvites.js';
import { PgObservedInvitePersistence } from './platform/observedInvitePersistence.js';
import { createAgentSetupServices } from './platform/agentSetupService.js';
import { createScopedRoleAssignments } from './conductor/scopedRoleAssignments.js';
import { DefaultChannelRegistry } from './channels/channelRegistry.js';
import type { AggregateHolderLookup, ChannelRegistry, ChannelBindingResolver } from '@omadia/channel-sdk';
import { DynamicChannelPluginResolver } from './channels/dynamicChannelResolver.js';
import type { TurnDispatcher } from './channels/coreApi.js';
import { createOrchestratorDispatcher } from './channels/orchestratorDispatcher.js';
import { deriveChannelType } from './channels/channelType.js';
import type { FactExtractor } from '@omadia/orchestrator-extras';
import { backfillGraph } from '@omadia/orchestrator-extras';
import { turnContext } from '@omadia/orchestrator';
import type {
  EmbeddingClient,
  EntityRefBus,
  KnowledgeGraph,
} from '@omadia/plugin-api';
import type { Pool } from 'pg';
import type {
  ChatAgent,
  ChatAgentBundle,
  ChatSessionStore,
  DomainTool,
} from '@omadia/orchestrator';

// Phase 5B: structural shims for kernel-side reads of plugin-published
// services. These replace direct type-imports from the 5 byte5-internal
// plugins (`@omadia/integration-confluence`, `@omadia/integration-odoo`,
// `@omadia/integration-microsoft365`, `@omadia/channel-teams`,
// `@omadia/channel-telegram`) which are removed in this commit. The
// kernel only ever reads the small subset of fields below; full plugin
// types stay inside the plugins.
interface Microsoft365AccessorShim {
  readonly app: unknown;
}

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
  const pluginRouteRegistry = new PluginRouteRegistry({
    sessionAuth: () => kernelRequireAuthRef.current,
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
  const targetedSendRegistry = new TargetedSendRegistry(registryLog);
  const conversationSendRegistry = new ConversationSendRegistry(registryLog);
  const conversationEventHub = new ConversationEventHub(registryLog);
  // #330 C2a — kernel-side invite index: subscribes directly at the hub (before
  // any plugin) and is the scope guard for plugin auto-binds. A plugin can only
  // bind conversations the transport actually reported a group bot_added for.
  const observedInvites = new ObservedConversationInvites({ log: (m) => console.log(`[middleware] ${m}`) });
  observedInvites.attach(conversationEventHub);
  serviceRegistry.provide('conversationRosters', conversationRosterRegistry);
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
  // method"): on installs where the key arrives via the Setup Wizard (vault)
  // and not via ENV, the boot-time `client` above is unauthenticated forever —
  // `refreshSharedAnthropicClientFromVault` only swaps the REGISTRY providers,
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

  const domainTools: DomainTool[] = [];

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

  const secretVault = new FileSecretVault(VAULT_PATH, masterKey.key);
  await secretVault.load();

  // Session signing key lives in the vault (`core:auth` scope). First boot
  // generates; every subsequent boot reuses the same key so outstanding
  // cookies stay valid across deploys. Resolved here (before the plugin
  // runtimes are constructed) because it doubles as the key the `ctx.flows`
  // toolkit signs plugin-flow state with (spec 004 FR-B3).
  const sessionSigningKey = await resolveSessionSigningKey(secretVault);
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
    console.log('[middleware] ⚠ credential-keychain master key loaded from dev file — set CREDENTIAL_KEYCHAIN_KEY for production');
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
  const operatorAuth = createOperatorAuthAccessor({
    signingKey: sessionSigningKey,
    whitelist: emailWhitelist,
  });

  const installedRegistry = new FileInstalledRegistry(
    INSTALLED_REGISTRY_PATH,
  );
  await installedRegistry.load();

  // Register/unregister a plugin's `llm_provider` block into the catalog (which
  // also overlays its models into the model-registry the admin Providers page
  // reads). Thin wrappers over the shared platform helpers — they add the
  // config-scope lookup, logging, and never-fatal error handling. Used by BOTH
  // the boot loop AND the hot-install path (InstallService.onInstalled/
  // onUninstall) so a provider plugin installed at runtime appears WITHOUT a
  // restart.
  const registerProviderFromPlugin = (pluginId: string): void => {
    try {
      const descriptor = registerPluginLlmProvider(
        pluginCatalog.get(pluginId)?.manifest,
        installedRegistry.get(pluginId)?.config,
        llmProviderCatalog,
      );
      if (descriptor !== undefined) {
        console.log(
          `[middleware] llm provider '${descriptor.id}' registered from ${pluginId} (${String(descriptor.models.length)} model(s), baseURL ${descriptor.baseURL})`,
        );
      }
    } catch (err) {
      console.warn(
        `[middleware] skipped llm_provider block in ${pluginId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  };
  const unregisterProviderFromPlugin = (pluginId: string): void => {
    try {
      const id = unregisterPluginLlmProvider(
        pluginCatalog.get(pluginId)?.manifest,
        llmProviderCatalog,
      );
      if (id !== undefined) {
        console.log(
          `[middleware] llm provider '${id}' unregistered (plugin ${pluginId} uninstalled)`,
        );
      }
    } catch {
      // malformed block never registered — nothing to clean up
    }
  };

  // Populate the LLM provider catalog from INSTALLED plugins at boot. Done
  // BEFORE `toolPluginRuntime.activateAllInstalled()` so the orchestrator
  // resolves a plugin-contributed provider at its own activate().
  for (const entry of pluginCatalog.list()) {
    if (!installedRegistry.has(entry.plugin.id)) continue;
    registerProviderFromPlugin(entry.plugin.id);
  }

  // #575 — the audience floor's grant store. Published HERE, before
  // `activateAllInstalled()`, because the orchestrator plugin reads the
  // services it consumes at its own activate(); published as a LATE-BOUND
  // wrapper because the Postgres pool it needs is itself published by the
  // knowledge-graph plugin during that same activation pass and is only
  // readable afterwards. `audienceGrantStoreRef` is filled in below, where
  // `graphPool` resolves — the same forward-reference shape the conductor's
  // template registrar uses.
  //
  // Nothing is published when the flag is off, and that absence is what keeps
  // the three guards inert: the orchestrator installs an audience provider only
  // when it received a grant store, so an unconfigured deployment behaves
  // exactly as before ("not enforced ≠ closed").
  let audienceGrantStoreRef: PostgresGrantStore | undefined;
  let attachmentBindingStoreRef: PostgresAttachmentBindingStore | undefined;
  if (config.AUDIENCE_FLOOR_ENABLED) {
    serviceRegistry.provide(
      'audienceGrants',
      createLateBoundGrantStore(() => audienceGrantStoreRef),
    );
    // #575 — pins each attachment handle to the room that minted it. Same flag,
    // because it is the same policy: without the floor there is no notion of a
    // room to bind to, and enforcing one alone would refuse handles for a
    // deployment that never opted into audience control at all.
    serviceRegistry.provide(
      'attachmentBindings',
      createLateBoundAttachmentBindingStore(() => attachmentBindingStoreRef),
    );
    console.log(
      '[middleware] #575 audience floor ENABLED — grants read from Postgres; rooms are limited to what every participant is granted, and attachment handles only redeem in the room that minted them',
    );
  }

  // Phase B (B1) — publish `pluginCapabilities@1` so the orchestrator's
  // first-boot onboarding (`ensureFallbackAgent`) can hydrate the fallback
  // Agent with every installed plugin, and so the registry's snapshot
  // validation has manifest metadata (multi_instance / installed /
  // memory-scope) to reject impossible configurations.
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
    listInstalled(): readonly string[] {
      // Include `active` AND `inactive` plugins (the latter may simply
      // not have activated yet on this boot). Drop `errored` only —
      // validateSnapshot would reject those, and the operator should fix
      // the underlying manifest before the platform re-attaches them.
      return installedRegistry
        .list()
        .filter((entry) => entry.status !== 'errored')
        .map((entry) => entry.id);
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

  // Kernel-wide background-job scheduler. Plugin-contributed jobs (cron or
  // interval) register here via `ctx.jobs.register(...)`. Bulk teardown on
  // plugin deactivate is owned by each runtime, so a leaked dispose handle
  // still cannot outlive its plugin's lifecycle.
  const jobScheduler = new JobScheduler({
    log: (msg) => console.log(msg),
  });

  // #1033 W1 — the kernel's own provider pool: same credentials source as the
  // orchestrator plugin (the vault scope `@omadia/orchestrator`), same
  // catalog, memoised per provider id. Consumed by the dynamic sub-agent
  // runtime today; the model-policy validation (W2) reads `usable()` from it.
  const kernelProviderPool = createLlmProviderPool({
    getSecret: (k) => secretVault.get('@omadia/orchestrator', k),
    catalog: llmProviderCatalog,
  });

  // Dynamic runtime for uploaded packages — wired up with the orchestrator
  // further below, once it exists. The install/uninstall service hooks in
  // so tools are hot-registered and torn down (without middleware restart).
  const dynamicAgentRuntime = new DynamicAgentRuntime({
    catalog: pluginCatalog,
    registry: installedRegistry,
    vault: secretVault,
    uploadedStore: uploadedPackageStore,
    builtInStore: builtInPackageStore,
    anthropic: client,
    subAgentModel: config.SUB_AGENT_MODEL,
    subAgentMaxTokens: config.SUB_AGENT_MAX_TOKENS,
    subAgentMaxIterations: config.SUB_AGENT_MAX_ITERATIONS,
    // Dynamic sub-agents inherit the orchestrator's configured provider so the
    // stack runs on any provider (incl. OpenAI-only, no Anthropic key). Both are
    // late-bound: a post-boot provider/key change is picked up on next build.
    hostProviderId: () => {
      const raw = installedRegistry.get('@omadia/orchestrator')?.config?.[
        'llm_provider'
      ];
      return typeof raw === 'string' && raw.trim().length > 0
        ? raw.trim()
        : 'anthropic';
    },
    hostGetSecret: (key: string) => secretVault.get('@omadia/orchestrator', key),
    providerPool: kernelProviderPool,
    serviceRegistry,
    nativeToolRegistry,
    pluginRouteRegistry,
    notificationRouter,
    uiRouteCatalog,
    jobScheduler,
    flowSigningKey: sessionSigningKey,
    flowPublicBaseUrl,
    pluginStatusRegistry,
    operatorAuth,
    oauthConnectionTracker,
    canvasOutputRegistry,
    eventCatalogRegistry,
    deterministicActionRegistry,
    log: (...a) => console.log(...a),
  });
  // agentToolInvoker — the kernel half of the deterministic-action fast-path.
  // Lets the ui-orchestrator run ONE agent-plugin tool by id directly (no
  // sub-agent model loop) when a canvas action names a deterministic tool.
  // Also exposes the optional streaming variant (`hasStream` + `invokeStream`)
  // for tools whose raw UploadedToolkit entry carries `runStream()`. This
  // deliberately does NOT add these tools to the main orchestrator's offered-
  // tool list, so agent isolation is preserved.
  serviceRegistry.provide('agentToolInvoker', {
    invoke: (toolId: string, input: unknown): Promise<string | undefined> =>
      dynamicAgentRuntime.invokeAgentTool(toolId, input),
    hasStream: (toolId: string): boolean =>
      dynamicAgentRuntime.hasStreamingTool(toolId),
    invokeStream: (toolId: string, input: unknown): AsyncGenerator<string> =>
      dynamicAgentRuntime.invokeAgentToolStream(toolId, input),
  });

  // Runtime for `kind: tool` / `kind: extension` plugins. These don't expose
  // a toolkit like agent plugins — their activate() registers directly into
  // the kernel's native-tool / route registries. Same package sources as
  // DynamicAgentRuntime; the two runtimes coordinate by kind-filtering.
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
    eventCatalogRegistry,
    // When an integration plugin activates — at boot OR via a live hot-
    // install — register every `manifest.service_types` entry into the
    // agent-builder's `serviceTypeRegistry`, and link its package into the
    // shared build template so generated agents that `external_reads`
    // against it typecheck. `lookupServiceType()` is read live by the
    // manifest-linter and codegen, so a newly-online platform becomes
    // buildable immediately, with no middleware restart.
    onActivated: async (entry, packagePath) => {
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

  // Forward refs — runtime propagation of a POST-BOOT agent-plugin
  // (de)activation into the per-Agent registry orchestrators + the fallback
  // Agent's enabled-plugin set. Assigned in the orchestrator-wiring block far
  // below (they need `registryForHydrate` + `currentDomainTools`). The install
  // hooks only fire at runtime, after assignment; when chat is disabled (no
  // orchestrator) they stay undefined and the `?.` calls no-op. Without this,
  // a plugin installed at runtime (operator install, Hub/registry install,
  // package re-upload, or self-extension) only reaches the single legacy
  // orchestrator — un-slugged chat routes to the fallback Agent, whose
  // per-Agent orchestrator never learned the new tool, so it behaves as if the
  // plugin were never activated.
   
  // --- Runtime plugin (de)activation propagation ------------------------
  // A plugin (de)activated AFTER boot (operator install, Hub/registry
  // install, package re-upload, self-extension) mutates only the standalone
  // `dynamicAgentRuntime` + the single legacy orchestrator. The per-Agent
  // registry orchestrators — which the chat router resolves for every turn,
  // falling back to the fallback Agent for un-slugged turns — are a boot
  // snapshot that the install path must reconcile.
  //
  // These closures are defined UNCONDITIONALLY here (not gated on the
  // boot-time `orchestrator` being present) and resolve `configStore` /
  // `orchestratorRegistry` LIVE from the serviceRegistry on every call.
  // Previously they were assigned inside the `if (orchestrator) { … }`
  // boot block, so on a chat-DISABLED boot (no ANTHROPIC_API_KEY at start —
  // the Setup-Wizard / Docker path) they stayed `undefined`. The
  // `onInstalled` hook's `propagatePluginInstall?.(agentId)` then silently
  // no-op'd: the agent activated in `dynamicAgentRuntime` but the fallback
  // Agent's `agent_plugins` enablement row was never written, so
  // `scopeDomainToolsToPlugins` withheld its `query_*` tool — at install
  // time AND on every later restart, because the missing DB row persists.
  // (Channels are unaffected: the channel install hook activates them
  // directly, with no plugin-scoping — which is why connectors appear on a
  // new session but specialist agents never did.) Resolving live here makes
  // the propagation take effect the moment chat goes live via the wizard.
  const ORCHESTRATOR_PLUGIN_ID = '@omadia/orchestrator';

  // Reconcile a single agent-plugin's DomainTool across every per-Agent
  // orchestrator: (re-)register a fresh handle where the plugin is enabled,
  // drop it where it is not. Idempotent and safe for re-uploads (the stale
  // handle is replaced). No-ops for non-agent plugins (no DomainTool); on
  // uninstall the runtime no longer knows the tool, so drop it by name.
  const reconcileRuntimeDomainTool = (
    pluginId: string,
    removedToolName?: string,
  ): void => {
    const reg =
      serviceRegistry.get<MultiOrchestratorRegistry>('orchestratorRegistry');
    if (!reg) return;
    const tool = dynamicAgentRuntime.domainToolFor(pluginId);
    reconcileDomainToolAcrossAgents(
      reg.list().map((entry) => ({
        slug: entry.agent.slug,
        enabled: entry.plugins.some(
          (p) => p.enabled && p.pluginId === pluginId,
        ),
        orchestrator: entry.built.orchestrator,
      })),
      {
        ...(tool ? { tool } : {}),
        ...(removedToolName ? { removedToolName } : {}),
        onError: (slug, err) =>
          console.error(
            `[middleware] reconcileRuntimeDomainTool(${pluginId}) on "${slug}" FAILED:`,
            err instanceof Error ? err.message : String(err),
          ),
      },
    );
  };

  const propagatePluginInstall = async (pluginId: string): Promise<void> => {
    if (pluginId === ORCHESTRATOR_PLUGIN_ID) return;
    const store =
      serviceRegistry.get<MultiOrchestratorConfigStore>('configStore');
    const reg =
      serviceRegistry.get<MultiOrchestratorRegistry>('orchestratorRegistry');
    if (!store || !reg) return; // no-DB / chat-disabled boot — nothing to wire
    try {
      const { fallbackAgentId } = await store.getPlatformSettings();
      if (fallbackAgentId) {
        // Keep the "fallback Agent has every installed plugin enabled"
        // invariant alive at runtime. Un-slugged chat routes to the
        // fallback Agent (getDefaultSlug → slugForFallback); without an
        // enabled `agent_plugins` row, `scopeDomainToolsToPlugins` would
        // withhold the new tool even after it is hydrated. First-boot does
        // this via `attachAllPlugins`; runtime installs never did.
        await store.upsertAgentPlugin(fallbackAgentId, {
          pluginId,
          enabled: true,
        });
        // Refresh `entry.plugins` from the DB so the scoping check below
        // sees the freshly-enabled row. Idempotent no-op when unchanged;
        // a plugin-only change is an `update` (no rebuild → sessions kept).
        await reg.reload();
      }
    } catch (err) {
      console.error(
        `[middleware] propagatePluginInstall(${pluginId}) enable/reload FAILED:`,
        err instanceof Error ? err.message : String(err),
      );
    }
    reconcileRuntimeDomainTool(pluginId);
    console.log(`[middleware] runtime plugin install propagated: ${pluginId}`);
  };

  const propagatePluginUninstall = async (
    pluginId: string,
    removedToolName?: string,
  ): Promise<void> => {
    if (pluginId === ORCHESTRATOR_PLUGIN_ID) return;
    const store =
      serviceRegistry.get<MultiOrchestratorConfigStore>('configStore');
    const reg =
      serviceRegistry.get<MultiOrchestratorRegistry>('orchestratorRegistry');
    if (!store || !reg) return;
    try {
      const { fallbackAgentId } = await store.getPlatformSettings();
      if (fallbackAgentId) {
        await store.removeAgentPlugin(fallbackAgentId, pluginId);
        await reg.reload();
      }
    } catch (err) {
      console.error(
        `[middleware] propagatePluginUninstall(${pluginId}) disable/reload FAILED:`,
        err instanceof Error ? err.message : String(err),
      );
    }
    reconcileRuntimeDomainTool(pluginId, removedToolName);
    console.log(
      `[middleware] runtime plugin uninstall propagated: ${pluginId}`,
    );
  };

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
    onInstalled: async (agentId) => {
      // A plugin may contribute an `llm_provider` block regardless of its kind
      // (provider plugins ship as `extension`). Register it FIRST — mirroring
      // the boot-time loop — so a runtime-installed provider lands in the
      // catalog + model registry and appears on the admin Providers page
      // without a restart. No-ops when the manifest declares no provider.
      registerProviderFromPlugin(agentId);
      // Dispatch by manifest.identity.kind. Without this, every uploaded
      // package — channels, integrations, tools — is fed to the agent
      // runtime, which crashes (channel: wrong handle shape; integration:
      // no toolkit). Built-ins return early from each runtime's activate()
      // when the agent isn't in their store, so the dispatch is safe.
      const kind = pluginCatalog.get(agentId)?.plugin.kind ?? 'agent';
      switch (kind) {
        case 'channel':
          if (!channelRegistryRef) {
            console.warn(
              `[install] channel '${agentId}' installed before channelRegistry was wired — activation will run at next boot`,
            );
            return;
          }
          await channelRegistryRef.activate(agentId);
          return;
        case 'tool':
        case 'extension':
        case 'integration':
          await toolPluginRuntime.activate(agentId);
          return;
        case 'agent':
        default:
          await dynamicAgentRuntime.activate(agentId);
          // Make the freshly-activated agent's tool reachable on the per-Agent
          // orchestrators (incl. the fallback Agent) without a restart.
          await propagatePluginInstall(agentId);
      }
    },
    onUninstall: async (agentId) => {
      // Symmetric to onInstalled: drop a contributed provider + its models so
      // an uninstalled provider plugin disappears from the admin Providers page
      // without a restart. Runs BEFORE runtime deactivation/registry removal.
      unregisterProviderFromPlugin(agentId);
      const kind = pluginCatalog.get(agentId)?.plugin.kind ?? 'agent';
      switch (kind) {
        case 'channel':
          if (channelRegistryRef?.isActive(agentId)) {
            await channelRegistryRef.deactivate(agentId);
          }
          return;
        case 'tool':
        case 'extension':
        case 'integration':
          await toolPluginRuntime.deactivate(agentId);
          return;
        case 'agent':
        default: {
          // Capture the tool name BEFORE deactivate drops it from the runtime —
          // the per-Agent orchestrators must be told which tool to unregister.
          const removedToolName =
            dynamicAgentRuntime.domainToolFor(agentId)?.name;
          await dynamicAgentRuntime.deactivate(agentId);
          await propagatePluginUninstall(agentId, removedToolName);
        }
      }
    },
  });
  console.log(
    `[middleware] plugin runtime wired (installed registry + secret vault, persistent) — ${installedRegistry.list().length} installed`,
  );

  // OB-61 fix — the shared `llm` + `anthropicClient` ServiceRegistry providers
  // are registered ONCE at boot (above) from `config.ANTHROPIC_API_KEY`. On a
  // cold boot without that env var the key is '' and those providers capture an
  // unauthenticated Anthropic client for the whole process lifetime. The /setup
  // wizard and the admin-secrets editor seed the real key into each consumer
  // plugin's vault and reactivate the plugin — but those plugins build their
  // OWN clients, so the SHARED providers stayed broken. Any plugin that reaches
  // the host LLM via `ctx.llm` (e.g. plan-runner's Haiku planning gate, which
  // swallows the resulting 401 and silently skips planning) then never worked
  // after a wizard key-entry.
  //
  // Fix: funnel every reactivation through `reactivateAgent`. When the
  // reactivated agent is the canonical host-key holder (@omadia/orchestrator),
  // re-read its freshly-seeded vault key and hot-swap the shared providers via
  // ServiceRegistry.replace(). Covers /setup, /admin/runtime/secrets, and any
  // future reactivate path. Idempotent: replacing with an equivalent client is
  // harmless when the key was already present via env. `ctx.llm` resolves the
  // 'llm' provider at call time, so already-active plugins pick up the swap on
  // their next call without re-activation.
  const ORCHESTRATOR_SECRET_SOURCE = '@omadia/orchestrator';
  // The key currently baked into the shared `llm`/`anthropicClient` providers.
  // Seeded with the boot-time ENV key (line ~288). Updated whenever we swap the
  // providers, so we only churn the Anthropic client when the key truly changes.
  let sharedAnthropicKeyApplied = config.ANTHROPIC_API_KEY ?? '';
  const refreshSharedAnthropicClientFromVault = async (
    sourceAgentId: string = ORCHESTRATOR_SECRET_SOURCE,
  ): Promise<void> => {
    try {
      const key = await readProviderApiKey(
        (k) => secretVault.get(sourceAgentId, k),
        'anthropic',
      );
      if (!key || key === sharedAnthropicKeyApplied) return;
      const refreshed = createAnthropicClient({ apiKey: key, maxRetries: 5 });
      serviceRegistry.replace('anthropicClient', refreshed);
      serviceRegistry.replace(
        'llm',
        createAnthropicLlmProvider({
          client: refreshed,
          log: (...args) => console.log('[llm]', ...args),
        }),
      );
      sharedAnthropicKeyApplied = key;
      console.log(
        `[middleware] shared llm/anthropicClient sourced from ${sourceAgentId} vault key — host-LLM plugins (plan-runner gate, LocalSubAgent inner calls, Teams) now armed`,
      );
    } catch (err) {
      console.error(
        '[middleware] failed to refresh shared anthropic client from vault:',
        err instanceof Error ? err.message : err,
      );
    }
  };
  const reactivateAgent = async (agentId: string): Promise<void> => {
    await installService.reactivate(agentId);
    // Live key-entry path (/setup wizard, /admin/runtime/secrets): the consumer
    // plugin's vault was just (re)seeded. Re-source the shared providers so any
    // plugin reaching the host LLM via `ctx.llm` picks up the real key without
    // a restart.
    if (agentId === ORCHESTRATOR_SECRET_SOURCE) {
      await refreshSharedAnthropicClientFromVault(agentId);
    }
  };

  // ── Vault off-site backup ─────────────────────────────────────────────────
  // Only starts when VAULT_BACKUP_ENABLED=true AND Tigris/MinIO credentials
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

  // ── Admin auth (A.1) ──────────────────────────────────────────────────────
  // `sessionSigningKey` (and `emailWhitelist`) are resolved earlier (right
  // after the vault loads) so the plugin runtimes can also use them —
  // `sessionSigningKey` for `ctx.flows` state signing, both together for
  // `ctx.operatorAuth` (issue #438 follow-up).
  if (emailWhitelist.isEmpty()) {
    console.warn(
      '[middleware] ⚠ ADMIN_ALLOWED_EMAILS is empty — every sign-in will 403 until the secret is set',
    );
  } else {
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
    console.warn(
      '[middleware] ⚠ admin OAuth disabled — MICROSOFT_APP_* missing. /api/v1/auth/* returns 503.',
    );
  } else {
    console.log(
      `[middleware] admin OAuth wired (redirect=${authRedirectUri})`,
    );
  }
  const requireAuth = createRequireAuth({
    signingKey: sessionSigningKey,
    whitelist: emailWhitelist,
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
  // Epic #470 C6 / G2 — hand the SAME instance to the plugin route registry.
  // Same instance, not an equivalent one: a plugin route registered with
  // `auth: 'session'` must agree with core, byte for byte, on what a valid
  // operator session is — including the `publicPaths` short-circuit above.
  // Two `createRequireAuth` calls with drifting options is exactly the class of
  // bug `auth/requireAuth.ts` extracted `evaluateSessionToken` to prevent.
  kernelRequireAuthRef.current = requireAuth;

  // ContextRetriever + FactExtractor construction moved to AFTER
  // `toolPluginRuntime.activateAllInstalled()` below — they consume
  // `knowledgeGraph` published by @omadia/knowledge-graph's activate()
  // (S+8 sub-commit 2b). Mirrors the post-activate consumption pattern used
  // by `memoryStore`, `microsoft365.graph`, `confluence.client`, etc.

  // --- Diagram rendering (Kroki + Tigris/MinIO) ------------------------------
  // Enabled when all four runtime deps are set in env. Missing any one? The
  // middleware stays up, the tool is simply not registered. No half-wired mode.
  // The render_diagram tool + /diagrams route are now contributed by the
  // @omadia/diagrams plugin (middleware/packages/harness-diagrams).
  // The kernel still needs a Tigris client for Teams-attachment serving —
  // that's a separate consumer of the same bucket. Clients with different
  // purposes; sharing the bucket means one set of AWS creds.
  let diagramStoreForRouter: ReturnType<typeof createTigrisStore> | undefined;
  const tigrisReady =
    Boolean(config.BUCKET_NAME) &&
    Boolean(config.AWS_ENDPOINT_URL_S3) &&
    Boolean(config.AWS_ACCESS_KEY_ID) &&
    Boolean(config.AWS_SECRET_ACCESS_KEY);
  if (tigrisReady) {
    diagramStoreForRouter = createTigrisStore({
      endpoint: config.AWS_ENDPOINT_URL_S3!,
      accessKeyId: config.AWS_ACCESS_KEY_ID!,
      secretAccessKey: config.AWS_SECRET_ACCESS_KEY!,
      bucket: config.BUCKET_NAME!,
    });
    // Phase 5B: publish so dynamic-imported channel plugins (Teams) can
    // late-resolve the attachment store via ctx.services.get('tigrisStore')
    // instead of constructor-injected Deps.
    serviceRegistry.provide('tigrisStore', diagramStoreForRouter);
    console.log(
      `[middleware] tigris attachment store ready (bucket=${config.BUCKET_NAME!})`,
    );
  } else {
    console.log(
      '[middleware] tigris attachment store DISABLED (BUCKET_NAME / AWS_* not fully set)',
    );
  }

  // enrich_company tool is now contributed by the Odoo integration plugin's
  // activate() via ctx.tools.register — construction moved in phase-2.2-iii.
  // The Orchestrator consumes the tool through NativeToolRegistry's generic
  // dispatch + promptDoc aggregation (same path as render_diagram).

  // S+10-4a: the five kernel-side native tools (chatParticipants /
  // askUserChoice / suggestFollowUps / findFreeSlots / bookMeeting) are
  // now constructed inside the @omadia/orchestrator plugin's
  // activate() — they're orchestrator-internal concerns, no kernel-side
  // consumer left them.
  const ms365IntegrationId = 'de.byte5.integration.microsoft365';
  const calendarAgentId = 'de.byte5.agent.calendar';

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
  // and the Microsoft365Accessor provided by de.byte5.integration.microsoft365).
  // Agents below consume these services through ctx, so the tool runtime
  // must run before the agent runtime.
  await toolPluginRuntime.activateAllInstalled();
  console.log(
    `[middleware] tool plugin runtime: ${toolPluginRuntime.activeIds().length} tool/extension/integration package(s) active`,
  );

  // OB-61 fix (boot path) — when the operator completed /setup in a PRIOR
  // session, the anthropic key lives in the orchestrator's VAULT, not in ENV.
  // On this boot the shared `llm`/`anthropicClient` providers were built from
  // the (empty) ENV key at line ~288, so host-LLM plugins (plan-runner's Haiku
  // gate, LocalSubAgent inner calls) would be broken until the next live
  // reactivate. Re-source them from the vault now. No-op when ENV already
  // carried the key (key === sharedAnthropicKeyApplied) or no key is stored.
  await refreshSharedAnthropicClientFromVault();

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
  const graphTenantId = process.env['GRAPH_TENANT_ID'] ?? 'default';

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
    if (!graphPool || !audienceGrantStore) {
      throw new Error(
        '[middleware] AUDIENCE_FLOOR_ENABLED=true requires Postgres (DATABASE_URL) — ' +
          'the in-memory backend has nowhere to store grants, and the floor fails closed, ' +
          'so booting like this would silently refuse every tool call in every room.',
      );
    }
    audienceGrantStoreRef = audienceGrantStore;
    attachmentBindingStoreRef = new PostgresAttachmentBindingStore(graphPool);
  }

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
    console.log(
      '[middleware] fact extractor DISABLED (orchestrator-extras plugin missing or anthropic_api_key not set)',
    );
  }

  // Calendar tools (find_free_slots + book_meeting) are constructed by the
  // @omadia/orchestrator plugin's activate() against the
  // microsoft365.graph capability. The kernel-side log lines below only
  // describe the wiring status of the integration + calendar agent — the
  // tools themselves live plugin-internal.
  if (installedRegistry.has(ms365IntegrationId)) {
    const microsoft365 = serviceRegistry.get<Microsoft365AccessorShim>(
      'microsoft365.graph',
    );
    if (microsoft365 && installedRegistry.has(calendarAgentId)) {
      console.log(
        '[middleware] sub-agent calendar ready (find_free_slots + book_meeting wired plugin-side, credentials=vault)',
      );
    } else if (microsoft365) {
      console.log(
        '[middleware] sub-agent calendar DISABLED (de.byte5.agent.calendar not installed — integration ready but tools not wired)',
      );
    } else {
      console.log(
        '[middleware] microsoft365 integration installed but accessor not in service registry — activate() failed? calendar tools DISABLED',
      );
    }
  } else {
    console.log(
      '[middleware] microsoft365 integration DISABLED (de.byte5.integration.microsoft365 not installed — set MICROSOFT_APP_* in .env for auto-bootstrap, or install via /store)',
    );
  }

  // Phase 5B M3+M4 catch-up: the byte5-customer Odoo + Confluence sub-agent
  // wiring lived here as inline kernel code that consumed the integration
  // plugins' published services and built LocalSubAgent + DomainTool by
  // hand. It now lives in three plugin packages (@omadia/agent-odoo-
  // accounting, @omadia/agent-odoo-hr, @omadia/agent-confluence) which the
  // dynamic-agent-runtime activates via the standard manifest path. The
  // kernel no longer needs to know any byte5-specific agent ids.

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
      const backfill = await backfillGraph(memoryStore, knowledgeGraph);
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
  // Dynamic agent activation: uploaded packages already marked `active` in
  // the registry are now actually started. `activate()` imports
  // `dist/plugin.js`, calls `activate(ctx)` and builds the LocalSubAgent
  // wrapper. Per-agent errors are logged but do not abort boot — a broken
  // package must not block the whole middleware.
  const dynamicDomainTools = await dynamicAgentRuntime.activateAllInstalled();
  for (const t of dynamicDomainTools) domainTools.push(t);
  console.log(
    `[middleware] dynamic agent runtime: ${dynamicAgentRuntime.activeIds().length} uploaded agent(s) active`,
  );

  // S+10-4a: capability-flip — the @omadia/orchestrator plugin's
  // activate() owns Orchestrator + 5 native-tools + ChatSessionStore +
  // SessionLogger + (optional) VerifierService construction and publishes
  // the bundle as `chatAgent@1`. Kernel late-resolves it here.
  //
  // Without `anthropic_api_key` set in the orchestrator-plugin's setup,
  // the plugin returns a no-op handle and chatAgent@1 is NOT published —
  // boot fails fast with a clear error so the operator wires up the key.
  // Graceful degradation: chatAgent@1 is published by @omadia/orchestrator
  // only once `anthropic_api_key` is set. That key is entered post-boot via
  // the Setup Wizard, so a missing key must NOT fail the boot — otherwise the
  // very admin UI that captures the key never comes up. We boot
  // "chat-disabled": the admin UI, Setup Wizard and every non-chat endpoint
  // run; the chat route returns 503 until the key is configured. Saving the
  // key via the wizard reactivates the orchestrator plugin (PATCH
  // /installed/:id/secrets → reactivate → activate()), which publishes
  // chatAgent@1 + orchestratorRegistry@1. The chat / session / operator
  // routes below resolve those services LIVE from the registry per request,
  // so chat goes live the moment the key is saved — no restart needed.
  //
  // The boot-only wiring guarded on `orchestrator` below (domain-tool
  // hydration of per-Agent orchestrators) re-applies on the next restart for
  // advanced stacks (sub-agents). The default out-of-the-box stack has no
  // domain tools, so chat is fully functional hot. Routines follows the same
  // live-resolution pattern as chat (issue #473): its runner resolves
  // chatAgent per run, so it hot-enables on key save too.
  const chatAgentBundle = serviceRegistry.get<ChatAgentBundle>('chatAgent');
  const orchestrator = chatAgentBundle?.raw;
  if (!chatAgentBundle) {
    console.warn(
      '[middleware] ⚠ chat DISABLED — chatAgent@1 not published. Set ANTHROPIC_API_KEY on @omadia/orchestrator via the Setup Wizard; chat goes live on save. Admin UI + all other endpoints are up.',
    );
  }
  // Live resolver for the plugin-published chat bundle. Every chat/session
  // consumer reads through this so a post-boot reactivation (Setup Wizard key
  // entry) is picked up without a restart.
  const getChatAgentBundle = (): ChatAgentBundle | undefined =>
    serviceRegistry.get<ChatAgentBundle>('chatAgent');
  const getChatSessionStore = (): ChatSessionStore | undefined =>
    getChatAgentBundle()?.chatSessionStore;
  // sessionLogger is exposed on the bundle for future channel/route
  // consumers but no longer threaded through the kernel — graphBackfill
  // doesn't need it (uses memoryStore + KG directly), and the chat-API
  // route resolves the orchestrator live from the registry.
  if (orchestrator) {
    // Push all kernel-collected DomainTools (native sub-agents + uploaded
    // dynamic agents) into the plugin-built Orchestrator. Plugin construction
    // happens BEFORE these are accumulated, so the registerDomainTool calls
    // here finish the wiring.
    for (const t of domainTools) orchestrator.registerDomainTool(t);
    // Hot-register pathway for future agent installs while the process runs.
    dynamicAgentRuntime.attachOrchestrator(orchestrator);

    // Phase B fix — the multi-orchestrator registry built one Orchestrator per
    // Agent earlier in boot (inside the orchestrator plugin's activate, during
    // `toolPluginRuntime.activateAllInstalled`). At that point `domainTools`
    // was still empty, so every per-Agent orchestrator started with
    // `domainTools: []` — chat hitting the fallback Agent could not see
    // `query_odoo_accounting`, `query_confluence`, etc. Push the populated
    // list into every registry-built Orchestrator now. Skip duplicates so a
    // hot-installed tool that already self-registered does not throw.
    const registryForHydrate =
      serviceRegistry.get<MultiOrchestratorRegistry>('orchestratorRegistry');
    if (registryForHydrate) {
      // Per-Agent tool isolation. A domain tool's `agentId` is the id of the
      // agent-plugin that exposes it (set by `createDomainTool` /
      // `dynamicAgentRuntime`), e.g. `query_odoo_accounting` →
      // `de.byte5.agent.odoo-accounting`. An Agent may only reach a sub-agent
      // query tool when that backing plugin is ENABLED on it; a tool with no
      // `agentId` is a core helper available to everyone. The fallback Agent
      // has every plugin enabled, so it still receives the full set
      // (preserving the original Phase-B hydration intent) — but a scoped
      // Agent (e.g. "marketing", which only enables the X plugin) no longer
      // inherits `query_odoo_accounting` et al. it was never granted.
      // See `scopeDomainToolsToPlugins` for the rule.
      //
      // LIVE tool source. The boot-time `domainTools[]` is frozen at process
      // start, so an agent-plugin installed/activated AFTER boot (its tool
      // lives only in `dynamicAgentRuntime`) would never reach a per-Agent
      // orchestrator on a later rebuild. Merge the boot set with the runtime's
      // currently-active domain tools, de-duped by name (boot built-ins are
      // already in `domainTools` and win on clash).
      const currentDomainTools = (): DomainTool[] =>
        mergeDomainTools(domainTools, dynamicAgentRuntime.activeDomainTools());

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
                  // discovery keeps this cheap per call).
                  const desc = await mcpOAuthService.describeAuth(server);
                  if (!desc.protected) return null;
                  // Machine block the chat parses into an in-line "Connect" card
                  // + modal (web-ui McpAuthRequiredCard). Mirrors the <nudge>
                  // block contract: human text stays readable for the model and
                  // the raw <pre>; the block is stripped from the UI output.
                  const authBlock = (needsClient: boolean): string =>
                    `\n<mcp-auth-required serverId="${xmlAttr(server.id)}" server="${xmlAttr(server.name)}"${desc.issuerHost ? ` host="${xmlAttr(desc.issuerHost)}"` : ''} needsClient="${needsClient ? 'true' : 'false'}"></mcp-auth-required>`;
                  try {
                    const { authorizeUrl } = await mcpOAuthService.beginAuthorization(server, userKey);
                    return `🔒 The MCP server "${server.name}" needs authorization before it can be used. Ask the user to click Connect (this opens the provider's login), then retry: ${authorizeUrl}${authBlock(false)}`;
                  } catch {
                    // Delegating server with no registered client yet — point
                    // the user at the one-time setup instead of a raw error.
                    return `🔒 The MCP server "${server.name}" needs authorization, but it isn't set up yet. Click Connect to register it${desc.issuerHost ? ` — it delegates OAuth to ${desc.issuerHost}, which needs a one-time app registration` : ''}.${authBlock(true)}`;
                  }
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
      const SUBAGENT_DEFAULT_MODEL = 'claude-sonnet-4-6';
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
        slug: string,
        built: { orchestrator: { hasDomainTool(n: string): boolean; registerDomainTool(t: DomainTool): void } },
      ): number => {
        const entry = registryForHydrate.get(slug);
        if (!entry) return 0;
        const snapshot = registryForHydrate.currentSnapshot();
        const mcpServers = snapshot?.mcpServers ?? [];
        // Persona skills + operator bindings for skill capability contracts
        // (issue #456) — resolved from the same snapshot the registry built
        // this agent from, so tool surface and signature stay consistent.
        const skillsById = new Map((snapshot?.skills ?? []).map((s) => [s.id, s]));
        const personaSkills = (snapshot?.personaSkillLinks ?? [])
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
            client,
            nativeToolRegistry,
            mcpManager,
            mcpServers,
            personaSkills,
            skillToolBindings: snapshot?.skillToolBindings ?? [],
            defaultModel: SUBAGENT_DEFAULT_MODEL,
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
            log: (m: string) => console.log(`[middleware] ${m}`),
          },
        );
      };

      let attached = 0;
      for (const entry of registryForHydrate.list()) {
        // WHAT THIS AGENT ACTUALLY ENDED UP WITH, by name and by owner.
        //
        // The count alone was not enough to answer the question that matters
        // — "why can this agent reach that connector?" — because it cannot
        // distinguish a tool that was granted from one that passed the filter
        // for lack of an owner id (`agentId === undefined` is waved through by
        // design, as a core helper). An agent with no grants reaching a
        // plugin's tool is indistinguishable from correct behaviour in a
        // number.
        const scoped = scopeDomainToolsToPlugins(
          currentDomainTools(),
          entry.plugins,
        );
        console.log(
          `[middleware] registry: tool surface for "${entry.agent.slug}": ` +
            (scoped.length === 0
              ? '(none)'
              : scoped
                  .map((t) => `${t.name}←${t.agentId ?? 'UNOWNED'}`)
                  .join(', ')),
        );
        for (const t of scoped) {
          if (!entry.built.orchestrator.hasDomainTool(t.name)) {
            entry.built.orchestrator.registerDomainTool(t);
            attached += 1;
          }
        }
        attached += hydrateSubAgentTools(entry.agent.slug, entry.built);
      }
      console.log(
        `[middleware] registry orchestrators: hydrated with ${String(attached)} domain-tool registrations across ${String(registryForHydrate.list().length)} agent(s) (per-Agent plugin-scoped)`,
      );
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
      // Persist the wiring so a later `registry.reload()` that REBUILDS an
      // Agent (privacy_profile flip, etc.) re-hydrates the new orchestrator —
      // still scoped to the Agent's enabled plugins, and now from the LIVE tool
      // source so a runtime-installed agent's tool survives the rebuild. The
      // entry is in the registry map before `onAgentBuilt` fires (both the
      // `add` and `rebuild` actions set it first), so the plugin lookup is
      // available here. Without this, the rebuilt Agent goes back to
      // `domainTools: []` and the operator's next chat turn cannot reach its
      // sub-agents.
      registryForHydrate.setOnAgentBuilt((slug, built) => {
        const entry = registryForHydrate.get(slug);
        const tools = entry
          ? scopeDomainToolsToPlugins(currentDomainTools(), entry.plugins)
          : [];
        for (const t of tools) {
          if (!built.orchestrator.hasDomainTool(t.name)) {
            built.orchestrator.registerDomainTool(t);
          }
        }
        const subTools = hydrateSubAgentTools(slug, built);
        // Same by-name surface as the initial hydrate above — a rebuild is
        // exactly when a tool can appear that the operator did not grant, so
        // the rebuild path must be as readable as the boot path.
        console.log(
          `[middleware] registry: orchestrator for "${slug}" hydrated with ${String(tools.length)} domain-tool(s) + ${String(subTools)} sub-agent tool(s) (per-Agent plugin-scoped): ` +
            (tools.length === 0
              ? '(none)'
              : tools.map((t) => `${t.name}←${t.agentId ?? 'UNOWNED'}`).join(', ')),
        );
      });

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
            .then(() => registryForHydrate.reload())
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
  }

  console.log('[middleware] context retriever ready (tail + entity-anchor + FTS)');

  // Routines feature (OB-NEW): persistent user-created scheduled agent
  // invocations. Requires Postgres for persistence; skipped in zero-config
  // dev (in-memory KG backend, no DATABASE_URL). The chat agent is NOT
  // required at wiring time — the runner resolves chatAgent@1 live per run
  // (same pattern as the chat routes above), so routines hot-enable the
  // moment the Setup Wizard key save publishes it; keyless fires record an
  // `error` run naming the missing key (issue #473). Channel adapters that
  // want proactive delivery register their `ProactiveSender` into
  // `routinesHandle.senderRegistry` after this call (Teams: wrap a
  // long-lived `CloudAdapter.continueConversationAsync` via
  // `createProactiveSender('teams', sendFn)`). Channel adapters MUST also
  // wrap their inbound turn with `routineTurnContext.run/enter({tenant,
  // userId, channel, conversationRef}, …)` — without it, the
  // `manage_routine` tool's `create`/`list` actions return a
  // model-friendly error string and the model degrades gracefully.
  let routinesHandle: RoutinesHandle | undefined;
  if (graphPool) {
    routinesHandle = await initRoutines({
      pool: graphPool,
      scheduler: jobScheduler,
      getOrchestrator: () => getChatAgentBundle()?.raw,
      registerNativeTool: (name, handler, options) =>
        nativeToolRegistry.register(name, {
          handler,
          spec: options.spec,
          ...(options.promptDoc !== undefined
            ? { promptDoc: options.promptDoc }
            : {}),
        }),
      log: (msg) => console.log(msg),
    });
    // Phase 5B: publish the channel-facing surface so dynamic-imported
    // channel plugins can late-resolve all routines callbacks (capture-
    // turn, proactive-send registration, action handler, smart-card
    // builders) without constructor-injected Deps.
    serviceRegistry.provide(
      ROUTINES_INTEGRATION_SERVICE_NAME,
      createRoutinesIntegration(routinesHandle, (info) => {
        // US5: persist a Conductor channel binding per inbound turn so awaits can be reminded.
        // Lazy-resolve the store (Conductor wires later in boot); fire-and-forget — a turn must
        // never be blocked or broken by it.
        const bindings = serviceRegistry.get<{ upsert(u: string, c: string, r: unknown): Promise<void> }>(
          'conductorChannelBindings',
        );
        // Key the binding by the operator-addressable principalRef (Teams: the user's email) when the
        // channel supplied one, so it matches a human-step principal / role holder; otherwise fall back
        // to the channel-native userId (e.g. AAD object id). The store canonicalizes the key on write.
        if (bindings) {
          void bindings
            .upsert(bindingKeyForTurn(info), String(info.channel), info.conversationRef)
            .catch(() => undefined);
        }
      }),
    );
    console.log(
      '[middleware] routines feature ready (manage_routine tool registered, routinesIntegration published, chat agent resolved live per run)',
    );
  } else {
    console.log(
      '[middleware] routines feature SKIPPED — no graphPool (in-memory KG backend; set DATABASE_URL to enable)',
    );
  }

  const app = express();
  app.set('trust proxy', true);
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
  console.log('[middleware] conductor webhook inbound router mounted at /api/hooks/:endpointId (raw-body, before express.json)');

  // `verify` records the RAW byte count (see `http/rawBodySize.ts`). Route-level
  // size gates downstream can only measure `JSON.stringify(req.body)`, which is
  // a different number: 9 MB of insignificant whitespace re-serialises to a
  // handful of bytes and walks through a cap written against it.
  app.use(express.json({ limit: '10mb', verify: recordRawBodyBytes }));
  app.use(cookieParser());

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
      // #432 — the build stamp (`unknown` when the image was built without
      // one). Load-bearing beyond display: the updater sidecar's health gate
      // polls THIS field to decide whether the new image is actually serving,
      // and rolls the stack back when the requested version never appears.
      // Non-sensitive: a release tag that is public on GitHub anyway.
      res
        .status(kg.pool === 'dead' ? 503 : 200)
        .json({ status, version: appVersion.version, kg, disclosure });
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
          // `encrypted` lives on tls.TLSSocket, not the base net.Socket type.
          encrypted: Boolean(
            (req.socket as { encrypted?: boolean } | undefined)?.encrypted,
          ),
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

  const agentResolver = createAgentResolver({ dynamicRuntime: dynamicAgentRuntime });
  // Phase A — Chat router resolves per-Agent via the registry. Falls
  // back to the legacy default `chatAgent@1` for two cases:
  //   1. Boot with no registry (no DATABASE_URL) — only the default
  //      bundle exists, gets reachable via slug "default".
  //   2. Registry has Agents but the requested slug is "default" —
  //      same shortcut for back-compat.
  // Otherwise the slug must map to a registered Agent (registry.get).
  // Resolve orchestratorRegistry@1 + chatAgent@1 LIVE per request. Both are
  // published by the orchestrator plugin's activate(); after a Setup-Wizard
  // key entry the plugin reactivates and (re)publishes them, so capturing a
  // boot-time value would pin the chat-disabled state forever.
  const getRegistry = (): MultiOrchestratorRegistry | undefined =>
    serviceRegistry.get<MultiOrchestratorRegistry>('orchestratorRegistry');
  const resolveChatAgent = (slug: string): ChatAgent | undefined => {
    const entry = getRegistry()?.get(slug);
    if (entry) return entry.built.bundle.agent;
    if (slug === 'default') return getChatAgentBundle()?.agent;
    return undefined;
  };
  const getDefaultSlug = (): string | undefined => {
    const reg = getRegistry();
    const fallback = reg?.slugForFallback();
    if (fallback) return fallback;
    // Pre-Phase-A / no-DB boot: the legacy default is the only Agent.
    return reg ? undefined : 'default';
  };
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
  //   * Anything else calls next() and meets requireAuth exactly as before.
  //
  // Fail-closed by construction: no grants, no store, no registry, no live
  // plugin — every one of those is a next(), i.e. a 401. There is no failure
  // mode of this mount that produces LESS authentication than a build without
  // it. Mounted after express.json/cookieParser so plugin handlers see the
  // same parsed request they see through the ordinary boot-time mount.
  app.use(
    createPublicPathMount({
      grants: publicPathGrants,
      routes: pluginRouteRegistry,
    }),
  );

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
      resolveChatAgent,
      getDefaultSlug,
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
  app.use('/api/chat', requireAuth, createChatSessionsRouter({ getStore: getChatSessionStore }));

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
  app.use(
    '/api/v1/admin/memory/purge',
    requireAuth,
    createMemoryPurgeRouter({
      store: memoryStore,
      ...(knowledgeGraph ? { knowledgeGraph } : {}),
      ...(graphPool ? { graphPool } : {}),
      tenantId: graphTenantId,
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

  // US9 / T037 — operator-facing Agents dashboard backend. Mounts at
  // /api/v1/operator/agents/*. 503s when the orchestratorRegistry@1
  // service is not published (no DATABASE_URL / orchestrator plugin not
  // active). Writes route through ConfigStore → trigger → reload bus →
  // registry.reload(), so the next request already sees the new config.
  app.use(
    '/api/v1/operator/agents',
    requireAuth,
    createOperatorAgentsRouter({
      getConfigStore: () =>
        serviceRegistry.get<MultiOrchestratorConfigStore>('configStore'),
      getRegistry: () =>
        serviceRegistry.get<MultiOrchestratorRegistry>('orchestratorRegistry'),
      getChatSessionStore,
      getPluginCatalog: () => pluginCatalog,
      getInstalledRegistry: () => installedRegistry,
      // OM-75 / OM-78 (#1000, #1001) — decorate the 503 with WHY the runtime
      // is down, so the readiness banner can tell "no access at all" from
      // "access exists, orchestrator not assigned to it". Same credential
      // verdicts the providers admin renders; no network probe. Kept above
      // the closure-heavy options so the wiring-pin tests' lazy regex, which
      // ends at the first closing paren-brace pair, still sees it.
      getReadinessCause: resolveOperatorRuntimeReadinessCause,
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
  app.use(
    '/api/v1/operator/channels',
    requireAuth,
    createOperatorChannelsRouter({
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

  // W2a (#860) — read-only operator browser for the chat-context memory trees.
  // Same gate and same prefix as its operator siblings above (`requireAuth`,
  // cookie session JWT), NOT the machine-to-machine ADMIN_TOKEN surface in
  // `admin.ts`: the memory browser in web-ui authenticates as a logged-in
  // admin user. It replaces `/bot-api/dev/memory/*` (the @omadia/memory dev
  // router), which is unauthenticated, exposes the WHOLE `/memories` tree and
  // is forbidden in production — so before this mount the browser had no
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
    createOperatorMemoryContextsRouter({ store: memoryStore }),
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
  app.use(
    '/api/v1/operator',
    requireAuth,
    createAgentBuilderRouter({
      getConfigStore: () =>
        serviceRegistry.get<MultiOrchestratorConfigStore>('configStore'),
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
      ...(mcpOAuthService ? { mcpOAuth: mcpOAuthService, mcpOAuthUserKey } : {}),
      ...(mcpConfigService ? { mcpConfig: mcpConfigService } : {}),
      ...(mcpRegistrySecrets ? { mcpRegistrySecrets } : {}),
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
                .filter((a) => a.status !== 'disabled')
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
            // NOT revoked. Authentication skips a revoked record, so counting
            // one as "known" reports a binding as healthy that can only ever
            // 401. Same reasoning as the enabled-agent filter above: this set
            // answers "would a real request resolve this id", not "is there a
            // row somewhere".
            return new Set(keys.filter((k) => k.revokedAt === undefined).map((k) => k.id));
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

  // Agent Builder schedule worker (P6) — fires cron-scheduled agent turns.
  // Only with a Neon graphPool (the agent_schedules table lives there).
  if (graphPool) {
    const schedulePool = graphPool;
    const scheduleWorker = new ScheduleWorker({
      getGraphStore: () => new AgentGraphStore(schedulePool),
      getRegistry: () =>
        serviceRegistry.get<MultiOrchestratorRegistry>('orchestratorRegistry'),
      log: (m, f) => console.log(`[middleware] ${m}`, f ?? ''),
    });
    scheduleWorker.start();
    console.log('[middleware] agent-builder schedule worker started (1-min poll)');
  }

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
  let conversationSendScope: ((agentSlug: string, channelType: string, conversationId: string) => Promise<boolean>) | undefined;
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
    // the Teams invite and the facilitation start must not force a re-invite.
    // Hydration is awaited (cheap, one bounded SELECT) so the scope guard is
    // warm before the conversationBindings service below can serve its first
    // bind; writes stay fire-and-forget.
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
    const scopedRoleAssignments = createScopedRoleAssignments({
      roleStore: facilitationRoleStore,
      auditRoleChange: async (entry) => {
        await adminAudit?.record({
          actor: { id: entry.actor },
          action: 'conductor.role_holders_change',
          target: `conductor-role:${entry.roleKey}`,
          before: { action: entry.action, holderId: entry.holderId },
          after: { holders: entry.holdersAfter },
        });
      },
      log: (m) => console.log(m),
    });
    const auditBindingChange = async (entry: {
      actor: string;
      action: 'bind' | 'unbind';
      channelType: string;
      channelKey: string;
      agentSlug: string;
    }): Promise<void> => {
      await adminAudit?.record({
        actor: { id: entry.actor },
        action: 'channel.binding_change',
        target: `channel-binding:${entry.channelType}/${entry.channelKey}`,
        before: { action: entry.action },
        after: { agentSlug: entry.agentSlug },
      });
    };
    // THE one disposal path (reap hook, guarded unbind, retry sweep): remove
    // the binding, close the role holders (audited), and only then delete the
    // row — a failure keeps the row, so the attachment sweep retries it.
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
      if (attachment.roleKey) {
        const holders = await scopedRoleAssignments.holders(attachment.roleKey);
        for (const holderId of holders) {
          await scopedRoleAssignments.removeHolder({ roleKey: attachment.roleKey, holderId, actor });
        }
      }
      await ephemeralAttachmentsStore.delete(attachment.id);
      await auditBindingChange({
        actor,
        action: 'unbind',
        channelType: attachment.channelType,
        channelKey: attachment.channelKey,
        agentSlug: attachment.agentSlug,
      }).catch(() => undefined);
      console.log(`[conductor] disposed ephemeral attachment ${attachment.channelType}/${attachment.channelKey}${attachment.roleKey ? ` (role ${attachment.roleKey})` : ''} by ${actor}`);
    };
    conversationSendScope = async (agentSlug, channelType, conversationId) => {
      const row = await ephemeralAttachmentsStore.getByConversation(channelType, conversationId);
      return row !== undefined && row.agentSlug === agentSlug;
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
    const presentBots = async (
      channelType: string,
      conversationId: string,
    ): Promise<{ slug: string; name: string; channelKey: string }[]> => {
      if (channelType !== 'teams') return [];
      const registry = getRegistry();
      if (!registry) return [];
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
    const conductorWiring = await wireConductor({
      pool: graphPool,
      onEphemeralReaped,
      app,
      requireAuth,
      getRegistry,
      // #330 round 4 — participants column of the facilitation admin lens.
      getRoster: (channelType, conversationId) => conversationRosterRegistry.getRoster(channelType, conversationId),
      // Agent dialogue: a `say` step publishes an agent's turn into the chat.
      // The SAME registry the plugin-facing conversationSend uses — one owner
      // per channel type, so a discussion cannot be posted by a hijacked provider.
      conversationSendProviders: conversationSendRegistry,
      // #1018 — re-checked on every utterance, so an operator's flip bites at
      // the agent's next turn rather than at the end of the run.
      peerGate,
      // #330 round 4 — the destructive terminate leaves a durable trace.
      // Closure like auditRoleChange: adminAudit is constructed further down.
      auditFacilitationTerminate: async (entry) => {
        // #775 lesson — the SUB is an email and must NEVER land in the uuid
        // actor_id column; the uuid rides separately when the session has one.
        await adminAudit?.record({
          actor: { id: entry.actorUserId, email: entry.actor },
          action: 'conductor.facilitation_terminate',
          target: `conductor-workflow:${entry.slug}`,
          before: { workflowId: entry.workflowId },
          after: { cancelledRuns: entry.cancelledRuns },
        });
      },
      // `webhook.post` (issue #437) is a built-in action, not a plugin tool — special-cased
      // ahead of the dynamicAgentRuntime dispatch so a Designer action step can fire an
      // ad-hoc outbound webhook without an installed connector.
      invokeAction: (toolId, input) =>
        toolId === WEBHOOK_POST_ACTION_ID ? invokeWebhookPostAction(input) : dynamicAgentRuntime.invokeAgentTool(toolId, input),
      listActions: () => [WEBHOOK_POST_ACTION_ID, ...deterministicActionRegistry.list()],
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
      webhooksEnabled: config.CONDUCTOR_WEBHOOKS_ENABLED,
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
    // Expose the event router so plugin contexts (ctx.events.emit) resolve it lazily — US4.
    serviceRegistry.provide('conductorEventRouter', conductorWiring.eventRouter);
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
          if (err instanceof AwaitNotPendingError) return 'already_resolved'; // stale card / double-click
          throw err;
        }
      },
    });
    // #330 — agent-facing create+start seam for ephemeral (JIT) workflows.
    // Deny-by-default like every kernel service: a plugin only reaches it after
    // declaring the service name in its manifest (pluginServiceGrants catalog).
    serviceRegistry.provide('conductorEphemeralRuns', conductorWiring.ephemeralRunService);
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
        log: (msg: string) => console.log(msg),
      }),
    );
    // #330 C2a — the three zero-touch-setup services (all deny-by-default via
    // the manifest grant gate). Constructed above, BEFORE wireConductor.
    serviceRegistry.provide('conductorRoleAssignments', scopedRoleAssignments);
    const agentSetup = createAgentSetupServices({
      pool: graphPool,
      getConfigStore: () => serviceRegistry.get<MultiOrchestratorConfigStore>('configStore'),
      getRegistry: () => serviceRegistry.get<MultiOrchestratorRegistry>('orchestratorRegistry'),
      invites: observedInvites,
      attachments: ephemeralAttachmentsStore,
      disposeAttachment: disposeEphemeralAttachment,
      auditBindingChange,
      // #330 field report — rehydration payload: the workflow's newest still
      // active run, so a restarted facilitator plugin can keep poking its
      // timer await. Read-only, newest-first, absent run → null.
      resolveActiveRun: async (workflowId: string) => {
        const r = await graphPool.query<{ id: string }>(
          `SELECT r.id FROM conductor_runs r
             JOIN conductor_workflow_versions v ON r.workflow_version_id = v.id
            WHERE v.workflow_id = $1 AND r.status IN ('running', 'waiting')
            ORDER BY r.started_at DESC
            LIMIT 1`,
          [workflowId],
        );
        return r.rows[0]?.id ?? null;
      },
      log: (m) => console.log(m),
    });
    serviceRegistry.provide('agentProvisioning', agentSetup.agentProvisioning);
    serviceRegistry.provide('conversationBindings', agentSetup.conversationBindings);
    agentSetup.startAttachmentSweep();
    // #330 B3 — role fan-out + cached 1:1 conversation refs for targeted sends.
    // Deliberately THE SAME holder registry the executor resolves approvals
    // through: "who gets the report" and "who may approve" come from one
    // instance, so a future external holder source (Entra group, Odoo HR)
    // reaches both paths at once — no drift.
    targetedRoleResolver = (roleKey) => conductorWiring.roleHolderRegistry.resolveHolders(roleKey);
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
    startTurnReceiptReaper(graphPool, {
      retentionDays: config.RECEIPT_RETENTION_DAYS,
    });
    console.log(
      `[middleware] turn receipts wired at /api/v1/operator/receipts (auth-gated, retention ${config.RECEIPT_RETENTION_DAYS}d)`,
    );

    // #758 — signed checkpoints over the receipt hash chain. The chain
    // itself always builds (the store appends chained rows unconditionally);
    // signing is the layer that needs the operator-held key. Absent key ⇒
    // loud boot log, not a silent no-op.
    const checkpointSigner = config.AUDIT_SIGNING_KEY
      ? loadCheckpointSigner(config.AUDIT_SIGNING_KEY)
      : undefined;
    if (checkpointSigner) {
      startCheckpointWorker(graphPool, checkpointSigner, {
        intervalMs: config.AUDIT_CHECKPOINT_INTERVAL_MINUTES * 60_000,
        ...(config.AUDIT_ANCHOR_PATH ? { anchorPath: config.AUDIT_ANCHOR_PATH } : {}),
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
      }),
    );
    console.log('[middleware] provenance verify/export wired at /api/v1/operator/provenance (auth-gated)');

    const userStore = new UserStore(graphPool);

    const bootstrapResult = await runAuthBootstrap({
      userStore,
      bootstrapEmail: config.ADMIN_BOOTSTRAP_EMAIL,
      bootstrapPassword: config.ADMIN_BOOTSTRAP_PASSWORD,
      bootstrapDisplayName: config.ADMIN_BOOTSTRAP_DISPLAY_NAME,
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

    app.use(
      '/api/v1/auth',
      createAuthRouter({
        registry: providerRegistry,
        userStore,
        signingKey: sessionSigningKey,
        publicBaseUrl: config.PUBLIC_BASE_URL,
        defaultReturnPath: config.AUTH_DEFAULT_RETURN_PATH,
        setupAllowed: bootstrapResult.setupRequired,
        // OB-61 — /setup wizard seeds the operator-supplied
        // `anthropic_api_key` into each consumer plugin's vault and
        // reactivates the plugin so the LLM-bound capabilities go live
        // without a server restart.
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

    app.use(
      '/api/v1/admin/users',
      requireAuth,
      createAdminUsersRouter({ userStore, audit: adminAudit }),
    );
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
      '[middleware] admin user-management + auth-toggle endpoints ready at /api/v1/admin/users and /api/v1/admin/auth (auth: required)',
    );
  } else {
    console.warn(
      '[auth] graphPool unavailable — local-password auth disabled, /api/v1/auth/* returns 503',
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
  // vault. Seeded on first boot from REGISTRY_URLS, else the public default
  // hub.omadia.ai. The live RegistryClient is reloaded from the store here and
  // again after every admin mutation, so changes apply without a restart.
  const registrySettings: RegistrySettingsKV = graphPool
    ? new PlatformSettingsStore(graphPool)
    : new InMemoryRegistrySettings();
  const registryConfigStore = new VaultBackedRegistryConfigStore({
    settings: registrySettings,
    vault: secretVault,
  });
  await seedRegistriesIfEmpty(
    registryConfigStore,
    parseRegistries(config.REGISTRY_URLS),
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
    createInstallRouter({ service: installService, oauthBroker }),
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
      // After a re-upload onto an already installed agent (registry entry
      // still alive, package was deleted + re-uploaded) we activate the
      // runtime directly — otherwise the tool stays unknown until the user
      // un-/re-installs once. For a version upgrade with onMigrate this
      // re-activation runs with the already migrated config.
      //
      // Dispatch by `manifest.identity.kind` — symmetric to
      // InstallService.onInstalled. Without the dispatch, a channel/
      // integration re-upload was routed through dynamicAgentRuntime; there
      // the PluginContext lacks e.g. `core`, and plugin-activate crashed with
      // "Cannot read properties of undefined (reading 'log')".
      onPackageReady: async (agentId) => {
        if (installedRegistry.get(agentId)?.status !== 'active') return;

        const kind = pluginCatalog.get(agentId)?.plugin.kind ?? 'agent';
        switch (kind) {
          case 'channel': {
            if (!channelRegistryRef) {
              console.warn(
                `[upload] channel '${agentId}' re-uploaded before channelRegistry was wired — hot-swap skipped, will pick up at next boot`,
              );
              return;
            }
            if (channelRegistryRef.isActive(agentId)) {
              await channelRegistryRef.deactivate(agentId);
            }
            await channelRegistryRef.activate(agentId);
            return;
          }
          case 'tool':
          case 'extension':
          case 'integration': {
            if (toolPluginRuntime.isActive(agentId)) {
              await toolPluginRuntime.deactivate(agentId);
            }
            await toolPluginRuntime.activate(agentId);
            return;
          }
          case 'agent':
          default: {
            // If v1 is still active, deactivate cleanly first — v2 has a
            // fresh DomainTool with potentially changed sub-tools.
            if (dynamicAgentRuntime.isActive(agentId)) {
              await dynamicAgentRuntime.deactivate(agentId);
            }
            await dynamicAgentRuntime.activate(agentId);
            // Hub/registry install + package re-upload land here. Propagate the
            // (fresh) tool onto the per-Agent orchestrators so the new/updated
            // capability is live for the next chat turn without a restart.
            await propagatePluginInstall(agentId);
          }
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
      backup: vaultBackupService,
      ...(vaultBackupDisabledReason
        ? { backupDisabledReason: vaultBackupDisabledReason }
        : {}),
    }),
  );
  console.log('[middleware] vault-status endpoint ready at /api/v1/admin/vault-status (auth: required)');

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
      reactivate: reactivateAgent,
      dynamicAgentRuntime,
      // Epic #470 C4 / H1 — operator consent for unauthenticated plugin path
      // prefixes. Behind requireAuth like every other runtime endpoint.
      publicPathGrantStore,
      publicPathGrants,
      // Epic #470 C16 (#817) — the half C7 shipped a gate for but no answer to.
      sqlGrantStore,
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
      installedRegistry,
      vault: secretVault,
      reactivate: reactivateAgent,
      llmProviderCatalog,
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
      // Resolved per request, never captured: `vectorWritesAllowed` flips
      // false→true in-process when a stale-vector clear drains, and the whole
      // point of the page is that the operator sees that without a reload.
      getGateStatus: () =>
        serviceRegistry.get<EmbeddingGateStatus>(EMBEDDING_GATE_STATUS_SERVICE),
      getGraphPool: () => graphPool,
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
  app.use('/api/v1/admin/cli-backends', requireAuth, createAdminCliBackendsRouter());
  console.log('[middleware] CLI backends endpoint ready at /api/v1/admin/cli-backends (auth: required)');
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
  const previewCache = new PreviewCache({
    activate: previewRuntime.activate.bind(previewRuntime),
    warmSlots: 3,
    logger: () => {},
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

  const resolveBuilderProvider: BuilderProviderResolver = async (modelRef) => {
    const { provider: providerId, modelId } =
      BuilderModelRegistry.resolve(modelRef);
    if (providerId === 'anthropic') {
      return {
        provider: createAnthropicProvider({ client: currentAnthropicClient() }),
        modelId,
      };
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

  const builderRebuildScheduler = new PreviewRebuildScheduler({
    debounceMs: 2_000,
    invalidate: (userEmail, draftId) => {
      previewCache.invalidate(userEmail, draftId);
    },
    rebuild: async (userEmail, draftId) => {
      // B.6-6: emit build-status events on the spec bus so the Workspace
      // header surfaces a live indicator for out-of-band rebuilds (PATCH
      // /spec without a chat turn). The PreviewChatPane already gets
      // build_status via PreviewStreamEvent during in-band turns; this
      // bus path covers the rebuild-while-not-chatting case.
      builderSpecBus.emit(draftId, { type: 'build_status', phase: 'building' });
      try {
        const handle = await previewCache.ensureWarm({
          userEmail,
          draftId,
          build: async () => {
            const result = await builderBuildPipeline.run({ userEmail, draftId });
            if (!result.buildResult.ok) {
              // Log stdout/stderr tails so we can diagnose `reason=unknown`
              // failures from middleware.log instead of having to surface
              // them through the SSE wire (B.6-12.1 diag).
              console.log(
                `[builder] auto-rebuild failed reason=${result.buildResult.reason} ` +
                  `exit=${String(result.buildResult.exitCode)} ` +
                  `errors=${String(result.buildResult.errors.length)} ` +
                  `draft=${draftId}`,
              );
              if (result.buildResult.stdoutTail) {
                console.log(
                  `[builder] stdout-tail draft=${draftId}:\n${result.buildResult.stdoutTail}`,
                );
              }
              if (result.buildResult.stderrTail) {
                console.log(
                  `[builder] stderr-tail draft=${draftId}:\n${result.buildResult.stderrTail}`,
                );
              }
              builderSpecBus.emit(draftId, {
                type: 'build_status',
                phase: 'failed',
                reason: result.buildResult.reason,
                errorCount: result.buildResult.errors.length,
                // Cap to 50 — SSE frame budget. Editor only needs enough
                // to highlight the visible failures; the full list is
                // available via the Preview-pane error view.
                errors: result.buildResult.errors.slice(0, 50).map((e) => ({
                  file: e.path,
                  line: e.line,
                  column: e.col,
                  code: e.code,
                  message: e.message,
                })),
              });
              throw new Error(
                `[builder] auto-rebuild failed for ${userEmail}/${draftId}: ${result.buildResult.reason}`,
              );
            }
            // In vault-backed mode this lazy-loads any secrets persisted in
            // a previous middleware run. No-op when the buffer is heap-only.
            await previewSecretBuffer.warm(userEmail, draftId);
            builderSpecBus.emit(draftId, {
              type: 'build_status',
              phase: 'ok',
              buildN: result.buildN,
            });
            // Split buffer by field-type — same pattern as
            // builderPreview.ensureWarmHandle. Pre-fix this used
            // draft.slots as configValues (slots are code chunks, not
            // config) so ctx.config.require('foo') always threw.
            const allBufferValues = previewSecretBuffer.get(userEmail, draftId);
            const setupFields = (result.draft.spec.setup_fields ?? []) as ReadonlyArray<unknown>;
            const fieldByKey = new Map<string, string>();
            for (const raw of setupFields) {
              if (!raw || typeof raw !== 'object') continue;
              const f = raw as { key?: unknown; type?: unknown };
              if (typeof f.key !== 'string') continue;
              fieldByKey.set(f.key, typeof f.type === 'string' ? f.type : 'string');
            }
            const splitConfigValues: Record<string, unknown> = {};
            const splitSecretValues: Record<string, string> = {};
            for (const [k, v] of Object.entries(allBufferValues)) {
              const t = fieldByKey.get(k);
              if (t === undefined) continue;
              if (t === 'secret' || t === 'oauth') splitSecretValues[k] = v;
              else splitConfigValues[k] = v;
            }
            return {
              zipBuffer: result.buildResult.zip,
              rev: result.buildN,
              configValues: splitConfigValues,
              secretValues: splitSecretValues,
            };
          },
        });
        // B.9-3: fire-and-forget runtime smoke after the auto-rebuild
        // scheduler's path. Dedup'd per (draftId, rev) inside the
        // orchestrator — no-op when the cache returned an unchanged handle.
        builderRuntimeSmokeOrchestrator.attemptSmoke({
          handle,
          userEmail,
          draftId,
        });
      } catch (err) {
        // If `build:` was never invoked (cache short-circuited or something
        // upstream threw), make sure we don't leave the UI stuck on
        // "building". Re-emitting `failed` is safe — clients always treat
        // the latest event as authoritative.
        builderSpecBus.emit(draftId, {
          type: 'build_status',
          phase: 'failed',
          reason: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
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
    logger: (...args: unknown[]) => {
      console.log('[builder/auto-fix]', ...args);
    },
  });

  const shutdownBuilder = async (): Promise<void> => {
    try {
      builderRebuildScheduler.cancelAll();
      await builderBuildQueue.drain(5_000).catch(() => {
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
    } catch {
      // ignore — process is exiting anyway
    }
  };
  process.once('SIGTERM', shutdownBuilder);
  process.once('SIGINT', shutdownBuilder);

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
      },
      events: {
        draftStore,
        bus: builderSpecBus,
        autoFixOrchestrator: builderAutoFixOrchestrator,
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
      // Issue #55 — live compiled-prompt preview
      previewPrompt: { draftStore },
      // Issue #52 — multidimensional quality score
      quality: { draftStore },
      // Install endpoint is only wired when the package-upload subsystem is
      // enabled — otherwise the underlying ingest service does not exist.
      // BuilderRouterDeps.install is optional so the route stays absent.
      ...(packageUploadService
        ? {
            install: {
              draftStore,
              buildPipeline: builderBuildPipeline,
              packageUploadService,
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

  if (config.ADMIN_TOKEN && config.ADMIN_TOKEN.length > 0) {
    app.use(
      '/api/admin',
      createAdminRouter({
        store: memoryStore,
        token: config.ADMIN_TOKEN,
      }),
    );
    console.log('[middleware] admin endpoints enabled at /api/admin');
    // S+7.7 — Telegram admin endpoints are now self-contained inside the
    // plugin (mounted via core.registerRouter at /api/telegram/admin/*).
    // No kernel-side route file. See packages/harness-channel-telegram/
    // src/adminRouter.ts.
  } else {
    console.log('[middleware] admin endpoints DISABLED (ADMIN_TOKEN not set)');
  }

  // `/diagrams/<signed-key>` is now mounted by the @omadia/diagrams
  // plugin via ctx.routes.register (see packages/harness-diagrams/src/plugin.ts).

  // `/attachments/<signed-key>` is now mounted by the de.byte5.channel.teams
  // plugin via ctx.routes.register (see packages/harness-channel-teams/src/plugin.ts,
  // phase-3.1-4).

  // `/api/dev/memory` is now mounted by the @omadia/memory plugin via
  // ctx.routes.register when its `dev_memory_endpoints_enabled` config is true.
  // It is authenticated by the same OB-106 `/api` requireAuth line as everything
  // else here — issue #669 removed the `/api/dev` entry from `publicPaths`.

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
  if (
    mountDevGraph(app, requireAuth, {
      graph: knowledgeGraph,
      enabled: config.DEV_ENDPOINTS_ENABLED,
      loopbackOnly: config.DEV_ENDPOINTS_LOOPBACK_ONLY,
    })
  ) {
    console.log(
      `[middleware] DEV endpoints enabled at ${DEV_GRAPH_PATH} (auth: required${
        config.DEV_ENDPOINTS_LOOPBACK_ONLY ? ', loopback-only' : ''
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
  const orchestratorDispatcher: TurnDispatcher = createOrchestratorDispatcher({
    getChannelBlock: (channelId) =>
      pluginCatalog.get(channelId)?.plugin.channel,
    getAgentBundle: (service) =>
      serviceRegistry.get<ChatAgentBundle>(service),
    // US7 — channelType autodiscovery: prefer the manifest's declared
    // channel_type, else derive it from the channel id's last dotted segment
    // (de.byte5.channel.teams → teams), the convention operators bind under.
    channelTypeFor: (channelId) =>
      deriveChannelType(channelId, {
        manifest: pluginCatalog.get(channelId)?.plugin.channel,
      }),
    // US7 — per-binding routing: resolve the scoped ChatAgent the operator
    // bound to (channelType, channelKey) via the multi-orchestrator
    // channelResolver. Resolved lazily so hot config reloads take effect and
    // so a Postgres-less deployment (no resolver published) degrades to the
    // shared chatAgent via the static dispatch_service path.
    resolveBinding: (channelType, channelKey) => {
      const resolver =
        serviceRegistry.get<ChannelBindingResolver>('channelResolver');
      if (!resolver) return undefined;
      const result = resolver.resolve(channelType, channelKey);
      return result.decision !== 'reject' ? result.chatAgent : undefined;
    },
  });

  // Omadia UI canvas transport: a kernel-owned WebSocket registry mirroring
  // ExpressRouteRegistry. It authenticates each upgrade with the session
  // cookie BEFORE the handshake (same signing key as requireAuth) and backs
  // `CoreApi.registerWebSocket`. Inert for every non-WS channel; attached to
  // the http.Server once it exists (after app.listen, below).
  const webSocketRegistry = new WebSocketRegistry({
    signingKey: sessionSigningKey,
    whitelist: emailWhitelist,
  });

  // #330 B3 — Principal-addressed targeted delivery ('targetedSend' service).
  // Constructed after the conductor block so the role resolver + binding
  // lookup are already set when Postgres is available; deny-by-default for
  // plugins like every other kernel service.
  const targetedDeliveryService = createTargetedDeliveryService({
    providers: targetedSendRegistry,
    ...(targetedRoleResolver ? { resolveRoleHolders: targetedRoleResolver } : {}),
    ...(targetedBindingLookup ? { lookupConversationRefs: targetedBindingLookup } : {}),
    log: (m) => console.log(m),
  });
  serviceRegistry.provide('targetedSend', targetedDeliveryService);
  // #330 C3b — conversation-addressed proactive send (Facilitator group nudges).
  serviceRegistry.provide(
    'conversationSend',
    createConversationSendService({
      providers: conversationSendRegistry,
      ...(conversationSendScope ? { isPermitted: conversationSendScope } : {}),
      log: (m) => console.log(m),
    }),
  );

  const channelCoreApi = createCoreApi({
    dispatcher: orchestratorDispatcher,
    routes: routeRegistry,
    webSockets: webSocketRegistry,
    rosterRegistry: conversationRosterRegistry,
    targetedSends: targetedSendRegistry,
    conversationEvents: conversationEventHub,
    conversationSends: conversationSendRegistry,
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
    notificationRouter,
    uiRouteCatalog,
    jobScheduler,
    flowSigningKey: sessionSigningKey,
    flowPublicBaseUrl,
    pluginStatusRegistry,
    operatorAuth,
    eventCatalogRegistry,
    resolver: channelPluginResolver,
    coreApi: channelCoreApi,
    routes: routeRegistry,
    webSockets: webSocketRegistry,
    rosterRegistry: conversationRosterRegistry,
    targetedSends: targetedSendRegistry,
    conversationSends: conversationSendRegistry,
  });
  channelRegistryRef = channelRegistry;
  await channelRegistry.activateAllInstalled();
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

  const server = app.listen(config.PORT, config.HOST, () => {
    console.log(`[middleware] listening on [${config.HOST}]:${config.PORT}`);
    console.log(`[middleware] skills dir: ${config.SKILLS_DIR}`);
    console.log(`[middleware] orchestrator model: ${config.ORCHESTRATOR_MODEL}`);
    console.log(`[middleware] sub-agent model:   ${config.SUB_AGENT_MODEL}`);
    console.log(`[middleware] domain tools: ${domainTools.map((t) => t.name).join(', ')}`);
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
    const stopMdns = (): void => {
      void mdnsAdvertisement?.stop();
    };
    process.once('SIGTERM', stopMdns);
    process.once('SIGINT', stopMdns);
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
