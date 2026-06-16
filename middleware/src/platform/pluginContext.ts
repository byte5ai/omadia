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
  type FlowsAccessor,
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
  type NotificationsAccessor,
  type PluginContext,
  type RoutesAccessor,
  type PluginActionStatus,
  type ScratchDirAccessor,
  type SecretsAccessor,
  type SecretsReadWriteAccessor,
  type ServicesAccessor,
  type StatusAccessor,
  type SubAgentAccessor,
  type UiRoutesAccessor,
  type ToolsAccessor,
} from '@omadia/plugin-api';
import type { DomainTool } from '@omadia/orchestrator';
import { turnContext } from '@omadia/orchestrator';
import {
  coerceModelToProvider,
  isClassRef,
  modelForClass,
  resolveLlmProvider,
  resolveModelRef,
  type ModelClass,
  type ProviderId,
} from '@omadia/llm-provider';

import type { InstalledRegistry } from '../plugins/installedRegistry.js';
import type { JobScheduler } from '../plugins/jobScheduler.js';
import type { PluginCatalog } from '../plugins/manifestLoader.js';
import type { SecretVault } from '../secrets/vault.js';
import { createLlmProviderFromNeutral } from './anthropicLlmProvider.js';
import type { NativeToolRegistry } from '@omadia/orchestrator';
import type { PluginRouteRegistry } from './pluginRouteRegistry.js';
import type { NotificationRouter } from './notificationRouter.js';
import type { UiRouteCatalog } from './uiRouteCatalog.js';
import { createHttpAccessor, isAuditMode, type AuditMode } from './httpAccessor.js';
import { signFlowState, verifyFlowState } from './flowState.js';
import type { PluginStatusRegistry } from './pluginStatusRegistry.js';
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
  type NotificationsAccessor,
  type PluginContext,
  type RoutesAccessor,
  type ScratchDirAccessor,
  type SecretsAccessor,
  type SecretsReadWriteAccessor,
  type ServicesAccessor,
  type ToolsAccessor,
  type UiRoutesAccessor,
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
  /** Kernel-wide notification fan-out. `ctx.notifications.send(...)` and
   *  `ctx.notifications.registerChannel(...)` both delegate here. */
  notificationRouter: NotificationRouter;
  /** Kernel-wide uiRoute descriptor catalogue. `ctx.uiRoutes.register(...)`
   *  delegates here; consumers (channel-teams Hub + Tab-Config) query
   *  it at request time via the `uiRouteCatalog` service. */
  uiRouteCatalog: UiRouteCatalog;
  /** Spec 004 (FR-B3) — symmetric key used to sign/verify `ctx.flows` state
   *  tokens (the same `auth/sessionSigningKey`). Held by the kernel; the
   *  `flows` accessor closes over it and never exposes it. Optional: when
   *  absent, `ctx.flows` is not built even if the manifest declares
   *  `permissions.flows` (migration/test contexts don't run flows). */
  flowSigningKey?: Uint8Array;
  /** Spec 004 (FR-B5) — browser-facing origin the flow callback URLs resolve
   *  against (`FLOW_PUBLIC_BASE_URL`, defaulting to `PUBLIC_BASE_URL`). No
   *  trailing slash. Required alongside `flowSigningKey` for `ctx.flows`. */
  flowPublicBaseUrl?: string;
  /** Spec 004 — kernel store backing `ctx.status`. Optional: when absent the
   *  accessor is a no-op (test/migration contexts don't surface status). */
  pluginStatusRegistry?: PluginStatusRegistry;
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

  // HTTP accessor: present when the manifest declares outbound hosts OR the
  // plugin is a #91 web_scanner (audit/scanner plugins fetch user-supplied
  // URLs and may declare no static hosts at all). The effective allow-list
  // is resolved from the manifest plus the operator-selected audit mode +
  // host_list config. Today the global `fetch` is still reachable — a future
  // hardening pass will sandbox it; plugins should use ctx.http exclusively.
  const outboundHosts = extractOutboundAllowlist(agentId, catalog);
  const webScanner =
    catalog.get(agentId)?.plugin.permissions_summary.network_web_scanner ===
    true;
  const auditConfig = extractAuditConfig(agentId, catalog, registry);
  const http: HttpAccessor | undefined =
    outboundHosts.length > 0 || webScanner
      ? createHttpAccessor({
          agentId,
          outbound: outboundHosts,
          webScanner,
          extraHosts: auditConfig.extraHosts,
          ...(auditConfig.auditMode
            ? { auditMode: auditConfig.auditMode }
            : {}),
        })
      : undefined;

  // Memory accessor: present when the manifest declares memory permissions
  // AND the memory provider plugin (`@omadia/memory`) has published its store
  // into the service registry. The accessor is scoped per-plugin AND
  // per-orchestrator to /memories/orchestrators/<agentSlug>/plugins/<pluginId>/
  // — the active Agent slug is resolved from the turn context at call time, so
  // the same plugin invoked under two Agents writes to two disjoint trees.
  // Plugins cannot see each other's — or another orchestrator's — memory.
  const memoryStoreService = serviceRegistry.get<MemoryStore>('memoryStore');
  const memory: MemoryAccessor | undefined =
    memoryStoreService && memoryDeclared(agentId, catalog)
      ? createMemoryAccessor({
          pluginId: agentId,
          store: memoryStoreService,
          resolveAgentSlug: () => turnContext.currentAgentSlug(),
        })
      : undefined;

  // Spec 004 — runtime credential write. When the manifest declares
  // `permissions.secrets.runtime_write`, the plugin gets write methods on its
  // OWN vault namespace + config (never the depends_on chain). Used by
  // credential-acquisition flows (e.g. the GitHub App-Manifest conversion) to
  // persist what they obtain. Absent otherwise, mirroring how ctx.http /
  // ctx.memory are gated.
  const runtimeWrite =
    catalog.get(agentId)?.plugin.permissions_summary.secrets_runtime_write ===
    true;

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
    ...(runtimeWrite
      ? {
          async set(key: string, value: string): Promise<void> {
            log(`[secrets:write] ${agentId} set ${key}`);
            await vault.set(agentId, key, value);
          },
          async delete(key: string): Promise<void> {
            log(`[secrets:write] ${agentId} delete ${key}`);
            await vault.deleteKey(agentId, key);
          },
        }
      : {}),
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
    ...(runtimeWrite
      ? {
          async set(key: string, value: unknown): Promise<void> {
            // Only declared, non-secret setup fields may be written as config —
            // secrets must go through secrets.set so they land in the vault.
            const field = catalog
              .get(agentId)
              ?.plugin.setup_fields?.find((f) => f.key === key);
            if (!field) {
              throw new Error(
                `config.set: "${key}" is not a declared setup field of ${agentId}`,
              );
            }
            if (field.type === 'secret' || field.type === 'oauth') {
              throw new Error(
                `config.set: "${key}" is a ${field.type} field — use ctx.secrets.set`,
              );
            }
            // Write to the plugin's OWN config (not the inherited chain).
            const current = registry.get(agentId)?.config ?? {};
            log(`[config:write] ${agentId} set ${key}`);
            await registry.updateConfig(agentId, { ...current, [key]: value });
          },
        }
      : {}),
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
        // Slice 2.5 — carry plugin ownership AND a config-reader closure
        // into the registry so the orchestrator dispatch hook can resolve
        // `_privacy_mode` / `_privacy_bypass_scopes` for this tool at
        // dispatch time. `config.get(...)` resolves through the plugin's
        // own ConfigAccessor chain, so an operator setting saved via the
        // install UI takes effect on the very next dispatch.
        agentId,
        readConfig: (key: string) => config.get(key),
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
    async invoke(name, input) {
      const entry = opts.nativeToolRegistry.get(name);
      if (!entry?.handler) {
        throw new Error(`tools.invoke: '${name}' is unknown or handler-less`);
      }
      return entry.handler(input);
    },
  };

  // Routes accessor: append to the kernel's route queue. The kernel mounts
  // after all plugins have activated.
  const routes: RoutesAccessor = {
    register(prefix, router) {
      return opts.routeRegistry.register(prefix, router, agentId);
    },
  };

  // Spec 004 (FR-B2..B5) — flow toolkit. Present iff the manifest declares
  // `permissions.flows` AND the kernel threaded both the signing key and the
  // public base URL (production always does; migration/test contexts may not,
  // so we degrade to `undefined` rather than throw). The plugin uses this to
  // run a redirect/callback round-trip on its OWN route.
  const flowsDeclared =
    catalog.get(agentId)?.plugin.permissions_summary.flows === true;
  const flowSigningKey = opts.flowSigningKey;
  const flowPublicBaseUrl = opts.flowPublicBaseUrl;
  const flows: FlowsAccessor | undefined =
    flowsDeclared && flowSigningKey && flowPublicBaseUrl
      ? {
          publicUrl(relPath: string, urlOpts?: { prefix?: string }): string {
            // Resolve which of the plugin's registered route prefixes to mount
            // against. Explicit `opts.prefix` wins; otherwise the plugin's sole
            // live registration is used. Ambiguity / absence is a loud error —
            // a wrong redirect_url silently breaks the whole flow.
            let prefix = urlOpts?.prefix;
            if (!prefix) {
              const own = opts.routeRegistry
                .list()
                .filter((e) => e.source === agentId && !e.disposed)
                .map((e) => e.prefix);
              const unique = Array.from(new Set(own));
              if (unique.length === 0) {
                throw new Error(
                  `flows.publicUrl: ${agentId} has no registered route — call ctx.routes.register(...) first or pass opts.prefix`,
                );
              }
              if (unique.length > 1) {
                throw new Error(
                  `flows.publicUrl: ${agentId} registered multiple routes (${unique.join(', ')}) — pass opts.prefix to disambiguate`,
                );
              }
              prefix = unique[0]!;
            }
            if (!prefix.startsWith('/')) {
              throw new Error(
                `flows.publicUrl: prefix must start with '/' (got '${prefix}')`,
              );
            }
            // The plugin route is mounted under `/api/<…>`; the browser reaches
            // it through the `/bot-api/* → /api/*` proxy. Strip a leading `/api`
            // segment exactly as the store-detail iframe does
            // (web-ui store/[id]/page.tsx) so the two stay in lockstep.
            const mountPath = prefix.replace(/^\/api(?=\/|$)/, '');
            const base = flowPublicBaseUrl.replace(/\/+$/, '');
            const rel = relPath.replace(/^\/+/, '');
            return `${base}/bot-api${mountPath}/${rel}`;
          },
          async signState(
            claims: Record<string, unknown>,
            stateOpts?: { ttl?: string },
          ): Promise<string> {
            return await signFlowState(
              agentId,
              claims,
              flowSigningKey,
              stateOpts?.ttl,
            );
          },
          async verifyState(token: string): Promise<Record<string, unknown>> {
            return await verifyFlowState(agentId, token, flowSigningKey);
          },
        }
      : undefined;

  // Status accessor (spec 004): the plugin pushes its operator-facing action
  // status to the kernel registry. Self-scoped to this plugin id — a plugin
  // cannot report another's status. No-op when no registry was threaded
  // (migration/test contexts). `clear()` and `report({state:'ok'})` both leave
  // no badge; the value is normalized to guard against malformed input.
  const statusRegistry = opts.pluginStatusRegistry;
  const status: StatusAccessor = {
    report(next) {
      if (!statusRegistry) return;
      const state =
        next?.state === 'ok' || next?.state === 'needs_action' || next?.state === 'error'
          ? next.state
          : 'needs_action';
      const normalized: PluginActionStatus = {
        state,
        ...(typeof next?.title === 'string' ? { title: next.title } : {}),
        ...(typeof next?.detail === 'string' ? { detail: next.detail } : {}),
      };
      if (state === 'ok') {
        statusRegistry.clear(agentId);
        return;
      }
      statusRegistry.set(agentId, normalized);
    },
    clear() {
      statusRegistry?.clear(agentId);
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

  // Notifications accessor: outbound notifications fan out through the
  // kernel router; channel plugins register inbound handlers via the same
  // accessor. The pluginId carried into each handler is auto-injected
  // from this context's agentId so plugins cannot spoof other plugins.
  const notifications: NotificationsAccessor = {
    send(payload) {
      return opts.notificationRouter.dispatch(agentId, payload);
    },
    registerChannel(channelId, handler) {
      return opts.notificationRouter.registerChannel(channelId, handler);
    },
  };

  // UiRoutes accessor: plugins publish discoverable uiRoute descriptors
  // for the channel-teams Hub + Tab-Config (and any future surface that
  // wants a live "what plugin UIs exist?" view). pluginId is injected
  // from this context's agentId so plugins can't spoof each other.
  const uiRoutes: UiRoutesAccessor = {
    register(input) {
      return opts.uiRouteCatalog.register(agentId, input);
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
    activeProvider: resolveActiveProvider(registry, agentId),
    vault,
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
    notifications,
    uiRoutes,
    smokeMode: false,
    ...(scratch ? { scratch } : {}),
    ...(http ? { http } : {}),
    ...(memory ? { memory } : {}),
    ...(subAgent ? { subAgent } : {}),
    ...(knowledgeGraph ? { knowledgeGraph } : {}),
    ...(llm ? { llm } : {}),
    ...(flows ? { flows } : {}),
    status,
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

/**
 * The LLM provider that serves THIS plugin's `ctx.llm`. Resolution order:
 *  1. the plugin's OWN `llm_provider` config (per-plugin pinning, written by the
 *     provider-admin `/assignment` endpoint),
 *  2. the global default — the orchestrator's `llm_provider` config, exactly as
 *     the kernel's dynamic sub-agent wiring reads it (`hostProviderId()` in
 *     src/index.ts),
 *  3. `'anthropic'` when neither is set, so the default path is unchanged.
 * This same provider drives BOTH the `class:*` whitelist resolution AND the
 * provider the call is actually served on (see `createLlmAccessor`), so gate and
 * execution can never disagree.
 */
function resolveActiveProvider(
  registry: InstalledRegistry,
  agentId: string,
): ProviderId {
  const pinned = registry.get(agentId)?.config?.['llm_provider'];
  if (typeof pinned === 'string' && pinned.trim().length > 0) {
    return pinned.trim();
  }
  const global = registry.get('@omadia/orchestrator')?.config?.['llm_provider'];
  return typeof global === 'string' && global.trim().length > 0
    ? global.trim()
    : 'anthropic';
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
 * Match a single whitelist entry against the requested model id, where
 * `activeProvider` is the LLM provider the runtime is currently serving
 * `ctx.llm` from (see `resolveActiveProvider`).
 *
 * Two entry shapes are supported:
 *
 * 1. Concrete / wildcard (back-compat, provider-agnostic strings) — unchanged
 *    glob semantics, matched against the raw requested id:
 *      - `'claude-haiku-4-5'`  → exact match only
 *      - `'claude-haiku-4-5*'` → prefix match (`'claude-haiku-4-5-20251001'`)
 *      - `'*'`                 → matches anything (sidesteps the whitelist)
 *    Existing installed agents that lock to `['claude-haiku-4-5*']` keep
 *    gating EXACTLY as before, on every provider.
 *
 * 2. Class ref (`class:fast|balanced|frontier`) — provider-agnostic. The class
 *    is resolved against the ACTIVE provider via `modelForClass(cls,
 *    activeProvider)`; the request is permitted ONLY when it denotes THAT model
 *    on the active provider. We accept the resolved bare `modelId`, the
 *    provider-qualified id (`<provider>:<modelId>`), and any registry ref that
 *    resolves (with the active provider as default) to a model owned by the
 *    active provider with the same `modelId` — e.g. the legacy alias `haiku`
 *    under anthropic. A bare id that the registry attributes to a DIFFERENT
 *    provider (e.g. `gpt-5.4-mini` while anthropic is active) does NOT match,
 *    so a `class:fast` lock permits the active provider's fast model and
 *    nothing else. On the Anthropic default this resolves to
 *    `claude-haiku-4-5-20251001` (class `fast`), `claude-sonnet-4-6`
 *    (`balanced`), `claude-opus-4-8` (`frontier`) — byte-identical gating to a
 *    concrete Anthropic lock today.
 */
function modelMatch(
  pattern: string,
  candidate: string,
  activeProvider: ProviderId,
): boolean {
  if (isClassRef(pattern)) {
    const cls = pattern.slice('class:'.length) as ModelClass;
    const target = modelForClass(cls, activeProvider);
    // Unknown class on this provider → no match (fail closed, never throws).
    if (target === undefined) return false;
    if (candidate === target.modelId || candidate === target.id) return true;
    // Accept registry refs (e.g. the legacy alias `haiku`) that resolve to the
    // SAME active-provider model. Resolution is pinned to the active provider
    // and must land on that provider — a cross-provider id never leaks through.
    const resolved = resolveModelRef(candidate, {
      defaultProvider: activeProvider,
    });
    return (
      resolved !== undefined &&
      resolved.provider === activeProvider &&
      resolved.modelId === target.modelId
    );
  }
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
  /** Provider that serves THIS plugin's `ctx.llm` (per-plugin pin → global →
   *  anthropic). Drives both class-ref whitelist resolution AND which provider
   *  the call is built on, so gate and execution stay in lockstep. */
  activeProvider: ProviderId;
  /** Vault for reading the active provider's API key when it is not the
   *  Anthropic default (which keeps using the shared, env/vault-armed
   *  `'llm'` service). */
  vault: SecretVault;
}

function createLlmAccessor(
  opts: LlmAccessorOptions,
): LlmAccessor | undefined {
  const { callerAgentId, permissions, serviceRegistry, activeProvider, vault } =
    opts;
  if (!permissions) return undefined;

  let callsUsed = 0;
  const log = (...args: unknown[]): void =>
    console.log(`[${callerAgentId}/llm]`, ...args);

  // Non-Anthropic providers are built once from the plugin's vault key and
  // cached for this context's lifetime (a re-assignment reactivates the plugin
  // → fresh context → fresh accessor, so the cache never goes stale). The
  // Anthropic default keeps using the shared `'llm'` service so the existing
  // ENV-or-vault key path stays byte-identical. Cache the in-flight build
  // promise so concurrent first callers await the same provider construction.
  let buildPromise: Promise<LlmProvider | undefined> | undefined;
  const resolveServingProvider = (): Promise<LlmProvider | undefined> => {
    if (activeProvider === 'anthropic') {
      return Promise.resolve(serviceRegistry.get<LlmProvider>('llm'));
    }
    if (buildPromise === undefined) {
      buildPromise = (async () => {
        const neutral = await resolveLlmProvider({
          providerId: activeProvider,
          getSecret: (key) => vault.get(callerAgentId, key),
          log,
        });
        // Bridge the neutral adapter to the narrow plugin-facing LlmProvider —
        // the same translation the Anthropic 'llm' service uses.
        return neutral !== undefined
          ? createLlmProviderFromNeutral(neutral, log)
          : undefined;
      })();
    }
    return buildPromise;
  };

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
        modelMatch(p, req.model, activeProvider),
      );
      if (!allowed) {
        throw new LlmModelNotAllowedError(callerAgentId, req.model);
      }
      // Fail loud if the pinned provider has no configured key — never silently
      // serve a different provider than the one the gate authorised against.
      const provider = await resolveServingProvider();
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

      // Coerce the requested model to the serving provider: a `class:*` ref or a
      // cross-vendor id maps to that provider's same-class model; a concrete id
      // the provider already owns is returned unchanged (Anthropic default is
      // idempotent — byte-identical to before). Unknown/custom ids pass through.
      const model = coerceModelToProvider(req.model, activeProvider);

      callsUsed += 1;
      return provider.complete({
        ...req,
        model,
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

/**
 * #91 — resolve the operator-set audit config for a plugin: the selected
 * `audit_mode` and the union of every `host_list` setup field's value. Both
 * live in the plugin's own InstalledRegistry config (written by the admin
 * mode-switch UI); unset or malformed entries are simply ignored, so a
 * fresh install defaults to `single-host` with no extra hosts.
 */
function extractAuditConfig(
  agentId: string,
  catalog: PluginCatalog,
  registry: InstalledRegistry,
): { auditMode?: AuditMode; extraHosts: string[] } {
  const config = registry.get(agentId)?.config ?? {};
  const extraHosts: string[] = [];
  const fields = catalog.get(agentId)?.plugin.setup_fields ?? [];
  for (const field of fields) {
    if (field.type !== 'host_list') continue;
    const value = config[field.key];
    if (!Array.isArray(value)) continue;
    for (const host of value) {
      if (typeof host === 'string' && host.length > 0) extraHosts.push(host);
    }
  }
  // Operator override (registry config) wins; otherwise fall back to the audit
  // mode the plugin manifest declared as its intended default (#91). A
  // non-web_scanner plugin is still forced to single-host in createHttpAccessor,
  // so this default only takes effect for declared scanners.
  const rawMode = config['audit_mode'];
  const declaredDefault = catalog.get(agentId)?.plugin.permissions_summary.network_default_audit_mode;
  const auditMode: AuditMode | undefined = isAuditMode(rawMode)
    ? rawMode
    : isAuditMode(declaredDefault)
      ? declaredDefault
      : undefined;
  return {
    ...(auditMode ? { auditMode } : {}),
    extraHosts,
  };
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
