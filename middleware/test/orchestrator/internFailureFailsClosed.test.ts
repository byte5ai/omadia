/**
 * A tool result the Privacy Shield cannot intern never reaches a model raw.
 *
 * When `internToolResultV4` threw, the seams used to send the raw result to
 * the model instead — every tool but `query_dataset`. A verifier re-entry
 * replays the first run's raw result through the same seam, so a result the
 * first pass had interned could reach the model unmasked on the second pass,
 * and from its answer the verifier's claim extractor. Every seam now fails
 * closed with the kernel's withheld notice: the orchestrator's dispatch (here),
 * a `LocalSubAgent`'s inner calls (here), `ToolDispatchService`
 * (`cliBridge/toolDispatchPrivacySeam.test.ts`) and the MCP input-card replay
 * (`mcpInputReplayPrivacy.test.ts`).
 *
 * Imported from SOURCE: the barrel resolves to `dist/`, and the ledger travels
 * through one AsyncLocalStorage. All values are synthetic.
 */

import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import type { LlmRequest } from '@omadia/llm-provider';
import type { PrivacyGuardService } from '@omadia/plugin-api';

import { LocalSubAgent } from '../../packages/harness-orchestrator/src/localSubAgent.js';
import { NativeToolRegistry } from '../../packages/harness-orchestrator/src/nativeToolRegistry.js';
import {
  Orchestrator,
  type OrchestratorOptions,
} from '../../packages/harness-orchestrator/src/orchestrator.js';
import type { PrivacyTurnHandle } from '../../packages/harness-orchestrator/src/privacyHandle.js';
import { turnContext } from '../../packages/harness-orchestrator/src/turnContext.js';
import {
  EMAIL,
  REQUEST,
  maskingPrivacy,
  registerWriteTool,
  scriptedModel,
  text,
  toolCalls,
  toolResultContents,
  verifiedTurn,
} from '../_helpers/replayTurnFixture.js';
import { approved, blocked } from '../_helpers/verifierVerdictFixtures.js';

const ROW = `{"customer":"K-1001","contact":"${EMAIL}"}`;
const NOTICE = /^Error: tool `lookup_customer` ran, but the privacy boundary could not process its result, so the result was withheld\./;

/** `maskingPrivacy` whose interning throws for every turn after the first
 *  `internable` turns it saw. Create it once per test: the orchestrator calls
 *  its `privacyGuard` thunk per turn. */
function failingInterning(internable: number): PrivacyGuardService {
  const { service } = maskingPrivacy();
  const turns: string[] = [];
  return {
    ...service,
    internToolResultV4: async (request) => {
      if (!turns.includes(request.turnId)) turns.push(request.turnId);
      if (turns.indexOf(request.turnId) >= internable) {
        throw new Error('privacy provider unavailable');
      }
      return service.internToolResultV4(request);
    },
  };
}

function lookupRegistry(): NativeToolRegistry {
  const registry = new NativeToolRegistry();
  registerWriteTool(registry, 'lookup_customer', () => Promise.resolve(ROW));
  return registry;
}

describe('the orchestrator withholds a result the shield could not intern', () => {
  beforeEach(() => {
    mock.method(console, 'warn', () => undefined);
  });
  afterEach(() => {
    mock.restoreAll();
  });

  it('MUTATION CHECK: the model reads the withheld notice, never the raw result', async () => {
    const model = scriptedModel([toolCalls(['lookup_customer', { id: 'K-1001' }]), text('Erledigt.')]);
    const orchestrator = new Orchestrator({
      provider: model.provider,
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 3,
      domainTools: [],
      nativeToolRegistry: lookupRegistry(),
      privacyGuard: () => failingInterning(0),
    } as OrchestratorOptions);

    await orchestrator.runTurn(REQUEST);

    const [result] = toolResultContents(model.requests[1]);
    assert.ok(result !== undefined, 'the tool ran and its result went back to the model');
    assert.equal(result.includes(EMAIL), false, 'the raw result reached the model');
    assert.match(result, NOTICE);
  });

  it('MUTATION CHECK: a re-entry whose interning fails does not replay the raw result', async () => {
    const run = () => [toolCalls(['lookup_customer', { id: 'K-1001' }]), text('Kontakt hinterlegt.')];
    // The first run interns; the correction retry's interning fails.
    const privacy = failingInterning(1);
    const t = verifiedTurn({
      registry: lookupRegistry(),
      responses: [...run(), ...run()],
      verdicts: [blocked(), approved()],
      orchestrator: { privacyGuard: () => privacy } as Partial<OrchestratorOptions>,
    });

    await t.service.chat(REQUEST);

    assert.equal(t.model.requests.length, 4, 'the correction retry ran');
    const [first] = toolResultContents(t.model.requests[1]);
    assert.ok(first?.includes('«dataset:lookup_customer»'), 'the first run interned the result');
    const [replayed] = toolResultContents(t.model.requests[3]);
    assert.ok(replayed !== undefined, 'the retry got the replayed call back');
    assert.equal(replayed.includes(EMAIL), false, 'the replayed raw result reached the retry’s model');
    assert.match(replayed, NOTICE);
  });
});

describe('a sub-agent withholds an inner result the shield could not intern', () => {
  beforeEach(() => {
    mock.method(console, 'warn', () => undefined);
  });
  afterEach(() => {
    mock.restoreAll();
  });

  it('MUTATION CHECK: its own model reads the withheld notice, flagged as an error', async () => {
    const model = scriptedModel([toolCalls(['lookup_customer', { id: 'K-1001' }]), text('Erledigt.')]);
    const agent = new LocalSubAgent({
      name: 'crm',
      provider: model.provider,
      model: 'claude-haiku',
      maxTokens: 1024,
      maxIterations: 3,
      systemPrompt: 'you are a test',
      tools: [
        {
          spec: {
            name: 'lookup_customer',
            description: 'test tool',
            input_schema: { type: 'object' as const, properties: {}, required: [] },
          },
          handle: () => Promise.resolve(ROW),
        },
      ],
    } as ConstructorParameters<typeof LocalSubAgent>[0]);
    const handle = {
      internToolResultV4: () => Promise.reject(new Error('privacy provider unavailable')),
      checkBypass: () => undefined,
      recordBypassedTool: () => Promise.resolve(),
      recordToolError: () => Promise.resolve(),
    } as unknown as PrivacyTurnHandle;

    await turnContext.run({ turnId: 'turn-intern', turnDate: '2026-10-01', privacyHandle: handle }, () =>
      agent.ask('Wer ist der Kontakt von K-1001?'),
    );

    const blocks = toolResultBlocks(model.requests[1]);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]!.content.includes(EMAIL), false, 'the raw result reached the sub-agent model');
    assert.match(blocks[0]!.content, NOTICE);
    assert.equal(blocks[0]!.isError, true, 'the notice is an error result');
  });
});

/** The `tool_result` blocks of one request, with their error flag. */
function toolResultBlocks(
  request: LlmRequest | undefined,
): Array<{ readonly content: string; readonly isError: boolean }> {
  const out: Array<{ content: string; isError: boolean }> = [];
  for (const message of (request?.messages ?? []) as unknown as Array<{ content?: unknown }>) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content as Array<{
      type?: string;
      content?: unknown;
      isError?: boolean;
      is_error?: boolean;
    }>) {
      if (block.type !== 'tool_result' || typeof block.content !== 'string') continue;
      out.push({ content: block.content, isError: block.isError === true || block.is_error === true });
    }
  }
  return out;
}
