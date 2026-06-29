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
import {
  defaultLlmAdapters,
  LlmProviderCatalog,
  readProviderApiKey,
  resolveLlmProvider,
} from '@omadia/llm-provider';
import express from 'express';
import cookieParser from 'cookie-parser';
import { config, parseRegistries } from './config.js';
import { createTigrisStore } from '@omadia/diagrams';
import type { MemoryStore } from '@omadia/plugin-api';
import { createAdminRouter } from './routes/admin.js';
import { createMemoryPurgeRouter } from './routes/memoryPurge.js';
import { createMemoryBackendRouter } from './routes/memoryBackend.js';
import { createChatRouter } from './routes/chat.js';
import { createOperatorAgentsRouter } from './routes/operatorAgents.js';
import { wireConductor } from './conductor/index.js';
import { createOperatorChannelsRouter } from './routes/operatorChannels.js';
import { createAgentBuilderRouter } from './routes/agentBuilder.js';
import { ScheduleWorker } from './scheduler/scheduleWorker.js';
import type {
  ConfigStore as MultiOrchestratorConfigStore,
  OrchestratorRegistry as MultiOrchestratorRegistry,
} from '@omadia/orchestrator';
import { createMemoryRouter } from './routes/memory.js';
import { createBulkPromotionRouter } from './routes/bulkPromotion.js';
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
import { createDevGraphRouter } from './routes/devGraph.js';
import { createDevGraphLifecycleRouter } from './routes/devGraphLifecycle.js';
import { createAgentPrioritiesRouter } from './routes/agentPriorities.js';
import { createAdminDomainsRouter } from './routes/adminDomains.js';
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
import { createAdminCliBackendsRouter } from './routes/adminCliBackends.js';
import { registerClaudeCliAdapter } from './platform/claudeCliAdapter.js';
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
import { createRequireAuth } from './auth/requireAuth.js';
import { OAuthClient } from './auth/oauthClient.js';
import { RefreshStore } from './auth/refreshStore.js';
import { EmailWhitelist } from './auth/whitelist.js';
import { resolveSessionSigningKey } from './auth/sessionSigningKey.js';
import { runAuthMigrations } from './auth/migrator.js';
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
import { AdminAuditLog } from './auth/adminAuditLog.js';
import {
  PlatformSettingsStore,
  SETTING_AUTH_ACTIVE_PROVIDERS,
} from './auth/platformSettings.js';
import { createAdminUsersRouter } from './routes/adminUsers.js';
import { createAdminAuthRouter } from './routes/adminAuth.js';
import { PluginCatalog } from './plugins/manifestLoader.js';
import { buildKgHealth } from './health/kgHealth.js';
import { FileInstalledRegistry } from './plugins/fileInstalledRegistry.js';
import { InstallService } from './plugins/installService.js';
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
import { NotificationRouter } from './platform/notificationRouter.js';
import { PluginStatusRegistry } from './platform/pluginStatusRegistry.js';
import { UiRouteCatalog } from './platform/uiRouteCatalog.js';
import { CanvasOutputRegistry } from './platform/canvasOutputRegistry.js';
import { EventCatalogRegistry } from './platform/eventCatalogRegistry.js';
import { DeterministicActionRegistry } from './platform/deterministicActionRegistry.js';
import { ServiceRegistry } from './platform/serviceRegistry.js';
import { TurnHookRegistry } from './platform/turnHookRegistry.js';
import { NativeToolRegistry } from '@omadia/orchestrator';
import { McpManager } from '@omadia/orchestrator';
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
  createRoutinesIntegration,
  initRoutines,
  type RoutinesHandle,
} from './plugins/routines/index.js';
import { ROUTINES_INTEGRATION_SERVICE_NAME } from '@omadia/plugin-api';
import { createRoutinesRouter } from './routes/routines.js';
import { ExpressRouteRegistry } from './channels/routeRegistry.js';
import { WebSocketRegistry } from './channels/webSocketRegistry.js';
import { createCoreApi } from './channels/coreApi.js';
import { ChannelDirectoryRegistry } from './channels/channelDirectoryRegistry.js';
import { DefaultChannelRegistry } from './channels/channelRegistry.js';
import type { ChannelRegistry, ChannelBindingResolver } from '@omadia/channel-sdk';
import { DynamicChannelPluginResolver } from './channels/dynamicChannelResolver.js';
import type { TurnDispatcher } from './channels/coreApi.js';
import { createOrchestratorDispatcher } from './channels/orchestratorDispatcher.js';
import { deriveChannelType } from './channels/channelType.js';
import type { FactExtractor } from '@omadia/orchestrator-extras';
import { backfillGraph } from '@omadia/orchestrator-extras';
import { turnContext } from '@omadia/orchestrator';
import type { EntityRefBus, KnowledgeGraph } from '@omadia/plugin-api';
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

async function main(): Promise<void> {
  // Install process-level guards FIRST — before any plugin code runs. Keeps
  // the host alive when a plugin's detached async (timers, resolved promises,
  // fire-and-forget I/O) throws.
  installProcessGuards();

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
  registerBuiltinLlmProviders(llmProviderCatalog);
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
  const pluginRouteRegistry = new PluginRouteRegistry();
  const notificationRouter = new NotificationRouter();

  // Phase B+ — directory aggregator for the /operator/channels dashboard.
  // Channel-kind plugins register their ChannelKeyDirectory contributions
  // during activate(); the kernel exposes the union over REST.
  const channelDirectoryRegistry = new ChannelDirectoryRegistry((msg, fields) =>
    console.log(`[middleware] ${msg}${fields ? ' ' + JSON.stringify(fields) : ''}`),
  );
  serviceRegistry.provide('channelDirectoryRegistry', channelDirectoryRegistry);
  const uiRouteCatalog = new UiRouteCatalog();
  // Publish the catalogue so plugin code (notably channel-teams' Hub +
  // Tab-Config) can read it via `ctx.services.get<UiRouteCatalog>(
  // 'uiRouteCatalog')`. Published BEFORE any plugin activates so the
  // service is available the moment a consumer asks for it.
  serviceRegistry.provide('uiRouteCatalog', uiRouteCatalog);

  // Spec 004 — kernel store of plugin action statuses (ctx.status). Read by the
  // admin API to surface "Aktion erforderlich" badges/banners in the store UI.
  const pluginStatusRegistry = new PluginStatusRegistry();

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
      ...builtInPackageStore.list().map((p) => ({ packageRoot: p.path })),
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
  // Spec 004 (FR-B5) — origin plugin flow callbacks resolve against.
  const flowPublicBaseUrl =
    config.FLOW_PUBLIC_BASE_URL ?? config.PUBLIC_BASE_URL;

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

  // Kernel-wide background-job scheduler. Plugin-contributed jobs (cron or
  // interval) register here via `ctx.jobs.register(...)`. Bulk teardown on
  // plugin deactivate is owned by each runtime, so a leaked dispose handle
  // still cannot outlive its plugin's lifecycle.
  const jobScheduler = new JobScheduler({
    log: (msg) => console.log(msg),
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
    serviceRegistry,
    nativeToolRegistry,
    pluginRouteRegistry,
    notificationRouter,
    uiRouteCatalog,
    jobScheduler,
    flowSigningKey: sessionSigningKey,
    flowPublicBaseUrl,
    pluginStatusRegistry,
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
    nativeToolRegistry,
    pluginRouteRegistry,
    notificationRouter,
    uiRouteCatalog,
    jobScheduler,
    flowSigningKey: sessionSigningKey,
    flowPublicBaseUrl,
    pluginStatusRegistry,
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
  // `sessionSigningKey` is resolved earlier (right after the vault loads) so
  // the plugin runtimes can also use it for `ctx.flows` state signing.
  const emailWhitelist = new EmailWhitelist(config.ADMIN_ALLOWED_EMAILS);
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
    publicPaths: [
      /^\/api\/v1\/auth(?:\/|$|\?)/,
      /^\/api\/v1\/setup(?:\/|$|\?)/,
      /^\/api\/auth(?:\/|$|\?)/,
      // Spec 005 — kernel OAuth broker callback. The IdP redirects the
      // operator's browser back here after consent; the session cookie may
      // have lapsed during the round-trip, so the route is public and
      // self-secures via the signed, single-use `state` token. `/oauth/start`
      // is NOT listed — it stays behind the cookie gate (operator-initiated).
      /^\/api\/v1\/install\/oauth\/callback(?:\/|$|\?)/,
      // Bot Framework webhook for channel-teams. The Teams adapter
      // validates the Bot-issued JWT inside the handler; the session
      // cookie check would silently drop every inbound activity because
      // Teams never sends one.
      /^\/api\/messages(?:\/|$|\?)/,
      // Plugin-served UI surfaces (`/p/<pluginId>/...`). Teams iframes
      // these from inside the bot-app shell where there is no
      // middleware session cookie — only a Teams SSO token. Routing
      // them through the cookie gate redirects to /login inside the
      // iframe, which shows the operator login form instead of the
      // Tab content. Plugins that expose sensitive data are
      // responsible for validating the Teams SSO token themselves;
      // pages like /p/channel-teams/{hub,tab-config} are public-by-
      // design and the reference dashboard is read-only demo state.
      /^\/p\/[^/]+(?:\/|$|\?)/,
      // Local dev surfaces. The `/api/dev/*` mount itself is conditional
      // on `DEV_ENDPOINTS_ENABLED=true` further down (see graph +
      // memory dev routers around the "DEV endpoints enabled" log line)
      // — when that flag is on the operator has already opted into an
      // unauthenticated surface and the local Next-UI relies on the
      // routes being callable without a session cookie. When the flag
      // is off, no `/api/dev/*` routes are mounted at all, so this
      // bypass cannot leak anything. When the flag is on AND the stack
      // is exposed beyond localhost, that is a separate operator
      // mistake the compose `127.0.0.1` port bindings are designed to
      // prevent.
      ...(config.DEV_ENDPOINTS_ENABLED
        ? [/^\/api\/dev(?:\/|$|\?)/]
        : []),
    ],
  });

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
  // - graphTenantId is read at the same place the plugin reads it so
  //   verifier-store + plugin-internal embedding-backfill use the same key.
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
  // hydration of per-Agent orchestrators, the routines feature) re-applies on
  // the next restart for advanced stacks (sub-agents / routines). The default
  // out-of-the-box stack has no domain tools, so chat is fully functional hot.
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
      const mcpManager = new McpManager();
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
        const mcpServers = registryForHydrate.currentSnapshot()?.mcpServers ?? [];
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
            defaultModel: SUBAGENT_DEFAULT_MODEL,
            hostIsCliProvider: providerId === 'claude-cli',
            cliModelAlias: (model: string): string =>
              model.replace(/-cli$/, '') || 'sonnet',
            log: (m: string) => console.log(`[middleware] ${m}`),
          },
        );
      };

      let attached = 0;
      for (const entry of registryForHydrate.list()) {
        for (const t of scopeDomainToolsToPlugins(
          currentDomainTools(),
          entry.plugins,
        )) {
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
        console.log(
          `[middleware] registry: orchestrator for "${slug}" hydrated with ${String(tools.length)} domain-tool(s) + ${String(subTools)} sub-agent tool(s) (per-Agent plugin-scoped)`,
        );
      });

    }
  }

  console.log('[middleware] context retriever ready (tail + entity-anchor + FTS)');

  // Routines feature (OB-NEW): persistent user-created scheduled agent
  // invocations. Requires Postgres for persistence; skipped in zero-config
  // dev (in-memory KG backend, no DATABASE_URL). Channel adapters that want
  // proactive delivery register their `ProactiveSender` into
  // `routinesHandle.senderRegistry` after this call (Teams: wrap a
  // long-lived `CloudAdapter.continueConversationAsync` via
  // `createProactiveSender('teams', sendFn)`). Channel adapters MUST also
  // wrap their inbound turn with `routineTurnContext.run/enter({tenant,
  // userId, channel, conversationRef}, …)` — without it, the
  // `manage_routine` tool's `create`/`list` actions return a
  // model-friendly error string and the model degrades gracefully.
  let routinesHandle: RoutinesHandle | undefined;
  if (graphPool && orchestrator) {
    routinesHandle = await initRoutines({
      pool: graphPool,
      scheduler: jobScheduler,
      orchestrator,
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
      createRoutinesIntegration(routinesHandle),
    );
    console.log(
      '[middleware] routines feature ready (manage_routine tool registered, routinesIntegration published)',
    );
  } else if (!graphPool) {
    console.log(
      '[middleware] routines feature SKIPPED — no graphPool (in-memory KG backend; set DATABASE_URL to enable)',
    );
  } else {
    console.log(
      '[middleware] routines feature SKIPPED — chatAgent not active (set ANTHROPIC_API_KEY via the Setup Wizard, then restart to enable routines)',
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
  app.use(express.json({ limit: '10mb' }));
  app.use(cookieParser());

  app.get('/health', (_req, res) => {
    // `kg` surfaces the recall capability picture (backend durability +
    // embeddings/semantic-recall/durable-tier/process-reuse availability) so a
    // silently-degraded deployment is observable here instead of only in boot
    // logs. Non-sensitive: capability states only, no secrets/URLs.
    res.json({ status: 'ok', kg: buildKgHealth(installedRegistry) });
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

  // Harness shared assets — currently the admin-UI baseline stylesheet
  // that plugin-bundled admin UIs `<link>` into their HTML. No auth: the
  // CSS is static and operator-agnostic. See PLAN-admin-ui-theming.md.
  app.use('/api/_harness', createHarnessAdminUiRouter());
  console.log('[middleware] harness admin-ui assets ready at /api/_harness/admin-ui.css');

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
      getChatSessionStore,
      snapshotForAgent: (slug) => getRegistry()?.snapshotForAgent(slug),
    }),
  );

  // Chat-sessions CRUD behind `requireAuth` — sessions may contain
  // PII / tool outputs / code snippets and must not be readable anonymously.
  // The `/api` mount above already gates this, but the explicit middleware
  // here is defence-in-depth: if a future refactor splits mounts or moves
  // the sessions router to a different base path, the auth guarantee
  // travels with it.
  app.use('/api/chat', requireAuth, createChatSessionsRouter({ getStore: getChatSessionStore }));

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
    }),
  );
  console.log(
    '[middleware] operator-agents endpoints ready at /api/v1/operator/agents/* (auth-gated)',
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
  if (graphPool) {
    await runAuthMigrations(graphPool, (m) => console.log(m));
    await runProfileStorageMigrations(graphPool, (m) => console.log(m));
    await runProfileSnapshotMigrations(graphPool, (m) => console.log(m));

    // Conductor (Spec 005) — deterministic workflow engine. Migrations + stores +
    // run executor + operator API, all behind the graphPool (inert in-memory).
    // Agent steps run real turns on Agents (orchestrator instances) resolved by slug
    // from the registry; action steps invoke real connector tools.
    const conductorWiring = await wireConductor({
      pool: graphPool,
      app,
      requireAuth,
      getRegistry,
      invokeAction: (toolId, input) => dynamicAgentRuntime.invokeAgentTool(toolId, input),
      eventCatalog: eventCatalogRegistry,
      log: (m) => console.log(m),
    });
    // Expose the event router so plugin contexts (ctx.events.emit) resolve it lazily — US4.
    serviceRegistry.provide('conductorEventRouter', conductorWiring.eventRouter);
    console.log('[middleware] conductor wired at /api/v1/operator/conductors/* (auth-gated)');
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
    reactivatePlugin: (pluginId) => installService.reactivate(pluginId),
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
    }),
  );
  console.log('[middleware] runtime introspection endpoint ready at /api/v1/admin/runtime (auth: required)');

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

  // Subscription-CLI backends (#309) — detect installed/logged-in vendor CLIs
  // (Claude/Codex/Gemini) so the operator can run agents on a subscription.
  // Read-only host-capability probe; never triggers a login or consumes quota.
  app.use('/api/v1/admin/cli-backends', requireAuth, createAdminCliBackendsRouter());
  console.log('[middleware] CLI backends endpoint ready at /api/v1/admin/cli-backends (auth: required)');

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
  if (config.DEV_ENDPOINTS_ENABLED) {
    app.use('/api/dev/graph', createDevGraphRouter({ graph: knowledgeGraph }));
    // OB-73 — palaia Phase 4 lifecycle admin (Tier-Histogram + Run-Now).
    // Mounted only when the KG-Neon plugin published `graphLifecycle@1`
    // (in-memory backend stays unmounted because the lifecycle is
    // Postgres-specific).
    const lifecycleService =
      serviceRegistry.get<LifecycleService>('graphLifecycle');
    if (lifecycleService) {
      app.use(
        '/api/dev/graph/lifecycle',
        createDevGraphLifecycleRouter({ lifecycle: lifecycleService }),
      );
      console.log(
        '[middleware] kg-lifecycle admin endpoints ready at /api/dev/graph/lifecycle',
      );
    }
    // OB-74 — palaia Phase 5 per-agent block/boost admin. Mounted only when
    // the KG-Neon plugin published `agentPriorities@1` (in-memory backend
    // can leave the page empty — the admin UI degrades to "no entries").
    const agentPrioritiesStore =
      serviceRegistry.get<AgentPrioritiesStore>('agentPriorities');
    if (agentPrioritiesStore) {
      app.use(
        '/api/dev/graph/priorities',
        createAgentPrioritiesRouter({ store: agentPrioritiesStore }),
      );
      console.log(
        '[middleware] kg-priorities admin endpoints ready at /api/dev/graph/priorities',
      );
    }

    // OB-77 — Palaia Phase 8 plugin-domain admin. Read-only listing of
    // all loaded plugins grouped by their declared identity.domain.
    // Mounted unconditionally (the catalog is always present); curation
    // is deferred to OB-78 Phase 9 Agent-Profile work.
    app.use(
      '/api/admin/domains',
      createAdminDomainsRouter({ catalog: pluginCatalog }),
    );
    console.log(
      '[middleware] domains admin endpoint ready at /api/admin/domains',
    );
    console.warn(
      '[middleware] ⚠ DEV endpoints enabled at /api/dev — unauthenticated, LOCAL USE ONLY',
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

  const channelCoreApi = createCoreApi({
    dispatcher: orchestratorDispatcher,
    routes: routeRegistry,
    webSockets: webSocketRegistry,
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
    resolver: channelPluginResolver,
    coreApi: channelCoreApi,
    routes: routeRegistry,
    webSockets: webSocketRegistry,
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
  // with no LAN reachability (Fly) simply never gets discovered this way.
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
