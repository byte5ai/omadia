/**
 * Public surface of `@omadia/plugin-privacy-guard`.
 *
 * The plugin's primary export is `activate` — invoked by the harness
 * runtime when an operator installs the plugin. The factory and the
 * detector/policy primitives are also re-exported for tests + future
 * sibling plugins (Presidio adapter, Ollama adapter) that will share
 * the receipt-assembly pipeline.
 */

export { activate } from './plugin.js';
export type { PrivacyGuardPluginHandle } from './plugin.js';

export { createPrivacyGuardService } from './service.js';
export type {
  PrivacyGuardServiceDeps,
  PrivacyGuardServiceInternal,
} from './service.js';

export {
  createRegexDetector,
  detectInText,
  REGEX_DETECTOR_ID,
  REGEX_DETECTOR_VERSION,
  type DetectionType,
  type DetectorHit,
} from './regexDetector.js';

export { decide, deriveRouting, type PolicyDecision } from './policyEngine.js';

export {
  createTokenizeMap,
  isToken,
  sanitizeTypeHint,
  TOKEN_REGEX,
  type TokenizeMap,
} from './tokenizeMap.js';

export { assembleReceipt, type AssembledHit, type AssembleInput } from './receiptAssembler.js';
