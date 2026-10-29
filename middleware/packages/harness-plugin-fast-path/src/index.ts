/**
 * Public surface of `@omadia/fast-path`. The kernel loads `./plugin.js`
 * (`activate`) via `manifest.lifecycle.entry`; the re-exports are the shared
 * building blocks the canvas orchestrator imports and the `fastPath@1`
 * service contract its consumers type against.
 */
export * from './refreshRecipes.js';
export * from './recipeStore.js';
export * from './jsonExtract.js';
export * from './fastPath.js';
export * from './literalStripping.js';
export * from './learnedPlanStore.js';
export * from './learningCapture.js';
export * from './exampleMasking.js';
export * from './storedTextPrivacy.js';
export * from './triage.js';
export * from './chatAnswer.js';
export * from './fieldLabels.js';
export * from './service.js';
export { activate, type FastPathPluginHandle } from './plugin.js';
