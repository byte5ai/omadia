// @omadia/conductor-core — pure, I/O-free Conductor engine (US1).
// Sibling of @omadia/canvas-core: deterministic workflow-graph validation + advancement.

export * from './types.js';
export { evaluatePredicate, resolvePath } from './predicate.js';
export { conductorGraphSchema, validateGraphShape, type ShapeResult } from './schema.js';
export { validate } from './validate.js';
export { nextStep } from './engine.js';
export {
  extractSlotRefs,
  missingSlotMappings,
  applyTemplateSlots,
  checkTemplateManifest,
} from './template.js';
