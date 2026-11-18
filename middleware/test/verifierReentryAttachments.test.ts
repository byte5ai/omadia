/**
 * A verifier re-entry never imports the request's uploads again.
 *
 * A tabular upload (CSV, XLSX) becomes a dataset before the model runs:
 * `ingestAttachments` → `importTabularDataset` → `KnowledgeGraph.ingestDataset`,
 * a plain insert of a new dataset with no dedupe. That runs once per turn, and
 * a verifier re-entry (borderline resample, correction retry, the stream's
 * retry) is a turn of its own — so one request imported the same file two or
 * three times as separate datasets, and the re-entry's model was told a
 * dataset id that matched none of the replayed first-run tool results.
 *
 * A re-entry now reuses the first run's ingestion: the same dataset ids and
 * the same `[dataset-imported]` blocks, masked through the re-entry's own
 * prompt map. A re-entry that finds no first-run ingestion to reuse is
 * abandoned rather than importing.
 *
 * Drives the REAL `Orchestrator` under the REAL `VerifierService`; only the
 * model, the attachment store, the knowledge graph's dataset insert, the
 * pipeline and the verdict store are scripted. All values are synthetic.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { LlmRequest } from '@omadia/llm-provider';
import type { DatasetIngest, KnowledgeGraph } from '@omadia/plugin-api';

import type { ChatTurnInput } from '../packages/harness-channel-sdk/src/chatAgent.js';
import type { AttachmentReader } from '../packages/harness-orchestrator/src/tools/readAttachmentTool.js';
import { ToolReplayLedger } from '../packages/harness-orchestrator/src/toolReplayLedger.js';
import { REQUEST, doneOf, drain, text, verifiedTurn } from './_helpers/replayTurnFixture.js';
import { approved, blocked, borderline } from './_helpers/verifierVerdictFixtures.js';

const CSV = 'kunde,betrag\nK-1001,1200\nK-1002,800\n';
const UPLOAD: ChatTurnInput = {
  ...REQUEST,
  userMessage: 'Wie hoch ist die Summe in der Datei?',
  userId: 'user-c07-attachments',
  attachments: [
    {
      kind: 'file',
      url: 'https://files.example/uploads/rechnungen.csv',
      mediaType: 'text/csv',
      name: 'rechnungen.csv',
    },
  ],
};
const ANSWER = 'Die Summe der Rechnungen beträgt 2.000 EUR.';

/** The upload store and the dataset insert, counting what each pass does. */
function uploadWorld(): {
  attachmentReader: AttachmentReader;
  knowledgeGraph: KnowledgeGraph;
  imports: DatasetIngest[];
  fetches: string[];
} {
  const imports: DatasetIngest[] = [];
  const fetches: string[] = [];
  const attachmentReader: AttachmentReader = {
    readByStorageKey: () => Promise.resolve(undefined),
    readByUrl: (url: string) => {
      fetches.push(url);
      return Promise.resolve({ bytes: Buffer.from(CSV, 'utf8'), contentType: 'text/csv' });
    },
  };
  const knowledgeGraph = {
    ingestDataset(input: DatasetIngest) {
      imports.push(input);
      const n = String(imports.length);
      return Promise.resolve({
        datasetId: `ds-upload-${n}`,
        rowCount: input.rows.length,
        graphNodeId: `node-upload-${n}`,
      });
    },
  } as unknown as KnowledgeGraph;
  return { attachmentReader, knowledgeGraph, imports, fetches };
}

/** All text one provider request carried in its messages. */
function messageText(request: LlmRequest | undefined): string {
  const messages = (request as { messages?: unknown[] } | undefined)?.messages ?? [];
  const parts: string[] = [];
  for (const message of messages) {
    const content = (message as { content?: unknown }).content;
    if (typeof content === 'string') parts.push(content);
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const b = block as { type?: string; text?: unknown };
      if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    }
  }
  return parts.join('\n');
}

describe('verifier re-entries reuse the first run’s attachment ingestion', () => {
  it('MUTATION CHECK chat(): a resample and its correction retry import the upload once', async () => {
    const world = uploadWorld();
    const t = verifiedTurn({
      responses: [text(ANSWER), text(ANSWER), text(ANSWER)],
      verdicts: [borderline(), blocked(), approved()],
      orchestrator: {
        attachmentReader: world.attachmentReader,
        knowledgeGraph: world.knowledgeGraph,
      },
    });

    const sa = await t.service.chat(UPLOAD);

    assert.equal(t.model.requests.length, 3, 'first run, resample and correction retry ran');
    assert.equal(world.imports.length, 1, 'one request imported the file once');
    for (const [i, request] of t.model.requests.entries()) {
      const prompt = messageText(request);
      assert.match(prompt, /\[dataset-imported: rechnungen\.csv\]/, `pass ${String(i)} got the import block`);
      assert.match(prompt, /dataset_id=ds-upload-1\b/, `pass ${String(i)} names the one dataset`);
    }
    assert.equal(world.fetches.length, 1, 'the upload was fetched once');
    assert.deepEqual(sa.verifier, { status: 'corrected' });
  });

  it('MUTATION CHECK chatStream(): the stream’s correction retry imports the upload once', async () => {
    const world = uploadWorld();
    const t = verifiedTurn({
      responses: [text(ANSWER), text(ANSWER)],
      verdicts: [blocked(), approved()],
      orchestrator: {
        attachmentReader: world.attachmentReader,
        knowledgeGraph: world.knowledgeGraph,
      },
    });

    const events = await drain(t.service.chatStream(UPLOAD));

    assert.equal(t.model.requests.length, 2, 'the stream ran its correction retry');
    assert.equal(world.imports.length, 1, 'one request imported the file once');
    assert.match(messageText(t.model.requests[1]), /dataset_id=ds-upload-1\b/);
    assert.equal(doneOf(events)?.verifier?.badge, 'corrected');
  });

  it('a re-entry with no first-run ingestion to reuse is abandoned instead of importing', async () => {
    const world = uploadWorld();
    const t = verifiedTurn({
      responses: [text(ANSWER)],
      verdicts: [approved()],
      orchestrator: {
        attachmentReader: world.attachmentReader,
        knowledgeGraph: world.knowledgeGraph,
      },
    });
    // A request ledger already in replay mode that never saw a first run —
    // the shape a re-entry would have if the first run had not ingested.
    const ledger = new ToolReplayLedger();
    ledger.beginReentry();
    const release = t.orchestrator.bindToolReplayLedger(UPLOAD, ledger);
    try {
      await assert.rejects(t.orchestrator.runTurn(UPLOAD), { name: 'ToolReplayAbortError' });
    } finally {
      release();
    }
    assert.equal(world.imports.length, 0, 'nothing was imported');
    assert.equal(t.model.requests.length, 0, 'the abandoned pass never reached the model');
  });

  it('a stream re-entry with no first-run ingestion to reuse ends in the abandonment error', async () => {
    const world = uploadWorld();
    const t = verifiedTurn({
      responses: [text(ANSWER)],
      verdicts: [approved()],
      orchestrator: {
        attachmentReader: world.attachmentReader,
        knowledgeGraph: world.knowledgeGraph,
      },
    });
    const ledger = new ToolReplayLedger();
    ledger.beginReentry();
    const release = t.orchestrator.bindToolReplayLedger(UPLOAD, ledger);
    let events;
    try {
      events = await drain(t.orchestrator.chatStream(UPLOAD));
    } finally {
      release();
    }
    assert.equal(world.imports.length, 0, 'nothing was imported');
    assert.equal(t.model.requests.length, 0, 'the abandoned pass never reached the model');
    assert.equal(doneOf(events), undefined, 'no answer');
    assert.equal(events.filter((e) => e.type === 'error').length, 1, 'one abandonment error');
  });

  it('control: a turn no re-entry can follow imports as before, once per message', async () => {
    const world = uploadWorld();
    const t = verifiedTurn({
      responses: [text(ANSWER), text(ANSWER)],
      verdicts: [approved()],
      orchestrator: {
        attachmentReader: world.attachmentReader,
        knowledgeGraph: world.knowledgeGraph,
      },
    });

    await t.orchestrator.runTurn(UPLOAD);
    await t.orchestrator.runTurn({ ...UPLOAD });

    assert.equal(world.imports.length, 2, 'two separate messages import twice');
  });
});
