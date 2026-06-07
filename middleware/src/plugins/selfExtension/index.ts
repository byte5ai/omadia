/**
 * Plugin self-extension subsystem — operator-gated, non-escalating.
 *
 * Lifecycle: a tool emits a runtime {@link LimitSignal} (plugin-api, Layer A);
 * the agent submits an {@link ExtensionProposal} (spec patches); the
 * {@link OperatorGate} runs the {@link evaluateProposal escalation guard}
 * (auto-denying any privilege widening); an operator approves (and may only
 * narrow); the {@link materializeApprovedProposal service} drives the approved
 * spec through the existing Builder install pipeline and runtime reactivation.
 * Every transition is recorded in the {@link SelfExtensionAudit} trail.
 */

export {
  extractPermissionSurface,
  extractSurfaceFromManifest,
  surfaceFromPartial,
  computeWidenings,
  isSurfaceSubset,
  patternCovers,
  coveredByAny,
  type PermissionSurface,
  type PartialSurface,
  type PrivacyClass,
  type SurfaceDimension,
  type SurfaceWidening,
} from './permissionSurface.js';

export {
  ExtensionProposalSchema,
  parseExtensionProposal,
  TemplateProposalSchema,
  parseTemplateProposal,
  type ExtensionProposal,
  type TemplateProposal,
  type JsonPatch,
} from './extensionProposal.js';

export {
  evaluateProposal,
  evaluateTemplateProposal,
  type ProposalDecision,
  type ProposalEvaluation,
} from './escalationGuard.js';

export {
  OperatorGate,
  NarrowingWidensError,
  ProposalNotFoundError,
  IllegalProposalTransitionError,
  type ProposalRecord,
  type ProposalStatus,
  type ProposalKind,
  type OperatorGateOptions,
  type SubmitInput,
  type SubmitSpecInput,
  type SubmitTemplateInput,
  type ApproveInput,
} from './operatorGate.js';

export { ExtensionStore } from './extensionStore.js';
export { SelfExtendRegistry } from './selfExtendRegistry.js';

export {
  createRequestSelfExtensionTool,
  REQUEST_SELF_EXTENSION_TOOL,
  type RequestSelfExtensionToolDeps,
  type KernelToolRegistration,
} from './requestSelfExtensionTool.js';

export {
  SelfExtensionAudit,
  type SelfExtensionAuditEvent,
  type SelfExtensionAuditType,
  type SelfExtensionAuditInput,
  type SelfExtensionAuditOptions,
} from './audit.js';

export {
  materializeApprovedProposal,
  type SelfExtensionServiceDeps,
  type MaterializeInput,
  type MaterializeResult,
} from './service.js';
