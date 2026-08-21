import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  TranscriptionRequestError,
  createOpenAiBatchTranscriber,
  normaliseBaseUrl,
  parseTranscriptionResponse,
} from '../src/batchProvider.js';

type FetchArgs = { url: string; init: Record<string, unknown> };

/** fetch fake that records the request and answers with a canned JSON body. */
function fakeFetch(response: { status?: number; body: unknown }): {
  impl: typeof fetch;
  calls: FetchArgs[];
} {
  const calls: FetchArgs[] = [];
  const impl = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: init as Record<string, unknown> });
    const status = response.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => response.body,
      text: async () => JSON.stringify(response.body),
    };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('normaliseBaseUrl', () => {
  it('accepts base with and without /v1 and trailing slashes', () => {
    assert.equal(normaliseBaseUrl('https://api.openai.com'), 'https://api.openai.com');
    assert.equal(normaliseBaseUrl('https://api.openai.com/'), 'https://api.openai.com');
    assert.equal(normaliseBaseUrl('https://api.openai.com/v1'), 'https://api.openai.com');
  });
});

describe('createOpenAiBatchTranscriber', () => {
  const make = (response: { status?: number; body: unknown }) => {
    const { impl, calls } = fakeFetch(response);
    const transcriber = createOpenAiBatchTranscriber({
      baseUrl: 'https://api.openai.com',
      apiKey: 'sk-test',
      model: 'gpt-transcribe',
      timeoutMs: 5_000,
      fetchImpl: impl as never,
    });
    return { transcriber, calls };
  };

  it('POSTs multipart to /v1/audio/transcriptions with bearer auth and the model', async () => {
    const { transcriber, calls } = make({ body: { text: 'hallo welt' } });
    const result = await transcriber.transcribeFile({
      bytes: new Uint8Array([1, 2, 3]),
      fileName: 'meeting.wav',
      contentType: 'audio/wav',
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, 'https://api.openai.com/v1/audio/transcriptions');
    const headers = calls[0]?.init['headers'] as Record<string, string>;
    assert.equal(headers['Authorization'], 'Bearer sk-test');
    const form = calls[0]?.init['body'] as FormData;
    assert.equal(form.get('model'), 'gpt-transcribe');
    assert.equal(result.text, 'hallo welt');
    assert.equal(result.provider, 'openai:gpt-transcribe');
    assert.deepEqual(result.segments, [{ text: 'hallo welt' }]);
  });

  it('maps hints onto the wire: context→prompt, keywords[] and languages[] (plural!) repeated entries', async () => {
    const { transcriber, calls } = make({ body: { text: 'x' } });
    await transcriber.transcribeFile(
      { bytes: new Uint8Array([1]) },
      {
        context: 'Standup zum Projekt Omadia',
        keywordHints: ['Omadia', 'Facilitator'],
        languageHints: ['de', 'en'],
      },
    );
    const form = calls[0]?.init['body'] as FormData;
    assert.equal(form.get('prompt'), 'Standup zum Projekt Omadia');
    assert.deepEqual(form.getAll('keywords[]'), ['Omadia', 'Facilitator']);
    assert.deepEqual(form.getAll('languages[]'), ['de', 'en']);
    // The legacy singular field must not appear for the new models.
    assert.equal(form.get('language'), null);
  });

  it('parses rich responses (segments with seconds offsets, speaker, duration, language)', () => {
    const transcript = parseTranscriptionResponse(
      {
        text: 'a b',
        language: 'de',
        duration: 12.5,
        segments: [
          { text: 'a', start: 0, end: 1.5, speaker: 'A' },
          { text: 'b', start: 1.5, end: 12.5 },
          { text: '', start: 90, end: 91 }, // empty → dropped
          'garbage',
        ],
      },
      'openai:gpt-transcribe',
    );
    assert.equal(transcript.durationMs, 12_500);
    assert.equal(transcript.language, 'de');
    assert.deepEqual(transcript.segments, [
      { text: 'a', startMs: 0, endMs: 1_500, speaker: 'A' },
      { text: 'b', startMs: 1_500, endMs: 12_500 },
    ]);
  });

  it('surfaces HTTP failures as TranscriptionRequestError with the status', async () => {
    const { transcriber } = make({ status: 401, body: { error: 'bad key' } });
    await assert.rejects(
      transcriber.transcribeFile({ bytes: new Uint8Array([1]) }),
      (err: unknown) =>
        err instanceof TranscriptionRequestError && err.status === 401,
    );
  });
});
