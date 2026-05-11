import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  KgEntityNamespaceError,
  KgServiceUnavailableError,
  LlmBudgetExceededError,
  LlmModelNotAllowedError,
  LlmServiceUnavailableError,
  MissingConfigError,
  MissingSecretError,
  SubAgentBudgetExceededError,
  SubAgentPermissionDeniedError,
  SubAgentRecursionError,
  UnknownSubAgentError,
  type ConfigAccessor,
  type EntityIngest,
  type EntityIngestResult,
  type FactIngest,
  type FactIngestResult,
  type HttpAccessor,
  type JobsAccessor,
  type KnowledgeGraph,
  type KnowledgeGraphAccessor,
  type LlmAccessor,
  type LlmCompleteRequest,
  type LlmCompleteResult,
  type LlmProvider,
  type MemoryAccessor,
  type MemoryStore,
  type MigrationContext,
  type PluginContext,
  type RoutesAccessor,
  type ScratchDirAccessor,
  type SecretsAccessor,
  type SecretsReadWriteAccessor,
  type ServicesAccessor,
  type SubAgentAccessor,
  type ToolsAccessor,
} from '@omadia/plugin-api';
import type { DomainTool } from '@omadia/orchestrator';

import type { InstalledRegistry } from '../plugins/installedRegistry.js';
import type { JobScheduler } from '../plugins/jobScheduler.js';
import type { PluginCatalog } from '../plugins/manifestLoader.js';
import type { SecretVault } from '../secrets/vault.js';
import type { NativeToolRegistry } from '@omadia/orchestrator';
import type { PluginRouteRegistry } from './pluginRouteRegistry.js';
import { createHttpAccessor } from './httpAccessor.js';
import { createMemoryAccessor } from './memoryAccessor.js';
import { SCRATCH_DIR } from './paths.js';
import type { ServiceRegistry } from './serviceRegistry.js';

/**
 * The plugin-facing types (PluginContext, SecretsAccessor, ConfigAccessor,
 * MissingSecretError, MissingConfigError) live in @omadia/plugin-api so
 * that every plugin package can import them without reaching back into the
 * middleware kernel. This file re-exports them so existing host-side imports
 * keep working, and hosts the runtime implementation (createPluginContext)
 * that wires them to the concrete Vault + Catalog + Registry.
 */

export {
  MissingConfigError,
  MissingSecretError,
  type ConfigAccessor,
  type JobsAccessor,
  type MemoryAccessor,
  type MigrationContext,
  type PluginContext,
  type RoutesAccessor,
  type ScratchDirAccessor,
  type SecretsAccessor,
  type SecretsReadWriteAccessor,
  type ServicesAccessor,
  type ToolsAccessor,
} from '@omadia/plugin-api';

export interface CreatePluginContextOptions {
  agentId: string;
  vault: SecretVault;
  registry: InstalledRegistry;
  /** Needed to resolve the `depends_on` chain for inheritance. */
  catalog: PluginCatalog;
  /** Kernel-wide service registry. Plugin code reaches plugin-bereitgestellte
   *  services (graph, bus, embeddings, ...) through `ctx.services.get(...)`
   *  which delegates to this registry. Required — cannot be omitted even when
   *  no providers are installed (the accessor just returns undefined). */
  serviceRegistry: ServiceRegistry;
  /** Kernel-wide native-tool registry. The `ctx.tools.register(...)` helper
   *  funnels plugin-contributed tools here. Each registration captures a
   *  dispose that the plugin's AgentHandle.close() must invoke to symmetric-
   *  ally hot-unregister on deactivate. */
  nativeToolRegistry: NativeToolRegistry;
  /** Kernel-wide plugin-route registry. `ctx.routes.register(prefix, router)`
   *  appends to this; the kernel mounts the queue onto the main app after all
   *  activates have completed. */
  routeRegistry: PluginRouteRegistry;
  /** Kernel-wide background-job scheduler. `ctx.jobs.register(spec, handler)`
   *  delegates here; the runtime additionally calls `stopForPlugin(agentId)`
   *  on deactivate so a misbehaving plugin's jobs cannot outlive its
   *  lifecycle. */
  jobScheduler: JobScheduler;
  logger?: (...args: unknown[]) => void;
}

/**
 * Resolution chain: [agentId, ...ancestors in DFS order]. Secrets and config
 * are searched in this order; the first hit wins. Cycles are broken defensively
 * (a visited set). If the catalog is out of sync with the registry the chain
 * may contain ids that aren't installed — that's fine, their vault/registry
 * lookups just return undefined.
 */
function buildResolutionChain(
  agentId: string,
  catalog: PluginCatalog,
): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();

  const visit = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    chain.push(id);
    const entry = catalog.get(id);
    if (!entry) return;
    for (const parent of entry.plugin.depends_on) {
      visit(parent);
    }
  };

  visit(agentId);
  return chain;
}

export function createPluginContext(
  opts: CreatePluginContextOptions,
): PluginContext {
  const { agentId, vault, registry, catalog, serviceRegistry } = opts;
  const log = opts.logger ?? ((...args) => console.log(`[${agentId}]`, ...args));
  const chain = buildResolutionChain(agentId, catalog);

  // OB-77 (Palaia Phase 8) — resolve plugin domain from the manifest. The
  // loader has already validated/auto-fallbacked it; we just read it here.
  // Plugins not in the catalog (boot-time smoke-mode probes, in-memory
  // fixtures) get the same auto-fallback so the contract surface is total.
  // Mirror the manifestLoader's regex-valid fallback so PLUGIN_DOMAIN_REGEX
  // holds for every PluginContext we hand out.
  const catalogEntry = catalog.get(agentId);
  let domain: string;
  if (catalogEntry?.plugin.domain) {
    domain = catalogEntry.plugin.domain;
  } else {
    const safeSegments = agentId
      .toLowerCase()
      .split(/[./]/)
      .map((p) => p.replace(/[^a-z0-9]/g, ''))
      .filter((p) => p.length > 0 && /^[a-z]/.test(p));
    const safeId = safeSegments.length > 0 ? safeSegments.join('.') : 'plugin';
    domain = `unknown.${safeId}`;
  }

  const services: ServicesAccessor = {
    get<T>(name: string): T | undefined {
      return serviceRegistry.get<T>(name);
    },
    has(name: string): boolean {
      return serviceRegistry.has(name);
    },
    provide<T>(name: string, impl: T): () => void {
      return serviceRegistry.provide(name, impl);
    },
    replace<T>(name: string, impl: T): () => void {
      return serviceRegistry.replace(name, impl);
    },
  };

  // Scratch-Dir accessor: gated on `manifest.filesystem.scratch: true`.
  // Created lazily on first path() call. Not isolated across restarts —
  // a plugin that needs durable state must use ctx.memory (Phase 0b/M4b)
  // or its own vault entry. Scratch is purely ephemeral working space.
  const scratch = scratchEnabled(agentId, catalog)
    ? createScratchAccessor(agentId)
    : undefined;

  // HTTP accessor: gated on `manifest.permissions.network.outbound` being
  // non-empty. When absent, ctx.http is undefined and plugins that didn't
  // declare network access can't make outbound calls via the accessor.
  // Today the global `fetch` is still reachable — future hardening will
  // sandbox that. Plugins should use ctx.http exclusively to stay
  // forward-compatible.
  const outboundHosts = extractOutboundAllowlist(agentId, catalog);
  const http: HttpAccessor | undefined =
    outboundHosts.length > 0
      ? createHttpAccessor({ agentId, outbound: outboundHosts })
      : undefined;

  // Memory accessor: present when the manifest declares memory permissions
  // AND the memory provider plugin (`@omadia/memory`) has published
  // its store into the service registry. The accessor is scoped to
  // /memories/agents/<agentId>/ — plugins cannot see each other's memory.
  // The manifest's permissions.memory.reads/writes fields are parsed but
  // not currently used for intra-scope ACL enforcement — scope isolation
  // itself is the primary boundary.
  const memoryStoreService = serviceRegistry.get<MemoryStore>('memoryStore');
  const memory: MemoryAccessor | undefined =
    memoryStoreService && memoryDeclared(agentId, catalog)
      ? createMemoryAccessor({ agentId, store: memoryStoreService })
      : undefined;

  const secrets: SecretsAccessor = {
    async get(key) {
      for (const id of chain) {
        const v = await vault.get(id, key);
        if (v !== undefined && v !== '') return v;
      }
      return undefined;
    },
    async require(key) {
      const v = await secrets.get(key);
      if (v === undefined || v === '') {
        throw new MissingSecretError(agentId, key);
      }
      return v;
    },
    async keys() {
      // Union of keys over the chain, deduplicated. Own keys first.
      const seen = new Set<string>();
      const out: string[] = [];
      for (const id of chain) {
        for (const k of await vault.listKeys(id)) {
          if (!seen.has(k)) {
            seen.add(k);
            out.push(k);
          }
        }
      }
      return out;
    },
  };

  const config: ConfigAccessor = {
    get<T = unknown>(key: string): T | undefined {
      for (const id of chain) {
        const entry = registry.get(id);
        if (!entry) continue;
        const value = entry.config[key];
        if (value !== undefined && value !== null) {
          return value as T;
        }
      }
      return undefined;
    },
    require<T = unknown>(key: string): T {
      const v = config.get<T>(key);
      if (v === undefined || v === null) {
        throw new MissingConfigError(agentId, key);
      }
      return v;
    },
  };

  // Tools accessor: funnel plugin-contributed tool registrations into the
  // kernel's NativeToolRegistry. Plugin captures the returned dispose handle
  // and calls it from its AgentHandle.close() for symmetric hot-unregister.
  const tools: ToolsAccessor = {
    register(spec, handler, options) {
      // OB-77 — domain priority: spec-level override (rare, plugins
      // contributing tools across domains) > manifest-level (`ctx.domain`).
      // Always defined here because `domain` is non-optional on PluginContext.
      const resolvedDomain = spec.domain ?? domain;
      return opts.nativeToolRegistry.register(spec.name, {
        spec,
        handler,
        domain: resolvedDomain,
        ...(options?.promptDoc !== undefined
          ? { promptDoc: options.promptDoc }
          : {}),
        ...(options?.attachmentSink
          ? { attachmentSink: options.attachmentSink }
          : {}),
      });
    },
    registerHandler(name, handler, options) {
      return opts.nativeToolRegistry.registerHandler(name, {
        handler,
        ...(options?.promptDoc !== undefined
          ? { promptDoc: options.promptDoc }
          : {}),
        ...(options?.attachmentSink
          ? { attachmentSink: options.attachmentSink }
          : {}),
      });
    },
  };

  // Routes accessor: append to the kernel's route queue. The kernel mounts
  // after all plugins have activated.
  const routes: RoutesAccessor = {
    register(prefix, router) {
      return opts.routeRegistry.register(prefix, router, agentId);
    },
  };

  // Jobs accessor: hands programmatic registrations to the kernel scheduler,
  // which keys them by (agentId, name). The runtime owns bulk teardown via
  // scheduler.stopForPlugin(agentId) on deactivate, so a leaked dispose from
  // the plugin still won't outlive its own lifecycle.
  const jobs: JobsAccessor = {
    register(spec, handler) {
      return opts.jobScheduler.register(agentId, spec, handler);
    },
  };

  // OB-29-1 — SubAgentAccessor: present iff the manifest declares
  // permissions.subAgents.calls with at least one entry. Whitelist + budget
  // check on every ask().
  const subAgent = createSubAgentAccessor({
    callerAgentId: agentId,
    permissions: extractSubAgentPermissions(agentId, catalog),
    serviceRegistry,
  });

  // OB-29-2 — KnowledgeGraphAccessor: present iff the manifest declares
  // permissions.graph.entity_systems with at least one (non-reserved)
  // namespace AND a 'knowledgeGraph' provider is registered.
  const knowledgeGraph = createKnowledgeGraphAccessor({
    callerAgentId: agentId,
    entitySystems: extractEntitySystems(agentId, catalog),
    serviceRegistry,
  });

  // OB-29-3 — LlmAccessor: present iff the manifest declares
  // permissions.llm.models_allowed with at least one entry.
  const llm = createLlmAccessor({
    callerAgentId: agentId,
    permissions: extractLlmPermissions(agentId, catalog),
    serviceRegistry,
  });

  return {
    agentId,
    domain,
    secrets,
    config,
    services,
    tools,
    routes,
    jobs,
    smokeMode: false,
    ...(scratch ? { scratch } : {}),
    ...(http ? { http } : {}),
    ...(memory ? { memory } : {}),
    ...(subAgent ? { subAgent } : {}),
    ...(knowledgeGraph ? { knowledgeGraph } : {}),
    ...(llm ? { llm } : {}),
    log,
  };
}

interface SubAgentPermissions {
  /** Whitelisted target agentIds. Wildcards (`'de.byte5.agent.*'`) match
   *  any suffix; an exact `'*'` matches every reachable target. */
  readonly calls: readonly string[];
  /** Per tool-handler invocation cap on `ctx.subAgent.ask`. */
  readonly callsPerInvocation: number;
}

function extractSubAgentPermissions(
  agentId: string,
  catalog: PluginCatalog,
): SubAgentPermissions | undefined {
  const entry = catalog.get(agentId);
  if (!entry) return undefined;
  const calls = entry.plugin.permissions_summary.sub_agents_calls ?? [];
  if (calls.length === 0) return undefined;
  const budget =
    entry.plugin.permissions_summary.sub_agents_calls_per_invocation ?? 5;
  return { calls, callsPerInvocation: budget };
}

/**
 * Glob-style match: `'de.byte5.agent.*'` matches `'de.byte5.agent.foo'`
 * but NOT `'de.byte5.agent.foo.bar'`. `'*'` matches anything.
 *
 * Kept tiny on purpose — no need to pull a full glob library for a
 * three-pattern whitelist.
 */
function whitelistMatch(pattern: string, candidate: string): boolean {
  if (pattern === candidate) return true;
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -1); // keep trailing dot
    if (!candidate.startsWith(prefix)) return false;
    // Reject deeper nesting: 'de.byte5.agent.*' must not match
    // 'de.byte5.agent.foo.bar'.
    return !candidate.slice(prefix.length).includes('.');
  }
  return false;
}

interface SubAgentAccessorOptions {
  callerAgentId: string;
  permissions: SubAgentPermissions | undefined;
  serviceRegistry: ServiceRegistry;
}

function createSubAgentAccessor(
  opts: SubAgentAccessorOptions,
): SubAgentAccessor | undefined {
  const { callerAgentId, permissions, serviceRegistry } = opts;
  if (!permissions) return undefined;

  // Per-instance call counter. Resets when a fresh ctx is created (which
  // the runtime currently does once per activate; per-tool-handler
  // accounting will land with the orchestrator-level invocation context
  // in a future follow-up). For v1 the budget is per ctx-lifetime — that
  // is generous-but-bounded and ships today.
  let callsUsed = 0;

  return {
    has(targetAgentId: string): boolean {
      return serviceRegistry.has(`subAgent:${targetAgentId}`);
    },
    list(): readonly string[] {
      const PREFIX = 'subAgent:';
      return serviceRegistry
        .names()
        .filter((n) => n.startsWith(PREFIX))
        .map((n) => n.slice(PREFIX.length));
    },
    async ask(targetAgentId: string, question: string): Promise<string> {
      if (targetAgentId === callerAgentId) {
        throw new SubAgentRecursionError(callerAgentId);
      }
      if (callsUsed >= permissions.callsPerInvocation) {
        throw new SubAgentBudgetExceededError(
          callerAgentId,
          permissions.callsPerInvocation,
        );
      }
      const allowed = permissions.calls.some((p) =>
        whitelistMatch(p, targetAgentId),
      );
      if (!allowed) {
        throw new SubAgentPermissionDeniedError(callerAgentId, targetAgentId);
      }
      const tool = serviceRegistry.get<DomainTool>(
        `subAgent:${targetAgentId}`,
      );
      if (!tool) {
        throw new UnknownSubAgentError(callerAgentId, targetAgentId);
      }
      callsUsed += 1;
      return tool.handle({ question });
    },
  };
}

// ---------------------------------------------------------------------------
// OB-29-2 — KnowledgeGraphAccessor wiring (namespace-validated KG access).
// ---------------------------------------------------------------------------

function extractEntitySystems(
  agentId: string,
  catalog: PluginCatalog,
): readonly string[] {
  const entry = catalog.get(agentId);
  if (!entry) return [];
  return entry.plugin.permissions_summary.graph_entity_systems ?? [];
}

interface KnowledgeGraphAccessorOptions {
  callerAgentId: string;
  entitySystems: readonly string[];
  serviceRegistry: ServiceRegistry;
}

function createKnowledgeGraphAccessor(
  opts: KnowledgeGraphAccessorOptions,
): KnowledgeGraphAccessor | undefined {
  const { callerAgentId, entitySystems, serviceRegistry } = opts;
  if (entitySystems.length === 0) return undefined;
  // We don't pre-resolve the KG impl: doing it lazily lets the plugin
  // boot even when the kg-provider activates later (provider-ordering is
  // not deterministic across restarts). The first ingest call resolves —
  // throwing KgServiceUnavailableError if no provider is around.
  const allowed = new Set(entitySystems);
  function resolveKg(): KnowledgeGraph {
    const kg = serviceRegistry.get<KnowledgeGraph>('knowledgeGraph');
    if (!kg) throw new KgServiceUnavailableError(callerAgentId);
    return kg;
  }
  return {
    entitySystems,
    async ingestEntities(entities: EntityIngest[]): Promise<EntityIngestResult> {
      for (const ent of entities) {
        if (!allowed.has(ent.system)) {
          throw new KgEntityNamespaceError(callerAgentId, ent.system);
        }
      }
      return resolveKg().ingestEntities(entities);
    },
    async ingestFacts(facts: FactIngest[]): Promise<FactIngestResult> {
      // Facts don't carry a system namespace directly — the namespace is
      // implicit in `mentionedEntityIds` (each ext-id begins with the
      // system prefix). We don't validate them here: the producer is the
      // plugin, and the read path tolerates dangling references. A future
      // hardening pass MAY parse out the prefix and assert it's allowed.
      return resolveKg().ingestFacts(facts);
    },
    searchTurns: (opts2) => resolveKg().searchTurns(opts2),
    findEntityCapturedTurns: (opts2) =>
      resolveKg().findEntityCapturedTurns(opts2),
    getNeighbors: (nodeId) => resolveKg().getNeighbors(nodeId),
    stats: () => resolveKg().stats(),
  };
}

// ---------------------------------------------------------------------------
// OB-29-3 — LlmAccessor wiring (host-LLM with model whitelist + budget).
// ---------------------------------------------------------------------------

interface LlmPermissions {
  readonly modelsAllowed: readonly string[];
  readonly callsPerInvocation: number;
  readonly maxTokensPerCall: number;
}

function extractLlmPermissions(
  agentId: string,
  catalog: PluginCatalog,
): LlmPermissions | undefined {
  const entry = catalog.get(agentId);
  if (!entry) return undefined;
  const summary = entry.plugin.permissions_summary;
  const modelsAllowed = summary.llm_models_allowed ?? [];
  if (modelsAllowed.length === 0) return undefined;
  return {
    modelsAllowed,
    callsPerInvocation: summary.llm_calls_per_invocation ?? 5,
    maxTokensPerCall: summary.llm_max_tokens_per_call ?? 4096,
  };
}

/**
 * Glob-style match for LLM model names.
 *   - `'claude-haiku-4-5'` matches exact only
 *   - `'claude-haiku-4-5*'` matches anything starting with that prefix
 *     (e.g. `'claude-haiku-4-5-20251001'`)
 *   - `'*'` matches anything (use sparingly — sidesteps the whitelist)
 */
function modelMatch(pattern: string, candidate: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1);
    return candidate.startsWith(prefix);
  }
  return pattern === candidate;
}

interface LlmAccessorOptions {
  callerAgentId: string;
  permissions: LlmPermissions | undefined;
  serviceRegistry: ServiceRegistry;
}

function createLlmAccessor(
  opts: LlmAccessorOptions,
): LlmAccessor | undefined {
  const { callerAgentId, permissions, serviceRegistry } = opts;
  if (!permissions) return undefined;

  let callsUsed = 0;
  const log = (...args: unknown[]): void =>
    console.log(`[${callerAgentId}/llm]`, ...args);

  return {
    modelsAllowed: permissions.modelsAllowed,
    async complete(req: LlmCompleteRequest): Promise<LlmCompleteResult> {
      if (callsUsed >= permissions.callsPerInvocation) {
        throw new LlmBudgetExceededError(
          callerAgentId,
          permissions.callsPerInvocation,
        );
      }
      const allowed = permissions.modelsAllowed.some((p) =>
        modelMatch(p, req.model),
      );
      if (!allowed) {
        throw new LlmModelNotAllowedError(callerAgentId, req.model);
      }
      const provider = serviceRegistry.get<LlmProvider>('llm');
      if (!provider) throw new LlmServiceUnavailableError(callerAgentId);

      // Silent-clamp of maxTokens to manifest cap. Plugin-side larger
      // values are not rejected — predictable plugin code beats throwing
      // on a value that's „too big" but probably never hits.
      const requestedMaxTokens = req.maxTokens ?? permissions.maxTokensPerCall;
      const effectiveMaxTokens = Math.min(
        requestedMaxTokens,
        permissions.maxTokensPerCall,
      );
      if (effectiveMaxTokens < requestedMaxTokens) {
        log(
          `clamped maxTokens ${String(requestedMaxTokens)} → ${String(effectiveMaxTokens)} (manifest cap)`,
        );
      }

      callsUsed += 1;
      return provider.complete({
        ...req,
        maxTokens: effectiveMaxTokens,
      });
    },
  };
}

export interface CreateMigrationContextOptions extends CreatePluginContextOptions {
  fromVersion: string;
  toVersion: string;
  previousConfig: Record<string, unknown>;
}

/**
 * Builds the context passed to a plugin's `onMigrate` hook. Structurally
 * identical to `createPluginContext` except the secrets accessor is
 * write-capable and the migration-specific fields (`fromVersion`, `toVersion`,
 * `previousConfig`) are present.
 *
 * Writes to secrets go through the same vault namespace the plugin uses at
 * runtime — they are visible to the v2 package immediately after migration
 * completes. The hook runs BEFORE the catalog is swapped to v2, so
 * `ctx.config.get(...)` returns the v1 manifest's config view (via
 * `previousConfig` + resolution chain). Hook authors who need v2-manifest
 * guarantees should rely on `previousConfig` and return the merged result —
 * do not trust `ctx.config.get` to reflect v2 yet.
 */
export function createMigrationContext(
  opts: CreateMigrationContextOptions,
): MigrationContext {
  const base = createPluginContext(opts);
  const { agentId, vault } = opts;

  const secrets: SecretsReadWriteAccessor = {
    get: base.secrets.get.bind(base.secrets),
    require: base.secrets.require.bind(base.secrets),
    keys: base.secrets.keys.bind(base.secrets),
    async set(key: string, value: string): Promise<void> {
      await vault.set(agentId, key, value);
    },
    async delete(key: string): Promise<void> {
      await vault.deleteKey(agentId, key);
    },
  };

  return {
    ...base,
    secrets,
    fromVersion: opts.fromVersion,
    toVersion: opts.toVersion,
    previousConfig: opts.previousConfig,
  };
}

function memoryDeclared(agentId: string, catalog: PluginCatalog): boolean {
  const entry = catalog.get(agentId);
  if (!entry) return false;
  const manifest = entry.manifest as Record<string, unknown> | undefined;
  const permissions = manifest?.['permissions'] as
    | Record<string, unknown>
    | undefined;
  const mem = permissions?.['memory'] as Record<string, unknown> | undefined;
  if (!mem) return false;
  const reads = Array.isArray(mem['reads']) ? mem['reads'] : [];
  const writes = Array.isArray(mem['writes']) ? mem['writes'] : [];
  return reads.length > 0 || writes.length > 0;
}

function extractOutboundAllowlist(
  agentId: string,
  catalog: PluginCatalog,
): string[] {
  const entry = catalog.get(agentId);
  if (!entry) return [];
  const manifest = entry.manifest as Record<string, unknown> | undefined;
  const permissions = manifest?.['permissions'] as
    | Record<string, unknown>
    | undefined;
  const network = permissions?.['network'] as Record<string, unknown> | undefined;
  const outbound = network?.['outbound'];
  if (!Array.isArray(outbound)) return [];
  return outbound.filter((h): h is string => typeof h === 'string');
}

function scratchEnabled(agentId: string, catalog: PluginCatalog): boolean {
  const entry = catalog.get(agentId);
  if (!entry) return false;
  const manifest = entry.manifest as Record<string, unknown> | undefined;
  const fsBlock = manifest?.['filesystem'] as Record<string, unknown> | undefined;
  return fsBlock?.['scratch'] === true;
}

function createScratchAccessor(agentId: string): ScratchDirAccessor {
  // Sanitise the agentId for use as a directory name. Dot-separated ids
  // (@omadia/agent-seo-analyst) are already safe on posix filesystems, but
  // we paranoia-clamp anyway — a future upload validator that accepts
  // looser ids should not turn into a path-traversal vector.
  const safe = agentId.replace(/[^A-Za-z0-9._-]/g, '_');
  const dir = path.join(SCRATCH_DIR, safe);
  let ensured = false;
  return {
    async path() {
      if (!ensured) {
        await fs.mkdir(dir, { recursive: true, mode: 0o700 });
        ensured = true;
      }
      return dir;
    },
  };
}
