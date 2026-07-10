// Template contract v2 (#478): text slots, strict import mode, manifest versioning,
// slot inference. The v1 surface stays pinned unchanged by template.test.ts; this
// file owns everything added on top. Fixtures are deliberately local copies — the
// v1 file must not grow past the 500-line budget.

import { describe, it, expect } from 'vitest';
import {
  applyTemplateSlots,
  checkTemplateManifest,
  inferTemplateManifest,
  missingSlotMappings,
  templateManifestVersion,
} from '../src/template.js';
import { extractTextSlotRefs } from '../src/textSlots.js';
import type {
  TemplateManifest,
  TemplateSlotMapping,
  ValidationCode,
  WorkflowGraph,
} from '../src/types.js';

/** Same shape as template.test.ts's fixture: all five placeholder positions, with
 *  ref-style decoys in the prose fields. */
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
      actions: [{ key: 'notify', label: 'Notify action' }],
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

/** Manifest whose prompt and human message carry text-slot tokens next to `{{...}}`
 *  interpolation and a ref-style decoy. */
function makeTextManifest(): TemplateManifest {
  const manifest = makeManifest();
  manifest.graph.steps[0]!.prompt =
    'Summarize {{ctx.request}} for slot:text:company — slot:agent:worker stays plain text';
  manifest.graph.steps[2]!.human!.message =
    'Please approve on behalf of slot:text:company. Signed, slot:text:signoff';
  manifest.slots.text = [
    { key: 'company', label: 'Company name' },
    { key: 'signoff', label: 'Signature line', default: 'The workflow team' },
  ];
  return manifest;
}

function codesOf(manifest: TemplateManifest): ValidationCode[] {
  return checkTemplateManifest(manifest).errors.map((e) => e.code);
}

describe('checkTemplateManifest — text slots, strict mode, version', () => {
  it('rejects an undeclared slot:text token in a designated field', () => {
    const manifest = makeManifest();
    manifest.graph.steps[0]!.prompt = 'Report for slot:text:company please';
    const result = checkTemplateManifest(manifest);
    const err = result.errors.find((e) => e.code === 'template_text_slot_undeclared');
    expect(err?.message).toContain("'company'");
    expect(err?.nodeIds).toEqual(['s_agent']);
  });

  it('rejects an unused declared text slot', () => {
    const manifest = makeManifest();
    manifest.slots.text = [{ key: 'company', label: 'Company name' }];
    const result = checkTemplateManifest(manifest);
    const err = result.errors.find((e) => e.code === 'template_text_slot_unused');
    expect(err?.nodeIds).toEqual(['slot:text:company']);
  });

  it('accepts a declared and used text slot, and rejects duplicate text keys', () => {
    const manifest = makeTextManifest();
    expect(checkTemplateManifest(manifest)).toEqual({ ok: true, errors: [] });
    manifest.slots.text!.push({ key: 'company', label: 'Again' });
    expect(codesOf(manifest)).toContain('template_duplicate_slot_key');
  });

  it('strict mode rejects a concrete ref; non-strict accepts it', () => {
    const manifest = makeManifest();
    manifest.graph.steps[0]!.agentId = 'fallback';
    manifest.slots.agents = [];
    expect(checkTemplateManifest(manifest)).toEqual({ ok: true, errors: [] });
    const strict = checkTemplateManifest(manifest, { strict: true });
    expect(strict.ok).toBe(false);
    const err = strict.errors.find((e) => e.code === 'template_concrete_ref_in_strict_mode');
    expect(err?.message).toContain("'fallback'");
    expect(err?.nodeIds).toEqual(['s_agent']);
  });

  it('strict mode accepts a fully slotted manifest', () => {
    expect(checkTemplateManifest(makeManifest(), { strict: true })).toEqual({ ok: true, errors: [] });
    expect(checkTemplateManifest(makeTextManifest(), { strict: true })).toEqual({ ok: true, errors: [] });
  });

  it('accepts version >= 1 and rejects non-integer or sub-1 versions', () => {
    const manifest = makeManifest();
    manifest.version = 3;
    expect(checkTemplateManifest(manifest)).toEqual({ ok: true, errors: [] });
    manifest.version = 0;
    expect(codesOf(manifest)).toContain('template_missing_metadata');
    manifest.version = 1.5;
    expect(codesOf(manifest)).toContain('template_missing_metadata');
  });
});

describe('text slots', () => {
  it('substitutes mapped text slots in prompt and human.message, leaving {{...}} untouched', () => {
    const mapping = makeMapping();
    mapping.text = { company: 'byte5', signoff: 'Finance' };
    const graph = applyTemplateSlots(makeTextManifest(), mapping);
    expect(graph.steps[0]!.prompt).toBe(
      'Summarize {{ctx.request}} for byte5 — slot:agent:worker stays plain text',
    );
    expect(graph.steps[2]!.human!.message).toBe('Please approve on behalf of byte5. Signed, Finance');
  });

  it('applies the declared default when the mapping omits a text slot', () => {
    const mapping = makeMapping();
    mapping.text = { company: 'byte5' };
    const graph = applyTemplateSlots(makeTextManifest(), mapping);
    expect(graph.steps[2]!.human!.message).toBe(
      'Please approve on behalf of byte5. Signed, The workflow team',
    );
  });

  it('reports a defaultless unmapped text slot as missing; a defaulted one is not', () => {
    const manifest = makeTextManifest();
    expect(missingSlotMappings(manifest, makeMapping())).toEqual([
      { kind: 'text', key: 'company', label: 'Company name' },
    ]);
    const mapping = makeMapping();
    mapping.text = { company: '   ' }; // whitespace-only counts as missing
    expect(missingSlotMappings(manifest, mapping)).toEqual([
      { kind: 'text', key: 'company', label: 'Company name' },
    ]);
  });

  it('applyTemplateSlots throws on a defaultless unmapped text token', () => {
    const manifest = makeTextManifest();
    expect(() => applyTemplateSlots(manifest, makeMapping())).toThrow(TypeError);
    expect(() => applyTemplateSlots(manifest, makeMapping())).toThrow(/text slot 'company'/);
  });

  it('extractTextSlotRefs groups tokens by key across designated fields only', () => {
    const manifest = makeTextManifest();
    expect(extractTextSlotRefs(manifest.graph)).toEqual([
      { key: 'company', nodeIds: ['s_agent', 's_human'] },
      { key: 'signoff', nodeIds: ['s_human'] },
    ]);
  });
});

describe('templateManifestVersion', () => {
  it('treats an absent version as 1 and passes an explicit one through', () => {
    const manifest = makeManifest();
    expect(manifest.version).toBeUndefined();
    expect(templateManifestVersion(manifest)).toBe(1);
    manifest.version = 4;
    expect(templateManifestVersion(manifest)).toBe(4);
  });
});

describe('inferTemplateManifest', () => {
  /** A fully concrete graph (what "save as template" starts from). */
  function makeConcreteGraph(): WorkflowGraph {
    const graph = makeGraph();
    graph.steps[0]!.agentId = 'fallback';
    graph.steps[1]!.actionId = 'act.notify';
    graph.steps[2]!.human!.principal.ref = 'finance';
    graph.steps[2]!.human!.channel = 'teams';
    graph.triggers![0]!.eventId = 'expense.submitted';
    return graph;
  }

  const inferOpts = {
    id: 'saved-approval',
    name: 'Saved approval',
    description: 'Inferred from a live workflow.',
    useCase: 'approval',
  };

  it('declares one slot per distinct concrete ref and slots all five ref fields', () => {
    const original = makeConcreteGraph();
    const manifest = inferTemplateManifest(original, inferOpts);

    expect(manifest.id).toBe('saved-approval');
    expect(manifest.defaultSlug).toBe('saved-approval');
    expect(manifest.graph.steps[0]!.agentId).toBe('slot:agent:fallback');
    expect(manifest.graph.steps[1]!.actionId).toBe('slot:action:act-notify');
    expect(manifest.graph.steps[2]!.human!.principal.ref).toBe('slot:role:finance');
    expect(manifest.graph.steps[2]!.human!.channel).toBe('slot:channel:teams');
    expect(manifest.graph.triggers![0]!.eventId).toBe('slot:event:expense-submitted');
    expect(manifest.slots).toEqual({
      agents: [{ key: 'fallback', label: 'fallback' }],
      actions: [{ key: 'act-notify', label: 'act.notify' }],
      roles: [{ key: 'finance', label: 'finance' }],
      events: [{ key: 'expense-submitted', label: 'expense.submitted' }],
      channels: [{ key: 'teams', label: 'teams' }],
    });
    // the emitted manifest is valid, in strict mode too, and the input was not mutated
    expect(checkTemplateManifest(manifest, { strict: true })).toEqual({ ok: true, errors: [] });
    expect(original).toEqual(makeConcreteGraph());
  });

  it('round-trips: applying the identity mapping reproduces the original graph', () => {
    const original = makeConcreteGraph();
    const manifest = inferTemplateManifest(original, inferOpts);
    const identity: TemplateSlotMapping = {};
    for (const kind of ['agents', 'actions', 'roles', 'events', 'channels'] as const) {
      identity[kind] = Object.fromEntries(
        (manifest.slots[kind] ?? []).map((slot) => [slot.key, slot.label as string]),
      );
    }
    expect(applyTemplateSlots(manifest, identity)).toEqual(original);
  });

  it('collapses duplicate refs to one slot and preserves pre-existing placeholders', () => {
    const graph = makeConcreteGraph();
    graph.steps.push({ id: 's_agent2', kind: 'agent', agentId: 'fallback' });
    graph.steps.push({ id: 's_agent3', kind: 'agent', agentId: 'slot:agent:worker' });
    graph.transitions.push({ id: 't3', source: 's_human', target: 's_agent2' });
    graph.transitions.push({ id: 't4', source: 's_agent2', target: 's_agent3' });

    const manifest = inferTemplateManifest(graph, inferOpts);
    expect(manifest.graph.steps[0]!.agentId).toBe('slot:agent:fallback');
    expect(manifest.graph.steps[3]!.agentId).toBe('slot:agent:fallback');
    expect(manifest.graph.steps[4]!.agentId).toBe('slot:agent:worker');
    expect(manifest.slots.agents).toEqual([
      { key: 'worker', label: 'worker' },
      { key: 'fallback', label: 'fallback' },
    ]);
    expect(checkTemplateManifest(manifest)).toEqual({ ok: true, errors: [] });
  });

  it('de-duplicates key collisions with numeric suffixes', () => {
    const graph = makeConcreteGraph();
    // 'act.notify' and 'act notify' both slugify to 'act-notify'
    graph.steps.push({ id: 's_action2', kind: 'action', actionId: 'act notify' });
    graph.transitions.push({ id: 't3', source: 's_human', target: 's_action2' });
    const manifest = inferTemplateManifest(graph, inferOpts);
    expect(manifest.slots.actions).toEqual([
      { key: 'act-notify', label: 'act.notify' },
      { key: 'act-notify-2', label: 'act notify' },
    ]);
  });
});
