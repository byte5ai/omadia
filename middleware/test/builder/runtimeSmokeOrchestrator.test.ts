import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DraftStore } from '../../src/plugins/builder/draftStore.js';
import type {
  PreviewActivateOptions,
  PreviewHandle,
  PreviewToolDescriptor,
} from '../../src/plugins/builder/previewRuntime.js';
import { RuntimeSmokeOrchestrator } from '../../src/plugins/builder/runtimeSmokeOrchestrator.js';
import { SpecEventBus, type SpecBusEvent } from '../../src/plugins/builder/specEventBus.js';

function makeTool(
  id: string,
  run: (input: unknown) => Promise<unknown>,
): PreviewToolDescriptor {
  return {
    id,
    description: `tool-${id}`,
    inputSchema: { type: 'object', properties: {} },
    run: async (input) => {
      const out = await run(input);
      return typeof out === 'string' ? out : JSON.stringify(out);
    },
  };
}

/** Handles the orchestrator's stub activation returns, by rev. */
const handlesByRev = new Map<number, PreviewHandle>();
const activations: PreviewActivateOptions[] = [];
async function activate(opts: PreviewActivateOptions): Promise<PreviewHandle> {
  activations.push(opts);
  const handle = handlesByRev.get(opts.rev);
  if (!handle) throw new Error(`no stub handle for rev ${String(opts.rev)}`);
  return handle;
}

function makeHandle(
  rev: number,
  tools: ReadonlyArray<PreviewToolDescriptor>,
): PreviewHandle {
  const handle = {
    draftId: 'd-1',
    agentId: 'de.byte5.agent.test',
    rev,
    toolkit: { tools },
    previewDir: '/tmp/preview-stub',
    routeCaptures: [],
    close: async () => undefined,
  } as unknown as PreviewHandle;
  handlesByRev.set(rev, handle);
  return handle;
}

const ZIP = Buffer.from('PK-fake');

/** Registers the stub handle; contributes nothing to the smoke target. */
function registered(_handle: PreviewHandle): Record<string, never> {
  return {};
}

const fixtureSpec = {
  template: 'integration',
  id: 'de.byte5.agent.test',
  name: 'Test',
  version: '0.1.0',
  description: 'fixture',
  category: 'analysis',
  depends_on: [],
  tools: [{ id: 'noop', description: 'a', input: { type: 'object' } }],
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
    const orchestrator = new RuntimeSmokeOrchestrator({ draftStore: store, bus, activate });
    const handle = makeHandle(1, [makeTool('noop', async () => 'done')]);
    orchestrator.attemptSmoke({ rev: handle.rev, zipBuffer: ZIP, userEmail, draftId });

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

  it('retains the last smoke outcome for get_build_status pull (Issue #227)', async () => {
    const orchestrator = new RuntimeSmokeOrchestrator({ draftStore: store, bus, activate });
    // No smoke yet → no snapshot.
    assert.equal(orchestrator.getLastSmokeStatus(draftId), undefined);

    const handle = makeHandle(3, [makeTool('noop', async () => 'done')]);
    orchestrator.attemptSmoke({ rev: handle.rev, zipBuffer: ZIP, userEmail, draftId });

    // `running` is retained synchronously (mirrors the sync emit).
    const running = orchestrator.getLastSmokeStatus(draftId);
    assert.equal(running?.phase, 'running');
    assert.equal(running?.buildN, 3);

    await new Promise((r) => setTimeout(r, 30));

    const terminal = orchestrator.getLastSmokeStatus(draftId);
    assert.equal(terminal?.phase, 'ok');
    assert.equal(terminal?.reason, 'ok');
    assert.equal(terminal?.results?.length, 1);
    assert.ok(terminal?.smokedAt);
  });

  it('dedups by (draftId, rev) — second attempt at same rev is a no-op', async () => {
    const orchestrator = new RuntimeSmokeOrchestrator({ draftStore: store, bus, activate });
    const handle = makeHandle(7, [makeTool('noop', async () => 'done')]);
    orchestrator.attemptSmoke({ rev: handle.rev, zipBuffer: ZIP, userEmail, draftId });
    orchestrator.attemptSmoke({ rev: handle.rev, zipBuffer: ZIP, userEmail, draftId });
    await new Promise((r) => setTimeout(r, 30));
    const runningEvents = events.filter(
      (e) => e.type === 'runtime_smoke_status' && e.phase === 'running',
    );
    assert.equal(runningEvents.length, 1, 'only one smoke run for the same rev');
  });

  it('runs again when rev advances', async () => {
    const orchestrator = new RuntimeSmokeOrchestrator({ draftStore: store, bus, activate });
    orchestrator.attemptSmoke({
      rev: 1,
      zipBuffer: ZIP,
      ...registered(makeHandle(1, [makeTool('noop', async () => 'done')])),
      userEmail,
      draftId,
    });
    await new Promise((r) => setTimeout(r, 30));
    orchestrator.attemptSmoke({
      rev: 2,
      zipBuffer: ZIP,
      ...registered(makeHandle(2, [makeTool('noop', async () => 'done')])),
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
    const orchestrator = new RuntimeSmokeOrchestrator({ draftStore: store, bus, activate });
    orchestrator.attemptSmoke({
      rev: 1,
      zipBuffer: ZIP,
      ...registered(makeHandle(1, [
        makeTool('boom', async () => {
          throw new Error('upstream API died');
        }),
      ])),
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
    const orchestrator = new RuntimeSmokeOrchestrator({ draftStore: store, bus, activate });
    // Use a different draftId that doesn't exist in the store.
    bus.subscribe('ghost-draft', (e) => events.push(e));
    orchestrator.attemptSmoke({
      rev: 1,
      zipBuffer: ZIP,
      ...registered(makeHandle(1, [makeTool('noop', async () => 'ok')])),
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

  it('#1778: smokes a stub activation of the build (smokeMode, stub secrets), never the warm handle', async () => {
    await store.update(userEmail, draftId, {
      spec: {
        ...fixtureSpec,
        setup_fields: [{ key: 'api_token', type: 'secret', label: 'Token', required: true }],
      } as never,
    });
    activations.length = 0;
    const orchestrator = new RuntimeSmokeOrchestrator({ draftStore: store, bus, activate });
    const handle = makeHandle(11, [makeTool('noop', async () => 'done')]);
    orchestrator.attemptSmoke({ rev: handle.rev, zipBuffer: ZIP, userEmail, draftId });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(activations.length, 1);
    assert.equal(activations[0]!.smokeMode, true);
    assert.equal(activations[0]!.zipBuffer, ZIP);
    assert.deepEqual(activations[0]!.secretValues, { api_token: 'smoke-test' });
  });

  it('#1778: never calls a tool the spec declares as writing', async () => {
    await store.update(userEmail, draftId, {
      spec: {
        ...fixtureSpec,
        tools: [{ id: 'create_order', description: 'w', input: { type: 'object' }, side_effects: 'write' }],
      } as never,
    });
    let called = false;
    const orchestrator = new RuntimeSmokeOrchestrator({ draftStore: store, bus, activate });
    const handle = makeHandle(12, [
      makeTool('create_order', async () => {
        called = true;
        return 'created';
      }),
    ]);
    orchestrator.attemptSmoke({ rev: handle.rev, zipBuffer: ZIP, userEmail, draftId });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(called, false);
    const terminal = orchestrator.getLastSmokeStatus(draftId);
    assert.equal(terminal?.phase, 'ok');
    assert.equal(terminal?.reason, 'writes_skipped');
    assert.equal(terminal?.results?.[0]?.status, 'skipped');
  });
});
