// The shared floor of an agent dialogue: `ctx.transcript`.
//
// Microsoft Teams does not deliver one bot's message to another bot, so the
// second speaker can never learn what the first said by listening to the
// channel. The transcript IS the bus — every `say` step's utterance is appended
// here, and the next speaker's prompt interpolates `{{ctx.transcriptText}}`.
//
// Executor-owned, like `steps` and `stepAttempts`: a caller-seeded transcript
// would let a plugin fabricate a conversation that never happened, so
// `createEphemeralRun` strips both keys from the payload.

import type { JsonObject, JsonValue, Step } from '@omadia/conductor-core';

/** Turns kept. Older ones fall off the front — a bounded loop can still run
 *  long, and an unbounded context is how an agent dialogue turns into a bill. */
export const TRANSCRIPT_MAX_ENTRIES = 40;

/** Rendered-transcript budget. Trimmed from the FRONT so the most recent turns
 *  — the ones a reply actually needs — always survive. */
export const TRANSCRIPT_TEXT_MAX_CHARS = 12_000;

export interface TranscriptEntry extends JsonObject {
  /** The step that produced the utterance. */
  step: string;
  /** The speaking agent's slug. */
  agent: string;
  /** The display name shown in the chat. */
  speaker: string;
  text: string;
  at: string;
}

function asObject(value: JsonValue | undefined): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}

/** Strip fenced ```json verdict blocks — they are guard fuel, not conversation.
 *  Leaving them in would make the next speaker answer the machine, not the peer. */
function speakableText(result: JsonValue): string {
  const text = asObject(result)['text'];
  if (typeof text !== 'string') return '';
  return text.replace(/```json\s*\n[\s\S]*?```/g, '').trim();
}

/** Render the entries as `Speaker: utterance` blocks, newest-preserving. */
export function renderTranscript(entries: readonly TranscriptEntry[]): string {
  const lines = entries.map((e) => `${e.speaker}: ${e.text}`);
  let rendered = lines.join('\n\n');
  while (rendered.length > TRANSCRIPT_TEXT_MAX_CHARS && lines.length > 1) {
    lines.shift();
    rendered = lines.join('\n\n');
  }
  return rendered.length > TRANSCRIPT_TEXT_MAX_CHARS ? rendered.slice(-TRANSCRIPT_TEXT_MAX_CHARS) : rendered;
}

/**
 * Append one `say` step's utterance to the run transcript. A step without
 * `say` contributes nothing — a workflow's internal agent steps must not leak
 * into a conversation's shared memory.
 *
 * Appended even when delivery FAILED (`said: false`): the dialogue's continuity
 * lives here, not in the chat. If a Teams hiccup dropped one turn, the peers
 * still build on it — the chat is the projection, the transcript is the thing.
 */
export function appendTranscript(
  context: JsonObject,
  step: Step,
  result: JsonValue,
  now: () => Date = () => new Date(),
): JsonObject {
  if (!step.say) return context;
  const text = speakableText(result);
  if (text.length === 0) return context;

  const previous = Array.isArray(context.transcript) ? (context.transcript as JsonValue[]) : [];
  const entry: TranscriptEntry = {
    step: step.id,
    agent: step.agentId ?? '',
    speaker: step.say.speaker ?? step.agentId ?? step.id,
    text,
    at: now().toISOString(),
  };
  const transcript = [...previous, entry].slice(-TRANSCRIPT_MAX_ENTRIES) as TranscriptEntry[];
  return { ...context, transcript, transcriptText: renderTranscript(transcript) };
}
