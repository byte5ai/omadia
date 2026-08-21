import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { RealtimeTranscriptionError, mapRealtimeEvent } from '../src/deltaMapper.js';

/**
 * Fixtures follow the documented realtime transcription-session event shapes
 * (developers.openai.com, 2026-08): delta / completed / error, keyed and
 * ordered by `item_id`.
 */
describe('mapRealtimeEvent', () => {
  it('maps transcription deltas to partial updates keyed by item_id', () => {
    const mapped = mapRealtimeEvent({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'item_003',
      content_index: 0,
      delta: 'Hello,',
    });
    assert.deepEqual(mapped, {
      kind: 'partial',
      itemId: 'item_003',
      text: 'Hello,',
    });
  });

  it('maps completed transcriptions to finalised segments', () => {
    const mapped = mapRealtimeEvent({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item_003',
      content_index: 0,
      transcript: 'Hello, how can I help?',
    });
    assert.deepEqual(mapped, {
      kind: 'segment',
      itemId: 'item_003',
      segment: { text: 'Hello, how can I help?' },
    });
  });

  it('keeps distinct item_ids apart so consumers can order and reconcile', () => {
    const a = mapRealtimeEvent({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'item_001',
      content_index: 0,
      delta: 'first',
    });
    const b = mapRealtimeEvent({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'item_002',
      content_index: 0,
      delta: 'second',
    });
    assert.equal(a?.itemId, 'item_001');
    assert.equal(b?.itemId, 'item_002');
  });

  it('ignores progress noise (session lifecycle, buffer acks, unknown events)', () => {
    for (const type of [
      'session.created',
      'session.updated',
      'input_audio_buffer.committed',
      'rate_limits.updated',
      'something.new.entirely',
    ]) {
      assert.equal(mapRealtimeEvent({ type, item_id: 'x' }), undefined);
    }
    assert.equal(mapRealtimeEvent(null), undefined);
    assert.equal(mapRealtimeEvent('nope'), undefined);
  });

  it('drops malformed transcript events instead of inventing text', () => {
    assert.equal(
      mapRealtimeEvent({
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: 'item_1',
        delta: 42,
      }),
      undefined,
    );
    assert.equal(
      mapRealtimeEvent({
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: 'no item id',
      }),
      undefined,
    );
  });

  it('throws on server error events, carrying the server message', () => {
    assert.throws(
      () =>
        mapRealtimeEvent({
          type: 'error',
          error: { message: 'session expired' },
        }),
      (err: unknown) =>
        err instanceof RealtimeTranscriptionError &&
        err.message === 'session expired',
    );
  });
});
