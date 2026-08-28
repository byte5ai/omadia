import type { TranscribeOpts, TranscriptDelta } from '@omadia/plugin-api';

import { mapRealtimeEvent } from './deltaMapper.js';
import type { RealtimeSocket, RealtimeSocketFactory } from './realtimeTransport.js';

/**
 * Realtime transcription over a Realtime-API transcription session (#584).
 *
 * Protocol (developers.openai.com, realtime-transcription guide, 2026-08):
 *   1. open the WebSocket (bearer auth),
 *   2. `session.update` with `session.type: 'transcription'`, the input audio
 *      format (`audio/pcm` @ 24 kHz), and the transcription config carrying
 *      model + the three context hints (`prompt`, `keywords`, `languages`),
 *   3. stream base64 chunks via `input_audio_buffer.append`, commit at end,
 *   4. consume `conversation.item.input_audio_transcription.delta/completed`
 *      events (mapped by `deltaMapper`) until the session closes.
 *
 * Audio contract: callers hand 16-bit PCM at 24 kHz (the session format this
 * provider declares). Container decoding is the caller's business — this
 * adapter transports bytes, it does not transcode.
 */

export const DEFAULT_REALTIME_MODEL = 'gpt-live-transcribe';
export const DEFAULT_REALTIME_URL = 'wss://api.openai.com/v1/realtime';

export interface OpenAiRealtimeTranscriberOptions {
  readonly url: string;
  readonly apiKey: string;
  readonly model: string;
  readonly openSocket: RealtimeSocketFactory;
}

export interface OpenAiRealtimeTranscriber {
  transcribeStream(
    audio: AsyncIterable<Uint8Array>,
    opts?: TranscribeOpts,
  ): AsyncIterable<TranscriptDelta>;
}

export function createOpenAiRealtimeTranscriber(
  options: OpenAiRealtimeTranscriberOptions,
): OpenAiRealtimeTranscriber {
  return {
    transcribeStream(
      audio: AsyncIterable<Uint8Array>,
      opts?: TranscribeOpts,
    ): AsyncIterable<TranscriptDelta> {
      return run(options, audio, opts);
    },
  };
}

async function* run(
  options: OpenAiRealtimeTranscriberOptions,
  audio: AsyncIterable<Uint8Array>,
  opts: TranscribeOpts | undefined,
): AsyncGenerator<TranscriptDelta> {
  const socket = await options.openSocket({
    url: options.url,
    apiKey: options.apiKey,
  });
  const abort = opts?.signal;
  if (abort?.aborted) {
    socket.close();
    return;
  }
  const onAbort = (): void => {
    socket.close();
  };
  abort?.addEventListener('abort', onAbort, { once: true });

  // Set when the delta side is finished with the session — normal socket
  // close, consumer break, abort, or error. The feeder observes it between
  // chunks so it never keeps pulling a LIVE audio source (which may simply
  // never end) into a session nobody is reading any more.
  let stopped = false;
  const iterator = audio[Symbol.asyncIterator]();

  try {
    socket.send(sessionUpdateEvent(options.model, opts));

    // Feed audio concurrently with event consumption: a realtime session
    // emits deltas WHILE audio is still arriving, so a send-then-read
    // sequence would deadlock on long streams.
    const feed = (async (): Promise<void> => {
      for (;;) {
        if (stopped || abort?.aborted) return;
        const next = await iterator.next();
        if (stopped || abort?.aborted) return;
        if (next.done) break;
        socket.send({
          type: 'input_audio_buffer.append',
          audio: Buffer.from(next.value).toString('base64'),
        });
      }
      socket.send({ type: 'input_audio_buffer.commit' });
    })();
    // A feeder failure must surface, not vanish into an unhandled rejection
    // while the event loop below waits forever on a starved session.
    let feedError: Error | undefined;
    const feedDone = feed.catch((err: unknown) => {
      feedError = err instanceof Error ? err : new Error(String(err));
      socket.close();
    });

    for await (const event of socket.events()) {
      const delta = mapRealtimeEvent(event);
      if (delta !== undefined) yield delta;
    }
    // Never `await feedDone` unconditionally: a live audio source with no
    // next chunk would park it (and this whole call) forever after the
    // server closed the session. Release the source and take the feeder's
    // verdict only if it is already settled / settles immediately.
    stopped = true;
    void Promise.resolve(iterator.return?.()).catch(() => undefined);
    await Promise.race([
      feedDone,
      new Promise((resolve) => {
        setImmediate(resolve);
      }),
    ]);
    if (feedError) throw feedError;
  } finally {
    stopped = true;
    void Promise.resolve(iterator.return?.()).catch(() => undefined);
    abort?.removeEventListener('abort', onAbort);
    socket.close();
  }
}

/** The `session.update` payload, with hints mapped onto the wire names. */
export function sessionUpdateEvent(
  model: string,
  opts: TranscribeOpts | undefined,
): Record<string, unknown> {
  const transcription: Record<string, unknown> = { model };
  if (opts?.context !== undefined && opts.context.trim() !== '') {
    transcription['prompt'] = opts.context;
  }
  if (opts?.keywordHints !== undefined && opts.keywordHints.length > 0) {
    transcription['keywords'] = [...opts.keywordHints];
  }
  if (opts?.languageHints !== undefined && opts.languageHints.length > 0) {
    transcription['languages'] = [...opts.languageHints];
  }
  return {
    type: 'session.update',
    session: {
      type: 'transcription',
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24_000 },
          transcription,
          turn_detection: null,
        },
      },
    },
  };
}

export type { RealtimeSocket };
