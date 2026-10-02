import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';

import type { LlmProvider, LlmResponse } from '@omadia/llm-provider';
import type { PrivacyGuardService } from '@omadia/plugin-api';

import { setMcpKgIngestServers } from '../../packages/harness-orchestrator/src/mcpKgIngest.js';
import { setMcpPrivacyBypassServers } from '../../packages/harness-orchestrator/src/mcpPrivacyBypass.js';
import { NativeToolRegistry } from '../../packages/harness-orchestrator/src/nativeToolRegistry.js';
import {
  Orchestrator,
  type OrchestratorOptions,
} from '../../packages/harness-orchestrator/src/orchestrator.js';
import type { DomainTool } from '../../packages/harness-orchestrator/src/tools/domainQueryTool.js';

/**
 * MCP → Knowledge-Graph ingestion under the org clamp.
 *
 * A server flagged for KG ingestion stores a value-free digest of each result,
 * and the raw result only while its operator `privacy_bypass` is in force.
 * `OMADIA_PRIVACY_FORCE_GUARDED=true` clamps every bypass back to guarded, so
 * the ingest branch must store the digest too: a stored raw result would reach
 * recall, the relevance judge and the embedder unmasked later on.
 *
 * Drives the real `Orchestrator` through the real `privacyGuard` seam and reads
 * the `rationale` handed to `createMemorableKnowledge`. All values are synthetic.
 */

const SERVER_ID = 'srv-crm';
const EMAIL = 'erika.mustermann@example.com';
const RAW_RESULT = JSON.stringify({ customer: 'K-1001', email: EMAIL });
const CLAMP = 'OMADIA_PRIVACY_FORCE_GUARDED';

const usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } as const;

function scriptedProvider(responses: readonly LlmResponse[]): LlmProvider {
  let idx = 0;
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
    complete: () => {
      const response = responses[idx];
      idx += 1;
      if (!response) throw new Error('scriptedProvider: no scripted response left');
      return Promise.resolve(response);
    },
    stream: () => {
      throw new Error('not used');
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  } as unknown as LlmProvider;
}

const toolCall = {
  content: [{ type: 'tool_call', id: 'use-1', name: 'crm_find_customer', input: { q: 'K-1001' } }],
  finishReason: 'tool_calls',
  providerFinishReason: 'tool_use',
  model: 'test',
  usage,
} as unknown as LlmResponse;

const done = {
  content: [{ type: 'text', text: 'done' }],
  finishReason: 'stop',
  providerFinishReason: 'end_turn',
  model: 'test',
  usage,
} as unknown as LlmResponse;

function maskingPrivacyService(): PrivacyGuardService {
  return {
    async internToolResultV4(request: { toolName: string; rawResult: string }) {
      return {
        digestText: request.rawResult.replaceAll(EMAIL, '[masked:email]'),
        datasetId: `ds-${request.toolName}`,
      };
    },
    async recordBypassedTool() {},
    async runV4Tool() {
      return { resultText: '' };
    },
    async subAgentResultV4() {
      return { resultText: '' };
    },
    async takeRenderedAnswerV4() {
      return undefined;
    },
    v4ToolSpecs() {
      return [];
    },
    async finalizeTurn() {
      return undefined;
    },
  } as unknown as PrivacyGuardService;
}

/** Runs one turn that calls the ingest-flagged MCP tool; returns the stored rationales. */
async function ingestOneResult(): Promise<string[]> {
  const rationales: string[] = [];
  const knowledgeGraph = new Proxy(
    {
      createMemorableKnowledge: (row: { rationale: string }) => {
        rationales.push(row.rationale);
        return Promise.resolve({ id: `mk-${String(rationales.length)}` });
      },
    } as Record<string, unknown>,
    {
      get: (target, prop: string) =>
        prop in target ? target[prop] : () => Promise.resolve(undefined),
    },
  ) as unknown as OrchestratorOptions['knowledgeGraph'];
  const crm = {
    name: 'crm_find_customer',
    spec: {
      name: 'crm_find_customer',
      description: 'CRM lookup (test MCP tool)',
      input_schema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    },
    domain: 'mcp.crm',
    mcpServerId: SERVER_ID,
    mcpServerName: 'CRM',
    handle: () => Promise.resolve(RAW_RESULT),
  } as unknown as DomainTool;
  const privacy = maskingPrivacyService();
  const orchestrator = new Orchestrator({
    provider: scriptedProvider([toolCall, done]),
    model: 'test',
    maxTokens: 1024,
    maxToolIterations: 3,
    domainTools: [crm],
    nativeToolRegistry: new NativeToolRegistry(),
    knowledgeGraph,
    privacyGuard: () => privacy,
  } as OrchestratorOptions);

  await orchestrator.runTurn({ userMessage: 'go', userId: 'user-1' });
  return rationales;
}

describe('MCP → Knowledge-Graph ingestion honours the org privacy clamp', () => {
  const previousClamp = process.env[CLAMP];
  afterEach(() => {
    setMcpKgIngestServers([]);
    setMcpPrivacyBypassServers([]);
    if (previousClamp === undefined) delete process.env[CLAMP];
    else process.env[CLAMP] = previousClamp;
  });

  it('stores only the value-free digest for a bypassed server while the clamp is set', async () => {
    setMcpKgIngestServers([SERVER_ID]);
    setMcpPrivacyBypassServers([SERVER_ID]);
    process.env[CLAMP] = 'true';

    const rationales = await ingestOneResult();

    assert.equal(rationales.length, 1, 'one Knowledge-Graph row for the call');
    assert.equal(rationales[0]!.includes(EMAIL), false, `raw value stored: ${rationales[0]!}`);
    assert.equal(rationales[0]!.includes('K-1001'), false, `raw value stored: ${rationales[0]!}`);
    assert.equal(rationales[0], 'Fields: customer, email (values masked)');
  });

  it('control — without the clamp the bypassed server still stores its raw result', async () => {
    // Without this, the test above would also pass if the bypass flag were
    // never read at all.
    setMcpKgIngestServers([SERVER_ID]);
    setMcpPrivacyBypassServers([SERVER_ID]);
    delete process.env[CLAMP];

    const rationales = await ingestOneResult();

    assert.equal(rationales.length, 1);
    assert.equal(rationales[0], RAW_RESULT);
  });

  it('a server that is not bypassed stores the digest with or without the clamp', async () => {
    setMcpKgIngestServers([SERVER_ID]);
    delete process.env[CLAMP];

    const rationales = await ingestOneResult();

    assert.equal(rationales.length, 1);
    assert.equal(rationales[0]!.includes(EMAIL), false);
  });
});
