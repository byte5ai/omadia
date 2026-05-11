/**
 * Public surface of `@omadia/plugin-privacy-detector-presidio`.
 *
 * The plugin's primary export is `activate` — invoked by the harness
 * runtime when an operator installs the plugin. The detector + client
 * factories are also re-exported so future detector plugins (and tests)
 * can build against them without re-implementing the prompt or transport.
 */

export { activate } from './plugin.js';
export type { PresidioDetectorPluginHandle } from './plugin.js';

export { createPresidioDetector } from './presidioDetector.js';
export type { PresidioDetectorOptions } from './presidioDetector.js';

export {
  createPresidioClient,
  PresidioTransportError,
} from './presidioClient.js';
export type {
  PresidioClient,
  PresidioClientOptions,
  PresidioAnalyzeRequest,
  PresidioAnalyzeResponse,
  PresidioRawHit,
} from './presidioClient.js';

export {
  mapPresidioType,
  isPresidioTypeRelevant,
  PRESIDIO_DETECTOR_VERSION,
} from './typeMapping.js';
