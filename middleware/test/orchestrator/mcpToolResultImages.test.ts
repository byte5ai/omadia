import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';

import type { LlmProvider, LlmRequest, LlmResponse } from '@omadia/llm-provider';
import type { PrivacyGuardService } from '@omadia/plugin-api';

import {
  MCP_MODEL_IMAGE_MAX_BYTES,
  binaryBlockPlaceholder,
  modelImagesOf,
  newModelImageBudget,
  recordMcpImages,
  stripModelImages,
  withModelImages,
} from '../../packages/harness-orchestrator/src/mcp/mcpBinaryContent.js';
import { renderToolResult } from '../../packages/harness-orchestrator/src/mcp/mcpClient.js';
import { setMcpPrivacyBypassServers } from '../../packages/harness-orchestrator/src/mcpPrivacyBypass.js';
import { NativeToolRegistry } from '../../packages/harness-orchestrator/src/nativeToolRegistry.js';
import {
  Orchestrator,
  type OrchestratorOptions,
} from '../../packages/harness-orchestrator/src/orchestrator.js';
import type { DomainTool } from '../../packages/harness-orchestrator/src/tools/domainQueryTool.js';

/**
 * #1920 / ADR-0272 — an MCP image reaches the model as an image block only
 * where no shield masks the server's results and the provider's wire carries
 * images in a `tool_result`. Everywhere else it stays a placeholder.
 */

const SERVER_ID = 'srv-img';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
const MCP_RESULT = {
  content: [
    { type: 'text', text: 'here is the chart' },
    { type: 'image', mimeType: 'image/png', data: PNG },
  ],
};

const usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } as const;

const toolCall = {
  content: [{ type: 'tool_call', id: 'use-1', name: 'img_get', input: {} }],
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

function provider(requests: LlmRequest[], toolResultImages: boolean): LlmProvider {
  const responses = [toolCall, done];
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
      toolResultImages,
    },
    complete: (req: LlmRequest) => {
      requests.push(structuredClone(req));
      const response = responses[idx];
      idx += 1;
      if (!response) throw new Error('no scripted response left');
      return Promise.resolve(response);
    },
    stream: () => {
      throw new Error('not used');
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  } as unknown as LlmProvider;
}

function maskingPrivacy(): PrivacyGuardService {
  return {
    async internToolResultV4(request: { toolName: string; rawResult: string }) {
      return { digestText: `digest of ${request.toolName}`, datasetId: 'ds-1' };
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

/** The tool_result part the model got back, from the second request. */
async function toolResultSent(opts: {
  readonly guard: boolean;
  readonly toolResultImages?: boolean;
}): Promise<{ content: unknown }> {
  const requests: LlmRequest[] = [];
  const tool = {
    name: 'img_get',
    spec: { name: 'img_get', description: 'image (test MCP tool)', input_schema: { type: 'object', properties: {} } },
    domain: 'mcp.img',
    mcpServerId: SERVER_ID,
    mcpServerName: 'IMG',
    // What `McpManager.callTool` does on success.
    handle: () => {
      recordMcpImages(MCP_RESULT);
      return Promise.resolve(renderToolResult(MCP_RESULT));
    },
  } as unknown as DomainTool;
  const privacy = maskingPrivacy();
  const orchestrator = new Orchestrator({
    provider: provider(requests, opts.toolResultImages ?? true),
    model: 'test',
    maxTokens: 1024,
    maxToolIterations: 3,
    domainTools: [tool],
    nativeToolRegistry: new NativeToolRegistry(),
    ...(opts.guard ? { privacyGuard: () => privacy } : {}),
  } as OrchestratorOptions);
  await orchestrator.runTurn({ userMessage: 'go', userId: 'user-1' });
  const second = requests[1];
  assert.ok(second, 'the model was asked again with the tool result');
  for (const message of second.messages) {
    if (typeof message.content === 'string') continue;
    for (const part of message.content) {
      if (part.type === 'tool_result') return part as { content: unknown };
    }
  }
  throw new Error('no tool_result in the second request');
}

function imageParts(content: unknown): unknown[] {
  return Array.isArray(content) ? content.filter((p: { type?: string }) => p.type === 'image') : [];
}

describe('MCP images in tool results (#1920, ADR-0272)', () => {
  afterEach(() => setMcpPrivacyBypassServers([]));

  it('attaches the image for a bypassed server', async () => {
    setMcpPrivacyBypassServers([SERVER_ID]);
    const part = await toolResultSent({ guard: true });
    const images = imageParts(part.content);
    assert.equal(images.length, 1);
    assert.deepEqual(images[0], { type: 'image', mediaType: 'image/png', data: PNG });
    const text = (part.content as Array<{ type: string; text?: string }>)[0]!.text ?? '';
    assert.match(text, /attached as an image/);
    assert.equal(text.includes(PNG), false, 'no base64 in the text');
  });

  it('attaches the image when no privacy guard is installed', async () => {
    const part = await toolResultSent({ guard: false });
    assert.equal(imageParts(part.content).length, 1);
  });

  it('keeps a placeholder under a guard that masks the server', async () => {
    const part = await toolResultSent({ guard: true });
    assert.equal(typeof part.content, 'string');
    assert.equal(String(part.content).includes(PNG), false);
  });

  it('keeps a placeholder when the provider cannot carry images in a tool result', async () => {
    setMcpPrivacyBypassServers([SERVER_ID]);
    const part = await toolResultSent({ guard: true, toolResultImages: false });
    assert.equal(typeof part.content, 'string');
    assert.match(String(part.content), /not shown to the model/);
  });
});

describe('modelImagesOf / withModelImages', () => {
  it('skips unsupported types, oversized and malformed images', () => {
    const big = 'A'.repeat(Math.ceil((MCP_MODEL_IMAGE_MAX_BYTES + 10) / 3) * 4);
    const images = modelImagesOf({
      content: [
        { type: 'image', mimeType: 'image/svg+xml', data: PNG },
        { type: 'image', mimeType: 'image/png', data: big },
        { type: 'image', mimeType: 'image/png', data: 'not base64!' },
        { type: 'image', mimeType: 'image/jpeg', data: PNG },
      ],
    });
    assert.equal(images.length, 1);
    assert.equal(images[0]!.mediaType, 'image/jpeg');
  });

  it('records nothing for an error result', () => {
    assert.deepEqual(modelImagesOf({ isError: true, content: MCP_RESULT.content }), []);
  });

  it('leaves an error block and a block without images unchanged', () => {
    const images = modelImagesOf(MCP_RESULT);
    const error = { type: 'tool_result', content: 'Error: x', is_error: true };
    assert.equal(withModelImages(error, images, newModelImageBudget()), error);
    const plain = { type: 'tool_result', content: 'x' };
    assert.equal(withModelImages(plain, [], newModelImageBudget()), plain);
    assert.ok(binaryBlockPlaceholder(MCP_RESULT.content[1]));
  });

  it('attaches nothing when the result cap cut the placeholder', () => {
    const images = modelImagesOf(MCP_RESULT);
    const cut = { type: 'tool_result', content: 'here is the chart\n[result truncated …]' };
    assert.equal(withModelImages(cut, images, newModelImageBudget()), cut);
  });

  it('shares one budget across the calls of a request', () => {
    const images = modelImagesOf(MCP_RESULT);
    const block = { type: 'tool_result', content: renderToolResult(MCP_RESULT) };
    const budget = { bytesLeft: 1_000_000, countLeft: 1 };
    const first = withModelImages(block, images, budget);
    const second = withModelImages(block, images, budget);
    assert.ok(Array.isArray(first.content), 'the first call gets its image');
    assert.equal(second, block, 'the budget is spent; the second stays text');
  });

  it('turns images of earlier iterations back into text', () => {
    const images = modelImagesOf(MCP_RESULT);
    const block = withModelImages(
      { type: 'tool_result', tool_use_id: 'u1', content: renderToolResult(MCP_RESULT) },
      images,
      newModelImageBudget(),
    );
    const messages: Array<{ role: string; content: unknown }> = [
      { role: 'user', content: 'go' },
      { role: 'user', content: [block] },
    ];
    stripModelImages(messages);
    const stripped = (messages[1]!.content as Array<{ content: unknown }>)[0]!;
    assert.equal(typeof stripped.content, 'string');
    assert.match(String(stripped.content), /shown to the model in an earlier step/);
    assert.equal(String(stripped.content).includes(PNG), false);
  });
});
