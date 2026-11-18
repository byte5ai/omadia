/**
 * A CSV upload in a turn behind the Privacy Shield, with prompt masking off
 * (the shipped default): its cells reach the model through neither attachment
 * path.
 *
 *   - The ingest of the user message imports the table as a dataset (or
 *     refuses it) and never inlines it as `[attachment-content]` text.
 *   - `read_attachment` is intern-exempt, so what it returns reaches the model
 *     as it is. It refuses the table and points to `query_dataset`.
 *
 * Drives the REAL `Orchestrator` with the REAL privacy-guard service. All
 * values are synthetic.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import type { LlmProvider, LlmResponse } from '@omadia/llm-provider';
import { type AttachmentReader, NativeToolRegistry, Orchestrator } from '@omadia/orchestrator';
import { createPrivacyGuardService } from '@omadia/plugin-privacy-guard/dist/index.js';

const STORAGE_KEY = 'teams-attachments/t1/c1/2026-10-02T10-00-00-abc123.csv';
const CSV =
  'name,email\n' +
  'Jana Beispielfrau,jana.beispiel@firma.example\n' +
  'Max Mustermann,max.muster@firma.example\n';
const CELLS = [
  'Jana Beispielfrau',
  'jana.beispiel@firma.example',
  'Max Mustermann',
  'max.muster@firma.example',
];
const MESSAGE =
  'Wer steht in der Liste?\n\n' +
  '[attachments-info] 1 Datei(en) in diesem Turn hochgeladen + persistiert:\n' +
  `- kunden.csv (text/csv, 1 KB) · storage_key=${STORAGE_KEY}`;

const usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } as const;

function toolCall(name: string, input: unknown): LlmResponse {
  return {
    content: [{ type: 'tool_call', id: 'use-1', name, input }],
    finishReason: 'tool_calls',
    providerFinishReason: 'tool_use',
    model: 'test',
    usage,
  } as unknown as LlmResponse;
}

function text(answer: string): LlmResponse {
  return {
    content: [{ type: 'text', text: answer }],
    finishReason: 'stop',
    providerFinishReason: 'end_turn',
    model: 'test',
    usage,
  } as unknown as LlmResponse;
}

/** Plays the scripted responses and records every request as sent. */
function scriptedProvider(responses: readonly LlmResponse[]): {
  provider: LlmProvider;
  requests: Array<{ messages?: unknown[] }>;
} {
  const requests: Array<{ messages?: unknown[] }> = [];
  const provider = {
    id: 'anthropic',
    capabilities: {
      tools: true,
      vision: true,
      streaming: true,
      promptCaching: true,
      forcedToolChoice: true,
      parallelToolCalls: true,
    },
    complete: (request: { messages?: unknown[] }) => {
      requests.push(request);
      const response = responses[requests.length - 1];
      if (!response) throw new Error('scriptedProvider: no scripted response left');
      return Promise.resolve(response);
    },
    stream: () => {
      throw new Error('scriptedProvider: stream() not scripted');
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  };
  return { provider: provider as unknown as LlmProvider, requests };
}

const attachmentReader: AttachmentReader = {
  readByStorageKey: async (key: string) =>
    key === STORAGE_KEY
      ? { bytes: Buffer.from(CSV, 'utf8'), contentType: 'text/csv', fileName: 'kunden.csv' }
      : undefined,
  readByUrl: async () => undefined,
};

describe('tabular upload behind the Privacy Shield, prompt masking off', () => {
  it('no cell reaches the model, through the ingest or through read_attachment', async () => {
    const { provider, requests } = scriptedProvider([
      toolCall('read_attachment', { storage_key: STORAGE_KEY }),
      text('Die Liste liegt als Dataset vor.'),
    ]);
    // No `readConfig`: `mask_user_prompt` is off, as shipped.
    const privacy = createPrivacyGuardService();
    const orch = new Orchestrator({
      provider,
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 3,
      domainTools: [],
      nativeToolRegistry: new NativeToolRegistry(),
      attachmentReader,
      knowledgeGraph: new InMemoryKnowledgeGraph(),
      privacyGuard: () => privacy,
    } as ConstructorParameters<typeof Orchestrator>[0]);

    await orch.runTurn({
      userMessage: MESSAGE,
      sessionScope: 'sess-tabular',
      userId: 'a1b2c3d4-0000-0000-0000-00000000000a',
    });

    assert.equal(requests.length, 2, 'the model must have read the tool result');
    const wire = JSON.stringify(requests);
    for (const cell of CELLS) {
      assert.equal(wire.includes(cell), false, `a cell reached the model: ${cell}`);
    }
    // The ingest imported the table instead of inlining it. (The tool
    // description names the `[attachment-content: …]` block, so look for this
    // file's block.)
    assert.equal(wire.includes('[attachment-content: kunden.csv]'), false);
    assert.ok(wire.includes('[dataset-imported:'), 'the import block is missing');
    // The model read the refusal, which names the dataset path.
    const toolTurn = JSON.stringify(requests[1]?.messages?.at(-1));
    assert.ok(toolTurn.includes('does not return table contents'), toolTurn);
    assert.ok(toolTurn.includes('query_dataset'), toolTurn);
  });
});
