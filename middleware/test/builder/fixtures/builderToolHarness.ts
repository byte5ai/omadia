import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DraftStore } from '../../../src/plugins/builder/draftStore.js';
import type {
  SlotTypecheckResult,
  SlotTypecheckService,
} from '../../../src/plugins/builder/slotTypecheckPipeline.js';
import { SpecEventBus, type SpecBusEvent } from '../../../src/plugins/builder/specEventBus.js';
import type {
  BuildFailureBudget,
  BuilderToolContext,
  RebuildScheduler,
  SlotRetryTracker,
} from '../../../src/plugins/builder/tools/index.js';

export interface RebuildCall {
  userEmail: string;
  draftId: string;
  at: number;
}

/**
 * Test harness that builds a real DraftStore + SpecEventBus + spy
 * RebuildScheduler. Returns an open bag of references the test can inspect:
 * `events` accumulates everything emitted on the bus for `draftId`,
 * `rebuilds` accumulates every `schedule(...)` call made.
 *
 * Caller is expected to `await harness.dispose()` in `after` / `afterEach`.
 */
export interface BuilderToolHarness {
  readonly draftStore: DraftStore;
  readonly bus: SpecEventBus;
  readonly rebuildScheduler: RebuildScheduler;
  readonly userEmail: string;
  readonly draftId: string;
  readonly events: SpecBusEvent[];
  readonly rebuilds: RebuildCall[];
  readonly referenceRoot: string;
  readonly catalogToolNames: () => readonly string[];
  readonly slotTypecheckCalls: Array<{ userEmail: string; draftId: string }>;
  /** Mutate to control the next slotTypechecker.run() outcome. */
  slotTypecheckResult: SlotTypecheckResult;
  /** Mutate to thread a userMessage into BuilderToolContext (B.7-3 content-guard). */
  userMessage: string | undefined;
  /** Mutate to control which plugin ids the manifestLinter sees (B.8-2). */
  knownPluginIds: readonly string[];
  readonly tmpRoot: string;
  context(): BuilderToolContext;
  dispose(): Promise<void>;
}

export interface CreateHarnessOptions {
  /** Files to seed inside the synthetic reference root. Map of relpath → content. */
  referenceFiles?: Record<string, string>;
  /** Catalog tool names returned by the provider. */
  catalogToolNames?: readonly string[];
  /** Initial outcome the stub slotTypechecker returns; defaults to a clean ok=true. */
  slotTypecheckResult?: SlotTypecheckResult;
  /** Initial known-plugin-ids set used by the manifestLinter (B.8-2). */
  knownPluginIds?: readonly string[];
  /**
   * Cap on consecutive slot-typecheck failures the BuildFailureBudget
   * should enforce. Defaults to a high number (1000) so legacy tests
   * that don't care about the budget never trip it. Override with a
   * small number to test the cap behaviour explicitly.
   */
  buildFailureBudgetLimit?: number;
  /**
   * Absolute path used as the template root for `list_package_types` /
   * `read_package_types`. When omitted, points at an empty directory
   * inside the harness tmp root — tests that exercise package lookup
   * should override this with a path containing a fake `node_modules/`.
   */
  templateRoot?: string;
}

export async function createBuilderToolHarness(
  opts: CreateHarnessOptions = {},
): Promise<BuilderToolHarness> {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), 'builder-tool-'));
  const dbPath = path.join(tmpRoot, 'drafts.db');
  const referenceRoot = path.join(tmpRoot, 'reference');
  mkdirSync(referenceRoot, { recursive: true });

  if (opts.referenceFiles) {
    for (const [rel, content] of Object.entries(opts.referenceFiles)) {
      const target = path.join(referenceRoot, rel);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content, 'utf8');
    }
  }

  const draftStore = new DraftStore({ dbPath });
  await draftStore.open();

  const userEmail = 'tester@example.com';
  const draft = await draftStore.create(userEmail, 'Test Draft');

  const bus = new SpecEventBus();
  const events: SpecBusEvent[] = [];
  bus.subscribe(draft.id, (e) => events.push(e));

  const rebuilds: RebuildCall[] = [];
  const rebuildScheduler: RebuildScheduler = {
    schedule(email: string, draftId: string) {
      rebuilds.push({ userEmail: email, draftId, at: Date.now() });
    },
  };

  const catalogNames = opts.catalogToolNames ?? [];
  const catalogToolNames = (): readonly string[] => catalogNames;

  // Per-harness fresh retry tracker (mirrors per-turn semantics from BuilderAgent).
  const slotRetries = new Map<string, number>();
  const slotRetryTracker: SlotRetryTracker = {
    recordFail(slotKey: string): number {
      const next = (slotRetries.get(slotKey) ?? 0) + 1;
      slotRetries.set(slotKey, next);
      return next;
    },
    reset(slotKey: string): void {
      slotRetries.delete(slotKey);
    },
  };

  // Per-harness cross-slot consecutive-failure budget. Default ceiling
  // is intentionally high so existing fillSlot tests never trip it.
  let consecutiveFails = 0;
  const buildFailureBudget: BuildFailureBudget = {
    recordFail(): number {
      consecutiveFails += 1;
      return consecutiveFails;
    },
    reset(): void {
      consecutiveFails = 0;
    },
    limit: opts.buildFailureBudgetLimit ?? 1000,
  };

  const templateRoot = opts.templateRoot ?? path.join(tmpRoot, 'template-root');
  mkdirSync(templateRoot, { recursive: true });

  const slotTypecheckCalls: Array<{ userEmail: string; draftId: string }> = [];
  const harnessState: {
    slotTypecheckResult: SlotTypecheckResult;
    userMessage: string | undefined;
    knownPluginIds: readonly string[];
  } = {
    slotTypecheckResult: opts.slotTypecheckResult ?? {
      ok: true,
      errors: [],
      reason: 'ok',
      summary: 'tsc clean',
      durationMs: 0,
    },
    userMessage: undefined,
    knownPluginIds: opts.knownPluginIds ?? [],
  };
  const slotTypechecker: SlotTypecheckService = {
    async run(call) {
      slotTypecheckCalls.push(call);
      return harnessState.slotTypecheckResult;
    },
  };

  return {
    draftStore,
    bus,
    rebuildScheduler,
    userEmail,
    draftId: draft.id,
    events,
    rebuilds,
    referenceRoot,
    catalogToolNames,
    slotTypecheckCalls,
    get slotTypecheckResult() {
      return harnessState.slotTypecheckResult;
    },
    set slotTypecheckResult(value: SlotTypecheckResult) {
      harnessState.slotTypecheckResult = value;
    },
    get userMessage() {
      return harnessState.userMessage;
    },
    set userMessage(value: string | undefined) {
      harnessState.userMessage = value;
    },
    get knownPluginIds() {
      return harnessState.knownPluginIds;
    },
    set knownPluginIds(value: readonly string[]) {
      harnessState.knownPluginIds = value;
    },
    tmpRoot,
    context(): BuilderToolContext {
      const base: BuilderToolContext = {
        userEmail,
        draftId: draft.id,
        draftStore,
        bus,
        rebuildScheduler,
        catalogToolNames,
        knownPluginIds: () => harnessState.knownPluginIds,
        slotTypechecker,
        slotRetryTracker,
        buildFailureBudget,
        templateRoot,
        referenceCatalog: {
          'seo-analyst': {
            root: referenceRoot,
            description: 'test reference',
          },
        },
      };
      return harnessState.userMessage !== undefined
        ? { ...base, userMessage: harnessState.userMessage }
        : base;
    },
    async dispose() {
      await draftStore.close();
      rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}
