/**
 * #1866 / #1967 / #1985 — what the REAL `Orchestrator` with the REAL
 * privacy-guard service hands the model for the new intern exemptions:
 *
 *   - `query_dataset` `list_datasets` / `get_schema` in clear, `query_rows`
 *     still interned (ADR-0197, per-operation exemption);
 *   - `render_diagram` in clear, while its handler still runs on the user's
 *     restored value (#1967, #1544);
 *   - a `transcribe_recording` transcript of an upload from THIS turn readable
 *     with its PII spans masked, a transcript of any other key interned
 *     (ADR-0198).
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { LlmProvider, LlmRequest, LlmResponse } from '@omadia/llm-provider';
import { NativeToolRegistry, Orchestrator } from '@omadia/orchestrator';
import { createPrivacyGuardService } from '@omadia/plugin-privacy-guard/dist/index.js';

const TERM = 'Projekt Falkenstein';
const PLACEHOLDER = /PLATZHALTER-CUSTOM-\d+/;
const usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } as const;

function maskingService(): ReturnType<typeof createPrivacyGuardService> {
  return createPrivacyGuardService({
    readConfig: (key: string) =>
      key === 'mask_user_prompt' ? 'on' : key === 'custom_terms' ? TERM : undefined,
  });
}

function reply(content: unknown[], finishReason: 'tool_calls' | 'stop'): LlmResponse {
  return {
    content,
    finishReason,
    providerFinishReason: finishReason === 'stop' ? 'end_turn' : 'tool_use',
    model: 'test',
    usage,
  } as unknown as LlmResponse;
}

/** Step 1: one call of `toolName` (input built from the first request); step 2: stop. */
function callingProvider(
  toolName: string,
  buildInput: (firstRequest: string) => unknown,
  requests: string[],
): LlmProvider {
  let step = 0;
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
    complete: (req: LlmRequest) => {
      const serialized = JSON.stringify(req.messages);
      requests.push(serialized);
      step += 1;
      if (step === 1) {
        return Promise.resolve(
          reply(
            [{ type: 'tool_call', id: 'call-1', name: toolName, input: buildInput(serialized) }],
            'tool_calls',
          ),
        );
      }
      return Promise.resolve(reply([{ type: 'text', text: 'Fertig.' }], 'stop'));
    },
    stream: () => {
      throw new Error('not used');
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  } as unknown as LlmProvider;
}

interface RunResult {
  /** What the model was sent after the tool ran. */
  readonly afterTool: string;
  readonly seen: unknown[];
}

async function runOne(args: {
  toolName: string;
  input: (firstRequest: string) => unknown;
  result: string;
  userMessage: string;
}): Promise<RunResult> {
  const seen: unknown[] = [];
  const registry = new NativeToolRegistry();
  registry.register(args.toolName, {
    handler: (input: unknown) => {
      seen.push(input);
      return Promise.resolve(args.result);
    },
    spec: {
      name: args.toolName,
      description: 'test tool',
      input_schema: { type: 'object' as const, properties: {}, required: [] },
    } as never,
  });
  const requests: string[] = [];
  const orchestrator = new Orchestrator({
    provider: callingProvider(args.toolName, args.input, requests),
    model: 'test',
    maxTokens: 1024,
    maxToolIterations: 3,
    domainTools: [],
    nativeToolRegistry: registry,
    privacyGuard: () => maskingService(),
  } as ConstructorParameters<typeof Orchestrator>[0]);

  await orchestrator.runTurn({ userMessage: args.userMessage });
  assert.equal(requests.length, 2, 'the model was called again after the tool');
  return { afterTool: requests[1]!, seen };
}

const DATASET_LIST = JSON.stringify({
  datasets: [
    { id: '7d1f0c2e-1111-4a4a-9b9b-000000000001', name: 'Kunden März', sourceFileName: 'umsätze.csv', rowCount: 3 },
    { id: '7d1f0c2e-1111-4a4a-9b9b-000000000002', name: 'orders', sourceFileName: 'orders.csv', rowCount: 2 },
  ],
});

describe('ADR-0197 — query_dataset metadata operations reach the model in clear (#1866)', () => {
  it('list_datasets: every dataset name and file name in clear', async () => {
    const { afterTool } = await runOne({
      toolName: 'query_dataset',
      input: () => ({ query: 'list_datasets' }),
      result: DATASET_LIST,
      userMessage: 'Welche Datasets habe ich?',
    });
    assert.ok(afterTool.includes('Kunden März'), 'a name with a space and an umlaut is readable');
    assert.ok(afterTool.includes('umsätze.csv'));
    assert.ok(afterTool.includes('orders'));
  });

  it('query_rows stays interned', async () => {
    const rows = JSON.stringify({
      rows: [
        { name: 'Kai Mueller', email: 'kai.mueller@customer.example' },
        { name: 'Anna Schmidt', email: 'anna.schmidt@customer.example' },
      ],
    });
    const { afterTool } = await runOne({
      toolName: 'query_dataset',
      input: () => ({ query: 'query_rows', dataset_id: '7d1f0c2e-1111-4a4a-9b9b-000000000001' }),
      result: rows,
      userMessage: 'Zeig mir die Zeilen.',
    });
    assert.ok(!afterTool.includes('kai.mueller@customer.example'), 'a row value reached the model');
  });
});

describe('#1967 — render_diagram result in clear, handler on the user value', () => {
  it('hands the model the diagram metadata and the handler the restored title', async () => {
    const url = 'https://omadia.example/diagrams/dl/abc?sig=xyz';
    const { afterTool, seen } = await runOne({
      toolName: 'render_diagram',
      input: (first) => {
        const placeholder = PLACEHOLDER.exec(first)?.[0];
        assert.ok(placeholder, 'the model was sent a placeholder for the term');
        return { kind: 'mermaid', source: 'graph TD; A-->B', title: `Ablauf ${placeholder}` };
      },
      result: JSON.stringify({ kind: 'mermaid', url, cacheHit: false, title: `Ablauf ${TERM}` }),
      userMessage: `Zeichne den Ablauf für ${TERM}.`,
    });
    assert.deepEqual(
      (seen[0] as { title: string }).title,
      `Ablauf ${TERM}`,
      'the image is drawn with the real name',
    );
    assert.ok(afterTool.includes(url.replace(/&/g, '\\u0026')) || afterTool.includes(url), 'the result is in clear');
    assert.ok(!afterTool.includes('Falkenstein'), 'the echoed user value is masked again');
  });
});

describe('ADR-0198 — a transcript of an own upload is prompt-masked, not interned (#1985)', () => {
  const KEY = 'uploads/2026/11/rec-1.wav';
  const transcript = `Kurze Notiz zu ${TERM}. Das Codewort lautet Leuchtturm 14.`;
  const withUpload = (text: string): string =>
    `${text}\n\n[attachments-info] 1 Datei(en) in diesem Turn hochgeladen + persistiert:\n` +
    `- notiz.wav (audio/wav, 120 KB) · storage_key=${KEY}`;

  it('the model reads the transcript, its PII spans masked', async () => {
    const { afterTool } = await runOne({
      toolName: 'transcribe_recording',
      input: () => ({ storage_key: KEY }),
      result: transcript,
      userMessage: withUpload('Transkribiere die Aufnahme und nenne mir das Codewort.'),
    });
    assert.ok(afterTool.includes('Leuchtturm 14'), 'the transcript is readable');
    assert.ok(!afterTool.includes('Falkenstein'), 'a PII span reached the model');
    assert.match(afterTool, PLACEHOLDER);
  });

  it('a transcript of a key that is not an upload of this turn stays interned', async () => {
    const { afterTool } = await runOne({
      toolName: 'transcribe_recording',
      input: () => ({ storage_key: 'uploads/other-chat/rec-9.wav' }),
      result: transcript,
      userMessage: withUpload('Transkribiere die Aufnahme.'),
    });
    assert.ok(!afterTool.includes('Leuchtturm 14'), 'a foreign transcript reached the model in clear');
  });
});
