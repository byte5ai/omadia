/**
 * `@omadia/llm-adapter-openai` — the OpenAI Chat Completions wire-format adapter
 * (also serves the OpenAI-compatible family: Mistral/Ollama/vLLM/Azure/MiniMax).
 *
 * Confines all `openai` SDK knowledge to this package. The app registers it into
 * the LLM adapter registry at boot (`registerOpenAiAdapter`).
 */
export { openAiAdapter, registerOpenAiAdapter } from './adapter.js';

export {
  createOpenAiProvider,
  classifyOpenAiError,
  type OpenAiProviderOptions,
} from './openaiProvider.js';

export {
  createOpenAiClient,
  type OpenAiClient,
  type OpenAiClientOptions,
} from './openaiClient.js';
