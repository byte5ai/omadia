/**
 * PR-9b-1 — Tier-2 surface synthesis in the canvasChatAgent.
 *
 * Drives `synthesizeSurfaceEvents` with a fake base `ChatStreamEvent` stream
 * (no kernel, no real orchestrator): an AUTHORISED tool's `_pendingCanvasTree`
 * sentinel becomes an injected `surface_snapshot`; the gate is deny-by-default;
 * non-tool events pass through unchanged; surfaceSeq/revision are monotonic.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { ChatStreamEvent } from '../packages/harness-channel-sdk/src/index.js';
import {
  synthesizeSurfaceEvents,
  type SurfaceSynthesisConfig,
} from '../packages/omadia-ui-orchestrator/src/surfaceSynthesis.js';

function streamOf(events: ChatStreamEvent[]): AsyncIterable<ChatStreamEvent> {
  return (async function* () {
    for (const e of events) {
      await Promise.resolve();
      yield e;
    }
  })();
}

async function collect(
  it: AsyncIterable<ChatStreamEvent>,
): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

function field(e: ChatStreamEvent, k: string): unknown {
  return (e as unknown as Record<string, unknown>)[k];
}

function cfg(authorized: string[]): SurfaceSynthesisConfig {
  return {
    canvasSessionId: 'cs1',
    authorizedToolNames: new Set(authorized),
    protocolVersion: '1.0',
    opsCatalogVersion: '1.0',
  };
}

const toolUse = (id: string, name: string): ChatStreamEvent =>
  ({ type: 'tool_use', id, name, input: {} }) as unknown as ChatStreamEvent;
const toolResult = (id: string, output: string): ChatStreamEvent =>
  ({ type: 'tool_result', id, output, durationMs: 1 }) as unknown as ChatStreamEvent;
const subToolUse = (id: string, name: string): ChatStreamEvent =>
  ({ type: 'sub_tool_use', parentId: 'q', id, name, input: {} }) as unknown as ChatStreamEvent;
const subToolResult = (id: string, output: string): ChatStreamEvent =>
  ({
    type: 'sub_tool_result',
    parentId: 'q',
    id,
    output,
    durationMs: 1,
    isError: false,
  }) as unknown as ChatStreamEvent;

const CANVAS_TREE_OUTPUT = JSON.stringify({
  prose: 'here is the table',
  _pendingCanvasTree: { tree: { type: 'p_text', id: 'x' } },
});

describe('canvasChatAgent surface synthesis', () => {
  it('synthesises a surface_snapshot from an authorised tool canvas sentinel', async () => {
    const out = await collect(
      synthesizeSurfaceEvents(
        streamOf([
          toolUse('t1', 'canvas_tool'),
          toolResult('t1', CANVAS_TREE_OUTPUT),
          { type: 'done', answer: 'x' } as unknown as ChatStreamEvent,
        ]),
        cfg(['canvas_tool']),
      ),
    );
    const snap = out.find((e) => e.type === 'surface_snapshot');
    assert.ok(snap, 'surface_snapshot emitted');
    assert.equal(field(snap, 'canvasSessionId'), 'cs1');
    assert.equal(field(snap, 'surfaceSeq'), 0);
    assert.equal(field(snap, 'producesRevision'), '0');
    assert.deepEqual(field(snap, 'tree'), { type: 'p_text', id: 'x' });
    assert.equal(field(snap, 'protocolVersion'), '1.0');
    // original events survive
    assert.ok(out.some((e) => e.type === 'tool_result'));
    assert.ok(out.some((e) => e.type === 'done'));
  });

  it('synthesises a surface_snapshot from a SUB-AGENT tool canvas sentinel', async () => {
    // Agent-kind plugins (e.g. X Studio) emit their deterministic tree from a
    // sub-tool inside the domain tool; the orchestrator forwards it as
    // sub_tool_use/sub_tool_result. Authorisation matches on the sub-tool name.
    const out = await collect(
      synthesizeSurfaceEvents(
        streamOf([
          subToolUse('s1', 'x_studio_show_wizard'),
          subToolResult('s1', CANVAS_TREE_OUTPUT),
          { type: 'done', answer: 'x' } as unknown as ChatStreamEvent,
        ]),
        cfg(['x_studio_show_wizard']),
      ),
    );
    const snap = out.find((e) => e.type === 'surface_snapshot');
    assert.ok(snap, 'surface_snapshot emitted from sub-tool sentinel');
    assert.deepEqual(field(snap, 'tree'), { type: 'p_text', id: 'x' });
    assert.ok(out.some((e) => e.type === 'sub_tool_result'), 'sub_tool_result passes through');
    assert.ok(out.some((e) => e.type === 'sub_tool_use'), 'sub_tool_use passes through');
  });

  it('denies an unauthorised SUB-AGENT tool (deny-by-default)', async () => {
    const out = await collect(
      synthesizeSurfaceEvents(
        streamOf([
          subToolUse('s1', 'untrusted_subtool'),
          subToolResult('s1', CANVAS_TREE_OUTPUT),
        ]),
        cfg(['x_studio_show_wizard']),
      ),
    );
    assert.ok(!out.some((e) => e.type === 'surface_snapshot'));
    assert.ok(out.some((e) => e.type === 'sub_tool_result'), 'event still passes through');
  });

  it('does not synthesise when the tool is not authorised (deny-by-default)', async () => {
    const out = await collect(
      synthesizeSurfaceEvents(
        streamOf([
          toolUse('t1', 'canvas_tool'),
          toolResult('t1', CANVAS_TREE_OUTPUT),
        ]),
        cfg([]), // empty allow-set
      ),
    );
    assert.ok(
      !out.some((e) => e.type === 'surface_snapshot'),
      'gate denies an unauthorised tool',
    );
    assert.ok(out.some((e) => e.type === 'tool_result'), 'tool_result still passes through');
  });

  it('passes through a tool result that carries no canvas sentinel', async () => {
    const out = await collect(
      synthesizeSurfaceEvents(
        streamOf([
          toolUse('t1', 'canvas_tool'),
          toolResult('t1', 'just plain text'),
        ]),
        cfg(['canvas_tool']),
      ),
    );
    assert.ok(!out.some((e) => e.type === 'surface_snapshot'));
  });

  it('passes non-tool events through unchanged and in order', async () => {
    const out = await collect(
      synthesizeSurfaceEvents(
        streamOf([
          { type: 'text_delta', text: 'a' } as ChatStreamEvent,
          { type: 'text_delta', text: 'b' } as ChatStreamEvent,
          { type: 'done', answer: 'ab' } as unknown as ChatStreamEvent,
        ]),
        cfg(['x']),
      ),
    );
    assert.deepEqual(
      out.map((e) => e.type),
      ['text_delta', 'text_delta', 'done'],
    );
  });

  it('assigns monotonic surfaceSeq + revision across multiple snapshots', async () => {
    const out = await collect(
      synthesizeSurfaceEvents(
        streamOf([
          toolUse('t1', 'canvas_tool'),
          toolResult('t1', CANVAS_TREE_OUTPUT),
          toolUse('t2', 'canvas_tool'),
          toolResult('t2', CANVAS_TREE_OUTPUT),
        ]),
        cfg(['canvas_tool']),
      ),
    );
    const snaps = out.filter((e) => e.type === 'surface_snapshot');
    assert.equal(snaps.length, 2);
    assert.equal(field(snaps[0] as ChatStreamEvent, 'surfaceSeq'), 0);
    assert.equal(field(snaps[1] as ChatStreamEvent, 'surfaceSeq'), 1);
    assert.equal(field(snaps[0] as ChatStreamEvent, 'producesRevision'), '0');
    assert.equal(field(snaps[1] as ChatStreamEvent, 'producesRevision'), '1');
  });
});

const surfacePatchOutput = JSON.stringify({
  prose: 'approved',
  _pendingSurfacePatch: {
    ops: [
      { id: 'variant-0-review', set: { text: 'Self-Review: ✓ PASS', tone: 'success' } },
      { id: 'd-1-status', set: { text: 'approved' } },
    ],
  },
});

describe('canvasChatAgent surface synthesis — ID-addressed surface patch (9b-3)', () => {
  const baseTree = {
    type: 'container',
    id: 'root',
    children: [
      { type: 'pane', id: 'variant-0', children: [{ type: 'status', id: 'variant-0-review', text: 'Self-Review: ⚠ WARN', tone: 'warning' }] },
      { type: 'status', id: 'd-1-status', text: 'draft' },
    ],
  };

  it('emits a surface_patch that updates nodes by id without a snapshot', async () => {
    const out = await collect(
      synthesizeSurfaceEvents(
        streamOf([toolUse('t1', 'studio_patch'), toolResult('t1', surfacePatchOutput)]),
        { ...cfg(['studio_patch']), baseTree, baseRevision: '0' },
      ),
    );
    const snap = out.find((e) => e.type === 'surface_snapshot');
    assert.ok(!snap, 'no snapshot — patch only');
    const patch = out.find((e) => e.type === 'surface_patch');
    assert.ok(patch, 'surface_patch emitted');
    assert.equal(field(patch, 'basedOnRevision'), '0');
    const patches = field(patch, 'patches') as Array<{ op: string; path: string; value: unknown }>;
    // both ids resolved to their JSON-Pointer paths and fields set
    const byPath = Object.fromEntries(patches.map((p) => [p.path, p.value]));
    assert.equal(byPath['/children/0/children/0/text'], 'Self-Review: ✓ PASS');
    assert.equal(byPath['/children/0/children/0/tone'], 'success');
    assert.equal(byPath['/children/1/text'], 'approved');
  });

  it('skips unmappable ids and emits nothing when none resolve', async () => {
    const out = await collect(
      synthesizeSurfaceEvents(
        streamOf([
          toolUse('t1', 'studio_patch'),
          toolResult('t1', JSON.stringify({ prose: 'x', _pendingSurfacePatch: { ops: [{ id: 'ghost', set: { text: 'y' } }] } })),
        ]),
        { ...cfg(['studio_patch']), baseTree, baseRevision: '0' },
      ),
    );
    assert.ok(!out.some((e) => e.type === 'surface_patch'), 'no patch for unmappable id');
  });

  it('does not patch when the tool is not authorised', async () => {
    const out = await collect(
      synthesizeSurfaceEvents(
        streamOf([toolUse('t1', 'studio_patch'), toolResult('t1', surfacePatchOutput)]),
        { ...cfg([]), baseTree, baseRevision: '0' },
      ),
    );
    assert.ok(!out.some((e) => e.type === 'surface_patch'));
  });
});
