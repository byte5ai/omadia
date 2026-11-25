import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { CliChatAgent } from '../../packages/harness-orchestrator/src/cliChatAgent.js';
import type { CliChatAgentDeps } from '../../packages/harness-orchestrator/src/cliChatAgent.js';
import type { ChatTurnInput } from '../../packages/harness-channel-sdk/src/chatAgent.js';

/**
 * #2217 / ADR 0043 — a tool-less turn on the subscription CLI: no loopback
 * MCP server, an mcp-config without servers, nothing pre-approved. The
 * permission gate (`--tools ""`, deny list, strict mcp-config) is unchanged.
 */

const OFFERED_SPEC = {
  name: 'ask_user_choice',
  description: 'choice',
  input_schema: { type: 'object' as const, properties: {} },
};

interface Spawned {
  readonly argv: readonly string[];
  readonly mcpConfig: string;
  readonly stdin: string;
}

function makeAgent(initTools: readonly string[]): {
  readonly agent: CliChatAgent;
  readonly spawned: Spawned[];
  readonly loopbackStarts: () => number;
} {
  const spawned: Spawned[] = [];
  let starts = 0;
  const agent = new CliChatAgent({
    dispatch: {
      listDispatchableToolSpecs: () => [OFFERED_SPEC],
    } as unknown as CliChatAgentDeps['dispatch'],
    createLoopbackServer: () =>
      ({
        start: async () => {
          starts += 1;
          return { url: 'http://127.0.0.1:1/mcp', port: 1, bearer: 'bearer' };
        },
        stop: async () => {},
      }) as never,
    resolveCliVersion: async () => '2.1.312',
    logger: { info: () => {}, warn: () => {} },
    buildEnv: () => ({ PATH: '/usr/bin', HOME: '/home/tester' }),
    spawnFn: ((_bin: string, argv: string[], opts: { cwd: string }) => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdin = new PassThrough();
      const chunks: Buffer[] = [];
      stdin.on('data', (c: Buffer) => chunks.push(c));
      const mcpConfig = readFileSync(join(opts.cwd, 'mcp-config.json'), 'utf8');
      const child = Object.assign(new PassThrough(), {
        stdin,
        stdout,
        stderr,
        exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null,
        kill: () => true,
      });
      stdin.on('finish', () => {
        spawned.push({ argv, mcpConfig, stdin: Buffer.concat(chunks).toString('utf8') });
        const lines = [
          JSON.stringify({ type: 'system', subtype: 'init', tools: initTools, mcp_servers: [] }),
          JSON.stringify({ type: 'result', is_error: false, result: 'Antwort.', num_turns: 1 }),
        ];
        stdout.end(lines.map((l) => `${l}\n`).join(''));
        setTimeout(() => {
          child.exitCode = 0;
          child.emit('close', 0, null);
        }, 5);
      });
      return child;
    }) as unknown as CliChatAgentDeps['spawnFn'],
  });
  return { agent, spawned, loopbackStarts: () => starts };
}

async function drain(agent: CliChatAgent, input: ChatTurnInput): Promise<void> {
  for await (const _event of agent.chatStream(input)) {
    // drain
  }
}

describe('CLI tool-less turn (#2217)', () => {
  it('starts no loopback server and spawns with an empty mcp-config', async () => {
    const { agent, spawned, loopbackStarts } = makeAgent([]);
    await drain(agent, { userMessage: 'Bewerte den Entwurf.', toolsOff: true });
    assert.equal(loopbackStarts(), 0);
    assert.equal(spawned.length, 1);
    assert.deepEqual(JSON.parse(spawned[0]!.mcpConfig), { mcpServers: {} });
  });

  it('pre-approves nothing, and keeps the permission gate', async () => {
    const { agent, spawned } = makeAgent([]);
    await drain(agent, { userMessage: 'x', toolsOff: true });
    const argv = spawned[0]!.argv;
    assert.equal(argv.includes('--allowedTools'), false);
    assert.ok(argv.includes('--strict-mcp-config'));
    const tools = argv.indexOf('--tools');
    assert.ok(tools >= 0 && argv[tools + 1] === '');
    assert.ok(argv.includes('--disallowedTools'));
  });

  it('tells the model it has no tools', async () => {
    const { agent, spawned } = makeAgent([]);
    await drain(agent, { userMessage: 'x', toolsOff: true });
    assert.match(spawned[0]!.stdin, /TURN OHNE WERKZEUGE/);
  });

  it('a normal turn still runs with the loopback server and its tools', async () => {
    const { agent, spawned, loopbackStarts } = makeAgent(['mcp__omadia__ask_user_choice']);
    await drain(agent, { userMessage: 'x' });
    assert.equal(loopbackStarts(), 1);
    assert.ok(spawned[0]!.argv.includes('--allowedTools'));
    assert.doesNotMatch(spawned[0]!.stdin, /TURN OHNE WERKZEUGE/);
  });
});
