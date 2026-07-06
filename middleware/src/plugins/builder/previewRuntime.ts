import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'yaml';
import type { z } from 'zod';

import type { HttpAccessor } from '@omadia/plugin-api';

import { extractZipToDir, type ExtractLimits } from '../zipExtractor.js';
import { createHttpAccessor, isAuditMode } from '../../platform/httpAccessor.js';
import {
  createPreviewMemoryAccessor,
  type PreviewMemoryAccessor,
} from './previewMemoryStore.js';

/**
 * PreviewRuntime — activates a builder-built ZIP into an ephemeral, in-memory
 * Agent-Handle for live testing inside the workspace UI.
 *
 * Distinct from `dynamicAgentRuntime.ts` (which serves *installed* agents and
 * registers them as DomainTools on the orchestrator):
 *   - Preview agents are NOT in the InstalledRegistry and never reach the
 *     orchestrator's domain-tool list.
 *   - Preview agents do NOT consume the SecretVault; setup-field values come
 *     from the draft (workspace-UI-supplied), in-memory only.
 *   - Preview agents do NOT register native tools or jobs.
 *   - `ctx.routes.register()` exists as a NO-OP stub: route-mounting plugins
 *     (admin-UI, webhooks) do not crash on activate, but their routes are
 *     not served from the preview iframe — admin UIs only become reachable
 *     after a real Install via the Kernel's route-registry.
 *
 * The runtime is dependency-injectable: `extractZip` and `activateModule` can
 * be replaced for tests without spinning up a real boilerplate build.
 */

const PREVIEW_LIMITS: ExtractLimits = {
  maxEntries: 5_000,
  maxExtractedBytes: 50 * 1024 * 1024,
  maxFileBytes: 10 * 1024 * 1024,
};

export interface PreviewToolDescriptor {
  readonly id: string;
  readonly description: string;
  readonly input: z.ZodType<unknown>;
  run(input: unknown): Promise<unknown>;
}

export interface PreviewToolkit {
  readonly tools: ReadonlyArray<PreviewToolDescriptor>;
}

export interface PreviewAgentHandle {
  readonly toolkit: PreviewToolkit;
  close(): Promise<void>;
}

export interface PreviewModuleShape {
  activate?: (ctx: PreviewPluginContext) => Promise<PreviewAgentHandle>;
  default?: {
    activate?: (ctx: PreviewPluginContext) => Promise<PreviewAgentHandle>;
  };
}

/**
 * Minimal PluginContext surface for preview agents — matches what the
 * boilerplate's `activate()` reads (see `boilerplate/agent-integration/types.ts`).
 * Preview never wires service-registry or native-tools. `routes` captures
 * (prefix, router) pairs locally so that the runtime-smoke pass (Theme D)
 * can introspect them later; nothing is actually served from the preview
 * iframe — admin-UI URLs only become reachable after a real Install.
 *
 * `smokeMode` is `true` exactly when the runtime activates the handle
 * specifically for a smoke probe; chat-preview activations leave it
 * `false`. Plugins MAY branch on it to return mock data instead of
 * hitting non-idempotent production APIs during the probe.
 */
/** B.12 — mirror of `UiRouteDescriptorInput` from plugin-api. Inline-
 *  copied to keep previewRuntime self-contained (no plugin-api import).
 *  Kernel-side validator runs the real check at install-time; the preview
 *  stub accepts anything and discards. */
export interface PreviewUiRouteDescriptorInput {
  readonly routeId: string;
  readonly path: string;
  readonly title: string;
  readonly description?: string;
  readonly order?: number;
}

/** Mirror of `LlmCompleteRequest` from the boilerplate contract. Inline-copied
 *  to keep previewRuntime self-contained (no plugin-api import). */
export interface PreviewLlmCompleteRequest {
  readonly model: string;
  readonly system?: string;
  readonly messages: ReadonlyArray<{
    readonly role: 'user' | 'assistant';
    readonly content: string;
  }>;
  readonly maxTokens?: number;
  readonly temperature?: number;
}

/** Mirror of `LlmCompleteResult` from the boilerplate contract. */
export interface PreviewLlmCompleteResult {
  readonly text: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly stopReason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use';
}

/** Plugin-facing LLM accessor surface (mirror of `LlmAccessor`). */
export interface PreviewLlmAccessor {
  complete(req: PreviewLlmCompleteRequest): Promise<PreviewLlmCompleteResult>;
  readonly modelsAllowed: readonly string[];
}

/** Structural subset of the host `'llm'` service the kernel registers — only
 *  the `complete` the preview accessor delegates to. Resolved from the wired
 *  ServiceRegistry via `hostServices.get('llm')`. */
export interface PreviewHostLlmProvider {
  complete(req: PreviewLlmCompleteRequest): Promise<PreviewLlmCompleteResult>;
}

/** LLM permission extracted from the package manifest, mirroring the kernel's
 *  `extractLlmPermissions`. Empty `modelsAllowed` means the agent declared no
 *  LLM access → `ctx.llm` stays absent. */
export interface PreviewLlmConfig {
  readonly modelsAllowed: readonly string[];
  readonly callsPerInvocation: number;
  readonly maxTokensPerCall: number;
}

/** Mirror of `JobSchedule` from the boilerplate contract
 *  (`agent-integration/types.ts`). Inline-copied to keep previewRuntime
 *  self-contained. */
export type PreviewJobSchedule =
  | { readonly cron: string }
  | { readonly intervalMs: number };

/** Mirror of `JobSpec` — only the fields the preview needs to capture +
 *  surface. The kernel validates the full shape at register-time; the
 *  preview accepts and records it without scheduling anything. */
export interface PreviewJobSpecInput {
  readonly name: string;
  readonly schedule: PreviewJobSchedule;
  readonly timeoutMs?: number;
  readonly overlap?: 'skip' | 'queue';
}

export type PreviewJobHandler = (signal: AbortSignal) => Promise<void>;

/** Mirror of `PluginActionStatus` from the boilerplate contract. */
export interface PreviewStatusInput {
  readonly state: 'ok' | 'needs_action' | 'error';
  readonly title?: string;
  readonly detail?: string;
}

export interface PreviewPluginContext {
  readonly agentId: string;
  readonly secrets: {
    get(key: string): Promise<string | undefined>;
    require(key: string): Promise<string>;
    keys(): Promise<readonly string[]>;
  };
  readonly config: {
    get<T = unknown>(key: string): T | undefined;
    require<T = unknown>(key: string): T;
  };
  readonly routes: {
    register(prefix: string, router: unknown): () => void;
  };
  /** B.12 — UI-Route catalogue. Preview accepts descriptors and discards
   *  (no Hub-render in preview). Real catalogue lives in middleware
   *  kernel after install. */
  readonly uiRoutes: {
    register(descriptor: PreviewUiRouteDescriptorInput): () => void;
  };
  /** Background-job registry. Non-optional in the kernel contract
   *  (`pluginContext.ts` always wires `jobs`), so a plugin with a scheduled
   *  job calls `ctx.jobs.register(...)` in activate() unconditionally. Before
   *  this stub existed the call threw `Cannot read properties of undefined
   *  (reading 'register')` ONLY in preview — the agent compiled and ran fine
   *  after install. The preview CAPTURES the registration (so the operator can
   *  see "this agent schedules N jobs") and returns a working disposer, but
   *  deliberately does NOT fire the cron/interval: preview activations are
   *  ephemeral and must not trigger real side effects. Contract-parity without
   *  runtime side effects — the same call shape and disposer the kernel hands
   *  the plugin post-install. */
  readonly jobs: {
    register(spec: PreviewJobSpecInput, handler: PreviewJobHandler): () => void;
  };
  /** Operator-facing action-status reporter. Non-optional in the kernel
   *  contract (`pluginContext.ts` always wires `status`). Preview has no admin
   *  badge to render into, so `report`/`clear` record the call locally (for
   *  introspection + smoke) without surfacing a banner. Same crash class as
   *  `jobs` before this stub — `reading 'report'`. */
  readonly status: {
    report(status: PreviewStatusInput): void;
    clear(): void;
  };
  /** ServicesAccessor (solution B). When the runtime is wired with the live
   *  kernel ServiceRegistry (`PreviewRuntimeDeps.serviceRegistry`), `get`/`has`
   *  read through to it, so an integration-backed agent under test resolves
   *  the real services its `depends_on` integrations provide (e.g.
   *  `odoo.client`) and runs against the live integration. Without a wired
   *  registry, `get` returns `undefined` and `spec.external_reads`/service
   *  consumers hit their codegen-emitted `if (!svc) throw …` guard (the legacy
   *  stub fallback). Services the previewed agent itself `provide`s stay
   *  preview-local and never mutate the kernel registry. Background:
   *  `docs/harness-platform/HANDOFF-2026-05-04-preview-services-undefined.md`. */
  readonly services: {
    get<T>(name: string): T | undefined;
    has(name: string): boolean;
    provide<T>(name: string, impl: T): () => void;
    replace<T>(name: string, impl: T): () => void;
  };
  /** Per-plugin memory store, present exactly when the manifest declares
   *  `permissions.memory.{reads,writes}` with at least one entry — the same
   *  gate the kernel applies post-install (`pluginContext.ts:memoryDeclared`).
   *  Preview backs it with an ephemeral in-memory store (one per activation,
   *  dropped on close), so agents that persist project state via `ctx.memory`
   *  activate and run in preview instead of crashing on their own
   *  `if (!ctx.memory) throw …` null-guard. Absent when the manifest omits the
   *  block, so a permissions-stripped manifest fails preview the same way it
   *  would fail a real install — no false "works in preview" signal. */
  readonly memory?: PreviewMemoryAccessor;
  /** Outbound-allowlisted HTTP, present exactly when the manifest declares
   *  `permissions.network.outbound` with ≥1 host OR `network.web_scanner:
   *  true` — the same gate the kernel applies post-install
   *  (`pluginContext.ts:createPluginContext`). Backed by the SAME
   *  `createHttpAccessor` the kernel uses, so the egress allow-list, host
   *  matching and rate limit behave identically in preview. Absent when the
   *  manifest declares no outbound hosts and is not a web_scanner, so a
   *  self-contained agent that forgot to declare `api.github.com` fails
   *  preview the same way it would fail a real install — no false
   *  "works in preview" signal. */
  readonly http?: HttpAccessor;
  /** Host-LLM accessor, present exactly when the manifest declares
   *  `permissions.llm.models_allowed` with ≥1 entry AND the runtime is wired
   *  with a host `'llm'` provider (the same two-part gate the kernel applies
   *  post-install). Backed by the SAME host `'llm'` service the kernel serves
   *  `ctx.llm` from (Anthropic default), so an agent that calls
   *  `ctx.llm.complete(...)` is testable in preview with real completions —
   *  model-whitelist, per-invocation call-budget and max-tokens clamp behave
   *  like install. Absent when the manifest declares no `models_allowed` (or no
   *  host provider is wired, e.g. unit tests), so an agent that forgot to
   *  declare the permission fails preview the same way it would fail install —
   *  no false "works in preview" signal. */
  readonly llm?: PreviewLlmAccessor;
  /** Epic #459 W5 (issue #458) — deterministic ctx.mcp preview stub, always
   *  present so MCP-using plugins do not crash in the Builder preview (the
   *  ctx.jobs/ctx.status crash class). No external connections. */
  readonly mcp?: {
    listServers(): Promise<readonly string[]>;
    listTools(serverId: string): Promise<readonly never[]>;
    callTool(
      serverId: string,
      toolName: string,
      args: Record<string, unknown>,
    ): Promise<string>;
  };
  readonly smokeMode: boolean;
  log(...args: unknown[]): void;
}

/**
 * (prefix, router) pair captured at activate-time by the preview's
 * `routes.register`. The runtime-smoke pass mounts these on a temporary
 * Express server to probe GET handlers without going through the real
 * kernel route registry. `disposed` flips when the plugin's close()
 * calls the dispose handle.
 */
export interface PreviewRouteCapture {
  readonly prefix: string;
  readonly router: unknown;
  disposed: boolean;
}

/**
 * Job registration captured at activate-time by the preview's
 * `jobs.register`. The preview does NOT schedule the job (no cron fires in
 * an ephemeral preview); it records the spec + handler so the operator/smoke
 * can see what the agent would schedule post-install. `disposed` flips when
 * the plugin's close() calls the returned dispose handle.
 */
export interface PreviewJobCapture {
  readonly name: string;
  readonly schedule: PreviewJobSchedule;
  readonly spec: PreviewJobSpecInput;
  readonly handler: PreviewJobHandler;
  disposed: boolean;
}

export interface PreviewActivateOptions {
  zipBuffer: Buffer;
  draftId: string;
  rev: number;
  /** Non-secret config values (from the draft's setup-fields). */
  configValues: Readonly<Record<string, unknown>>;
  /** Secret values (in-memory only — never persisted). */
  secretValues: Readonly<Record<string, string>>;
  /** When `true`, `ctx.smokeMode` is set on the activated handle so
   *  plugins can branch to mock data. Defaults to `false`. */
  smokeMode?: boolean;
}

export interface PreviewHandle {
  readonly draftId: string;
  readonly agentId: string;
  readonly rev: number;
  readonly toolkit: PreviewToolkit;
  readonly previewDir: string;
  /** (prefix, router) pairs the plugin's `activate()` registered via
   *  `ctx.routes.register(...)`. Empty for plugins that contribute no
   *  HTTP routes. Read-only at the API surface — entries are appended
   *  during `activate()` and may be flagged `disposed` when the plugin's
   *  close-handle is invoked. */
  readonly routeCaptures: ReadonlyArray<PreviewRouteCapture>;
  /** Background jobs the plugin's `activate()` registered via
   *  `ctx.jobs.register(...)`. Captured but never scheduled in preview.
   *  Lets the operator/smoke confirm the agent wires its job the same way
   *  the kernel would post-install. Empty for plugins with no jobs. */
  readonly jobCaptures: ReadonlyArray<PreviewJobCapture>;
  /** Action-status values the plugin reported via `ctx.status.report(...)`
   *  during `activate()`, newest last. `ctx.status.clear()` appends a
   *  synthetic `{ state: 'ok' }` marker (the kernel treats `ok`/clear the
   *  same — both remove the badge). Empty when the plugin reports nothing. */
  readonly statusReports: ReadonlyArray<PreviewStatusInput>;
  close(): Promise<void>;
}

/**
 * Read-through host service surface. Structural subset of the kernel's
 * `ServiceRegistry` — only the lookups the preview needs. Kept structural so
 * previewRuntime stays decoupled from the platform ServiceRegistry type.
 */
export interface PreviewHostServices {
  get<T>(name: string): T | undefined;
  has(name: string): boolean;
}

export interface PreviewRuntimeDeps {
  /** Absolute path to `data/builder/.previews/`. */
  previewsRoot: string;
  /** Default: 10s — same budget as activate() in dynamicAgentRuntime. */
  activateTimeoutMs?: number;
  logger?: (...args: unknown[]) => void;
  /**
   * Live kernel ServiceRegistry. When set, the preview's `ctx.services.get/has`
   * read through to it, so an integration-backed agent under test resolves the
   * real services its `depends_on` integrations provide (e.g. `odoo.client`) —
   * the previewed agent runs against the live, already-configured integration
   * instead of hitting its own `if (!svc) throw` guard. Without it, lookups
   * return undefined (legacy stub behaviour). Services the previewed agent
   * itself `provide`s stay preview-local and never mutate the kernel registry.
   *
   * Note: the agent then makes REAL calls through those services during a
   * preview test (e.g. live Odoo reads with the installed integration's
   * credentials) — which is the point of "test the agent", and safe for the
   * read-only integrations this targets.
   */
  serviceRegistry?: PreviewHostServices;
  /** Absolute path to the shared build-template's `node_modules`. When set,
   *  the runtime symlinks it into the extracted package root before activate
   *  so dynamic-import calls resolve `zod` etc. The build-zip step ships the
   *  package without bundled deps — without this link `import('./toolkit.js')`
   *  fails with `Cannot find package 'zod'`. */
  templateNodeModulesPath?: string;
  /** Test override — extracts a zip buffer into the destination directory. */
  extractZip?: (zipBuffer: Buffer, destDir: string) => Promise<void>;
  /** Test override — replaces the dynamic-import + activate step. */
  activateModule?: (
    entryAbs: string,
    ctx: PreviewPluginContext,
  ) => Promise<PreviewAgentHandle>;
}

const DEFAULT_ACTIVATE_TIMEOUT_MS = 10_000;

export class PreviewRuntime {
  private readonly previewsRoot: string;
  private readonly activateTimeoutMs: number;
  private readonly log: (...args: unknown[]) => void;
  private readonly templateNodeModulesPath: string | undefined;
  private readonly hostServices: PreviewHostServices | undefined;
  private readonly extractZip: (zipBuffer: Buffer, destDir: string) => Promise<void>;
  private readonly activateModule: (
    entryAbs: string,
    ctx: PreviewPluginContext,
  ) => Promise<PreviewAgentHandle>;

  constructor(deps: PreviewRuntimeDeps) {
    this.previewsRoot = deps.previewsRoot;
    this.activateTimeoutMs = deps.activateTimeoutMs ?? DEFAULT_ACTIVATE_TIMEOUT_MS;
    this.log = deps.logger ?? ((...args) => console.log('[preview]', ...args));
    this.templateNodeModulesPath = deps.templateNodeModulesPath;
    this.hostServices = deps.serviceRegistry;
    this.extractZip = deps.extractZip ?? defaultExtractZip;
    this.activateModule = deps.activateModule ?? defaultActivateModule;
  }

  /**
   * Boot-time orphan cleanup: remove anything in `previewsRoot` left over
   * from a previous middleware run. Preview directories are ephemeral and
   * have no value once the process restarts.
   */
  async cleanupOrphans(): Promise<{ removed: number }> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.previewsRoot);
    } catch {
      // Root doesn't exist yet — nothing to clean.
      return { removed: 0 };
    }
    let removed = 0;
    await Promise.all(
      entries.map(async (name) => {
        try {
          await fs.rm(path.join(this.previewsRoot, name), {
            recursive: true,
            force: true,
          });
          removed += 1;
        } catch (err) {
          this.log(`orphan cleanup failed for ${name}: ${(err as Error).message}`);
        }
      }),
    );
    return { removed };
  }

  /**
   * Extract the given ZIP and call its `activate()` with a stub PluginContext.
   * Returns a handle whose `close()` tears down both the agent and the
   * on-disk preview directory.
   */
  async activate(opts: PreviewActivateOptions): Promise<PreviewHandle> {
    const previewDir = path.join(
      this.previewsRoot,
      `${opts.draftId}-${opts.rev}`,
    );
    // Wipe any stale dir from a prior rev with the same number (e.g. after
    // a restart that survived only the in-memory cache eviction).
    await fs.rm(previewDir, { recursive: true, force: true });
    await fs.mkdir(this.previewsRoot, { recursive: true });

    await this.extractZip(opts.zipBuffer, previewDir);

    // Resolve the actual package root. The boilerplate's build-zip.mjs
    // wraps the package in `<id>-<version>-package/` (npm-pack style)
    // because the install-flow expects that layout. Preview is happy
    // with either flat OR wrapped — detect once here and operate on
    // the resolved root from this point onwards.
    const packageRoot = await resolvePackageRoot(previewDir);
    if (!packageRoot) {
      await fs.rm(previewDir, { recursive: true, force: true });
      throw new Error(
        `preview: no package.json found in extracted zip (looked at ${previewDir} and up to two nested levels)`,
      );
    }

    const pkgPath = path.join(packageRoot, 'package.json');
    let pkg: { name?: string; main?: string };
    try {
      pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8')) as typeof pkg;
    } catch (err) {
      await fs.rm(previewDir, { recursive: true, force: true });
      throw new Error(
        `preview: failed to read package.json from extracted zip: ${(err as Error).message}`,
        { cause: err },
      );
    }
    const agentId = pkg.name;
    if (!agentId) {
      await fs.rm(previewDir, { recursive: true, force: true });
      throw new Error('preview: package.json has no `name` field');
    }
    const entryRel = pkg.main ?? 'dist/index.js';
    const entryAbs = path.resolve(packageRoot, entryRel);
    if (!entryAbs.startsWith(packageRoot + path.sep)) {
      await fs.rm(previewDir, { recursive: true, force: true });
      throw new Error(
        `preview: entry path escapes preview root (${entryRel})`,
      );
    }

    if (this.templateNodeModulesPath) {
      const linkPath = path.join(packageRoot, 'node_modules');
      try {
        await fs.rm(linkPath, { recursive: true, force: true });
        await fs.symlink(this.templateNodeModulesPath, linkPath, 'dir');
      } catch (err) {
        await fs.rm(previewDir, { recursive: true, force: true });
        throw new Error(
          `preview: failed to symlink build-template node_modules into ${linkPath}: ${(err as Error).message}`,
          { cause: err },
        );
      }
    }

    // Memory accessor is gated on the manifest declaring memory permissions —
    // exactly like the kernel's `memoryDeclared` check post-install. Reading
    // the manifest here (we already have packageRoot) keeps preview faithful:
    // a correct manifest gets a working ephemeral store, a stripped one gets
    // `ctx.memory === undefined` and fails the same way install would.
    const provideMemory = await manifestDeclaresMemory(packageRoot);

    // ctx.http is gated on the manifest's outbound allow-list exactly like the
    // kernel's createPluginContext — a self-contained agent that declares
    // `permissions.network.outbound` (or `web_scanner`) gets a working,
    // allow-list-enforced fetch in preview; one that declares neither gets
    // `ctx.http === undefined` and fails preview the same way it would fail a
    // real install. Built with the SAME createHttpAccessor the kernel uses so
    // host-matching, the rate limit and the audit modes behave identically.
    const network = await manifestNetworkConfig(packageRoot);
    const auditMode = opts.configValues['audit_mode'];
    const http: HttpAccessor | undefined =
      network.outbound.length > 0 || network.webScanner
        ? createHttpAccessor({
            agentId,
            outbound: network.outbound,
            webScanner: network.webScanner,
            ...(network.webScanner && isAuditMode(auditMode)
              ? { auditMode }
              : {}),
          })
        : undefined;

    // ctx.llm is gated on the manifest's `permissions.llm.models_allowed`
    // exactly like the kernel's `extractLlmPermissions`, AND on a wired host
    // `'llm'` provider (the second half of the kernel's two-part gate). When
    // both hold, the preview serves REAL completions through the same host
    // service the kernel uses post-install (Anthropic default), so an agent
    // that calls `ctx.llm.complete(...)` is testable in the builder instead of
    // crashing with "ctx.llm unavailable". When the manifest omits the
    // permission (or no host provider is wired, e.g. unit tests), `ctx.llm`
    // stays absent — same failure mode as a real install.
    const llmConfig = await manifestLlmConfig(packageRoot);
    const hostLlm =
      llmConfig && this.hostServices
        ? this.hostServices.get<PreviewHostLlmProvider>('llm')
        : undefined;
    const llm: PreviewLlmAccessor | undefined =
      llmConfig && hostLlm
        ? createPreviewLlmAccessor({
            agentId,
            config: llmConfig,
            provider: hostLlm,
            log: (...args) => this.log(`[${agentId}/llm]`, ...args),
          })
        : undefined;

    const routeCaptures: PreviewRouteCapture[] = [];
    const jobCaptures: PreviewJobCapture[] = [];
    const statusReports: PreviewStatusInput[] = [];
    const ctx = createStubContext({
      agentId,
      configValues: opts.configValues,
      secretValues: opts.secretValues,
      smokeMode: opts.smokeMode === true,
      routeCaptures,
      jobCaptures,
      statusReports,
      hostServices: this.hostServices,
      provideMemory,
      ...(http ? { http } : {}),
      ...(llm ? { llm } : {}),
      logger: (...args) => this.log(`[${agentId}]`, ...args),
    });

    let handle: PreviewAgentHandle;
    try {
      handle = await withTimeout(
        this.activateModule(entryAbs, ctx),
        this.activateTimeoutMs,
        `preview activate(${agentId}) timed out`,
      );
    } catch (err) {
      await fs.rm(previewDir, { recursive: true, force: true });
      throw err;
    }

    return {
      draftId: opts.draftId,
      agentId,
      rev: opts.rev,
      toolkit: handle.toolkit,
      previewDir,
      routeCaptures,
      jobCaptures,
      statusReports,
      close: async () => {
        try {
          await withTimeout(
            handle.close(),
            5_000,
            `preview close(${agentId}) timed out`,
          );
        } catch (err) {
          this.log(`close failed for ${agentId}: ${(err as Error).message}`);
        }
        await fs.rm(previewDir, { recursive: true, force: true });
      },
    };
  }
}

/**
 * Reads the package's `manifest.yaml` and reports whether it declares memory
 * permissions (`permissions.memory.reads` OR `.writes` with ≥1 entry). This is
 * a 1:1 mirror of `pluginContext.ts:memoryDeclared`, the gate the kernel uses
 * to decide whether to hand a plugin `ctx.memory` after install. A missing or
 * unparsable manifest reports `false` (no memory) rather than throwing — the
 * preview test harness writes packages without a manifest, and a real build
 * always ships one.
 */
async function manifestDeclaresMemory(packageRoot: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(packageRoot, 'manifest.yaml'), 'utf-8');
  } catch {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = yaml.parse(raw);
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null) return false;
  const permissions = (parsed as Record<string, unknown>)['permissions'];
  if (typeof permissions !== 'object' || permissions === null) return false;
  const mem = (permissions as Record<string, unknown>)['memory'];
  if (typeof mem !== 'object' || mem === null) return false;
  const reads = (mem as Record<string, unknown>)['reads'];
  const writes = (mem as Record<string, unknown>)['writes'];
  const readsLen = Array.isArray(reads) ? reads.length : 0;
  const writesLen = Array.isArray(writes) ? writes.length : 0;
  return readsLen > 0 || writesLen > 0;
}

/**
 * Reads the package's `manifest.yaml` and extracts the egress configuration
 * the kernel uses to gate `ctx.http`: the `permissions.network.outbound[]`
 * host allow-list and the `permissions.network.web_scanner` flag. Mirrors
 * `pluginContext.ts:extractOutboundAllowlist` (which reads the same manifest
 * shape post-install) so preview and production agree on when `ctx.http` is
 * present. A missing or unparsable manifest reports no egress (`outbound: []`,
 * `webScanner: false`) rather than throwing — the same lenient stance as
 * `manifestDeclaresMemory`.
 */
async function manifestNetworkConfig(
  packageRoot: string,
): Promise<{ outbound: string[]; webScanner: boolean }> {
  const empty = { outbound: [] as string[], webScanner: false };
  let raw: string;
  try {
    raw = await fs.readFile(path.join(packageRoot, 'manifest.yaml'), 'utf-8');
  } catch {
    return empty;
  }
  let parsed: unknown;
  try {
    parsed = yaml.parse(raw);
  } catch {
    return empty;
  }
  if (typeof parsed !== 'object' || parsed === null) return empty;
  const permissions = (parsed as Record<string, unknown>)['permissions'];
  if (typeof permissions !== 'object' || permissions === null) return empty;
  const network = (permissions as Record<string, unknown>)['network'];
  if (typeof network !== 'object' || network === null) return empty;
  const rawOutbound = (network as Record<string, unknown>)['outbound'];
  const outbound = Array.isArray(rawOutbound)
    ? rawOutbound.filter((h): h is string => typeof h === 'string')
    : [];
  const webScanner =
    (network as Record<string, unknown>)['web_scanner'] === true;
  return { outbound, webScanner };
}

/**
 * Reads the package's `manifest.yaml` and extracts the LLM permission the
 * kernel uses to gate `ctx.llm`: the `permissions.llm.models_allowed` whitelist
 * plus the optional per-invocation call budget and max-tokens cap. Mirrors
 * `pluginContext.ts:extractLlmPermissions` so preview and production agree on
 * when `ctx.llm` is present. Returns `undefined` when the manifest is missing,
 * unparsable, declares no `permissions.llm`, or lists an empty `models_allowed`
 * — the same "no LLM access" outcome the kernel produces. Defaults
 * (`calls_per_invocation: 5`, `max_tokens_per_call: 4096`) match the kernel.
 */
async function manifestLlmConfig(
  packageRoot: string,
): Promise<PreviewLlmConfig | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(packageRoot, 'manifest.yaml'), 'utf-8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = yaml.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const permissions = (parsed as Record<string, unknown>)['permissions'];
  if (typeof permissions !== 'object' || permissions === null) return undefined;
  const llm = (permissions as Record<string, unknown>)['llm'];
  if (typeof llm !== 'object' || llm === null) return undefined;
  const rawModels = (llm as Record<string, unknown>)['models_allowed'];
  const modelsAllowed = Array.isArray(rawModels)
    ? rawModels.filter((m): m is string => typeof m === 'string' && m.length > 0)
    : [];
  if (modelsAllowed.length === 0) return undefined;
  const callsRaw = (llm as Record<string, unknown>)['calls_per_invocation'];
  const tokensRaw = (llm as Record<string, unknown>)['max_tokens_per_call'];
  return {
    modelsAllowed,
    callsPerInvocation:
      typeof callsRaw === 'number' && callsRaw > 0 ? callsRaw : 5,
    maxTokensPerCall:
      typeof tokensRaw === 'number' && tokensRaw > 0 ? tokensRaw : 4096,
  };
}

/**
 * Builds the preview `ctx.llm` accessor. Delegates real completions to the
 * wired host `'llm'` provider (the same service the kernel serves `ctx.llm`
 * from — Anthropic default), while replicating the three guardrails the kernel
 * applies in `createLlmAccessor`:
 *
 *   - **call budget** — at most `callsPerInvocation` completions per preview
 *     activation (the preview handle is one "invocation");
 *   - **model whitelist** — the requested model must match an entry in
 *     `models_allowed`. Concrete ids match exactly; `*` and `class:*` refs are
 *     allowed through (the host default provider resolves class refs the same
 *     way the kernel does), matching the kernel's intent without re-importing
 *     its provider-coupling logic;
 *   - **max-tokens clamp** — silently clamped to `maxTokensPerCall`.
 *
 * Preview does NOT thread non-Anthropic provider pins or the vault; it always
 * serves on the host default `'llm'` provider, which is the common case and
 * keeps the preview decoupled from the kernel's ServiceRegistry/vault types.
 */
function createPreviewLlmAccessor(opts: {
  agentId: string;
  config: PreviewLlmConfig;
  provider: PreviewHostLlmProvider;
  log: (...args: unknown[]) => void;
}): PreviewLlmAccessor {
  const { agentId, config, provider, log } = opts;
  let callsUsed = 0;
  return {
    modelsAllowed: config.modelsAllowed,
    async complete(
      req: PreviewLlmCompleteRequest,
    ): Promise<PreviewLlmCompleteResult> {
      if (callsUsed >= config.callsPerInvocation) {
        throw new Error(
          `preview: agent '${agentId}' exceeded its LLM call budget ` +
            `(${String(config.callsPerInvocation)} per invocation).`,
        );
      }
      const allowed = config.modelsAllowed.some(
        (m) => m === req.model || m === '*' || m.startsWith('class:'),
      );
      if (!allowed) {
        throw new Error(
          `preview: model '${req.model}' is not in agent '${agentId}' ` +
            `permissions.llm.models_allowed (${config.modelsAllowed.join(', ')}).`,
        );
      }
      const requested = req.maxTokens ?? config.maxTokensPerCall;
      const effective = Math.min(requested, config.maxTokensPerCall);
      if (effective < requested) {
        log(`clamped maxTokens ${String(requested)} → ${String(effective)} (manifest cap)`);
      }
      callsUsed += 1;
      return provider.complete({ ...req, maxTokens: effective });
    },
  };
}

function createStubContext(opts: {
  agentId: string;
  configValues: Readonly<Record<string, unknown>>;
  secretValues: Readonly<Record<string, string>>;
  smokeMode: boolean;
  routeCaptures: PreviewRouteCapture[];
  jobCaptures: PreviewJobCapture[];
  statusReports: PreviewStatusInput[];
  hostServices?: PreviewHostServices;
  provideMemory: boolean;
  http?: HttpAccessor;
  llm?: PreviewLlmAccessor;
  logger: (...args: unknown[]) => void;
}): PreviewPluginContext {
  // Services the previewed agent provides itself stay isolated to this
  // preview activation — they never leak into the live kernel ServiceRegistry.
  // Lookups check this local layer first, then read through to the host
  // registry (when wired) so cross-plugin services from `depends_on`
  // integrations resolve.
  const localServices = new Map<string, unknown>();
  const host = opts.hostServices;
  const memory: PreviewMemoryAccessor | undefined = opts.provideMemory
    ? createPreviewMemoryAccessor()
    : undefined;
  return {
    agentId: opts.agentId,
    secrets: {
      get: async (key) => opts.secretValues[key],
      require: async (key) => {
        const v = opts.secretValues[key];
        if (v === undefined) {
          throw new Error(
            `preview: secret '${key}' is not set for agent '${opts.agentId}'. Fill in the workspace setup-fields before testing.`,
          );
        }
        return v;
      },
      keys: async () => Object.keys(opts.secretValues),
    },
    config: {
      get: <T,>(key: string): T | undefined => opts.configValues[key] as T | undefined,
      require: <T,>(key: string): T => {
        const v = opts.configValues[key];
        if (v === undefined) {
          throw new Error(
            `preview: config '${key}' is not set for agent '${opts.agentId}'. Fill in the workspace setup-fields before testing.`,
          );
        }
        return v as T;
      },
    },
    routes: {
      // Capture the (prefix, router) pair so the runtime-smoke pass
      // (Theme D) can introspect and probe GET handlers without going
      // through the real kernel route registry. Routes still don't
      // serve traffic from the preview iframe — admin-UI URLs only
      // become reachable after a real Install.
      register: (prefix, router) => {
        const entry: PreviewRouteCapture = {
          prefix,
          router,
          disposed: false,
        };
        opts.routeCaptures.push(entry);
        return () => {
          entry.disposed = true;
        };
      },
    },
    // B.12 — no-op uiRoutes stub. Codegen-emitted plugin.ts calls
    // `ctx.uiRoutes.register({routeId, path, title})` to publish
    // Dashboard-Tab descriptors to channel-teams' Hub. Preview doesn't
    // serve the Hub, so we accept the call and return a disposer that
    // does nothing — same shape as the routes accessor. The kernel-side
    // catalogue gets populated only after a real Install.
    uiRoutes: {
      register: (_descriptor) => () => {},
    },
    // Jobs accessor — non-optional in the kernel contract, so a plugin with a
    // scheduled job calls `ctx.jobs.register(...)` unconditionally in
    // activate(). Before this stub the call threw `Cannot read properties of
    // undefined (reading 'register')` ONLY in preview (the plugin compiled and
    // ran fine after install — the kernel always wires `jobs`). We CAPTURE the
    // registration so the operator/smoke can see what the agent would schedule,
    // and return a real disposer matching the kernel shape — but we never fire
    // the cron/interval: preview activations are ephemeral and must not trigger
    // real side effects. Same intent as the routes/uiRoutes stubs.
    jobs: {
      register: (spec, handler) => {
        const entry: PreviewJobCapture = {
          name: spec.name,
          schedule: spec.schedule,
          spec,
          handler,
          disposed: false,
        };
        opts.jobCaptures.push(entry);
        return () => {
          entry.disposed = true;
        };
      },
    },
    // Status accessor — also non-optional in the kernel contract. Preview has
    // no admin badge to render into, so we just record the reported values
    // (newest last) for introspection. `clear()` records a synthetic `ok`
    // marker since the kernel treats `ok` and clear identically (both drop the
    // badge). Same crash class as `jobs` before this stub (`reading 'report'`).
    status: {
      report: (next) => {
        const state =
          next.state === 'ok' ||
          next.state === 'needs_action' ||
          next.state === 'error'
            ? next.state
            : 'needs_action';
        opts.statusReports.push({
          state,
          ...(typeof next.title === 'string' ? { title: next.title } : {}),
          ...(typeof next.detail === 'string' ? { detail: next.detail } : {}),
        });
      },
      clear: () => {
        opts.statusReports.push({ state: 'ok' });
      },
    },
    // ServicesAccessor (solution B): read through to the live kernel
    // ServiceRegistry when one is wired, so an integration-backed agent under
    // test resolves the real services its `depends_on` integrations provide
    // (e.g. `odoo.client`). When no host registry is wired (legacy / unit
    // tests), `get` returns undefined and the agent hits its own
    // `if (!svc) throw` guard — the previous stub behaviour. Provides made by
    // the previewed agent stay in `localServices` and are checked first, so
    // they neither leak into the kernel registry nor get shadowed by it.
    services: {
      get: <T,>(name: string): T | undefined => {
        if (localServices.has(name)) return localServices.get(name) as T;
        return host ? host.get<T>(name) : undefined;
      },
      has: (name: string): boolean =>
        localServices.has(name) || (host ? host.has(name) : false),
      provide: <T,>(name: string, impl: T): (() => void) => {
        localServices.set(name, impl);
        return () => {
          localServices.delete(name);
        };
      },
      replace: <T,>(name: string, impl: T): (() => void) => {
        localServices.set(name, impl);
        return () => {
          localServices.delete(name);
        };
      },
    },
    // Ephemeral per-activation memory accessor, gated on the manifest's
    // memory permissions (see `manifestDeclaresMemory`). Spread so the field
    // is simply absent — not `memory: undefined` — when the manifest omits
    // the block, matching the kernel's optional `ctx.memory`.
    ...(memory ? { memory } : {}),
    // Outbound-allowlisted HTTP — present iff the manifest gated it on (see
    // activate()). Spread so the field is simply absent — not
    // `http: undefined` — when the manifest declares no egress, matching the
    // kernel's optional `ctx.http`.
    ...(opts.http ? { http: opts.http } : {}),
    ...(opts.llm ? { llm: opts.llm } : {}),
    // Epic #459 W5 (issue #458) — ctx.mcp preview stub. Always present in
    // preview (unlike the kernel, which gates on permissions.mcp): the same
    // crash class that once hit ctx.jobs/ctx.status (documented above) would
    // otherwise return for MCP-using plugins. Deterministic no-op behavior —
    // no external connections from the Builder preview sandbox.
    mcp: {
      listServers: async (): Promise<readonly string[]> => [],
      listTools: async (): Promise<readonly never[]> => [],
      callTool: async (_serverId: string, toolName: string): Promise<string> =>
        `Error: MCP tool "${toolName}" is not available in the Builder preview. Install the plugin and grant it a server to test real calls.`,
    },
    smokeMode: opts.smokeMode,
    log: opts.logger,
  };
}

/**
 * Walks the extracted preview directory to locate the directory that
 * holds `package.json`. Producers should write a single-level wrapper
 * (`<safe-name>-<version>-package/`, npm-pack style), but a stray
 * unsanitized scoped name in an older builder leaves a two-level layout
 * (`@scope/<wrapper>/package.json`). We probe up to two levels so a
 * partially-fixed producer still surfaces here.
 *
 * Returns the resolved package root, or null when no package.json is
 * found within the depth budget.
 */
async function resolvePackageRoot(previewDir: string): Promise<string | null> {
  if (await hasPackageJson(previewDir)) return previewDir;
  const level1 = await readSubdirs(previewDir);
  for (const l1 of level1) {
    const candidate = path.join(previewDir, l1.name);
    if (await hasPackageJson(candidate)) return candidate;
    const level2 = await readSubdirs(candidate);
    for (const l2 of level2) {
      const nested = path.join(candidate, l2.name);
      if (await hasPackageJson(nested)) return nested;
    }
  }
  return null;
}

async function hasPackageJson(dir: string): Promise<boolean> {
  try {
    await fs.access(path.join(dir, 'package.json'));
    return true;
  } catch {
    return false;
  }
}

async function readSubdirs(dir: string): Promise<Dirent[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory());
  } catch {
    return [];
  }
}

async function defaultExtractZip(zipBuffer: Buffer, destDir: string): Promise<void> {
  // The ZipExtractor reads from disk, so we stage the buffer to a temp file
  // alongside the destination and clean up afterwards.
  const stagingPath = `${destDir}.zip`;
  await fs.mkdir(path.dirname(destDir), { recursive: true });
  await fs.writeFile(stagingPath, zipBuffer);
  try {
    await extractZipToDir(stagingPath, destDir, PREVIEW_LIMITS);
  } finally {
    await fs.rm(stagingPath, { force: true });
  }
}

async function defaultActivateModule(
  entryAbs: string,
  ctx: PreviewPluginContext,
): Promise<PreviewAgentHandle> {
  await fs.access(entryAbs);
  const mod = (await import(pathToFileURL(entryAbs).href)) as PreviewModuleShape;
  const activateFn = mod.activate ?? mod.default?.activate;
  if (typeof activateFn !== 'function') {
    throw new Error(
      `preview: ${entryAbs} exports neither activate() nor default.activate()`,
    );
  }
  return activateFn(ctx);
}

async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  msg: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(msg)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
