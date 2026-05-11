import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';

import { DraftStore } from '../../src/plugins/builder/draftStore.js';
import type {
  PreviewHandle,
  PreviewToolDescriptor,
} from '../../src/plugins/builder/previewRuntime.js';
import { RuntimeSmokeOrchestrator } from '../../src/plugins/builder/runtimeSmokeOrchestrator.js';
import { SpecEventBus, type SpecBusEvent } from '../../src/plugins/builder/specEventBus.js';

function makeTool(
  id: string,
  run: (input: unknown) => Promise<unknown>,
): PreviewToolDescriptor {
  return { id, description: `tool-${id}`, input: z.unknown(), run };
}

function makeHandle(
  rev: number,
  tools: ReadonlyArray<PreviewToolDescriptor>,
): PreviewHandle {
  return {
    draftId: 'd-1',
    agentId: 'de.byte5.agent.test',
    rev,
    toolkit: { tools },
    previewDir: '/tmp/preview-stub',
    routeCaptures: [],
    close: async () => undefined,
  };
}

const fixtureSpec = {
  template: 'agent-integration',
  id: 'de.byte5.agent.test',
  name: 'Test',
  version: '0.1.0',
  description: 'fixture',
  category: 'analysis',
  depends_on: [],
  tools: [{ id: 'noop', description: 'a', input: { type: 'object' } }],
  skill: { role: 'tester' },
  setup_fields: [],
  playbook: { when_to_use: 't', not_for: [], example_prompts: [] },
  network: { outbound: [] },
  slots: {},
};

describe('RuntimeSmokeOrchestrator.attemptSmoke', () => {
  let tmp: string;
  let dbPath: string;
  let store: DraftStore;
  let bus: SpecEventBus;
  let userEmail: string;
  let draftId: string;
  let events: SpecBusEvent[];

  beforeEach(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'smoke-orch-'));
    dbPath = path.join(tmp, 'drafts.db');
    store = new DraftStore({ dbPath });
    await store.open();
    userEmail = 'tester@example.com';
    const draft = await store.create(userEmail, 'fixture');
    draftId = draft.id;
    await store.update(userEmail, draftId, {
      spec: fixtureSpec as never,
    });
    bus = new SpecEventBus();
    events = [];
    bus.subscribe(draftId, (e) => events.push(e));
  });

  afterEach(async () => {
    await store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('emits running synchronously and ok asynchronously after invocations finish', async () => {
    const orchestrator = new RuntimeSmokeOrchestrator({ draftStore: store, bus });
    const handle = makeHandle(1, [makeTool('noop', async () => 'done')]);
    orchestrator.attemptSmoke({ handle, userEmail, draftId });

    // 'running' must be visible immediately (sync emit).
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, 'runtime_smoke_status');
    if (events[0]?.type === 'runtime_smoke_status') {
      assert.equal(events[0].phase, 'running');
      assert.equal(events[0].buildN, 1);
    }

    // Drain microtasks until the terminal event arrives.
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(events.length, 2);
    if (events[1]?.type === 'runtime_smoke_status') {
      assert.equal(events[1].phase, 'ok');
      assert.equal(events[1].reason, 'ok');
      assert.equal(events[1].results?.length, 1);
    }
  });

  it('dedups by (draftId, rev) — second attempt at same rev is a no-op', async () => {
    const orchestrator = new RuntimeSmokeOrchestrator({ draftStore: store, bus });
    const handle = makeHandle(7, [makeTool('noop', async () => 'done')]);
    orchestrator.attemptSmoke({ handle, userEmail, draftId });
    orchestrator.attemptSmoke({ handle, userEmail, draftId });
    await new Promise((r) => setTimeout(r, 30));
    const runningEvents = events.filter(
      (e) => e.type === 'runtime_smoke_status' && e.phase === 'running',
    );
    assert.equal(runningEvents.length, 1, 'only one smoke run for the same rev');
  });

  it('runs again when rev advances', async () => {
    const orchestrator = new RuntimeSmokeOrchestrator({ draftStore: store, bus });
    orchestrator.attemptSmoke({
      handle: makeHandle(1, [makeTool('noop', async () => 'done')]),
      userEmail,
      draftId,
    });
    await new Promise((r) => setTimeout(r, 30));
    orchestrator.attemptSmoke({
      handle: makeHandle(2, [makeTool('noop', async () => 'done')]),
      userEmail,
      draftId,
    });
    await new Promise((r) => setTimeout(r, 30));
    const runningEvents = events.filter(
      (e) => e.type === 'runtime_smoke_status' && e.phase === 'running',
    );
    assert.equal(runningEvents.length, 2);
  });

  it('emits failed with reason=tool_failures when a tool throws', async () => {
    const orchestrator = new RuntimeSmokeOrchestrator({ draftStore: store, bus });
    orchestrator.attemptSmoke({
      handle: makeHandle(1, [
        makeTool('boom', async () => {
          throw new Error('upstream API died');
        }),
      ]),
      userEmail,
      draftId,
    });
    await new Promise((r) => setTimeout(r, 30));
    const terminal = events.find(
      (e) => e.type === 'runtime_smoke_status' && e.phase !== 'running',
    );
    assert.ok(terminal);
    if (terminal?.type === 'runtime_smoke_status') {
      assert.equal(terminal.phase, 'failed');
      assert.equal(terminal.reason, 'tool_failures');
      assert.equal(terminal.results?.[0]?.status, 'threw');
    }
  });

  it('emits failed with reason=activate_failed when the draft is missing', async () => {
    const orchestrator = new RuntimeSmokeOrchestrator({ draftStore: store, bus });
    // Use a different draftId that doesn't exist in the store.
    bus.subscribe('ghost-draft', (e) => events.push(e));
    orchestrator.attemptSmoke({
      handle: makeHandle(1, [makeTool('noop', async () => 'ok')]),
      userEmail,
      draftId: 'ghost-draft',
    });
    await new Promise((r) => setTimeout(r, 30));
    const terminal = events.find(
      (e) => e.type === 'runtime_smoke_status' && e.phase === 'failed',
    );
    assert.ok(terminal);
    if (terminal?.type === 'runtime_smoke_status') {
      assert.equal(terminal.reason, 'activate_failed');
      assert.match(terminal.activateError ?? '', /not found/);
    }
  });
});
