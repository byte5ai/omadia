import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { loadManifestFromPath } from '../src/plugins/manifestLoader.js';
import {
  CHAT_AGENT_SERVICE,
  type ChatAgentBundle,
  type ChatStreamEvent,
  type ChatTurnInput,
} from '../packages/harness-channel-sdk/src/index.js';
import type { PluginContext } from '../packages/plugin-api/src/index.js';
import {
  activate,
  CANVAS_CHAT_AGENT_SERVICE,
  CANVAS_CHOICE_TOOL,
  CANVAS_PUBLISH_TOOL,
  handleCanvasPublishChoice,
  handleCanvasPublishRows,
} from '../packages/omadia-ui-orchestrator/src/plugin.js';
import { parseToolEmittedStructuredPayload } from '../packages/harness-orchestrator/src/canvasSentinels.js';
import { composeStructuredPayloadPatch } from '../packages/omadia-ui-orchestrator/src/patchComposition.js';

/**
 * PR-9a — the omadia-ui-orchestrator skeleton. activate() publishes
 * `canvasChatAgent` (bare key), delegating chat/chatStream to the base
 * `chatAgent` resolved lazily per call. No canvas composition yet.
 */

/** Tiny in-memory services registry + ctx mock (only the surface activate uses). */
function makeCtx() {
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
  } as unknown as PluginContext;
  return { ctx, reg };
}

const input = {
  userMessage: 'hi',
  sessionScope: 's',
  userId: 'u',
} as unknown as ChatTurnInput;

function baseBundle(events: ChatStreamEvent[]): ChatAgentBundle {
  return {
    agent: {
      chat: () => Promise.resolve({ text: 'base answer' }),
      async *chatStream() {
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

describe('omadia-ui-orchestrator skeleton', () => {
  it('publishes canvasChatAgent under the bare key', async () => {
    const { ctx, reg } = makeCtx();
    await activate(ctx);
    assert.equal(CANVAS_CHAT_AGENT_SERVICE, 'canvasChatAgent');
    const bundle = reg.get('canvasChatAgent') as ChatAgentBundle | undefined;
    assert.ok(bundle?.agent, 'canvasChatAgent bundle with an agent is registered');
  });

  it('delegates chat + chatStream to the base chatAgent', async () => {
    const { ctx, reg } = makeCtx();
    reg.set(CHAT_AGENT_SERVICE, baseBundle([{ type: 'done', answer: 'x', toolCalls: 0, iterations: 1 }]));
    await activate(ctx);
    const agent = (reg.get('canvasChatAgent') as ChatAgentBundle).agent;
    assert.equal((await agent.chat(input)).text, 'base answer');
    const events = await collect(agent.chatStream(input));
    assert.equal(events.at(-1)?.type, 'done');
  });

  it('degrades gracefully when no base chatAgent is registered', async () => {
    const { ctx, reg } = makeCtx();
    await activate(ctx);
    const agent = (reg.get('canvasChatAgent') as ChatAgentBundle).agent;
    await assert.rejects(() => agent.chat(input), /orchestrator unavailable/);
    const events = await collect(agent.chatStream(input));
    assert.deepEqual(events, [{ type: 'error', message: 'orchestrator unavailable' }]);
  });

  it('close() removes the published service', async () => {
    const { ctx, reg } = makeCtx();
    const handle = await activate(ctx);
    assert.ok(reg.get('canvasChatAgent'));
    await handle.close();
    assert.equal(reg.get('canvasChatAgent'), undefined);
  });
});

describe('canvas_publish_rows producer tool', () => {
  it('emits a parseable structured-payload sentinel that composes onto a skeleton table', async () => {
    const out = await handleCanvasPublishRows({
      containerId: 'courses',
      rows: [
        { courseName: 'Sea Survival', date: '2026-06-15' },
        { courseName: 'First Aid', date: '2026-06-16' },
      ],
      prose: '2 Kurse veröffentlicht.',
    });
    const payload = parseToolEmittedStructuredPayload(out);
    assert.ok(payload, 'handler output carries the sentinel');
    assert.equal(payload.prose, '2 Kurse veröffentlicht.');

    const baseTree = {
      type: 'container',
      id: 'root',
      layout: 'stack',
      children: [
        {
          type: 'table',
          id: 'courses',
          loading: 'skeleton',
          columns: [
            { fieldKey: 'courseName', label: 'Kurs' },
            { fieldKey: 'date', label: 'Datum' },
          ],
          rows: [],
        },
      ],
    };
    const composed = composeStructuredPayloadPatch({
      baseTree,
      payload,
      dataRequirements: [{ containerId: 'courses', description: 'Kurse', fields: [] }],
    });
    assert.ok(composed, 'payload maps onto the skeleton table');
    assert.equal(composed.patches[0]?.op, 'replace'); // loading: skeleton → none
    assert.equal(composed.patches.length, 3, 'loading replace + 2 row adds');
  });

  it('emits a fields sentinel that fills a scalar/KPI container (no rows)', async () => {
    const out = await handleCanvasPublishRows({
      containerId: 'scores',
      fields: { seo: 82, technical: 'OK' },
      prose: 'Scores veröffentlicht.',
    });
    const payload = parseToolEmittedStructuredPayload(out);
    assert.ok(payload, 'handler output carries the sentinel');
    // a fields publish carries `fields`, not `rows`
    assert.deepEqual((payload.data as { fields?: unknown }).fields, { seo: 82, technical: 'OK' });
    assert.equal((payload.data as { rows?: unknown }).rows, undefined);

    const baseTree = {
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
            { type: 'text', id: 'scores.seo', content: '' },
            { type: 'text', id: 'scores.technical', content: '' },
          ],
        },
      ],
    };
    const composed = composeStructuredPayloadPatch({
      baseTree,
      payload,
      dataRequirements: [{ containerId: 'scores', description: 'Scores', fields: [] }],
    });
    assert.ok(composed, 'fields payload maps onto the scalar container');
    const tree = composed.nextTree as {
      children: Array<{ loading?: string; children: Array<{ content?: string }> }>;
    };
    assert.equal(tree.children[0]?.loading, 'none');
    assert.equal(tree.children[0]?.children[0]?.content, '82');
    assert.equal(tree.children[0]?.children[1]?.content, 'OK');
  });

  it('maps agent-authored actions onto the table as suggestedActions and strips markdown in cells', async () => {
    const out = await handleCanvasPublishRows({
      containerId: 'courses',
      rows: [{ courseName: '**Sea Survival**' }],
      actions: [
        { id: 'unenroll', label: 'Teilnehmer abmelden', prompt: 'Melde diesen Teilnehmer ab' },
        { label: 'E-Mail senden' },
      ],
    });
    const payload = parseToolEmittedStructuredPayload(out);
    assert.ok(payload);
    const baseTree = {
      type: 'container',
      id: 'root',
      layout: 'stack',
      children: [
        {
          type: 'table',
          id: 'courses',
          loading: 'skeleton',
          columns: [{ fieldKey: 'courseName', label: 'Kurs' }],
          rows: [],
        },
      ],
    };
    const composed = composeStructuredPayloadPatch({
      baseTree,
      payload,
      dataRequirements: [{ containerId: 'courses', description: 'Kurse', fields: [] }],
    });
    assert.ok(composed, 'rows + actions compose');
    const actionsPatch = composed.patches.find((p) => p.path.endsWith('/suggestedActions'));
    assert.ok(actionsPatch, 'suggestedActions patch emitted');
    const acts = actionsPatch.value as Array<{ id: string; label: string; effect: string; prompt?: string }>;
    assert.equal(acts.length, 2);
    assert.equal(acts[0]?.id, 'unenroll');
    assert.equal(acts[0]?.effect, 'internal');
    assert.equal(acts[1]?.label, 'E-Mail senden');
    const rowPatch = composed.patches.find((p) => p.path.endsWith('/rows/-'));
    assert.equal(
      (rowPatch?.value as { cells: Record<string, unknown> }).cells['courseName'],
      'Sea Survival',
      'markdown emphasis stripped from cell values',
    );
  });

  it('maps rows published against a CHART container onto points and resolves loading', async () => {
    const out = await handleCanvasPublishRows({
      containerId: 'bookings_chart',
      rows: [
        { label: 'KW 25', value: 12 },
        { label: 'KW 26', value: 7 },
      ],
    });
    const payload = parseToolEmittedStructuredPayload(out);
    assert.ok(payload);
    const baseTree = {
      type: 'container',
      id: 'root',
      layout: 'stack',
      children: [
        { type: 'chart', id: 'bookings_chart', chartType: 'bar', loading: 'skeleton', points: [] },
      ],
    };
    const composed = composeStructuredPayloadPatch({
      baseTree,
      payload,
      dataRequirements: [{ containerId: 'bookings_chart', description: 'Buchungen', fields: [] }],
    });
    assert.ok(composed, 'rows map onto the chart');
    assert.equal(composed.patches[0]?.op, 'replace'); // loading → none
    assert.equal(composed.patches.length, 3, 'loading + 2 point adds');
    const point = composed.patches[1]?.value as { pointKey: string; label: string; value: number };
    assert.equal(point.label, 'KW 25');
    assert.equal(point.value, 12);
    assert.ok(point.pointKey.length > 0);
  });

  it('returns an error string (no sentinel) for a missing containerId or rows array', async () => {
    assert.match(await handleCanvasPublishRows({ containerId: '', rows: [] }), /^Error:/);
    assert.match(await handleCanvasPublishRows({ containerId: 'courses' }), /^Error:/);
    assert.equal(
      parseToolEmittedStructuredPayload(await handleCanvasPublishRows({ containerId: '', rows: [] })),
      undefined,
    );
  });

  it('accepts empty rows (empty data set) and still resolves the skeleton loading state', async () => {
    const out = await handleCanvasPublishRows({ containerId: 'courses', rows: [] });
    const payload = parseToolEmittedStructuredPayload(out);
    assert.ok(payload, 'empty data set still emits the sentinel');
    assert.match(payload.prose, /empty/);

    const baseTree = {
      type: 'container',
      id: 'root',
      layout: 'stack',
      children: [
        {
          type: 'table',
          id: 'courses',
          loading: 'skeleton',
          columns: [{ fieldKey: 'courseName', label: 'Kurs' }],
          rows: [],
        },
      ],
    };
    const composed = composeStructuredPayloadPatch({
      baseTree,
      payload,
      dataRequirements: [{ containerId: 'courses', description: 'Kurse', fields: [] }],
    });
    assert.ok(composed, 'empty payload still composes the loading-clearing patch');
    assert.deepEqual(composed.patches, [
      { op: 'replace', path: '/children/0/loading', value: 'none' },
    ]);
  });
});

describe('canvas_publish_choice producer tool', () => {
  it('emits a sentinel that appends a choice element to the root container', async () => {
    const out = await handleCanvasPublishChoice({
      question: 'Welchen Kurs meinst du?',
      options: [
        { value: 'heinemann', label: 'Manual Handling — Heinemann, 09:00' },
        { value: 'mukran', label: 'Manual Handling — Mukran, 08:30' },
      ],
      prose: 'Zwei Kurse gefunden.',
    });
    const payload = parseToolEmittedStructuredPayload(out);
    assert.ok(payload, 'handler output carries the sentinel');
    assert.equal(payload.prose, 'Zwei Kurse gefunden.');

    const baseTree = { type: 'container', id: 'root', layout: 'stack', children: [] };
    const composed = composeStructuredPayloadPatch({ baseTree, payload, dataRequirements: [] });
    assert.ok(composed, 'choice payload composes onto the root container');
    assert.equal(composed.patches.length, 1);
    assert.equal(composed.patches[0]?.path, '/children/-');
    const node = composed.patches[0]?.value as { type: string; label: string; options: unknown[] };
    assert.equal(node.type, 'choice');
    assert.equal(node.label, 'Welchen Kurs meinst du?');
    assert.equal(node.options.length, 2);
  });

  it('returns an error string (no sentinel) for a missing question or fewer than two options', async () => {
    assert.match(await handleCanvasPublishChoice({ question: '', options: [] }), /^Error:/);
    assert.match(
      await handleCanvasPublishChoice({ question: 'Which?', options: [{ value: 'a', label: 'A' }] }),
      /^Error:/,
    );
  });

  it('registers the tool when the context has a tools accessor and disposes on close', async () => {
    const reg = new Map<string, unknown>();
    const registered: string[] = [];
    let disposed = 0;
    const ctx = {
      log: () => {},
      services: {
        get: <T>(name: string): T | undefined => reg.get(name) as T | undefined,
        provide: (name: string, impl: unknown) => {
          reg.set(name, impl);
          return () => reg.delete(name);
        },
      },
      tools: {
        register: (spec: { name: string }) => {
          registered.push(spec.name);
          return () => {
            disposed += 1;
          };
        },
      },
    } as unknown as PluginContext;
    const handle = await activate(ctx);
    assert.deepEqual(registered, [CANVAS_PUBLISH_TOOL, CANVAS_CHOICE_TOOL]);
    await handle.close();
    assert.equal(disposed, 2);
  });
});

describe('omadia-ui-orchestrator manifest', () => {
  // CI does not boot the app, so without this test the load-bearing manifest is
  // unvalidated. Loading it through the real loader proves it is a valid
  // schema-v1 plugin the builtInPackageStore will accept at boot.
  it('is a valid schema-v1 extension manifest providing canvasChatAgent@1', async () => {
    const manifestPath = fileURLToPath(
      new URL('../packages/omadia-ui-orchestrator/manifest.yaml', import.meta.url),
    );
    const entry = await loadManifestFromPath(manifestPath);
    assert.ok(entry, 'manifest loads as a valid schema-v1 document');
    assert.equal(entry.plugin.kind, 'extension');
    assert.equal(entry.plugin.id, '@omadia/ui-orchestrator');
    assert.deepEqual(entry.plugin.provides, ['canvasChatAgent@1']);
    assert.deepEqual(entry.plugin.requires, ['chatAgent@^1']);
  });
});

describe('canvas_publish_rows — privacy-shield datasetId publishes', () => {
  const dataset = {
    rowCount: 3,
    columns: [
      { path: 'invoice', type: 'string' },
      { path: 'amount', type: 'number' },
    ],
    rows: [
      { invoice: 'INV-1', amount: 100 },
      { invoice: 'INV-2', amount: 250.5 },
      { invoice: 'INV-3', amount: 7 },
    ],
  };

  it('resolves a datasetId server-side and publishes the real rows', async () => {
    const out = await handleCanvasPublishRows(
      { containerId: 'invoices', datasetId: 'ds_abc123', prose: '' },
      (id) => (id === 'ds_abc123' ? dataset : undefined),
    );
    const payload = parseToolEmittedStructuredPayload(out);
    assert.ok(payload, 'dataset publish emits the sentinel');
    const data = payload.data as { rows?: Array<Record<string, unknown>> };
    assert.equal(data.rows?.length, 3);
    assert.deepEqual(data.rows?.[0], { invoice: 'INV-1', amount: 100 });
    assert.match(payload.prose, /3 row\(s\) from dataset ds_abc123/);
  });

  it('rejects datasetId combined with rows or fields', async () => {
    const out = await handleCanvasPublishRows(
      { containerId: 'invoices', datasetId: 'ds_abc123', rows: [{ a: 1 }] },
      () => dataset,
    );
    assert.match(out, /^Error: .*EITHER datasetId OR rows/);
  });

  it('reports an unknown/expired datasetId with same-turn guidance', async () => {
    const out = await handleCanvasPublishRows(
      { containerId: 'invoices', datasetId: 'ds_gone' },
      () => undefined,
    );
    assert.match(out, /^Error: unknown or expired datasetId/);
    assert.match(out, /SAME turn/);
  });

  it('reports dataset support as unavailable without a privacy provider', async () => {
    const viaSentinel = await handleCanvasPublishRows(
      { containerId: 'invoices', datasetId: 'ds_abc123' },
      () => 'unavailable',
    );
    assert.match(viaSentinel, /^Error: dataset publishing is unavailable/);
    const withoutResolver = await handleCanvasPublishRows({
      containerId: 'invoices',
      datasetId: 'ds_abc123',
    });
    assert.match(withoutResolver, /^Error: dataset publishing is unavailable/);
  });

  it('turns a dataset reference smuggled into rows into a self-correcting error', async () => {
    const byKey = await handleCanvasPublishRows({
      containerId: 'invoices',
      rows: [{ datasetId: 'ds_abc123' }],
    });
    assert.match(byKey, /^Error: that rows array contains a dataset REFERENCE/);
    const byValue = await handleCanvasPublishRows({
      containerId: 'invoices',
      rows: [{ data: 'ds_5239d8b1-b0fc-4cf6-838f-bdcdcbf13aa3' }],
    });
    assert.match(byValue, /^Error: that rows array contains a dataset REFERENCE/);
  });

  it('caps oversized dataset publishes and says so in the prose', async () => {
    const big = {
      rowCount: 750,
      columns: [{ path: 'n', type: 'number' }],
      rows: Array.from({ length: 750 }, (_, i) => ({ n: i })),
    };
    const out = await handleCanvasPublishRows(
      { containerId: 'invoices', datasetId: 'ds_big' },
      () => big,
    );
    const payload = parseToolEmittedStructuredPayload(out);
    assert.ok(payload);
    const data = payload.data as { rows?: unknown[] };
    assert.equal(data.rows?.length, 500);
    assert.match(payload.prose, /Truncated from 750 rows/);
  });
});
