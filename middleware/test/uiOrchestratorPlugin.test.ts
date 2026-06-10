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
  CANVAS_PUBLISH_TOOL,
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

  it('returns an error string (no sentinel) for missing containerId or empty rows', async () => {
    const out = await handleCanvasPublishRows({ containerId: '', rows: [] });
    assert.match(out, /^Error:/);
    assert.equal(parseToolEmittedStructuredPayload(out), undefined);
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
    assert.deepEqual(registered, [CANVAS_PUBLISH_TOOL]);
    await handle.close();
    assert.equal(disposed, 1);
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
