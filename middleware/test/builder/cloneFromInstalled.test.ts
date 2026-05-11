import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DraftStore } from '../../src/plugins/builder/draftStore.js';
import { DraftQuota } from '../../src/plugins/builder/draftQuota.js';
import {
  cloneFromInstalled,
  bumpPatchVersion,
} from '../../src/plugins/builder/cloneFromInstalled.js';

interface Harness {
  store: DraftStore;
  quota: DraftQuota;
  tmpRoot: string;
  close: () => Promise<void>;
}

async function makeHarness(opts: { quotaCap?: number } = {}): Promise<Harness> {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), 'clone-from-installed-'));
  const dbPath = path.join(tmpRoot, 'drafts.db');
  const store = new DraftStore({ dbPath });
  await store.open();
  const cap = opts.quotaCap ?? 50;
  const quota = new DraftQuota({ store, cap, warnAt: Math.min(40, cap) });
  return {
    store,
    quota,
    tmpRoot,
    async close() {
      await store.close();
      rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}

async function makeInstalledSource(
  store: DraftStore,
  userEmail: string,
  agentId: string,
  overrides: Partial<{
    name: string;
    spec: Record<string, unknown>;
    slots: Record<string, string>;
    codegenModel: 'haiku' | 'sonnet' | 'opus';
    previewModel: 'haiku' | 'sonnet' | 'opus';
    transcript: { role: 'user' | 'assistant'; content: string; timestamp: number }[];
  }> = {},
): Promise<string> {
  const draft = await store.create(userEmail, overrides.name ?? 'Source Agent');
  const spec = overrides.spec ?? {
    template: 'agent-integration',
    id: agentId,
    version: '0.1.0',
    name: overrides.name ?? 'Source Agent',
    description: 'cloned-from-installed fixture',
    category: 'analysis',
    depends_on: ['de.byte5.integration.openweather'],
    tools: [],
    skill: { role: 'tester' },
    setup_fields: [],
    playbook: { when_to_use: 'tests', not_for: [], example_prompts: [] },
    network: { outbound: ['api.example.com'] },
    slots: {},
  };
  await store.update(userEmail, draft.id, {
    spec: spec as never,
    slots: overrides.slots ?? { 'skill-prompt': '# Source Skill' },
    status: 'installed',
    installedAgentId: agentId,
    codegenModel: overrides.codegenModel ?? 'opus',
    previewModel: overrides.previewModel ?? 'haiku',
    transcript: overrides.transcript ?? [
      { role: 'user', content: 'hi', timestamp: Date.now() },
    ],
  });
  return draft.id;
}

describe('cloneFromInstalled (B.6-3)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('clones spec + slots + model preferences from the source draft into a fresh draft', async () => {
    const sourceId = await makeInstalledSource(
      h.store,
      'alice@example.com',
      'de.byte5.agent.foo',
    );

    const result = await cloneFromInstalled(
      { userEmail: 'alice@example.com', installedAgentId: 'de.byte5.agent.foo' },
      { draftStore: h.store, quota: h.quota, log: () => {} },
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.installedAgentId, 'de.byte5.agent.foo');
    assert.equal(result.sourceDraftId, sourceId);
    assert.notEqual(result.draftId, sourceId);

    const fresh = await h.store.load('alice@example.com', result.draftId);
    assert.ok(fresh);
    assert.equal(fresh.status, 'draft');
    assert.equal(fresh.installedAgentId, null);
    assert.equal(fresh.spec.id, 'de.byte5.agent.foo');
    // Theme C: clone auto-bumps the patch version so re-install does
    // not collide with the already-installed package.duplicate_version.
    // Source was '0.1.0' → cloned draft is '0.1.1'.
    assert.equal(fresh.spec.version, '0.1.1');
    assert.deepEqual(fresh.slots, { 'skill-prompt': '# Source Skill' });
    assert.equal(fresh.codegenModel, 'opus');
    assert.equal(fresh.previewModel, 'haiku');
    // Transcripts intentionally NOT cloned.
    assert.deepEqual(fresh.transcript, []);
    assert.deepEqual(fresh.previewTranscript, []);
  });

  it('source untouched after clone (Edit-from-Store keeps the installed plugin live)', async () => {
    const sourceId = await makeInstalledSource(
      h.store,
      'alice@example.com',
      'de.byte5.agent.foo',
    );
    await cloneFromInstalled(
      { userEmail: 'alice@example.com', installedAgentId: 'de.byte5.agent.foo' },
      { draftStore: h.store, quota: h.quota, log: () => {} },
    );
    const source = await h.store.load('alice@example.com', sourceId);
    assert.ok(source);
    assert.equal(source.status, 'installed');
    assert.equal(source.installedAgentId, 'de.byte5.agent.foo');
    // Source transcript preserved.
    assert.equal(source.transcript.length, 1);
  });

  it('cloned draft name appends " (Kopie)" the first time', async () => {
    await makeInstalledSource(h.store, 'alice@example.com', 'de.byte5.agent.foo', {
      name: 'Weather Forecast',
    });
    const result = await cloneFromInstalled(
      { userEmail: 'alice@example.com', installedAgentId: 'de.byte5.agent.foo' },
      { draftStore: h.store, quota: h.quota, log: () => {} },
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const fresh = await h.store.load('alice@example.com', result.draftId);
    assert.equal(fresh?.name, 'Weather Forecast (Kopie)');
  });

  it('cloned draft name bumps " (Kopie N)" on re-clone', async () => {
    // Source already named with " (Kopie 2)" — clone should produce "(Kopie 3)".
    const draft = await h.store.create('alice@example.com', 'Weather (Kopie 2)');
    await h.store.update('alice@example.com', draft.id, {
      spec: {
        template: 'agent-integration',
        id: 'de.byte5.agent.foo',
        version: '0.1.0',
        name: 'Weather (Kopie 2)',
        description: 'fixture',
        category: 'analysis',
      } as never,
      status: 'installed',
      installedAgentId: 'de.byte5.agent.foo',
    });
    const result = await cloneFromInstalled(
      { userEmail: 'alice@example.com', installedAgentId: 'de.byte5.agent.foo' },
      { draftStore: h.store, quota: h.quota, log: () => {} },
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const fresh = await h.store.load('alice@example.com', result.draftId);
    assert.equal(fresh?.name, 'Weather (Kopie 3)');
  });

  it('source_not_found when no draft has installed_agent_id matching agentId', async () => {
    const result = await cloneFromInstalled(
      { userEmail: 'alice@example.com', installedAgentId: 'de.byte5.agent.never' },
      { draftStore: h.store, quota: h.quota, log: () => {} },
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'source_not_found');
    assert.equal(result.code, 'builder.source_draft_not_found');
  });

  it('source_not_found is owner-scoped — Bob cannot clone Alice\'s installed plugin', async () => {
    await makeInstalledSource(h.store, 'alice@example.com', 'de.byte5.agent.foo');
    const result = await cloneFromInstalled(
      { userEmail: 'bob@example.com', installedAgentId: 'de.byte5.agent.foo' },
      { draftStore: h.store, quota: h.quota, log: () => {} },
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'source_not_found');
  });

  it('quota_exceeded when user is at the draft cap', async () => {
    await h.close();
    h = await makeHarness({ quotaCap: 1 });
    await makeInstalledSource(h.store, 'alice@example.com', 'de.byte5.agent.foo');
    // Source draft itself counts against the quota; cap=1 → already at cap.
    const result = await cloneFromInstalled(
      { userEmail: 'alice@example.com', installedAgentId: 'de.byte5.agent.foo' },
      { draftStore: h.store, quota: h.quota, log: () => {} },
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'quota_exceeded');
    assert.equal(result.code, 'quota.exceeded');
    const details = result.details as { quota?: { used?: number; cap?: number } };
    assert.ok(details?.quota);
    assert.equal(details.quota.cap, 1);
  });

  it('multiple Edit-from-Store rounds are stable (clone of clone)', async () => {
    await makeInstalledSource(
      h.store,
      'alice@example.com',
      'de.byte5.agent.foo',
      { name: 'Iter 1' },
    );
    const r1 = await cloneFromInstalled(
      { userEmail: 'alice@example.com', installedAgentId: 'de.byte5.agent.foo' },
      { draftStore: h.store, quota: h.quota, log: () => {} },
    );
    assert.equal(r1.ok, true);
    if (!r1.ok) return;
    // The clone has no installed_agent_id, so a second clone request still
    // resolves to the original installed source draft.
    const r2 = await cloneFromInstalled(
      { userEmail: 'alice@example.com', installedAgentId: 'de.byte5.agent.foo' },
      { draftStore: h.store, quota: h.quota, log: () => {} },
    );
    assert.equal(r2.ok, true);
    if (!r2.ok) return;
    assert.notEqual(r1.draftId, r2.draftId);
    assert.equal(r1.sourceDraftId, r2.sourceDraftId);
  });

  // ── Theme C: auto-bump patch version on clone ────────────────────────

  it('clone of a clone bumps the patch version a second time', async () => {
    // Install at 0.1.0, clone → 0.1.1. Pretend that clone got
    // installed too (simulate by setting status='installed' +
    // installedAgentId), then clone again. Expected: 0.1.2.
    await makeInstalledSource(h.store, 'alice@example.com', 'de.byte5.agent.foo');
    const r1 = await cloneFromInstalled(
      { userEmail: 'alice@example.com', installedAgentId: 'de.byte5.agent.foo' },
      { draftStore: h.store, quota: h.quota, log: () => {} },
    );
    assert.equal(r1.ok, true);
    if (!r1.ok) return;
    const fresh1 = await h.store.load('alice@example.com', r1.draftId);
    assert.equal(fresh1?.spec.version, '0.1.1');

    // Promote the clone to "installed" so it becomes the source for the
    // next round. Simulates the operator finishing the edit-cycle.
    await h.store.update('alice@example.com', r1.draftId, {
      status: 'installed',
      installedAgentId: 'de.byte5.agent.foo.v2',
    });

    const r2 = await cloneFromInstalled(
      {
        userEmail: 'alice@example.com',
        installedAgentId: 'de.byte5.agent.foo.v2',
      },
      { draftStore: h.store, quota: h.quota, log: () => {} },
    );
    assert.equal(r2.ok, true);
    if (!r2.ok) return;
    const fresh2 = await h.store.load('alice@example.com', r2.draftId);
    assert.equal(fresh2?.spec.version, '0.1.2');
  });
});

describe('bumpPatchVersion', () => {
  it('increments the patch segment', () => {
    assert.equal(bumpPatchVersion('0.1.0'), '0.1.1');
    assert.equal(bumpPatchVersion('1.2.3'), '1.2.4');
    assert.equal(bumpPatchVersion('0.0.0'), '0.0.1');
    assert.equal(bumpPatchVersion('10.20.30'), '10.20.31');
  });

  it('strips prerelease tags before bumping', () => {
    assert.equal(bumpPatchVersion('1.2.3-alpha'), '1.2.4');
    assert.equal(bumpPatchVersion('1.2.3-alpha.4'), '1.2.4');
    assert.equal(bumpPatchVersion('0.1.0-rc.1'), '0.1.1');
  });

  it('returns the input unchanged for non-semver input', () => {
    // Defensive: caller (install validation) decides how to surface
    // malformed versions. We do NOT silently fix garbage.
    assert.equal(bumpPatchVersion(''), '');
    assert.equal(bumpPatchVersion('not-a-version'), 'not-a-version');
    assert.equal(bumpPatchVersion('1.2'), '1.2');
    assert.equal(bumpPatchVersion('1.2.x'), '1.2.x');
  });
});
