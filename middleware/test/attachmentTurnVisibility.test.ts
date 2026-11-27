/**
 * #1976 / #1978 — the attachment tools and the auto-ingest drops, driven
 * through the real `Orchestrator`.
 *
 * #1976: `read_attachment` is offered only on a turn that came in through a
 * messaging channel; the web chat (no origin) has no upload, so the tool is
 * not on its list. The not-found answer never sends the user to re-upload or
 * to internal markup.
 *
 * #1978: every attachment auto-ingest cannot read leaves an
 * `[attachment-not-ingested]` block with a plain reason; a corrupt XLSX never
 * hands the library's error text to the model.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { LlmProvider, LlmRequest, LlmResponse } from '@omadia/llm-provider';
import {
  type AttachmentReader,
  NativeToolRegistry,
  Orchestrator,
  parseXlsx,
  ReadAttachmentTool,
  runWithToolCallContext,
  turnMayCarryUploads,
} from '@omadia/orchestrator';

function recordingProvider(requests: LlmRequest[]): LlmProvider {
  const response: LlmResponse = {
    content: [{ type: 'text', text: 'ok' }],
    finishReason: 'stop',
    providerFinishReason: 'end_turn',
    model: 'test',
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  };
  return {
    id: 'anthropic',
    capabilities: {
      tools: true,
      vision: true,
      streaming: true,
      promptCaching: true,
      forcedToolChoice: true,
      parallelToolCalls: true,
    },
    complete: (req: LlmRequest): Promise<LlmResponse> => {
      requests.push(req);
      return Promise.resolve(response);
    },
    stream: () => {
      throw new Error('not used');
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  } as unknown as LlmProvider;
}

function reader(files: Record<string, { bytes: Buffer; contentType: string }>): AttachmentReader {
  return {
    readByStorageKey: (key: string) => Promise.resolve(files[key]),
    readByUrl: () => Promise.resolve(undefined),
  };
}

function orchestrator(requests: LlmRequest[], attachmentReader: AttachmentReader): Orchestrator {
  return new Orchestrator({
    provider: recordingProvider(requests),
    model: 'test',
    maxTokens: 256,
    maxToolIterations: 2,
    domainTools: [],
    nativeToolRegistry: new NativeToolRegistry(),
    attachmentReader,
  } as unknown as ConstructorParameters<typeof Orchestrator>[0]);
}

const TEAMS_ORIGIN = {
  channelType: 'teams',
  scope: { kind: 'personal', userId: 'u1' },
} as const;

function firstUserText(req: LlmRequest | undefined): string {
  const first = req?.messages[0];
  if (!first) return '';
  if (typeof first.content === 'string') return first.content;
  return first.content.map((p) => (p.type === 'text' ? p.text : '')).join('');
}

function toolNames(req: LlmRequest | undefined): string[] {
  return (req?.tools ?? []).map((t) => (t as { name: string }).name);
}

describe('#1976 — read_attachment only where an upload can exist', () => {
  it('the web chat (no origin) is not offered read_attachment', async () => {
    const requests: LlmRequest[] = [];
    await orchestrator(requests, reader({})).runTurn({
      userMessage: 'Lies den Anhang gibtesnicht.txt',
      sessionScope: 's1976-web',
    });
    assert.ok(!toolNames(requests[0]).includes('read_attachment'));
  });

  it('a channel turn is offered read_attachment', async () => {
    const requests: LlmRequest[] = [];
    await orchestrator(requests, reader({})).runTurn({
      userMessage: 'Lies den Anhang',
      sessionScope: 's1976-teams',
      userId: 'u1',
      origin: TEAMS_ORIGIN,
    } as unknown as Parameters<Orchestrator['runTurn']>[0]);
    assert.ok(toolNames(requests[0]).includes('read_attachment'));
  });

  it('an older channel plugin without origin but with a channel user is offered it', async () => {
    const requests: LlmRequest[] = [];
    await orchestrator(requests, reader({})).runTurn({
      userMessage: 'Lies den Anhang',
      sessionScope: 's1976-legacy',
      userId: 'tg-1',
      channelIdentity: { channelKind: 'telegram', channelUserId: 'tg-1' },
    } as unknown as Parameters<Orchestrator['runTurn']>[0]);
    assert.ok(toolNames(requests[0]).includes('read_attachment'));
  });

  it('the subscription-CLI carrier counts too (runWithToolCallContext)', () => {
    assert.equal(turnMayCarryUploads(), false, 'outside a turn: no');
    assert.equal(
      runWithToolCallContext({ agentSlug: 'a', channelType: 'teams' }, () => turnMayCarryUploads()),
      true,
    );
    assert.equal(
      runWithToolCallContext({ agentSlug: 'a', channelType: 'http' }, () => turnMayCarryUploads()),
      false,
    );
  });

  it('not found: no re-upload request, no internal markup', async () => {
    const tool = new ReadAttachmentTool(reader({}));
    const result = await tool.handle({ storage_key: 'gibtesnicht.txt' });
    assert.match(result, /^Error: no uploaded file/);
    assert.ok(!result.includes('[attachments-info]'));
    assert.ok(!/upload it again|re-upload|noch einmal/i.test(result));
  });
});

describe('#1978 — every dropped attachment leaves a visible block', () => {
  const manifest =
    'Was steht in den Dateien?\n\n' +
    '[attachments-info] 3 Datei(en) in diesem Turn hochgeladen + persistiert:\n' +
    '- broken.pdf (application/pdf, 1 KB) · storage_key=uploads/broken.pdf\n' +
    '- deck.pptx (application/vnd.openxmlformats-officedocument.presentationml.presentation, 1 KB) · storage_key=uploads/deck.pptx\n' +
    '- gone.docx (application/vnd.openxmlformats-officedocument.wordprocessingml.document, 1 KB) · storage_key=uploads/gone.docx';

  it('damaged, unsupported and missing files each get a plain reason', async () => {
    const requests: LlmRequest[] = [];
    await orchestrator(
      requests,
      reader({
        'uploads/broken.pdf': { bytes: Buffer.from('not a pdf at all'), contentType: 'application/pdf' },
        'uploads/deck.pptx': {
          bytes: Buffer.from('PK'),
          contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        },
      }),
    ).runTurn({
      userMessage: manifest,
      // ADR-0178: the kernel ingests only what the channel adapter states.
      storedAttachments: [
        { fileName: 'broken.pdf', contentType: 'application/pdf', storageKey: 'uploads/broken.pdf' },
        {
          fileName: 'deck.pptx',
          contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          storageKey: 'uploads/deck.pptx',
        },
        {
          fileName: 'gone.docx',
          contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          storageKey: 'uploads/gone.docx',
        },
      ],
      sessionScope: 's1978',
      userId: 'u1',
    } as unknown as Parameters<Orchestrator['runTurn']>[0]);
    const text = firstUserText(requests[0]);
    assert.ok(text.includes('[attachment-not-ingested: broken.pdf]'), text);
    assert.ok(text.includes('the file is damaged or unreadable'), text);
    assert.ok(text.includes('[attachment-not-ingested: deck.pptx]'), text);
    assert.ok(text.includes('the file type is not supported'), text);
    assert.ok(text.includes('[attachment-not-ingested: gone.docx]'), text);
    assert.ok(text.includes('the file was not found in storage'), text);
    // The technical detail stays in the server log.
    assert.ok(!text.includes('extraction failed'), text);
    assert.ok(!text.includes('contentType='), text);
  });

  it('a corrupt XLSX states a plain reason, never the jszip text', async () => {
    const result = await parseXlsx(Buffer.from('this is not a zip file'));
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.reason === 'the file is damaged or unreadable (not a valid XLSX workbook)');
    assert.ok(!result.ok && !/jszip|central directory|https?:/i.test(result.reason));
  });
});
