import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { OrchestratorRegistry } from '@omadia/orchestrator';
import type { WorkflowGraph } from '@omadia/conductor-core';

import { applyGraphPatches, emptyGraph } from '../src/conductor/graphPatch.js';
import { ConductorBuilderAgent, ConductorBuilderUnavailableError, parseTurnResponse } from '../src/conductor/builderAgent.js';
import { userTemplateVisible } from '../src/conductor/templateCatalog.js';
import type { TemplateSummary } from '../src/conductor/templateCatalog.js';

// Conductor US7 — conversational builder: pure patch algebra + the stateless turn (graph,message)→(graph,reply).

describe('applyGraphPatches', () => {
  it('add_step on an empty graph makes the first step the entry', () => {
    const r = applyGraphPatches(emptyGraph(), [
      { op: 'add_step', step: { id: 's1', kind: 'agent', agentId: 'fallback', prompt: 'hi' } },
    ]);
    assert.equal(r.errors.length, 0);
    assert.equal(r.applied, 1);
    assert.equal(r.graph.entryStepId, 's1');
    assert.equal(r.graph.steps.length, 1);
  });

  it('update_step merges fields but never changes the id', () => {
    const base: WorkflowGraph = {
      entryStepId: 's1',
      steps: [{ id: 's1', kind: 'agent', agentId: 'fallback' }],
      transitions: [],
      triggers: [],
    };
    // patch tries to also change the id — applyGraphPatches must preserve the original id.
    const r = applyGraphPatches(base, [{ op: 'update_step', id: 's1', patch: { prompt: 'do the thing', id: 'hacked' } }]);
    assert.equal(r.errors.length, 0);
    assert.equal(r.graph.steps[0].id, 's1');
    assert.equal(r.graph.steps[0].prompt, 'do the thing');
  });

  it('remove_step drops the step AND its dangling transitions', () => {
    const base: WorkflowGraph = {
      entryStepId: 's1',
      steps: [
        { id: 's1', kind: 'agent', agentId: 'fallback' },
        { id: 's2', kind: 'agent', agentId: 'fallback' },
      ],
      transitions: [{ id: 't1', source: 's1', target: 's2' }],
      triggers: [],
    };
    const r = applyGraphPatches(base, [{ op: 'remove_step', id: 's2' }]);
    assert.equal(r.errors.length, 0);
    assert.equal(r.graph.steps.length, 1);
    assert.equal(r.graph.transitions.length, 0); // dangling transition removed
  });

  it('reports errors for unknown ids and duplicates, applying the rest', () => {
    const base: WorkflowGraph = {
      entryStepId: 's1',
      steps: [{ id: 's1', kind: 'agent', agentId: 'fallback' }],
      transitions: [],
      triggers: [],
    };
    const r = applyGraphPatches(base, [
      { op: 'add_step', step: { id: 's1', kind: 'agent', agentId: 'fallback' } }, // duplicate
      { op: 'update_step', id: 'ghost', patch: { prompt: 'x' } }, // unknown
      { op: 'remove_transition', id: 'nope' }, // unknown
      { op: 'add_step', step: { id: 's2', kind: 'agent', agentId: 'fallback' } }, // valid
    ]);
    assert.equal(r.applied, 1);
    assert.equal(r.errors.length, 3);
    assert.equal(r.graph.steps.length, 2);
  });

  it('set_trigger replaces (single-trigger parity) and set_entry sets the entry', () => {
    const base: WorkflowGraph = {
      entryStepId: 's1',
      steps: [{ id: 's1', kind: 'agent', agentId: 'fallback' }],
      transitions: [],
      triggers: [{ id: 'old', kind: 'manual' }],
    };
    const r = applyGraphPatches(base, [
      { op: 'set_trigger', trigger: { id: 'tr', kind: 'event', eventId: 'github.pull_request.merged' } },
      { op: 'set_entry', stepId: 's1' },
    ]);
    assert.equal(r.graph.triggers?.length, 1);
    assert.equal(r.graph.triggers?.[0].id, 'tr');
    assert.equal(r.graph.entryStepId, 's1');
  });

  it('does not mutate the input graph', () => {
    const base = emptyGraph();
    applyGraphPatches(base, [{ op: 'add_step', step: { id: 's1', kind: 'agent', agentId: 'fallback' } }]);
    assert.equal(base.steps.length, 0);
  });

  it('tolerates a malformed input graph (non-array steps/transitions) without throwing', () => {
    const bad = { entryStepId: '', steps: 'nope', transitions: undefined } as unknown as WorkflowGraph;
    const r = applyGraphPatches(bad, [{ op: 'add_step', step: { id: 's1', kind: 'agent', agentId: 'fallback' } }]);
    assert.equal(r.applied, 1);
    assert.equal(r.graph.steps.length, 1);
  });

  it('update_step with a missing patch field records nothing-to-do but never throws', () => {
    const base: WorkflowGraph = {
      entryStepId: 's1',
      steps: [{ id: 's1', kind: 'agent', agentId: 'fallback', prompt: 'keep' }],
      transitions: [],
      triggers: [],
    };
    // LLM emitted update_step with no `patch` key — must not throw (would 500 the whole turn).
    const r = applyGraphPatches(base, [{ op: 'update_step', id: 's1' } as unknown as Parameters<typeof applyGraphPatches>[1][number]]);
    assert.equal(r.errors.length, 0);
    assert.equal(r.graph.steps[0].prompt, 'keep');
  });

  it('update_step never changes a step kind (preserves it; use remove+add to change kind)', () => {
    const base: WorkflowGraph = {
      entryStepId: 's1',
      steps: [{ id: 's1', kind: 'agent', agentId: 'fallback' }],
      transitions: [],
      triggers: [],
    };
    const r = applyGraphPatches(base, [{ op: 'update_step', id: 's1', patch: { kind: 'human', prompt: 'x' } }]);
    assert.equal(r.graph.steps[0].kind, 'agent');
  });

  it('remove_step clears an orphaned fallbackTransitionId on a surviving step', () => {
    const base: WorkflowGraph = {
      entryStepId: 's1',
      steps: [
        { id: 's1', kind: 'agent', agentId: 'fallback', fallbackTransitionId: 't2' },
        { id: 's2', kind: 'agent', agentId: 'fallback' },
        { id: 's3', kind: 'agent', agentId: 'fallback' },
      ],
      transitions: [{ id: 't2', source: 's3', target: 's2' }],
      triggers: [],
    };
    const r = applyGraphPatches(base, [{ op: 'remove_step', id: 's2' }]); // drops t2 (targets s2)
    assert.equal(r.graph.transitions.length, 0);
    assert.equal(r.graph.steps.find((s) => s.id === 's1')?.fallbackTransitionId, undefined);
  });
});

describe('parseTurnResponse', () => {
  it('parses a bare JSON object', () => {
    const r = parseTurnResponse('{"reply":"ok","patches":[]}');
    assert.equal(r.ok, true);
    assert.equal(r.reply, 'ok');
    assert.deepEqual(r.patches, []);
  });

  it('parses JSON wrapped in markdown fences and prose', () => {
    const r = parseTurnResponse('Sure! Here you go:\n```json\n{"reply":"added","patches":[{"op":"set_entry","stepId":"s1"}]}\n```\nDone.');
    assert.equal(r.ok, true);
    assert.equal(r.reply, 'added');
    assert.equal(r.patches.length, 1);
  });

  it('handles braces inside JSON strings without breaking balance', () => {
    const r = parseTurnResponse('{"reply":"use {{ctx.base}} here","patches":[]}');
    assert.equal(r.ok, true);
    assert.equal(r.reply, 'use {{ctx.base}} here');
  });

  it('falls back to ok:false with raw text when there is no JSON', () => {
    const r = parseTurnResponse('I cannot do that.');
    assert.equal(r.ok, false);
    assert.equal(r.reply, 'I cannot do that.');
    assert.deepEqual(r.patches, []);
  });

  it('parses the real object even when brace-bearing prose precedes it', () => {
    // First `{` is invalid JSON ({op:eq}); the scanner must try the next candidate.
    const r = parseTurnResponse('I will set the guard to {op:eq}. Here is the patch: {"reply":"ok","patches":[]}');
    assert.equal(r.ok, true);
    assert.equal(r.reply, 'ok');
  });
});

// ── stub orchestrator registry ──────────────────────────────────────────────

function stubRegistry(responses: string[]): { registry: OrchestratorRegistry; calls: () => number; prompts: string[] } {
  let i = 0;
  const prompts: string[] = [];
  const registry = {
    get: (_slug: string) => ({
      built: {
        bundle: {
          agent: {
            chat: async (args: { userMessage: string; sessionScope: string }) => {
              prompts.push(args.userMessage);
              const text = responses[Math.min(i, responses.length - 1)];
              i += 1;
              return { text };
            },
          },
        },
      },
    }),
  } as unknown as OrchestratorRegistry;
  return { registry, calls: () => i, prompts };
}

// ── template-awareness fixtures (#478 B4) ───────────────────────────────────

/** Viewer-scoped catalog stub: static (bundled/plugin) entries pass through, user
 *  entries run through the REAL visibility rule so the digest tests exercise it. */
function stubCatalog(templates: TemplateSummary[]): { list(viewer: string): Promise<TemplateSummary[]> } {
  return {
    list: async (viewer: string) =>
      templates.filter(
        (t) => t.source !== 'user' || userTemplateVisible({ status: t.status ?? 'private', createdBy: t.createdBy ?? '' }, viewer),
      ),
  };
}

const vacationTemplate: TemplateSummary = {
  id: 'vacation-approval',
  name: 'Vacation approval',
  description: 'Route vacation requests to an approver',
  useCase: 'approval',
  defaultSlug: 'vacation-approval',
  graph: {
    entryStepId: 's1',
    steps: [{ id: 's1', kind: 'agent', agentId: 'slot:agent:approver', prompt: 'slot:text:greeting' }],
    transitions: [],
    triggers: [{ id: 'tr', kind: 'manual' }],
  },
  slots: {
    agents: [{ key: 'approver', label: 'Approver agent' }],
    channels: [{ key: 'notify', label: 'Notification channel' }],
    text: [{ key: 'greeting', label: 'Greeting line' }],
  },
  source: 'bundled',
  version: 2,
  latestVersion: 2,
  instantiationCount: 0,
};

const foreignPrivateTemplate: TemplateSummary = {
  ...vacationTemplate,
  id: 'secret-flow',
  name: 'Secret flow',
  source: 'user',
  status: 'private',
  createdBy: 'op-a',
};

const foreignPendingTemplate: TemplateSummary = {
  ...vacationTemplate,
  id: 'pending-flow',
  name: 'Pending flow',
  source: 'user',
  status: 'pending',
  createdBy: 'op-a',
};

/** A valid one-step draft so a clean stub response scores 7 → exactly one LLM call. */
function validBaseGraph(): WorkflowGraph {
  return {
    entryStepId: 's1',
    steps: [{ id: 's1', kind: 'agent', agentId: 'fallback' }],
    transitions: [],
    triggers: [{ id: 'tr', kind: 'manual' }],
  };
}

describe('ConductorBuilderAgent.runTurn', () => {
  it('applies the agent-proposed patches and validates the result', async () => {
    const { registry } = stubRegistry([
      JSON.stringify({
        reply: 'Added a greeting step.',
        patches: [
          { op: 'add_step', step: { id: 's1', kind: 'agent', agentId: 'fallback', prompt: 'Say hi' } },
          { op: 'set_trigger', trigger: { id: 'tr', kind: 'manual' } },
        ],
      }),
    ]);
    const agent = new ConductorBuilderAgent({ getRegistry: () => registry });
    const res = await agent.runTurn({ message: 'start with a greeting' });
    assert.equal(res.validation.ok, true);
    assert.equal(res.graph.steps.length, 1);
    assert.equal(res.graph.entryStepId, 's1');
    assert.equal(res.reply, 'Added a greeting step.');
    assert.equal(res.applyErrors.length, 0);
  });

  it('surfaces validation errors (never publishes a broken graph) and still returns the draft', async () => {
    // Always returns a graph whose entry points at a missing step → invalid; both attempts fail.
    const { registry, calls } = stubRegistry([
      JSON.stringify({
        reply: 'here',
        patches: [
          { op: 'add_step', step: { id: 's1', kind: 'agent', agentId: 'fallback' } },
          { op: 'set_entry', stepId: 'does-not-exist' },
        ],
      }),
    ]);
    const agent = new ConductorBuilderAgent({ getRegistry: () => registry });
    const res = await agent.runTurn({ message: 'break it' });
    assert.equal(res.validation.ok, false);
    assert.ok(res.validation.errors.some((e) => e.code === 'unknown_entry_step'));
    assert.equal(res.graph.steps.length, 1); // draft still returned for the user to see
    assert.equal(calls(), 2); // retried once on the invalid result
  });

  it('self-corrects: retries once when the first response is unparseable, accepts the valid retry', async () => {
    const { registry, calls } = stubRegistry([
      'sorry, no json here',
      JSON.stringify({
        reply: 'fixed',
        patches: [
          { op: 'add_step', step: { id: 's1', kind: 'agent', agentId: 'fallback' } },
          { op: 'set_trigger', trigger: { id: 'tr', kind: 'manual' } },
        ],
      }),
    ]);
    const agent = new ConductorBuilderAgent({ getRegistry: () => registry });
    const res = await agent.runTurn({ message: 'make a step' });
    assert.equal(calls(), 2);
    assert.equal(res.validation.ok, true);
    assert.equal(res.reply, 'fixed');
    assert.equal(res.graph.steps.length, 1);
  });

  it('throws ConductorBuilderUnavailableError when no registry is present', async () => {
    const agent = new ConductorBuilderAgent({ getRegistry: () => undefined });
    await assert.rejects(() => agent.runTurn({ message: 'hi' }), ConductorBuilderUnavailableError);
  });

  it('turn response carries NO templateProposals key when the agent proposes none (v1 shape regression)', async () => {
    const { registry } = stubRegistry([
      JSON.stringify({
        reply: 'Added a greeting step.',
        patches: [
          { op: 'add_step', step: { id: 's1', kind: 'agent', agentId: 'fallback', prompt: 'Say hi' } },
          { op: 'set_trigger', trigger: { id: 'tr', kind: 'manual' } },
        ],
      }),
    ]);
    const agent = new ConductorBuilderAgent({
      getRegistry: () => registry,
      templateCatalog: stubCatalog([vacationTemplate]),
      templateKnownRefs: () => ({ agentIds: ['fallback'] }),
    });
    const res = await agent.runTurn({ message: 'start with a greeting', viewer: 'op-b' });
    assert.deepEqual(Object.keys(res).sort(), ['applyErrors', 'graph', 'patches', 'reply', 'validation']);
    assert.ok(!('templateProposals' in res));
  });

  it('keeps the BEST attempt: a parseable-but-invalid result outranks an unparseable retry', async () => {
    // Attempt 0: parseable, but sets entry to a missing step → invalid (still inspectable, score 5).
    // Attempt 1: unparseable junk → no patches → base unchanged & valid (vacuous, score 3).
    // The builder must return attempt 0, not the worse latest attempt.
    const base: WorkflowGraph = {
      entryStepId: 's1',
      steps: [{ id: 's1', kind: 'agent', agentId: 'fallback' }],
      transitions: [],
      triggers: [{ id: 'tr', kind: 'manual' }],
    };
    const { registry, calls } = stubRegistry([
      JSON.stringify({ reply: 'attempt0', patches: [{ op: 'set_entry', stepId: 'ghost' }] }),
      'sorry, no json here',
    ]);
    const agent = new ConductorBuilderAgent({ getRegistry: () => registry });
    const res = await agent.runTurn({ graph: base, message: 'edit it' });
    assert.equal(calls(), 2);
    assert.equal(res.reply, 'attempt0');
    assert.equal(res.validation.ok, false);
    assert.equal(res.graph.entryStepId, 'ghost');
  });
});

// ── template awareness (#478 B4): catalog digest in the prompt + vetted proposals ──

describe('ConductorBuilderAgent template awareness', () => {
  const cleanResponse = JSON.stringify({ reply: 'looks good', patches: [] });

  it('inlines a viewer-scoped catalog digest: pending visible, foreign private absent', async () => {
    const { registry, prompts } = stubRegistry([cleanResponse]);
    const agent = new ConductorBuilderAgent({
      getRegistry: () => registry,
      templateCatalog: stubCatalog([vacationTemplate, foreignPrivateTemplate, foreignPendingTemplate]),
      templateKnownRefs: () => ({ agentIds: ['fallback'] }),
    });
    await agent.runTurn({ graph: validBaseGraph(), message: 'hello', viewer: 'op-b' });
    assert.equal(prompts.length, 1);
    const prompt = prompts[0];
    assert.ok(prompt.includes('WORKFLOW TEMPLATE CATALOG'));
    // digest carries id, version, resolved name/useCase, and the slot list incl. text slots
    assert.ok(prompt.includes('vacation-approval (v2) — Vacation approval. Use case: approval.'));
    assert.ok(prompt.includes('agents.approver "Approver agent"'));
    assert.ok(prompt.includes('channels.notify "Notification channel"'));
    assert.ok(prompt.includes('text.greeting "Greeting line"'));
    // B2 visibility rule: pending is reviewer-visible install-wide, foreign private is not
    assert.ok(prompt.includes('pending-flow'));
    assert.ok(!prompt.includes('secret-flow'));
  });

  it('renders NO template section without a catalog (v1 prompt regression)', async () => {
    const { registry, prompts } = stubRegistry([cleanResponse]);
    const agent = new ConductorBuilderAgent({ getRegistry: () => registry });
    await agent.runTurn({ graph: validBaseGraph(), message: 'hello' });
    assert.ok(!prompts[0].includes('WORKFLOW TEMPLATE CATALOG'));
    assert.ok(!prompts[0].includes('templateProposals'));
  });

  it('surfaces a valid proposal with catalog-authoritative version and vetted prefill', async () => {
    const { registry } = stubRegistry([
      JSON.stringify({
        reply: 'The vacation template fits.',
        patches: [],
        templateProposals: [
          {
            templateId: 'vacation-approval',
            version: 99, // LLM hallucination — must be overridden by the catalog's v2
            reason: 'Matches your vacation-request ask.',
            prefill: { agents: { approver: 'fallback' }, channels: { notify: 'teams' }, text: { greeting: 'Hi team' } },
          },
        ],
      }),
    ]);
    const agent = new ConductorBuilderAgent({
      getRegistry: () => registry,
      templateCatalog: stubCatalog([vacationTemplate]),
      templateKnownRefs: () => ({ agentIds: ['fallback'] }),
    });
    const res = await agent.runTurn({ graph: validBaseGraph(), message: 'I need a vacation approval flow', viewer: 'op-b' });
    assert.equal(res.templateProposals?.length, 1);
    const p = res.templateProposals![0];
    assert.equal(p.templateId, 'vacation-approval');
    assert.equal(p.version, 2);
    assert.equal(p.reason, 'Matches your vacation-request ask.');
    // agents checked against KnownRefs; channels has no KnownRefs set → kept; text kept
    assert.deepEqual(p.prefill, { agents: { approver: 'fallback' }, channels: { notify: 'teams' }, text: { greeting: 'Hi team' } });
  });

  it('drops unknown/invisible template ids, dedupes, and caps at 3', async () => {
    const many = [1, 2, 3, 4].map((n) => ({ ...vacationTemplate, id: `t-${n}`, name: `T${n}` }));
    const { registry } = stubRegistry([
      JSON.stringify({
        reply: 'options',
        patches: [],
        templateProposals: [
          { templateId: 'not-in-catalog', version: 1, reason: 'x', prefill: {} },
          { templateId: 'secret-flow', version: 1, reason: 'invisible to op-b', prefill: {} },
          { templateId: 't-1', version: 1, reason: 'a', prefill: {} },
          { templateId: 't-1', version: 1, reason: 'duplicate', prefill: {} },
          { templateId: 't-2', version: 1, reason: 'b', prefill: {} },
          { templateId: 't-3', version: 1, reason: 'c', prefill: {} },
          { templateId: 't-4', version: 1, reason: 'over the cap', prefill: {} },
        ],
      }),
    ]);
    const agent = new ConductorBuilderAgent({
      getRegistry: () => registry,
      templateCatalog: stubCatalog([...many, foreignPrivateTemplate]),
      templateKnownRefs: () => ({}),
    });
    const res = await agent.runTurn({ graph: validBaseGraph(), message: 'anything', viewer: 'op-b' });
    assert.deepEqual(res.templateProposals?.map((p) => p.templateId), ['t-1', 't-2', 't-3']);
  });

  it('strips prefill entries that fail KnownRefs or name undeclared slots', async () => {
    const { registry } = stubRegistry([
      JSON.stringify({
        reply: 'try this',
        patches: [],
        templateProposals: [
          {
            templateId: 'vacation-approval',
            version: 2,
            reason: 'fits',
            prefill: {
              agents: { approver: 'ghost-agent', undeclared: 'fallback' }, // unknown ref + undeclared key
              events: { nope: 'not.declared' }, // kind with no declared slots
              text: { greeting: 'Hello', undeclared: 'x' },
            },
          },
        ],
      }),
    ]);
    const agent = new ConductorBuilderAgent({
      getRegistry: () => registry,
      templateCatalog: stubCatalog([vacationTemplate]),
      templateKnownRefs: () => ({ agentIds: ['fallback'] }),
    });
    const res = await agent.runTurn({ graph: validBaseGraph(), message: 'vacation flow', viewer: 'op-b' });
    assert.equal(res.templateProposals?.length, 1);
    // every ref guess failed → empty prefill except the declared text slot
    assert.deepEqual(res.templateProposals![0].prefill, { text: { greeting: 'Hello' } });
  });

  it('ignores a malformed templateProposals block without failing the turn', async () => {
    const { registry, calls } = stubRegistry([
      JSON.stringify({ reply: 'ok', patches: [], templateProposals: 'not-an-array' }),
    ]);
    const agent = new ConductorBuilderAgent({
      getRegistry: () => registry,
      templateCatalog: stubCatalog([vacationTemplate]),
      templateKnownRefs: () => ({}),
    });
    const res = await agent.runTurn({ graph: validBaseGraph(), message: 'hello', viewer: 'op-b' });
    assert.equal(calls(), 1); // still a clean score-7 turn — no retry burned on proposals
    assert.equal(res.reply, 'ok');
    assert.ok(!('templateProposals' in res));
  });

  it('ignores malformed ELEMENTS inside an otherwise valid proposals array', async () => {
    const { registry } = stubRegistry([
      JSON.stringify({
        reply: 'ok',
        patches: [],
        templateProposals: [null, 42, 'x', { reason: 'no templateId' }, { templateId: 'vacation-approval', prefill: null }],
      }),
    ]);
    const agent = new ConductorBuilderAgent({
      getRegistry: () => registry,
      templateCatalog: stubCatalog([vacationTemplate]),
      templateKnownRefs: () => ({}),
    });
    const res = await agent.runTurn({ graph: validBaseGraph(), message: 'hello', viewer: 'op-b' });
    assert.equal(res.templateProposals?.length, 1);
    assert.equal(res.templateProposals![0].templateId, 'vacation-approval');
    assert.equal(res.templateProposals![0].reason, '');
    assert.deepEqual(res.templateProposals![0].prefill, {});
  });

  it('a throwing catalog degrades to a template-less turn instead of a 500', async () => {
    const { registry, prompts } = stubRegistry([cleanResponse]);
    const agent = new ConductorBuilderAgent({
      getRegistry: () => registry,
      templateCatalog: { list: async () => { throw new Error('db down'); } },
      templateKnownRefs: () => ({}),
    });
    const res = await agent.runTurn({ graph: validBaseGraph(), message: 'hello', viewer: 'op-b' });
    assert.equal(res.reply, 'looks good');
    assert.ok(!prompts[0].includes('WORKFLOW TEMPLATE CATALOG'));
    assert.ok(!('templateProposals' in res));
  });
});
