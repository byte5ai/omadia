import type { DraftStore } from './draftStore.js';
import { BuildPipelineError, type BuildPipeline } from './buildPipeline.js';
import { CodegenError } from './codegen.js';
import type {
  IngestResult,
  PackageUploadService,
} from '../packageUploadService.js';

/**
 * Install-Commit Orchestrator (B.6-1).
 *
 * Drives the end-to-end install pipeline for a builder draft:
 *
 *   1. `BuildPipeline.run()` → loads draft, runs codegen, runs sandbox build.
 *   2. On build success, hands the resulting zip buffer to
 *      `PackageUploadService.ingest()` for manifest validation, peer-resolve,
 *      and atomic move into the packages directory.
 *   3. On ingest success, marks the draft `status='installed'` and pins the
 *      `installedAgentId` so the dashboard / store-UI can deep-link back to
 *      the source draft (Edit-from-Store flow, B.6-3).
 *
 * Returns a discriminated union — the route layer maps `reason` → HTTP status
 * (404 / 409 / 413 / 422 / 500). No HTTP semantics live in this module so it
 * stays unit-testable with fake deps.
 */

export interface InstallDraftDeps {
  draftStore: DraftStore;
  buildPipeline: BuildPipeline;
  packageUploadService: PackageUploadService;
  log?: (line: string) => void;
}

export interface InstallDraftInput {
  userEmail: string;
  draftId: string;
}

export type InstallFailureReason =
  | 'draft_not_found'
  | 'spec_invalid'
  | 'codegen_failed'
  | 'pipeline_failed'
  | 'build_failed'
  | 'conflict'
  | 'too_large'
  | 'manifest_invalid'
  | 'ingest_failed';

export interface InstallSuccess {
  ok: true;
  installedAgentId: string;
  version: string;
  packageBytes: number;
}

export interface InstallFailure {
  ok: false;
  reason: InstallFailureReason;
  code: string;
  message: string;
  details?: unknown;
}

export type InstallResult = InstallSuccess | InstallFailure;

const CONFLICT_INGEST_CODES = new Set<string>([
  'package.id_conflict_builtin',
  'package.duplicate_version',
]);

const TOO_LARGE_INGEST_CODES = new Set<string>(['package.too_large']);

const MANIFEST_INVALID_INGEST_CODES = new Set<string>([
  'package.manifest_missing',
  'package.manifest_invalid',
  'package.id_mismatch',
  'package.version_mismatch',
  'package.entry_missing',
  'package.package_json_invalid',
  'package.zip_too_many_entries',
  'package.zip_too_large',
  'package.zip_unsafe_path',
]);

export async function installDraft(
  input: InstallDraftInput,
  deps: InstallDraftDeps,
): Promise<InstallResult> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const { userEmail, draftId } = input;

  // Step 1: build pipeline (load draft → codegen → sandbox).
  let pipelineResult;
  try {
    pipelineResult = await deps.buildPipeline.run({ userEmail, draftId });
  } catch (err) {
    if (err instanceof BuildPipelineError) {
      return mapPipelineError(err);
    }
    throw err;
  }

  // Step 2: build sandbox failure.
  if (!pipelineResult.buildResult.ok) {
    const fail = pipelineResult.buildResult;
    return {
      ok: false,
      reason: 'build_failed',
      code: `builder.build_failed.${fail.reason}`,
      message: `tsc/build failed (reason=${fail.reason}, exit=${
        fail.exitCode === null ? 'null' : String(fail.exitCode)
      })`,
      details: {
        errors: fail.errors,
        exitCode: fail.exitCode,
        stderrTail: fail.stderrTail,
        stdoutTail: fail.stdoutTail,
      },
    };
  }

  // Step 3: ingest into PackageUploadService.
  const success = pipelineResult.buildResult;
  const draft = pipelineResult.draft;
  const filename = buildOriginalFilename(draft);

  let ingestResult: IngestResult;
  try {
    ingestResult = await deps.packageUploadService.ingest({
      fileBuffer: success.zip,
      originalFilename: filename,
      uploadedBy: userEmail,
    });
  } catch (err) {
    log(
      `[install] draft=${draftId} ingest threw unexpectedly: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return {
      ok: false,
      reason: 'ingest_failed',
      code: 'builder.ingest_threw',
      message: err instanceof Error ? err.message : String(err),
    };
  }

  if (!ingestResult.ok) {
    return mapIngestFailure(ingestResult);
  }

  // Step 4: mark draft as installed + pin installed_agent_id.
  await deps.draftStore.update(userEmail, draftId, {
    status: 'installed',
    installedAgentId: ingestResult.plugin_id,
  });

  log(
    `[install] draft=${draftId} ok plugin=${ingestResult.plugin_id} version=${ingestResult.version} bytes=${String(
      ingestResult.package.zip_bytes,
    )}`,
  );

  return {
    ok: true,
    installedAgentId: ingestResult.plugin_id,
    version: ingestResult.version,
    packageBytes: ingestResult.package.zip_bytes,
  };
}

// ---------------------------------------------------------------------------

function mapPipelineError(err: BuildPipelineError): InstallFailure {
  const reason: InstallFailureReason =
    err.code === 'draft_not_found'
      ? 'draft_not_found'
      : err.code === 'spec_invalid'
        ? 'spec_invalid'
        : err.code === 'codegen_failed'
          ? 'codegen_failed'
          : 'pipeline_failed';

  const failure: InstallFailure = {
    ok: false,
    reason,
    code: `builder.${err.code}`,
    message: err.message,
  };

  if (err.cause instanceof CodegenError) {
    failure.details = { issues: err.cause.issues };
  } else if (err.cause !== undefined) {
    failure.details = serializeCause(err.cause);
  }
  return failure;
}

function mapIngestFailure(failure: {
  ok: false;
  code: string;
  message: string;
  details?: unknown;
}): InstallFailure {
  let reason: InstallFailureReason;
  if (CONFLICT_INGEST_CODES.has(failure.code)) {
    reason = 'conflict';
  } else if (TOO_LARGE_INGEST_CODES.has(failure.code)) {
    reason = 'too_large';
  } else if (MANIFEST_INVALID_INGEST_CODES.has(failure.code)) {
    reason = 'manifest_invalid';
  } else {
    reason = 'ingest_failed';
  }

  const out: InstallFailure = {
    ok: false,
    reason,
    code: failure.code,
    message: failure.message,
  };
  if (failure.details !== undefined) out.details = failure.details;
  return out;
}

function buildOriginalFilename(draft: {
  id: string;
  spec: unknown;
}): string {
  const spec = draft.spec as { id?: unknown; version?: unknown } | null;
  const id =
    spec && typeof spec.id === 'string' && spec.id.length > 0
      ? spec.id
      : draft.id;
  const version =
    spec && typeof spec.version === 'string' && spec.version.length > 0
      ? spec.version
      : '0.0.0';
  // Sanitise — packageUploadService is permissive but we want stable filenames
  // for logs / staging.
  const safeId = id.replace(/[^A-Za-z0-9_.-]/g, '_');
  const safeVersion = version.replace(/[^A-Za-z0-9_.+-]/g, '_');
  return `${safeId}-${safeVersion}.zip`;
}

function serializeCause(cause: unknown): unknown {
  if (cause instanceof Error) {
    return { name: cause.name, message: cause.message };
  }
  return cause;
}
