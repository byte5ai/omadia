import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { applyTemplateSlots, isTemplateExpression, validate } from '@omadia/conductor-core';
import type { JsonObject, WorkflowGraph } from '@omadia/conductor-core';

import { ConductorAwaitStore } from '../src/conductor/awaitStore.js';
import { loadPatternCatalog } from '../src/conductor/patternCatalog.js';
import { loadTemplateCatalog } from '../src/conductor/templateCatalog.js';
import { RealStepEffects } from '../src/conductor/realStepEffects.js';
import { ConductorRunExecutor } from '../src/conductor/runExecutor.js';
import {
  AWAIT_MESSAGE_MAX_CHARS,
  renderActionInput,
  renderAgentPrompt,
  renderAgentRef,
  renderAwaitMessage,
  UNRESOLVED_PLACEHOLDER,
} from '../src/conductor/runInterpolation.js';

// #1709 — human-step messages and action inputs kept their `{{ctx.*}}` /
// `{{steps.*}}` tokens verbatim, so an approver was shown the template text of
// the workflow instead of the values of the run. The read-back assertions below
// are deliberately made on what is HANDED ON (the await row's message, the
// object the action invoker receives), not on the renderer's input.
//
// The four fields differ in ONE way — what an unresolved token becomes — and the
// suite pins each policy separately, because collapsing them is the regression:
// a dash in a prompt breaks the discussion pattern's opening turn, and a dash in
// an action input gets POSTed to a connector.

const CONTEXT: JsonObject = {
  employeeName: 'Ada Lovelace',
  startDate: '2026-12-01',
  amount: 42,
  nothing: null,
  empty: '',
  nested: { deep: 'value' },
  steps: { 'hr-checklist': { approved: true, note: 'all items done' } },
};

describe('runInterpolation — resolution', () => {
  it('resolves ctx, nested, numeric and step paths — kebab step ids included', () => {
    assert.equal(
      renderAwaitMessage('New hire {{ctx.employeeName}} starts on {{ctx.startDate}}.', CONTEXT),
      'New hire Ada Lovelace starts on 2026-12-01.',
    );
    assert.equal(renderAwaitMessage('{{ ctx.nested.deep }}', CONTEXT), 'value');
    assert.equal(renderAwaitMessage('{{ctx.amount}} EUR', CONTEXT), '42 EUR');
    // A step id is any non-empty string and the bundled templates use kebab ids;
    // the old `[\w.]+` token grammar left these unrendered.
    assert.equal(renderAwaitMessage('{{steps.hr-checklist.note}}', CONTEXT), 'all items done');
    assert.equal(renderAwaitMessage('{{ctx.steps.hr-checklist.approved}}', CONTEXT), 'true');
  });

  it('leaves a non-token brace run and a text-slot token alone', () => {
    assert.equal(renderAwaitMessage('literal {{ not a path }} stays', CONTEXT), 'literal {{ not a path }} stays');
    assert.equal(renderAwaitMessage('slot:text:greeting', CONTEXT), 'slot:text:greeting');
  });

  it('shares its grammar with the authoring check, so a kebab token is not an unknown ref', () => {
    // The two sides drifted once: the runtime resolved `{{ctx.next-speaker}}` while
    // validate() reported `unknown_agent_ref` for the same string.
    assert.equal(isTemplateExpression('{{ctx.next-speaker}}'), true);
    assert.equal(isTemplateExpression('{{steps.hr-checklist.owner}}'), true);
    assert.equal(isTemplateExpression('fallback'), false);

    const graph: WorkflowGraph = {
      entryStepId: 'speak',
      steps: [{ id: 'speak', kind: 'agent', agentId: '{{ctx.next-speaker}}', prompt: 'go' }],
      transitions: [],
    };
    const result = validate(graph, { agentIds: ['fallback'] });
    assert.ok(
      !result.errors.some((e) => e.code === 'unknown_agent_ref'),
      JSON.stringify(result.errors),
    );
  });
});

describe('runInterpolation — the unresolved-token policy per field', () => {
  it('an await message renders a dash — never raw syntax', () => {
    const out = renderAwaitMessage('New hire {{ctx.missing}} starts on {{ctx.nothing}}.', CONTEXT);
    assert.equal(out, `New hire ${UNRESOLVED_PLACEHOLDER} starts on ${UNRESOLVED_PLACEHOLDER}.`);
    assert.ok(!out.includes('{{'), out);
    // An explicitly empty string is a value, not a gap.
    assert.equal(renderAwaitMessage('[{{ctx.empty}}]', CONTEXT), '[]');
  });

  it('an await message is length-capped with a visible ellipsis', () => {
    const long = 'x'.repeat(AWAIT_MESSAGE_MAX_CHARS * 2);
    const out = renderAwaitMessage('Report: {{steps.compose.text}}', { steps: { compose: { text: long } } });
    assert.equal(out.length, AWAIT_MESSAGE_MAX_CHARS);
    assert.ok(out.endsWith('…'), out.slice(-20));
    assert.ok(out.startsWith('Report: xxx'), out.slice(0, 20));
  });

  it('a PROMPT renders empty — a dash would make the discussion pattern read as non-empty', () => {
    assert.equal(renderAgentPrompt('{{ctx.transcriptText}}', {}), '');
    assert.equal(renderAgentPrompt('Topic: {{ctx.topic}}.', { topic: 'pricing' }), 'Topic: pricing.');

    // Read back through the shipped pattern: `transcriptText` is a reserved context key
    // (runContext.ts), stripped from every payload and written only by transcript.ts, so
    // the OPENING turn always renders it unresolved. The prompt branches on that
    // emptiness ("empty if you are opening"), so a placeholder there changes the task.
    const discussion = loadPatternCatalog({ log: () => undefined }).get('discussion');
    assert.ok(discussion, 'bundled discussion pattern is missing');
    const speak = discussion.graph.steps.find((s) => s.id === 'speak');
    assert.ok(speak?.prompt, 'discussion pattern has no speak prompt');
    // NB: assert the transcript slot structurally, not `!includes(UNRESOLVED_PLACEHOLDER)` —
    // the prompt's own prose contains literal em dashes, so that check passes vacuously
    // in one direction and false-positives in the other.
    const opening = renderAgentPrompt(speak.prompt, { topic: 'pricing', participants: 'a, b' });
    assert.ok(opening.includes('empty if you are opening):\n\n\n'), 'transcript must render empty');
    assert.ok(!opening.includes('{{'), 'no token may survive');
  });

  it('a REF renders empty, so an unnamed speaker stays detectable', () => {
    assert.equal(renderAgentRef('{{ctx.speaker}}', CONTEXT), '');
    assert.equal(renderAgentRef('{{ctx.employeeName}}', CONTEXT), 'Ada Lovelace');
  });

  it('an ACTION INPUT renders empty at any depth, and no key — a dash would be POSTed onward', () => {
    const input: JsonObject = {
      '{{ctx.employeeName}}': 'key stays a key',
      url: 'https://example.invalid/hire/{{ctx.employeeName}}',
      body: { lines: ['start {{ctx.startDate}}', 'note: {{ctx.missing}}'], amount: 42, flag: true, none: null },
    };
    const out = renderActionInput(input, CONTEXT);
    assert.deepEqual(out, {
      '{{ctx.employeeName}}': 'key stays a key',
      url: 'https://example.invalid/hire/Ada Lovelace',
      body: { lines: ['start 2026-12-01', 'note: '], amount: 42, flag: true, none: null },
    });
    // The graph's own input object is never mutated.
    assert.deepEqual(input.body, {
      lines: ['start {{ctx.startDate}}', 'note: {{ctx.missing}}'],
      amount: 42,
      flag: true,
      none: null,
    });
  });
});

describe('RealStepEffects — action input interpolation', () => {
  function effects(capture: { input?: unknown }) {
    return new RealStepEffects({
      getRegistry: () => undefined,
      invokeAction: async (_toolId: string, input: unknown) => {
        capture.input = input;
        return JSON.stringify({ ok: true });
      },
    });
  }

  it('hands the invoker the rendered input, not the template', async () => {
    const capture: { input?: unknown } = {};
    const exec = await effects(capture).runActionStep(
      {
        id: 'notify',
        kind: 'action',
        actionId: 'webhook.post',
        input: { url: 'https://example.invalid/hook', body: { text: 'Onboarding for {{ctx.employeeName}} done' } },
      },
      { employeeName: 'Ada Lovelace' },
      { runId: 'run1' },
    );
    assert.deepEqual(capture.input, {
      url: 'https://example.invalid/hook',
      body: { text: 'Onboarding for Ada Lovelace done' },
    });
    assert.deepEqual(exec.actor, { kind: 'action', actionId: 'webhook.post' });
  });

  it('refuses an agent step whose context names no speaker instead of resolving a dash', async () => {
    await assert.rejects(
      () =>
        effects({}).runAgentStep(
          { id: 'speak', kind: 'agent', agentId: '{{ctx.speaker}}' },
          {},
          { runId: 'run1' },
        ),
      /does not name a speaker/,
    );
  });
});

describe('ConductorAwaitStore — a row parked before the fix', () => {
  /** A fake pg Pool that answers every query with one row. */
  function poolWith(row: Record<string, unknown>) {
    return { query: async () => ({ rows: [row], rowCount: 1 }) } as never;
  }

  const row = {
    id: 'aw1', run_id: 'run1', step_id: 'hr-checklist', principal_kind: 'role', principal_ref: 'role-hr',
    channel_type: 'teams', quorum: 'any', reminder_interval_ms: null, deadline_at: null,
    fallback_transition_id: null, status: 'waiting', unreachable: false, created_at: new Date(0),
  };

  it('renders the stored template on read, against the joined run context', async () => {
    const store = new ConductorAwaitStore(
      poolWith({
        ...row,
        message: 'New hire {{ctx.employeeName}} starts on {{ctx.startDate}}.',
        run_context: { employeeName: 'Ada Lovelace', startDate: '2026-12-01' },
      }),
    );
    const [aw] = await store.listWaiting();
    assert.equal(aw?.message, 'New hire Ada Lovelace starts on 2026-12-01.');
  });

  it('falls back to dashes when the run row is gone, never to raw syntax', async () => {
    const store = new ConductorAwaitStore(
      poolWith({ ...row, message: 'New hire {{ctx.employeeName}}.', run_context: null }),
    );
    const aw = await store.get('aw1');
    assert.equal(aw?.message, `New hire ${UNRESOLVED_PLACEHOLDER}.`);
  });

  it('leaves an already-rendered message untouched', async () => {
    const store = new ConductorAwaitStore(
      poolWith({ ...row, message: 'New hire Ada Lovelace.', run_context: { employeeName: 'someone else' } }),
    );
    const aw = await store.get('aw1');
    assert.equal(aw?.message, 'New hire Ada Lovelace.');
  });
});

// ── executor harness (conductorTimerStep.test.ts mould) ──────────────────────

function makeHarness(graph: WorkflowGraph, agentText = 'ok') {
  const recorded: Array<Record<string, unknown>> = [];
  const awaitsCreated: Array<Record<string, unknown>> = [];
  const awaitRows: Array<Record<string, unknown>> = [];
  const run: Record<string, unknown> = {
    id: 'run1', workflowVersionId: 'v1', status: 'running', currentStepId: graph.entryStepId,
    context: {}, triggerKind: 'manual', triggerSource: null, isDryRun: false,
    startedAt: new Date(0), endedAt: null, cancelRequestedBy: null, cancelRequestedAt: null,
  };

  const executor = new ConductorRunExecutor({
    workflowStore: {
      getBySlug: async () => ({ id: 'w1', slug: 'probe', status: 'enabled', activeVersionId: 'v1' }),
      getVersion: async () => ({ id: 'v1', workflowId: 'w1', version: 1, graph }),
    } as never,
    runStore: {
      create: async () => run,
      get: async () => run,
      acquireLease: async () => undefined,
      stepsForRun: async () => recorded,
      isCancelRequested: async () => false,
      park: async (_runId: string, stepId: string, context: Record<string, unknown>) => {
        run.status = 'waiting';
        run.currentStepId = stepId;
        run.context = context;
      },
      recordStepAndAdvance: async (input: Record<string, unknown>) => {
        recorded.push(input);
        run.status = input.status;
        run.context = input.context;
      },
    } as never,
    awaitStore: {
      create: async (input: Record<string, unknown>) => {
        const created = { id: `aw${String(awaitsCreated.length + 1)}`, status: 'waiting', createdAt: new Date(0), ...input };
        awaitsCreated.push(input);
        awaitRows.push(created);
        return created;
      },
      get: async (id: string) => awaitRows.find((a) => a.id === id) ?? null,
      close: async () => true,
    } as never,
    effects: {
      runAgentStep: async () => ({ result: { text: agentText }, actor: { kind: 'agent', agentSlug: 'x' } }),
      runActionStep: async () => ({ result: { text: 'action' }, actor: { kind: 'action' } }),
    } as never,
    resolveRoleHolders: async () => ({ holders: ['user-1'], partial: false, bySource: [] }),
  });
  return { executor, awaitsCreated, awaitRows, run };
}

const catalog = loadTemplateCatalog({ log: () => undefined });

function instantiate(id: string, mapping: Parameters<typeof applyTemplateSlots>[1]): WorkflowGraph {
  const manifest = catalog.get(id);
  assert.ok(manifest, `bundled template '${id}' is missing`);
  return applyTemplateSlots(manifest, mapping);
}

const ONBOARDING = {
  agents: { notifier: 'fallback' },
  roles: { hr: 'role-hr', it: 'role-it', manager: 'role-manager' },
  channels: { delivery: 'teams' },
};

describe('ConductorRunExecutor — the await an approver actually reads', () => {
  it('the bundled onboarding checklist opens its await with the payload substituted', async () => {
    const { executor, awaitsCreated, run } = makeHarness(instantiate('onboarding-checklist', ONBOARDING));

    const out = await executor.startRun({
      slug: 'probe',
      payload: { employeeName: 'Ada Lovelace', startDate: '2026-12-01' },
      awaitCompletion: true,
    });

    assert.equal(out.status, 'waiting');
    assert.equal(run.currentStepId, 'hr-checklist');
    assert.equal(awaitsCreated.length, 1);
    assert.equal(
      awaitsCreated[0]!.message,
      'New hire Ada Lovelace starts on 2026-12-01. Please complete the HR onboarding items (contract, payroll, policies) and confirm.',
    );
  });

  it('a run started without a payload shows dashes, not template syntax', async () => {
    const { executor, awaitsCreated } = makeHarness(instantiate('onboarding-checklist', ONBOARDING));

    await executor.startRun({ slug: 'probe', payload: {}, awaitCompletion: true });

    const message = awaitsCreated[0]!.message as string;
    assert.ok(!message.includes('{{'), message);
    assert.equal(
      message,
      `New hire ${UNRESOLVED_PLACEHOLDER} starts on ${UNRESOLVED_PLACEHOLDER}. Please complete the HR onboarding items (contract, payroll, policies) and confirm.`,
    );
  });

  it('the weekly report await carries the composing step result, not {{steps.compose.text}}', async () => {
    const graph = instantiate('weekly-report', {
      agents: { reporter: 'fallback' },
      roles: { recipient: 'role-team' },
      channels: { delivery: 'teams' },
    });
    const { executor, awaitsCreated } = makeHarness(graph, 'Highlights: shipped the conductor fix.');

    await executor.startRun({ slug: 'probe', payload: {}, awaitCompletion: true });

    assert.equal(
      awaitsCreated[0]!.message,
      'The weekly status report is ready: Highlights: shipped the conductor fix.',
    );
  });

  // The two escalation templates reach their SECOND await through a different path:
  // expireAwait → driveFrom(run.context) → openHumanAwait. Rendering lives in
  // openHumanAwait, so this path has to carry the context too.
  it('the expense-approval escalation await renders after a deadline passes', async () => {
    const graph = instantiate('expense-approval', {
      agents: { summarizer: 'fallback', notifier: 'fallback' },
      roles: { approver: 'role-approver', 'escalation-approver': 'role-cfo' },
      channels: { delivery: 'teams' },
    });
    const { executor, awaitsCreated, awaitRows } = makeHarness(graph, 'Taxi to the airport, 42 EUR, within policy.');

    await executor.startRun({
      slug: 'probe',
      payload: { requester: 'Ada Lovelace', amount: '42 EUR', purpose: 'travel' },
      awaitCompletion: true,
    });
    assert.equal(awaitsCreated.length, 1);

    await executor.expireAwait(awaitRows[0]!.id as string);

    assert.equal(awaitsCreated.length, 2);
    assert.equal(
      awaitsCreated[1]!.message,
      'Escalation: the expense request from Ada Lovelace over 42 EUR was not decided within 48 hours. ' +
        'Please decide now. Summary: Taxi to the airport, 42 EUR, within policy.',
    );
  });

  it('the notify-and-escalate escalation await renders after a deadline passes', async () => {
    const graph = instantiate('notify-and-escalate', {
      agents: { triage: 'fallback', notifier: 'fallback' },
      roles: { 'on-duty': 'role-oncall', escalation: 'role-lead' },
      events: { incident: 'teams.message.posted' },
      channels: { delivery: 'teams' },
    });
    const { executor, awaitsCreated, awaitRows } = makeHarness(graph, 'Checkout is down for EU customers.');

    await executor.startRun({
      slug: 'probe',
      payload: { summary: 'payments API 500s' },
      awaitCompletion: true,
    });
    await executor.expireAwait(awaitRows[0]!.id as string);

    assert.equal(awaitsCreated.length, 2);
    assert.equal(
      awaitsCreated[1]!.message,
      'Escalation: the incident (payments API 500s) was not acknowledged by the on-duty role within 4 hours. ' +
        'Please take over. Triage note: Checkout is down for EU customers.',
    );
  });
});
