/**
 * #584 — audio skip-guard in the attachment auto-ingest path.
 *
 * Audio-content-type manifest entries must not fall through to
 * `extractAttachmentText`: transcription is an explicit agent tool
 * (`transcribe_recording`), never hidden channel magic, so the auto-ingest
 * pass skips audio candidates entirely — before the fetch (no point pulling
 * up to 25 MB of bytes just to discard them). The `storage_key` stays
 * visible in the `[attachments-info]` block of the user message so the tool
 * can pick it up.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type {
  ContentPart,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStreamEvent,
} from '@omadia/llm-provider';
import {
  type AttachmentReader,
  type ChatTurnAttachment,
  NativeToolRegistry,
  Orchestrator,
  isAudioAttachment,
} from '@omadia/orchestrator';

const providerCapabilities = {
  tools: true,
  vision: true,
  streaming: true,
  promptCaching: true,
  forcedToolChoice: true,
  parallelToolCalls: true,
} as const;

function textResponse(text: string): LlmResponse {
  return {
    content: [{ type: 'text', text }],
    finishReason: 'stop',
    providerFinishReason: 'end_turn',
    model: 'test',
    usage: {
      inputTokens: 10,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  };
}

function recordingProvider(requests: LlmRequest[]): LlmProvider {
  const provider = {
    id: 'anthropic',
    capabilities: providerCapabilities,
    complete: async (req: LlmRequest): Promise<LlmResponse> => {
      requests.push(req);
      return textResponse('ok');
    },
    stream: (): AsyncIterable<LlmStreamEvent> => {
      throw new Error('recordingProvider: stream() not scripted');
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  };
  return provider as unknown as LlmProvider;
}

function textOf(req: LlmRequest): string {
  const first = req.messages[0];
  if (!first) return '';
  if (typeof first.content === 'string') return first.content;
  return first.content
    .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

function fakeAttachmentReader(opts: {
  byStorageKey?: Record<
    string,
    { bytes: Buffer; contentType?: string; fileName?: string }
  >;
  byUrl?: Record<string, { bytes: Buffer; contentType?: string }>;
}): AttachmentReader & { calls: { storageKeys: string[]; urls: string[] } } {
  const calls = { storageKeys: [] as string[], urls: [] as string[] };
  return {
    calls,
    readByStorageKey: async (storageKey: string) => {
      calls.storageKeys.push(storageKey);
      return opts.byStorageKey?.[storageKey];
    },
    readByUrl: async (url: string) => {
      calls.urls.push(url);
      return opts.byUrl?.[url];
    },
  };
}

function makeOrchestrator(
  requests: LlmRequest[],
  reader: AttachmentReader,
): Orchestrator {
  return new Orchestrator({
    provider: recordingProvider(requests),
    model: 'test',
    maxTokens: 1024,
    maxToolIterations: 3,
    domainTools: [],
    nativeToolRegistry: new NativeToolRegistry(),
    attachmentReader: reader,
  });
}

describe('#584 — audio attachment skip-guard', () => {
  it('an audio manifest candidate is never fetched and produces no extracted text; the storage_key stays visible', async () => {
    const requests: LlmRequest[] = [];
    const reader = fakeAttachmentReader({
      byStorageKey: {
        // Scripted so that IF the guard failed and the candidate were fetched
        // anyway, extraction would see real bytes rather than the test
        // silently passing on an empty-candidate skip.
        'tigris:standup-rec': {
          bytes: Buffer.from('ID3 not really text'),
          contentType: 'audio/mpeg',
          fileName: 'standup.mp3',
        },
      },
    });
    const orch = makeOrchestrator(requests, reader);

    const userMessage =
      'Bitte transkribiere die Aufnahme.\n\n' +
      '[attachments-info] 1 Datei(en) in diesem Turn hochgeladen + persistiert:\n' +
      '- standup.mp3 (audio/mpeg, 2048 KB) · storage_key=tigris:standup-rec';

    await orch.runTurn({ userMessage, sessionScope: 'sess-1', userId: 'u1' });

    assert.equal(requests.length, 1);
    const text = textOf(requests[0]!);
    assert.ok(
      !text.includes('[attachment-content:'),
      'audio must never reach extractAttachmentText / produce a text block',
    );
    assert.ok(
      text.includes('storage_key=tigris:standup-rec'),
      'the storage_key must stay visible in the manifest for the transcribe tool',
    );
    assert.deepEqual(
      reader.calls.storageKeys,
      [],
      'the audio candidate must be skipped BEFORE the fetch',
    );
  });

  it('an audio attachments[] url candidate (non-Teams channel) is skipped the same way', async () => {
    const requests: LlmRequest[] = [];
    const reader = fakeAttachmentReader({
      byUrl: {
        'https://example.com/voicenote.ogg': {
          bytes: Buffer.from('OggS'),
          contentType: 'audio/ogg',
        },
      },
    });
    const orch = makeOrchestrator(requests, reader);

    const attachments: ChatTurnAttachment[] = [
      {
        kind: 'file',
        url: 'https://example.com/voicenote.ogg',
        mediaType: 'audio/ogg',
        name: 'voicenote.ogg',
      },
    ];

    await orch.runTurn({
      userMessage: 'Was wurde gesagt?',
      sessionScope: 'sess-1',
      userId: 'u1',
      attachments,
    });

    assert.equal(requests.length, 1);
    assert.ok(!textOf(requests[0]!).includes('[attachment-content:'));
    assert.deepEqual(reader.calls.urls, [], 'never fetched');
  });

  it('a non-audio sibling in the same manifest is still ingested normally', async () => {
    const requests: LlmRequest[] = [];
    const reader = fakeAttachmentReader({
      byStorageKey: {
        'tigris:notes': {
          bytes: Buffer.from('Meeting notes: ship slice four.'),
          contentType: 'text/plain',
          fileName: 'notes.txt',
        },
        'tigris:rec': {
          bytes: Buffer.from('RIFFxxxxWAVE'),
          contentType: 'audio/wav',
          fileName: 'rec.wav',
        },
      },
    });
    const orch = makeOrchestrator(requests, reader);

    const userMessage =
      'Fasse zusammen.\n\n' +
      '[attachments-info] 2 Datei(en) in diesem Turn hochgeladen + persistiert:\n' +
      '- notes.txt (text/plain, 1 KB) · storage_key=tigris:notes\n' +
      '- rec.wav (audio/wav, 4096 KB) · storage_key=tigris:rec';

    await orch.runTurn({ userMessage, sessionScope: 'sess-1', userId: 'u1' });

    assert.equal(requests.length, 1);
    const text = textOf(requests[0]!);
    assert.ok(
      text.includes('[attachment-content: notes.txt]'),
      'the text sibling must still be extracted',
    );
    assert.ok(text.includes('ship slice four'));
    assert.deepEqual(
      reader.calls.storageKeys,
      ['tigris:notes'],
      'only the non-audio candidate may be fetched',
    );
  });
});

describe('#584 — isAudioAttachment predicate', () => {
  it('accepts the nine provider formats by content-type and extension', () => {
    for (const ct of [
      'audio/flac',
      'audio/mpeg',
      'audio/mp3',
      'audio/mp4',
      'audio/x-m4a',
      'audio/ogg',
      'audio/wav',
      'audio/webm',
      'AUDIO/WAV; codecs=1',
    ]) {
      assert.equal(isAudioAttachment(ct, undefined), true, ct);
    }
    for (const name of [
      'a.flac',
      'a.mp3',
      'a.mp4',
      'a.mpeg',
      'a.mpga',
      'a.m4a',
      'a.ogg',
      'a.wav',
      'a.webm',
      'REC.WAV',
    ]) {
      assert.equal(isAudioAttachment(undefined, name), true, name);
    }
  });

  it('rejects non-audio types and names', () => {
    assert.equal(isAudioAttachment('text/plain', 'notes.txt'), false);
    assert.equal(isAudioAttachment('application/pdf', 'a.pdf'), false);
    assert.equal(isAudioAttachment('image/png', 'a.png'), false);
    assert.equal(isAudioAttachment(undefined, undefined), false);
    assert.equal(isAudioAttachment('', 'wav'), false); // no extension, just a name
  });
});
