import type { PluginContext } from '@omadia/plugin-api';

import { createDevMemoryRouter } from './devMemoryRouter.js';
import { FilesystemMemoryStore } from './filesystem.js';
import { MemoryToolHandler } from './memoryTool.js';
import { MemorySeeder, type MemorySeedMode } from './seeder.js';

/**
 * @omadia/memory — plugin entry point for the memory infrastructure.
 *
 * `kind: extension`. Provides three things to the kernel on activate():
 *   1. The `memoryStore` service (root-level MemoryStore the kernel and
 *      cross-scope consumers read/write against — admin router, chat-session
 *      store, graph backfill, the Diagrams brand-logo auto-lookup, …).
 *   2. The Anthropic-native `memory` tool HANDLER — kernel keeps the
 *      `{type: 'memory_20250818', name: 'memory'}` wire-spec push itself
 *      (buildToolsList). Dispatch routes through this handler.
 *   3. The `/api/dev/memory` read-only browser router — mounted only when
 *      `dev_memory_endpoints_enabled` config resolves truthy. MUST stay
 *      disabled in production (the router has no auth).
 *
 * Required config (via ctx.config):
 *   - memory_dir                 absolute path for `/memories` on disk
 *
 * Optional config:
 *   - seed_dir                   default `memory-seed` relative to cwd
 *   - seed_mode                  'missing' | 'overwrite' | 'skip' (default 'missing')
 *   - dev_memory_endpoints_enabled  'true' mounts /api/dev/memory
 *
 * The plugin performs the seeder run during activate(), which blocks boot
 * until the seed directory has been walked. This keeps the pre-extraction
 * behaviour identical: index.ts used to run the seeder synchronously right
 * after `memoryStore.init()`.
 */

const DEV_MEMORY_PREFIX = '/api/dev/memory';

export interface MemoryPluginHandle {
  close(): Promise<void>;
}

export async function activate(ctx: PluginContext): Promise<MemoryPluginHandle> {
  ctx.log('activating memory plugin');

  const memoryDir = ctx.config.require<string>('memory_dir');
  const seedDir = ctx.config.get<string>('seed_dir') ?? 'memory-seed';
  const seedMode = normaliseSeedMode(ctx.config.get<string>('seed_mode'));
  const devEndpointsEnabled =
    String(ctx.config.get<string>('dev_memory_endpoints_enabled') ?? 'false')
      .trim()
      .toLowerCase() === 'true';

  const store = new FilesystemMemoryStore(memoryDir);
  await store.init();

  const disposeService = ctx.services.provide('memoryStore', store);

  const seedResult = await new MemorySeeder({
    seedDir,
    store,
    mode: seedMode,
  }).run();
  const summary = seedResult.files
    .reduce<Record<string, number>>((acc, entry) => {
      acc[entry.action] = (acc[entry.action] ?? 0) + 1;
      return acc;
    }, {});
  ctx.log(
    `[memory] seeder (${seedResult.mode}) → ${JSON.stringify(summary)} entries: ${seedResult.files.length}`,
  );

  const toolHandler = new MemoryToolHandler(store);
  const disposeTool = ctx.tools.registerHandler('memory', (input) =>
    toolHandler.handle(input),
  );

  let disposeRoute: (() => void) | undefined;
  if (devEndpointsEnabled) {
    const router = createDevMemoryRouter({ store });
    disposeRoute = ctx.routes.register(DEV_MEMORY_PREFIX, router);
    ctx.log(`[memory] mounted dev browser at ${DEV_MEMORY_PREFIX}`);
  }

  ctx.log(`[memory] ready (dir=${memoryDir}, seed=${seedDir}, mode=${seedMode})`);

  return {
    async close(): Promise<void> {
      ctx.log('deactivating memory plugin');
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
