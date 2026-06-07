import {
  MemorySeeder,
  MemoryToolHandler,
  createDevMemoryRouter,
  type MemorySeedMode,
} from '@omadia/memory';
import type { PluginContext } from '@omadia/plugin-api';
import type { Pool } from 'pg';

import { runMemoryMigrations } from './migrator.js';
import { PostgresMemoryStore } from './postgresMemoryStore.js';

/**
 * @omadia/memory-postgres — plugin entry point for the Postgres-backed memory
 * infrastructure. A drop-in alternative to @omadia/memory: it provides the
 * same `memoryStore` service + Anthropic-native `memory` tool handler + startup
 * seeder, but persists `/memories` into a Postgres `memory_files` table instead
 * of the local filesystem.
 *
 * Pool reuse: this plugin does NOT open its own Pool. It consumes the shared
 * `graphPool` service published by @omadia/knowledge-graph-neon (declared via
 * `requires: ["graphPool@^1"]`). If the pool is absent, activate() logs and
 * returns a no-op handle so the plugin stays installable.
 *
 * Optional config (mirrors @omadia/memory):
 *   - seed_dir   default `memory-seed` relative to cwd
 *   - seed_mode  'missing' | 'overwrite' | 'skip' (default 'missing')
 */

const GRAPH_POOL_SERVICE = 'graphPool';
const MEMORY_STORE_SERVICE = 'memoryStore';
const DEV_MEMORY_PREFIX = '/api/dev/memory';

export interface MemoryPostgresPluginHandle {
  close(): Promise<void>;
}

export async function activate(
  ctx: PluginContext,
): Promise<MemoryPostgresPluginHandle> {
  ctx.log('activating memory-postgres plugin');

  const pool = ctx.services.get<Pool>(GRAPH_POOL_SERVICE);
  if (!pool) {
    ctx.log(
      '[memory-postgres] no graphPool service — capabilities NOT published; install @omadia/knowledge-graph-neon (set database_url) or use @omadia/memory',
    );
    return {
      async close(): Promise<void> {
        // no-op: nothing constructed
      },
    };
  }

  await runMemoryMigrations(pool, (msg) => ctx.log(msg));

  const seedDir = ctx.config.get<string>('seed_dir') ?? 'memory-seed';
  const seedMode = normaliseSeedMode(ctx.config.get<string>('seed_mode'));

  const store = new PostgresMemoryStore(pool);

  const disposeService = ctx.services.provide(MEMORY_STORE_SERVICE, store);

  const seedResult = await new MemorySeeder({
    seedDir,
    store,
    mode: seedMode,
  }).run();
  const summary = seedResult.files.reduce<Record<string, number>>(
    (acc, entry) => {
      acc[entry.action] = (acc[entry.action] ?? 0) + 1;
      return acc;
    },
    {},
  );
  ctx.log(
    `[memory-postgres] seeder (${seedResult.mode}) → ${JSON.stringify(summary)} entries: ${seedResult.files.length}`,
  );

  const toolHandler = new MemoryToolHandler(store);
  const disposeTool = ctx.tools.registerHandler('memory', (input) =>
    toolHandler.handle(input),
  );

  // Read-only dev memory browser (`/api/dev/memory`), gated by
  // `dev_memory_endpoints_enabled`. Mounted HERE too (not only in
  // @omadia/memory) so the operator memory view works when Postgres is the
  // active backend — otherwise the router lives in the inactive in-memory
  // provider and the browser 404s even with DEV_ENDPOINTS_ENABLED set. The
  // router is backend-agnostic (reads via the MemoryStore). MUST stay
  // disabled in production (no auth).
  const devEndpointsEnabled =
    String(ctx.config.get<string>('dev_memory_endpoints_enabled') ?? 'false')
      .trim()
      .toLowerCase() === 'true';
  let disposeRoute: (() => void) | undefined;
  if (devEndpointsEnabled) {
    disposeRoute = ctx.routes.register(
      DEV_MEMORY_PREFIX,
      createDevMemoryRouter({ store }),
    );
    ctx.log(`[memory-postgres] mounted dev browser at ${DEV_MEMORY_PREFIX}`);
  }

  ctx.log(`[memory-postgres] ready (seed=${seedDir}, mode=${seedMode})`);

  return {
    async close(): Promise<void> {
      ctx.log('deactivating memory-postgres plugin');
      // Reverse order of construction. The pool is owned by the graphPool
      // provider — do NOT call pool.end() here.
      disposeTool();
      disposeService();
      disposeRoute?.();
    },
  };
}

function normaliseSeedMode(raw: string | undefined): MemorySeedMode {
  if (raw === 'overwrite' || raw === 'skip' || raw === 'missing') return raw;
  return 'missing';
}
