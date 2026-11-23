/**
 * Spec 2042 §5.10, §6 criterion 37 — "the agent runtime, verifier and fast
 * lane keep working through the gateway".
 *
 * With the gateway in `enforce`, a model call outside any execution context
 * is refused. `withAgentTurnExecution` is the outermost layer of every
 * agent's chat agent, so what runs before the loop (the fast lane's triage),
 * the loop itself, what runs after it (the verifier's scorers) and the
 * `claude-cli` runtime (which opens no turn scope of its own) all run as the
 * agent's turn and are admitted.
 */

import { strict as assert } from 'node:assert';
import { PassThrough } from 'node:stream';
import { afterEach, describe, it } from 'node:test';

import type { ChatAgent, ChatStreamEvent, ChatTurnInput, SemanticAnswer } from '@omadia/channel-sdk';
import { isModelCallNotCovered, type LlmProvider } from '@omadia/llm-provider';
import {
  currentExecutionContext,
  resetModelGatewayForTests,
  setModelCallHalts,
  setModelGatewayMode,
} from '@omadia/usage-telemetry';

import { CliChatAgent } from '../packages/harness-orchestrator/src/cliChatAgent.js';
import type { CliChatAgentDeps } from '../packages/harness-orchestrator/src/cliChatAgent.js';
import { withAgentTurnExecution } from '../packages/harness-orchestrator/src/agentTurnExecution.js';
import { scriptedModel } from './_helpers/scriptedModel.js';

afterEach(() => resetModelGatewayForTests());

const ask = (provider: LlmProvider, text: string): Promise<unknown> =>
  provider.complete({
    model: 'm',
    maxTokens: 10,
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
  });

/**
 * A chat agent shaped like the runtime around the loop: the fast lane's
 * triage call before it, the loop's call, the verifier's scorer after it.
 */
function laneLoopVerifierAgent(provider: LlmProvider, seen: string[]): ChatAgent {
  const run = async (): Promise<SemanticAnswer> => {
    await ask(provider, 'fast lane triage');
    seen.push(`triage:${currentExecutionContext()?.agentSlug ?? 'none'}`);
    await ask(provider, 'agent loop');
    seen.push(`loop:${currentExecutionContext()?.agentSlug ?? 'none'}`);
    await ask(provider, 'verifier scorer');
    seen.push(`verifier:${currentExecutionContext()?.agentSlug ?? 'none'}`);
    return { text: 'answer' } as SemanticAnswer;
  };
  return {
    chat: (_input: ChatTurnInput) => run(),
    async *chatStream(): AsyncGenerator<ChatStreamEvent> {
      const answer = await run();
      yield { type: 'text_delta', text: answer.text } as ChatStreamEvent;
    },
  } as unknown as ChatAgent;
}

function fakeCliAgent(): { readonly agent: CliChatAgent; readonly spawned: () => number } {
  let spawned = 0;
  const agent = new CliChatAgent({
    dispatch: { listDispatchableToolSpecs: () => [], agentSlug: 'sales' } as unknown as CliChatAgentDeps['dispatch'],
    createLoopbackServer: () =>
      ({
        start: async () => ({ url: 'http://127.0.0.1:1/mcp', port: 1, bearer: 'bearer' }),
        stop: async () => {},
      }) as never,
    resolveCliVersion: async () => '2.1.259',
    logger: { info: () => {}, warn: () => {} },
    spawnFn: (() => {
      spawned += 1;
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
      stdin.on('finish', () => {
        stdout.end(JSON.stringify({ type: 'result', is_error: false, result: 'cli answer', num_turns: 1 }) + '\n');
        child.exitCode = 0;
        child.emit('close', 0, null);
      });
      stdin.resume();
      return child;
    }) as unknown as CliChatAgentDeps['spawnFn'],
  });
  return { agent, spawned: () => spawned };
}

describe('agent turns under the gateway in enforce (criterion 37)', () => {
  it('criterion 37: the fast lane, the agent loop and the verifier keep working through the gateway in enforce', async () => {
    setModelGatewayMode('enforce');
    const model = scriptedModel();
    model.script({ text: 'triage' }, { text: 'loop' }, { text: 'verdict' });
    const seen: string[] = [];
    const agent = withAgentTurnExecution(laneLoopVerifierAgent(model.provider, seen), 'sales');

    const answer = await agent.chat({ userMessage: 'hi' } as ChatTurnInput);
    assert.equal(answer.text, 'answer');
    assert.deepEqual(seen, ['triage:sales', 'loop:sales', 'verifier:sales']);
    assert.equal(model.requests.length, 3);

    // The streaming path too.
    model.script({ text: 'triage' }, { text: 'loop' }, { text: 'verdict' });
    const events: ChatStreamEvent[] = [];
    for await (const event of agent.chatStream({ userMessage: 'hi' } as ChatTurnInput)) events.push(event);
    assert.equal(events.length, 1);
    assert.equal(model.requests.length, 6);
  });

  it('the same calls outside an agent turn are refused in enforce (the control)', async () => {
    setModelGatewayMode('enforce');
    const model = scriptedModel();
    model.script({ text: 'triage' });
    await assert.rejects(
      laneLoopVerifierAgent(model.provider, []).chat({ userMessage: 'hi' } as ChatTurnInput),
      (err: unknown) => isModelCallNotCovered(err),
    );
    assert.equal(model.requests.length, 0);
  });

  it('criterion 37: an agent on claude-cli keeps working through the gateway in enforce (run_loop)', async () => {
    setModelGatewayMode('enforce');
    const cli = fakeCliAgent();
    const answer = await withAgentTurnExecution(cli.agent, 'sales').chat({ userMessage: 'hi' } as ChatTurnInput);
    assert.equal(answer.text, 'cli answer');
    assert.equal(cli.spawned(), 1);

    // Control: the bare CLI agent, outside the agent's turn, is refused
    // before the CLI starts, through chat() and chatStream() alike.
    const bare = fakeCliAgent();
    await assert.rejects(bare.agent.chat({ userMessage: 'hi' } as ChatTurnInput), (err: unknown) =>
      isModelCallNotCovered(err),
    );
    await assert.rejects(
      (async () => {
        for await (const _event of bare.agent.chatStream({ userMessage: 'hi' } as ChatTurnInput)) void _event;
      })(),
      (err: unknown) => isModelCallNotCovered(err),
    );
    assert.equal(bare.spawned(), 0);
  });

  it('criterion 37: a claude-cli turn through chat() is admitted as run_loop, so the kill switch refuses it before the CLI starts', async () => {
    setModelCallHalts({ agents: new Map([['sales', 'runaway']]) });
    const cli = fakeCliAgent();
    await assert.rejects(withAgentTurnExecution(cli.agent, 'sales').chat({ userMessage: 'hi' } as ChatTurnInput), (err: unknown) =>
      isModelCallNotCovered(err),
    );
    assert.equal(cli.spawned(), 0);
  });
});
