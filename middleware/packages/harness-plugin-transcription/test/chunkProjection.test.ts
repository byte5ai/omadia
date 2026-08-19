import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  TRANSCRIPT_CHUNK_MAX_CHARS,
  projectTranscriptChunks,
} from '../src/chunkProjection.js';

describe('projectTranscriptChunks', () => {
  it('renders one line per segment as [label]: text', () => {
    const chunks = projectTranscriptChunks([
      { label: 'speaker_0', text: 'Hallo zusammen.' },
      { label: 'Anna', text: 'Guten Morgen.' },
    ]);
    assert.equal(chunks.length, 1);
    assert.equal(
      chunks[0]?.text,
      '[speaker_0]: Hallo zusammen.\n[Anna]: Guten Morgen.',
    );
    assert.equal(chunks[0]?.offsetMs, 0);
  });

  it('breaks only at segment boundaries', () => {
    const a = { label: 's', text: 'x'.repeat(40) };
    const b = { label: 's', text: 'y'.repeat(40) };
    const c = { label: 's', text: 'z'.repeat(40) };
    // maxChars fits two lines (2×45 + newline = 91) but not three.
    const chunks = projectTranscriptChunks([a, b, c], 100);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0]?.text, `[s]: ${a.text}\n[s]: ${b.text}`);
    assert.equal(chunks[1]?.text, `[s]: ${c.text}`);
  });

  it('keeps every chunk within the char budget', () => {
    const segments = Array.from({ length: 20 }, (_, i) => ({
      label: `speaker_${String(i % 3)}`,
      text: `Satz ${String(i)}. `.repeat(30).trim(),
    }));
    const chunks = projectTranscriptChunks(segments);
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
      assert.ok(chunk.text.length <= TRANSCRIPT_CHUNK_MAX_CHARS);
    }
  });

  it('splits an oversized monologue at sentence boundaries, prefix repeated', () => {
    const sentences = Array.from(
      { length: 8 },
      (_, i) => `Dies ist der ausführliche Monologsatz Nummer ${String(i)}.`,
    );
    const text = sentences.join(' ');
    const chunks = projectTranscriptChunks(
      [{ label: 'speaker_0', text }],
      120,
    );
    assert.ok(chunks.length > 1);
    const lines = chunks.flatMap((c) => c.text.split('\n'));
    for (const line of lines) {
      assert.ok(line.startsWith('[speaker_0]: '));
      assert.ok(line.length <= 120);
      // Sentence-boundary split: every piece ends on sentence punctuation.
      assert.ok(line.endsWith('.'));
    }
    // Lossless: the pieces reassemble to the original monologue.
    const reassembled = lines
      .map((l) => l.slice('[speaker_0]: '.length))
      .join(' ');
    assert.equal(reassembled, text);
  });

  it('uses segment startMs as chunk offset and keeps offsets strictly increasing', () => {
    const withTiming = projectTranscriptChunks(
      [
        { label: 's', text: 'a'.repeat(90), startMs: 5_000 },
        { label: 's', text: 'b'.repeat(90), startMs: 12_000 },
      ],
      100,
    );
    assert.deepEqual(
      withTiming.map((c) => c.offsetMs),
      [5_000, 12_000],
    );

    // Duplicate startMs must not collide (turn ids are time-keyed).
    const duplicate = projectTranscriptChunks(
      [
        { label: 's', text: 'a'.repeat(90), startMs: 5_000 },
        { label: 's', text: 'b'.repeat(90), startMs: 5_000 },
      ],
      100,
    );
    assert.deepEqual(
      duplicate.map((c) => c.offsetMs),
      [5_000, 5_001],
    );

    // No timing at all → chunk index as offset.
    const untimed = projectTranscriptChunks(
      [
        { label: 's', text: 'a'.repeat(90) },
        { label: 's', text: 'b'.repeat(90) },
      ],
      100,
    );
    assert.deepEqual(
      untimed.map((c) => c.offsetMs),
      [0, 1],
    );
  });

  it('skips empty segments and returns no chunks for an empty transcript', () => {
    assert.deepEqual(projectTranscriptChunks([]), []);
    assert.deepEqual(
      projectTranscriptChunks([{ label: 's', text: '   ' }]),
      [],
    );
  });
});
