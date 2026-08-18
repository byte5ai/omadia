import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  TRANSCRIPTION_CAPABILITY,
  type Transcript,
  type TranscriptDelta,
  type TranscriptSegment,
  type TranscriptionUsage,
} from '../src/index.js';

describe('transcription@1 contract', () => {
  it('pins the capability constant', () => {
    assert.equal(TRANSCRIPTION_CAPABILITY, 'transcription@1');
  });

  it('the delta union is exhaustive (compile-time)', () => {
    // A switch over `kind` with a `never` default proves at compile time that
    // every variant of TranscriptDelta is handled. Adding a variant to the
    // union without extending this switch breaks the package typecheck.
    const describeDelta = (delta: TranscriptDelta): string => {
      switch (delta.kind) {
        case 'partial':
          return `partial:${delta.segmentId}:${delta.textDelta}`;
        case 'segmentCompleted':
          return `completed:${delta.segment.id}`;
        case 'end':
          return `end:${delta.usage.attempts}`;
        default: {
          const unreachable: never = delta;
          return unreachable;
        }
      }
    };

    const segment: TranscriptSegment = { id: 'seg-0', text: 'hello' };
    const usage: TranscriptionUsage = { attempts: 1 };
    assert.equal(
      describeDelta({ kind: 'partial', segmentId: 'seg-0', textDelta: 'he' }),
      'partial:seg-0:he',
    );
    assert.equal(describeDelta({ kind: 'segmentCompleted', segment }), 'completed:seg-0');
    assert.equal(describeDelta({ kind: 'end', usage }), 'end:1');
  });

  it('a minimal batch Transcript satisfies the contract shape', () => {
    // Batch = 1 segment per file, no timestamps, timing provenance 'none'.
    const transcript: Transcript = {
      segments: [{ id: 'seg-0', text: 'full transcript text' }],
      timing: 'none',
      usage: { attempts: 1 },
    };
    assert.equal(transcript.segments.length, 1);
    assert.equal(transcript.timing, 'none');
    assert.equal(transcript.usage.attempts, 1);
  });
});
