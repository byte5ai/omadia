import { parseAgentSpec } from './agentSpec.js';
import type { BuildError } from './buildErrorParser.js';
import {
  prepareStagingDir,
  cleanupStagingDir,
} from './buildTemplate.js';
import { generate, CodegenError } from './codegen.js';
import type { DraftStore } from './draftStore.js';
import {
  typecheckStaging,
  type TypecheckResult,
  type TypecheckOptions,
} from './typecheck.js';
import {
  eslintAutoFixBundle,
  extractPersistableSlotFixes,
  type PersistableSlotFix,
} from './eslintAutoFixPass.js';
import type { SpecEventBus } from './specEventBus.js';
import {
  type ImportLookup,
  loadInstalledPackagesLookup,
  validateBundleImports,
} from './workspaceImportResolver.js';

/**
 * SlotTypecheckPipeline — fast tsc-gate fed by the `fill_slot` tool.
 *
 * Responsibilities (mirror of BuildPipeline minus the sandbox/zip step):
 *   1. Load draft + parse spec via Zod
 *   2. Codegen the file map (slots already merged in the draft store)
 *   3. prepareStagingDir on disk (symlink shared node_modules)
 *   4. Run `tsc --noEmit` via {@link typecheckStaging}
 *   5. Cleanup staging dir
 *
 * Design notes:
 *   - Per-draft mutex serialises concurrent `fill_slot` calls so we don't
 *     race on staging dir creation/cleanup. The build pipeline has its
 *     own coalescing (BuildQueue) — they coexist via separate staging dirs.
 *   - Slot content is persisted by `fill_slot` BEFORE this runs; this
 *     pipeline only reads `draft.slots` and reports tsc/codegen problems.
 *   - Failure modes are flattened into a single `SlotTypecheckResult` so
 *     `fill_slot` can surface a uniform tool-result to the agent without
 *     having to discriminate between BuildPipelineError, CodegenError,
 *     spec-invalid etc.
 */

export type SlotTypecheckReason =
  | 'ok'
  | 'tsc'
  | 'unknown'
  | 'spec_invalid'
  | 'codegen_failed'
  | 'imports_invalid'
  | 'staging_failed'
  | 'timeout'
  | 'abort'
  | 'spawn'
  | 'draft_not_found';

export interface SlotTypecheckResult {
  ok: boolean;
  errors: BuildError[];
  reason: SlotTypecheckReason;
  /** Single-line human-readable summary, suitable for tool-result `error` field. */
  summary: string;
  durationMs: number;
}

export interface SlotTypecheckService {
  run(opts: { userEmail: string; draftId: string }): Promise<SlotTypecheckResult>;
}

export interface SlotTypecheckPipelineDeps {
  draftStore: DraftStore;
  /** Absolute path to the build-template dir (`data/builder/build-template`). */
  templateRoot: string;
  /** Override staging base; defaults to `<templateRoot>/../staging`. */
  stagingBaseDir?: string;
  /** Awaited before the first staging prep, same as in BuildPipeline. */
  templateReady?: Promise<void>;
  /** Per-tsc timeout (ms). Defaults to typecheckStaging's default (30s). */
  timeoutMs?: number;
  /** Test override — replaces the actual tsc invocation. */
  runTypecheck?: (opts: TypecheckOptions) => Promise<TypecheckResult>;
  /**
   * Test override — replaces the build-template scan that backs the
   * pre-tsc workspace-import resolver. Production wires this to
   * `loadInstalledPackagesLookup(templateRoot)`. Pass `null` to disable
   * the gate entirely (useful in tests that pre-date the gate). */
  loadImportLookup?: (() => Promise<ImportLookup>) | null;
  /**
   * Test override — replaces the in-memory ESLint auto-fix pass
   * (OB-40 PR-B). Production uses the default exported pass. Pass
   * `null` to disable the auto-fix step (tests that want to assert
   * raw codegen output without style normalisation).
   */
  runEslintAutoFix?:
    | ((files: ReadonlyMap<string, Buffer>) => Promise<Map<string, Buffer>>)
    | null;
  /**
   * Optional event bus for the OB-46 persist-back pass. When provided
   * AND the ESLint pass produces a slot-level diff that survives the
   * placeholder-safety filter, the pipeline writes the fixed slot
   * source back to the DraftStore and emits a `slot_patch` event with
   * `cause: 'eslint-autofix'` per affected slot. Tests that don't care
   * about events can omit it; persistence still happens but the SSE
   * surface goes silent (acceptable for non-UI test paths).
   */
  bus?: SpecEventBus;
  logger?: (...args: unknown[]) => void;
}

const MAX_ERRORS_REPORTED = 50;

export class SlotTypecheckPipeline implements SlotTypecheckService {
  private readonly draftStore: DraftStore;
  private readonly templateRoot: string;
  private readonly stagingBaseDir: string | undefined;
  private readonly templateReady: Promise<void> | undefined;
  private readonly timeoutMs: number | undefined;
  private readonly runTypecheck: (opts: TypecheckOptions) => Promise<TypecheckResult>;
  private readonly loadImportLookup: (() => Promise<ImportLookup>) | null;
  private readonly runEslintAutoFix:
    | ((files: ReadonlyMap<string, Buffer>) => Promise<Map<string, Buffer>>)
    | null;
  private readonly bus: SpecEventBus | undefined;
  private readonly log: (...args: unknown[]) => void;

  /** Per-draft mutex — concurrent fill_slot calls on the same draft serialise. */
  private readonly locks = new Map<string, Promise<unknown>>();
  /** Monotonic per-instance counter, used in staging-dir naming. */
  private buildCounter = 0;

  constructor(deps: SlotTypecheckPipelineDeps) {
    this.draftStore = deps.draftStore;
    this.templateRoot = deps.templateRoot;
    this.stagingBaseDir = deps.stagingBaseDir;
    this.templateReady = deps.templateReady;
    this.timeoutMs = deps.timeoutMs;
    this.runTypecheck = deps.runTypecheck ?? typecheckStaging;
    this.loadImportLookup =
      deps.loadImportLookup === undefined
        ? () => loadInstalledPackagesLookup(this.templateRoot)
        : deps.loadImportLookup;
    this.runEslintAutoFix =
      deps.runEslintAutoFix === undefined
        ? eslintAutoFixBundle
        : deps.runEslintAutoFix;
    this.bus = deps.bus;
    this.log = deps.logger ?? (() => {});
  }

  async run(opts: { userEmail: string; draftId: string }): Promise<SlotTypecheckResult> {
    return this.withDraftLock(opts.draftId, () => this.runUnlocked(opts));
  }

  private async withDraftLock<T>(draftId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(draftId) ?? Promise.resolve();
    // Settle (don't propagate) the previous lock's outcome so a failure
    // in one fill_slot doesn't poison subsequent ones on the same draft.
    const next = previous.catch(() => undefined).then(fn);
    this.locks.set(draftId, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(draftId) === next) this.locks.delete(draftId);
    }
  }

  private async runUnlocked(opts: {
    userEmail: string;
    draftId: string;
  }): Promise<SlotTypecheckResult> {
    const start = Date.now();

    const draft = await this.draftStore.load(opts.userEmail, opts.draftId);
    if (!draft) {
      return {
        ok: false,
        errors: [],
        reason: 'draft_not_found',
        summary: `draft '${opts.draftId}' not found for user '${opts.userEmail}'`,
        durationMs: Date.now() - start,
      };
    }

    let spec;
    try {
      spec = parseAgentSpec(draft.spec);
    } catch (err) {
      return {
        ok: false,
        errors: [],
        reason: 'spec_invalid',
        summary: `spec invalid: ${truncate((err as Error).message, 400)}`,
        durationMs: Date.now() - start,
      };
    }

    let files: Map<string, Buffer>;
    try {
      files = await generate({ spec, slots: draft.slots });
    } catch (err) {
      if (err instanceof CodegenError) {
        const detail = err.issues.map((i) => i.detail).join('; ');
        return {
          ok: false,
          errors: [],
          reason: 'codegen_failed',
          summary: `codegen failed: ${truncate(detail, 600)}`,
          durationMs: Date.now() - start,
        };
      }
      throw err;
    }

    if (this.templateReady) {
      await this.templateReady;
    }

    // OB-40 PR-B — in-memory ESLint auto-fix pass. Type-info-free style
    // rules (prefer-const, no-var, no-useless-escape) get applied before
    // tsc sees the bundle, so the agent doesn't churn on cosmetic
    // diagnostics that don't carry semantic meaning. Failure of the pass
    // is non-fatal — files fall through unchanged on parse errors and
    // tsc surfaces the real diagnostic.
    //
    // OB-46 — persist-back: when the ESLint pass changed a slot's body
    // (and the slot's original text contains no `{{TOKEN}}` placeholders),
    // write the fixed source back to the DraftStore and emit a
    // `slot_patch` event with `cause: 'eslint-autofix'` so the editor,
    // the build pipeline, the install zip, and clone-from-installed
    // all see the fixed code. Without this the in-memory fix lives
    // only for the current tsc gate and the unfixed slot ships in the
    // built zip.
    if (this.runEslintAutoFix !== null) {
      const preFixFiles = files;
      try {
        const postFixFiles = await this.runEslintAutoFix(preFixFiles);
        if (postFixFiles !== preFixFiles) {
          const fixes = extractPersistableSlotFixes({
            preFixFiles,
            postFixFiles,
            originalSlots: draft.slots,
          });
          if (fixes.length > 0) {
            await this.persistEslintFixes(opts, draft.slots, fixes);
          }
        }
        files = postFixFiles;
      } catch (err) {
        this.log(
          `[slot-typecheck] eslint auto-fix failed (non-fatal): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    // OB-40 PR-A — pre-tsc workspace-import gate. Catches forbidden-
    // internal and unresolved bare-specifier imports without spawning tsc
    // (saves ~200-500ms on the failure path) and feeds back sharper,
    // actionable diagnostics than tsc's generic "Cannot find module".
    if (this.loadImportLookup !== null) {
      let importLookup: ImportLookup;
      try {
        importLookup = await this.loadImportLookup();
      } catch (err) {
        // Fail-open: if the lookup can't be built we let tsc do its job
        // and surface the error there. The alternative (failing closed)
        // would block all fill_slot turns whenever the build-template
        // is in a transient state.
        this.log(
          `[slot-typecheck] import-lookup unavailable, falling back to tsc-only: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        importLookup = { isInstalled: () => true };
      }
      const importIssues = validateBundleImports(files, importLookup);
      if (importIssues.length > 0) {
        const durationMs = Date.now() - start;
        const summary =
          importIssues.length === 1
            ? `import gate: ${importIssues[0]!.code} for '${importIssues[0]!.path}'`
            : `import gate: ${String(importIssues.length)} unresolved/forbidden imports`;
        this.log(
          `[slot-typecheck] draft=${opts.draftId} import-gate failed errors=${String(importIssues.length)} duration_ms=${String(durationMs)}`,
        );
        return {
          ok: false,
          errors: importIssues,
          reason: 'imports_invalid',
          summary,
          durationMs,
        };
      }
    }

    const buildN = ++this.buildCounter;
    let stagingDir: string;
    try {
      stagingDir = await prepareStagingDir({
        templateRoot: this.templateRoot,
        draftId: opts.draftId,
        buildN,
        files,
        ...(this.stagingBaseDir !== undefined ? { stagingBaseDir: this.stagingBaseDir } : {}),
      });
    } catch (err) {
      return {
        ok: false,
        errors: [],
        reason: 'staging_failed',
        summary: `staging failed: ${truncate((err as Error).message, 400)}`,
        durationMs: Date.now() - start,
      };
    }

    try {
      const tcResult = await this.runTypecheck({
        stagingDir,
        ...(this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {}),
      });
      const durationMs = Date.now() - start;
      this.log(
        `[slot-typecheck] draft=${opts.draftId} buildN=${String(buildN)} ok=${String(tcResult.ok)} errors=${String(tcResult.errors.length)} reason=${tcResult.reason} duration_ms=${String(durationMs)}`,
      );

      const reportedErrors = tcResult.errors.slice(0, MAX_ERRORS_REPORTED);
      const summary = tcResult.ok
        ? 'tsc clean'
        : tcResult.reason === 'tsc'
          ? `tsc found ${String(tcResult.errors.length)} error(s)${tcResult.errors.length > MAX_ERRORS_REPORTED ? ` (showing first ${String(MAX_ERRORS_REPORTED)})` : ''}`
          : `tsc gate failed (reason=${tcResult.reason})`;

      return {
        ok: tcResult.ok,
        errors: reportedErrors,
        reason: tcResult.reason,
        summary,
        durationMs,
      };
    } finally {
      try {
        await cleanupStagingDir(stagingDir);
      } catch (err) {
        this.log(
          `[slot-typecheck] cleanup failed for staging=${stagingDir}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * OB-46 — write the fixed slot bodies back to the DraftStore in a
   * single `update()` call (atomic for the slots map) and emit one
   * `slot_patch` event per fix so the frontend SSE bridge can update
   * Monaco buffers and surface a turn-log entry per auto-fix.
   *
   * Errors are swallowed so the in-memory fix still flows through tsc.
   * Persistence failure is logged but doesn't fail the gate — the
   * worst-case is the next slotTypecheck run will detect the same diff
   * and try again.
   */
  private async persistEslintFixes(
    opts: { userEmail: string; draftId: string },
    originalSlots: Readonly<Record<string, string>>,
    fixes: PersistableSlotFix[],
  ): Promise<void> {
    const updatedSlots: Record<string, string> = { ...originalSlots };
    for (const fix of fixes) {
      updatedSlots[fix.slotKey] = fix.fixedSource;
    }

    try {
      await this.draftStore.update(opts.userEmail, opts.draftId, {
        slots: updatedSlots,
      });
    } catch (err) {
      this.log(
        `[slot-typecheck] eslint persist-back update failed (non-fatal) draft=${opts.draftId} fixes=${String(fixes.length)}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }

    this.log(
      `[slot-typecheck] eslint persist-back draft=${opts.draftId} fixes=${String(fixes.length)} keys=${fixes
        .map((f) => f.slotKey)
        .join(',')}`,
    );

    if (this.bus !== undefined) {
      for (const fix of fixes) {
        try {
          this.bus.emit(opts.draftId, {
            type: 'slot_patch',
            slotKey: fix.slotKey,
            source: fix.fixedSource,
            cause: 'eslint-autofix',
          });
        } catch (err) {
          this.log(
            `[slot-typecheck] bus.emit slot_patch failed (non-fatal) slotKey=${fix.slotKey}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
