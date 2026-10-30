import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { OrchestratorRegistry } from '@omadia/orchestrator';
import type { WorkflowGraph } from '@omadia/conductor-core';

import { ConductorBuilderAgent } from '../src/conductor/builderAgent.js';
import { collectMissingCapabilities, renderKnownIdsBlock, suggestedQuery } from '../src/conductor/builderCapabilities.js';
import { collectPersonSuggestions, isUnresolvedUserRef } from '../src/conductor/builderPeople.js';

// Builder capability + people awareness: the "connector missing" signal is computed
// beside validate() and the draft keeps its placeholder; person lookups are proposals.

const DRAFT: WorkflowGraph = {
  entryStepId: 'fetch',
  steps: [
    { id: 'fetch', kind: 'action', actionId: 'pleo.list_missing_receipts' },
    { id: 'notify', kind: 'human', human: { principal: { kind: 'user', ref: 'Teresita Biel' }, channel: 'teams', message: 'Beleg?' } },
    { id: 'verify', kind: 'agent', agentId: 'fallback' },
    { id: 'attach', kind: 'action', actionId: 'mcp:srv-1:attach_receipt' },
    { id: 'escalate', kind: 'human', human: { principal: { kind: 'user', ref: 'teresita biel' }, channel: 'teams', message: 'Eskalation' } },
    { id: 'cc', kind: 'human', human: { principal: { kind: 'user', ref: 'boss@byte5.de' }, channel: 'teams', message: 'cc' } },
    { id: 'approve', kind: 'human', human: { principal: { kind: 'role', ref: 'Finance Lead' }, channel: 'teams', message: 'ok?' } },
    { id: 'ghost', kind: 'agent', agentId: 'no-such-agent' },
  ],
  transitions: [],
  triggers: [{ id: 'tr', kind: 'manual' }],
};

describe('collectMissingCapabilities', () => {
  it('reports action/agent refs outside the known sets with a vendor query', () => {
    const missing = collectMissingCapabilities(DRAFT, { actionIds: ['webhook.post', 'mcp:srv-1:attach_receipt'], agentIds: ['fallback'] });
    assert.deepEqual(missing, [
      { stepId: 'fetch', kind: 'action', ref: 'pleo.list_missing_receipts', suggestedQuery: 'pleo' },
      { stepId: 'ghost', kind: 'agent', ref: 'no-such-agent', suggestedQuery: 'no-such-agent' },
    ]);
  });

  it('an unknown set reports nothing (validate() KnownRefs parity)', () => {
    assert.deepEqual(collectMissingCapabilities(DRAFT, {}), []);
    assert.equal(collectMissingCapabilities(DRAFT, { agentIds: ['fallback'] }).every((m) => m.kind === 'agent'), true);
  });

  it('caps at 20 entries', () => {
    const steps = Array.from({ length: 30 }, (_, i) => ({ id: `s${String(i)}`, kind: 'action' as const, actionId: `x.y${String(i)}` }));
    const g: WorkflowGraph = { entryStepId: 's0', steps, transitions: [], triggers: [] };
    assert.equal(collectMissingCapabilities(g, { actionIds: [] }).length, 20);
  });

  it('suggestedQuery takes the vendor segment and strips an mcp prefix', () => {
    assert.equal(suggestedQuery('Pleo.mcp.attach'), 'pleo');
    assert.equal(suggestedQuery('jira:create'), 'jira');
    assert.equal(suggestedQuery('mcp:srv:toolname'), 'toolname');
    assert.equal(suggestedQuery('a'.repeat(100)).length, 40);
  });

  it('renderKnownIdsBlock sanitizes third-party ids and caps the list', () => {
    const ids = [...Array.from({ length: 70 }, (_, i) => `t${String(i)}`), 'bad id with spaces', 'x'.repeat(81), 'ok_1.2:3-4'];
    const block = renderKnownIdsBlock('KNOWN', ids);
    assert.equal(block.includes('bad id'), false);
    assert.equal(block.includes('x'.repeat(81)), false);
    assert.match(block, /\(\+11 more not shown\)/);
    assert.equal(renderKnownIdsBlock('KNOWN', undefined), '');
    assert.equal(renderKnownIdsBlock('KNOWN', ['  ']), 'KNOWN: (none registered)');
  });
});

describe('collectPersonSuggestions', () => {
  it('looks up each distinct name once, never addresses or roles, and fans out per step', async () => {
    const queries: string[] = [];
    const out = await collectPersonSuggestions(DRAFT, async (q) => {
      queries.push(q);
      return { people: [{ principalRef: 'teresita.biel@byte5.de', displayName: 'Teresita Biel', channelType: 'teams', email: 'teresita.biel@byte5.de' }], partial: false };
    });
    assert.deepEqual(queries, ['Teresita Biel']);
    assert.deepEqual(out.map((s) => [s.stepId, s.query, s.candidates.length, s.partial]), [
      ['notify', 'Teresita Biel', 1, false],
      ['escalate', 'Teresita Biel', 1, false],
    ]);
    assert.equal(isUnresolvedUserRef('boss@byte5.de'), false);
    assert.equal(isUnresolvedUserRef('x'), false);
    assert.equal(isUnresolvedUserRef('U04ABC9XY'), false, 'Slack member id is a resolved ref');
    assert.equal(isUnresolvedUserRef('3f2a1b4c-0000-4000-8000-000000000000'), false, 'AAD oid is a resolved ref');
    assert.equal(isUnresolvedUserRef('Teresita Biel'), true);
    assert.equal(isUnresolvedUserRef('{{steps.fetch.ownerEmail}}'), false, 'template expression is dynamic');
    assert.equal(isUnresolvedUserRef('stepResult.employee'), false, 'dotted run-context path is dynamic');
    assert.equal(isUnresolvedUserRef('Dr. Biel'), true, 'a dotted NAME with a space is still looked up');
  });

  it('keeps a zero-candidate suggestion and propagates partial', async () => {
    const out = await collectPersonSuggestions(DRAFT, async () => ({ people: [], partial: true }));
    assert.equal(out.length, 2);
    assert.deepEqual(out[0]?.candidates, []);
    assert.equal(out[0]?.partial, true);
  });

  it('caps distinct names per turn at 5 and candidates at 5', async () => {
    const steps = Array.from({ length: 8 }, (_, i) => ({
      id: `h${String(i)}`,
      kind: 'human' as const,
      human: { principal: { kind: 'user' as const, ref: `Person ${String.fromCharCode(65 + i)}` }, channel: 'teams', message: 'x' },
    }));
    const g: WorkflowGraph = { entryStepId: 'h0', steps, transitions: [], triggers: [] };
    const many = Array.from({ length: 9 }, (_, i) => ({ principalRef: `p${String(i)}@x.io`, displayName: `P${String(i)}`, channelType: 'teams' }));
    const out = await collectPersonSuggestions(g, async () => ({ people: many, partial: false }));
    assert.equal(out.length, 5);
    assert.equal(out[0]?.candidates.length, 5);
  });
});

// ── end-to-end through the agent seam (stub orchestrator) ───────────────────

function registryReturning(text: string, calls: string[] = []): () => OrchestratorRegistry {
  const entry = {
    agent: { slug: 'fallback', name: 'Fallback' },
    built: { bundle: { agent: { chat: async (args: { userMessage: string }) => { calls.push(args.userMessage); return { text }; } } } },
  };
  return () => ({ get: (slug: string) => (slug === 'fallback' ? entry : undefined), list: () => [entry] }) as unknown as OrchestratorRegistry;
}

describe('ConductorBuilderAgent capability + people fields', () => {
  const reply = JSON.stringify({
    reply: 'Pleo is not connected yet.',
    patches: [
      { op: 'add_step', step: { id: 'fetch', kind: 'action', actionId: 'pleo.list_missing_receipts' } },
      { op: 'add_step', step: { id: 'notify', kind: 'human', human: { principal: { kind: 'user', ref: 'Teresita Biel' }, channel: 'teams', message: 'Beleg?' } } },
      { op: 'add_transition', transition: { id: 't1', source: 'fetch', target: 'notify' } },
    ],
  });

  it('emits missingCapabilities + personSuggestions, keeps the placeholder, single LLM call, candidates never in the prompt', async () => {
    const calls: string[] = [];
    const agent = new ConductorBuilderAgent({
      getRegistry: registryReturning(reply, calls),
      listActions: async () => ['webhook.post', 'mcp:srv-1:attach_receipt'],
      listAgents: () => ['fallback'],
      searchPeople: async () => ({ people: [{ principalRef: 'teresita.biel@byte5.de', displayName: 'Teresita Biel', channelType: 'teams' }], partial: false }),
    });
    const res = await agent.runTurn({ message: 'Pleo reminder' });
    assert.equal(res.validation.ok, true, 'unknown action must NOT be a validation error for drafts');
    assert.equal(res.graph.steps.find((s) => s.id === 'fetch')?.actionId, 'pleo.list_missing_receipts');
    assert.deepEqual(res.missingCapabilities, [{ stepId: 'fetch', kind: 'action', ref: 'pleo.list_missing_receipts', suggestedQuery: 'pleo' }]);
    assert.equal(res.personSuggestions?.[0]?.candidates[0]?.principalRef, 'teresita.biel@byte5.de');
    assert.equal(res.graph.steps.find((s) => s.id === 'notify')?.human?.principal.ref, 'Teresita Biel', 'server never rewrites the ref');
    assert.equal(calls.length, 1, 'a missing connector must not trigger the self-correction retry');
    assert.match(calls[0] ?? '', /KNOWN ACTION IDS[^\n]*mcp:srv-1:attach_receipt/);
    assert.match(calls[0] ?? '', /KNOWN AGENT SLUGS[^\n]*fallback/);
    assert.equal((calls[0] ?? '').includes('teresita.biel@byte5.de'), false, 'directory candidates never reach the LLM');
  });

  it('omits both keys when nothing is missing and nothing is unresolved (v1 wire shape)', async () => {
    const clean = JSON.stringify({ reply: 'ok', patches: [{ op: 'add_step', step: { id: 'a', kind: 'agent', agentId: 'fallback' } }] });
    const agent = new ConductorBuilderAgent({ getRegistry: registryReturning(clean), listActions: () => [], listAgents: () => ['fallback'], searchPeople: async () => ({ people: [], partial: false }) });
    const res = await agent.runTurn({ message: 'x' });
    assert.equal('missingCapabilities' in res, false);
    assert.equal('personSuggestions' in res, false);
  });

  it('degrades when the action list or the directory throws — turn succeeds, keys absent', async () => {
    const agent = new ConductorBuilderAgent({
      getRegistry: registryReturning(reply),
      listActions: async () => { throw new Error('store down'); },
      searchPeople: async () => { throw new Error('graph down'); },
    });
    const res = await agent.runTurn({ message: 'x' });
    assert.equal(res.graph.steps.length, 2);
    assert.equal('missingCapabilities' in res, false);
    assert.equal('personSuggestions' in res, false);
  });
});
