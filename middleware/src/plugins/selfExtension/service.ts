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
import type { ExtensionStore } from './extensionStore.js';

export interface SelfExtensionServiceDeps {
  gate: OperatorGate;
  /** Spec path (Builder plugins). */
  draftStore?: DraftStore;
  buildPipeline?: BuildPipeline;
  packageUploadService?: PackageUploadService;
  /** Template path (standalone plugins). */
  extensionStore?: ExtensionStore;
  /** Deactivate→activate the plugin so it re-materialises its approved
   *  extensions (template path). Wired to ToolPluginRuntime reactivation. */
  reactivate?: (pluginId: string) => Promise<void>;
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
  | { ok: true; kind: 'spec'; install: Extract<InstallResult, { ok: true }> }
  | { ok: true; kind: 'template'; pluginId: string; templateId: string }
  | {
      ok: false;
      stage: 'precondition' | 'install';
      message: string;
      install?: Extract<InstallResult, { ok: false }>;
    };

/**
 * Materialise an approved proposal. Branches on the proposal kind:
 *   - `spec` → drive the existing Builder install pipeline (codegen → build →
 *     ingest → reactivate).
 *   - `template` → persist the approved {templateId, params} in the
 *     ExtensionStore and reactivate, so the standalone plugin re-runs its own
 *     `selfExtend.apply()` and registers the new tool. No codegen, no package
 *     write — the plugin materialises within its own capability scope.
 *
 * Idempotency / re-entry is the caller's concern — the gate's status machine
 * rejects a second install of a record past `approved`.
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
  if (record.status !== 'approved') {
    return {
      ok: false,
      stage: 'precondition',
      message: `proposal '${input.proposalId}' is '${record.status}', expected 'approved'`,
    };
  }

  // ── Template path ────────────────────────────────────────────────────────
  if (record.kind === 'template') {
    if (!record.approvedExtension) {
      return { ok: false, stage: 'precondition', message: 'approved template proposal has no approvedExtension' };
    }
    if (!deps.extensionStore || !deps.reactivate) {
      return { ok: false, stage: 'precondition', message: 'template materialisation needs extensionStore + reactivate deps' };
    }
    try {
      await deps.extensionStore.add(record.pluginId, record.approvedExtension);
      await deps.reactivate(record.pluginId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.gate.markFailed(record.id, message);
      log(`[self-extension] template materialise FAILED for ${record.id}: ${message}`);
      return { ok: false, stage: 'install', message };
    }
    deps.gate.markInstalled(record.id, `template:${record.approvedExtension.templateId}`);
    log(`[self-extension] applied template ${record.approvedExtension.templateId} to ${record.pluginId}`);
    return { ok: true, kind: 'template', pluginId: record.pluginId, templateId: record.approvedExtension.templateId };
  }

  // ── Spec path ────────────────────────────────────────────────────────────
  if (!record.approvedSpec) {
    return { ok: false, stage: 'precondition', message: 'approved spec proposal has no approvedSpec' };
  }
  if (!deps.draftStore || !deps.buildPipeline || !deps.packageUploadService) {
    return { ok: false, stage: 'precondition', message: 'spec materialisation needs draftStore + buildPipeline + packageUploadService deps' };
  }

  const { draftStore, buildPipeline, packageUploadService } = deps;
  const spec = record.approvedSpec;
  const draft = await draftStore.create(input.userEmail, input.draftName ?? spec.name);
  await draftStore.update(input.userEmail, draft.id, {
    spec,
    slots: spec.slots,
  });
  log(`[self-extension] materialising proposal ${record.id} via draft ${draft.id}`);

  const installDeps: InstallDraftDeps = {
    draftStore,
    buildPipeline,
    packageUploadService,
  };
  const result = await installDraft(
    { userEmail: input.userEmail, draftId: draft.id },
    installDeps,
  );

  if (result.ok) {
    deps.gate.markInstalled(record.id, result.version);
    log(`[self-extension] installed ${result.publishedAgentId}@${result.version}`);
    return { ok: true, kind: 'spec', install: result };
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
