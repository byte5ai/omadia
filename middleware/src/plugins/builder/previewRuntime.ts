import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { z } from 'zod';

import { extractZipToDir, type ExtractLimits } from '../zipExtractor.js';

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
  /** Theme A: stub-only ServicesAccessor. Preview wires no real
   *  ServiceRegistry, so every lookup returns `undefined`. Agents using
   *  `spec.external_reads` will hit their codegen-emitted
   *  `if (!svc) throw …` guard, which is the correct failure mode for
   *  preview — real services land at install-time when the host kernel
   *  wires up `dynamicAgentRuntime`'s ServiceRegistry. Solving B (real
   *  preview registry) is its own theme; see
   *  `docs/harness-platform/HANDOFF-2026-05-04-preview-services-undefined.md`. */
  readonly services: {
    get<T>(name: string): T | undefined;
    has(name: string): boolean;
    provide<T>(name: string, impl: T): () => void;
    replace<T>(name: string, impl: T): () => void;
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

export interface PreviewRuntimeDeps {
  /** Absolute path to `data/builder/.previews/`. */
  previewsRoot: string;
  /** Default: 10s — same budget as activate() in dynamicAgentRuntime. */
  activateTimeoutMs?: number;
  logger?: (...args: unknown[]) => void;
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
        `preview: no package.json found in extracted zip (looked at ${previewDir} and one nested level)`,
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
        );
      }
    }

    const routeCaptures: PreviewRouteCapture[] = [];
    const ctx = createStubContext({
      agentId,
      configValues: opts.configValues,
      secretValues: opts.secretValues,
      smokeMode: opts.smokeMode === true,
      routeCaptures,
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

function createStubContext(opts: {
  agentId: string;
  configValues: Readonly<Record<string, unknown>>;
  secretValues: Readonly<Record<string, string>>;
  smokeMode: boolean;
  routeCaptures: PreviewRouteCapture[];
  logger: (...args: unknown[]) => void;
}): PreviewPluginContext {
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
    // Theme A: no-op ServicesAccessor stub. Preview never wires a real
    // ServiceRegistry, so external_reads-driven `ctx.services.get(...)`
    // calls return undefined, the codegen-emitted null-guard throws
    // a descriptive `service '<name>' is not registered` error, and the
    // operator sees a real failure message instead of a TypeError. See
    // `HANDOFF-2026-05-04-preview-services-undefined.md` (solution A).
    services: {
      get: <T,>(_name: string): T | undefined => undefined,
      has: (_name: string): boolean => false,
      provide: <T,>(_name: string, _impl: T): (() => void) => () => {},
      replace: <T,>(_name: string, _impl: T): (() => void) => () => {},
    },
    smokeMode: opts.smokeMode,
    log: opts.logger,
  };
}

/**
 * Walks one directory level deep to locate the directory that holds
 * `package.json`. The boilerplate's build-zip.mjs wraps the package in
 * `<id>-<version>-package/` so the extracted layout is one level deeper
 * than the preview dir; an old-style flat zip lives directly at the root.
 *
 * Returns the resolved package root (== previewDir for flat zips), or
 * null when no package.json is found in either layout.
 */
async function resolvePackageRoot(previewDir: string): Promise<string | null> {
  try {
    await fs.access(path.join(previewDir, 'package.json'));
    return previewDir;
  } catch {
    /* fall through to wrapper-detection */
  }
  let entries: Dirent[];
  try {
    entries = await fs.readdir(previewDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(previewDir, entry.name);
    try {
      await fs.access(path.join(candidate, 'package.json'));
      return candidate;
    } catch {
      /* keep scanning */
    }
  }
  return null;
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
