import { parseAgentSpec } from './agentSpec.js';
import { build as runBuildSandbox } from './buildSandbox.js';
import type { BuildResult } from './buildSandbox.js';
import type { BuildQueue } from './buildQueue.js';
import { generate, CodegenError } from './codegen.js';
import {
  prepareStagingDir,
  cleanupStagingDir,
} from './buildTemplate.js';
import type { DraftStore } from './draftStore.js';
import { specToAgentMd } from './specToAgentMd.js';
import type { Draft } from './types.js';

/**
 * BuildPipeline — convenience layer that glues B.1 codegen + B.2 staging +
 * B.2 sandbox into a single `run()` call routed through the shared
 * `BuildQueue`. Designed for B.3's preview rebuilds and B.5's install
 * commits. Keeps each builder phase replaceable by accepting raw modules
 * instead of importing them globally.
 *
 * Responsibilities:
 *   1. Load + validate the draft (spec via Zod)
 *   2. Codegen the file map
 *   3. Materialise a staging dir on disk (`prepareStagingDir`)
 *   4. Enqueue the sandbox build via BuildQueue (coalesces stale builds)
 *   5. Always cleanup the staging dir afterward (success or failure)
 *
 * Errors classify into `BuildPipelineError` with a code:
 *   - `draft_not_found` — store returned null (auth scope check)
 *   - `spec_invalid`    — Zod parse failed
 *   - `codegen_failed`  — CodegenError from generate()
 *   - `staging_failed`  — disk-write or symlink error during prepareStagingDir
 *
 * `run()` does NOT throw on tsc failures — those surface as
 * `BuildResult { ok: false, errors: [...] }` so callers (preview-cache,
 * SSE bridges) can stream them as build-status events instead of HTTP 5xx.
 */

export interface BuildPipelineDeps {
  draftStore: DraftStore;
  buildQueue: BuildQueue;
  /** Absolute path to the build-template dir (`data/builder/build-template`). */
  templateRoot: string;
  /** Override staging base; defaults to `<templateRoot>/../staging`. */
  stagingBaseDir?: string;
  /** Per-build timeout (ms). Defaults to buildSandbox default (45s). */
  buildTimeoutMs?: number;
  /** Test override — replaces the buildSandbox call. */
  buildSandbox?: (opts: {
    stagingDir: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  }) => Promise<BuildResult>;
  /** Optional gate awaited before each `prepareStagingDir`. Index wires this
   *  to the in-flight `ensureBuildTemplate(...)` promise so the first preview
   *  build queues until npm install + workspace symlinks are ready. Once the
   *  gate resolves, subsequent builds skip the await (resolved promise).
   *  Tests omit it. */
  templateReady?: Promise<void>;
  logger?: (...args: unknown[]) => void;
}

export interface PipelineRunOptions {
  userEmail: string;
  draftId: string;
  /**
   * What this build is for. Controls the BuildQueue coalesce key:
   *   - `'preview'` (default): coalesces by `draftId` so the latest debounced
   *     rebuild wins — successive PATCH-driven rebuilds drop stale work.
   *   - `'install'`: coalesces by `${draftId}:install` so an explicit
   *     install-commit is NOT aborted by a debounced preview rebuild
   *     that happens to fire while tsc is still running. Without this
   *     separation an install kicked off right after a spec patch
   *     (e.g. the version-bump retry path in InstallDiffModal) raced
   *     the 2s-debounced rebuild and surfaced as
   *     `builder.build_failed.abort` (reason=abort, exit=null).
   */
  kind?: 'preview' | 'install';
}

export interface PipelineRunResult {
  draft: Draft;
  buildResult: BuildResult;
  /** Monotonic per-pipeline-instance counter; surfaced in staging-dir name
   *  and used as `rev` for preview-cache invalidation. */
  buildN: number;
}

export class BuildPipelineError extends Error {
  readonly code:
    | 'draft_not_found'
    | 'spec_invalid'
    | 'codegen_failed'
    | 'staging_failed';
  override readonly cause?: unknown;
  constructor(
    code: BuildPipelineError['code'],
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'BuildPipelineError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

export class BuildPipeline {
  private buildCounter = 0;
  private readonly draftStore: DraftStore;
  private readonly buildQueue: BuildQueue;
  private readonly templateRoot: string;
  private readonly stagingBaseDir: string | undefined;
  private readonly buildTimeoutMs: number | undefined;
  private readonly runSandbox: NonNullable<BuildPipelineDeps['buildSandbox']>;
  private readonly templateReady: Promise<void> | undefined;
  private readonly log: (...args: unknown[]) => void;

  constructor(deps: BuildPipelineDeps) {
    this.draftStore = deps.draftStore;
    this.buildQueue = deps.buildQueue;
    this.templateRoot = deps.templateRoot;
    this.stagingBaseDir = deps.stagingBaseDir;
    this.buildTimeoutMs = deps.buildTimeoutMs;
    this.runSandbox = deps.buildSandbox ?? defaultRunSandbox;
    this.templateReady = deps.templateReady;
    this.log = deps.logger ?? (() => {});
  }

  async run(opts: PipelineRunOptions): Promise<PipelineRunResult> {
    const draft = await this.draftStore.load(opts.userEmail, opts.draftId);
    if (!draft) {
      throw new BuildPipelineError(
        'draft_not_found',
        `BuildPipeline: draft '${opts.draftId}' not found for user '${opts.userEmail}'`,
      );
    }

    let spec;
    try {
      spec = parseAgentSpec(draft.spec);
    } catch (err) {
      throw new BuildPipelineError(
        'spec_invalid',
        `BuildPipeline: draft '${opts.draftId}' spec failed Zod validation`,
        err,
      );
    }

    let files: Map<string, Buffer>;
    try {
      files = await generate({ spec, slots: draft.slots });
    } catch (err) {
      if (err instanceof CodegenError) {
        throw new BuildPipelineError(
          'codegen_failed',
          `BuildPipeline: codegen failed (${String(err.issues.length)} issue(s))`,
          err,
        );
      }
      throw err;
    }

    // Phase 3 (OB-67): emit `AGENT.md` alongside the generated source.
    // The frontmatter carries `quality:` and `persona:` blocks so the
    // runtime `loadSystemPrompt` can splice them into the system prompt.
    // Without this file the persona/quality slider settings would never
    // reach the LLM — they'd live only in the Builder draft state.
    files.set(
      'AGENT.md',
      specToAgentMd({
        draftId: opts.draftId,
        draftName: draft.name,
        spec: draft.spec,
      }),
    );

    const buildN = ++this.buildCounter;

    if (this.templateReady) {
      await this.templateReady;
    }

    let stagingDir: string;
    try {
      stagingDir = await prepareStagingDir({
        templateRoot: this.templateRoot,
        draftId: opts.draftId,
        buildN,
        files,
        ...(this.stagingBaseDir !== undefined
          ? { stagingBaseDir: this.stagingBaseDir }
          : {}),
      });
    } catch (err) {
      throw new BuildPipelineError(
        'staging_failed',
        `BuildPipeline: prepareStagingDir failed for draft '${opts.draftId}' (buildN=${String(buildN)})`,
        err,
      );
    }

    const kind = opts.kind ?? 'preview';
    const coalesceKey =
      kind === 'install' ? `${opts.draftId}:install` : opts.draftId;

    try {
      const buildResult = await this.buildQueue.enqueue(
        opts.draftId,
        async (signal: AbortSignal) =>
          this.runSandbox({
            stagingDir,
            signal,
            ...(this.buildTimeoutMs !== undefined
              ? { timeoutMs: this.buildTimeoutMs }
              : {}),
          }),
        { coalesceKey },
      );
      this.log(
        `[build-pipeline] draft=${opts.draftId} buildN=${String(buildN)} ok=${String(buildResult.ok)} reason=${buildResult.ok ? 'ok' : buildResult.reason} duration_ms=${String(buildResult.durationMs)}`,
      );
      return { draft, buildResult, buildN };
    } finally {
      // Best-effort cleanup. We do NOT want a failed cleanup to mask the
      // build error path — staging dirs are isolated by name+ts so leftover
      // dirs are merely disk-noise, never a correctness issue.
      try {
        await cleanupStagingDir(stagingDir);
      } catch (err) {
        this.log(
          `[build-pipeline] cleanup failed for staging=${stagingDir}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}

function defaultRunSandbox(opts: {
  stagingDir: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<BuildResult> {
  return runBuildSandbox({
    stagingDir: opts.stagingDir,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
}
