import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'yaml';
import type { z } from 'zod';

import { extractZipToDir, type ExtractLimits } from '../zipExtractor.js';
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

    const routeCaptures: PreviewRouteCapture[] = [];
    const ctx = createStubContext({
      agentId,
      configValues: opts.configValues,
      secretValues: opts.secretValues,
      smokeMode: opts.smokeMode === true,
      routeCaptures,
      hostServices: this.hostServices,
      provideMemory,
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

function createStubContext(opts: {
  agentId: string;
  configValues: Readonly<Record<string, unknown>>;
  secretValues: Readonly<Record<string, string>>;
  smokeMode: boolean;
  routeCaptures: PreviewRouteCapture[];
  hostServices?: PreviewHostServices;
  provideMemory: boolean;
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
