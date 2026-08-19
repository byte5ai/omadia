export { activate } from './plugin.js';
export type { TranscriptionPluginHandle } from './plugin.js';
export {
  createTranscriptionUploadRouter,
} from './uploadRouter.js';
export type {
  TranscriptionUploadRouterOptions,
  TranscriptionUploadStore,
} from './uploadRouter.js';
export {
  handleTranscribeRecording,
  transcribeRecordingToolSpec,
} from './transcribeRecordingTool.js';
export type {
  RecordingReader,
  TranscribeRecordingToolDeps,
  TranscriptArtifactStore,
  TranscriptTurnLogger,
} from './transcribeRecordingTool.js';
export {
  DEFAULT_SPEAKER_LABEL,
  TRANSCRIPT_ARTIFACT_KEY_PREFIX,
  buildTranscriptArtifact,
  recordingIdFor,
  transcriptArtifactKey,
  transcriptScope,
} from './transcriptArtifact.js';
export type {
  TranscriptArtifact,
  TranscriptArtifactSegment,
  TranscriptArtifactUploader,
} from './transcriptArtifact.js';
export {
  TRANSCRIPT_CHUNK_MAX_CHARS,
  projectTranscriptChunks,
} from './chunkProjection.js';
export type {
  ProjectableSegment,
  TranscriptChunk,
} from './chunkProjection.js';
