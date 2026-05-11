/**
 * Public surface of `@omadia/plugin-privacy-detector-ollama`.
 *
 * The plugin's primary export is `activate` — invoked by the harness
 * runtime when an operator installs the plugin. The detector + client
 * factories are also re-exported so future detector plugins (and tests)
 * can build against them without re-implementing the prompt or transport.
 */

export { activate } from './plugin.js';
export type { OllamaDetectorPluginHandle } from './plugin.js';

export { createOllamaNerDetector } from './nerDetector.js';
export type { NerDetectorOptions } from './nerDetector.js';

export {
  createOllamaChatClient,
  OllamaTransportError,
} from './ollamaClient.js';
export type {
  OllamaChatClient,
  OllamaChatClientOptions,
  OllamaChatRequest,
} from './ollamaClient.js';

export {
  buildNerMessages,
  parseNerResponse,
  NER_FEW_SHOT,
  NER_SYSTEM_PROMPT,
  NER_TYPE_VOCABULARY,
  NerHitSchema,
  NerResponseSchema,
} from './nerPrompt.js';
export type {
  ChatMessage,
  NerHit,
  NerResponse,
  NerType,
} from './nerPrompt.js';
