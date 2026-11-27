import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { ChatAgent, ChatTurnInput, SemanticAnswer } from '@omadia/channel-sdk';
import type { FastLlm } from '../packages/harness-plugin-fast-path/src/fastPath.js';
import { mapRefreshRecords } from '../packages/harness-plugin-fast-path/src/refreshRecipes.js';
import { ROUTER_TOOL, routeTurn } from '../packages/harness-plugin-fast-path/src/router.js';
import type { ChatTriageOutcome } from '../packages/harness-plugin-fast-path/src/service.js';
import { wrapChatAgentWithFastPath } from '../packages/harness-orchestrator/src/fastPathAgent.js';
import {
  FAST_LANE_HANDOFF_MAX_OUTPUT_CHARS,
  fastLaneCallOf,
  fastLaneCliHint,
  fastLaneToolResultNote,
} from '../packages/harness-orchestrator/src/fastLaneHandoff.js';

/**
 * W17 — fast-lane misses: a wrong map is refused (#1898), the router can say
 * no offered tool fits (#1931), and a call that ran reaches the agent (#1930).
 */

describe('mapRefreshRecords — a column no record fills is a wrong map (#1898)', () => {
  const source = { tool: 'agent_tool', input: {}, map: { name: 'name', amount: 'guessed_amount' } };

  it('refuses when no record has the guessed attribute', () => {
    const raw = JSON.stringify({ records: [{ name: 'a' }, { name: 'b' }] });
    assert.equal(mapRefreshRecords(raw, source), null);
  });

  it('accepts when at least one record fills every column', () => {
    const raw = JSON.stringify({ records: [{ name: 'a' }, { name: 'b', guessed_amount: 3 }] });
    assert.equal(mapRefreshRecords(raw, source)?.rows.length, 2);
  });

  it('an empty result is still an empty data set, not a wrong map', () => {
    assert.deepEqual(mapRefreshRecords(JSON.stringify({ records: [] }), source)?.rows, []);
  });
});

describe('router — none of the offered tools fits (#1931)', () => {
  const fake = (input: unknown): FastLlm => ({
    complete: () => Promise.resolve({ text: '', toolCalls: [{ name: ROUTER_TOOL, input }] }),
  });
  const one = [{ name: 'odoo_query', spec: 'odoo_query — Odoo search_read' }];
  const two = [...one, { name: 'hr_query', spec: 'hr_query — HR records' }];
  const run = (input: unknown, tools = one) =>
    routeTurn({ llm: fake(input), model: 'm', channel: 'web', message: 'q', tools, log: () => {} });

  it('agent_no_tool routes to the agent as complex', async () => {
    const out = await run({ decision: 'agent_no_tool', confidence: 0.9 });
    assert.deepEqual({ kind: out.kind, reason: out.kind === 'agent' && out.reason, route: out.kind === 'agent' && out.route }, {
      kind: 'agent',
      reason: 'agent:no-tool',
      route: 'complex',
    });
  });

  it('one offered tool needs the higher bar', async () => {
    const low = await run({ decision: 'deterministic', tool: 'odoo_query', confidence: 0.7 });
    assert.equal(low.kind === 'agent' && low.reason, 'router-low-confidence');
    const high = await run({ decision: 'deterministic', tool: 'odoo_query', confidence: 0.85 });
    assert.equal(high.kind, 'plan');
  });

  it('two offered tools keep the normal bar', async () => {
    const out = await run({ decision: 'deterministic', tool: 'hr_query', confidence: 0.7 }, two);
    assert.equal(out.kind, 'plan');
  });
});

describe('fast lane hands its executed call to the agent (#1930, #2300)', () => {
  const executed = {
    tool: 'odoo_query',
    input: { model: 'res.partner', limit: 100 },
    output: '{"records":[{"id":1,"display":"Acme"}]}',
    rows: 1,
  };

  async function innerInputFor(outcome: ChatTriageOutcome, privacyGuarded: boolean): Promise<ChatTurnInput> {
    let seen: ChatTurnInput | undefined;
    const inner = {
      chat: async (input: ChatTurnInput): Promise<SemanticAnswer> => {
        seen = input;
        return { text: 'ok' } as SemanticAnswer;
      },
      chatStream: async function* () {},
    } as unknown as ChatAgent;
    const wrapped = wrapChatAgentWithFastPath(inner, {
      fastPath: () => ({ channelEnabled: () => true, triageChatTurn: () => Promise.resolve(outcome) }),
      permittedTools: () => new Set(['odoo_query']),
      privacyGuarded: () => privacyGuarded,
      log: () => {},
    });
    await wrapped.chat({ userMessage: 'Kunden in Berlin?', sessionScope: '3f2a6c1e-8a4b-4c1d-9e2f-1a2b3c4d5e6f' });
    assert.ok(seen);
    return seen;
  }

  it('the executed call travels as the fastLaneCall carrier, not as system text (#2300)', async () => {
    const input = await innerInputFor({ kind: 'agent', reason: 'summary-unresolvable', ms: 1, executed }, false);
    assert.equal(input.extraSystemHint, undefined);
    assert.deepEqual(input.fastLaneCall, {
      tool: 'odoo_query',
      input: { model: 'res.partner', limit: 100 },
      output: executed.output,
      reason: 'summary-unresolvable',
      rows: 1,
    });
  });

  it('under a shield the carrier is the same: the orchestrator interns the output', async () => {
    const input = await innerInputFor({ kind: 'agent', reason: 'unmappable', ms: 1, executed }, true);
    assert.equal(input.fastLaneCall?.output, executed.output);
    assert.equal(input.extraSystemHint, undefined);
  });

  it('an over-long output is cut and marked', async () => {
    const long = 'x'.repeat(FAST_LANE_HANDOFF_MAX_OUTPUT_CHARS + 10);
    const input = await innerInputFor(
      { kind: 'agent', reason: 'truncated', ms: 1, executed: { ...executed, output: long } },
      false,
    );
    assert.equal(input.fastLaneCall?.output.length, FAST_LANE_HANDOFF_MAX_OUTPUT_CHARS);
    assert.equal(input.fastLaneCall?.truncated, true);
  });

  it('the notes after the tool result and for the CLI carry no data', () => {
    const call = fastLaneCallOf(executed, 'unmappable');
    assert.doesNotMatch(fastLaneToolResultNote(call), /Acme/);
    assert.doesNotMatch(fastLaneCliHint(call), /Acme/);
    assert.match(fastLaneToolResultNote(fastLaneCallOf({ ...executed, rows: 0 }, 'empty-result')), /keine Datensätze/);
    assert.match(
      fastLaneToolResultNote(fastLaneCallOf(executed, 'tool-error')),
      /erneuter Aufruf mit angepasster Eingabe ist erlaubt/,
    );
  });

  it('a miss before any call passes the input unchanged', async () => {
    const input = await innerInputFor({ kind: 'agent', reason: 'boundary', ms: 1 }, false);
    assert.equal(input.extraSystemHint, undefined);
    assert.equal(input.fastLaneCall, undefined);
  });
});
