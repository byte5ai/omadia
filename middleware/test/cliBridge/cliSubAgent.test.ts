import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { LocalSubAgentTool } from '@omadia/plugin-api';

import { createCliSubAgent } from '../../packages/harness-orchestrator/src/cliSubAgent.js';
import type { CliChatAgentDeps } from '../../packages/harness-orchestrator/src/cliChatAgent.js';

describe('createCliSubAgent', () => {
  it('routes ask() through CliChatAgent.chat and exposes sub-agent tools on dispatch', async () => {
    let seenInput: { userMessage: string } | undefined;
    let capturedDeps: CliChatAgentDeps | undefined;
    const structuredTool: LocalSubAgentTool = {
      spec: {
        name: 'sub_lookup',
        description: 'lookup',
        input_schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
          },
          required: ['id'],
        },
      },
      async handle(input) {
        assert.deepEqual(input, { id: '42' });
        return { output: 'tool-out' };
      },
    };

    const agent = createCliSubAgent({
      name: 'finance',
      systemPrompt: 'You are finance.',
      model: 'sonnet',
      tools: [structuredTool],
      createCliAgent(deps) {
        capturedDeps = deps;
        return {
          async chat(input) {
            seenInput = input;
            return { text: 'cli-answer' };
          },
        } as never;
      },
    });

    const answer = await agent.ask('where is invoice 42?');

    assert.equal(answer, 'cli-answer');
    assert.deepEqual(seenInput, { userMessage: 'where is invoice 42?' });
    assert.ok(capturedDeps);
    assert.deepEqual(
      capturedDeps.dispatch.listDispatchableToolSpecs().map((spec) => spec.name),
      ['sub_lookup'],
    );

    const dispatched = await capturedDeps.dispatch.dispatch('sub_lookup', {
      id: '42',
    });
    assert.equal(dispatched.content, 'tool-out');
    assert.equal(dispatched.isError, undefined);
  });

  it('passes through string-returning sub-agent tools unchanged', async () => {
    let capturedDeps: CliChatAgentDeps | undefined;
    const stringTool: LocalSubAgentTool = {
      spec: {
        name: 'sub_ping',
        description: 'ping',
        input_schema: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
      async handle() {
        return 'pong';
      },
    };

    createCliSubAgent({
      name: 'ops',
      systemPrompt: 'You are ops.',
      model: 'haiku',
      tools: [stringTool],
      createCliAgent(deps) {
        capturedDeps = deps;
        return {
          async chat() {
            return { text: 'unused' };
          },
        } as never;
      },
    });

    assert.ok(capturedDeps);
    const dispatched = await capturedDeps.dispatch.dispatch('sub_ping', {});
    assert.equal(dispatched.content, 'pong');
    assert.equal(dispatched.isError, undefined);
  });
});
