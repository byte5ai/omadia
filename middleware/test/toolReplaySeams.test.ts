/**
 * Every seam that runs a tool handler consults the request's replay ledger,
 * and a re-entry that needed something outside the first run is abandoned no
 * matter where the miss happened.
 *
 *  - `ToolDispatchService` (the loopback/CLI-sub-agent dispatcher) reads the
 *    ledger from the ambient turn context: it replays a recorded result
 *    through its own privacy pipeline without running the handler, refuses a
 *    miss, and without a ledger (the public MCP endpoint runs outside any
 *    turn) behaves exactly as before.
 *  - A re-entry of an MCP input-card answer is abandoned before the parked
 *    call could be replayed a second time.
 *  - A direct-line turn swallows a refused dispatch into its own answer; the
 *    authoritative check at the end of the turn still abandons the re-entry.
 *
 * Imported from SOURCE (one AsyncLocalStorage). All values are synthetic.
 */

import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { formatMcpInputReply } from '../packages/harness-orchestrator/src/mcp/pendingMcpInput.js';
import type {
  McpInputReplayer,
  PendingMcpInputStore,
} from '../packages/harness-orchestrator/src/mcp/pendingMcpInput.js';
import { LocalSubAgent } from '../packages/harness-orchestrator/src/localSubAgent.js';
import { NativeToolRegistry } from '../packages/harness-orchestrator/src/nativeToolRegistry.js';
import { Orchestrator } from '../packages/harness-orchestrator/src/orchestrator.js';
import { ToolDispatchService } from '../packages/harness-orchestrator/src/toolDispatchService.js';
import { sendsEachCallOnce } from '../packages/harness-orchestrator/src/toolIdempotency.js';
import {
  ToolReplayAbortError,
  ToolReplayLedger,
} from '../packages/harness-orchestrator/src/toolReplayLedger.js';
import type { DomainTool } from '../packages/harness-orchestrator/src/tools/domainQueryTool.js';
import { turnContext } from '../packages/harness-orchestrator/src/turnContext.js';
import {
  REQUEST,
  registerWriteTool,
  scriptedModel,
  text,
  toolCalls,
} from './_helpers/replayTurnFixture.js';

const TICKET = { title: 'Drucker defekt' };
const CREATED = 'Ticket T-7 angelegt.';

function dispatcherWithTicket() {
  const registry = new NativeToolRegistry();
  const ticket = registerWriteTool(registry, 'create_ticket', () => Promise.resolve(CREATED));
  return { ticket, dispatch: new ToolDispatchService({ nativeTools: registry }) };
}

const inTurn = <T>(ledger: ToolReplayLedger | undefined, fn: () => Promise<T>): Promise<T> =>
  turnContext.run(
    { turnId: 'turn-1', turnDate: '2026-10-01', ...(ledger ? { toolReplayLedger: ledger } : {}) },
    fn,
  );

describe('ToolDispatchService honours the ambient replay ledger', () => {
  it('MUTATION CHECK: a re-entry replays the recorded result without running the handler', async () => {
    const { ticket, dispatch } = dispatcherWithTicket();
    const ledger = new ToolReplayLedger();

    const first = await inTurn(ledger, () => dispatch.dispatch('create_ticket', TICKET));
    ledger.beginReentry();
    const replayed = await inTurn(ledger, () => dispatch.dispatch('create_ticket', TICKET));

    assert.equal(ticket.inputs.length, 1, 'the handler ran in the first run only');
    assert.equal(replayed.content, first.content);
    assert.equal(replayed.content, CREATED);
  });

  it('a re-entry refuses a call the first run did not make and marks it abandoned', async () => {
    const { ticket, dispatch } = dispatcherWithTicket();
    const ledger = new ToolReplayLedger();
    ledger.beginReentry();

    const refused = await inTurn(ledger, () => dispatch.dispatch('create_ticket', TICKET));

    assert.equal(ticket.inputs.length, 0);
    assert.equal(refused.isError, true);
    assert.equal(refused.origin, 'dispatcher');
    assert.match(refused.content, /^Error: tool `create_ticket` was not run/);
    assert.equal(ledger.abortedTool, 'create_ticket');
  });

  it('control: without a ledger every dispatch runs, as on the public endpoint', async () => {
    const { ticket, dispatch } = dispatcherWithTicket();
    const a = await dispatch.dispatch('create_ticket', TICKET);
    const b = await inTurn(undefined, () => dispatch.dispatch('create_ticket', TICKET));
    assert.equal(ticket.inputs.length, 2);
    assert.deepEqual(a, { content: CREATED, origin: 'tool' });
    assert.deepEqual(b, a);
  });
});

describe('the orchestrator abandons a re-entry it cannot replay', () => {
  beforeEach(() => {
    mock.method(console, 'error', () => undefined);
    mock.method(console, 'warn', () => undefined);
    mock.method(console, 'log', () => undefined);
  });
  afterEach(() => {
    mock.restoreAll();
  });

  it('an MCP input-card answer is not replayed a second time', async () => {
    const replays: unknown[] = [];
    const replayer: McpInputReplayer = {
      replay: (_record, inputResponses) => {
        replays.push(inputResponses);
        return Promise.resolve('done');
      },
    };
    const store = {
      take: () => ({
        correlationId: 'corr-1',
        serverId: 'srv-1',
        serverName: 'Ticketing',
        toolName: 'create_ticket',
        originalArgs: {},
        fields: [],
      }),
    } as unknown as PendingMcpInputStore;
    const model = scriptedModel([text('Erledigt.'), text('Erledigt.')]);
    const orchestrator = new Orchestrator({
      provider: model.provider,
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 3,
      domainTools: [],
      nativeToolRegistry: new NativeToolRegistry(),
      pendingMcpInput: store,
      mcpInputReplay: replayer,
    });
    const input = {
      ...REQUEST,
      userMessage: formatMcpInputReply({ correlationId: 'corr-1', inputResponses: { code: '4711' } }),
    };
    const ledger = new ToolReplayLedger();
    orchestrator.bindToolReplayLedger(input, ledger);

    await orchestrator.runTurn(input);
    ledger.beginReentry();
    await assert.rejects(orchestrator.runTurn(input), ToolReplayAbortError);

    assert.equal(replays.length, 1, 'the parked call ran for the first run only');
    assert.equal(model.requests.length, 1, 'the re-entry never reached the model');
  });

  it('a direct-line turn that misses is abandoned by the check at the end of the turn', async () => {
    const asked: unknown[] = [];
    const crm: DomainTool = {
      name: 'ask_crm',
      spec: {
        name: 'ask_crm',
        description: 'CRM specialist (test)',
        input_schema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
      },
      domain: 'crm',
      handle: (input: unknown) => {
        asked.push(input);
        return Promise.resolve('Adresse gespeichert.');
      },
    };
    const model = scriptedModel([]);
    const orchestrator = new Orchestrator({
      provider: model.provider,
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 3,
      domainTools: [crm],
      nativeToolRegistry: new NativeToolRegistry(),
    });
    const input = { ...REQUEST, userMessage: '#crm Speichere die Adresse von Partner 42.' };
    const ledger = new ToolReplayLedger();
    // A re-entry whose first run never asked the specialist this question.
    ledger.beginReentry();
    orchestrator.bindToolReplayLedger(input, ledger);

    await assert.rejects(orchestrator.runTurn(input), ToolReplayAbortError);

    assert.equal(asked.length, 0, 'the specialist was never asked');
  });

  it('control: a turn without a bound ledger never replays', async () => {
    const registry = new NativeToolRegistry();
    const ticket = registerWriteTool(registry, 'create_ticket', () => Promise.resolve(CREATED));
    const model = scriptedModel([
      toolCalls(['create_ticket', TICKET]),
      text('Angelegt.'),
      toolCalls(['create_ticket', TICKET]),
      text('Angelegt.'),
    ]);
    const orchestrator = new Orchestrator({
      provider: model.provider,
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 3,
      domainTools: [],
      nativeToolRegistry: registry,
    });

    await orchestrator.runTurn(REQUEST);
    await orchestrator.runTurn(REQUEST);

    assert.equal(ticket.inputs.length, 2, 'two requests, two writes');
  });
});

/**
 * While a request ledger is bound, every seam runs its handler sending each
 * call beneath it once (`runHandlerAtMostOnce`): the MCP client then does not
 * re-send a call after a transient failure — a re-send the ledger, which sees
 * one handler call, could not stop. `mcpWriteIdempotency.test.ts` drives the
 * real transport; here each seam's handler reads the signal it runs under.
 */
describe('a seam sends each call once only while a request ledger is bound', () => {
  function probeRegistry(seen: boolean[]): NativeToolRegistry {
    const registry = new NativeToolRegistry();
    registry.register('probe_send_once', {
      handler: () => {
        seen.push(sendsEachCallOnce());
        return Promise.resolve('ok');
      },
      spec: {
        name: 'probe_send_once',
        description: 'reads the send-once signal (test)',
        input_schema: { type: 'object' as const, properties: {}, required: [] },
      } as never,
      domain: 'test.probe',
    });
    return registry;
  }

  it('the orchestrator’s dispatch', async () => {
    const seen: boolean[] = [];
    const model = scriptedModel([
      toolCalls(['probe_send_once', {}]),
      text('fertig'),
      toolCalls(['probe_send_once', {}]),
      text('fertig'),
    ]);
    const orchestrator = new Orchestrator({
      provider: model.provider,
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 3,
      domainTools: [],
      nativeToolRegistry: probeRegistry(seen),
    });
    const bound = { ...REQUEST };
    const release = orchestrator.bindToolReplayLedger(bound, new ToolReplayLedger());

    await orchestrator.runTurn(bound);
    release();
    await orchestrator.runTurn({ ...REQUEST });

    assert.deepEqual(seen, [true, false], 'bound request, then a turn-local ledger');
  });

  it('`ToolDispatchService` under the ambient ledger', async () => {
    const seen: boolean[] = [];
    const dispatch = new ToolDispatchService({ nativeTools: probeRegistry(seen) });

    await inTurn(new ToolReplayLedger(), () => dispatch.dispatch('probe_send_once', {}));
    await inTurn(new ToolReplayLedger({ retainResults: false }), () =>
      dispatch.dispatch('probe_send_once', {}),
    );
    await inTurn(undefined, () => dispatch.dispatch('probe_send_once', {}));

    assert.deepEqual(seen, [true, false, false]);
  });

  it('a `LocalSubAgent`’s inner calls', async () => {
    const seen: boolean[] = [];
    const run = () => [toolCalls(['probe_send_once', {}]), text('fertig')];
    const model = scriptedModel([...run(), ...run()]);
    const agent = new LocalSubAgent({
      name: 'probe',
      provider: model.provider,
      model: 'test',
      maxTokens: 1024,
      maxIterations: 3,
      systemPrompt: 'test',
      tools: [
        {
          spec: {
            name: 'probe_send_once',
            description: 'reads the send-once signal (test)',
            input_schema: { type: 'object' as const, properties: {}, required: [] },
          },
          handle: () => {
            seen.push(sendsEachCallOnce());
            return Promise.resolve('ok');
          },
        },
      ],
    } as ConstructorParameters<typeof LocalSubAgent>[0]);

    await inTurn(new ToolReplayLedger(), () => agent.ask('Frage'));
    await inTurn(new ToolReplayLedger({ retainResults: false }), () => agent.ask('Frage'));

    assert.deepEqual(seen, [true, false]);
  });
});
