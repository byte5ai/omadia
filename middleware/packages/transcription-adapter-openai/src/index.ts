/**
 * `@omadia/transcription-adapter-openai` — OpenAI adapter for the
 * `transcription@1` capability. See `plugin.ts` for the registration contract
 * and `openaiTranscriptionService.ts` for the adapter behaviour rules.
 */
export {
  TRANSCRIPTION_SERVICE_NAME,
  activate,
  type OpenAiTranscriptionPluginHandle,
} from './plugin.js';
export {
  OPENAI_BATCH_TRANSCRIPTION_MODEL,
  classifyOpenAiTranscriptionError,
  createOpenAiTranscriptionService,
  type OpenAiTranscriptionServiceOptions,
} from './openaiTranscriptionService.js';
export {
  createOpenAiTranscriptionClient,
  type OpenAiTranscriptionClient,
  type OpenAiTranscriptionClientOptions,
} from './openaiClient.js';
