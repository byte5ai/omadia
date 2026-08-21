import type { TranscriptDelta } from '@omadia/plugin-api';

/**
 * Pure mapper from OpenAI Realtime transcription-session events to the
 * provider-neutral {@link TranscriptDelta} union (#584).
 *
 * Wire shapes (developers.openai.com, realtime transcription guide,
 * 2026-08 state):
 *   - `conversation.item.input_audio_transcription.delta`
 *       { type, item_id, content_index, delta }
 *   - `conversation.item.input_audio_transcription.completed`
 *       { type, item_id, content_index, transcript }
 *   - `error` { type, error: { message? } }
 *
 * Everything else (session.created/updated, input_audio_buffer.*, rate-limit
 * notices) is progress noise for this consumer and maps to `undefined`.
 * Kept free of I/O so the protocol translation is unit-testable against
 * recorded fixtures without a socket.
 */

const DELTA_EVENT = 'conversation.item.input_audio_transcription.delta';
const COMPLETED_EVENT = 'conversation.item.input_audio_transcription.completed';
const ERROR_EVENT = 'error';

/** Raised when the server reports an error event on the session. */
export class RealtimeTranscriptionError extends Error {}

/** Map one server event. Returns `undefined` for events that carry no
 *  transcript progress; throws {@link RealtimeTranscriptionError} on `error`. */
export function mapRealtimeEvent(event: unknown): TranscriptDelta | undefined {
  if (typeof event !== 'object' || event === null) return undefined;
  const record = event as Record<string, unknown>;
  const type = record['type'];

  if (type === ERROR_EVENT) {
    const detail = (record['error'] as Record<string, unknown> | undefined)?.[
      'message'
    ];
    throw new RealtimeTranscriptionError(
      typeof detail === 'string' && detail.length > 0
        ? detail
        : 'realtime transcription session reported an error',
    );
  }

  const itemId = readItemId(record);
  if (itemId === undefined) return undefined;

  if (type === DELTA_EVENT) {
    const delta = record['delta'];
    if (typeof delta !== 'string') return undefined;
    return { kind: 'partial', itemId, text: delta };
  }

  if (type === COMPLETED_EVENT) {
    const transcript = record['transcript'];
    if (typeof transcript !== 'string') return undefined;
    return { kind: 'segment', itemId, segment: { text: transcript } };
  }

  return undefined;
}

function readItemId(record: Record<string, unknown>): string | undefined {
  const raw = record['item_id'];
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}
