/**
 * Within one user request, no loop repeats a write call that ended in an
 * exception.
 *
 * An exception says nothing about how far a call got: a write can commit
 * upstream and its response then time out. `LocalSubAgent` already refused an
 * identical repeat of such a call within its own run; the orchestrator's own
 * tool loops (buffered and streaming) and a subscription-CLI sub-agent's
 * loopback dispatch did not, so their model could call the same write with
 * the same input again and it would run twice. The per-request ledger every
 * turn carries now remembers a call whose outcome is unknown and answers an
 * identical repeat with a refusal notice, without running the handler. A
 * different input, a call that RETURNED an ordinary `Error:` hint, and a
 * kernel tool known to be read-only still run.
 *
 * Imported from SOURCE so the ledger's AsyncLocalStorage is the one the
 * orchestrator uses. All values are synthetic.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { NativeToolRegistry } from '../../packages/harness-orchestrator/src/nativeToolRegistry.js';
import { Orchestrator } from '../../packages/harness-orchestrator/src/orchestrator.js';
import { ToolDispatchService } from '../../packages/harness-orchestrator/src/toolDispatchService.js';
import type { DomainTool } from '../../packages/harness-orchestrator/src/tools/domainQueryTool.js';
import {
  REQUEST,
  drain,
  registerWriteTool,
  scriptedModel,
  text,
  toolCalls,
  toolResultContents,
} from '../_helpers/replayTurnFixture.js';

const TICKET = { title: 'Drucker defekt', priority: 'high' };
const OTHER_TICKET = { title: 'Drucker defekt', priority: 'low' };
const REFUSED = /was not called: an identical call/;

function orchestratorOver(
  responses: Parameters<typeof scriptedModel>[0],
  registry: NativeToolRegistry,
  domainTools: DomainTool[] = [],
) {
  const model = scriptedModel(responses);
  const orchestrator = new Orchestrator({
    provider: model.provider,
    model: 'test',
    maxTokens: 1024,
    maxToolIterations: 5,
    domainTools,
    nativeToolRegistry: registry,
  });
  return { orchestrator, model };
}

const throwing = () => Promise.reject(new Error('socket hang up after commit'));

describe('the orchestrator loops refuse an identical repeat of a call that threw', () => {
  beforeEach(() => {
    mock.method(console, 'error', () => undefined);
    mock.method(console, 'warn', () => undefined);
  });
  afterEach(() => {
    mock.restoreAll();
  });

  it('MUTATION CHECK, buffered loop: the repeat is refused, the handler ran once', async () => {
    const registry = new NativeToolRegistry();
    const ticket = registerWriteTool(registry, 'create_ticket', throwing);
    const { orchestrator, model } = orchestratorOver(
      [
        toolCalls(['create_ticket', TICKET]),
        toolCalls(['create_ticket', TICKET]),
        text('Das Ticket konnte nicht sicher angelegt werden.'),
      ],
      registry,
    );

    await orchestrator.runTurn(REQUEST);

    assert.equal(ticket.inputs.length, 1, 'the write ran once');
    const repeatResult = toolResultContents(model.requests[2]).at(-1) ?? '';
    assert.match(repeatResult, REFUSED);
  });

  it('MUTATION CHECK, streaming loop: the repeat is refused, the handler ran once', async () => {
    const registry = new NativeToolRegistry();
    const ticket = registerWriteTool(registry, 'create_ticket', throwing);
    const { orchestrator, model } = orchestratorOver(
      [
        toolCalls(['create_ticket', TICKET]),
        toolCalls(['create_ticket', TICKET]),
        text('Das Ticket konnte nicht sicher angelegt werden.'),
      ],
      registry,
    );

    await drain(orchestrator.chatStream(REQUEST));

    assert.equal(ticket.inputs.length, 1, 'the write ran once');
    assert.match(toolResultContents(model.requests[2]).at(-1) ?? '', REFUSED);
  });

  it('control: another input, and a repeat after a returned Error: hint, still run', async () => {
    const registry = new NativeToolRegistry();
    const ticket = registerWriteTool(registry, 'create_ticket', (_input, n) =>
      n === 1 ? throwing() : Promise.resolve('Error: priority must be one of low, normal'),
    );
    const { orchestrator } = orchestratorOver(
      [
        toolCalls(['create_ticket', TICKET]),
        toolCalls(['create_ticket', OTHER_TICKET]),
        toolCalls(['create_ticket', OTHER_TICKET]),
        text('Das Ticket ist nicht angelegt.'),
      ],
      registry,
    );

    await orchestrator.runTurn(REQUEST);

    assert.deepEqual(ticket.inputs, [TICKET, OTHER_TICKET, OTHER_TICKET]);
  });

  it('control: a new request starts with a clean slate', async () => {
    const registry = new NativeToolRegistry();
    const ticket = registerWriteTool(registry, 'create_ticket', throwing);
    const { orchestrator } = orchestratorOver(
      [
        toolCalls(['create_ticket', TICKET]),
        text('Fehlgeschlagen.'),
        toolCalls(['create_ticket', TICKET]),
        text('Fehlgeschlagen.'),
      ],
      registry,
    );

    await orchestrator.runTurn(REQUEST);
    await orchestrator.runTurn(REQUEST);

    assert.equal(ticket.inputs.length, 2, 'the user asked twice');
  });
});

describe('a CLI sub-agent’s loopback dispatch refuses the repeat within the same request', () => {
  beforeEach(() => {
    mock.method(console, 'error', () => undefined);
    mock.method(console, 'warn', () => undefined);
  });
  afterEach(() => {
    mock.restoreAll();
  });

  it('MUTATION CHECK: the dispatch seam sees the request’s ledger through the snapshot', async () => {
    // The CLI sub-agent's own tools, served by a dedicated dispatcher — the
    // shape `createCliSubAgent` builds.
    const inner = new NativeToolRegistry();
    const cliTicket = registerWriteTool(inner, 'cli_create_ticket', throwing);
    const dispatch = new ToolDispatchService({ nativeTools: inner });
    const contents: string[] = [];
    // The domain tool stands in for `createCliSubAgent`: it captures the
    // caller's async context the way `CliChatAgent.captureTurnContext` does,
    // and the loopback server's `tools/call` handler, which runs in a fresh
    // async root, re-enters it for every call the CLI makes.
    const askCli: DomainTool = {
      name: 'ask_cli',
      spec: {
        name: 'ask_cli',
        description: 'CLI sub-agent (test)',
        input_schema: { type: 'object', properties: {}, required: [] },
      },
      domain: 'cli.test',
      handle: async () => {
        const runInTurnContext = AsyncLocalStorage.snapshot();
        for (let i = 0; i < 2; i += 1) {
          const result = await new Promise<string>((resolve) => {
            setImmediate(() => {
              void runInTurnContext(() => dispatch.dispatch('cli_create_ticket', TICKET)).then(
                (r) => resolve(r.content),
              );
            });
          });
          contents.push(result);
        }
        return 'Das Ticket wurde nicht bestätigt.';
      },
    };
    const { orchestrator } = orchestratorOver(
      [toolCalls(['ask_cli', {}]), text('Erledigt.')],
      new NativeToolRegistry(),
      [askCli],
    );

    await orchestrator.runTurn(REQUEST);

    assert.equal(cliTicket.inputs.length, 1, 'the CLI’s write ran once');
    assert.match(contents[1] ?? '', REFUSED);
  });
});
