/**
 * ADR-0044 follow-up — a turn the subscription CLI answers gets its graph read
 * boundary even when the agent has no memory tool.
 *
 * Before: `bindCliTurnMemory` returned before the binding that publishes the
 * boundary, and the CLI turn context carried no box to publish it into. Every
 * loopback tool call (process tools, a plugin's bounded `knowledgeGraph@1`)
 * then read with no boundary and failed closed: correct reads came back empty.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PassThrough } from 'node:stream';

import type { KnowledgeGraph } from '@omadia/plugin-api';

import type { ChatTurnInput } from '../packages/harness-channel-sdk/src/chatAgent.js';
import { CliChatAgent, type CliChatAgentDeps } from '../packages/harness-orchestrator/src/cliChatAgent.js';
import { NativeToolRegistry } from '../packages/harness-orchestrator/src/nativeToolRegistry.js';
import { Orchestrator, type OrchestratorOptions } from '../packages/harness-orchestrator/src/orchestrator.js';
import { turnContext, type GraphReadScope } from '../packages/harness-orchestrator/src/turnContext.js';
import { scriptedModel, text } from './_helpers/replayTurnFixture.js';

const knowledgeGraph = new Proxy(
  {},
  {
    get(_target, prop) {
      if (prop === 'resolveOrCreateChannelIdentity') {
        return async (input: { channelUserId: string }) => ({ omadiaUserId: input.channelUserId });
      }
      return undefined;
    },
  },
) as unknown as KnowledgeGraph;

/** An agent whose archetype omits memory (a facilitator): no memory tool. */
function orchestratorWithoutMemory(): Orchestrator {
  return new Orchestrator({
    provider: scriptedModel([text('ok')]).provider,
    model: 'test',
    maxTokens: 1024,
    maxToolIterations: 4,
    domainTools: [],
    nativeToolRegistry: new NativeToolRegistry(),
    agentId: 'mira',
    knowledgeGraph,
    archetypeOmissions: { memory: true },
  } as unknown as OrchestratorOptions);
}

const INPUT: ChatTurnInput = { userMessage: 'Welche Prozesse kenne ich?', sessionScope: 'web-1', userId: 'u1' };

function line(payload: unknown): string {
  return `${JSON.stringify(payload)}\n`;
}

function fakeChild() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  const child = Object.assign(new PassThrough(), {
    stdin,
    stdout,
    stderr,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: () => true,
  });
  stdin.resume();
  stdin.on('finish', () => {
    stdout.end(line({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1 }));
    stderr.end('');
    child.exitCode = 0;
    child.emit('close', 0, null);
  });
  return child;
}

function cliAgent(orchestrator: Orchestrator, onLoopback: (run: <T>(fn: () => T) => T) => void): CliChatAgent {
  return new CliChatAgent({
    dispatch: { listDispatchableToolSpecs: () => [], agentSlug: 'mira' } as unknown as CliChatAgentDeps['dispatch'],
    createLoopbackServer: ((opts: { runInTurnContext: <T>(fn: () => T) => T }) => {
      onLoopback(opts.runInTurnContext);
      return {
        start: async () => ({ url: 'http://127.0.0.1:1/mcp', port: 1, bearer: 'bearer' }),
        stop: async () => {},
      };
    }) as never,
    resolveCliVersion: async () => '2.1.187',
    logger: { info: () => undefined, warn: () => undefined },
    discretionTurnFields: (input) => orchestrator.cliDiscretionTurnFields(input),
    bindTurnMemory: (input) => orchestrator.bindCliTurnMemory(input),
    spawnFn: fakeChild as unknown as CliChatAgentDeps['spawnFn'],
  });
}

describe('CLI turn graph boundary (ADR-0044 follow-up)', () => {
  it('bindCliTurnMemory publishes the boundary for an agent without a memory tool', async () => {
    const orchestrator = orchestratorWithoutMemory();
    const box: { value?: GraphReadScope } = {};
    const memory = await turnContext.runScoped(
      { turnId: 't1', turnDate: '2026-11-25', graphReadScope: box },
      () => orchestrator.bindCliTurnMemory(INPUT),
    );
    assert.equal(memory, undefined, 'still no memory tool');
    assert.equal(box.value?.kind, 'user');
    assert.equal(box.value?.kind === 'user' ? box.value.userId : undefined, 'u1');
  });

  it('a CLI turn inside a caller\'s turn binds its own box, never the caller\'s', async () => {
    const orchestrator = orchestratorWithoutMemory();
    let runInTurnContext: (<T>(fn: () => T) => T) | undefined;
    const agent = cliAgent(orchestrator, (run) => {
      runInTurnContext = run;
    });
    const callerBound: GraphReadScope = { kind: 'members', audience: ['a', 'b'], agentScopePrefix: 'other::' };
    const callerBox: { value?: GraphReadScope } = { value: callerBound };
    await turnContext.runScoped({ turnId: 'outer', turnDate: '2026-11-25', graphReadScope: callerBox }, async () => {
      for await (const _ev of agent.chatStream(INPUT)) {
        // drain
      }
    });
    assert.equal(callerBox.value, callerBound, "the caller's boundary is untouched");
    assert.equal(runInTurnContext?.(() => turnContext.current()?.graphReadScope?.value)?.kind, 'user');
  });

  it('a loopback tool call of the CLI turn reads with the boundary', async () => {
    const orchestrator = orchestratorWithoutMemory();
    let runInTurnContext: (<T>(fn: () => T) => T) | undefined;
    const agent = new CliChatAgent({
      dispatch: { listDispatchableToolSpecs: () => [], agentSlug: 'mira' } as unknown as CliChatAgentDeps['dispatch'],
      createLoopbackServer: ((opts: { runInTurnContext: <T>(fn: () => T) => T }) => {
        runInTurnContext = opts.runInTurnContext;
        return {
          start: async () => ({ url: 'http://127.0.0.1:1/mcp', port: 1, bearer: 'bearer' }),
          stop: async () => {},
        };
      }) as never,
      resolveCliVersion: async () => '2.1.187',
      logger: { info: () => undefined, warn: () => undefined },
      discretionTurnFields: (input) => orchestrator.cliDiscretionTurnFields(input),
      bindTurnMemory: (input) => orchestrator.bindCliTurnMemory(input),
      spawnFn: fakeChild as unknown as CliChatAgentDeps['spawnFn'],
    });
    for await (const _ev of agent.chatStream(INPUT)) {
      // drain
    }
    assert.ok(runInTurnContext, 'the loopback server was built');
    const bound = runInTurnContext(() => turnContext.current()?.graphReadScope?.value);
    assert.equal(bound?.kind, 'user', 'a tool call sees the turn boundary, not none');
  });
});
