import { describe, it, expect } from 'vitest';
import {
  applyTemplateSlots,
  checkTemplateManifest,
  extractSlotRefs,
  missingSlotMappings,
} from '../src/template.js';
import { validate } from '../src/validate.js';
import type {
  TemplateManifest,
  TemplateSlotMapping,
  ValidationCode,
  WorkflowGraph,
} from '../src/types.js';

/** A well-formed template graph exercising all five placeholder positions. The prompt and
 *  the human message deliberately contain `slot:`-looking substrings that must be ignored. */
function makeGraph(): WorkflowGraph {
  return {
    entryStepId: 's_agent',
    steps: [
      {
        id: 's_agent',
        kind: 'agent',
        agentId: 'slot:agent:worker',
        prompt: 'Summarize {{ctx.request}} — mention of slot:agent:worker here is plain text',
      },
      { id: 's_action', kind: 'action', actionId: 'slot:action:notify' },
      {
        id: 's_human',
        kind: 'human',
        human: {
          principal: { kind: 'role', ref: 'slot:role:approver' },
          channel: 'slot:channel:approvals',
          message: 'Please approve. (slot:role:approver appears here as plain text)',
        },
      },
    ],
    transitions: [
      { id: 't1', source: 's_agent', target: 's_action' },
      { id: 't2', source: 's_action', target: 's_human' },
    ],
    triggers: [{ id: 'tr_event', kind: 'event', eventId: 'slot:event:submitted' }],
  };
}

function makeManifest(): TemplateManifest {
  return {
    id: 'expense-approval',
    name: 'Expense approval',
    description: 'Route an expense to an approver and notify on decision.',
    useCase: 'approval',
    defaultSlug: 'expense-approval',
    graph: makeGraph(),
    slots: {
      agents: [{ key: 'worker', label: 'Summarizing agent' }],
      actions: [{ key: 'notify', label: 'Notify action', description: 'Sends the decision.' }],
      roles: [{ key: 'approver', label: 'Approver role' }],
      events: [{ key: 'submitted', label: 'Submission event' }],
      channels: [{ key: 'approvals', label: 'Approval channel' }],
    },
  };
}

function makeMapping(): TemplateSlotMapping {
  return {
    agents: { worker: 'fallback' },
    actions: { notify: 'act.notify' },
    roles: { approver: 'finance' },
    events: { submitted: 'expense.submitted' },
    channels: { approvals: 'teams' },
  };
}

function codesOf(manifest: TemplateManifest): ValidationCode[] {
  return checkTemplateManifest(manifest).errors.map((e) => e.code);
}

describe('extractSlotRefs', () => {
  it('finds placeholders in all five ref field positions with correct nodeIds', () => {
    const refs = extractSlotRefs(makeGraph());
    expect(refs).toEqual([
      { kind: 'agents', key: 'worker', nodeIds: ['s_agent'] },
      { kind: 'actions', key: 'notify', nodeIds: ['s_action'] },
      { kind: 'roles', key: 'approver', nodeIds: ['s_human'] },
      { kind: 'channels', key: 'approvals', nodeIds: ['s_human'] },
      { kind: 'events', key: 'submitted', nodeIds: ['tr_event'] },
    ]);
  });

  it('groups multiple references to the same slot under one ref', () => {
    const graph = makeGraph();
    graph.steps.push({ id: 's_agent2', kind: 'agent', agentId: 'slot:agent:worker' });
    graph.transitions.push({ id: 't3', source: 's_human', target: 's_agent2' });
    const refs = extractSlotRefs(graph);
    const worker = refs.find((r) => r.kind === 'agents' && r.key === 'worker');
    expect(worker?.nodeIds).toEqual(['s_agent', 's_agent2']);
  });

  it('ignores slot-looking substrings inside prompt and human.message', () => {
    const graph = makeGraph();
    // Strip real placeholders; only the prompt/message decoys remain.
    graph.steps[0]!.agentId = 'fallback';
    graph.steps[1]!.actionId = 'act.x';
    graph.steps[2]!.human!.principal.ref = 'finance';
    graph.steps[2]!.human!.channel = 'teams';
    graph.triggers![0]!.eventId = 'expense.submitted';
    expect(extractSlotRefs(graph)).toEqual([]);
  });

  it('does not treat a role placeholder on a user principal as a role slot', () => {
    const graph = makeGraph();
    graph.steps[2]!.human!.principal = { kind: 'user', ref: 'slot:role:approver' };
    const refs = extractSlotRefs(graph);
    expect(refs.some((r) => r.kind === 'roles')).toBe(false);
  });
});

describe('missingSlotMappings', () => {
  it('returns [] for a complete mapping', () => {
    expect(missingSlotMappings(makeManifest(), makeMapping())).toEqual([]);
  });

  it('returns exactly the unmapped slots with kind, key and label', () => {
    const mapping = makeMapping();
    delete mapping.roles;
    delete mapping.events!.submitted;
    expect(missingSlotMappings(makeManifest(), mapping)).toEqual([
      { kind: 'roles', key: 'approver', label: 'Approver role' },
      { kind: 'events', key: 'submitted', label: 'Submission event' },
    ]);
  });

  it('treats an empty-string mapping value as missing', () => {
    const mapping = makeMapping();
    mapping.channels = { approvals: '  ' };
    expect(missingSlotMappings(makeManifest(), mapping)).toEqual([
      { kind: 'channels', key: 'approvals', label: 'Approval channel' },
    ]);
  });
});

describe('applyTemplateSlots', () => {
  it('substitutes every placeholder (no refs remain) and leaves the manifest untouched', () => {
    const manifest = makeManifest();
    const before = structuredClone(manifest);
    const graph = applyTemplateSlots(manifest, makeMapping());

    expect(extractSlotRefs(graph)).toEqual([]);
    expect(graph.steps[0]!.agentId).toBe('fallback');
    expect(graph.steps[1]!.actionId).toBe('act.notify');
    expect(graph.steps[2]!.human!.principal.ref).toBe('finance');
    expect(graph.steps[2]!.human!.channel).toBe('teams');
    expect(graph.triggers![0]!.eventId).toBe('expense.submitted');
    // prompt / message decoys untouched
    expect(graph.steps[0]!.prompt).toContain('slot:agent:worker');
    expect(graph.steps[2]!.human!.message).toContain('slot:role:approver');
    // manifest not mutated
    expect(manifest).toEqual(before);
  });

  it('produces a graph that passes validate() with KnownRefs of the mapped values', () => {
    const graph = applyTemplateSlots(makeManifest(), makeMapping());
    const result = validate(graph, {
      agentIds: ['fallback'],
      actionIds: ['act.notify'],
      roleKeys: ['finance'],
      eventIds: ['expense.submitted'],
    });
    expect(result).toEqual({ ok: true, errors: [] });
  });

  it('throws TypeError on an unmapped placeholder', () => {
    const mapping = makeMapping();
    delete mapping.roles;
    expect(() => applyTemplateSlots(makeManifest(), mapping)).toThrow(TypeError);
    expect(() => applyTemplateSlots(makeManifest(), mapping)).toThrow(/roles slot 'approver'/);
  });

  it('throws TypeError on a malformed slot ref (wrong kind token for the field)', () => {
    const manifest = makeManifest();
    manifest.graph.steps[0]!.agentId = 'slot:role:worker';
    expect(() => applyTemplateSlots(manifest, makeMapping())).toThrow(TypeError);
  });

  it('leaves plain (non-slot) refs alone', () => {
    const manifest = makeManifest();
    manifest.graph.steps[0]!.agentId = 'fallback';
    manifest.slots.agents = [];
    const graph = applyTemplateSlots(manifest, makeMapping());
    expect(graph.steps[0]!.agentId).toBe('fallback');
  });
});

describe('checkTemplateManifest', () => {
  it('accepts a valid manifest', () => {
    expect(checkTemplateManifest(makeManifest())).toEqual({ ok: true, errors: [] });
  });

  it('rejects an undeclared placeholder', () => {
    const manifest = makeManifest();
    manifest.slots.events = [];
    const result = checkTemplateManifest(manifest);
    expect(result.ok).toBe(false);
    const err = result.errors.find((e) => e.code === 'template_undeclared_slot');
    expect(err?.nodeIds).toEqual(['tr_event']);
  });

  it('rejects an unused declared slot', () => {
    const manifest = makeManifest();
    manifest.slots.agents!.push({ key: 'reviewer', label: 'Reviewer agent' });
    expect(codesOf(manifest)).toContain('template_unused_slot');
  });

  it('rejects a duplicate slot key within a kind', () => {
    const manifest = makeManifest();
    manifest.slots.roles!.push({ key: 'approver', label: 'Approver again' });
    expect(codesOf(manifest)).toContain('template_duplicate_slot_key');
  });

  it('rejects empty metadata fields', () => {
    const manifest = makeManifest();
    manifest.name = '  ';
    manifest.defaultSlug = '';
    const result = checkTemplateManifest(manifest);
    const err = result.errors.find((e) => e.code === 'template_missing_metadata');
    expect(err?.message).toContain('name');
    expect(err?.message).toContain('defaultSlug');
  });

  it('rejects a malformed slot ref (wrong kind token in a ref field)', () => {
    const manifest = makeManifest();
    manifest.graph.steps[1]!.actionId = 'slot:agent:notify';
    const result = checkTemplateManifest(manifest);
    const malformed = result.errors.find((e) => e.code === 'template_malformed_slot_ref');
    expect(malformed?.nodeIds).toEqual(['s_action']);
  });

  it('surfaces structural graph errors (deadline without fallback)', () => {
    const manifest = makeManifest();
    manifest.graph.steps[2]!.human!.deadline = 'PT1H';
    expect(codesOf(manifest)).toContain('deadline_without_fallback');
  });

  it('reports only a shape error for a structurally broken graph (no slot noise)', () => {
    const manifest = makeManifest();
    manifest.graph = { steps: [], transitions: [] } as unknown as WorkflowGraph;
    const result = checkTemplateManifest(manifest);
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.code)).toEqual(['shape']);
  });
});
