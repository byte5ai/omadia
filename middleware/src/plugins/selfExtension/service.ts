/**
 * Plugin self-extension — materialisation service.
 *
 * Takes an APPROVED proposal and drives it through the EXISTING Builder install
 * pipeline rather than re-inventing codegen/build/ingest:
 *
 *   approved spec ─▶ DraftStore.create + update(spec)
 *                 ─▶ installDraft()  [codegen → typecheck → build → ingest]
 *                 ─▶ PackageUploadService.onPackageReady → runtime reactivate
 *
 * The reactivation seam is the upload service's `onPackageReady(agentId)` hook
 * (wired to `ToolPluginRuntime.reactivate` in the app boot) — re-using it means
 * a self-extension lands exactly like an operator upload: same gates, same
 * circuit-breaker, same versioned store. The guardrail-inviolability invariant
 * holds for free: the new tools run through the same per-call privacy/data-plane
 * path as every other tool, with no privileged bypass.
 *
 * Install outcome is reflected back onto the proposal record (installed /
 * install_failed) and into the audit trail.
 */

import {
  installDraft,
  type InstallDraftDeps,
  type InstallResult,
} from '../builder/installCommit.js';
import type { DraftStore } from '../builder/draftStore.js';
import type { BuildPipeline } from '../builder/buildPipeline.js';
import type { PackageUploadService } from '../packageUploadService.js';
import type { OperatorGate } from './operatorGate.js';

export interface SelfExtensionServiceDeps {
  gate: OperatorGate;
  draftStore: DraftStore;
  buildPipeline: BuildPipeline;
  packageUploadService: PackageUploadService;
  log?: (line: string) => void;
}

export interface MaterializeInput {
  proposalId: string;
  /** Operator on whose behalf the draft is created + installed. */
  userEmail: string;
  /** Optional draft name; defaults to the spec name. */
  draftName?: string;
}

export type MaterializeResult =
  | { ok: true; install: Extract<InstallResult, { ok: true }> }
  | {
      ok: false;
      stage: 'precondition' | 'install';
      message: string;
      install?: Extract<InstallResult, { ok: false }>;
    };

/**
 * Materialise an approved proposal. Idempotency / re-entry is the caller's
 * concern — the operator gate's status machine rejects a second install of a
 * record that already moved past `approved`.
 */
export async function materializeApprovedProposal(
  input: MaterializeInput,
  deps: SelfExtensionServiceDeps,
): Promise<MaterializeResult> {
  const log = deps.log ?? (() => {});
  const record = deps.gate.get(input.proposalId);
  if (!record) {
    return { ok: false, stage: 'precondition', message: `proposal '${input.proposalId}' not found` };
  }
  if (record.status !== 'approved' || !record.approvedSpec) {
    return {
      ok: false,
      stage: 'precondition',
      message: `proposal '${input.proposalId}' is '${record.status}', expected 'approved'`,
    };
  }

  const spec = record.approvedSpec;
  const draft = await deps.draftStore.create(input.userEmail, input.draftName ?? spec.name);
  await deps.draftStore.update(input.userEmail, draft.id, {
    spec,
    slots: spec.slots,
  });
  log(`[self-extension] materialising proposal ${record.id} via draft ${draft.id}`);

  const installDeps: InstallDraftDeps = {
    draftStore: deps.draftStore,
    buildPipeline: deps.buildPipeline,
    packageUploadService: deps.packageUploadService,
  };
  const result = await installDraft(
    { userEmail: input.userEmail, draftId: draft.id },
    installDeps,
  );

  if (result.ok) {
    deps.gate.markInstalled(record.id, result.version);
    log(`[self-extension] installed ${result.publishedAgentId}@${result.version}`);
    return { ok: true, install: result };
  }

  deps.gate.markFailed(record.id, `${result.code}: ${result.message}`);
  log(`[self-extension] install FAILED for ${record.id}: ${result.code} ${result.message}`);
  return {
    ok: false,
    stage: 'install',
    message: `${result.code}: ${result.message}`,
    install: result,
  };
}
