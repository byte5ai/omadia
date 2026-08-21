/**
 * `@omadia/llm-adapter-openai-responses` — the OpenAI Responses (SSE) wire-
 * format adapter for the ChatGPT/Codex backend (#294 "Sign in with ChatGPT",
 * EXPERIMENTAL). Raw fetch + in-package SSE parser; no vendor SDK. The app
 * registers it into the LLM adapter registry at boot
 * (`registerOpenAiResponsesAdapter`).
 */
export {
  openAiResponsesAdapter,
  registerOpenAiResponsesAdapter,
} from './adapter.js';

export {
  createOpenAiResponsesProvider,
  ResponsesHttpError,
  type OpenAiResponsesProviderOptions,
} from './responsesProvider.js';

export { SseParser, type SseEvent } from './sse.js';
