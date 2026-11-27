/**
 * #2300 / ADR-0265 — the call the fast lane already ran reaches the agent as
 * its first tool round (`tool_use` + `tool_result`), not as system text: the
 * handler does not run again, the Privacy Shield interns the output like any
 * result of that tool, and the verifier sees the call in the run trace.
 *
 * Real `Orchestrator` and `VerifierService` over a scripted model; all values
 * are synthetic.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { LlmRequest } from '@omadia/llm-provider';

import type { ChatTurnInput } from '../../packages/harness-channel-sdk/src/chatAgent.js';
import { NativeToolRegistry } from '../../packages/harness-orchestrator/src/nativeToolRegistry.js';
import {
  EMAIL,
  REQUEST,
  drain,
  maskingPrivacy,
  text,
  toolResultContents,
  verifiedTurn,
} from '../_helpers/replayTurnFixture.js';
import { approved } from '../_helpers/verifierVerdictFixtures.js';

const TOOL = 'odoo_query';
const OUTPUT = `{"records":[{"id":1,"display":"Acme","email":"${EMAIL}"}]}`;

function readTool(): { registry: NativeToolRegistry; runs: () => number } {
  const registry = new NativeToolRegistry();
  let runs = 0;
  registry.register(TOOL, {
    handler: () => {
      runs += 1;
      return Promise.resolve(OUTPUT);
    },
    spec: {
      name: TOOL,
      description: 'reads records',
      input_schema: { type: 'object' as const, properties: {}, required: [] },
    } as never,
    domain: 'test.partner',
  });
  return { registry, runs: () => runs };
}

const INPUT: ChatTurnInput = {
  ...REQUEST,
  fastLaneCall: {
    tool: TOOL,
    input: { model: 'res.partner', limit: 100 },
    output: OUTPUT,
    reason: 'summary-unresolvable',
    rows: 1,
  },
};

function systemText(request: LlmRequest | undefined): string {
  return JSON.stringify((request as { system?: unknown } | undefined)?.system ?? '');
}

describe('fast lane hands its executed call over as a tool round (#2300)', () => {
  it('without a shield: the output is a tool result, the handler does not run, the verifier sees the call', async () => {
    const tool = readTool();
    const t = verifiedTurn({
      responses: [text('Acme ist der Kunde.')],
      verdicts: [approved()],
      registry: tool.registry,
    });
    await t.service.chat(INPUT);
    assert.equal(tool.runs(), 0, 'the tool ran a second time');
    const first = t.model.requests[0];
    assert.deepEqual(toolResultContents(first), [OUTPUT]);
    assert.doesNotMatch(systemText(first), /Acme/, 'tool output reached the system text');
    assert.match(JSON.stringify(first), /Kernel-Hinweis/);
    assert.ok(
      t.verifyInputs[0]?.domainToolsCalled?.includes(TOOL),
      `verifier did not see the call: ${JSON.stringify(t.verifyInputs[0]?.domainToolsCalled)}`,
    );
  });

  it('under a shield: the output is interned like any result of that tool', async () => {
    const tool = readTool();
    const privacy = maskingPrivacy();
    const t = verifiedTurn({
      responses: [text('Acme ist der Kunde.')],
      verdicts: [approved()],
      registry: tool.registry,
      mode: 'shadow',
      orchestrator: { privacyGuard: () => privacy.service },
    });
    await t.orchestrator.runTurn(INPUT);
    assert.equal(tool.runs(), 0);
    const first = t.model.requests[0];
    const [result] = toolResultContents(first);
    assert.match(result ?? '', /^«dataset:odoo_query»/);
    assert.equal(JSON.stringify(first).includes(EMAIL), false, 'raw value reached the model');
  });

  it('the streaming path replays the same round', async () => {
    const tool = readTool();
    const t = verifiedTurn({
      responses: [text('Acme ist der Kunde.')],
      verdicts: [approved()],
      registry: tool.registry,
    });
    await drain(t.orchestrator.chatStream(INPUT));
    assert.equal(tool.runs(), 0);
    assert.deepEqual(toolResultContents(t.model.requests[0]), [OUTPUT]);
  });

  it('a turn without a fast-lane call has no replayed round', async () => {
    const tool = readTool();
    const t = verifiedTurn({ responses: [text('ok')], verdicts: [approved()], registry: tool.registry });
    await t.orchestrator.runTurn(REQUEST);
    assert.deepEqual(toolResultContents(t.model.requests[0]), []);
  });
});
