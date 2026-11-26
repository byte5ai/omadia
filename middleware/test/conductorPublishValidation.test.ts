import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { Step, WorkflowGraph } from '@omadia/conductor-core';

import { validatePublishGraph } from '../src/conductor/publishValidation.js';

const graphFor = (step: Step): WorkflowGraph => ({ entryStepId: step.id, steps: [step], transitions: [] });

describe('Conductor publish validation', () => {
  it('refuses an unknown agent with the step ID', async () => {
    const result = await validatePublishGraph(graphFor({ id: 's', kind: 'agent', agentId: 'unknown' }), {
      templateKnownRefs: async () => ({ agentIds: ['known'] }),
    });
    assert.deepEqual(result.errors.map(({ code, nodeIds }) => [code, nodeIds]), [['unknown_agent_ref', ['s']]]);
  });

  it('requires action inputs that the tool declares and accepts runtime values', async () => {
    const actionId = 'mcp:server:tool';
    const deps = { templateKnownRefs: async () => ({
      actionIds: [actionId],
      requiredActionInputs: new Map([[actionId, ['query']]]),
    }) };
    const step: Step = { id: 's', kind: 'action', actionId };
    assert.equal((await validatePublishGraph(graphFor(step), deps)).errors[0]?.code, 'invalid_action_input');
    step.input = { query: '{{ctx.query}}' };
    assert.equal((await validatePublishGraph(graphFor(step), deps)).ok, true);
  });

  it('checks static webhook URLs and permits run tokens', async () => {
    const step: Step = { id: 's', kind: 'action', actionId: 'webhook.post', input: {} };
    for (const input of [{}, { url: '/relative' }, { url: 'file:///tmp' }]) {
      step.input = input;
      assert.equal((await validatePublishGraph(graphFor(step), {})).errors[0]?.code, 'invalid_action_input');
    }
    step.input = { url: '{{ctx.target}}' };
    assert.equal((await validatePublishGraph(graphFor(step), {})).ok, true);
  });

  it('refuses internal account UUIDs and keeps channel-directory UUIDs', async () => {
    const ref = '55197aac-0332-4978-9b11-bbae73fc2994';
    const graph = graphFor({ id: 's', kind: 'human', human: {
      principal: { kind: 'user', ref }, channel: 'teams', message: 'Approve',
    } });
    assert.equal((await validatePublishGraph(graph, { isOperatorAccountId: async () => true })).errors[0]?.code, 'invalid_user_ref');
    assert.equal((await validatePublishGraph(graph, { isOperatorAccountId: async () => false })).ok, true);
  });
});
