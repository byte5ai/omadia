/**
 * #504/#505 — orchestrator-level coverage for the attachment auto-ingest
 * path's image handling: Teams `[attachments-info]` manifest images (#504)
 * and the `input.attachments[]` url-fallback for images without
 * `bytesBase64` (#505) must both end up as vision content-blocks on the
 * outgoing LLM request — not silently dropped, and not double-embedded when
 * an image is reachable through more than one candidate source.
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
} from '@omadia/orchestrator';

const providerCapabilities = {
  tools: true,
  vision: true,
  streaming: true,
  promptCaching: true,
  forcedToolChoice: true,
  parallelToolCalls: true,
} as const;

/** #504/#505 review round 2 — a provider/model with NO vision capability, to
 *  verify the guard: zero image content-blocks, but a visible note instead
 *  of a silent drop. */
const nonVisionProviderCapabilities = {
  ...providerCapabilities,
  vision: false,
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

/** Records every request the orchestrator sends and answers with fixed text. */
function recordingProvider(
  requests: LlmRequest[],
  capabilities: typeof providerCapabilities = providerCapabilities,
): LlmProvider {
  const provider = {
    id: 'anthropic',
    capabilities,
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

/** Image content-parts of the FIRST user message the provider saw. */
function imagePartsOf(req: LlmRequest): ContentPart[] {
  const first = req.messages[0];
  if (!first || typeof first.content === 'string') return [];
  return [...first.content].filter((p): p is ContentPart => p.type === 'image');
}

/** Plain text of the FIRST user message the provider saw — handles both the
 *  plain-string shape (no images) and the multimodal content-block array. */
function textOf(req: LlmRequest): string {
  const first = req.messages[0];
  if (!first) return '';
  if (typeof first.content === 'string') return first.content;
  return first.content
    .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

/** A fake `AttachmentReader` scripted with a fixed map of storageKey/url →
 *  fetch result, and a call log so tests can assert what was (not) fetched. */
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

type OrchestratorOptions = ConstructorParameters<typeof Orchestrator>[0];

function baseOrchestratorOptions(
  requests: LlmRequest[],
  attachmentReader: AttachmentReader,
  capabilities: typeof providerCapabilities = providerCapabilities,
): OrchestratorOptions {
  return {
    provider: recordingProvider(requests, capabilities),
    model: 'test',
    maxTokens: 1024,
    maxToolIterations: 3,
    domainTools: [],
    nativeToolRegistry: new NativeToolRegistry(),
    attachmentReader,
  };
}

describe('#504/#505 — vision attachment auto-ingest', () => {
  it('#504: a Teams-manifest image candidate is embedded via images, not extractAttachmentText', async () => {
    const requests: LlmRequest[] = [];
    const reader = fakeAttachmentReader({
      byStorageKey: {
        'tigris:photo-1': {
          bytes: PNG_BYTES,
          contentType: 'image/png',
          fileName: 'photo.png',
        },
      },
    });
    const orch = new Orchestrator(baseOrchestratorOptions(requests, reader));

    const userMessage =
      'Was ist auf dem Bild?\n\n' +
      '[attachments-info] 1 Datei(en) in diesem Turn hochgeladen + persistiert:\n' +
      '- photo.png (image/png, 4 KB) · storage_key=tigris:photo-1';

    await orch.runTurn({ userMessage, sessionScope: 'sess-1', userId: 'u1' });

    assert.equal(requests.length, 1);
    const images = imagePartsOf(requests[0]!);
    assert.equal(images.length, 1, 'the manifest image must reach the model as a vision block');
    const img = images[0]! as Extract<ContentPart, { type: 'image' }>;
    assert.equal(img.mediaType, 'image/png');
    assert.equal(img.data, PNG_BYTES.toString('base64'));

    // No `[attachment-content: …]` text block — it went through the vision
    // branch, not `extractAttachmentText`.
    const text = requests[0]!.messages[0]!.content
      .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
      .map((p) => p.text)
      .join('');
    assert.ok(!text.includes('[attachment-content:'));
  });

  it('#505: an attachments[] image with url + no bytesBase64 is fetched and embedded via images', async () => {
    const requests: LlmRequest[] = [];
    const reader = fakeAttachmentReader({
      byUrl: {
        'https://example.com/cat.png': { bytes: PNG_BYTES, contentType: 'image/png' },
      },
    });
    const orch = new Orchestrator(baseOrchestratorOptions(requests, reader));

    const attachments: ChatTurnAttachment[] = [
      {
        kind: 'image',
        url: 'https://example.com/cat.png',
        mediaType: 'image/png',
        name: 'cat.png',
      },
    ];

    await orch.runTurn({
      userMessage: 'Was zeigt das Bild?',
      sessionScope: 'sess-1',
      userId: 'u1',
      attachments,
    });

    assert.equal(requests.length, 1);
    const images = imagePartsOf(requests[0]!);
    assert.equal(images.length, 1, 'the url-only image attachment must be fetched and embedded');
    const img = images[0]! as Extract<ContentPart, { type: 'image' }>;
    assert.equal(img.data, PNG_BYTES.toString('base64'));
    assert.deepEqual(reader.calls.urls, ['https://example.com/cat.png']);
  });

  it('#505: an attachments[] image that already has bytesBase64 is left alone (not fetched again)', async () => {
    const requests: LlmRequest[] = [];
    const reader = fakeAttachmentReader({});
    const orch = new Orchestrator(baseOrchestratorOptions(requests, reader));

    const inlineBase64 = PNG_BYTES.toString('base64');
    const attachments: ChatTurnAttachment[] = [
      {
        kind: 'image',
        url: 'https://example.com/dog.png',
        mediaType: 'image/png',
        name: 'dog.png',
        bytesBase64: inlineBase64,
      },
    ];

    await orch.runTurn({
      userMessage: 'Was zeigt das Bild?',
      sessionScope: 'sess-1',
      userId: 'u1',
      attachments,
    });

    assert.equal(requests.length, 1);
    const images = imagePartsOf(requests[0]!);
    assert.equal(images.length, 1, 'exactly one image block — the inline one');
    const img = images[0]! as Extract<ContentPart, { type: 'image' }>;
    assert.equal(img.data, inlineBase64);
    // The pre-fetch pass must never have touched the network for this image.
    assert.deepEqual(reader.calls.urls, []);
    assert.deepEqual(reader.calls.storageKeys, []);
  });

  it('folds an ingested (manifest) image alongside an existing inline bytesBase64 image block', async () => {
    const requests: LlmRequest[] = [];
    const reader = fakeAttachmentReader({
      byStorageKey: {
        'tigris:chart-1': { bytes: PNG_BYTES, contentType: 'image/png', fileName: 'chart.png' },
      },
    });
    const orch = new Orchestrator(baseOrchestratorOptions(requests, reader));

    const inlineBytes = Buffer.from([0x47, 0x49, 0x46, 0x38]); // GIF magic
    const attachments: ChatTurnAttachment[] = [
      {
        kind: 'image',
        url: 'https://example.com/inline.gif',
        mediaType: 'image/gif',
        name: 'inline.gif',
        bytesBase64: inlineBytes.toString('base64'),
      },
    ];
    const userMessage =
      'Vergleiche die beiden Bilder.\n\n' +
      '[attachments-info] 1 Datei(en) in diesem Turn hochgeladen + persistiert:\n' +
      '- chart.png (image/png, 4 KB) · storage_key=tigris:chart-1';

    await orch.runTurn({ userMessage, sessionScope: 'sess-1', userId: 'u1', attachments });

    assert.equal(requests.length, 1);
    const images = imagePartsOf(requests[0]!) as Array<Extract<ContentPart, { type: 'image' }>>;
    assert.equal(images.length, 2, 'both the inline and the ingested image must be present');
    // Inline bytesBase64 blocks are built first, ingested ones appended after.
    assert.equal(images[0]!.mediaType, 'image/gif');
    assert.equal(images[0]!.data, inlineBytes.toString('base64'));
    assert.equal(images[1]!.mediaType, 'image/png');
    assert.equal(images[1]!.data, PNG_BYTES.toString('base64'));
  });

  it('de-dup guard: a manifest image candidate matching an already-inline-embedded filename is not double-sent', async () => {
    const requests: LlmRequest[] = [];
    const reader = fakeAttachmentReader({
      // Scripted so that IF the guard failed and the manifest candidate were
      // fetched anyway, the test would still see a second image block and fail
      // loudly rather than silently passing on an empty-candidate skip.
      byStorageKey: {
        'tigris:dup-1': { bytes: PNG_BYTES, contentType: 'image/png', fileName: 'photo.png' },
      },
    });
    const orch = new Orchestrator(baseOrchestratorOptions(requests, reader));

    const inlineBytes = Buffer.from([0x47, 0x49, 0x46, 0x38]);
    const attachments: ChatTurnAttachment[] = [
      {
        kind: 'image',
        url: 'https://example.com/photo.png',
        mediaType: 'image/png',
        name: 'photo.png',
        bytesBase64: inlineBytes.toString('base64'),
      },
    ];
    // Same filename as the inline attachment above — the structural overlap
    // the reviewer flagged as unguarded.
    const userMessage =
      'Bild anbei.\n\n' +
      '[attachments-info] 1 Datei(en) in diesem Turn hochgeladen + persistiert:\n' +
      '- photo.png (image/png, 4 KB) · storage_key=tigris:dup-1';

    await orch.runTurn({ userMessage, sessionScope: 'sess-1', userId: 'u1', attachments });

    assert.equal(requests.length, 1);
    const images = imagePartsOf(requests[0]!) as Array<Extract<ContentPart, { type: 'image' }>>;
    assert.equal(
      images.length,
      1,
      'the manifest candidate must be skipped once its filename matches an inline image',
    );
    assert.equal(images[0]!.data, inlineBytes.toString('base64'));
    assert.deepEqual(
      reader.calls.storageKeys,
      [],
      'the guarded candidate must never even be fetched',
    );
  });

  it('#504 review round 4: an oversized manifest image under a vision-capable provider is skipped, not embedded and not text-extracted, but leaves a visible note', async () => {
    const requests: LlmRequest[] = [];
    const reader = fakeAttachmentReader({
      byStorageKey: {
        'tigris:huge-1': {
          bytes: Buffer.alloc(5 * 1024 * 1024 + 1),
          contentType: 'image/png',
          fileName: 'huge.png',
        },
      },
    });
    const orch = new Orchestrator(baseOrchestratorOptions(requests, reader));

    const userMessage =
      'Bild anbei.\n\n' +
      '[attachments-info] 1 Datei(en) in diesem Turn hochgeladen + persistiert:\n' +
      '- huge.png (image/png, 5121 KB) · storage_key=tigris:huge-1';

    await orch.runTurn({ userMessage, sessionScope: 'sess-1', userId: 'u1' });

    assert.equal(requests.length, 1);
    assert.equal(imagePartsOf(requests[0]!).length, 0);
    // Round-4 finding: a guard rejection under a VISION-CAPABLE provider used
    // to be a silent console.warn with zero trace in the turn's text — the
    // exact silent-drop failure #504 exists to close, just triggered by size
    // instead of provider capability. Must now leave a visible note.
    const text = textOf(requests[0]!);
    assert.match(
      text,
      /1 image attachment.*could not be shown.*too large/,
      'a guard-rejected image must leave a visible note, not just a console.warn',
    );
  });
});

describe('#504/#505 review round 2 — vision-capability guard', () => {
  it('a Teams-manifest image is never embedded for a non-vision provider, and leaves a visible note', async () => {
    const requests: LlmRequest[] = [];
    const reader = fakeAttachmentReader({
      byStorageKey: {
        'tigris:photo-1': {
          bytes: PNG_BYTES,
          contentType: 'image/png',
          fileName: 'photo.png',
        },
      },
    });
    const orch = new Orchestrator(
      baseOrchestratorOptions(requests, reader, nonVisionProviderCapabilities),
    );

    const userMessage =
      'Was ist auf dem Bild?\n\n' +
      '[attachments-info] 1 Datei(en) in diesem Turn hochgeladen + persistiert:\n' +
      '- photo.png (image/png, 4 KB) · storage_key=tigris:photo-1';

    await orch.runTurn({ userMessage, sessionScope: 'sess-1', userId: 'u1' });

    assert.equal(requests.length, 1);
    assert.equal(
      imagePartsOf(requests[0]!).length,
      0,
      'no image content-block may be built for a non-vision provider',
    );
    // The candidate must never even be fetched — vision-unsupported image
    // candidates are skipped before the network round-trip.
    assert.deepEqual(reader.calls.storageKeys, []);
    const text = textOf(requests[0]!);
    assert.match(
      text,
      /1 image attachment.*received but the active model does not support image input/,
      'a visible note must replace the silently-dropped image, not a silent no-op',
    );
  });

  it('an attachments[] bytesBase64 image is never embedded for a non-vision provider, and leaves a visible note', async () => {
    const requests: LlmRequest[] = [];
    const reader = fakeAttachmentReader({});
    const orch = new Orchestrator(
      baseOrchestratorOptions(requests, reader, nonVisionProviderCapabilities),
    );

    const attachments: ChatTurnAttachment[] = [
      {
        kind: 'image',
        url: 'https://example.com/dog.png',
        mediaType: 'image/png',
        name: 'dog.png',
        bytesBase64: PNG_BYTES.toString('base64'),
      },
    ];

    await orch.runTurn({
      userMessage: 'Was zeigt das Bild?',
      sessionScope: 'sess-1',
      userId: 'u1',
      attachments,
    });

    assert.equal(requests.length, 1);
    assert.equal(imagePartsOf(requests[0]!).length, 0);
    const text = textOf(requests[0]!);
    assert.match(
      text,
      /1 image attachment.*received but the active model does not support image input/,
    );
  });

  it('an attachments[] url-only image is never fetched for a non-vision provider, and leaves a visible note', async () => {
    const requests: LlmRequest[] = [];
    const reader = fakeAttachmentReader({
      byUrl: {
        'https://example.com/cat.png': { bytes: PNG_BYTES, contentType: 'image/png' },
      },
    });
    const orch = new Orchestrator(
      baseOrchestratorOptions(requests, reader, nonVisionProviderCapabilities),
    );

    const attachments: ChatTurnAttachment[] = [
      {
        kind: 'image',
        url: 'https://example.com/cat.png',
        mediaType: 'image/png',
        name: 'cat.png',
      },
    ];

    await orch.runTurn({
      userMessage: 'Was zeigt das Bild?',
      sessionScope: 'sess-1',
      userId: 'u1',
      attachments,
    });

    assert.equal(requests.length, 1);
    assert.equal(imagePartsOf(requests[0]!).length, 0);
    // Never fetched — a non-vision provider can't use the bytes anyway.
    assert.deepEqual(reader.calls.urls, []);
    const text = textOf(requests[0]!);
    assert.match(
      text,
      /1 image attachment.*received but the active model does not support image input/,
    );
  });

  it('vision-capable providers are unaffected — no note, images embedded as before', async () => {
    const requests: LlmRequest[] = [];
    const reader = fakeAttachmentReader({
      byStorageKey: {
        'tigris:photo-1': {
          bytes: PNG_BYTES,
          contentType: 'image/png',
          fileName: 'photo.png',
        },
      },
    });
    const orch = new Orchestrator(baseOrchestratorOptions(requests, reader));

    const userMessage =
      'Was ist auf dem Bild?\n\n' +
      '[attachments-info] 1 Datei(en) in diesem Turn hochgeladen + persistiert:\n' +
      '- photo.png (image/png, 4 KB) · storage_key=tigris:photo-1';

    await orch.runTurn({ userMessage, sessionScope: 'sess-1', userId: 'u1' });

    assert.equal(requests.length, 1);
    assert.equal(imagePartsOf(requests[0]!).length, 1);
    const text = textOf(requests[0]!);
    assert.ok(
      !text.includes('does not support image input'),
      'a vision-capable provider must never see the guard note',
    );
  });
});
