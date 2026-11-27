/**
 * #2377 (follow-up of #2374, ADR-0301) — the `CliChatAgent` side of connect
 * requests: a connect prompt a loopback call minted during a CLI turn is named
 * on that turn's `chat()` result (`mcpConnectRequired`), never on the caller's
 * map directly, and a withheld answer carries none. A CLI sub-agent
 * (`createCliSubAgent`) hands its turn's requests to the calling turn's map.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { PassThrough } from 'node:stream';

import { MCP_AUTH_PROMPT_PREFIX } from '@omadia/plugin-api';

import { CliChatAgent } from '../../packages/harness-orchestrator/src/cliChatAgent.js';
import type { CliChatAgentDeps } from '../../packages/harness-orchestrator/src/cliChatAgent.js';
import { createCliSubAgent } from '../../packages/harness-orchestrator/src/cliSubAgent.js';
import {
  McpAuthPromptMint,
  notePendingMcpConnect,
  recordMcpAuthPrompt,
  runWithMcpAuthPromptMint,
} from '../../packages/harness-orchestrator/src/mcp/mcpAuthPromptMint.js';
import { turnContext } from '../../packages/harness-orchestrator/src/turnContext.js';

type ConnectRequest = { readonly serverId: string; readonly serverName: string };

const PROMPT =
  `${MCP_AUTH_PROMPT_PREFIX}Linear" needs you to connect your account.\n\n` +
  '<mcp-auth-required server="Linear" serverId="srv-linear"></mcp-auth-required>';

function fakeSpawn(result: string): CliChatAgentDeps['spawnFn'] {
  return ((_bin: string, _argv: string[]) => {
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    const child = Object.assign(new PassThrough(), {
      stdin,
      stdout,
      stderr: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill: () => true,
    });
    stdin.on('data', () => undefined);
    stdin.on('finish', () => {
      const lines = [
        JSON.stringify({ type: 'system', subtype: 'init', tools: [], mcp_servers: [] }),
        JSON.stringify({ type: 'result', is_error: false, result, num_turns: 1 }),
      ];
      stdout.end(lines.map((l) => `${l}\n`).join(''));
      setTimeout(() => {
        child.exitCode = 0;
        child.emit('close', 0, null);
      }, 5);
    });
    return child;
  }) as unknown as CliChatAgentDeps['spawnFn'];
}

/**
 * Stands in for a loopback tool call of the turn: the dispatcher records a
 * minted prompt through `notePendingMcpConnect`, inside the CLI turn's
 * captured context. The attachment drain is the seam that runs there.
 */
function mintOnTurn(): void {
  const mint = new McpAuthPromptMint();
  runWithMcpAuthPromptMint(mint, () => recordMcpAuthPrompt(PROMPT));
  notePendingMcpConnect(mint, PROMPT);
}

function agentWith(deps: Partial<CliChatAgentDeps> = {}): CliChatAgent {
  return new CliChatAgent({
    dispatch: { listDispatchableToolSpecs: () => [] } as unknown as CliChatAgentDeps['dispatch'],
    policyEnv: {},
    resolveCliVersion: async () => '2.1.312',
    logger: { info: () => {}, warn: () => {} },
    buildEnv: () => ({ PATH: '/usr/bin', HOME: '/home/tester' }),
    spawnFn: fakeSpawn('Bitte verbinde Linear.'),
    drainTurnAttachments: () => {
      mintOnTurn();
      return {};
    },
    ...deps,
  });
}

describe('#2377 · CliChatAgent names its connect requests on chat()', () => {
  it('returns the minted server on the result and keeps the caller map untouched', async () => {
    const outer = new Map<string, ConnectRequest>();
    const answer = await turnContext.run(
      { turnId: 'turn-2377', turnDate: '2026-11-27', mcpConnectRequests: outer },
      () => agentWith().chat({ userMessage: 'Suche in Linear' }),
    );
    assert.deepEqual(answer.mcpConnectRequired, [{ serverId: 'srv-linear', serverName: 'Linear' }]);
    assert.equal(outer.size, 0, 'the CLI turn has its own map');
  });

  it('a withheld answer carries no connect request', async () => {
    const agent = agentWith({ guardAnswer: async () => ({ answer: 'zurückgehalten', withheld: true }) });
    const answer = await turnContext.run({ turnId: 'turn-2377-w', turnDate: '2026-11-27' }, () =>
      agent.chat({ userMessage: 'Suche in Linear' }),
    );
    assert.equal(answer.mcpConnectRequired, undefined);
  });
});

describe('#2377 · a CLI sub-agent forwards its connect requests to the calling turn', () => {
  function subAgent(deps: Partial<CliChatAgentDeps> = {}) {
    return createCliSubAgent({
      name: 'linear',
      systemPrompt: 'You are linear.',
      model: 'sonnet',
      tools: [],
      createCliAgent: (base) => agentWith({ ...base, ...deps }),
    });
  }

  it('puts the sub-agent turn’s requests on the parent turn map', async () => {
    const parent = new Map<string, ConnectRequest>();
    await turnContext.run(
      { turnId: 'turn-parent', turnDate: '2026-11-27', mcpConnectRequests: parent },
      () => subAgent().ask('Suche in Linear'),
    );
    assert.deepEqual([...parent.values()], [{ serverId: 'srv-linear', serverName: 'Linear' }]);
  });

  it('forwards nothing for a withheld sub-agent answer', async () => {
    const parent = new Map<string, ConnectRequest>();
    await turnContext.run(
      { turnId: 'turn-parent-w', turnDate: '2026-11-27', mcpConnectRequests: parent },
      () => subAgent({ guardAnswer: async () => ({ answer: 'zurückgehalten', withheld: true }) }).ask('x'),
    );
    assert.equal(parent.size, 0);
  });

  it('does not throw when the caller has no request map', async () => {
    const answer = await subAgent().ask('Suche in Linear');
    assert.equal(typeof answer, 'string');
  });
});
