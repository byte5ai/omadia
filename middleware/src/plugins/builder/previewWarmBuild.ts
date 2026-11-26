/**
 * The one way to build and warm a Builder preview with live build status
 * (#1730/#1731/#1733/#1807/#1809).
 *
 * WHY
 * ---
 * The auto-rebuild scheduler (`index.ts`) and the preview routes
 * (`routes/builderPreview.ts`) each had their own copy of "build, emit
 * `build_status`, activate". The copies drifted: failed events carried no
 * `buildN` (AutoFix dedup collapsed every failure onto key 0), the scheduler
 * re-emitted a second `failed` carrying its log line — user e-mail and draft
 * id — over the structured error list, `building` was emitted before a cache
 * hit that then never emitted `ok`, and a missing test credential at
 * activation turned into a failed build.
 *
 * RULES
 *  - `building` is emitted only when a build actually starts (cache miss).
 *  - Every failure is emitted exactly once, here, with a stable code as
 *    `reason` and the build number when one exists. The thrown error is
 *    marked as reported; callers must not emit again
 *    (`isBuildStatusReported`).
 *  - A setup value without a test credential is not a failed build: the
 *    `ok` stands, re-emitted with `missingSetupKey` and recorded on the
 *    pipeline so a reload still knows.
 *  - An activation failure after a green build is `failed` with
 *    `activate_failed:<code>` (`classifyActivationError`). The message —
 *    plugin text and server paths — stays server-side: logged, and recorded
 *    on the pipeline for the builder agent's `get_build_status`.
 *  - A result for a build that a newer one already superseded is recorded
 *    nowhere and emitted nowhere: the latest event must stay the truth.
 *
 * Contract: ADR-0230.
 */

import {
  BuildPipelineError,
  type BuildPipeline,
  type PipelineRunResult,
} from './buildPipeline.js';
import { classifyActivationError } from '../activationFailure.js';
import type { BuildFailure, BuildSuccess } from './buildSandbox.js';
import { CodegenError } from './codegen.js';
import type { PreviewCache } from './previewCache.js';
import type { PreviewHandle } from './previewRuntime.js';
import { PreviewSetupValueMissingError } from './previewRuntime.js';
import type { PreviewSecretBuffer } from './previewSecretBuffer.js';
import type { SpecEventBus } from './specEventBus.js';

/** SSE frame budget: the editor only needs the visible failures. */
const MAX_WIRE_ERRORS = 50;
/** Activation messages are plugin text; keep the recorded reason bounded. */
const MAX_ACTIVATE_REASON_CHARS = 300;

export interface WarmPreviewDeps {
  readonly previewCache: PreviewCache;
  readonly buildPipeline: BuildPipeline;
  readonly previewSecretBuffer: PreviewSecretBuffer;
  readonly bus: SpecEventBus;
  /** Diagnostic sink for failed builds and activations. */
  readonly log?: (line: string) => void;
  /** Names the caller in log lines (`auto-rebuild`, `preview`). */
  readonly logTag?: string;
}

export interface WarmPreviewOptions {
  readonly userEmail: string;
  readonly draftId: string;
}

const reported = new WeakSet<object>();

function markReported<T>(err: T): T {
  if (typeof err === 'object' && err !== null) reported.add(err);
  return err;
}

/** True when `warmPreview` already emitted the `build_status` for `err`. */
export function isBuildStatusReported(err: unknown): boolean {
  return typeof err === 'object' && err !== null && reported.has(err);
}

/**
 * A setup value the preview read without a test credential. Matches the
 * preview's own error and the plugin-api classes by `name` (a draft may
 * rethrow its own copy); returns the key when known.
 */
export function missingSetupValueKey(err: unknown): string | null {
  if (err instanceof PreviewSetupValueMissingError) return err.key;
  if (typeof err !== 'object' || err === null) return null;
  const name = (err as { name?: unknown }).name;
  if (name !== 'MissingSecretError' && name !== 'MissingConfigError') return null;
  // Without a key the operator could never satisfy it: an activation failure.
  const key = (err as { key?: unknown }).key;
  return typeof key === 'string' && key.length > 0 ? key : null;
}

/**
 * Returns the warm preview handle, building and activating it on a cache
 * miss. Emits the build status on the draft's bus; see the module rules.
 */
export async function warmPreview(
  deps: WarmPreviewDeps,
  opts: WarmPreviewOptions,
): Promise<PreviewHandle> {
  const { userEmail, draftId } = opts;
  let builtN: number | undefined;
  try {
    return await deps.previewCache.ensureWarm({
      userEmail,
      draftId,
      build: async () => {
        deps.bus.emit(draftId, { type: 'build_status', phase: 'building' });
        const result = await runBuild(deps, opts);
        await deps.previewSecretBuffer.warm(userEmail, draftId);
        builtN = result.buildN;
        deps.bus.emit(draftId, {
          type: 'build_status',
          phase: 'ok',
          buildN: result.buildN,
        });
        const { configValues, secretValues } = splitBufferByFieldType(
          deps.previewSecretBuffer.get(userEmail, draftId),
          result.draft.spec.setup_fields ?? [],
        );
        return {
          zipBuffer: result.buildResult.zip,
          rev: result.buildN,
          configValues,
          secretValues,
        };
      },
    });
  } catch (err) {
    if (isBuildStatusReported(err)) throw err;
    reportActivationFailure(deps, draftId, builtN, err);
    throw markReported(err);
  }
}

type SuccessfulRun = PipelineRunResult & { buildResult: BuildSuccess };

async function runBuild(
  deps: WarmPreviewDeps,
  opts: WarmPreviewOptions,
): Promise<SuccessfulRun> {
  const { draftId } = opts;
  let result: PipelineRunResult;
  try {
    result = await deps.buildPipeline.run(opts);
  } catch (err) {
    const pipelineErr = err instanceof BuildPipelineError ? err : null;
    deps.bus.emit(draftId, {
      type: 'build_status',
      phase: 'failed',
      ...(pipelineErr?.buildN !== undefined ? { buildN: pipelineErr.buildN } : {}),
      reason: pipelineErr ? pipelineErr.code : 'build_error',
      ...codegenIssueCount(err),
    });
    throw markReported(err);
  }
  const br = result.buildResult;
  if (br.ok) return { ...result, buildResult: br };

  logFailedBuild(deps, draftId, br);
  deps.bus.emit(draftId, {
    type: 'build_status',
    phase: 'failed',
    buildN: result.buildN,
    reason: br.reason,
    errorCount: br.errors.length,
    errors: br.errors.slice(0, MAX_WIRE_ERRORS).map((e) => ({
      file: e.path,
      line: e.line,
      column: e.col,
      code: e.code,
      message: e.message,
    })),
  });
  throw markReported(
    new BuildPipelineError(
      'codegen_failed',
      `preview build failed: ${br.reason}`,
      br,
    ),
  );
}

function codegenIssueCount(err: unknown): { errorCount?: number } {
  if (err instanceof BuildPipelineError && err.cause instanceof CodegenError) {
    return { errorCount: err.cause.issues.length };
  }
  return {};
}

function reportActivationFailure(
  deps: WarmPreviewDeps,
  draftId: string,
  builtN: number | undefined,
  err: unknown,
): void {
  const message = err instanceof Error ? err.message : String(err);
  const log = deps.log ?? ((line: string) => console.log(line));
  const tag = deps.logTag ?? 'preview';
  if (builtN === undefined) {
    // The build never got to `ok` (e.g. the test-credential vault read).
    log(`[builder] ${tag} preparation failed draft=${draftId}: ${message}`);
    deps.bus.emit(draftId, { type: 'build_status', phase: 'failed', reason: 'preview_failed' });
    return;
  }
  if (deps.buildPipeline.hasNewerBuild(draftId, builtN)) {
    log(`[builder] ${tag} stale activation result for build ${String(builtN)} dropped draft=${draftId}`);
    return;
  }
  const missingKey = missingSetupValueKey(err);
  if (missingKey !== null) {
    deps.buildPipeline.recordMissingSetupValue(draftId, builtN, missingKey);
    deps.bus.emit(draftId, {
      type: 'build_status',
      phase: 'ok',
      buildN: builtN,
      missingSetupKey: missingKey,
    });
    return;
  }
  log(`[builder] ${tag} activation failed build=${String(builtN)} draft=${draftId}: ${message}`);
  deps.buildPipeline.recordActivationFailure(
    draftId,
    builtN,
    `activate_failed: ${message}`.slice(0, MAX_ACTIVATE_REASON_CHARS),
  );
  deps.bus.emit(draftId, {
    type: 'build_status',
    phase: 'failed',
    buildN: builtN,
    reason: `activate_failed:${classifyActivationError(err)}`,
  });
}

function logFailedBuild(
  deps: WarmPreviewDeps,
  draftId: string,
  br: BuildFailure,
): void {
  const log = deps.log ?? ((line: string) => console.log(line));
  const tag = deps.logTag ?? 'preview';
  log(
    `[builder] ${tag} build failed reason=${br.reason} ` +
      `exit=${String(br.exitCode)} errors=${String(br.errors.length)} draft=${draftId}`,
  );
  if (br.stdoutTail) log(`[builder] ${tag} stdout-tail draft=${draftId}:\n${br.stdoutTail}`);
  if (br.stderrTail) log(`[builder] ${tag} stderr-tail draft=${draftId}:\n${br.stderrTail}`);
}

/**
 * Splits the PreviewSecretBuffer's flat key→value map into the two runtime
 * channels by each setup_field's declared type. Keys not in the spec are
 * dropped (a stale entry after a spec change).
 */
export function splitBufferByFieldType(
  bufferValues: Readonly<Record<string, string>>,
  setupFields: ReadonlyArray<unknown>,
): {
  configValues: Readonly<Record<string, unknown>>;
  secretValues: Readonly<Record<string, string>>;
} {
  const fieldByKey = new Map<string, string>();
  for (const raw of setupFields) {
    if (!raw || typeof raw !== 'object') continue;
    const f = raw as { key?: unknown; type?: unknown };
    if (typeof f.key !== 'string') continue;
    fieldByKey.set(f.key, typeof f.type === 'string' ? f.type : 'string');
  }
  const configValues: Record<string, unknown> = {};
  const secretValues: Record<string, string> = {};
  for (const [key, value] of Object.entries(bufferValues)) {
    const declaredType = fieldByKey.get(key);
    if (declaredType === undefined) continue;
    if (declaredType === 'secret' || declaredType === 'oauth') secretValues[key] = value;
    else configValues[key] = value;
  }
  return { configValues, secretValues };
}
