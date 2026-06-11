/**
 * PR-9b-2 — the Haiku composition step in the canvasChatAgent.
 *
 *   - composeSkeleton: model path (schema-valid JSON accepted), bounded repair
 *     retry carrying the validator errors, deterministic fallback (non-JSON,
 *     invalid-twice, llm unavailable) — composition never blocks the turn;
 *   - composeStructuredPayloadPatch: payload rows → RFC-6902-subset patch
 *     against the skeleton's own columns; unmappable payloads → null (skip);
 *   - canvasTurnStream via the published agent: skeleton surface_snapshot is
 *     the FIRST event (revision "0"), the delegated main turn carries the
 *     [canvas-context] requirement handoff, an authorised structured payload
 *     becomes a surface_patch with basedOnRevision "0", and non-canvas turns
 *     pass through with zero LLM calls.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  CHAT_AGENT_SERVICE,
  type ChatAgentBundle,
  type ChatStreamEvent,
  type ChatTurnInput,
} from '../packages/harness-channel-sdk/src/index.js';
import type { PluginContext } from '../packages/plugin-api/src/index.js';
import {
  composeSkeleton,
  FALLBACK_SKELETON,
  type CompositionLlm,
} from '../packages/omadia-ui-orchestrator/src/composition.js';
import { composeStructuredPayloadPatch } from '../packages/omadia-ui-orchestrator/src/patchComposition.js';
import { activate } from '../packages/omadia-ui-orchestrator/src/plugin.js';

const SKELETON_TREE = {
  type: 'container',
  id: 'root',
  layout: 'stack',
  children: [
    { type: 'heading', id: 'h', content: 'Tickets by owner', level: 2 },
    {
      type: 'table',
      id: 'tickets',
      loading: 'skeleton',
      columns: [
        { fieldKey: 'owner', label: 'Owner' },
        { fieldKey: 'hoursLeft', label: 'Budget left (h)' },
      ],
      rows: [],
    },
    { type: 'status', id: 'st', text: 'Querying…' },
  ],
};

const VALID_COMPOSER_OUTPUT = JSON.stringify({
  tree: SKELETON_TREE,
  dataRequirements: [
    {
      containerId: 'tickets',
      description: 'open Jira tickets grouped by owner with remaining ERP hour budget',
      fields: [
        { fieldKey: 'owner', label: 'Owner' },
        { fieldKey: 'hoursLeft', label: 'Budget left (h)', type: 'number' },
      ],
    },
  ],
});

const llmReturning = (outputs: string[]): { llm: CompositionLlm; calls: string[] } => {
  const calls: string[] = [];
  let i = 0;
  return {
    calls,
    llm: {
      complete: ({ messages }) => {
        calls.push(messages[0]?.content ?? '');
        const out = outputs[Math.min(i, outputs.length - 1)] ?? '';
        i += 1;
        return Promise.resolve({ text: out });
      },
    },
  };
};

describe('composeSkeleton', () => {
  it('returns a schema-valid skeleton + requirements on the model path', async () => {
    const { llm } = llmReturning([VALID_COMPOSER_OUTPUT]);
    const result = await composeSkeleton({ llm, model: 'claude-haiku-4-5', userText: 'show tickets' });
    assert.equal(result.source, 'model');
    assert.equal((result.tree as { type: string }).type, 'container');
    assert.equal(result.dataRequirements[0]?.containerId, 'tickets');
  });

  it('retries once with validator errors, then falls back deterministically', async () => {
    const { llm, calls } = llmReturning(['{"tree":{"type":"iframe"}}']);
    const result = await composeSkeleton({ llm, model: 'claude-haiku-4-5', userText: 'whatever' });
    assert.equal(calls.length, 2, 'one bounded repair retry');
    assert.match(calls[1] ?? '', /schema-invalid/);
    assert.equal(result.source, 'fallback');
    assert.deepEqual(result.tree, FALLBACK_SKELETON);
    assert.equal(result.dataRequirements.length, 1, 'generic whole-turn requirement');
  });

  it('falls back on non-JSON output and on a rejecting llm', async () => {
    const { llm } = llmReturning(['Sure! Here is your UI: …']);
    const r1 = await composeSkeleton({ llm, model: 'claude-haiku-4-5', userText: 'x' });
    assert.equal(r1.source, 'fallback');

    const rejecting: CompositionLlm = { complete: () => Promise.reject(new Error('no key')) };
    const r2 = await composeSkeleton({ llm: rejecting, model: 'claude-haiku-4-5', userText: 'x' });
    assert.equal(r2.source, 'fallback');
  });

  it('accepts fenced and preambled JSON output (models ignore "raw JSON only")', async () => {
    const fenced = '```json\n' + VALID_COMPOSER_OUTPUT + '\n```';
    const r1 = await composeSkeleton({
      llm: llmReturning([fenced]).llm,
      model: 'claude-haiku-4-5',
      userText: 'show tickets',
    });
    assert.equal(r1.source, 'model');

    const preambled = 'Here is the skeleton you asked for:\n' + VALID_COMPOSER_OUTPUT;
    const r2 = await composeSkeleton({
      llm: llmReturning([preambled]).llm,
      model: 'claude-haiku-4-5',
      userText: 'show tickets',
    });
    assert.equal(r2.source, 'model');
  });

  it('reports every fallback reason through the log hook', async () => {
    const logged: string[] = [];
    await composeSkeleton({
      llm: llmReturning(['not json at all']).llm,
      model: 'claude-haiku-4-5',
      userText: 'x',
      log: (m) => logged.push(m),
    });
    assert.ok(logged.some((m) => m.includes('not parseable')));
    assert.ok(logged.some((m) => m.includes('fallback')));
  });
});

describe('composeStructuredPayloadPatch', () => {
  const REQS = [
    {
      containerId: 'tickets',
      description: 'tickets',
      fields: [{ fieldKey: 'owner', label: 'Owner' }],
    },
  ];

  it('maps payload rows onto the skeleton table (pinned patch grammar)', () => {
    const composed = composeStructuredPayloadPatch({
      baseTree: SKELETON_TREE,
      payload: {
        prose: '2 tickets',
        dataRefId: 'jira-q1',
        data: {
          rows: [
            { rowKey: 'anna', owner: 'Anna Becker', hoursLeft: 5 },
            { owner: 'Bernd Roth', hoursLeft: 7 },
          ],
        },
      },
      dataRequirements: REQS,
    });
    assert.ok(composed, 'patch composed');
    assert.deepEqual(composed?.patches[0], {
      op: 'replace',
      path: '/children/1/loading',
      value: 'none',
    });
    const add = composed?.patches[1];
    assert.equal(add?.op, 'add');
    assert.equal(add?.path, '/children/1/rows/-');
    assert.deepEqual(add?.value, {
      rowKey: 'anna',
      cells: { owner: 'Anna Becker', hoursLeft: 5 },
    });
    // rowKey for the keyless second row is dataRefId-scoped (stable per payload)
    assert.deepEqual((composed?.patches[2] as { value?: { rowKey?: string } }).value?.rowKey, 'jira-q1-1');
    // nextTree carries the appended rows + cleared skeleton state
    const table = (composed?.nextTree as typeof SKELETON_TREE).children[1] as {
      loading?: string;
      rows: unknown[];
    };
    assert.equal(table.loading, 'none');
    assert.equal(table.rows.length, 2);
  });

  it('maps via the explicit data.containerId onto a table nested in a pane', () => {
    // detail view: a participants table inside a tabs/pane whose id is named by
    // NO dataRequirement — only the agent's explicit containerId resolves it.
    const paneTree = {
      type: 'container',
      id: 'root',
      layout: 'stack',
      children: [
        {
          type: 'tabs',
          id: 'detail_tabs',
          tabs: [
            {
              label: 'Teilnehmer',
              child: {
                type: 'table',
                id: 'participants',
                loading: 'skeleton',
                columns: [{ fieldKey: 'name', label: 'Name' }],
                rows: [],
              },
            },
          ],
        },
      ],
    };
    const composed = composeStructuredPayloadPatch({
      baseTree: paneTree,
      payload: {
        prose: '1 Teilnehmer',
        dataRefId: 'p1',
        data: { containerId: 'participants', rows: [{ name: 'Dean Hughes' }] },
      },
      dataRequirements: [], // intentionally empty — explicit containerId must win
    });
    assert.ok(composed, 'explicit containerId resolves the nested table');
    assert.equal(composed?.patches.some((p) => p.path.endsWith('/loading')), true);
    const table = ((composed?.nextTree as { children: Array<{ tabs: Array<{ child: { rows: unknown[] } }> }> })
      .children[0]?.tabs[0]?.child);
    assert.equal(table?.rows.length, 1);
  });

  it('returns null for unmappable payloads (no rows / unknown container)', () => {
    assert.equal(
      composeStructuredPayloadPatch({
        baseTree: SKELETON_TREE,
        payload: { prose: 'x', dataRefId: 'd1', data: { note: 'no rows here' } },
        dataRequirements: REQS,
      }),
      null,
    );
    assert.equal(
      composeStructuredPayloadPatch({
        baseTree: SKELETON_TREE,
        payload: { prose: 'x', dataRefId: 'd1', data: { rows: [{ a: 1 }] } },
        dataRequirements: [{ containerId: 'nope', description: '', fields: [] }],
      }),
      null,
    );
  });
});

describe('composeStructuredPayloadPatch — fields (scalar/KPI)', () => {
  // a KPI block: value leaves carry id `${containerId}.${fieldKey}`
  const KPI_TREE = {
    type: 'container',
    id: 'root',
    layout: 'stack',
    children: [
      {
        type: 'container',
        id: 'scores',
        layout: 'grid',
        loading: 'skeleton',
        children: [
          {
            type: 'container',
            id: 'scores.seo_card',
            layout: 'stack',
            children: [
              { type: 'heading', id: 'scores.seo_card.h', content: 'SEO', level: 4 },
              { type: 'text', id: 'scores.seo', content: '' },
            ],
          },
          {
            type: 'container',
            id: 'scores.tech_card',
            layout: 'stack',
            children: [
              { type: 'heading', id: 'scores.tech_card.h', content: 'Technical', level: 4 },
              { type: 'text', id: 'scores.technical', content: '' },
            ],
          },
        ],
      },
    ],
  };

  it('fills value leaves `${containerId}.${fieldKey}` from data.fields and resolves loading', () => {
    const composed = composeStructuredPayloadPatch({
      baseTree: KPI_TREE,
      payload: {
        prose: '2 scores',
        dataRefId: 'seo-1',
        data: { containerId: 'scores', fields: { seo: 82, technical: 'OK' } },
      },
      dataRequirements: [
        {
          containerId: 'scores',
          description: 'scores',
          fields: [
            { fieldKey: 'seo', label: 'SEO' },
            { fieldKey: 'technical', label: 'Technical' },
          ],
        },
      ],
    });
    assert.ok(composed, 'fields patch composed');
    // container skeleton resolved + each value leaf replaced (as text)
    assert.ok(composed?.patches.some((p) => p.path === '/children/0/loading' && p.op === 'replace'));
    // value leaf `scores.seo` lives at /children/0/children/0/children/1 (the text node)
    const seoPatch = composed?.patches.find(
      (p) => p.path === '/children/0/children/0/children/1/content',
    );
    assert.equal(seoPatch?.op, 'replace');
    assert.equal(seoPatch?.value, '82');
    const tree = composed?.nextTree as typeof KPI_TREE;
    assert.equal(tree.children[0]?.loading, 'none');
    assert.equal(
      (tree.children[0]?.children?.[0]?.children?.[1] as { content?: string }).content,
      '82',
    );
    assert.equal(
      (tree.children[0]?.children?.[1]?.children?.[1] as { content?: string }).content,
      'OK',
    );
  });

  it('returns null when no value leaf matches a field key (unmappable → prose)', () => {
    assert.equal(
      composeStructuredPayloadPatch({
        baseTree: KPI_TREE,
        payload: {
          prose: 'x',
          dataRefId: 'd1',
          data: { containerId: 'scores', fields: { unknown_metric: 5 } },
        },
        dataRequirements: [],
      }),
      null,
    );
  });

  it('drops non-scalar field values, keeps scalar ones', () => {
    const composed = composeStructuredPayloadPatch({
      baseTree: KPI_TREE,
      payload: {
        prose: 'x',
        dataRefId: 'd2',
        data: { containerId: 'scores', fields: { seo: 90, technical: { nested: true } } },
      },
      dataRequirements: [],
    });
    assert.ok(composed, 'composed with the one scalar field');
    const tree = composed?.nextTree as typeof KPI_TREE;
    assert.equal(
      (tree.children[0]?.children?.[0]?.children?.[1] as { content?: string }).content,
      '90',
    );
    // the object-valued field was dropped → its leaf stays empty
    assert.equal(
      (tree.children[0]?.children?.[1]?.children?.[1] as { content?: string }).content,
      '',
    );
  });
});

// ── plugin-level: the canvas turn stream ──

function makeCtx(opts?: { llm?: CompositionLlm; config?: Record<string, string> }) {
  const reg = new Map<string, unknown>();
  const ctx = {
    log: () => {},
    services: {
      get: <T>(name: string): T | undefined => reg.get(name) as T | undefined,
      provide: (name: string, impl: unknown) => {
        reg.set(name, impl);
        return () => reg.delete(name);
      },
    },
    ...(opts?.llm ? { llm: opts.llm } : {}),
    ...(opts?.config
      ? { config: { get: <T>(k: string): T | undefined => opts.config?.[k] as T | undefined } }
      : {}),
  } as unknown as PluginContext;
  return { ctx, reg };
}

function baseBundle(
  events: ChatStreamEvent[],
  seen: ChatTurnInput[],
): ChatAgentBundle {
  return {
    agent: {
      chat: () => Promise.resolve({ text: 'base answer' }),
      async *chatStream(input) {
        seen.push(input);
        await Promise.resolve();
        for (const e of events) yield e;
      },
    },
  };
}

async function collect(it: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

function field(e: ChatStreamEvent, k: string): unknown {
  return (e as unknown as Record<string, unknown>)[k];
}

const STRUCTURED_OUTPUT = JSON.stringify({
  prose: 'twelve tickets',
  _pendingStructuredPayload: {
    prose: 'twelve tickets',
    dataRefId: 'jira-q1',
    data: { rows: [{ rowKey: 'anna', owner: 'Anna Becker', hoursLeft: 5 }] },
  },
});

describe('canvasChatAgent — Haiku composition step', () => {
  it('emits the skeleton snapshot first, hands requirements to the main turn, patches on payload', async () => {
    const { llm, calls } = llmReturning([VALID_COMPOSER_OUTPUT]);
    const { ctx, reg } = makeCtx({ llm, config: { canvas_output_tools: 'jira_tool' } });
    const seen: ChatTurnInput[] = [];
    reg.set(
      CHAT_AGENT_SERVICE,
      baseBundle(
        [
          { type: 'tool_use', id: 't1', name: 'jira_tool', input: {} } as unknown as ChatStreamEvent,
          { type: 'tool_result', id: 't1', output: STRUCTURED_OUTPUT, durationMs: 1 } as unknown as ChatStreamEvent,
          { type: 'text_delta', text: 'Three people…' } as ChatStreamEvent,
          { type: 'done', answer: 'x' } as unknown as ChatStreamEvent,
        ],
        seen,
      ),
    );
    await activate(ctx);
    const agent = (reg.get('canvasChatAgent') as ChatAgentBundle).agent;
    const events = await collect(
      agent.chatStream({
        userMessage: 'show tickets with budgets',
        canvasSessionId: 'cs1',
      } as unknown as ChatTurnInput),
    );

    // (a) skeleton snapshot FIRST, revision "0"
    assert.equal(events[0]?.type, 'surface_snapshot');
    assert.equal(field(events[0] as ChatStreamEvent, 'producesRevision'), '0');
    assert.equal(field(events[0] as ChatStreamEvent, 'surfaceSeq'), 0);
    assert.deepEqual(field(events[0] as ChatStreamEvent, 'tree'), SKELETON_TREE);
    assert.equal(calls.length, 1, 'one composition call');

    // (b) requirement handoff on the delegated main turn
    assert.equal(seen.length, 1);
    assert.match(seen[0]?.userMessage ?? '', /\[canvas-context\]/);
    assert.match(seen[0]?.userMessage ?? '', /"containerId":"tickets"/);
    assert.match(seen[0]?.userMessage ?? '', /call the canvas_publish_rows tool/);

    // (c) authorised structured payload → surface_patch based on the skeleton
    const patch = events.find((e) => e.type === 'surface_patch');
    assert.ok(patch, 'surface_patch emitted');
    assert.equal(field(patch as ChatStreamEvent, 'basedOnRevision'), '0');
    assert.equal(field(patch as ChatStreamEvent, 'producesRevision'), '1');
    assert.equal(field(patch as ChatStreamEvent, 'surfaceSeq'), 1);

    // (d) base events survive untouched
    assert.ok(events.some((e) => e.type === 'text_delta'));
    assert.ok(events.some((e) => e.type === 'done'));
  });

  it('falls back to the deterministic skeleton when ctx.llm is absent — the turn still runs', async () => {
    const { ctx, reg } = makeCtx();
    const seen: ChatTurnInput[] = [];
    reg.set(CHAT_AGENT_SERVICE, baseBundle([{ type: 'done', answer: 'x' } as unknown as ChatStreamEvent], seen));
    await activate(ctx);
    const agent = (reg.get('canvasChatAgent') as ChatAgentBundle).agent;
    const events = await collect(
      agent.chatStream({ userMessage: 'hi', canvasSessionId: 'cs1' } as unknown as ChatTurnInput),
    );
    assert.equal(events[0]?.type, 'surface_snapshot');
    assert.deepEqual(field(events[0] as ChatStreamEvent, 'tree'), FALLBACK_SKELETON);
    assert.equal(events.at(-1)?.type, 'done');
  });

  it('passes non-canvas turns through with zero LLM calls', async () => {
    const { llm, calls } = llmReturning([VALID_COMPOSER_OUTPUT]);
    const { ctx, reg } = makeCtx({ llm });
    const seen: ChatTurnInput[] = [];
    reg.set(CHAT_AGENT_SERVICE, baseBundle([{ type: 'done', answer: 'x' } as unknown as ChatStreamEvent], seen));
    await activate(ctx);
    const agent = (reg.get('canvasChatAgent') as ChatAgentBundle).agent;
    const events = await collect(
      agent.chatStream({ userMessage: 'classic turn' } as unknown as ChatTurnInput),
    );
    assert.equal(calls.length, 0, 'no composition call for a non-canvas turn');
    assert.equal(seen[0]?.userMessage, 'classic turn', 'input untouched');
    assert.equal(events[0]?.type, 'done');
  });
});

// ── PR-9b-3: in-place action turns (client sends canvasState) ──

describe('canvasChatAgent — in-place action (canvasState, 9b-3)', () => {
  const LIVE_TREE = {
    type: 'container',
    id: 'root',
    layout: 'stack',
    children: [
      { type: 'heading', id: 'h', content: 'Drafts', level: 2 },
      { type: 'status', id: 'd-1-status', text: 'draft' },
    ],
  };

  it('skips the skeleton and patches the live tree in place — no remount, no composition', async () => {
    const { llm, calls } = llmReturning([VALID_COMPOSER_OUTPUT]);
    const { ctx, reg } = makeCtx({ llm, config: { canvas_output_tools: 'studio_patch' } });
    const seen: ChatTurnInput[] = [];
    const PATCH_OUTPUT = JSON.stringify({
      prose: 'approved',
      _pendingSurfacePatch: { ops: [{ id: 'd-1-status', set: { text: 'approved', tone: 'success' } }] },
    });
    reg.set(
      CHAT_AGENT_SERVICE,
      baseBundle(
        [
          { type: 'tool_use', id: 't1', name: 'studio_patch', input: {} } as unknown as ChatStreamEvent,
          { type: 'tool_result', id: 't1', output: PATCH_OUTPUT, durationMs: 1 } as unknown as ChatStreamEvent,
          { type: 'done', answer: 'x' } as unknown as ChatStreamEvent,
        ],
        seen,
      ),
    );
    await activate(ctx);
    const agent = (reg.get('canvasChatAgent') as ChatAgentBundle).agent;
    const events = await collect(
      agent.chatStream({
        userMessage: 'approve draft 1',
        canvasSessionId: 'cs1',
        action: { type: 'studio.approve', payload: { value: 'd-1' } },
        canvasState: { basedOnRevision: '5', currentTree: LIVE_TREE },
      } as unknown as ChatTurnInput),
    );

    // (a) no skeleton: zero composition calls, and NO surface_snapshot remount
    assert.equal(calls.length, 0, 'in-place action skips skeleton composition');
    assert.ok(!events.some((e) => e.type === 'surface_snapshot'), 'no remount snapshot');

    // (b) the action turn still runs, carrying the [canvas-action] + in-place context
    assert.equal(seen.length, 1);
    assert.match(seen[0]?.userMessage ?? '', /\[canvas-action\]/);
    assert.match(seen[0]?.userMessage ?? '', /IN PLACE/);
    assert.match(seen[0]?.userMessage ?? '', /"canvasRevision":"5"/);

    // (c) the plugin patch lands as a surface_patch on the CLIENT's revision (seq 0)
    const patch = events.find((e) => e.type === 'surface_patch');
    assert.ok(patch, 'surface_patch emitted');
    assert.equal(field(patch as ChatStreamEvent, 'basedOnRevision'), '5');
    assert.equal(field(patch as ChatStreamEvent, 'surfaceSeq'), 0);
    assert.ok(events.some((e) => e.type === 'done'), 'base events survive');
  });

  it('still recomposes via a single snapshot when an in-place action emits a full tree', async () => {
    const { ctx, reg } = makeCtx({ config: { canvas_output_tools: 'studio_view' } });
    const seen: ChatTurnInput[] = [];
    const NEW_TREE = {
      type: 'container',
      id: 'root',
      layout: 'stack',
      children: [{ type: 'heading', id: 'h2', content: 'Wizard', level: 2 }],
    };
    const TREE_OUTPUT = JSON.stringify({ prose: 'wizard', _pendingCanvasTree: { tree: NEW_TREE } });
    reg.set(
      CHAT_AGENT_SERVICE,
      baseBundle(
        [
          { type: 'tool_use', id: 't1', name: 'studio_view', input: {} } as unknown as ChatStreamEvent,
          { type: 'tool_result', id: 't1', output: TREE_OUTPUT, durationMs: 1 } as unknown as ChatStreamEvent,
          { type: 'done', answer: 'x' } as unknown as ChatStreamEvent,
        ],
        seen,
      ),
    );
    await activate(ctx);
    const agent = (reg.get('canvasChatAgent') as ChatAgentBundle).agent;
    const events = await collect(
      agent.chatStream({
        userMessage: 'open wizard',
        canvasSessionId: 'cs1',
        action: { type: 'studio.wizard' },
        canvasState: { basedOnRevision: '3', currentTree: LIVE_TREE },
      } as unknown as ChatTurnInput),
    );
    // exactly one snapshot (the recompose) — no skeleton flash before it
    const snaps = events.filter((e) => e.type === 'surface_snapshot');
    assert.equal(snaps.length, 1, 'one snapshot (the recompose), not a skeleton + a recompose');
    assert.deepEqual(field(snaps[0] as ChatStreamEvent, 'tree'), NEW_TREE);
  });
});
