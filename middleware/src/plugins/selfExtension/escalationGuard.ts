/**
 * Plugin self-extension — the escalation guard.
 *
 * Given the plugin's LIVE spec and an {@link ExtensionProposal}, decide whether
 * the proposal may even be shown to an operator. The two operator constraints
 * are encoded here as hard, pre-operator gates:
 *
 *   1. NON-ESCALATION — the proposed privilege surface must be a subset of the
 *      current one (no new write, no new egress, no new parent, no loosened
 *      privacy class). Any widening ⇒ `denied_escalation`. The operator never
 *      sees an escalating proposal, so they cannot rubber-stamp one.
 *
 *   2. NO IMPERSONATION — a proposal may not mutate the plugin's identity
 *      (`/id`, `/version` is allowed to bump, `/template` is frozen). A patch
 *      that changes `/id` ⇒ `invalid_spec`.
 *
 * Everything that survives both gates is `needs_approval`: a real human still
 * decides, and can only narrow further (see {@link ./operatorGate.ts}). The
 * guard is pure and side-effect free — it computes a verdict, it does not
 * persist or build anything.
 */

import type { ExtensionTemplate } from '@omadia/plugin-api';

import {
  applySpecPatches,
  IllegalSpecState,
} from '../builder/specPatcher.js';
import type { AgentSpec } from '../builder/agentSpec.js';
import type { Plugin } from '../../api/admin-v1.js';
import type { ExtensionProposal, TemplateProposal } from './extensionProposal.js';
import {
  computeWidenings,
  extractPermissionSurface,
  extractSurfaceFromManifest,
  surfaceFromPartial,
  type PermissionSurface,
  type SurfaceWidening,
} from './permissionSurface.js';

export type ProposalDecision =
  | 'needs_approval'
  | 'denied_escalation'
  | 'invalid_spec';

export interface ProposalEvaluation {
  readonly decision: ProposalDecision;
  /** Non-empty iff `decision === 'denied_escalation'`. */
  readonly escalations: readonly SurfaceWidening[];
  /** Why the spec was rejected, iff `decision === 'invalid_spec'`. */
  readonly invalidReason?: string;
  /** Privilege surface of the live spec (always computed). */
  readonly currentSurface: PermissionSurface;
  /** The spec that would result from applying the patches — present unless
   *  `decision === 'invalid_spec'`. */
  readonly proposedSpec?: AgentSpec;
  /** Privilege surface of {@link proposedSpec} — present unless invalid. */
  readonly proposedSurface?: PermissionSurface;
  /** Template path only: the sub-surface the chosen template requires. */
  readonly requiredSurface?: PermissionSurface;
}

/**
 * Evaluate a proposal against the live spec. Pure. The returned
 * {@link ProposalEvaluation} is the single source of truth the operator gate
 * persists and acts on.
 */
export function evaluateProposal(
  currentSpec: AgentSpec,
  proposal: ExtensionProposal,
): ProposalEvaluation {
  const currentSurface = extractPermissionSurface(currentSpec);

  // The proposal must target THIS plugin.
  if (proposal.pluginId !== currentSpec.id) {
    return {
      decision: 'invalid_spec',
      escalations: [],
      invalidReason: `proposal pluginId '${proposal.pluginId}' does not match spec id '${currentSpec.id}'`,
      currentSurface,
    };
  }

  // Apply the patches against a re-validated copy of the live spec.
  let proposedSpec: AgentSpec;
  try {
    ({ spec: proposedSpec } = applySpecPatches(currentSpec, proposal.patches));
  } catch (err) {
    const reason =
      err instanceof IllegalSpecState
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    return {
      decision: 'invalid_spec',
      escalations: [],
      invalidReason: reason,
      currentSurface,
    };
  }

  // Identity must be immutable — a self-extension cannot become another
  // plugin (which would inherit a different Vault scope + provider slot).
  if (proposedSpec.id !== currentSpec.id) {
    return {
      decision: 'invalid_spec',
      escalations: [],
      invalidReason: `patches mutate immutable plugin id ('${currentSpec.id}' → '${proposedSpec.id}')`,
      currentSurface,
      proposedSpec,
    };
  }
  if (proposedSpec.template !== currentSpec.template) {
    return {
      decision: 'invalid_spec',
      escalations: [],
      invalidReason: `patches mutate immutable template ('${currentSpec.template}' → '${proposedSpec.template}')`,
      currentSurface,
      proposedSpec,
    };
  }

  const proposedSurface = extractPermissionSurface(proposedSpec);
  const escalations = computeWidenings(currentSurface, proposedSurface);

  return {
    decision: escalations.length > 0 ? 'denied_escalation' : 'needs_approval',
    escalations,
    currentSurface,
    proposedSpec,
    proposedSurface,
  };
}

/**
 * Evaluate a TEMPLATE proposal (standalone-plugin path) against the plugin's
 * INSTALLED manifest. The non-escalation check is `template.requires ⊆ manifest
 * surface` — params never widen the surface, so they are not security-relevant
 * (the plugin validates them in `apply`). Pure.
 */
export function evaluateTemplateProposal(
  plugin: Plugin,
  template: ExtensionTemplate | undefined,
  proposal: TemplateProposal,
): ProposalEvaluation {
  const currentSurface = extractSurfaceFromManifest(plugin);

  if (proposal.pluginId !== plugin.id) {
    return {
      decision: 'invalid_spec',
      escalations: [],
      invalidReason: `proposal pluginId '${proposal.pluginId}' does not match plugin id '${plugin.id}'`,
      currentSurface,
    };
  }
  if (!template) {
    return {
      decision: 'invalid_spec',
      escalations: [],
      invalidReason: `plugin '${plugin.id}' declares no self-extend template '${proposal.templateId}'`,
      currentSurface,
    };
  }

  const requiredSurface = surfaceFromPartial(template.requires ?? {});
  const escalations = computeWidenings(currentSurface, requiredSurface);

  return {
    decision: escalations.length > 0 ? 'denied_escalation' : 'needs_approval',
    escalations,
    currentSurface,
    requiredSurface,
  };
}
