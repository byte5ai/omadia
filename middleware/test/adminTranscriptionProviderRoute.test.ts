import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  OPENAI_STT,
  OTHER_STT,
  makeHarness,
  type Harness,
} from './adminTranscriptionProvider.harness.js';

/**
 * `/api/v1/admin/transcription-provider` — the live `transcription@1`
 * provider switch (#584 WS T).
 *
 * Auth is NOT exercised inside the router: `requireAuth` is applied at MOUNT
 * time in production (src/index.ts), the same convention every admin router
 * in this tree follows.
 */

let harness: Harness | undefined;

beforeEach(() => {
  harness = undefined;
});

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('GET /api/v1/admin/transcription-provider', () => {
  it('reports installed providers, the active one, and the published service', async () => {
    harness = await makeHarness([
      { id: OPENAI_STT, status: 'active' },
      { id: OTHER_STT, status: 'inactive' },
    ]);
    const { status, body } = await harness.getJson();
    assert.equal(status, 200);
    assert.deepEqual(
      body.providers.map((p) => p.pluginId).sort(),
      [OPENAI_STT, OTHER_STT].sort(),
    );
    assert.equal(body.activeProviderId, OPENAI_STT);
    assert.equal(body.capabilityPublished, true);
    assert.equal(body.activeProvider, 'openai:gpt-transcribe');
  });

  it('an active adapter that publishes nothing reads as capabilityPublished:false', async () => {
    harness = await makeHarness([{ id: OPENAI_STT, status: 'active' }]);
    harness.state.publishedBy = null; // active in the registry, no key in the vault
    const { body } = await harness.getJson();
    assert.equal(body.activeProviderId, OPENAI_STT);
    assert.equal(body.capabilityPublished, false);
    assert.equal(body.activeProvider, null);
  });

  it('a plugin with a malformed provides entry never hides the valid providers', async () => {
    harness = await makeHarness([{ id: OPENAI_STT, status: 'active' }]);
    const { body } = await harness.getJson();
    assert.ok(body.providers.some((p) => p.pluginId === OPENAI_STT));
  });
});

describe('POST /switch', () => {
  it('switches provider: deactivates the current one, activates the target, flips registry status', async () => {
    harness = await makeHarness([
      { id: OPENAI_STT, status: 'active' },
      { id: OTHER_STT, status: 'inactive' },
    ]);
    const { status, body } = await harness.postSwitch({ pluginId: OTHER_STT });
    assert.equal(status, 200);
    assert.equal(body['ok'], true);
    assert.equal(body['switchedTo'], OTHER_STT);
    assert.deepEqual(harness.state.calls, [
      `deactivate:${OPENAI_STT}`,
      `activate:${OTHER_STT}`,
    ]);
    assert.equal(harness.registry.get(OPENAI_STT)?.status, 'inactive');
    assert.equal(harness.registry.get(OTHER_STT)?.status, 'active');
    assert.equal(harness.state.publishedBy, OTHER_STT);
  });

  it('rejects an unknown or non-provider target with 400', async () => {
    harness = await makeHarness([{ id: OPENAI_STT, status: 'active' }]);
    const { status, body } = await harness.postSwitch({
      pluginId: '@omadia/knowledge-graph-neon',
    });
    assert.equal(status, 400);
    assert.equal(body['code'], 'transcriptionProvider.unknown_target');
  });

  it('answers 409 for the already-active provider', async () => {
    harness = await makeHarness([{ id: OPENAI_STT, status: 'active' }]);
    const { status, body } = await harness.postSwitch({ pluginId: OPENAI_STT });
    assert.equal(status, 409);
    assert.equal(body['code'], 'transcriptionProvider.already_active');
  });

  it('rolls back (verified) when the target activates but publishes nothing', async () => {
    harness = await makeHarness([
      { id: OPENAI_STT, status: 'active' },
      { id: OTHER_STT, status: 'inactive' },
    ]);
    harness.state.publishNothing.add(OTHER_STT);
    const { status, body } = await harness.postSwitch({ pluginId: OTHER_STT });
    assert.equal(status, 409);
    assert.equal(body['code'], 'transcriptionProvider.target_unavailable');
    const details = body['details'] as { restoredProviderId?: string | null };
    assert.equal(details.restoredProviderId, OPENAI_STT);
    // The previous provider is live again and the registry agrees.
    assert.equal(harness.state.publishedBy, OPENAI_STT);
    assert.equal(harness.registry.get(OPENAI_STT)?.status, 'active');
    assert.equal(harness.registry.get(OTHER_STT)?.status, 'inactive');
  });

  it('rolls back when activating the target throws', async () => {
    harness = await makeHarness([
      { id: OPENAI_STT, status: 'active' },
      { id: OTHER_STT, status: 'inactive' },
    ]);
    harness.state.failActivation.add(OTHER_STT);
    const { status, body } = await harness.postSwitch({ pluginId: OTHER_STT });
    assert.equal(status, 409);
    assert.equal(body['code'], 'transcriptionProvider.target_unavailable');
    assert.equal(harness.state.publishedBy, OPENAI_STT);
  });

  it('never claims a restore that did not take: rollback failure reports restoredProviderId null', async () => {
    harness = await makeHarness([
      { id: OPENAI_STT, status: 'active' },
      { id: OTHER_STT, status: 'inactive' },
    ]);
    harness.state.publishNothing.add(OTHER_STT);
    // Sabotage the restore too: re-activating the previous provider now
    // publishes nothing either.
    harness.state.publishNothing.add(OPENAI_STT);
    const { status, body } = await harness.postSwitch({ pluginId: OTHER_STT });
    assert.equal(status, 409);
    const details = body['details'] as { restoredProviderId?: string | null };
    assert.equal(details.restoredProviderId, null);
    // Registry must not claim a provider that is not live.
    assert.equal(harness.registry.get(OPENAI_STT)?.status, 'inactive');
    assert.equal(harness.registry.get(OTHER_STT)?.status, 'inactive');
  });

  it('switching TO a provider with no previous active one works', async () => {
    harness = await makeHarness([
      { id: OPENAI_STT, status: 'inactive' },
      { id: OTHER_STT, status: 'inactive' },
    ]);
    const { status, body } = await harness.postSwitch({ pluginId: OPENAI_STT });
    assert.equal(status, 200);
    assert.equal(body['switchedTo'], OPENAI_STT);
    assert.equal(harness.state.publishedBy, OPENAI_STT);
  });

  it('serialises switches: a second POST while one is mid-flight answers 409 switch_in_progress', async () => {
    harness = await makeHarness([
      { id: OPENAI_STT, status: 'active' },
      { id: OTHER_STT, status: 'inactive' },
    ]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    harness.state.activateGate = () => gate;

    const first = harness.postSwitch({ pluginId: OTHER_STT });
    // Wait until the first switch is inside activate() and holding the lock.
    while (!harness.state.calls.includes(`activate:${OTHER_STT}`)) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const second = await harness.postSwitch({ pluginId: OTHER_STT });
    assert.equal(second.status, 409);
    assert.equal(second.body['code'], 'transcriptionProvider.switch_in_progress');

    release();
    const firstResult = await first;
    assert.equal(firstResult.status, 200);
    assert.equal(harness.state.publishedBy, OTHER_STT);
  });

  it('validates the body shape', async () => {
    harness = await makeHarness([{ id: OPENAI_STT, status: 'active' }]);
    const { status, body } = await harness.postSwitch({ nope: true });
    assert.equal(status, 400);
    assert.equal(body['code'], 'transcriptionProvider.invalid_request');
  });
});
