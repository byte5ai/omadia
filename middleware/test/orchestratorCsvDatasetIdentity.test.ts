/**
 * #430 fixup (reviewer round 2, finding 1) — orchestrator-level coverage for
 * the chat-attachment CSV auto-ingest path's dataset ownership. Before the
 * fix, `ingestAttachments` wrote `ownerOmadiaUserId: input.userId` directly —
 * for a channel turn that's the RAW channel-native id (Teams AAD oid, …),
 * NOT the canonical `omadiaUserId` uuid the KG's ACL routes filter on. This
 * verifies the resolved identity (via `input.channelIdentity` +
 * `KnowledgeGraph.resolveOrCreateChannelIdentity`) is what actually gets
 * used as the dataset owner.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { LlmProvider, LlmRequest, LlmResponse, LlmStreamEvent } from '@omadia/llm-provider';
import {
  type AttachmentReader,
  NativeToolRegistry,
  Orchestrator,
} from '@omadia/orchestrator';
import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';

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
    usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  };
}

/** Same fake-provider pattern as `orchestratorVisionAttachmentIngest.test.ts`. */
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

function fakeAttachmentReader(byStorageKey: Record<string, { bytes: Buffer; contentType?: string; fileName?: string }>): AttachmentReader {
  return {
    readByStorageKey: async (storageKey: string) => byStorageKey[storageKey],
    readByUrl: async () => undefined,
  };
}

const CSV_BYTES = Buffer.from('name,age\nAda,36\nGrace,85\n', 'utf8');

const CSV_MANIFEST =
  'Hier ist die Datei.\n\n' +
  '[attachments-info] 1 Datei(en) in diesem Turn hochgeladen + persistiert:\n' +
  '- data.csv (text/csv, 1 KB) · storage_key=tigris:csv-1';

type OrchestratorOptions = ConstructorParameters<typeof Orchestrator>[0];

function options(
  requests: LlmRequest[],
  knowledgeGraph: InMemoryKnowledgeGraph,
): OrchestratorOptions {
  return {
    provider: recordingProvider(requests),
    model: 'test',
    maxTokens: 1024,
    maxToolIterations: 3,
    domainTools: [],
    nativeToolRegistry: new NativeToolRegistry(),
    attachmentReader: fakeAttachmentReader({
      'tigris:csv-1': { bytes: CSV_BYTES, contentType: 'text/csv', fileName: 'data.csv' },
    }),
    knowledgeGraph,
  } as OrchestratorOptions;
}

describe('#430 fixup — CSV dataset-import ACL identity resolution', () => {
  it('resolves a channel turn (channelIdentity present) to the canonical omadiaUserId, NOT the raw channel-native id', async () => {
    const requests: LlmRequest[] = [];
    const graph = new InMemoryKnowledgeGraph();
    const orch = new Orchestrator(options(requests, graph));

    // Pre-resolve what the canonical id WILL be, so we can assert against it
    // without depending on internal id-generation details.
    const expected = await graph.resolveOrCreateChannelIdentity({
      channelKind: 'teams',
      channelUserId: 'aad-oid-123',
    });

    await orch.runTurn({
      userMessage: CSV_MANIFEST,
      sessionScope: 'sess-1',
      userId: 'aad-oid-123', // raw channel-native id, as the real dispatcher sets it
      channelIdentity: { channelKind: 'teams', channelUserId: 'aad-oid-123' },
    });

    const owned = await graph.listDatasets({ ownerOmadiaUserId: expected.omadiaUserId });
    assert.equal(owned.length, 1, 'the dataset must be owned by the RESOLVED omadiaUserId');

    const wronglyOwned = await graph.listDatasets({ ownerOmadiaUserId: 'aad-oid-123' });
    assert.equal(
      wronglyOwned.length,
      0,
      'the raw channel-native id must NOT own the dataset (the bug this fixup closes)',
    );
  });

  it('uses input.userId as-is for an HTTP/CLI turn (no channelIdentity — userId already IS canonical)', async () => {
    const requests: LlmRequest[] = [];
    const graph = new InMemoryKnowledgeGraph();
    const orch = new Orchestrator(options(requests, graph));

    await orch.runTurn({
      userMessage: CSV_MANIFEST,
      sessionScope: 'sess-1',
      userId: 'a1b2c3d4-0000-0000-0000-000000000001', // already-canonical uuid, e.g. from req.session.omadia_user_id
    });

    const owned = await graph.listDatasets({
      ownerOmadiaUserId: 'a1b2c3d4-0000-0000-0000-000000000001',
    });
    assert.equal(owned.length, 1);
  });

  it('refuses the file WITHOUT leaking its rows as plain text when the uploading user cannot be resolved', async () => {
    const requests: LlmRequest[] = [];
    const graph = new InMemoryKnowledgeGraph();
    const orch = new Orchestrator(options(requests, graph));

    await orch.runTurn({ userMessage: CSV_MANIFEST, sessionScope: 'sess-1' });

    const stats = await graph.stats();
    assert.equal(stats.byNodeType['PluginEntity'] ?? 0, 0, 'no Dataset node should have been created');

    // The regression this guards: `ingestAttachments` used to fall through to
    // the plain-text path here, appending every CSV row to the prompt as
    // `[attachment-content]` cleartext — bypassing the per-cell privacy scan
    // exactly when the dataset pipeline was unavailable. A tabular upload now
    // either becomes a scanned dataset or is refused; it is never inlined.
    const wire = JSON.stringify(requests);
    assert.equal(wire.includes('Ada'), false, 'CSV row values must not reach the model');
    assert.equal(wire.includes('Grace'), false, 'CSV row values must not reach the model');
    assert.equal(
      wire.includes('attachment-not-ingested'),
      true,
      'the model must be told the file was not ingested',
    );
  });
});
