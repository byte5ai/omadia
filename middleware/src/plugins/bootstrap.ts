import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { parseCapabilityRef } from '@omadia/plugin-api';

import type { Config } from '../config.js';
import type { BuiltInPackageStore } from './builtInPackageStore.js';
import { findCapabilityProvidersInCatalog } from './capabilityResolver.js';
import type { InstalledAgent, InstalledRegistry } from './installedRegistry.js';
import type { PluginCatalog } from './manifestLoader.js';
import type { SecretVault } from '../secrets/vault.js';
import type { UploadedPackageStore } from './uploadedPackageStore.js';

const DIAGRAMS_TOOL_ID = '@omadia/diagrams';
const EMBEDDINGS_TOOL_ID = '@omadia/embeddings';
const MEMORY_TOOL_ID = '@omadia/memory';
const ORCHESTRATOR_TOOL_ID = '@omadia/orchestrator';
const ORCHESTRATOR_EXTRAS_TOOL_ID = '@omadia/orchestrator-extras';
const VERIFIER_TOOL_ID = '@omadia/verifier';

// S+11-2b: KG providers are operator-managed (RequiresWizard / install UI).
// Both sibling plugins declare `provides: knowledgeGraph@1` —
// mutual exclusion, only one may live in installed.json at a time.
// `bootstrapKnowledgeGraphFromEnv` picks one based on DATABASE_URL;
// the catch-all `bootstrapBuiltInPackages` explicitly skips both sibling IDs
// so it does not register the other provider with `config={}` alongside the
// chosen one (which would blow up on the first activate step with a
// "duplicate-provider" throw from `ctx.services.provide`).
//
// The legacy plugin ID `de.byte5.tool.knowledge-graph` (now a deprecated
// shell, S+11-2b) is skipped by the catch-all too — `bootstrapKnowledgeGraphFromEnv`
// migrates any pre-S+11-2b installation once via `registry.remove`.
const KNOWLEDGE_GRAPH_LEGACY_ID = 'de.byte5.tool.knowledge-graph';
const KNOWLEDGE_GRAPH_INMEMORY_ID = '@omadia/knowledge-graph-inmemory';
const KNOWLEDGE_GRAPH_NEON_ID = '@omadia/knowledge-graph-neon';
const KNOWLEDGE_GRAPH_PROVIDER_IDS_SKIP_AUTO_INSTALL = new Set<string>([
  KNOWLEDGE_GRAPH_LEGACY_ID,
  KNOWLEDGE_GRAPH_INMEMORY_ID,
  KNOWLEDGE_GRAPH_NEON_ID,
]);

/**
 * One-time migrations from the legacy `.env`-driven world into the new
 * per-agent vault + installed-registry. Runs at middleware startup, before
 * any sub-agent is constructed.
 *
 * Design rules (do not violate):
 *   1. Idempotent. Running bootstrap twice is a no-op after the first run.
 *   2. Non-destructive. The `.env` values are never modified or removed.
 *   3. Bootstrap only writes. It never reads from the vault first to "merge"
 *      — if the agent is already installed, we skip entirely. That preserves
 *      the user's explicitly-entered values from the install UI.
 *   4. Logs loudly. The first time it migrates, the operator sees exactly
 *      which agent and which keys were moved.
 */

export interface BootstrapDeps {
  config: Config;
  catalog: PluginCatalog;
  registry: InstalledRegistry;
  vault: SecretVault;
  /** In-image packages under `middleware/packages/*`. Optional — when
   *  omitted, only legacy .env-based bootstrapping runs. */
  builtInStore?: BuiltInPackageStore;
  log?: (msg: string) => void;
}

// ---------------------------------------------------------------------------
// S+8.5 sub-commit-3 — Errored-status auto-reset.
// ---------------------------------------------------------------------------
//
// Plugins whose activation failed past the circuit-breaker threshold flip
// to `status: 'errored'` and are skipped on subsequent boots. Without an
// auto-reset path they stay stuck forever — even after the operator has
// fixed the underlying issue. This function runs at boot, before
// `toolPluginRuntime.activateAllInstalled`, and lifts errored entries that
// are clearly fixable.
//
// John's architecture (Briefing-Fork-#5): file-mtime OR cap-resolution.
//
//   - File-mtime path: if the package's `manifest.yaml` was modified more
//     recently than `last_activation_error_at`, the operator has clearly
//     touched the plugin (likely the fix). We don't try to be clever
//     about whether the change actually addresses the failure — the
//     activation will be re-tried, and if it fails again the circuit
//     breaker re-trips on its own.
//
//   - Capability-resolution path: if the entry recorded
//     `unresolved_requires` on its last failed activation, we re-check
//     whether every cap is now provided by an active installed plugin.
//     If yes (operator installed the missing provider in the meantime),
//     reset. We deliberately check *active* providers only — an
//     `errored`/`inactive` provider doesn't satisfy the contract.

export interface RetryErroredPluginsDeps {
  catalog: PluginCatalog;
  registry: InstalledRegistry;
  builtInStore?: BuiltInPackageStore;
  uploadedStore?: UploadedPackageStore;
  log?: (msg: string) => void;
}

export async function retryErroredPlugins(
  deps: RetryErroredPluginsDeps,
): Promise<void> {
  const log = deps.log ?? ((m) => console.log(m));

  for (const entry of deps.registry.list()) {
    if (entry.status !== 'errored') continue;

    const reasons: string[] = [];

    const mtimeReason = await maybeMtimeReason(deps, entry);
    if (mtimeReason) reasons.push(mtimeReason);

    const capReason = maybeCapResolutionReason(deps, entry);
    if (capReason) reasons.push(capReason);

    if (reasons.length === 0) continue;

    try {
      await deps.registry.clearActivationError(entry.id);
      log(
        `[bootstrap] ⚐ reset ${entry.id} status:errored→active — ${reasons.join('; ')}`,
      );
    } catch (err) {
      log(
        `[bootstrap] clearActivationError FAILED for ${entry.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

async function maybeMtimeReason(
  deps: RetryErroredPluginsDeps,
  entry: InstalledAgent,
): Promise<string | null> {
  if (!entry.last_activation_error_at) return null;
  const pkgPath = resolvePackagePath(deps, entry.id);
  if (!pkgPath) return null;
  const manifestPath = path.join(pkgPath, 'manifest.yaml');
  try {
    const stat = await fs.stat(manifestPath);
    const mtimeIso = stat.mtime.toISOString();
    if (mtimeIso > entry.last_activation_error_at) {
      return `manifest.yaml mtime ${mtimeIso} > last_activation_error_at ${entry.last_activation_error_at}`;
    }
  } catch {
    // Missing manifest — stay stuck. Operator may have removed the
    // package entirely; unrelated cleanup will surface that.
  }
  return null;
}

function maybeCapResolutionReason(
  deps: RetryErroredPluginsDeps,
  entry: InstalledAgent,
): string | null {
  const pending = entry.unresolved_requires ?? [];
  if (pending.length === 0) return null;
  for (const rawReq of pending) {
    if (!hasActiveProvider(deps, rawReq)) return null;
  }
  return `all unresolved_requires now satisfied by active providers (${pending.join(', ')})`;
}

function hasActiveProvider(
  deps: RetryErroredPluginsDeps,
  rawReq: string,
): boolean {
  let req;
  try {
    req = parseCapabilityRef(rawReq);
  } catch {
    return false;
  }
  const candidates = findCapabilityProvidersInCatalog(deps.catalog, req);
  for (const cand of candidates) {
    const installed = deps.registry.get(cand.plugin.id);
    if (installed?.status === 'active') return true;
  }
  return false;
}

function resolvePackagePath(
  deps: RetryErroredPluginsDeps,
  agentId: string,
): string | undefined {
  const uploaded = deps.uploadedStore?.get(agentId);
  if (uploaded) return uploaded.path;
  const builtIn = deps.builtInStore?.get(agentId);
  if (builtIn) return builtIn.path;
  return undefined;
}

export async function runLegacyBootstrap(deps: BootstrapDeps): Promise<void> {
  // bootstrapConfluenceFromEnv + bootstrapOdooFromEnv removed in Phase 5B
  // M3+M4 catch-up — those byte5-customer integrations no longer ship in
  // the public core. Operators install them via Admin-UI ZIP upload and
  // configure credentials through the plugin's setup form instead.
  await bootstrapMicrosoft365FromEnv(deps);
  await bootstrapTelegramFromEnv(deps);
  await bootstrapDiagramsFromEnv(deps);
  await bootstrapMemoryFromEnv(deps);
  await bootstrapEmbeddingsFromEnv(deps);
  await bootstrapKnowledgeGraphFromEnv(deps);
  await bootstrapOrchestratorExtrasFromEnv(deps);
  await bootstrapVerifierFromEnv(deps);
  await bootstrapOrchestratorFromEnv(deps);
  if (deps.builtInStore) {
    await bootstrapBuiltInPackages(deps);
  }
}

// ---------------------------------------------------------------------------
// S+12.6 Vault-Migration helper for anthropic_api_key
// ---------------------------------------------------------------------------

/**
 * Idempotent migration: pre-S+12.6 boots stored `anthropic_api_key` in the
 * plugin's installed.json config; from now on it lives in the per-plugin
 * vault (matches `database_url` post-S+12.5-3 and `telegram_bot_token`).
 *
 * Fires only when the registry entry has the key in config AND the vault
 * doesn't already have one. write-before-clear (Rule #37) — vault gets the
 * value first, then the config entry is re-registered without it.
 *
 * Used by `bootstrapOrchestratorExtrasFromEnv`, `bootstrapVerifierFromEnv`,
 * and `bootstrapOrchestratorFromEnv`. Same logic, three call sites — DRY
 * via this helper.
 */
async function migrateAnthropicKeyToVault(
  deps: BootstrapDeps,
  toolId: string,
  log: (m: string) => void,
): Promise<void> {
  if (!deps.registry.has(toolId)) return;
  const entry = deps.registry.get(toolId);
  const keyInConfig = entry?.config?.['anthropic_api_key'];
  if (typeof keyInConfig !== 'string' || keyInConfig.length === 0) return;
  const keyInVault = await deps.vault.get(toolId, 'anthropic_api_key');
  if (keyInVault) return;
  await deps.vault.setMany(toolId, { anthropic_api_key: keyInConfig });
  const newConfig = { ...entry!.config };
  delete newConfig['anthropic_api_key'];
  await deps.registry.register({
    ...entry!,
    config: newConfig,
  });
  log(
    `[bootstrap] ⚐ migrated anthropic_api_key for ${toolId}: installed.json config → vault (S+12.6 hardening)`,
  );
}

// ---------------------------------------------------------------------------
// Memory (extension-kind built-in, no secrets → always auto-install)
// ---------------------------------------------------------------------------

/**
 * Seeds `@omadia/memory` into the registry on first boot, migrating
 * the legacy MEMORY_DIR / MEMORY_SEED_DIR / MEMORY_SEED_MODE env vars into
 * per-plugin config. Runs before `bootstrapBuiltInPackages` so the memory
 * plugin lands with the proper config instead of the empty auto-install
 * default that would miss the env-provided paths.
 *
 * Idempotent: once the registry entry exists we never overwrite the
 * operator's settings.
 */
async function bootstrapMemoryFromEnv(deps: BootstrapDeps): Promise<void> {
  const log = deps.log ?? ((m) => console.log(m));

  if (deps.registry.has(MEMORY_TOOL_ID)) return;

  const catalogEntry = deps.catalog.get(MEMORY_TOOL_ID);
  if (!catalogEntry) {
    log(
      `[bootstrap] cannot migrate ${MEMORY_TOOL_ID}: not in plugin catalog (built-in package not picked up?)`,
    );
    return;
  }

  await deps.registry.register({
    id: MEMORY_TOOL_ID,
    installed_version: catalogEntry.plugin.version,
    installed_at: new Date().toISOString(),
    status: 'active',
    config: {
      memory_dir: deps.config.MEMORY_DIR,
      seed_dir: deps.config.MEMORY_SEED_DIR,
      seed_mode: deps.config.MEMORY_SEED_MODE,
      dev_memory_endpoints_enabled: deps.config.DEV_ENDPOINTS_ENABLED
        ? 'true'
        : 'false',
    },
  });

  log(
    `[bootstrap] ⚐ auto-installed ${MEMORY_TOOL_ID} (memory_dir=${deps.config.MEMORY_DIR}, seed_mode=${deps.config.MEMORY_SEED_MODE})`,
  );
}

// ---------------------------------------------------------------------------
// Embeddings (extension-kind built-in, no secrets → always auto-install)
// ---------------------------------------------------------------------------

/**
 * Seeds `@omadia/embeddings` into the registry on first boot,
 * migrating the legacy OLLAMA_BASE_URL / OLLAMA_EMBEDDING_MODEL /
 * GRAPH_EMBEDDING_MAX_CONCURRENT env vars into per-plugin config so
 * the plugin's activate() (S+9.1 sub-commit 2b) can build the client
 * via `ctx.config.get` instead of reading env directly.
 *
 * **Always registers**, even when `OLLAMA_BASE_URL` is empty. The
 * plugin's activate() handles the empty case (logs + skips
 * `ctx.services.provide`); leaving it un-registered would make
 * the S+8.5 capability-resolver drop the @omadia/knowledge-graph
 * plugin (which now declares `requires: ["embeddingClient@^1"]`) on
 * every boot.
 *
 * Idempotent: once the registry entry exists we never overwrite the
 * operator's settings.
 */
async function bootstrapEmbeddingsFromEnv(deps: BootstrapDeps): Promise<void> {
  const log = deps.log ?? ((m) => console.log(m));

  if (deps.registry.has(EMBEDDINGS_TOOL_ID)) return;

  const catalogEntry = deps.catalog.get(EMBEDDINGS_TOOL_ID);
  if (!catalogEntry) {
    log(
      `[bootstrap] cannot migrate ${EMBEDDINGS_TOOL_ID}: not in plugin catalog (built-in package not picked up?)`,
    );
    return;
  }

  const config: Record<string, unknown> = {};
  if (deps.config.OLLAMA_BASE_URL) {
    config['ollama_base_url'] = deps.config.OLLAMA_BASE_URL;
  }
  if (deps.config.OLLAMA_EMBEDDING_MODEL) {
    config['ollama_model'] = deps.config.OLLAMA_EMBEDDING_MODEL;
  }
  if (
    typeof deps.config.GRAPH_EMBEDDING_MAX_CONCURRENT === 'number' &&
    Number.isFinite(deps.config.GRAPH_EMBEDDING_MAX_CONCURRENT)
  ) {
    config['max_concurrent'] = deps.config.GRAPH_EMBEDDING_MAX_CONCURRENT;
  }

  await deps.registry.register({
    id: EMBEDDINGS_TOOL_ID,
    installed_version: catalogEntry.plugin.version,
    installed_at: new Date().toISOString(),
    status: 'active',
    config,
  });

  log(
    `[bootstrap] ⚐ auto-installed ${EMBEDDINGS_TOOL_ID} (ollama_base_url=${deps.config.OLLAMA_BASE_URL ?? '(unset → no client published)'})`,
  );
}

// ---------------------------------------------------------------------------
// Orchestrator-Extras (extension-kind built-in, optional Anthropic key →
// always auto-install)
// ---------------------------------------------------------------------------

/**
 * Seeds `@omadia/orchestrator-extras` into the registry on first
 * boot, migrating the legacy ANTHROPIC_API_KEY / TOPIC_CLASSIFIER_MODEL /
 * TOPIC_UPPER_THRESHOLD / TOPIC_LOWER_THRESHOLD env vars into per-plugin
 * config so the plugin's activate() (S+9.2 sub-commit 2b) can build the
 * three tool-set classes via `ctx.config.get` instead of reading env
 * directly.
 *
 * **Always registers**, even when `ANTHROPIC_API_KEY` is empty. The
 * plugin's activate() handles the empty case (logs + skips publishing
 * factExtractor + topicDetector capabilities); leaving it un-registered
 * would make the S+8.5 capability-resolver drop any consumer plugin that
 * later declares `requires: ["topicDetector@^1"]` etc.
 *
 * Idempotent: once the registry entry exists we never overwrite the
 * operator's settings.
 */
// ---------------------------------------------------------------------------
// Knowledge-graph providers (S+11-2b)
// ---------------------------------------------------------------------------

/**
 * Migrates the legacy `de.byte5.tool.knowledge-graph` registry entry (now a
 * deprecated no-op shell) to one of the two new sibling provider plugins:
 *
 *   - `@omadia/knowledge-graph-neon`     when DATABASE_URL is set
 *   - `@omadia/knowledge-graph-inmemory` otherwise (Empty-Middleware-
 *                                              Demo / local dev / CI)
 *
 * Mutual exclusion: both new plugins declare `provides: knowledgeGraph@1`
 * — the resolver / `ctx.services.provide` only allows one active provider
 * for a given capability. This function picks one based on env; the catch-
 * all `bootstrapBuiltInPackages` skips the other (KNOWLEDGE_GRAPH_PROVIDER_IDS_SKIP_AUTO_INSTALL).
 *
 * Idempotent: once the chosen target is in the registry, subsequent boots
 * are no-ops and respect operator-set values. The legacy-entry uninstall
 * runs at most once (idempotent on `registry.has(LEGACY_ID)`).
 *
 * Operator-Switch-Story: to flip between inmemory ↔ neon, the operator
 * uninstalls the active provider in the install UI, sets/clears DATABASE_URL,
 * and triggers the install of the desired sibling. Bootstrap does NOT
 * auto-flip between the two on subsequent boots — once a provider is
 * installed, it stays installed regardless of env changes.
 */
async function bootstrapKnowledgeGraphFromEnv(
  deps: BootstrapDeps,
): Promise<void> {
  const log = deps.log ?? ((m) => console.log(m));

  // Step 1: migrate the legacy entry once. Capability ownership moved in
  // S+11-2b to the sibling plugins; the legacy plugin's activate() is now a
  // no-op shell, so leaving the entry in installed.json would just clutter
  // the install UI.
  if (deps.registry.has(KNOWLEDGE_GRAPH_LEGACY_ID)) {
    await deps.registry.remove(KNOWLEDGE_GRAPH_LEGACY_ID);
    log(
      `[bootstrap] ⚐ migrated ${KNOWLEDGE_GRAPH_LEGACY_ID} → uninstalled (capability ownership moved to ${KNOWLEDGE_GRAPH_INMEMORY_ID} or ${KNOWLEDGE_GRAPH_NEON_ID} in S+11-2b)`,
    );
  }

  // Step 1.5 (S+12.5-3): pre-S+12.5-3 boots may have stored database_url
  // in the neon plugin's installed.json config (legacy storage). Migrate
  // it to the vault on first post-S+12.5-3 boot — idempotent: only when
  // config has a value AND vault doesn't already have one.
  if (deps.registry.has(KNOWLEDGE_GRAPH_NEON_ID)) {
    const entry = deps.registry.get(KNOWLEDGE_GRAPH_NEON_ID);
    const dsnInConfig = entry?.config?.['database_url'];
    if (typeof dsnInConfig === 'string' && dsnInConfig.length > 0) {
      const dsnInVault = await deps.vault.get(
        KNOWLEDGE_GRAPH_NEON_ID,
        'database_url',
      );
      if (!dsnInVault) {
        await deps.vault.setMany(KNOWLEDGE_GRAPH_NEON_ID, {
          database_url: dsnInConfig,
        });
        const newConfig = { ...entry!.config };
        delete newConfig['database_url'];
        await deps.registry.register({
          ...entry!,
          config: newConfig,
        });
        log(
          `[bootstrap] ⚐ migrated database_url for ${KNOWLEDGE_GRAPH_NEON_ID}: installed.json config → vault (S+12.5-3 hardening)`,
        );
      }
    }
  }

  // Step 2: pick the provider based on DATABASE_URL. (S+12.5-2: lifted
  // from raw `process.env` to the Config-Zod schema so the input boundary
  // is validated + empty-string is normalized to `undefined`. Persistent
  // storage of the resolved DSN still lives in installed.json config until
  // S+12.5-3 migrates it to the Vault.)
  const databaseUrl = deps.config.DATABASE_URL;
  const targetId = databaseUrl
    ? KNOWLEDGE_GRAPH_NEON_ID
    : KNOWLEDGE_GRAPH_INMEMORY_ID;
  const otherId = databaseUrl
    ? KNOWLEDGE_GRAPH_INMEMORY_ID
    : KNOWLEDGE_GRAPH_NEON_ID;

  // Mutual exclusion: respect an operator-managed switch to the sibling.
  if (deps.registry.has(otherId)) {
    log(
      `[bootstrap] ${otherId} already installed — skipping ${targetId} migration (operator-managed)`,
    );
    return;
  }

  // Idempotent: preserve operator settings on subsequent boots.
  if (deps.registry.has(targetId)) return;

  const catalogEntry = deps.catalog.get(targetId);
  if (!catalogEntry) {
    log(
      `[bootstrap] cannot migrate ${targetId}: not in plugin catalog (built-in package not picked up?)`,
    );
    return;
  }

  // S+12.5-3: database_url goes to the vault, not installed.json config.
  // Vault is namespaced by agent_id and persists separately from registry
  // state, matching telegram_bot_token-style hardening.
  if (databaseUrl) {
    await deps.vault.setMany(targetId, {
      database_url: databaseUrl,
    });
  }

  const config: Record<string, unknown> = {};
  // GRAPH_TENANT_ID is in Config (default 'default'). Carry it forward only
  // when explicitly set, so the registry doesn't pin a default that would
  // outlive a future schema-default-change.
  if (deps.config.GRAPH_TENANT_ID && deps.config.GRAPH_TENANT_ID !== 'default') {
    config['graph_tenant_id'] = deps.config.GRAPH_TENANT_ID;
  }
  if (databaseUrl) {
    // Backfill knobs only matter for the Neon backend.
    config['graph_embedding_backfill_enabled'] = String(
      deps.config.GRAPH_EMBEDDING_BACKFILL_ENABLED,
    );
    config['graph_embedding_backfill_interval_minutes'] = String(
      deps.config.GRAPH_EMBEDDING_BACKFILL_INTERVAL_MINUTES,
    );
    config['graph_embedding_backfill_batch_size'] = String(
      deps.config.GRAPH_EMBEDDING_BACKFILL_BATCH_SIZE,
    );
    config['graph_embedding_backfill_max_attempts'] = String(
      deps.config.GRAPH_EMBEDDING_BACKFILL_MAX_ATTEMPTS,
    );
  }

  await deps.registry.register({
    id: targetId,
    installed_version: catalogEntry.plugin.version,
    installed_at: new Date().toISOString(),
    status: 'active',
    config,
  });

  log(
    `[bootstrap] ⚐ auto-installed ${targetId} (database_url=${databaseUrl ? '(set)' : '(unset → in-memory backend)'})`,
  );
}

async function bootstrapOrchestratorExtrasFromEnv(
  deps: BootstrapDeps,
): Promise<void> {
  const log = deps.log ?? ((m) => console.log(m));

  // S+12.6: migrate pre-S+12.6 anthropic_api_key from config to vault.
  await migrateAnthropicKeyToVault(deps, ORCHESTRATOR_EXTRAS_TOOL_ID, log);

  if (deps.registry.has(ORCHESTRATOR_EXTRAS_TOOL_ID)) return;

  const catalogEntry = deps.catalog.get(ORCHESTRATOR_EXTRAS_TOOL_ID);
  if (!catalogEntry) {
    log(
      `[bootstrap] cannot migrate ${ORCHESTRATOR_EXTRAS_TOOL_ID}: not in plugin catalog (built-in package not picked up?)`,
    );
    return;
  }

  // S+12.6: anthropic_api_key moves to the vault (matches database_url pattern).
  if (deps.config.ANTHROPIC_API_KEY) {
    await deps.vault.setMany(ORCHESTRATOR_EXTRAS_TOOL_ID, {
      anthropic_api_key: deps.config.ANTHROPIC_API_KEY,
    });
  }

  const config: Record<string, unknown> = {};
  if (deps.config.TOPIC_CLASSIFIER_MODEL) {
    config['fact_extractor_model'] = deps.config.TOPIC_CLASSIFIER_MODEL;
    config['topic_classifier_model'] = deps.config.TOPIC_CLASSIFIER_MODEL;
  }
  if (
    typeof deps.config.TOPIC_UPPER_THRESHOLD === 'number' &&
    Number.isFinite(deps.config.TOPIC_UPPER_THRESHOLD)
  ) {
    config['topic_upper_threshold'] = deps.config.TOPIC_UPPER_THRESHOLD;
  }
  if (
    typeof deps.config.TOPIC_LOWER_THRESHOLD === 'number' &&
    Number.isFinite(deps.config.TOPIC_LOWER_THRESHOLD)
  ) {
    config['topic_lower_threshold'] = deps.config.TOPIC_LOWER_THRESHOLD;
  }

  await deps.registry.register({
    id: ORCHESTRATOR_EXTRAS_TOOL_ID,
    installed_version: catalogEntry.plugin.version,
    installed_at: new Date().toISOString(),
    status: 'active',
    config,
  });

  log(
    `[bootstrap] ⚐ auto-installed ${ORCHESTRATOR_EXTRAS_TOOL_ID} (anthropic_api_key=${deps.config.ANTHROPIC_API_KEY ? '(set)' : '(unset → FactExtractor + TopicDetector capabilities not published)'})`,
  );
}

// ---------------------------------------------------------------------------
// Verifier (extension-kind built-in, optional Anthropic key + opt-in flag →
// always auto-install)
// ---------------------------------------------------------------------------

/**
 * Seeds `@omadia/verifier` into the registry on first boot,
 * migrating the legacy ANTHROPIC_API_KEY / VERIFIER_ENABLED /
 * VERIFIER_MODE / VERIFIER_MODEL / VERIFIER_MAX_CLAIMS /
 * VERIFIER_AMOUNT_TOLERANCE / VERIFIER_MAX_RETRIES / GRAPH_TENANT_ID
 * env vars into per-plugin config so the plugin's activate() (S+9.3
 * sub-commit 2b) can build the pipeline via `ctx.config.get` instead
 * of reading env directly.
 *
 * **Always registers**, even when `VERIFIER_ENABLED` is false or
 * `ANTHROPIC_API_KEY` is empty. The plugin's activate() handles both
 * cases (logs + skips publishing `verifier@1`); leaving the entry
 * un-registered would lock the operator out of toggling the verifier
 * later through the install UI.
 *
 * Idempotent: once the registry entry exists we never overwrite the
 * operator's settings.
 */
async function bootstrapVerifierFromEnv(
  deps: BootstrapDeps,
): Promise<void> {
  const log = deps.log ?? ((m) => console.log(m));

  // S+12.6: migrate pre-S+12.6 anthropic_api_key from config to vault.
  await migrateAnthropicKeyToVault(deps, VERIFIER_TOOL_ID, log);

  if (deps.registry.has(VERIFIER_TOOL_ID)) return;

  const catalogEntry = deps.catalog.get(VERIFIER_TOOL_ID);
  if (!catalogEntry) {
    log(
      `[bootstrap] cannot migrate ${VERIFIER_TOOL_ID}: not in plugin catalog (built-in package not picked up?)`,
    );
    return;
  }

  // S+12.6: anthropic_api_key moves to the vault.
  if (deps.config.ANTHROPIC_API_KEY) {
    await deps.vault.setMany(VERIFIER_TOOL_ID, {
      anthropic_api_key: deps.config.ANTHROPIC_API_KEY,
    });
  }

  const config: Record<string, unknown> = {};
  config['verifier_enabled'] = deps.config.VERIFIER_ENABLED ? 'true' : 'false';
  config['verifier_mode'] = deps.config.VERIFIER_MODE;
  config['verifier_model'] = deps.config.VERIFIER_MODEL;
  config['verifier_max_claims'] = deps.config.VERIFIER_MAX_CLAIMS;
  config['verifier_amount_tolerance'] = deps.config.VERIFIER_AMOUNT_TOLERANCE;
  config['verifier_max_retries'] = deps.config.VERIFIER_MAX_RETRIES;
  if (deps.config.GRAPH_TENANT_ID) {
    config['graph_tenant_id'] = deps.config.GRAPH_TENANT_ID;
  }

  await deps.registry.register({
    id: VERIFIER_TOOL_ID,
    installed_version: catalogEntry.plugin.version,
    installed_at: new Date().toISOString(),
    status: 'active',
    config,
  });

  log(
    `[bootstrap] ⚐ auto-installed ${VERIFIER_TOOL_ID} (verifier_enabled=${deps.config.VERIFIER_ENABLED ? 'true' : 'false'}, mode=${deps.config.VERIFIER_MODE}, anthropic_api_key=${deps.config.ANTHROPIC_API_KEY ? '(set)' : '(unset → verifier@1 capability not published)'})`,
  );
}

// ---------------------------------------------------------------------------
// Orchestrator (S+10-4a — extension-kind built-in, plugin-owned construction)
// ---------------------------------------------------------------------------

/**
 * Seeds `@omadia/orchestrator` into the registry on first boot,
 * migrating ANTHROPIC_API_KEY + ORCHESTRATOR_MODEL + ORCHESTRATOR_MAX_TOKENS
 * + MAX_TOOL_ITERATIONS into per-plugin config. The plugin's activate()
 * reads these to construct the Anthropic client + Orchestrator-Class +
 * five native tools + ChatSessionStore + SessionLogger and publishes
 * `chatAgent@1`. Without ANTHROPIC_API_KEY → activate() returns a no-op
 * handle, the capability is NOT published, and channel-plugins (after
 * S+10-4b's `requires: ["chatAgent@^1"]`) skip activation.
 *
 * Always-Register-Pattern (S+9.1 Rule #8): runs even without ANTHROPIC_API_KEY
 * so the plugin shows up in the catalog/admin UI. Activation-time
 * graceful-degrade does the real gating.
 *
 * Idempotent: once the registry entry exists we never overwrite the
 * operator's settings.
 */
async function bootstrapOrchestratorFromEnv(
  deps: BootstrapDeps,
): Promise<void> {
  const log = deps.log ?? ((m) => console.log(m));

  // S+12.6: migrate pre-S+12.6 anthropic_api_key from config to vault.
  await migrateAnthropicKeyToVault(deps, ORCHESTRATOR_TOOL_ID, log);

  if (deps.registry.has(ORCHESTRATOR_TOOL_ID)) return;

  const catalogEntry = deps.catalog.get(ORCHESTRATOR_TOOL_ID);
  if (!catalogEntry) {
    log(
      `[bootstrap] cannot migrate ${ORCHESTRATOR_TOOL_ID}: not in plugin catalog (built-in package not picked up?)`,
    );
    return;
  }

  // S+12.6: anthropic_api_key moves to the vault.
  if (deps.config.ANTHROPIC_API_KEY) {
    await deps.vault.setMany(ORCHESTRATOR_TOOL_ID, {
      anthropic_api_key: deps.config.ANTHROPIC_API_KEY,
    });
  }

  const config: Record<string, unknown> = {};
  config['orchestrator_model'] = deps.config.ORCHESTRATOR_MODEL;
  config['orchestrator_max_tokens'] = String(
    deps.config.ORCHESTRATOR_MAX_TOKENS,
  );
  config['max_tool_iterations'] = String(deps.config.MAX_TOOL_ITERATIONS);

  await deps.registry.register({
    id: ORCHESTRATOR_TOOL_ID,
    installed_version: catalogEntry.plugin.version,
    installed_at: new Date().toISOString(),
    status: 'active',
    config,
  });

  log(
    `[bootstrap] ⚐ auto-installed ${ORCHESTRATOR_TOOL_ID} (model=${deps.config.ORCHESTRATOR_MODEL}, anthropic_api_key=${deps.config.ANTHROPIC_API_KEY ? '(set)' : '(unset → chatAgent@1 capability not published)'})`,
  );
}

// ---------------------------------------------------------------------------
// Diagrams (tool-kind built-in, needs secrets → can't auto-install)
// ---------------------------------------------------------------------------

async function bootstrapDiagramsFromEnv(deps: BootstrapDeps): Promise<void> {
  const log = deps.log ?? ((m) => console.log(m));

  if (deps.registry.has(DIAGRAMS_TOOL_ID)) return;

  const {
    KROKI_BASE_URL,
    DIAGRAM_URL_SECRET,
    DIAGRAM_PUBLIC_BASE_URL,
    BUCKET_NAME,
    AWS_ENDPOINT_URL_S3,
    AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY,
    GRAPH_TENANT_ID,
    DIAGRAM_SIGNED_URL_TTL_SEC,
    DIAGRAM_MAX_SOURCE_BYTES,
    DIAGRAM_MAX_PNG_BYTES,
  } = deps.config;

  const envHasMinimum =
    Boolean(KROKI_BASE_URL) &&
    Boolean(DIAGRAM_URL_SECRET) &&
    Boolean(DIAGRAM_PUBLIC_BASE_URL) &&
    Boolean(BUCKET_NAME) &&
    Boolean(AWS_ENDPOINT_URL_S3) &&
    Boolean(AWS_ACCESS_KEY_ID) &&
    Boolean(AWS_SECRET_ACCESS_KEY);
  if (!envHasMinimum) {
    log(
      `[bootstrap] diagrams tool: .env lacks one of KROKI_BASE_URL / DIAGRAM_* / BUCKET_NAME / AWS_* — skipping auto-install`,
    );
    return;
  }

  const catalogEntry = deps.catalog.get(DIAGRAMS_TOOL_ID);
  if (!catalogEntry) {
    log(
      `[bootstrap] cannot migrate ${DIAGRAMS_TOOL_ID}: not in plugin catalog (built-in package not picked up?)`,
    );
    return;
  }

  await deps.vault.setMany(DIAGRAMS_TOOL_ID, {
    diagram_url_secret: DIAGRAM_URL_SECRET as string,
    aws_access_key_id: AWS_ACCESS_KEY_ID as string,
    aws_secret_access_key: AWS_SECRET_ACCESS_KEY as string,
  });

  await deps.registry.register({
    id: DIAGRAMS_TOOL_ID,
    installed_version: catalogEntry.plugin.version,
    installed_at: new Date().toISOString(),
    status: 'active',
    config: {
      kroki_base_url: KROKI_BASE_URL as string,
      public_base_url: DIAGRAM_PUBLIC_BASE_URL as string,
      tigris_endpoint: AWS_ENDPOINT_URL_S3 as string,
      tigris_bucket: BUCKET_NAME as string,
      ...(GRAPH_TENANT_ID ? { tenant_id: GRAPH_TENANT_ID } : {}),
      signed_url_ttl_sec: DIAGRAM_SIGNED_URL_TTL_SEC,
      max_source_bytes: DIAGRAM_MAX_SOURCE_BYTES,
      max_png_bytes: DIAGRAM_MAX_PNG_BYTES,
    },
  });

  log(
    `[bootstrap] ⚐ migrated ${DIAGRAMS_TOOL_ID} from .env — kroki/tigris config → registry, hmac + aws creds → vault`,
  );
}

// ---------------------------------------------------------------------------
// Built-in packages (shipped inside the middleware image)
// ---------------------------------------------------------------------------

/**
 * Seeds an active InstalledRegistry entry for every built-in package whose
 * agentId is not already present. Built-ins without required secrets are
 * safe to auto-install; ones with secret/oauth fields are left uninstalled
 * (the user has to run the setup flow so credentials reach the vault).
 *
 * An operator who hard-removes a built-in via the admin UI will see it
 * re-seeded on the next boot — built-ins are part of the image, not
 * operator-managed state. The supported way to disable a built-in is to
 * flip its status (or let the circuit-breaker flip it to `errored`): both
 * cases leave the entry in the registry, so `has(id)` returns true and the
 * seeder skips it.
 */
async function bootstrapBuiltInPackages(deps: BootstrapDeps): Promise<void> {
  const log = deps.log ?? ((m) => console.log(m));
  const store = deps.builtInStore;
  if (!store) return;

  for (const pkg of store.list()) {
    if (deps.registry.has(pkg.id)) continue;
    // S+11-2b: KG providers are operator-managed (mutual exclusion + Wizard);
    // `bootstrapKnowledgeGraphFromEnv` has already installed the matching
    // provider. The catch-all must not register the OTHER one alongside —
    // otherwise duplicate-provider throw at activate time.
    if (KNOWLEDGE_GRAPH_PROVIDER_IDS_SKIP_AUTO_INSTALL.has(pkg.id)) {
      log(
        `[bootstrap] built-in ${pkg.id} skipped — KG-Provider sind operator-managed (siehe bootstrapKnowledgeGraphFromEnv + RequiresWizard)`,
      );
      continue;
    }
    const catalogEntry = deps.catalog.get(pkg.id);
    if (!catalogEntry) {
      log(
        `[bootstrap] built-in ${pkg.id} not in catalog — extraSources wiring broken?`,
      );
      continue;
    }

    // If the package declares required secrets, we cannot auto-install — the
    // user must run the setup flow first. Leave it uninstalled; the UI shows
    // it as "available" and the install endpoint handles it normally.
    const hasRequiredSecret = catalogEntry.plugin.required_secrets.some(
      (f) => f.type === 'secret' || f.type === 'oauth',
    );
    if (hasRequiredSecret) {
      log(
        `[bootstrap] built-in ${pkg.id} needs setup (required secret field) — skipping auto-install`,
      );
      continue;
    }

    // Seed non-secret manifest defaults into the install config so the
    // plugin's activate() sees the operator-tunable values declared in
    // the manifest (e.g. `ollama_endpoint: http://ollama:11434`) rather
    // than falling through to the plugin code's last-resort hardcoded
    // default (often `localhost:...`, which breaks in-network docker
    // resolution). Secret fields are still vault-only; we never seed
    // them here. Operators can override any of these later via the
    // post-install editor.
    const defaultConfig: Record<string, unknown> = {};
    for (const field of catalogEntry.plugin.required_secrets) {
      if (field.type === 'secret' || field.type === 'oauth') continue;
      if (field.default !== undefined) {
        defaultConfig[field.key] = field.default;
      }
    }

    await deps.registry.register({
      id: pkg.id,
      installed_version: catalogEntry.plugin.version,
      installed_at: new Date().toISOString(),
      status: 'active',
      config: defaultConfig,
    });
    log(
      `[bootstrap] ⚐ auto-installed built-in ${pkg.id} v${catalogEntry.plugin.version}` +
        (Object.keys(defaultConfig).length > 0
          ? ` (seeded ${Object.keys(defaultConfig).length} manifest default(s))`
          : ''),
    );
  }
}

// ---------------------------------------------------------------------------
// Microsoft 365 (integration + Calendar dependent)
// ---------------------------------------------------------------------------

const MS365_INTEGRATION_ID = 'de.byte5.integration.microsoft365';
const CALENDAR_AGENT_ID = 'de.byte5.agent.calendar';
const TEAMS_CHANNEL_ID = 'de.byte5.channel.teams';
const TELEGRAM_CHANNEL_ID = 'de.byte5.channel.telegram';

async function bootstrapMicrosoft365FromEnv(
  deps: BootstrapDeps,
): Promise<void> {
  const log = deps.log ?? ((m) => console.log(m));
  const {
    MICROSOFT_APP_ID,
    MICROSOFT_APP_PASSWORD,
    MICROSOFT_APP_TENANT_ID,
  } = deps.config;

  const envHasMinimum =
    Boolean(MICROSOFT_APP_ID) &&
    Boolean(MICROSOFT_APP_PASSWORD) &&
    Boolean(MICROSOFT_APP_TENANT_ID);

  // 1) Integration layer — credentials
  if (!deps.registry.has(MS365_INTEGRATION_ID)) {
    if (!envHasMinimum) return;
    const catalogEntry = deps.catalog.get(MS365_INTEGRATION_ID);
    if (!catalogEntry) {
      log(
        `[bootstrap] cannot migrate ${MS365_INTEGRATION_ID}: not in plugin catalog`,
      );
      return;
    }
    await deps.vault.setMany(MS365_INTEGRATION_ID, {
      microsoft_app_password: MICROSOFT_APP_PASSWORD as string,
    });
    await deps.registry.register({
      id: MS365_INTEGRATION_ID,
      installed_version: catalogEntry.plugin.version,
      installed_at: new Date().toISOString(),
      status: 'active',
      config: {
        microsoft_tenant_id: MICROSOFT_APP_TENANT_ID as string,
        microsoft_app_id: MICROSOFT_APP_ID as string,
      },
    });
    log(
      `[bootstrap] ⚐ migrated ${MS365_INTEGRATION_ID} from .env — ` +
        `app_password → vault, tenant_id/app_id → registry.`,
    );
  }

  // 2) Calendar dependent
  await autoInstallDependent(
    deps,
    CALENDAR_AGENT_ID,
    MS365_INTEGRATION_ID,
    log,
  );

  // 3) Teams channel dependent — inherits MS App creds from the integration,
  //    plus carries Teams-specific non-secret config (SSO connection name,
  //    attachment key prefix) lifted from legacy .env for the first install.
  await autoInstallDependentWithConfig(
    deps,
    TEAMS_CHANNEL_ID,
    MS365_INTEGRATION_ID,
    {
      teams_sso_connection_name: deps.config.TEAMS_SSO_CONNECTION_NAME ?? '',
      teams_attachment_key_prefix: deps.config.TEAMS_ATTACHMENT_KEY_PREFIX,
    },
    log,
  );
}

/**
 * Telegram channel — self-contained (no parent integration). When the
 * `.env` carries TELEGRAM_BOT_TOKEN + TELEGRAM_WEBHOOK_SECRET on first
 * boot, the secrets land in the plugin's vault entry and the registry
 * gets the optional public-base-URL config; subsequent boots skip the
 * migration and respect any operator-set values.
 */
async function bootstrapTelegramFromEnv(deps: BootstrapDeps): Promise<void> {
  const log = deps.log ?? ((m) => console.log(m));
  const {
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_WEBHOOK_SECRET,
    TELEGRAM_PUBLIC_BASE_URL,
  } = deps.config;

  // Backfill path for pre-existing registry entries with incomplete
  // vaults. Idempotent + additive: only writes keys that are missing.
  // Covers two real-world scenarios:
  //   (a) S+7 → S+7.6/7.7 upgrade — bot_token + webhook_secret exist,
  //       admin_token doesn't. Backfill admin_token.
  //   (b) Vault was manually cleared but registry entry stayed —
  //       resurrect bot_token + webhook_secret from env, generate
  //       admin_token. Plugin activates fully again.
  if (deps.registry.has(TELEGRAM_CHANNEL_ID)) {
    const existingBotToken = await deps.vault.get(
      TELEGRAM_CHANNEL_ID,
      'telegram_bot_token',
    );
    const existingWebhookSecret = await deps.vault.get(
      TELEGRAM_CHANNEL_ID,
      'telegram_webhook_secret',
    );
    const existingAdminToken = await deps.vault.get(
      TELEGRAM_CHANNEL_ID,
      'telegram_admin_token',
    );
    const updates: Record<string, string> = {};
    let backfilledAdmin: string | undefined;

    if (!existingBotToken && TELEGRAM_BOT_TOKEN) {
      updates.telegram_bot_token = TELEGRAM_BOT_TOKEN;
    }
    if (!existingWebhookSecret && TELEGRAM_WEBHOOK_SECRET) {
      updates.telegram_webhook_secret = TELEGRAM_WEBHOOK_SECRET;
    }
    if (!existingAdminToken) {
      backfilledAdmin = randomBytes(32).toString('hex');
      updates.telegram_admin_token = backfilledAdmin;
    }

    if (Object.keys(updates).length === 0) return; // fully provisioned

    await deps.vault.setMany(TELEGRAM_CHANNEL_ID, updates);
    const backfilledKeys = Object.keys(updates).join(', ');
    log(
      `[bootstrap] ⚐ backfilled vault keys for existing ${TELEGRAM_CHANNEL_ID}: ${backfilledKeys}`,
    );
    if (backfilledAdmin) {
      log(
        `[bootstrap] ⚑ telegram_admin_token backfilled (fp ${tokenFingerprint(backfilledAdmin)}). ` +
          `Recover via vault decryption (VAULT_KEY required); ` +
          `or rotate by deleting the telegram_admin_token vault key and rebooting.`,
      );
    }
    return;
  }

  const envHasMinimum =
    Boolean(TELEGRAM_BOT_TOKEN) && Boolean(TELEGRAM_WEBHOOK_SECRET);
  if (!envHasMinimum) return;

  const catalogEntry = deps.catalog.get(TELEGRAM_CHANNEL_ID);
  if (!catalogEntry) {
    log(
      `[bootstrap] cannot migrate ${TELEGRAM_CHANNEL_ID}: not in plugin catalog`,
    );
    return;
  }

  // S+7.7 — admin-token for the plugin's self-contained operator-admin
  // surface. Random 32 bytes → 64-char hex. Operator captures from this
  // log line on first boot (or reads via vault inspection later).
  const telegramAdminToken = randomBytes(32).toString('hex');
  await deps.vault.setMany(TELEGRAM_CHANNEL_ID, {
    telegram_bot_token: TELEGRAM_BOT_TOKEN as string,
    telegram_webhook_secret: TELEGRAM_WEBHOOK_SECRET as string,
    telegram_admin_token: telegramAdminToken,
  });
  const initialConfig: Record<string, unknown> = {
    // S+7.6 — safer-default for first-installs. Existing installs (pre-
    // S+7.6 boots that already registered the plugin) keep their absent
    // dm_policy field which the plugin runtime reads as the parseDmPolicy
    // fallback ('pairing' too, but operators of pre-S+7.6 installs may
    // explicitly set 'open' to keep prior behaviour).
    dm_policy: 'pairing',
  };
  if (TELEGRAM_PUBLIC_BASE_URL) {
    initialConfig.telegram_public_base_url = TELEGRAM_PUBLIC_BASE_URL;
  }
  await deps.registry.register({
    id: TELEGRAM_CHANNEL_ID,
    installed_version: catalogEntry.plugin.version,
    installed_at: new Date().toISOString(),
    status: 'active',
    config: initialConfig,
  });
  log(
    `[bootstrap] ⚐ migrated ${TELEGRAM_CHANNEL_ID} from .env — ` +
      `bot_token + webhook_secret → vault, public_base_url → registry (${TELEGRAM_PUBLIC_BASE_URL ? 'webhook mode' : 'long-poll mode'}).`,
  );
  // Operator NEEDS this token to log into the admin UI, but logs leak
  // (aggregators, screenshots, CI). Print a fingerprint only; the value
  // lives encrypted in the vault. Recover via offline vault decryption
  // with VAULT_KEY, or rotate by deleting the telegram_admin_token vault
  // key and rebooting (the backfill branch above regenerates).
  log(
    `[bootstrap] ⚑ telegram_admin_token issued (fp ${tokenFingerprint(telegramAdminToken)}). ` +
      `Recover via vault decryption (VAULT_KEY required); ` +
      `or rotate by deleting the telegram_admin_token vault key and rebooting.`,
  );
}

/**
 * Short identity fingerprint for a secret. Lets the operator confirm "I
 * have the right token" without ever putting the secret itself in logs.
 * First 16 hex chars of SHA-256 = 64 bits of identity — not reversible.
 */
function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

/**
 * Variant of autoInstallDependent that seeds the child's registry entry
 * with initial (non-secret) config values. Used e.g. for Teams where the
 * channel carries its own SSO-connection-name + attachment-prefix
 * alongside the inherited MS365 credentials.
 */
async function autoInstallDependentWithConfig(
  deps: BootstrapDeps,
  agentId: string,
  parentId: string,
  initialConfig: Record<string, unknown>,
  log: (m: string) => void,
): Promise<void> {
  if (deps.registry.has(agentId)) return;
  if (!deps.registry.has(parentId)) return;
  const catalogEntry = deps.catalog.get(agentId);
  if (!catalogEntry) {
    log(`[bootstrap] cannot auto-install ${agentId}: not in plugin catalog`);
    return;
  }
  // Strip empty-string values so `ctx.config.get()` returns undefined for
  // them (cleaner than storing an empty string that passes a truthiness
  // check but fails URL/enum validation downstream).
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(initialConfig)) {
    if (v === '' || v === null || v === undefined) continue;
    cleaned[k] = v;
  }
  await deps.registry.register({
    id: agentId,
    installed_version: catalogEntry.plugin.version,
    installed_at: new Date().toISOString(),
    status: 'active',
    config: cleaned,
  });
  log(
    `[bootstrap] ⚐ auto-installed ${agentId} (depends on ${parentId}; config=${Object.keys(cleaned).join(',') || 'none'})`,
  );
}

/**
 * Installs a child agent that has no own secrets/config — its ctx inherits
 * everything from the parent integration. Idempotent and safe.
 */
async function autoInstallDependent(
  deps: BootstrapDeps,
  agentId: string,
  parentId: string,
  log: (m: string) => void,
): Promise<void> {
  if (deps.registry.has(agentId)) return;
  if (!deps.registry.has(parentId)) return;
  const catalogEntry = deps.catalog.get(agentId);
  if (!catalogEntry) {
    log(`[bootstrap] cannot auto-install ${agentId}: not in plugin catalog`);
    return;
  }
  await deps.registry.register({
    id: agentId,
    installed_version: catalogEntry.plugin.version,
    installed_at: new Date().toISOString(),
    status: 'active',
    config: {},
  });
  log(
    `[bootstrap] ⚐ auto-installed ${agentId} (depends on ${parentId}; no own secrets)`,
  );
}
