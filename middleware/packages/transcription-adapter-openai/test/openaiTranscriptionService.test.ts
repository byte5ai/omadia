import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import { describe, it } from 'node:test';

import { TranscriptionError } from '@omadia/transcription-api';

import {
  classifyOpenAiTranscriptionError,
  createOpenAiTranscriptionService,
} from '../src/openaiTranscriptionService.js';

/**
 * Adapter ↔ OpenAI HTTP boundary tests: a local `node:http` server plays the
 * provider endpoint (the SDK takes an injected baseURL), so the assertions run
 * against the real wire shape — multipart request, hint params, SDK retries —
 * with no SDK-internal mocking.
 */

interface RecordedRequest {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: Record<string, string | string[] | undefined>;
  /** latin1 so the multipart body (binary parts included) survives as text. */
  readonly body: string;
}

interface ProgrammedResponse {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
  /** Delay before answering — used to leave room for an abort. */
  readonly delayMs?: number;
}

interface FakeProvider {
  readonly baseURL: string;
  readonly requests: RecordedRequest[];
}

async function withFakeProvider(
  responses: ProgrammedResponse[],
  run: (provider: FakeProvider) => Promise<void>,
): Promise<void> {
  const requests: RecordedRequest[] = [];
  const pending: NodeJS.Timeout[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('latin1'),
      });
      const programmed = responses.shift() ?? { status: 500 };
      const answer = (): void => {
        res.writeHead(programmed.status, {
          'content-type': 'application/json',
          ...(programmed.headers ?? {}),
        });
        res.end(JSON.stringify(programmed.body ?? {}));
      };
      if (programmed.delayMs !== undefined) {
        pending.push(setTimeout(answer, programmed.delayMs));
      } else {
        answer();
      }
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('fake provider did not bind a port');
  }
  try {
    await run({ baseURL: `http://127.0.0.1:${String(address.port)}/v1`, requests });
  } finally {
    for (const t of pending) clearTimeout(t);
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
}

function serviceFor(provider: FakeProvider, maxRetries = 0) {
  return createOpenAiTranscriptionService({
    apiKey: 'test-key',
    baseURL: provider.baseURL,
    maxRetries,
  });
}

const AUDIO = {
  data: new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00]),
  filename: 'meeting.mp3',
  mimeType: 'audio/mpeg',
};

async function expectTranscriptionError(
  promise: Promise<unknown>,
): Promise<TranscriptionError> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof TranscriptionError, `expected TranscriptionError, got ${String(err)}`);
    return err;
  }
  throw new Error('expected the call to throw');
}

describe('createOpenAiTranscriptionService — transcribeFile', () => {
  it('sends a multipart request with mapped hint params and returns one seg-0 segment', async () => {
    await withFakeProvider(
      [{ status: 200, body: { text: 'Hallo Welt', languages: [{ code: 'de' }, { code: 'en' }] } }],
      async (provider) => {
        const result = await serviceFor(provider).transcribeFile(AUDIO, {
          languageHints: ['de', 'en'],
          keywordHints: ['omadia', 'Kanban'],
          context: 'Weekly team sync recording',
        });

        // --- result mapping ---
        assert.equal(result.segments.length, 1);
        const segment = result.segments[0];
        assert.ok(segment);
        assert.equal(segment.id, 'seg-0');
        assert.equal(segment.text, 'Hallo Welt');
        assert.deepEqual(segment.detectedLanguages, ['de', 'en']);
        assert.equal(segment.speaker, undefined);
        assert.equal(result.timing, 'none');
        assert.deepEqual(result.detectedLanguages, ['de', 'en']);
        assert.deepEqual(result.usage, { attempts: 1 });

        // --- request shape ---
        assert.equal(provider.requests.length, 1);
        const request = provider.requests[0];
        assert.ok(request);
        assert.equal(request.method, 'POST');
        assert.equal(request.url, '/v1/audio/transcriptions');
        assert.equal(request.headers['authorization'], 'Bearer test-key');
        assert.match(String(request.headers['content-type']), /^multipart\/form-data; boundary=/);
        assert.match(request.body, /name="model"\r\n\r\ngpt-transcribe\r\n/);
        assert.match(request.body, /name="languages\[\]"\r\n\r\nde\r\n/);
        assert.match(request.body, /name="languages\[\]"\r\n\r\nen\r\n/);
        assert.match(request.body, /name="keywords\[\]"\r\n\r\nomadia\r\n/);
        assert.match(request.body, /name="keywords\[\]"\r\n\r\nKanban\r\n/);
        assert.match(request.body, /name="prompt"\r\n\r\nWeekly team sync recording\r\n/);
        assert.match(request.body, /name="file"; filename="meeting.mp3"/);
        assert.match(request.body, /Content-Type: audio\/mpeg/i);
      },
    );
  });

  it('omits hint params and detectedLanguages when not provided', async () => {
    await withFakeProvider(
      [{ status: 200, body: { text: 'hello', languages: [] } }],
      async (provider) => {
        const result = await serviceFor(provider).transcribeFile(AUDIO);
        assert.equal(result.detectedLanguages, undefined);
        assert.equal(result.segments[0]?.detectedLanguages, undefined);
        const request = provider.requests[0];
        assert.ok(request);
        assert.doesNotMatch(request.body, /name="languages\[\]"/);
        assert.doesNotMatch(request.body, /name="keywords\[\]"/);
        assert.doesNotMatch(request.body, /name="prompt"/);
      },
    );
  });

  it("classifies 401 as 'auth' with partial usage", async () => {
    await withFakeProvider(
      [{ status: 401, body: { error: { message: 'Incorrect API key provided', code: 'invalid_api_key' } } }],
      async (provider) => {
        const err = await expectTranscriptionError(
          serviceFor(provider).transcribeFile(AUDIO),
        );
        assert.equal(err.code, 'auth');
        assert.deepEqual(err.usage, { attempts: 1 });
        assert.ok(err.cause instanceof Error);
      },
    );
  });

  it("classifies 413 as 'too-large'", async () => {
    await withFakeProvider(
      [{ status: 413, body: { error: { message: 'Maximum content size limit (26214400) exceeded' } } }],
      async (provider) => {
        const err = await expectTranscriptionError(
          serviceFor(provider).transcribeFile(AUDIO),
        );
        assert.equal(err.code, 'too-large');
      },
    );
  });

  it("classifies a 400 format complaint as 'unsupported-format'", async () => {
    await withFakeProvider(
      [{ status: 400, body: { error: { message: "Invalid file format. Supported formats: ['flac', 'mp3', …]" } } }],
      async (provider) => {
        const err = await expectTranscriptionError(
          serviceFor(provider).transcribeFile(AUDIO),
        );
        assert.equal(err.code, 'unsupported-format');
      },
    );
  });

  it("classifies an unrecognised failure as 'provider'", async () => {
    await withFakeProvider(
      [{ status: 400, body: { error: { message: 'something else entirely' } } }],
      async (provider) => {
        const err = await expectTranscriptionError(
          serviceFor(provider).transcribeFile(AUDIO),
        );
        assert.equal(err.code, 'provider');
      },
    );
  });

  it('counts SDK-internal retries into usage.attempts on success', async () => {
    await withFakeProvider(
      [
        { status: 500, body: { error: { message: 'flaky' } }, headers: { 'retry-after-ms': '1' } },
        { status: 200, body: { text: 'second try' } },
      ],
      async (provider) => {
        const result = await serviceFor(provider, 2).transcribeFile(AUDIO);
        assert.equal(result.segments[0]?.text, 'second try');
        assert.deepEqual(result.usage, { attempts: 2 });
        assert.equal(provider.requests.length, 2);
      },
    );
  });

  it('counts every retry into the partial usage when all attempts fail', async () => {
    const flaky = {
      status: 500,
      body: { error: { message: 'still broken' } },
      headers: { 'retry-after-ms': '1' },
    };
    await withFakeProvider([flaky, flaky], async (provider) => {
      const err = await expectTranscriptionError(
        serviceFor(provider, 1).transcribeFile(AUDIO),
      );
      assert.equal(err.code, 'provider');
      assert.deepEqual(err.usage, { attempts: 2 });
      assert.equal(provider.requests.length, 2);
    });
  });

  it("surfaces an AbortSignal as 'aborted'", async () => {
    await withFakeProvider(
      [{ status: 200, body: { text: 'never delivered' }, delayMs: 5_000 }],
      async (provider) => {
        const controller = new AbortController();
        const call = serviceFor(provider).transcribeFile(AUDIO, {
          signal: controller.signal,
        });
        setTimeout(() => {
          controller.abort();
        }, 50);
        const err = await expectTranscriptionError(call);
        assert.equal(err.code, 'aborted');
        assert.deepEqual(err.usage, { attempts: 1 });
      },
    );
  });
});

describe('classifyOpenAiTranscriptionError — branches not reachable via the fake provider tests above', () => {
  function apiError(props: {
    status?: number;
    code?: string;
    nestedCode?: string;
    message?: string;
  }): Error {
    const err = new Error(props.message ?? 'boom') as Error & {
      status?: number;
      code?: string;
      error?: { code?: string };
    };
    if (props.status !== undefined) err.status = props.status;
    if (props.code !== undefined) err.code = props.code;
    if (props.nestedCode !== undefined) err.error = { code: props.nestedCode };
    return err;
  }

  it("maps 403 to 'auth'", () => {
    assert.equal(classifyOpenAiTranscriptionError(apiError({ status: 403 })), 'auth');
  });

  it("maps machine-readable auth codes without a status to 'auth' (top-level and nested)", () => {
    assert.equal(
      classifyOpenAiTranscriptionError(apiError({ code: 'invalid_api_key' })),
      'auth',
    );
    assert.equal(
      classifyOpenAiTranscriptionError(apiError({ nestedCode: 'permission_denied' })),
      'auth',
    );
  });

  it("maps 415 to 'unsupported-format'", () => {
    assert.equal(
      classifyOpenAiTranscriptionError(apiError({ status: 415 })),
      'unsupported-format',
    );
  });

  it("maps a 400 size complaint to 'too-large'", () => {
    assert.equal(
      classifyOpenAiTranscriptionError(
        apiError({ status: 400, message: 'Maximum content size limit (26214400) exceeded' }),
      ),
      'too-large',
    );
  });

  it("maps non-Error garbage to 'provider'", () => {
    assert.equal(classifyOpenAiTranscriptionError('string failure'), 'provider');
    assert.equal(classifyOpenAiTranscriptionError(undefined), 'provider');
  });
});

describe('createOpenAiTranscriptionService — transcribeStream stub', () => {
  it('throws a not-implemented TranscriptionError before yielding anything', () => {
    const service = createOpenAiTranscriptionService({ apiKey: 'test-key' });
    assert.throws(
      () =>
        service.transcribeStream(
          (async function* (): AsyncIterable<Uint8Array> {
            yield new Uint8Array([0]);
          })(),
          { format: { encoding: 'pcm16', sampleRateHz: 16_000, channels: 1 } },
        ),
      (err: unknown) =>
        err instanceof TranscriptionError &&
        err.code === 'provider' &&
        /not implemented/i.test(err.message),
    );
  });
});
