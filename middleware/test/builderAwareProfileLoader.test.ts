import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { DraftStore } from '../src/plugins/builder/draftStore.js';
import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';
import { makeBuilderAwareProfileLoader } from '../src/profileSnapshots/builderAwareProfileLoader.js';
import type {
  AgentMdRecord,
  KnowledgeFileRecord,
  KnowledgeFileSummary,
  LiveProfileStorageService,
} from '../src/profileStorage/liveProfileStorageService.js';

/**
 * Phase 2.2.5 fix — the snapshot's profileLoader must distinguish
 * Builder-Drafts (snapshot the agent alone, empty pluginPins) from
 * Bootstrap-Profiles (legacy registry-wide pins). The bug we're
 * pinning down here was that EVERY snapshot carried the whole
 * installed-plugin set, which broke `vendorPlugins: true` whenever
 * a built-in plugin was installed and surfaced an architecturally
 * wrong "snapshot of my whole environment" UX.
 */

interface StorageStubState {
  agentMd: Map<string, Buffer>;
  knowledge: Map<string, Map<string, Buffer>>; // profileId → filename → bytes
}

function makeStorageStub(state: StorageStubState): LiveProfileStorageService {
  const stub = {
    async getAgentMd(profileId: string): Promise<AgentMdRecord | null> {
      const buf = state.agentMd.get(profileId);
      if (!buf) return null;
      return {
        content: buf,
        sha256: 'stub',
        sizeBytes: buf.byteLength,
        updatedAt: new Date(),
        updatedBy: 'op@example.com',
      };
    },
    async listKnowledge(profileId: string): Promise<KnowledgeFileSummary[]> {
      const files = state.knowledge.get(profileId);
      if (!files) return [];
      return [...files.entries()].map(([filename, content]) => ({
        filename,
        sha256: 'stub',
        sizeBytes: content.byteLength,
        updatedAt: new Date(),
      }));
    },
    async getKnowledgeFile(
      profileId: string,
      filename: string,
    ): Promise<KnowledgeFileRecord | null> {
      const buf = state.knowledge.get(profileId)?.get(filename);
      if (!buf) return null;
      return {
        filename,
        content: buf,
        sha256: 'stub',
        sizeBytes: buf.byteLength,
        updatedAt: new Date(),
        updatedBy: 'op@example.com',
      };
    },
    async getLiveProfileBundle(input: {
      profileId: string;
      profileName: string;
    }) {
      // Bootstrap-fallback path — registry-wide pins; the test seeds the
      // registry below.
      return {
        profileId: input.profileId,
        profileName: input.profileName,
        profileVersion: '1.0.0',
        agentMd: state.agentMd.get(input.profileId) ?? Buffer.alloc(0),
        pluginPins: [
          { id: 'de.byte5.agent.calendar', version: '0.1.0' },
          { id: '@omadia/agent-reference-maximum', version: '0.1.0' },
        ],
        knowledge: [],
      };
    },
  } as unknown as LiveProfileStorageService;
  return stub;
}

describe('makeBuilderAwareProfileLoader', () => {
  let tmpDir: string;
  let draftStore: DraftStore;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'loader-test-'));
    draftStore = new DraftStore({ dbPath: join(tmpDir, 'drafts.db') });
    await draftStore.open();
  });

  afterEach(async () => {
    await draftStore.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('Builder-Draft path returns empty pluginPins (the fix)', async () => {
    const draft = await draftStore.create('op@example.com', 'My Bot');
    const state: StorageStubState = {
      agentMd: new Map([[draft.id, Buffer.from('# my bot\n', 'utf8')]]),
      knowledge: new Map(),
    };
    const storage = makeStorageStub(state);
    const registry = new InMemoryInstalledRegistry();
    const loader = makeBuilderAwareProfileLoader({
      liveProfileStorage: storage,
      draftStore,
      installedRegistry: registry,
    });

    const live = await loader(draft.id);
    assert.equal(live.profileId, draft.id);
    assert.equal(live.profileName, 'My Bot');
    assert.equal(live.agentMd.toString('utf8'), '# my bot\n');
    assert.deepEqual(
      live.pluginPins,
      [],
      'Builder-Draft snapshot must NOT include the installed-plugin set as pins',
    );
  });

  it('Builder-Draft path includes spec.json plus user knowledge files', async () => {
    const draft = await draftStore.create('op@example.com', 'Doc Bot');
    const knowledge = new Map<string, Buffer>([
      ['style.md', Buffer.from('Be concise.', 'utf8')],
    ]);
    const state: StorageStubState = {
      agentMd: new Map([[draft.id, Buffer.from('# bot\n', 'utf8')]]),
      knowledge: new Map([[draft.id, knowledge]]),
    };
    const loader = makeBuilderAwareProfileLoader({
      liveProfileStorage: makeStorageStub(state),
      draftStore,
      installedRegistry: new InMemoryInstalledRegistry(),
    });

    const live = await loader(draft.id);
    // spec.json is always first; user knowledge follows
    assert.equal(live.knowledge.length, 2);
    assert.equal(live.knowledge[0]!.filename, 'spec.json');
    const parsedSpec = JSON.parse(live.knowledge[0]!.content.toString('utf8'));
    assert.equal(parsedSpec.id, draft.spec.id);
    assert.equal(live.knowledge[1]!.filename, 'style.md');
    assert.equal(
      live.knowledge[1]!.content.toString('utf8'),
      'Be concise.',
    );
  });

  it('Builder-Draft path renders agent.md inline when no mirror exists yet', async () => {
    // Brand new draft, operator never typed anything, immediately
    // clicks "Snapshot erstellen" — the bridge mirror hook hasn't
    // fired, so profile_agent_md is empty. Loader must produce the
    // bytes from spec on the fly so the snapshot isn't empty.
    const draft = await draftStore.create('op@example.com', 'Fresh Bot');
    const state: StorageStubState = {
      agentMd: new Map(), // ← intentionally empty
      knowledge: new Map(),
    };
    const loader = makeBuilderAwareProfileLoader({
      liveProfileStorage: makeStorageStub(state),
      draftStore,
      installedRegistry: new InMemoryInstalledRegistry(),
    });

    const live = await loader(draft.id);
    assert.ok(
      live.agentMd.byteLength > 0,
      'agent.md must not be 0 bytes when mirror is empty — render inline from spec',
    );
    const text = live.agentMd.toString('utf8');
    assert.ok(text.startsWith('---\n'), 'inline render produces frontmatter');
    assert.ok(text.includes('display_name: Fresh Bot'));
  });

  it('Builder-Draft path filters out a stale mirrored spec.json so the inline one wins', async () => {
    // If a previous import wrote `spec.json` into profile_knowledge_file,
    // the loader strips it out and re-inserts the current draft.spec
    // version. Otherwise rollback would resurrect the old spec.
    const draft = await draftStore.create('op@example.com', 'Bot');
    const knowledge = new Map<string, Buffer>([
      ['spec.json', Buffer.from('{"id":"stale"}', 'utf8')],
      ['readme.md', Buffer.from('hi', 'utf8')],
    ]);
    const state: StorageStubState = {
      agentMd: new Map([[draft.id, Buffer.from('x', 'utf8')]]),
      knowledge: new Map([[draft.id, knowledge]]),
    };
    const loader = makeBuilderAwareProfileLoader({
      liveProfileStorage: makeStorageStub(state),
      draftStore,
      installedRegistry: new InMemoryInstalledRegistry(),
    });

    const live = await loader(draft.id);
    const specEntry = live.knowledge.find((k) => k.filename === 'spec.json');
    assert.ok(specEntry);
    const parsed = JSON.parse(specEntry!.content.toString('utf8'));
    assert.notEqual(parsed.id, 'stale', 'must not surface a stale mirrored spec.json');
    // user knowledge still rides along
    assert.ok(live.knowledge.find((k) => k.filename === 'readme.md'));
  });

  it('Bootstrap-Profile fallback returns the registry-wide pins (legacy)', async () => {
    // No draft created → loader hits the bootstrap path which delegates
    // to LiveProfileStorageService.getLiveProfileBundle — our stub
    // returns the calendar + reference plugins.
    const state: StorageStubState = {
      agentMd: new Map(),
      knowledge: new Map(),
    };
    const loader = makeBuilderAwareProfileLoader({
      liveProfileStorage: makeStorageStub(state),
      draftStore,
      installedRegistry: new InMemoryInstalledRegistry(),
    });

    const live = await loader('production');
    assert.equal(live.pluginPins.length, 2);
    assert.equal(live.pluginPins[0]!.id, 'de.byte5.agent.calendar');
  });

  it('soft-deleted draft falls back to bootstrap path', async () => {
    const draft = await draftStore.create('op@example.com', 'Stale Bot');
    await draftStore.softDelete('op@example.com', draft.id);
    const state: StorageStubState = {
      agentMd: new Map(),
      knowledge: new Map(),
    };
    const loader = makeBuilderAwareProfileLoader({
      liveProfileStorage: makeStorageStub(state),
      draftStore,
      installedRegistry: new InMemoryInstalledRegistry(),
    });
    const live = await loader(draft.id);
    // Soft-deleted → findById returns null → bootstrap path → registry pins
    assert.ok(live.pluginPins.length > 0);
  });
});
