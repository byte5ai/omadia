/**
 * Plugin self-extension — the operator gate.
 *
 * Owns the lifecycle of a proposal AFTER the escalation guard has run:
 *
 *   submit ─▶ (guard) ─▶ pending ─▶ approve ─▶ approved ─▶ installed
 *                   └─▶ denied (escalation / invalid)        └▶ install_failed
 *
 * Two invariants live here:
 *
 *   - An escalating or invalid proposal is recorded as `denied` immediately on
 *     submit — it never reaches `pending`, so no `approve` call can resurrect
 *     it (the guard verdict is the floor).
 *
 *   - On `approve`, the operator may attach NARROWING patches. The narrowed
 *     spec is re-checked: it must be a subset of the *proposed* surface (the
 *     operator can only subtract). A narrowing that widens anything is
 *     rejected with {@link NarrowingWidensError}. The operator can tighten, the
 *     operator can never grant.
 *
 * Storage is in-memory + injectable clock/id for deterministic tests; an
 * {@link SelfExtensionAudit} mirror records every transition.
 */

import { randomUUID } from 'node:crypto';

import type { ApprovedExtension, ExtensionTemplate } from '@omadia/plugin-api';

import { applySpecPatches, type JsonPatch } from '../builder/specPatcher.js';
import type { AgentSpec } from '../builder/agentSpec.js';
import type { Plugin } from '../../api/admin-v1.js';
import {
  computeWidenings,
  extractPermissionSurface,
  type SurfaceWidening,
} from './permissionSurface.js';
import {
  evaluateProposal,
  evaluateTemplateProposal,
  type ProposalEvaluation,
} from './escalationGuard.js';
import type { ExtensionProposal, TemplateProposal } from './extensionProposal.js';
import { SelfExtensionAudit } from './audit.js';

export type ProposalKind = 'spec' | 'template';

export type ProposalStatus =
  | 'pending'
  | 'denied'
  | 'approved'
  | 'installed'
  | 'install_failed';

export interface ProposalRecord {
  readonly id: string;
  readonly pluginId: string;
  /** `spec` = Builder-authored plugin (patch path); `template` = standalone
   *  plugin extending itself via its `selfExtend` SDK contract. */
  readonly kind: ProposalKind;
  readonly proposal: ExtensionProposal | TemplateProposal;
  readonly evaluation: ProposalEvaluation;
  readonly submittedBy: string;
  readonly createdAt: number;
  status: ProposalStatus;
  /** Live spec at submit time (spec path only) — kept so `approve` can re-check
   *  narrowing. */
  readonly currentSpec?: AgentSpec;
  decidedBy?: string;
  decidedAt?: number;
  denialReason?: string;
  /** The spec the operator approved (spec path; proposed spec, possibly
   *  narrowed). */
  approvedSpec?: AgentSpec;
  /** Narrowing patches the operator attached, if any (spec path). */
  narrowingPatches?: readonly JsonPatch[];
  /** The approved {templateId, params} the plugin will materialise on the next
   *  activation (template path). */
  approvedExtension?: ApprovedExtension;
  installFailureReason?: string;
}

/** Raised when operator-supplied narrowing patches would WIDEN the surface
 *  (vs. the proposal) instead of tightening it. */
export class NarrowingWidensError extends Error {
  readonly widenings: readonly SurfaceWidening[];
  constructor(widenings: readonly SurfaceWidening[]) {
    super(
      `narrowing patches widen the privilege surface: ${widenings
        .map((w) => `${w.dimension}:${w.item}`)
        .join(', ')}`,
    );
    this.name = 'NarrowingWidensError';
    this.widenings = widenings;
  }
}

export class ProposalNotFoundError extends Error {
  constructor(id: string) {
    super(`self-extension proposal '${id}' not found`);
    this.name = 'ProposalNotFoundError';
  }
}

export class IllegalProposalTransitionError extends Error {
  constructor(id: string, from: ProposalStatus, action: string) {
    super(`cannot ${action} proposal '${id}' in status '${from}'`);
    this.name = 'IllegalProposalTransitionError';
  }
}

export interface OperatorGateOptions {
  now?: () => number;
  genId?: () => string;
  audit?: SelfExtensionAudit;
}

/** Spec-path submit (Builder plugins). `kind` optional + defaults to `spec`
 *  so existing callers stay unchanged. */
export interface SubmitSpecInput {
  kind?: 'spec';
  pluginId: string;
  currentSpec: AgentSpec;
  proposal: ExtensionProposal;
  submittedBy: string;
}

/** Template-path submit (standalone plugins via the selfExtend SDK). */
export interface SubmitTemplateInput {
  kind: 'template';
  pluginId: string;
  plugin: Plugin;
  template: ExtensionTemplate | undefined;
  proposal: TemplateProposal;
  submittedBy: string;
}

export type SubmitInput = SubmitSpecInput | SubmitTemplateInput;

export interface ApproveInput {
  id: string;
  decidedBy: string;
  /** Optional patches that may only TIGHTEN the approved surface. */
  narrowingPatches?: readonly JsonPatch[];
}

export class OperatorGate {
  private readonly records = new Map<string, ProposalRecord>();
  private readonly now: () => number;
  private readonly genId: () => string;
  private readonly audit: SelfExtensionAudit;

  constructor(opts: OperatorGateOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.genId = opts.genId ?? (() => randomUUID());
    this.audit = opts.audit ?? new SelfExtensionAudit({ now: this.now });
  }

  /** Submit a proposal. Runs the guard; an escalating/invalid proposal lands
   *  as `denied` and can never be approved. */
  submit(input: SubmitInput): ProposalRecord {
    const kind: ProposalKind = input.kind === 'template' ? 'template' : 'spec';
    const evaluation =
      input.kind === 'template'
        ? evaluateTemplateProposal(input.plugin, input.template, input.proposal)
        : evaluateProposal(input.currentSpec, input.proposal);
    const id = this.genId();
    const createdAt = this.now();

    const denied =
      evaluation.decision === 'denied_escalation' ||
      evaluation.decision === 'invalid_spec';

    const record: ProposalRecord = {
      id,
      pluginId: input.pluginId,
      kind,
      proposal: input.proposal,
      evaluation,
      submittedBy: input.submittedBy,
      createdAt,
      ...(input.kind === 'template' ? {} : { currentSpec: input.currentSpec }),
      status: denied ? 'denied' : 'pending',
      ...(denied
        ? {
            denialReason:
              evaluation.decision === 'denied_escalation'
                ? 'privilege escalation'
                : (evaluation.invalidReason ?? 'invalid spec'),
            decidedAt: createdAt,
            decidedBy: 'system:escalation-guard',
          }
        : {}),
    };
    this.records.set(id, record);

    this.audit.record({
      type: 'proposed',
      pluginId: input.pluginId,
      proposalId: id,
      actor: input.submittedBy,
      detail: input.proposal.rationale,
    });
    if (denied) {
      this.audit.record({
        type:
          evaluation.decision === 'denied_escalation'
            ? 'denied_escalation'
            : 'invalid_spec',
        pluginId: input.pluginId,
        proposalId: id,
        actor: 'system:escalation-guard',
        detail: record.denialReason ?? '',
        ...(evaluation.escalations.length
          ? { escalations: evaluation.escalations }
          : {}),
      });
    }
    return record;
  }

  /** Operator approves, optionally narrowing. Throws on illegal transition or
   *  a widening narrowing. */
  approve(input: ApproveInput): ProposalRecord {
    const record = this.require(input.id);
    if (record.status !== 'pending') {
      throw new IllegalProposalTransitionError(input.id, record.status, 'approve');
    }

    // Template path: no spec to narrow. The approved {templateId, params} is
    // the artifact the plugin re-materialises on activation. Params cannot
    // widen the manifest surface, so there is nothing further to gate here.
    if (record.kind === 'template') {
      const proposal = record.proposal as TemplateProposal;
      record.approvedExtension = {
        templateId: proposal.templateId,
        params: proposal.params,
      };
      record.status = 'approved';
      record.decidedBy = input.decidedBy;
      record.decidedAt = this.now();
      this.audit.record({
        type: 'approved',
        pluginId: record.pluginId,
        proposalId: record.id,
        actor: input.decidedBy,
        detail: record.proposal.rationale,
      });
      return record;
    }

    const proposedSpec = record.evaluation.proposedSpec;
    const proposedSurface = record.evaluation.proposedSurface;
    if (!proposedSpec || !proposedSurface) {
      // Defensive — a pending record always carries both.
      throw new IllegalProposalTransitionError(input.id, record.status, 'approve');
    }

    let approvedSpec = proposedSpec;
    if (input.narrowingPatches && input.narrowingPatches.length > 0) {
      const { spec: narrowedSpec } = applySpecPatches(
        proposedSpec,
        input.narrowingPatches,
      );
      const narrowedSurface = extractPermissionSurface(narrowedSpec);
      // Narrowing may only subtract: narrowed ⊆ proposed.
      const widenings = computeWidenings(proposedSurface, narrowedSurface);
      if (widenings.length > 0) {
        throw new NarrowingWidensError(widenings);
      }
      approvedSpec = narrowedSpec;
      record.narrowingPatches = input.narrowingPatches;
      this.audit.record({
        type: 'narrowed',
        pluginId: record.pluginId,
        proposalId: record.id,
        actor: input.decidedBy,
        detail: `operator applied ${input.narrowingPatches.length} narrowing patch(es)`,
      });
    }

    record.status = 'approved';
    record.decidedBy = input.decidedBy;
    record.decidedAt = this.now();
    record.approvedSpec = approvedSpec;
    this.audit.record({
      type: 'approved',
      pluginId: record.pluginId,
      proposalId: record.id,
      actor: input.decidedBy,
      detail: record.proposal.rationale,
    });
    return record;
  }

  deny(id: string, decidedBy: string, reason: string): ProposalRecord {
    const record = this.require(id);
    if (record.status !== 'pending') {
      throw new IllegalProposalTransitionError(id, record.status, 'deny');
    }
    record.status = 'denied';
    record.decidedBy = decidedBy;
    record.decidedAt = this.now();
    record.denialReason = reason;
    this.audit.record({
      type: 'denied_by_operator',
      pluginId: record.pluginId,
      proposalId: record.id,
      actor: decidedBy,
      detail: reason,
    });
    return record;
  }

  markInstalled(id: string, version: string): ProposalRecord {
    const record = this.require(id);
    if (record.status !== 'approved') {
      throw new IllegalProposalTransitionError(id, record.status, 'install');
    }
    record.status = 'installed';
    this.audit.record({
      type: 'installed',
      pluginId: record.pluginId,
      proposalId: record.id,
      actor: record.decidedBy ?? 'system',
      detail: `installed version ${version}`,
    });
    return record;
  }

  markFailed(id: string, reason: string): ProposalRecord {
    const record = this.require(id);
    if (record.status !== 'approved') {
      throw new IllegalProposalTransitionError(id, record.status, 'fail');
    }
    record.status = 'install_failed';
    record.installFailureReason = reason;
    this.audit.record({
      type: 'install_failed',
      pluginId: record.pluginId,
      proposalId: record.id,
      actor: record.decidedBy ?? 'system',
      detail: reason,
    });
    return record;
  }

  get(id: string): ProposalRecord | undefined {
    return this.records.get(id);
  }

  list(filter?: { pluginId?: string; status?: ProposalStatus }): ProposalRecord[] {
    return Array.from(this.records.values()).filter((r) => {
      if (filter?.pluginId && r.pluginId !== filter.pluginId) return false;
      if (filter?.status && r.status !== filter.status) return false;
      return true;
    });
  }

  auditTrail(): SelfExtensionAudit {
    return this.audit;
  }

  private require(id: string): ProposalRecord {
    const record = this.records.get(id);
    if (!record) throw new ProposalNotFoundError(id);
    return record;
  }
}
