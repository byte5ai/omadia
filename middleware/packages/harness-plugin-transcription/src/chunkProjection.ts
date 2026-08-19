/**
 * #584 — Chunk projection: capability segments → recall-sized chunk texts.
 *
 * The Transcript Artifact is canonical truth; this module derives the
 * DISPOSABLE recall projection from it (ticket-02 decision). Each chunk
 * becomes one session turn (`[<label>]: <text>` per segment line in the
 * userMessage), so the sizing follows the fact extractor's USER-MESSAGE
 * truncation limit (2000 chars, `factExtractor.ts` — 4000 is the
 * assistant-answer limit and never applies here): a chunk that fits is never
 * amputated on the recall path.
 *
 * Rules:
 * - Chunks break ONLY at segment boundaries.
 * - An oversized single segment (monologue) is split at sentence boundaries
 *   in the projection only — the artifact segment stays whole — with the
 *   speaker prefix repeated on every piece.
 * - Chunk offsets are recording-relative milliseconds: the first line's
 *   `startMs` when the provider/adapter delivered timestamps, else the chunk
 *   index. Offsets are forced strictly increasing so every chunk's turn id
 *   (`recordingStart + offset`) stays collision-free even without timing.
 */

export interface ProjectableSegment {
  /** Display name (when a mapping was resolved at ingest time) or the
   *  canonical Speaker Label. */
  label: string;
  text: string;
  startMs?: number;
}

export interface TranscriptChunk {
  /** One line per segment (piece): `[<label>]: <text>`. */
  text: string;
  /** Recording-relative offset in ms — strictly increasing across chunks. */
  offsetMs: number;
}

export const TRANSCRIPT_CHUNK_MAX_CHARS = 2000;

interface ChunkLine {
  text: string;
  startMs?: number;
}

export function projectTranscriptChunks(
  segments: readonly ProjectableSegment[],
  maxChars: number = TRANSCRIPT_CHUNK_MAX_CHARS,
): TranscriptChunk[] {
  const lines: ChunkLine[] = [];
  for (const segment of segments) {
    const text = segment.text.replace(/\r\n/g, '\n').trim();
    if (text.length === 0) continue;
    const prefix = `[${segment.label}]: `;
    const pieceLimit = Math.max(1, maxChars - prefix.length);
    for (const piece of splitAtSentences(text, pieceLimit)) {
      lines.push({
        text: `${prefix}${piece}`,
        ...(segment.startMs !== undefined ? { startMs: segment.startMs } : {}),
      });
    }
  }

  const chunks: TranscriptChunk[] = [];
  let current: ChunkLine[] = [];
  let currentLen = 0;
  const flush = (): void => {
    if (current.length === 0) return;
    const candidate = current[0]?.startMs ?? chunks.length;
    const previous = chunks.length > 0 ? chunks[chunks.length - 1]!.offsetMs : -1;
    chunks.push({
      text: current.map((l) => l.text).join('\n'),
      offsetMs: Math.max(candidate, previous + 1),
    });
    current = [];
    currentLen = 0;
  };

  for (const line of lines) {
    const addition = current.length === 0 ? line.text.length : line.text.length + 1;
    if (current.length > 0 && currentLen + addition > maxChars) flush();
    current.push(line);
    currentLen += current.length === 1 ? line.text.length : addition;
  }
  flush();

  return chunks;
}

/**
 * Greedy sentence packing: split at sentence-ending punctuation, then pack
 * consecutive sentences into pieces of at most `limit` chars. A single
 * sentence longer than the limit is hard-sliced — a lossless projection
 * beats a pretty one.
 */
function splitAtSentences(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const sentences = text.split(/(?<=[.!?])\s+/);
  const pieces: string[] = [];
  let buffer = '';
  const push = (): void => {
    if (buffer.length > 0) pieces.push(buffer);
    buffer = '';
  };
  for (const sentence of sentences) {
    if (sentence.length > limit) {
      push();
      for (let i = 0; i < sentence.length; i += limit) {
        pieces.push(sentence.slice(i, i + limit));
      }
      continue;
    }
    const joined = buffer.length === 0 ? sentence : `${buffer} ${sentence}`;
    if (joined.length > limit) {
      push();
      buffer = sentence;
    } else {
      buffer = joined;
    }
  }
  push();
  return pieces;
}
