import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';

import { createPluginContext } from '../platform/pluginContext.js';
import type { PluginRouteRegistry } from '../platform/pluginRouteRegistry.js';
import type { NotificationRouter } from '../platform/notificationRouter.js';
import type { UiRouteCatalog } from '../platform/uiRouteCatalog.js';
import type { ServiceRegistry } from '../platform/serviceRegistry.js';
import type { SecretVault } from '../secrets/vault.js';
import type { NativeToolRegistry } from '@omadia/orchestrator';
import { LocalSubAgent, type LocalSubAgentTool } from '@omadia/orchestrator';
import type { Orchestrator } from '@omadia/orchestrator';
import {
  createDomainTool,
  type DomainTool,
} from '@omadia/orchestrator';

import { parseAgentMd } from './agentMdFrontmatter.js';
import type { BuiltInPackageStore } from './builtInPackageStore.js';
import type { InstalledRegistry } from './installedRegistry.js';
import type { JobScheduler } from './jobScheduler.js';
import type { PluginCatalog, PluginCatalogEntry } from './manifestLoader.js';
import { composePersonaSection } from './personaCompose.js';
import type { PersonaModelFamily } from './personaDelta.js';
import { topoSortByDependsOn } from './topoSort.js';
import type { UploadedPackageStore } from './uploadedPackageStore.js';
import { zodToJsonSchema } from './zodToJsonSchema.js';

/**
 * Runtime for uploaded agent packages.
 *
 * For each installed-and-uploaded agent:
 *   1. Dynamic import of `<pkg>/dist/<manifest.lifecycle.entry>`
 *   2. Call `activate(ctx)` with an agent-scoped PluginContext
 *   3. Wrap returned `Toolkit.tools` (Zod) into LocalSubAgent tools
 *      (JSON-Schema)
 *   4. Build a LocalSubAgent with a system prompt from `manifest.skills[*].path`
 *   5. Attach as an askable to the orchestrator via `createDomainTool`
 *
 * On uninstall / hot-unload:
 *   1. Remove DomainTool from the orchestrator (hot — no restart needed)
 *   2. Run `handle.close()` (connections, timers, …)
 *   3. Delete the entry from the internal map
 *
 * The runtime only knows uploaded packages. Built-in sub-agents
 * (Odoo, Confluence, Calendar) are still wired statically in index.ts —
 * this is intentionally not merged so the two paths stay separately
 * observable.
 */

// Structurally compatible with the package contract (see middleware/packages/agent-seo-analyst/plugin.ts).
// Tools can arrive in two shapes:
//   1. Zod-style `{ id, description, input: ZodType, run }` — the builder
//      default for self-generated tools.
//   2. Already-bridged `LocalSubAgentTool` (`{ spec, handle }`) — when a
//      sub-agent plugin (e.g. agent-odoo-accounting) consumes a scope-locked
//      tool from an integration and forwards it.
interface UploadedToolkit {
  readonly tools: ReadonlyArray<
    | {
        readonly id: string;
        readonly description: string;
        readonly input: z.ZodType<unknown>;
        run(input: unknown): Promise<unknown>;
      }
    | LocalSubAgentTool
  >;
}

interface UploadedAgentHandle {
  readonly toolkit: UploadedToolkit;
  close(): Promise<void>;
}

interface UploadedModuleShape {
  activate?: (ctx: unknown) => Promise<UploadedAgentHandle>;
  default?: {
    activate?: (ctx: unknown) => Promise<UploadedAgentHandle>;
  };
}

interface ActiveAgent {
  agentId: string;
  handle: UploadedAgentHandle;
  domainTool: DomainTool;
  /** OB-29-1 — dispose handle for the `subAgent:<agentId>` ServiceRegistry
   *  entry. Called on deactivate so a hot-upgrade doesn't leave a stale
   *  DomainTool reachable via `ctx.subAgent.ask`. */
  disposeSubAgentService: () => void;
}

export interface DynamicAgentRuntimeDeps {
  catalog: PluginCatalog;
  registry: InstalledRegistry;
  vault: SecretVault;
  uploadedStore: UploadedPackageStore;
  /** Packages that ship inside the middleware image (under
   *  `middleware/packages/*`). Optional: when omitted, only uploaded
   *  packages are candidates for activation. When both stores declare the
   *  same `agentId`, the uploaded package wins — lets an operator override
   *  a built-in by uploading a newer zip. */
  builtInStore?: BuiltInPackageStore;
  anthropic: Anthropic;
  subAgentModel: string;
  subAgentMaxTokens: number;
  subAgentMaxIterations: number;
  serviceRegistry: ServiceRegistry;
  /** Shared registry for plugin-contributed top-level native tools. Activated
   *  plugins register handlers here via `ctx.tools.register(...)`. */
  nativeToolRegistry: NativeToolRegistry;
  /** Shared registry for plugin-contributed Express routers. Activated
   *  plugins register mounts here via `ctx.routes.register(prefix, router)`. */
  pluginRouteRegistry: PluginRouteRegistry;
  notificationRouter: NotificationRouter;
  uiRouteCatalog: UiRouteCatalog;
  /** Kernel-wide background-job scheduler. Plugin-contributed jobs register
   *  here via `ctx.jobs.register(spec, handler)`. */
  jobScheduler: JobScheduler;
  log?: (...args: unknown[]) => void;
}

export class DynamicAgentRuntime {
  private readonly active = new Map<string, ActiveAgent>();
  private orchestrator: Orchestrator | null = null;

  constructor(private readonly deps: DynamicAgentRuntimeDeps) {}

  /** Must be set exactly once after orchestrator construction.
   *  Hot-register only takes effect after this.
   *
   *  Tools the orchestrator already knows through its `options.domainTools`
   *  constructor parameter are skipped here — otherwise `registerDomainTool`
   *  would throw duplicate errors immediately. This is the usual boot flow:
   *  `activateAllInstalled()` builds the DomainTool list, index.ts hands it
   *  to the orchestrator, and `attachOrchestrator()` only keeps the reference
   *  around for later hot-installs. */
  attachOrchestrator(orchestrator: Orchestrator): void {
    this.orchestrator = orchestrator;
    for (const entry of this.active.values()) {
      if (!orchestrator.hasDomainTool(entry.domainTool.name)) {
        orchestrator.registerDomainTool(entry.domainTool);
      }
    }
  }

  /** Reverse-lookup: given a domain-tool name (`query_<short>`), return the
   *  agent id that exposes it. Used by the chat route to attach agent metadata
   *  to `tool_use` events for the UI's pill rendering. Returns `undefined`
   *  when the tool is not backed by a Builder-uploaded / dynamic agent (could
   *  be a built-in tool, a helper tool, or simply not registered). */
  findAgentIdByToolName(toolName: string): string | undefined {
    for (const entry of this.active.values()) {
      if (entry.domainTool.name === toolName) return entry.agentId;
    }
    return undefined;
  }

  /** Activates all uploaded and built-in packages that are already marked
   *  `active` in the registry. Returns the DomainTools so the caller can
   *  pass them in on the initial orchestrator construction. */
  async activateAllInstalled(): Promise<DomainTool[]> {
    const log = this.deps.log ?? ((...a: unknown[]) => console.log(...a));
    const out: DomainTool[] = [];

    // Merge ids from both stores; uploaded overrides built-in if duplicated.
    const ids = new Set<string>();
    for (const pkg of this.deps.uploadedStore.list()) ids.add(pkg.id);
    if (this.deps.builtInStore) {
      for (const pkg of this.deps.builtInStore.list()) ids.add(pkg.id);
    }

    // Pre-filter to agent-kind ids that are registry-active, then
    // topologically sort by manifest `depends_on` so an agent's deps
    // activate first. Cross-runtime deps (agent depending on a tool/
    // extension plugin) are handled by the outer boot order — the
    // tool runtime runs before this one.
    const eligible: string[] = [];
    for (const id of ids) {
      // Skip non-agent kinds — tool/extension plugins go through
      // ToolPluginRuntime, channel plugins through DefaultChannelRegistry.
      // Integration-kind plugins are library-only (no activate()) and are
      // consumed directly by their dependents via shared code.
      const catalogEntry = this.deps.catalog.get(id);
      if (catalogEntry && catalogEntry.plugin.kind !== 'agent') continue;

      // OB-29-5: builder-reference plugins (`is_reference_only: true`) are
      // exclusively a pattern source for the BuilderAgent (read_reference)
      // and have no business in either the operator plugin catalog or the
      // active runtime. Without this skip the reference plugin (which
      // intentionally exposes no sub-agent-tools[]) would crash here with
      // "Cannot read properties of undefined (reading 'map')".
      if (catalogEntry?.plugin.is_reference_only === true) continue;

      const reg = this.deps.registry.get(id);
      // Circuit-breaker: `errored` entries have failed activation
      // CIRCUIT_BREAKER_THRESHOLD times in a row; skip them until manual
      // re-enable. Also skip inactive (never-installed / soft-disabled).
      if (!reg || reg.status !== 'active') continue;
      eligible.push(id);
    }

    const sorted = topoSortByDependsOn(eligible, this.deps.catalog);

    for (const id of sorted) {
      try {
        const tool = await this.activate(id);
        if (tool) out.push(tool);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`[dynamic-runtime] activate FAILED for ${id}: ${msg}`);
        try {
          await this.deps.registry.markActivationFailed(id, msg);
        } catch (registryErr) {
          // Registry write failure is secondary — log but don't rethrow.
          log(
            `[dynamic-runtime] registry markActivationFailed FAILED for ${id}: ${registryErr instanceof Error ? registryErr.message : String(registryErr)}`,
          );
        }
      }
    }
    return out;
  }

  /** Resolve the on-disk package root for a given agent id. Uploaded packages
   *  win over built-ins when the id is present in both — lets an operator
   *  override a built-in without removing it from the image. */
  private resolvePackagePath(agentId: string): string | undefined {
    const uploaded = this.deps.uploadedStore.get(agentId);
    if (uploaded) return uploaded.path;
    return this.deps.builtInStore?.get(agentId)?.path;
  }

  /** Activates a single uploaded agent. Idempotent: already-active
   *  agents are returned without a second import. */
  async activate(agentId: string): Promise<DomainTool | null> {
    const log = this.deps.log ?? ((...a: unknown[]) => console.log(...a));
    const existing = this.active.get(agentId);
    if (existing) return existing.domainTool;

    const packagePath = this.resolvePackagePath(agentId);
    if (!packagePath) return null; // Agent is not known in any store.

    const catalogEntry = this.deps.catalog.get(agentId);
    if (!catalogEntry) {
      throw new Error(`dynamic-runtime: ${agentId} not in plugin catalog`);
    }
    // OB-29-5: defensive guard mirroring the activateAllInstalled-loop —
    // is_reference_only plugins are never to be wrapped in a LocalSubAgent
    // / DomainTool. activate() is also called from the install flow and
    // hot-reload paths; this guard keeps both safe.
    if (catalogEntry.plugin.is_reference_only === true) {
      throw new Error(
        `dynamic-runtime: cannot activate '${agentId}' — plugin is marked is_reference_only=true (Builder-Reference, read_reference-only)`,
      );
    }

    const entryRel = extractEntryPath(catalogEntry) ?? 'dist/plugin.js';
    const entryAbs = path.resolve(packagePath, entryRel);
    if (!entryAbs.startsWith(packagePath + path.sep)) {
      throw new Error(
        `dynamic-runtime: entry path escapes package root (${entryRel})`,
      );
    }
    await ensureReadable(entryAbs);

    const mod = (await import(pathToFileURL(entryAbs).href)) as UploadedModuleShape;
    const activateFn = mod.activate ?? mod.default?.activate;
    if (typeof activateFn !== 'function') {
      throw new Error(
        `dynamic-runtime: ${entryAbs} exports neither activate() nor default.activate()`,
      );
    }

    const ctx = createPluginContext({
      agentId,
      vault: this.deps.vault,
      registry: this.deps.registry,
      catalog: this.deps.catalog,
      serviceRegistry: this.deps.serviceRegistry,
      nativeToolRegistry: this.deps.nativeToolRegistry,
      routeRegistry: this.deps.pluginRouteRegistry,
      notificationRouter: this.deps.notificationRouter,
      uiRouteCatalog: this.deps.uiRouteCatalog,
      jobScheduler: this.deps.jobScheduler,
      logger: (...args) => console.log(`[${agentId}]`, ...args),
    });

    // Pre-flight: two uploaded agents whose agentIds end in the same
    // dot-segment generate the same top-level DomainTool name (`query_<short>`).
    // Without this check, the second activate silently clobbered the first
    // (Map.set last-wins). Surface a clear error with BOTH agent ids so the
    // operator knows which two conflict.
    const shortName = shortAgentName(agentId);
    const toolName = `query_${shortName.replace(/-/g, '_')}`;
    const conflictingAgent = Array.from(this.active.values()).find(
      (a) => a.domainTool.name === toolName && a.agentId !== agentId,
    );
    if (conflictingAgent) {
      throw new Error(
        `dynamic-runtime: cannot activate '${agentId}' — tool name '${toolName}' is already held by '${conflictingAgent.agentId}'. ` +
          `Two agents whose ids end in the same dot-segment ('${shortName}') cannot be active at once. Rename or uninstall one.`,
      );
    }
    if (this.orchestrator?.hasDomainTool(toolName)) {
      throw new Error(
        `dynamic-runtime: cannot activate '${agentId}' — tool name '${toolName}' is already registered on the orchestrator (possibly a built-in agent). Rename the uploaded agent.`,
      );
    }

    const handle = await withTimeout(
      activateFn(ctx),
      10_000,
      `activate(${agentId}) timed out after 10s`,
    );

    // Intra-agent subtool-name duplicate check. A plugin that defines two
    // toolkit tools with the same id is a plugin bug; detect early so the
    // activation fails loud instead of the second tool silently overwriting
    // the first inside LocalSubAgent.toolsByName. Tolerate both toolkit
    // shapes: UploadedToolkit uses `id`, LocalSubAgentTool uses `spec.name`.
    const subtoolIds = handle.toolkit.tools.map((t) =>
      isLocalSubAgentTool(t) ? t.spec.name : t.id,
    );
    const duplicateSubtool = findFirstDuplicate(subtoolIds);
    if (duplicateSubtool) {
      // Cleanup: close the handle we just activated so resources don't leak.
      await entryCloseQuietly(handle);
      throw new Error(
        `dynamic-runtime: plugin '${agentId}' declares duplicate subtool id '${duplicateSubtool}' — toolkit.tools[*].id must be unique within a package`,
      );
    }

    const subAgentTools: LocalSubAgentTool[] = handle.toolkit.tools.map((t) =>
      bridgeTool(t),
    );

    // Respect `llm.prefers.model` from the manifest when present — an agent
    // author may pick Haiku for a fast classifier-style agent or Opus for a
    // reasoning-heavy one. Falls back to the host-default when absent. For
    // MVP we trust the manifest string verbatim; a whitelist lands with the
    // security-hardening work (see security-hardening-backlog.md).
    const preferredModel = extractPreferredModel(catalogEntry);
    const effectiveModel = preferredModel ?? this.deps.subAgentModel;

    // Phase 3 (OB-67): hand the effective model into loadSystemPrompt so the
    // persona compose step can compute deltas against the right family
    // defaults (Sonnet/Opus/Haiku tune the LLM differently at the same
    // axis value).
    const systemPrompt = await loadSystemPrompt(
      packagePath,
      catalogEntry,
      effectiveModel,
    );

    const subAgent = new LocalSubAgent({
      name: shortName,
      client: this.deps.anthropic,
      model: effectiveModel,
      maxTokens: this.deps.subAgentMaxTokens,
      maxIterations: this.deps.subAgentMaxIterations,
      systemPrompt,
      tools: subAgentTools,
    });

    const description = buildDomainToolDescription(catalogEntry);

    // OB-77 — Domain inherits from the agent's manifest (`identity.domain`).
    // Auto-fallback `unknown.<id>` is already applied in the loader, so this
    // is always a valid domain string per `PLUGIN_DOMAIN_REGEX`. Each
    // uploaded agent thus contributes its own domain bucket without any
    // central registration — exactly the "wachsende Welt"-property.
    const domainTool = createDomainTool({
      name: toolName,
      description,
      agent: subAgent,
      domain: catalogEntry.plugin.domain,
    });

    // OB-29-1 — publish the DomainTool as a `subAgent:<agentId>` service
    // so other plugins can reach it via `ctx.subAgent.ask`. Provide on top
    // of (not instead of) the orchestrator-tool registration: the model
    // reaches it via the tool, plugins reach it via the service.
    const disposeSubAgentService = this.deps.serviceRegistry.provide(
      `subAgent:${agentId}`,
      domainTool,
    );

    this.active.set(agentId, {
      agentId,
      handle,
      domainTool,
      disposeSubAgentService,
    });
    this.orchestrator?.registerDomainTool(domainTool);

    // Circuit-breaker: clear any prior failure counter so an agent that
    // recovers (e.g. after a config fix + re-upload) returns to a healthy
    // starting state for the next boot. Best-effort — registry write errors
    // are logged but don't fail the activation.
    try {
      await this.deps.registry.markActivationSucceeded(agentId);
    } catch (err) {
      log(
        `[dynamic-runtime] registry markActivationSucceeded FAILED for ${agentId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    log(
      `[dynamic-runtime] ACTIVATED ${agentId} as ${toolName} (tools=${subAgentTools.length}, entry=${entryRel})`,
    );
    return domainTool;
  }

  async deactivate(agentId: string): Promise<boolean> {
    const log = this.deps.log ?? ((...a: unknown[]) => console.log(...a));
    const entry = this.active.get(agentId);
    if (!entry) return false;
    this.orchestrator?.unregisterDomainTool(entry.domainTool.name);
    // OB-29-1 — symmetric to the activate-time provide(). A hot-upgrade
    // re-runs activate() which registers a fresh DomainTool; without this
    // dispose, ServiceRegistry would throw 'duplicate provider'.
    entry.disposeSubAgentService();
    try {
      await withTimeout(
        entry.handle.close(),
        5_000,
        `close(${agentId}) timed out after 5s`,
      );
    } catch (err) {
      log(
        `[dynamic-runtime] close FAILED for ${agentId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // Fail-safe: dispose any Express routes the plugin registered, even if
    // its own close() body forgot to call the per-route dispose handle.
    // Without this, a hot-upgrade leaves the previous version's router
    // mounted under the same prefix and Express's first-match-wins rule
    // serves stale responses (observed 2026-05-04 with unifi-device-tracker
    // v0.4.0 → v0.5.0).
    const disposedCount =
      this.deps.pluginRouteRegistry.disposeBySource(agentId);
    if (disposedCount > 0) {
      log(
        `[dynamic-runtime] disposed ${String(disposedCount)} route mount(s) for ${agentId}`,
      );
    }
    // Bulk-stop any background jobs the plugin registered. Symmetric with the
    // ToolPluginRuntime — see toolPluginRuntime.ts for the same belt-and-braces
    // teardown comment.
    this.deps.jobScheduler.stopForPlugin(agentId);
    this.deps.uiRouteCatalog.disposeBySource(agentId);
    this.active.delete(agentId);
    log(`[dynamic-runtime] DEACTIVATED ${agentId}`);
    return true;
  }

  isActive(agentId: string): boolean {
    return this.active.has(agentId);
  }

  activeIds(): string[] {
    return Array.from(this.active.keys());
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Two toolkit-tool shapes flow into the dynamic runtime:
 *
 *   - `UploadedToolkit['tools'][number]` — the legacy Zod-based contract
 *     (`{ id, description, input: ZodType, run() }`). Used by the canonical
 *     Builder-emitted plugins (agent-seo-analyst, etc.).
 *   - `LocalSubAgentTool` — already-bridged shape (`{ spec: { name,
 *     description, input_schema }, handle() }`). Used by the Phase-5B-
 *     extracted sub-agent plugins (agent-odoo-accounting, agent-odoo-hr,
 *     agent-confluence) that consume `LocalSubAgentTool`-typed services
 *     from their integration plugins.
 *
 * Distinguish by duck-typing: `spec.input_schema` is the LocalSubAgentTool
 * marker. Passing it through unchanged avoids re-bridging a tool that's
 * already in the kernel's expected shape (and would otherwise crash on
 * `td.input._def` because there is no Zod schema there).
 */
function isLocalSubAgentTool(t: unknown): t is LocalSubAgentTool {
  return (
    typeof t === 'object' &&
    t !== null &&
    'spec' in t &&
    'handle' in t &&
    typeof (t as { handle: unknown }).handle === 'function'
  );
}

function bridgeTool(
  td: UploadedToolkit['tools'][number] | LocalSubAgentTool,
): LocalSubAgentTool {
  if (isLocalSubAgentTool(td)) return td;
  const schema = zodToJsonSchema(td.input);
  const properties =
    schema.properties && typeof schema.properties === 'object'
      ? schema.properties
      : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  return {
    spec: {
      name: td.id,
      description: td.description,
      input_schema: {
        type: 'object',
        properties,
        required,
      },
    },
    async handle(input: unknown): Promise<string> {
      try {
        const parsed = td.input.parse(input);
        const result = await td.run(parsed);
        return typeof result === 'string'
          ? result
          : JSON.stringify(result, null, 2);
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

async function loadSystemPrompt(
  packageRoot: string,
  entry: PluginCatalogEntry,
  modelId: string,
): Promise<string> {
  const manifest = entry.manifest as Record<string, unknown> | undefined;
  const skills = Array.isArray(manifest?.['skills']) ? manifest['skills'] : [];
  const skillParts: string[] = [];
  for (const s of skills) {
    const rec = s as Record<string, unknown> | null;
    if (!rec) continue;
    if (rec['kind'] !== 'prompt_partial') continue;
    const relPath = typeof rec['path'] === 'string' ? rec['path'] : '';
    if (!relPath) continue;
    const absPath = path.resolve(packageRoot, relPath);
    if (!absPath.startsWith(packageRoot + path.sep)) continue;
    try {
      const raw = await fs.readFile(absPath, 'utf-8');
      skillParts.push(stripFrontmatter(raw).trim());
    } catch {
      // missing skill file: skip — the agent may still work, just with less prompt guidance.
    }
  }

  // Phase 3 (OB-67) — read AGENT.md frontmatter and compose the persona
  // section. The file is optional: legacy plugins without an AGENT.md
  // simply get no persona injection. Read failures are swallowed so a
  // mis-packaged plugin doesn't take down activation.
  const personaSection = await composePersonaFromAgentMd(packageRoot, modelId);

  const header = buildHeader(entry);
  const parts: string[] = [header];
  if (personaSection.length > 0) parts.push(personaSection);
  if (skillParts.length > 0) parts.push(skillParts.join('\n\n---\n\n'));
  return parts.join('\n\n---\n\n');
}

/**
 * Phase 3 (OB-67) — read the plugin's AGENT.md (if present), parse the
 * frontmatter, and compose the `<persona>` system-prompt section.
 * Returns `''` when:
 *   - no AGENT.md or agent.md file at the package root
 *   - file read fails
 *   - frontmatter is missing / malformed
 *   - no persona block present, or all axes neutral with no custom_notes
 *
 * Tries `AGENT.md` (canonical, Builder-codegen output) then `agent.md`
 * (legacy / hand-authored) before giving up.
 */
export async function composePersonaFromAgentMd(
  packageRoot: string,
  modelId: string,
): Promise<string> {
  for (const candidate of ['AGENT.md', 'agent.md']) {
    const p = path.join(packageRoot, candidate);
    let content: string;
    try {
      content = await fs.readFile(p, 'utf-8');
    } catch {
      continue;
    }
    const parsed = parseAgentMd(content);
    if (!parsed.frontmatter?.persona) return '';
    return composePersonaSection({
      persona: parsed.frontmatter.persona,
      family: inferFamilyFromModel(modelId),
    });
  }
  return '';
}

/**
 * Map an Anthropic model id (e.g. `claude-sonnet-4-6`) to one of the
 * three persona-family buckets. Unknown / mis-spelled models default
 * to Sonnet — the safe middle ground for the per-family delta math.
 */
export function inferFamilyFromModel(modelId: string): PersonaModelFamily {
  const lower = modelId.toLowerCase();
  if (lower.includes('haiku')) return 'haiku';
  if (lower.includes('opus')) return 'opus';
  return 'sonnet';
}

function buildHeader(entry: PluginCatalogEntry): string {
  const manifest = entry.manifest as Record<string, unknown> | undefined;
  const playbook = manifest?.['playbook'] as Record<string, unknown> | undefined;
  const whenToUse = typeof playbook?.['when_to_use'] === 'string'
    ? (playbook['when_to_use'] as string).trim()
    : '';
  const desc = entry.plugin.description;
  const parts = [
    `# ${entry.plugin.name} (${entry.plugin.id} v${entry.plugin.version})`,
    desc,
  ];
  if (whenToUse) parts.push(`## Wann nutzen\n\n${whenToUse}`);
  return parts.filter(Boolean).join('\n\n');
}

function stripFrontmatter(md: string): string {
  return md.replace(/^---\n[\s\S]*?\n---\n?/, '');
}

function buildDomainToolDescription(entry: PluginCatalogEntry): string {
  const manifest = entry.manifest as Record<string, unknown> | undefined;
  const playbook = manifest?.['playbook'] as Record<string, unknown> | undefined;
  const whenToUse = typeof playbook?.['when_to_use'] === 'string'
    ? (playbook['when_to_use'] as string).trim()
    : '';
  const notFor = Array.isArray(playbook?.['not_for'])
    ? (playbook['not_for'] as unknown[])
        .filter((x): x is string => typeof x === 'string')
        .map((x) => `• ${x}`)
        .join(' ')
    : '';

  const parts = [entry.plugin.description];
  if (whenToUse) parts.push(whenToUse);
  if (notFor) parts.push(`NICHT geeignet für: ${notFor}`);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function shortAgentName(agentId: string): string {
  // Take last segment after splitting on either `.` (legacy `de.byte5.agent.X`)
  // or `/` (post-Welle-1 `@omadia/X`). The Anthropic tool-name regex
  // (`^[a-zA-Z0-9_-]{1,128}$`) rejects `@` and `/`, so the npm-scope namespace
  // must be stripped before composing the `query_<short>` tool name.
  const last = agentId.split(/[./]/).pop() ?? agentId;
  // Drop a leading `agent-` kind prefix (`agent-seo-analyst` → `seo-analyst`)
  // so the composed tool name reads `query_seo_analyst` instead of the
  // tautological `query_agent_seo_analyst`. Only this runtime handles
  // kind=agent, so the prefix is redundant. Guard against an empty result.
  const stripped = last.replace(/^agent-/, '');
  return stripped.length > 0 ? stripped : last;
}

function extractEntryPath(entry: PluginCatalogEntry): string | undefined {
  const manifest = entry.manifest as Record<string, unknown> | undefined;
  const lifecycle = manifest?.['lifecycle'] as Record<string, unknown> | undefined;
  const raw = lifecycle?.['entry'];
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

function extractPreferredModel(entry: PluginCatalogEntry): string | undefined {
  const manifest = entry.manifest as Record<string, unknown> | undefined;
  const llm = manifest?.['llm'] as Record<string, unknown> | undefined;
  const prefers = llm?.['prefers'] as Record<string, unknown> | undefined;
  const raw = prefers?.['model'];
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

async function ensureReadable(absPath: string): Promise<void> {
  try {
    await fs.access(absPath);
  } catch {
    throw new Error(`dynamic-runtime: entry file not readable at ${absPath}`);
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Returns the first value that appears more than once, or undefined. */
function findFirstDuplicate(values: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const v of values) {
    if (seen.has(v)) return v;
    seen.add(v);
  }
  return undefined;
}

/** Best-effort close used when we must abort activation after the plugin's
 *  `activate()` already returned a handle. Swallows errors — the primary
 *  failure is the caller's to report. */
async function entryCloseQuietly(
  handle: UploadedAgentHandle,
): Promise<void> {
  try {
    await withTimeout(handle.close(), 5_000, 'close() timed out after 5s');
  } catch {
    // swallow — caller is already throwing a more informative error
  }
}
