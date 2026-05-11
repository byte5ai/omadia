import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { _resetCacheForTests } from '../../src/plugins/builder/boilerplateSource.js';
import { ensureBuildTemplate } from '../../src/plugins/builder/buildTemplate.js';
import { DraftStore } from '../../src/plugins/builder/draftStore.js';
import { SlotTypecheckPipeline } from '../../src/plugins/builder/slotTypecheckPipeline.js';
import type {
  TypecheckOptions,
  TypecheckResult,
} from '../../src/plugins/builder/typecheck.js';

describe('SlotTypecheckPipeline', () => {
  let tmp: string;
  let templateRoot: string;
  let stagingBaseDir: string;
  let dbPath: string;
  let draftStore: DraftStore;

  before(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'slot-tc-'));
    _resetCacheForTests();

    // Build template with workspace-only deps (skipNpmInstall) so tests
    // don't shell out to npm — staging prep just needs node_modules to
    // exist as a symlink target.
    templateRoot = path.join(tmp, 'build-template');
    const wsPkg = path.join(tmp, 'fake-plugin-api');
    mkdirSync(wsPkg, { recursive: true });
    writeFileSync(
      path.join(wsPkg, 'package.json'),
      JSON.stringify({ name: '@omadia/plugin-api', version: '0.1.0' }),
    );

    const result = await ensureBuildTemplate({
      templateRoot,
      npmDeps: {},
      workspaceDeps: { '@omadia/plugin-api': wsPkg },
      skipNpmInstall: true,
    });
    assert.equal(result.ready, true);

    stagingBaseDir = path.join(tmp, 'staging');
    mkdirSync(stagingBaseDir, { recursive: true });
  });

  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  beforeEach(async () => {
    dbPath = path.join(tmp, `drafts-${String(Date.now())}-${String(Math.random()).slice(2, 8)}.db`);
    draftStore = new DraftStore({ dbPath });
    await draftStore.open();
  });

  afterEach(async () => {
    await draftStore.close();
    rmSync(dbPath, { force: true });
  });

  function loadMinimalSpec(): { spec: Record<string, unknown>; slots: Record<string, string> } {
    const minimalSpec = JSON.parse(
      readFileSync(
        path.join(import.meta.dirname, 'fixtures', 'minimal-spec.json'),
        'utf-8',
      ),
    ) as Record<string, unknown>;
    const slots = (minimalSpec['slots'] as Record<string, string>) ?? {};
    const { slots: _ignored, ...specRest } = minimalSpec;
    void _ignored;
    return { spec: specRest, slots };
  }

  async function seedDraft(): Promise<{ userEmail: string; draftId: string }> {
    const userEmail = 'tester@example.com';
    const draft = await draftStore.create(userEmail, 'Slot-TC Draft');
    const { spec, slots } = loadMinimalSpec();
    await draftStore.update(userEmail, draft.id, { spec, slots });
    return { userEmail, draftId: draft.id };
  }

  function fakeRunTypecheck(
    canned: TypecheckResult,
  ): (opts: TypecheckOptions) => Promise<TypecheckResult> {
    return async () => canned;
  }

  it('returns reason=draft_not_found when the draft is missing', async () => {
    const pipeline = new SlotTypecheckPipeline({
      draftStore,
      templateRoot,
      stagingBaseDir,
      loadImportLookup: null,
      runTypecheck: fakeRunTypecheck({
        ok: true,
        errors: [],
        exitCode: 0,
        stdoutTail: '',
        stderrTail: '',
        durationMs: 0,
        reason: 'ok',
      }),
    });

    const result = await pipeline.run({ userEmail: 'who@example.com', draftId: 'no-such' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'draft_not_found');
    assert.match(result.summary, /not found/);
  });

  it('returns reason=spec_invalid when the spec fails Zod parsing', async () => {
    const userEmail = 'tester@example.com';
    const draft = await draftStore.create(userEmail, 'invalid');
    // Spec missing required identity fields → Zod throws.
    await draftStore.update(userEmail, draft.id, {
      spec: { description: 'no identity' },
      slots: {},
    });

    const pipeline = new SlotTypecheckPipeline({
      draftStore,
      templateRoot,
      stagingBaseDir,
      loadImportLookup: null,
      runTypecheck: fakeRunTypecheck({
        ok: true,
        errors: [],
        exitCode: 0,
        stdoutTail: '',
        stderrTail: '',
        durationMs: 0,
        reason: 'ok',
      }),
    });

    const result = await pipeline.run({ userEmail, draftId: draft.id });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'spec_invalid');
    assert.match(result.summary, /spec invalid/);
  });

  it('returns reason=codegen_failed when codegen rejects (e.g., missing required slot)', async () => {
    const userEmail = 'tester@example.com';
    const draft = await draftStore.create(userEmail, 'no slots');
    const { spec } = loadMinimalSpec();
    // Persist the spec but drop ALL slots — the boilerplate has required slots
    // that must be present, codegen will throw CodegenError.
    await draftStore.update(userEmail, draft.id, { spec, slots: {} });

    const pipeline = new SlotTypecheckPipeline({
      draftStore,
      templateRoot,
      stagingBaseDir,
      loadImportLookup: null,
      runTypecheck: fakeRunTypecheck({
        ok: true,
        errors: [],
        exitCode: 0,
        stdoutTail: '',
        stderrTail: '',
        durationMs: 0,
        reason: 'ok',
      }),
    });

    const result = await pipeline.run({ userEmail, draftId: draft.id });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'codegen_failed');
    assert.match(result.summary, /codegen failed/);
  });

  it('returns reason=ok and ok=true when typecheck reports clean', async () => {
    const { userEmail, draftId } = await seedDraft();

    const pipeline = new SlotTypecheckPipeline({
      draftStore,
      templateRoot,
      stagingBaseDir,
      loadImportLookup: null,
      runTypecheck: fakeRunTypecheck({
        ok: true,
        errors: [],
        exitCode: 0,
        stdoutTail: '',
        stderrTail: '',
        durationMs: 42,
        reason: 'ok',
      }),
    });

    const result = await pipeline.run({ userEmail, draftId });
    assert.equal(result.ok, true);
    assert.equal(result.reason, 'ok');
    assert.equal(result.errors.length, 0);
    assert.equal(result.summary, 'tsc clean');
  });

  it('returns reason=tsc with capped errors[] when typecheck reports problems', async () => {
    const { userEmail, draftId } = await seedDraft();
    const errors = Array.from({ length: 73 }, (_, i) => ({
      path: 'src/toolkit.ts',
      line: i + 1,
      col: 1,
      code: `TS900${String(i)}`,
      message: `error #${String(i)}`,
    }));

    const pipeline = new SlotTypecheckPipeline({
      draftStore,
      templateRoot,
      stagingBaseDir,
      loadImportLookup: null,
      runTypecheck: fakeRunTypecheck({
        ok: false,
        errors,
        exitCode: 1,
        stdoutTail: '',
        stderrTail: '',
        durationMs: 1500,
        reason: 'tsc',
      }),
    });

    const result = await pipeline.run({ userEmail, draftId });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'tsc');
    // Errors are capped at 50 to bound tool-result size.
    assert.equal(result.errors.length, 50);
    assert.match(result.summary, /tsc found 73 error\(s\)/);
    assert.match(result.summary, /showing first 50/);
  });

  it('OB-40 PR-A: short-circuits with reason=imports_invalid before tsc when a slot imports a forbidden internal package', async () => {
    const { userEmail, draftId } = await seedDraft();
    // Inject a forbidden import into the toolkit-impl slot. Codegen
    // substitutes the slot body verbatim into toolkit.ts via marker
    // regions, so the resolver will see the import in the generated
    // bundle and fail the gate before tsc is even invoked. We merge
    // with the seed slots so the other required slots stay populated.
    const { slots: seedSlots } = loadMinimalSpec();
    await draftStore.update(userEmail, draftId, {
      slots: {
        ...seedSlots,
        'toolkit-impl':
          "import type { PluginContext } from '@omadia/plugin-api';\n" +
          'export const FORBIDDEN_REF: PluginContext | null = null;\n',
      },
    });

    let tscCalls = 0;
    const pipeline = new SlotTypecheckPipeline({
      draftStore,
      templateRoot,
      stagingBaseDir,
      // Real lookup against the test build-template — `@omadia/
      // plugin-api` is symlinked in by the `before()` setup, but the
      // forbidden-list takes precedence so the gate still fires.
      runTypecheck: async (): Promise<TypecheckResult> => {
        tscCalls += 1;
        return {
          ok: true,
          errors: [],
          exitCode: 0,
          stdoutTail: '',
          stderrTail: '',
          durationMs: 0,
          reason: 'ok',
        };
      },
    });

    const result = await pipeline.run({ userEmail, draftId });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'imports_invalid');
    assert.equal(tscCalls, 0, 'tsc must not be invoked when import gate fails');
    assert.equal(result.errors.length >= 1, true);
    const forbidden = result.errors.find((e) => e.code === 'IMPORT_FORBIDDEN');
    assert.ok(
      forbidden !== undefined,
      'expected at least one IMPORT_FORBIDDEN issue for @omadia/plugin-api',
    );
    assert.match(forbidden.message, /standalone/i);
    assert.match(forbidden.message, /types\.ts/);
  });

  it('OB-40 PR-A: gate is skipped when loadImportLookup is null (test escape hatch)', async () => {
    const { userEmail, draftId } = await seedDraft();
    const { slots: seedSlots } = loadMinimalSpec();
    await draftStore.update(userEmail, draftId, {
      slots: {
        ...seedSlots,
        'toolkit-impl':
          "import { something } from 'definitely-not-installed';\n",
      },
    });

    let tscCalls = 0;
    const pipeline = new SlotTypecheckPipeline({
      draftStore,
      templateRoot,
      stagingBaseDir,
      loadImportLookup: null,
      runTypecheck: async (): Promise<TypecheckResult> => {
        tscCalls += 1;
        return {
          ok: true,
          errors: [],
          exitCode: 0,
          stdoutTail: '',
          stderrTail: '',
          durationMs: 0,
          reason: 'ok',
        };
      },
    });

    const result = await pipeline.run({ userEmail, draftId });
    assert.equal(result.ok, true);
    assert.equal(result.reason, 'ok');
    assert.equal(tscCalls, 1, 'tsc runs because the gate is disabled');
  });

  it('always cleans up staging dir even when typecheck fails', async () => {
    const { userEmail, draftId } = await seedDraft();

    const pipeline = new SlotTypecheckPipeline({
      draftStore,
      templateRoot,
      stagingBaseDir,
      loadImportLookup: null,
      runTypecheck: fakeRunTypecheck({
        ok: false,
        errors: [],
        exitCode: 1,
        stdoutTail: '',
        stderrTail: '',
        durationMs: 0,
        reason: 'unknown',
      }),
    });

    await pipeline.run({ userEmail, draftId });
    // Staging-base must be empty (or contain only the leftover dirs from
    // earlier tests in the same `before` block — but freshly created
    // entries from this run must have been cleaned).
    const remaining = readdirSync(stagingBaseDir).filter((name) => name.startsWith(draftId));
    assert.equal(remaining.length, 0, `expected no leftover staging dirs for ${draftId}`);
  });

  it('serialises concurrent run() calls on the same draftId via per-draft mutex', async () => {
    const { userEmail, draftId } = await seedDraft();

    const ledger: Array<'enter' | 'leave'> = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const pipeline = new SlotTypecheckPipeline({
      draftStore,
      templateRoot,
      stagingBaseDir,
      loadImportLookup: null,
      runTypecheck: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        ledger.push('enter');
        await new Promise((resolve) => setTimeout(resolve, 25));
        ledger.push('leave');
        inFlight -= 1;
        return {
          ok: true,
          errors: [],
          exitCode: 0,
          stdoutTail: '',
          stderrTail: '',
          durationMs: 25,
          reason: 'ok',
        };
      },
    });

    await Promise.all([
      pipeline.run({ userEmail, draftId }),
      pipeline.run({ userEmail, draftId }),
      pipeline.run({ userEmail, draftId }),
    ]);

    // Mutex must guarantee at most one tsc-gate runs at a time per draft.
    assert.equal(maxInFlight, 1, 'mutex must serialise concurrent runs on same draft');
    // Strict alternation: enter-leave-enter-leave-enter-leave.
    assert.deepEqual(ledger, ['enter', 'leave', 'enter', 'leave', 'enter', 'leave']);
  });

  it('does NOT serialise calls across different drafts (mutex is per-draft)', async () => {
    const a = await seedDraft();

    const userEmail = 'tester@example.com';
    const draftB = await draftStore.create(userEmail, 'B');
    const { spec, slots } = loadMinimalSpec();
    await draftStore.update(userEmail, draftB.id, {
      spec: { ...spec, id: 'de.byte5.agent.other' },
      slots,
    });

    let inFlight = 0;
    let maxInFlight = 0;
    const pipeline = new SlotTypecheckPipeline({
      draftStore,
      templateRoot,
      stagingBaseDir,
      loadImportLookup: null,
      runTypecheck: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 25));
        inFlight -= 1;
        return {
          ok: true,
          errors: [],
          exitCode: 0,
          stdoutTail: '',
          stderrTail: '',
          durationMs: 25,
          reason: 'ok',
        };
      },
    });

    await Promise.all([
      pipeline.run({ userEmail: a.userEmail, draftId: a.draftId }),
      pipeline.run({ userEmail, draftId: draftB.id }),
    ]);

    // Two distinct drafts → both can run concurrently.
    assert.equal(maxInFlight, 2);
  });

  it('awaits templateReady before preparing staging', async () => {
    const { userEmail, draftId } = await seedDraft();

    let templateGate: () => void = () => undefined;
    const templateReady = new Promise<void>((resolve) => {
      templateGate = resolve;
    });

    const pipeline = new SlotTypecheckPipeline({
      draftStore,
      templateRoot,
      stagingBaseDir,
      loadImportLookup: null,
      templateReady,
      runTypecheck: fakeRunTypecheck({
        ok: true,
        errors: [],
        exitCode: 0,
        stdoutTail: '',
        stderrTail: '',
        durationMs: 0,
        reason: 'ok',
      }),
    });

    let resolved = false;
    const runPromise = pipeline.run({ userEmail, draftId }).then((r) => {
      resolved = true;
      return r;
    });

    // Give the pipeline a microtask to advance and (if it ignored
    // templateReady) reach completion. It must NOT have resolved yet.
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(resolved, false, 'pipeline must wait on templateReady');

    templateGate();
    const result = await runPromise;
    assert.equal(result.ok, true);
  });

  it('persists no leftover staging dir even when codegen fails', async () => {
    const userEmail = 'tester@example.com';
    const draft = await draftStore.create(userEmail, 'codegen-fail');
    const { spec } = loadMinimalSpec();
    await draftStore.update(userEmail, draft.id, { spec, slots: {} });

    const stagingBefore = existsSync(stagingBaseDir)
      ? readdirSync(stagingBaseDir).length
      : 0;

    const pipeline = new SlotTypecheckPipeline({
      draftStore,
      templateRoot,
      stagingBaseDir,
      loadImportLookup: null,
      runTypecheck: fakeRunTypecheck({
        ok: true,
        errors: [],
        exitCode: 0,
        stdoutTail: '',
        stderrTail: '',
        durationMs: 0,
        reason: 'ok',
      }),
    });

    const result = await pipeline.run({ userEmail, draftId: draft.id });
    assert.equal(result.reason, 'codegen_failed');

    const stagingAfter = readdirSync(stagingBaseDir).length;
    // Codegen fails BEFORE staging prep → no new dir created.
    assert.equal(stagingAfter, stagingBefore);
  });

  /**
   * OB-46 — persist-back path. The pipeline writes ESLint-fixed slot
   * bodies back to the DraftStore and emits `slot_patch` events with
   * `cause: 'eslint-autofix'`. We use a deterministic fake auto-fix
   * (let → const everywhere) so the tests don't depend on the real
   * ESLint plugin behaviour, which is covered separately in
   * eslintAutoFixPass.test.ts.
   */
  describe('OB-46 ESLint persist-back', () => {
    /**
     * Deterministic stand-in for `eslintAutoFixBundle`: replaces every
     * `let ` with `const ` in text-like files. Keeps non-text buffers
     * untouched so we can also check the binary-preservation path
     * without stitching real ESLint into pipeline tests.
     */
    function fakeAutoFix(
      files: ReadonlyMap<string, Buffer>,
    ): Promise<Map<string, Buffer>> {
      const out = new Map<string, Buffer>();
      for (const [relPath, buf] of files) {
        const ext = path.extname(relPath).toLowerCase();
        if (!['.ts', '.tsx', '.js', '.mjs'].includes(ext)) {
          out.set(relPath, buf);
          continue;
        }
        const text = buf.toString('utf-8');
        const fixed = text.replace(/\blet /g, 'const ');
        out.set(relPath, fixed === text ? buf : Buffer.from(fixed, 'utf-8'));
      }
      return Promise.resolve(out);
    }

    function recordingBus() {
      const events: Array<{
        draftId: string;
        type: string;
        slotKey?: string;
        source?: string;
        cause?: string;
      }> = [];
      const bus = {
        emit: (
          draftId: string,
          ev: {
            type: string;
            slotKey?: string;
            source?: string;
            cause?: string;
          },
        ) => {
          events.push({ draftId, ...ev });
        },
        on: () => () => undefined,
      } as unknown as ConstructorParameters<typeof SlotTypecheckPipeline>[0]['bus'];
      return { bus, events };
    }

    it('writes fixed slot back to DraftStore and emits slot_patch with cause=eslint-autofix', async () => {
      const userEmail = 'tester@example.com';
      const draft = await draftStore.create(userEmail, 'persist-back');
      const { spec, slots } = loadMinimalSpec();
      // Authored slot uses `let` — the fake auto-fix flips it to `const`.
      const authoredToolkit =
        'export function createToolkit(opts: ToolkitOptions): Toolkit {\n' +
        '  let toolList: never[] = [];\n' +
        '  return { tools: toolList, async close() { await opts.client.dispose(); } };\n' +
        '}';
      await draftStore.update(userEmail, draft.id, {
        spec,
        slots: { ...slots, 'toolkit-impl': authoredToolkit },
      });

      const { bus, events } = recordingBus();
      const pipeline = new SlotTypecheckPipeline({
        draftStore,
        templateRoot,
        stagingBaseDir,
        loadImportLookup: null,
        runEslintAutoFix: fakeAutoFix,
        bus,
        runTypecheck: fakeRunTypecheck({
          ok: true,
          errors: [],
          exitCode: 0,
          stdoutTail: '',
          stderrTail: '',
          durationMs: 0,
          reason: 'ok',
        }),
      });

      const result = await pipeline.run({ userEmail, draftId: draft.id });
      assert.equal(result.ok, true);

      // Slot persisted back with `const`.
      const reloaded = await draftStore.load(userEmail, draft.id);
      assert.ok(reloaded !== null);
      const persistedSlot = reloaded.slots['toolkit-impl'];
      assert.match(persistedSlot ?? '', /const toolList: never\[\] = \[\];/);
      assert.doesNotMatch(persistedSlot ?? '', /\blet toolList\b/);

      // Bus event emitted with the right shape.
      const slotPatch = events.find(
        (e) => e.type === 'slot_patch' && e.slotKey === 'toolkit-impl',
      );
      assert.ok(slotPatch !== undefined, 'expected one slot_patch event for toolkit-impl');
      assert.equal(slotPatch.cause, 'eslint-autofix');
      assert.equal(slotPatch.draftId, draft.id);
      assert.match(slotPatch.source ?? '', /const toolList/);
    });

    it('is idempotent — second run on the already-fixed slot emits no event and does not re-write', async () => {
      const userEmail = 'tester@example.com';
      const draft = await draftStore.create(userEmail, 'idempotent');
      const { spec, slots } = loadMinimalSpec();
      // Already-fixed slot: contains only `const`. Fake auto-fix is a
      // no-op on this input; persist-back must skip.
      const cleanToolkit =
        'export function createToolkit(opts: ToolkitOptions): Toolkit {\n' +
        '  const toolList: never[] = [];\n' +
        '  return { tools: toolList, async close() { await opts.client.dispose(); } };\n' +
        '}';
      await draftStore.update(userEmail, draft.id, {
        spec,
        slots: { ...slots, 'toolkit-impl': cleanToolkit },
      });

      const { bus, events } = recordingBus();
      let updateCalls = 0;
      const wrappedStore = new Proxy(draftStore, {
        get(target, prop, receiver) {
          if (prop === 'update') {
            return async (...args: unknown[]) => {
              updateCalls += 1;
              // @ts-expect-error pass-through
              return target.update(...args);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });

      const pipeline = new SlotTypecheckPipeline({
        draftStore: wrappedStore,
        templateRoot,
        stagingBaseDir,
        loadImportLookup: null,
        runEslintAutoFix: fakeAutoFix,
        bus,
        runTypecheck: fakeRunTypecheck({
          ok: true,
          errors: [],
          exitCode: 0,
          stdoutTail: '',
          stderrTail: '',
          durationMs: 0,
          reason: 'ok',
        }),
      });

      const result = await pipeline.run({ userEmail, draftId: draft.id });
      assert.equal(result.ok, true);
      assert.equal(updateCalls, 0, 'persist-back must not call draftStore.update on no-diff run');
      assert.equal(
        events.filter((e) => e.cause === 'eslint-autofix').length,
        0,
        'no eslint-autofix event should fire on a clean slot',
      );
    });

    it('skips persist-back when bus is omitted but still updates DraftStore', async () => {
      const userEmail = 'tester@example.com';
      const draft = await draftStore.create(userEmail, 'no-bus');
      const { spec, slots } = loadMinimalSpec();
      const authoredToolkit =
        'export function createToolkit(opts: ToolkitOptions): Toolkit {\n' +
        '  let xs: never[] = [];\n' +
        '  return { tools: xs, async close() { await opts.client.dispose(); } };\n' +
        '}';
      await draftStore.update(userEmail, draft.id, {
        spec,
        slots: { ...slots, 'toolkit-impl': authoredToolkit },
      });

      const pipeline = new SlotTypecheckPipeline({
        draftStore,
        templateRoot,
        stagingBaseDir,
        loadImportLookup: null,
        runEslintAutoFix: fakeAutoFix,
        // no bus — non-UI test path
        runTypecheck: fakeRunTypecheck({
          ok: true,
          errors: [],
          exitCode: 0,
          stdoutTail: '',
          stderrTail: '',
          durationMs: 0,
          reason: 'ok',
        }),
      });

      const result = await pipeline.run({ userEmail, draftId: draft.id });
      assert.equal(result.ok, true);
      const reloaded = await draftStore.load(userEmail, draft.id);
      assert.ok(reloaded !== null);
      assert.match(reloaded.slots['toolkit-impl'] ?? '', /const xs/);
    });

    it('does NOT persist when the slot contains placeholders ({{TOKEN}})', async () => {
      const userEmail = 'tester@example.com';
      const draft = await draftStore.create(userEmail, 'placeholder');
      const { spec, slots } = loadMinimalSpec();
      // The slot has a {{TOKEN}} placeholder — codegen step 5c resolves
      // it before fakeAutoFix runs, so the post-fix region body would
      // be the resolved value. Persisting that would corrupt the slot.
      const authoredToolkit =
        'export function createToolkit(opts: ToolkitOptions): Toolkit {\n' +
        "  let label = '{{AGENT_ID}}';\n" +
        '  return { tools: [], async close() { await opts.client.dispose(); }, label };\n' +
        '}';
      await draftStore.update(userEmail, draft.id, {
        spec,
        slots: { ...slots, 'toolkit-impl': authoredToolkit },
      });

      const { bus, events } = recordingBus();
      const pipeline = new SlotTypecheckPipeline({
        draftStore,
        templateRoot,
        stagingBaseDir,
        loadImportLookup: null,
        runEslintAutoFix: fakeAutoFix,
        bus,
        runTypecheck: fakeRunTypecheck({
          ok: true,
          errors: [],
          exitCode: 0,
          stdoutTail: '',
          stderrTail: '',
          durationMs: 0,
          reason: 'ok',
        }),
      });

      await pipeline.run({ userEmail, draftId: draft.id });
      const reloaded = await draftStore.load(userEmail, draft.id);
      assert.ok(reloaded !== null);
      // Slot stays as authored — placeholder safety filter prevented
      // the persist that would have lost the {{AGENT_ID}} reference.
      assert.equal(reloaded.slots['toolkit-impl'], authoredToolkit);
      assert.equal(
        events.filter((e) => e.cause === 'eslint-autofix').length,
        0,
        'no eslint-autofix event should fire on placeholder-bearing slots',
      );
    });
  });
});
