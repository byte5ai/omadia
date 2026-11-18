import { describe, expect, it } from 'vitest';

import { describeActionId } from '../actionIdLabel';
import { resetStepPrincipal, setStepActionId, setStepPrincipal, stepChannel } from '../graphLocalEdits';

const graph = {
  entryStepId: 'fetch',
  steps: [
    { id: 'fetch', kind: 'action', actionId: 'pleo.list_missing_receipts' },
    { id: 'notify', kind: 'human', human: { principal: { kind: 'user', ref: 'Teresita Biel' }, channel: 'slack', message: 'Beleg?' } },
  ],
  transitions: [],
  triggers: [],
};

describe('graphLocalEdits', () => {
  it('setStepActionId rewrites only the targeted step and never mutates the input', () => {
    const out = setStepActionId(graph, 'fetch', 'mcp:srv-1:list_missing_receipts') as typeof graph;
    expect(out.steps[0]?.actionId).toBe('mcp:srv-1:list_missing_receipts');
    expect(out.steps[1]).toBe(graph.steps[1]);
    expect(graph.steps[0]?.actionId).toBe('pleo.list_missing_receipts');
  });

  it('setStepPrincipal writes the routable ref AND the candidate channel; reset restores the name', () => {
    const picked = setStepPrincipal(graph, 'notify', {
      principalRef: 'teresita.biel@byte5.de',
      displayName: 'Teresita Biel',
      channelType: 'teams',
    }) as typeof graph;
    expect(picked.steps[1]?.human).toEqual({
      principal: { kind: 'user', ref: 'teresita.biel@byte5.de' },
      channel: 'teams',
      message: 'Beleg?',
    });
    const reset = resetStepPrincipal(picked, 'notify', 'Teresita Biel', 'slack') as typeof graph;
    expect(reset.steps[1]?.human).toEqual({ principal: { kind: 'user', ref: 'Teresita Biel' }, channel: 'slack', message: 'Beleg?' });
    expect(stepChannel(graph, 'notify')).toBe('slack');
    expect(stepChannel(graph, 'fetch')).toBeUndefined();
    // A step that had NO channel before the pick loses the candidate's channel again on undo.
    const noChannel = { ...graph, steps: [graph.steps[0], { ...graph.steps[1], human: { principal: { kind: 'user', ref: 'Teresita Biel' }, message: 'x' } }] };
    const pickedNC = setStepPrincipal(noChannel, 'notify', { principalRef: 't@x.io', displayName: 'T', channelType: 'teams' }) as typeof graph;
    expect(pickedNC.steps[1]?.human?.channel).toBe('teams');
    const resetNC = resetStepPrincipal(pickedNC, 'notify', 'Teresita Biel', null) as typeof graph;
    expect(resetNC.steps[1]?.human).toEqual({ principal: { kind: 'user', ref: 'Teresita Biel' }, message: 'x' });
  });

  it('tolerates a graph without a steps array', () => {
    expect(setStepActionId({ entryStepId: '' }, 'x', 'y')).toEqual({ entryStepId: '' });
  });
});

describe('describeActionId', () => {
  it('shows the tool name for mcp ids and the id verbatim otherwise', () => {
    expect(describeActionId('mcp:3f2a-uuid:attach_receipt')).toEqual({ label: 'attach_receipt', isMcp: true });
    expect(describeActionId('mcp:3f2a-uuid:ns:tool')).toEqual({ label: 'ns:tool', isMcp: true });
    expect(describeActionId('webhook.post')).toEqual({ label: 'webhook.post', isMcp: false });
    expect(describeActionId('mcp:only')).toEqual({ label: 'only', isMcp: true });
  });
});
