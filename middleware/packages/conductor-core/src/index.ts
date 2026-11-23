// @omadia/conductor-core — pure, I/O-free Conductor engine (US1).
// Sibling of @omadia/canvas-core (byte5ai/omadia-ui-support): deterministic workflow-graph validation + advancement.

export * from './types.js';
export { evaluatePredicate, resolvePath } from './predicate.js';
export { conductorGraphSchema, validateGraphShape, type ShapeResult } from './schema.js';
export { validate } from './validate.js';
export { nextStep, type NextStepOptions } from './engine.js';
export { parseIsoDurationMs } from './duration.js';
export {
  extractSlotRefs,
  missingSlotMappings,
  applyTemplateSlots,
  checkTemplateManifest,
  resolveLocalizedText,
  templateManifestVersion,
  inferTemplateManifest,
  type InferTemplateOptions,
} from './template.js';
export {
  extractTextSlotRefs,
  TEXT_SLOT_PREFIX,
  type TemplateTextSlotRef,
} from './textSlots.js';
// #1709 — the run-context token grammar, shared with the kernel's renderer so the
// authoring check and the runtime substitution can never disagree about what a token is.
export { isTemplateExpression, runTokenMatcher } from './runTokens.js';
