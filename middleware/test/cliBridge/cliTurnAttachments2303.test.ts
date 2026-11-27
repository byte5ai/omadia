/**
 * #2303 (ADR-0177) — a subscription-CLI turn delivers the files and diagrams
 * its loopback tool calls produced: the agent drains the sinks once, inside
 * the turn's captured context (the sinks key on that turn id), and puts them
 * on the `done` event and the semantic answer. A withheld answer carries none.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { PassThrough } from 'node:stream';

import { CliChatAgent } from '../../packages/harness-orchestrator/src/cliChatAgent.js';
import type { CliChatAgentDeps } from '../../packages/harness-orchestrator/src/cliChatAgent.js';
import { turnContext } from '../../packages/harness-orchestrator/src/turnContext.js';
import type { ChatStreamEvent } from '../../packages/harness-channel-sdk/src/chatAgent.js';

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

const FILE = {
  kind: 'file' as const,
  url: 'https://example.test/documents/dl/report.xlsx?exp=1&sig=x',
  altText: 'report.xlsx',
  mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  producer: 'office.xlsx',
};

function agentWith(deps: Partial<CliChatAgentDeps>, drainedIn: Array<string | undefined>) {
  return new CliChatAgent({
    dispatch: { listDispatchableToolSpecs: () => [] } as unknown as CliChatAgentDeps['dispatch'],
    policyEnv: {},
    resolveCliVersion: async () => '2.1.312',
    logger: { info: () => {}, warn: () => {} },
    buildEnv: () => ({ PATH: '/usr/bin', HOME: '/home/tester' }),
    spawnFn: fakeSpawn('Hier ist die Datei.'),
    drainTurnAttachments: () => {
      drainedIn.push(turnContext.current()?.turnId);
      return { fileAttachments: [FILE] };
    },
    ...deps,
  });
}

describe('CLI turn delivers generated files (#2303)', () => {
  it('puts the drained files on the done event, drained inside the turn context', async () => {
    const drainedIn: Array<string | undefined> = [];
    const agent = agentWith({}, drainedIn);
    const events: ChatStreamEvent[] = [];
    await turnContext.run({ turnId: 'turn-2303', turnDate: '2026-11-27' }, async () => {
      for await (const event of agent.chatStream({ userMessage: 'Excel bitte' })) events.push(event);
    });
    const done = events.find((e) => e.type === 'done');
    assert.ok(done && done.type === 'done');
    assert.deepEqual(done.fileAttachments, [FILE]);
    assert.deepEqual(drainedIn, ['turn-2303']);
  });

  it('chat() returns them as attachments of the semantic answer', async () => {
    const agent = agentWith({}, []);
    const answer = await turnContext.run({ turnId: 'turn-b', turnDate: '2026-11-27' }, () =>
      agent.chat({ userMessage: 'Excel bitte' }),
    );
    assert.equal(answer.attachments?.length, 1);
    assert.equal(answer.attachments?.[0]?.kind, 'file');
  });

  it('a withheld answer carries no files, and the buffers are still drained', async () => {
    const drainedIn: Array<string | undefined> = [];
    const agent = agentWith(
      { guardAnswer: async () => ({ answer: 'zurückgehalten', withheld: true }) },
      drainedIn,
    );
    const events: ChatStreamEvent[] = [];
    await turnContext.run({ turnId: 'turn-c', turnDate: '2026-11-27' }, async () => {
      for await (const event of agent.chatStream({ userMessage: 'Excel bitte' })) events.push(event);
    });
    const done = events.find((e) => e.type === 'done');
    assert.ok(done && done.type === 'done');
    assert.equal(done.fileAttachments, undefined);
    assert.equal(drainedIn.length, 1);
  });
});
