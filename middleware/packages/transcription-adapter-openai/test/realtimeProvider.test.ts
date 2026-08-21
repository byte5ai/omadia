import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { TranscriptDelta } from '@omadia/plugin-api';

import {
  createOpenAiRealtimeTranscriber,
  sessionUpdateEvent,
} from '../src/realtimeProvider.js';
import type { RealtimeSocket } from '../src/realtimeTransport.js';

/**
 * Scripted fake socket: records every event the provider sends and replays a
 * canned server-event sequence — the whole protocol adapter is exercised with
 * zero network and zero credentials.
 */
function fakeSocket(serverEvents: readonly unknown[]): {
  socket: RealtimeSocket;
  sent: Array<Record<string, unknown>>;
  closed: () => boolean;
} {
  const sent: Array<Record<string, unknown>> = [];
  let closed = false;
  const socket: RealtimeSocket = {
    send(event) {
      sent.push(event);
    },
    async *events() {
      for (const e of serverEvents) yield e;
    },
    close() {
      closed = true;
    },
  };
  return { socket, sent, closed: () => closed };
}

async function* audioChunks(...chunks: number[][]): AsyncGenerator<Uint8Array> {
  for (const c of chunks) yield new Uint8Array(c);
}

async function collect(
  it2: AsyncIterable<TranscriptDelta>,
): Promise<TranscriptDelta[]> {
  const out: TranscriptDelta[] = [];
  for await (const d of it2) out.push(d);
  return out;
}

describe('sessionUpdateEvent', () => {
  it('declares a transcription session with pcm audio and maps every hint onto the wire names', () => {
    const event = sessionUpdateEvent('gpt-live-transcribe', {
      context: 'Kundencall zu Vertrag AC-42',
      keywordHints: ['AC-42', 'omadia'],
      languageHints: ['de'],
    });
    assert.deepEqual(event, {
      type: 'session.update',
      session: {
        type: 'transcription',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24_000 },
            transcription: {
              model: 'gpt-live-transcribe',
              prompt: 'Kundencall zu Vertrag AC-42',
              keywords: ['AC-42', 'omadia'],
              languages: ['de'],
            },
            turn_detection: null,
          },
        },
      },
    });
  });

  it('omits absent hints instead of sending empty fields', () => {
    const event = sessionUpdateEvent('gpt-live-transcribe', undefined);
    const transcription = (
      event['session'] as {
        audio: { input: { transcription: Record<string, unknown> } };
      }
    ).audio.input.transcription;
    assert.deepEqual(Object.keys(transcription), ['model']);
  });
});

describe('createOpenAiRealtimeTranscriber', () => {
  const make = (serverEvents: readonly unknown[]) => {
    const fake = fakeSocket(serverEvents);
    const transcriber = createOpenAiRealtimeTranscriber({
      url: 'wss://api.openai.com/v1/realtime',
      apiKey: 'sk-test',
      model: 'gpt-live-transcribe',
      openSocket: async () => fake.socket,
    });
    return { transcriber, fake };
  };

  it('configures the session, base64-appends audio, commits, and yields mapped deltas in order', async () => {
    const { transcriber, fake } = make([
      { type: 'session.created' },
      {
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: 'item_1',
        delta: 'Hal',
      },
      {
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'item_1',
        transcript: 'Hallo.',
      },
    ]);
    const deltas = await collect(
      transcriber.transcribeStream(audioChunks([1, 2], [3])),
    );

    assert.deepEqual(deltas, [
      { kind: 'partial', itemId: 'item_1', text: 'Hal' },
      {
        kind: 'segment',
        itemId: 'item_1',
        segment: { text: 'Hallo.' },
      },
    ]);
    assert.equal(fake.sent[0]?.['type'], 'session.update');
    const appends = fake.sent.filter(
      (e) => e['type'] === 'input_audio_buffer.append',
    );
    assert.deepEqual(
      appends.map((a) => a['audio']),
      [
        Buffer.from([1, 2]).toString('base64'),
        Buffer.from([3]).toString('base64'),
      ],
    );
    assert.equal(fake.sent.at(-1)?.['type'], 'input_audio_buffer.commit');
    assert.equal(fake.closed(), true);
  });

  it('surfaces server error events as a thrown error and still closes the socket', async () => {
    const { transcriber, fake } = make([
      { type: 'error', error: { message: 'invalid session config' } },
    ]);
    await assert.rejects(
      collect(transcriber.transcribeStream(audioChunks([1]))),
      /invalid session config/,
    );
    assert.equal(fake.closed(), true);
  });

  it('an already-aborted signal never opens a stream', async () => {
    const { transcriber, fake } = make([
      {
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: 'i',
        delta: 'x',
      },
    ]);
    const controller = new AbortController();
    controller.abort();
    const deltas = await collect(
      transcriber.transcribeStream(audioChunks([1]), {
        signal: controller.signal,
      }),
    );
    assert.deepEqual(deltas, []);
    assert.equal(fake.sent.length, 0);
    assert.equal(fake.closed(), true);
  });
});
