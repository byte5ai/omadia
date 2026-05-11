import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import express from 'express';
import cookieParser from 'cookie-parser';
import { config } from './config.js';
import { createTigrisStore } from '@omadia/diagrams';
import type { MemoryStore } from '@omadia/plugin-api';
import { createAdminRouter } from './routes/admin.js';
import { createChatRouter } from './routes/chat.js';
import { createAgentResolver } from './agents/resolveAgentForTool.js';
// `/attachments/<signed-key>` is now mounted by the de.byte5.channel.teams
// plugin via ctx.routes.register (see packages/harness-channel-teams/src/plugin.ts,
// phase-3.1-4). No kernel-side attachment router import needed anymore.
import { createChatSessionsRouter } from './routes/chatSessions.js';
import { createDevGraphRouter } from './routes/devGraph.js';
import { createDevGraphLifecycleRouter } from './routes/devGraphLifecycle.js';
import { createAgentPrioritiesRouter } from './routes/agentPriorities.js';
import { createAdminDomainsRouter } from './routes/adminDomains.js';
import type { LifecycleService } from '@omadia/knowledge-graph-neon/dist/lifecycleService.js';
import type { AgentPrioritiesStore } from '@omadia/plugin-api';
import { createHarnessAdminUiRouter } from './routes/harnessAdminUi.js';
import { createStoreRouter } from './routes/store.js';
import { createInstallRouter } from './routes/install.js';
import { createProfilesRouter } from './routes/profiles.js';
import { createPackagesRouter } from './routes/packages.js';
import { createRuntimeRouter } from './routes/runtime.js';
import { createVaultStatusRouter } from './routes/vaultStatus.js';
import { createBuilderRouter } from './routes/builder.js';
import { DraftStore } from './plugins/builder/draftStore.js';
import { buildDraftStorageMirrorHook } from './plugins/builder/draftStorageBridge.js';
import { DraftQuota } from './plugins/builder/draftQuota.js';
import { PreviewRuntime } from './plugins/builder/previewRuntime.js';
import { PreviewCache } from './plugins/builder/previewCache.js';
import { PreviewSecretBuffer } from './plugins/builder/previewSecretBuffer.js';
import { PreviewRebuildScheduler } from './plugins/builder/previewRebuildScheduler.js';
import { PreviewChatService } from './plugins/builder/previewChatService.js';
import { BuilderAgent } from './plugins/builder/builderAgent.js';
import { SpecEventBus } from './plugins/builder/specEventBus.js';
import { BuilderTurnRingBuffer } from './plugins/builder/turnRingBuffer.js';
import { ensureBuildTemplate } from './plugins/builder/buildTemplate.js';
import { loadBuildTemplateConfig } from './plugins/builder/buildTemplateConfig.js';
import { BuildPipeline } from './plugins/builder/buildPipeline.js';
import { RuntimeSmokeOrchestrator } from './plugins/builder/runtimeSmokeOrchestrator.js';
import { AutoFixOrchestrator } from './plugins/builder/autoFixOrchestrator.js';
import { BuilderModelRegistry } from './plugins/builder/modelRegistry.js';
import { SlotTypecheckPipeline } from './plugins/builder/slotTypecheckPipeline.js';
import { BuildQueue } from './plugins/builder/buildQueue.js';
import { createAuthRouter } from './routes/auth.js';
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
import { EntraProvider } from './auth/providers/EntraProvider.js';
import { runAuthBootstrap } from './auth/bootstrap.js';
import { AdminAuditLog } from './auth/adminAuditLog.js';
import {
  PlatformSettingsStore,
  SETTING_AUTH_ACTIVE_PROVIDERS,
} from './auth/platformSettings.js';
import { createAdminUsersRouter } from './routes/adminUsers.js';
import { createAdminAuthRouter } from './routes/adminAuth.js';
import { PluginCatalog } from './plugins/manifestLoader.js';
import { FileInstalledRegistry } from './plugins/fileInstalledRegistry.js';
import { InstallService } from './plugins/installService.js';
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
import { BackgroundJobRegistry } from './platform/backgroundJobRegistry.js';
import { ChatAgentWrapRegistry } from './platform/chatAgentWrapRegistry.js';
import { PromptContributionRegistry } from './platform/promptContributionRegistry.js';
import { installProcessGuards } from './platform/processGuards.js';
import { PluginRouteRegistry } from './platform/pluginRouteRegistry.js';
import { ServiceRegistry } from './platform/serviceRegistry.js';
import { TurnHookRegistry } from './platform/turnHookRegistry.js';
import { NativeToolRegistry } from '@omadia/orchestrator';
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
import { createCoreApi } from './channels/coreApi.js';
import { DefaultChannelRegistry } from './channels/channelRegistry.js';
import type { ChannelRegistry } from '@omadia/channel-sdk';
import { DynamicChannelPluginResolver } from './channels/dynamicChannelResolver.js';
import type { TurnDispatcher } from './channels/coreApi.js';
import type { FactExtractor } from '@omadia/orchestrator-extras';
import { backfillGraph } from '@omadia/orchestrator-extras';
import { turnContext } from '@omadia/orchestrator';
import type { EntityRefBus, KnowledgeGraph } from '@omadia/plugin-api';
import type { Pool } from 'pg';
import type {
  ChatAgent,
  ChatAgentBundle,
  DomainTool,
} from '@omadia/orchestrator';

// Structural shim for kernel-side reads of plugin-published services. The
// kernel only ever reads the narrow subset of fields below; full plugin
// types stay inside the plugin that publishes the service.
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
  const pluginRouteRegistry = new PluginRouteRegistry();

  // Shared Anthropic client used by sub-agents (LocalSubAgent inner Claude
  // calls) and the Teams channel (anthropicClient dep). The orchestrator-
  // plugin constructs ITS OWN client from `anthropic_api_key` setup-field —
  // they're functionally equivalent but separate instances.
  const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

  // Phase 5B: publish the raw Anthropic client so dynamic-imported channel
  // plugins (Teams, future) can late-resolve it via ctx.services.get(...)
  // instead of constructor-injected Deps. The whitelist-wrapped variant
  // stays under 'llm' for plugins that go through the budget/model gate.
  serviceRegistry.provide('anthropicClient', client);

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
  // Uploaded-Package-Store — muss vor dem Catalog-Load existieren, weil der
  // Catalog die entpackten Manifeste aus diesem Store mergt.
  const uploadedPackagesDir = config.UPLOADED_PACKAGES_DIR;
  const uploadedPackageStore = new UploadedPackageStore(
    path.join(uploadedPackagesDir, 'index.json'),
    uploadedPackagesDir,
  );
  await uploadedPackageStore.load();
  // Damit dynamische Imports aus hochgeladenen Packages ihre peerDependencies
  // finden (Node-Resolver läuft die Dir-Hierarchie hoch, bis er `node_modules/`
  // trifft), legen wir am Packages-Root einen Symlink auf die Host-node_modules.
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

  // Built-in-Packages (im Middleware-Image ausgeliefert, unter
  // middleware/packages/*/manifest.yaml). Gleiche Aktivierungs-Pipeline wie
  // uploaded packages — nur die Package-Quelle unterscheidet sich.
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
  const installedRegistry = new FileInstalledRegistry(
    INSTALLED_REGISTRY_PATH,
  );
  await installedRegistry.load();

  // Kernel-wide background-job scheduler. Plugin-contributed jobs (cron or
  // interval) register here via `ctx.jobs.register(...)`. Bulk teardown on
  // plugin deactivate is owned by each runtime, so a leaked dispose handle
  // still cannot outlive its plugin's lifecycle.
  const jobScheduler = new JobScheduler({
    log: (msg) => console.log(msg),
  });

  // Dynamic-Runtime für hochgeladene Packages — wird weiter unten mit dem
  // Orchestrator verbunden, sobald dieser existiert. Der Install/Uninstall-
  // Service hängt sich als Hook ein, damit Tools hot registriert + abgebaut
  // werden (ohne Middleware-Restart).
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
    serviceRegistry,
    nativeToolRegistry,
    pluginRouteRegistry,
    jobScheduler,
    log: (...a) => console.log(...a),
  });

  // Runtime for `kind: tool` / `kind: extension` plugins. These don't expose
  // a toolkit like agent plugins — their activate() registers directly into
  // the kernel's native-tool / route registries. Same package sources as
  // DynamicAgentRuntime; the two runtimes coordinate by kind-filtering.
  const toolPluginRuntime = new ToolPluginRuntime({
    catalog: pluginCatalog,
    registry: installedRegistry,
    vault: secretVault,
    uploadedStore: uploadedPackageStore,
    builtInStore: builtInPackageStore,
    serviceRegistry,
    nativeToolRegistry,
    pluginRouteRegistry,
    jobScheduler,
    log: (msg) => console.log(msg),
  });

  // Forward reference for the channel registry — constructed later in boot
  // (after the channel-SDK adapters are wired up). The install hooks below
  // close over this variable so post-install activations dispatched to a
  // channel-kind plugin reach the right runtime once it exists.
  let channelRegistryRef: ChannelRegistry | undefined;

  const installService = new InstallService({
    catalog: pluginCatalog,
    registry: installedRegistry,
    vault: secretVault,
    onInstalled: async (agentId) => {
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
      }
    },
    onUninstall: async (agentId) => {
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
        default:
          await dynamicAgentRuntime.deactivate(agentId);
      }
    },
  });
  console.log(
    `[middleware] plugin runtime wired (installed registry + secret vault, persistent) — ${installedRegistry.list().length} installed`,
  );

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
  // Session signing key lives in the vault (`core:auth` scope). First boot
  // generates; every subsequent boot reuses the same key so outstanding
  // cookies stay valid across deploys.
  const sessionSigningKey = await resolveSessionSigningKey(secretVault);
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

  // Integration-contributed tools are registered by the owning plugin's
  // activate() via ctx.tools.register — kernel does no longer build them.
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
  // Dynamic-Agent-Aktivierung: Uploaded-Packages, die im Registry bereits als
  // `active` markiert sind, werden jetzt echt gestartet. `activate()` importiert
  // `dist/plugin.js`, ruft `activate(ctx)` und baut den LocalSubAgent-Wrapper.
  // Fehler pro Agent werden geloggt, brechen Boot aber nicht ab — ein defektes
  // Package soll nicht die ganze Middleware blockieren.
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
  const chatAgentBundle = serviceRegistry.get<ChatAgentBundle>('chatAgent');
  if (!chatAgentBundle) {
    throw new Error(
      '[middleware] chatAgent@1 capability not published — @omadia/orchestrator plugin must be active and `anthropic_api_key` must be set (via .env ANTHROPIC_API_KEY → bootstrapped, or via admin UI on the orchestrator plugin)',
    );
  }
  const orchestrator = chatAgentBundle.raw;
  const chatAgent = chatAgentBundle.agent;
  const chatSessionStore = chatAgentBundle.chatSessionStore;
  // sessionLogger is exposed on the bundle for future channel/route
  // consumers but no longer threaded through the kernel — graphBackfill
  // doesn't need it (uses memoryStore + KG directly), and the chat-API
  // route consumes orchestrator (the bundle.agent) only.
  // Push all kernel-collected DomainTools (native sub-agents + uploaded
  // dynamic agents) into the plugin-built Orchestrator. Plugin construction
  // happens BEFORE these are accumulated, so the registerDomainTool calls
  // here finish the wiring.
  for (const t of domainTools) orchestrator.registerDomainTool(t);
  // Hot-register pathway for future agent installs while the process runs.
  dynamicAgentRuntime.attachOrchestrator(orchestrator);
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
  if (graphPool) {
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
  app.use(express.json({ limit: '10mb' }));
  app.use(cookieParser());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Harness shared assets — currently the admin-UI baseline stylesheet
  // that plugin-bundled admin UIs `<link>` into their HTML. No auth: the
  // CSS is static and operator-agnostic. See PLAN-admin-ui-theming.md.
  app.use('/api/_harness', createHarnessAdminUiRouter());
  console.log('[middleware] harness admin-ui assets ready at /api/_harness/admin-ui.css');

  const agentResolver = createAgentResolver({ dynamicRuntime: dynamicAgentRuntime });
  app.use('/api', createChatRouter(chatAgent, { agentResolver }));

  app.use('/api/chat', createChatSessionsRouter({ store: chatSessionStore }));
  console.log('[middleware] chat-sessions endpoint ready at /api/chat/sessions');

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

    app.use(
      '/api/v1/auth',
      createAuthRouter({
        registry: providerRegistry,
        userStore,
        signingKey: sessionSigningKey,
        publicBaseUrl: config.PUBLIC_BASE_URL,
        defaultReturnPath: config.AUTH_DEFAULT_RETURN_PATH,
        setupAllowed: bootstrapResult.setupRequired,
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

  app.use(
    '/api/v1/store/plugins',
    requireAuth,
    createStoreRouter({ catalog: pluginCatalog, registry: installedRegistry }),
  );
  console.log('[middleware] plugin store endpoints ready at /api/v1/store/plugins (auth: required)');

  app.use(
    '/api/v1/install',
    requireAuth,
    createInstallRouter({ service: installService }),
  );
  console.log('[middleware] plugin install endpoints ready at /api/v1/install (auth: required)');

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
      // Nach einem Re-Upload auf einen bereits installierten Agent (Registry-
      // Eintrag lebt noch, Package wurde gelöscht + neu hochgeladen) aktivieren
      // wir die Runtime direkt — sonst bleibt der Tool unbekannt, bis der User
      // einmal de-/neu-installiert. Bei einem Version-Upgrade mit onMigrate
      // läuft diese Re-Aktivierung mit der bereits migrierten Config.
      onPackageReady: async (agentId) => {
        if (installedRegistry.get(agentId)?.status === 'active') {
          // Falls v1 noch aktiv ist, erst sauber deaktivieren — v2 hat ein
          // frisches DomainTool mit potenziell geänderten Subtools.
          if (dynamicAgentRuntime.isActive(agentId)) {
            await dynamicAgentRuntime.deactivate(agentId);
          }
          await dynamicAgentRuntime.activate(agentId);
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
      reactivate: (agentId) => installService.reactivate(agentId),
    }),
  );
  console.log('[middleware] runtime introspection endpoint ready at /api/v1/admin/runtime (auth: required)');

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
    .then((result) => {
      if (!result.ready) {
        throw new Error(
          `[builder] build template not ready: ${result.reason ?? 'unknown reason'}`,
        );
      }
      console.log(
        `[builder] build template ready (reused=${String(result.reused)}, took ${String(result.durationMs)}ms, npmDeps=${String(Object.keys(buildTemplateConfig.npmDeps).length)}, workspaceDeps=${String(Object.keys(buildTemplateConfig.workspaceDeps).length)})`,
      );
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

  const previewChatService = new PreviewChatService({
    anthropic: client,
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

  const builderAgent = new BuilderAgent({
    anthropic: client,
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
    referenceCatalog: resolveBuilderReferenceCatalog(pluginCatalog),
    templateRoot: BUILDER_BUILD_TEMPLATE_DIR,
    // OB-31 follow-up: a single fill_slot routinely generates whole TS
    // slot bodies (5–15k tokens). The 4096 LocalSubAgent default hit
    // max_tokens mid-input-streaming; the SDK aggregator then drops the
    // truncated `source` field and zod parses `{"slotKey":"…"}` alone —
    // surfacing as the misleading "Required: source" error in the Builder
    // chat. See BUILDER_AGENT_MAX_TOKENS in config.ts.
    subAgentMaxTokens: config.BUILDER_AGENT_MAX_TOKENS,
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
    defaultModel: BuilderModelRegistry.get(BuilderModelRegistry.default()).anthropicModelId,
    resolveModelId: (id) => BuilderModelRegistry.get(id).anthropicModelId,
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
            },
          }
        : {}),
    }),
  );
  console.log(
    `[builder] preview cache initialized (cap=3/user, previews=${BUILDER_PREVIEWS_DIR}, orphans-cleared=${String(orphanResult.removed)})`,
  );
  console.log(
    `[middleware] agent-builder endpoints ready at /api/v1/builder (db=${DRAFTS_DB_PATH}, auth: required)`,
  );

  if (config.ADMIN_TOKEN && config.ADMIN_TOKEN.length > 0) {
    app.use('/api/admin', createAdminRouter({ store: memoryStore, token: config.ADMIN_TOKEN }));
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

  // Placeholder TurnDispatcher: real wiring to orchestrator.chatStream lands
  // when Teams gets ported (Slice 2.3). Until then the CoreApi is callable
  // but yields nothing, so any premature channel activation is visible in
  // logs without causing a crash.
  const stubDispatcher: TurnDispatcher = {
    // eslint-disable-next-line require-yield
    async *streamTurn(input) {
      console.warn(
        `[channels] stub dispatcher: turn ignored (scope=${input.scope}, user=${input.userRef.kind}:${input.userRef.id})`,
      );
    },
  };

  const channelCoreApi = createCoreApi({
    dispatcher: stubDispatcher,
    routes: routeRegistry,
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
    jobScheduler,
    resolver: channelPluginResolver,
    coreApi: channelCoreApi,
    routes: routeRegistry,
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

  // Bind dual-stack on :: so both IPv6 (Fly-Edge default + flycast) and
  // IPv4 (legacy + local dev) clients are served. Default `0.0.0.0` would
  // miss IPv6-only Fly-internal traffic — Stolperfalle #4 in
  // memory/feedback-fly-operational.
  const server = app.listen(config.PORT, '::', () => {
    console.log(`[middleware] listening on [::]:${config.PORT}`);
    console.log(`[middleware] memory dir: ${config.MEMORY_DIR}`);
    console.log(`[middleware] skills dir: ${config.SKILLS_DIR}`);
    console.log(`[middleware] orchestrator model: ${config.ORCHESTRATOR_MODEL}`);
    console.log(`[middleware] sub-agent model:   ${config.SUB_AGENT_MODEL}`);
    console.log(`[middleware] domain tools: ${domainTools.map((t) => t.name).join(', ')}`);
  });

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
