import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  MIGRATION_TIMEOUT_MS_DEFAULT,
  MigrationHookError,
  MigrationTimeoutError,
  type MigrationContext,
  type MigrationResult,
} from '@omadia/plugin-api';

import type { PluginCatalog, PluginCatalogEntry } from './manifestLoader.js';
import { createMigrationContext } from '../platform/pluginContext.js';
import type { PluginRouteRegistry } from '../platform/pluginRouteRegistry.js';
import type { ServiceRegistry } from '../platform/serviceRegistry.js';
import type { SecretVault } from '../secrets/vault.js';
import type { NativeToolRegistry } from '@omadia/orchestrator';
import type { InstalledRegistry } from './installedRegistry.js';
import type { JobScheduler } from './jobScheduler.js';

/**
 * Runs a plugin's `onMigrate` hook during zip-upload of a new version.
 *
 * Opt-in: if the v2 module does not export `onMigrate`, the runner carries
 * `previousConfig` over 1:1 and returns it as `newConfig`. This covers the
 * common 80% case (bug-fix release without config-shape change).
 *
 * Failure model:
 *   - Sync throw from the hook       → MigrationHookError (wraps cause)
 *   - Rejected promise               → MigrationHookError
 *   - Promise never resolves in time → MigrationTimeoutError
 *   - Any other dynamic-import fail  → bubbles up as-is
 *
 * Writes to `ctx.secrets` / `ctx.memory` inside the hook go through the
 * regular vault + memory store and are NOT rolled back if the hook later
 * throws. Plugin authors must keep their migrations idempotent.
 */

export interface RunMigrationParams {
  agentId: string;
  fromVersion: string;
  toVersion: string;
  /** Snapshot of the v1 config, read from the InstalledRegistry just before
   *  the hook is invoked. */
  previousConfig: Record<string, unknown>;
  /** Absolute path to the staged v2 package root (where `manifest.yaml` and
   *  `dist/plugin.js` live). The hook is dynamic-imported from here. */
  stagingPackageRoot: string;
  /** Entry path relative to the package root, usually `dist/plugin.js`. */
  entryPath: string;
  /** Catalog entry for the v2 plugin (parsed from the staged manifest).
   *  Used to read `lifecycle.onMigrate.timeout_ms`. */
  catalogEntry: PluginCatalogEntry;
}

export interface MigrationRunnerDeps {
  vault: SecretVault;
  registry: InstalledRegistry;
  catalog: PluginCatalog;
  serviceRegistry: ServiceRegistry;
  nativeToolRegistry: NativeToolRegistry;
  pluginRouteRegistry: PluginRouteRegistry;
  jobScheduler: JobScheduler;
  log?: (msg: string) => void;
}

interface StagedModuleShape {
  onMigrate?: (ctx: MigrationContext) => Promise<MigrationResult>;
  default?: {
    onMigrate?: (ctx: MigrationContext) => Promise<MigrationResult>;
  };
}

export class MigrationRunner {
  constructor(private readonly deps: MigrationRunnerDeps) {}

  async run(params: RunMigrationParams): Promise<MigrationResult> {
    const log = this.deps.log ?? ((m) => console.log(m));

    const entryAbs = path.resolve(params.stagingPackageRoot, params.entryPath);
    if (!entryAbs.startsWith(params.stagingPackageRoot + path.sep)) {
      throw new MigrationHookError(
        params.agentId,
        params.fromVersion,
        params.toVersion,
        `entry path escapes staging root (${params.entryPath})`,
      );
    }

    // Dynamic-import from the staged v2 path. The v1 package (different file
    // path) stays untouched in Node's module cache; this import is a fresh
    // load. Cache-busting via `?t=<ts>` is unnecessary — the path itself
    // differs because staging dirs carry a timestamp suffix.
    const mod = (await import(pathToFileURL(entryAbs).href)) as StagedModuleShape;
    const hook = mod.onMigrate ?? mod.default?.onMigrate;

    if (typeof hook !== 'function') {
      // Opt-in carry-over. Log so operators see the implicit path taken.
      log(
        `[migration] ${params.agentId} v${params.fromVersion} → v${params.toVersion}: no onMigrate hook, carrying config over 1:1`,
      );
      return { newConfig: params.previousConfig };
    }

    const ctx = createMigrationContext({
      agentId: params.agentId,
      vault: this.deps.vault,
      registry: this.deps.registry,
      catalog: this.deps.catalog,
      serviceRegistry: this.deps.serviceRegistry,
      nativeToolRegistry: this.deps.nativeToolRegistry,
      routeRegistry: this.deps.pluginRouteRegistry,
      jobScheduler: this.deps.jobScheduler,
      fromVersion: params.fromVersion,
      toVersion: params.toVersion,
      previousConfig: params.previousConfig,
      logger: (...args) => console.log(`[${params.agentId}/migrate]`, ...args),
    });

    const timeoutMs = extractTimeoutMs(params.catalogEntry);

    let result: MigrationResult;
    try {
      result = await withTimeout(
        hook(ctx),
        timeoutMs,
        new MigrationTimeoutError(
          params.agentId,
          params.fromVersion,
          params.toVersion,
          timeoutMs,
        ),
      );
    } catch (err) {
      if (err instanceof MigrationTimeoutError) throw err;
      throw new MigrationHookError(
        params.agentId,
        params.fromVersion,
        params.toVersion,
        err,
      );
    }

    if (!result || typeof result !== 'object' || !isRecord(result.newConfig)) {
      throw new MigrationHookError(
        params.agentId,
        params.fromVersion,
        params.toVersion,
        'onMigrate must return { newConfig: Record<string, unknown> }',
      );
    }

    log(
      `[migration] ${params.agentId} v${params.fromVersion} → v${params.toVersion}: hook OK`,
    );
    return result;
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function extractTimeoutMs(entry: PluginCatalogEntry): number {
  const manifest = entry.manifest as Record<string, unknown> | undefined;
  const lifecycle = manifest?.['lifecycle'] as Record<string, unknown> | undefined;
  const onMigrate = lifecycle?.['onMigrate'] as Record<string, unknown> | undefined;
  const raw = onMigrate?.['timeout_ms'];
  if (typeof raw === 'number' && raw > 0 && Number.isFinite(raw)) {
    return Math.floor(raw);
  }
  return MIGRATION_TIMEOUT_MS_DEFAULT;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  timeoutError: Error,
): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => reject(timeoutError), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
