/**
 * Spec 2042 §5.10 / §6 criterion 37 — a Plugin Builder preview runs as a
 * draft agent: an `agents` row with status `draft`, one per Builder draft,
 * removed when the preview closes and swept at boot.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AgentInput, AgentRow, AgentTombstone } from '@omadia/orchestrator';

import {
  PREVIEW_DRAFT_AGENT_SLUG_PREFIX,
  PreviewDraftAgentUnavailableError,
  PreviewDraftAgents,
  isPreviewDraftAgentSlug,
  previewDraftAgentSlug,
  type PreviewDraftAgentStore,
} from '../../src/plugins/builder/previewDraftAgents.js';

function fakeStore(
  initial: AgentRow[] = [],
  tombs: AgentTombstone[] = [],
): PreviewDraftAgentStore & { rows: AgentRow[]; purged: string[] } {
  const rows = [...initial];
  const purged: string[] = [];
  let seq = 0;
  return {
    rows,
    purged,
    listAgents: () => Promise.resolve(rows.filter((r) => !r.slug.startsWith('deleted-'))),
    listTombstones: () => Promise.resolve(tombs),
    getAgentBySlug: (slug: string) => Promise.resolve(rows.find((r) => r.slug === slug)),
    createAgent: (input: AgentInput) => {
      seq += 1;
      const row = {
        id: `a-${String(seq)}`,
        slug: input.slug,
        name: input.name,
        description: input.description ?? null,
        status: input.status ?? 'enabled',
      } as AgentRow;
      rows.push(row);
      return Promise.resolve(row);
    },
    deleteAgent: (id: string) => {
      const row = rows.find((r) => r.id === id);
      if (!row) return Promise.resolve(undefined);
      Object.assign(row, { slug: `deleted-${id}` });
      return Promise.resolve({ id } as AgentTombstone);
    },
    purgeAgent: (id: string) => {
      const t = tombs.findIndex((x) => x.id === id);
      if (t >= 0) {
        tombs.splice(t, 1);
        purged.push(id);
        return Promise.resolve(true);
      }
      const i = rows.findIndex((r) => r.id === id && r.slug.startsWith('deleted-'));
      if (i < 0) return Promise.resolve(false);
      rows.splice(i, 1);
      purged.push(id);
      return Promise.resolve(true);
    },
  };
}

describe('preview draft agents', () => {
  it('a preview creates one draft agent per Builder draft, never an enabled one', async () => {
    const store = fakeStore();
    const agents = new PreviewDraftAgents(() => store);
    const first = await agents.ensure('Draft_42', 'Weather');
    const again = await agents.ensure('Draft_42', 'Weather');
    assert.equal(first.id, again.id, 'reused, not a second row');
    assert.equal(store.rows.length, 1);
    assert.equal(store.rows[0]?.status, 'draft');
    assert.equal(first.slug, `${PREVIEW_DRAFT_AGENT_SLUG_PREFIX}draft-42`);
    assert.equal(first.name, 'Preview: Weather');
  });

  it('removes the draft agent when the preview closes, and only drafts', async () => {
    const store = fakeStore();
    const agents = new PreviewDraftAgents(() => store);
    const ref = await agents.ensure('d1', 'Weather');
    assert.equal(await agents.remove('d1'), true);
    assert.deepEqual(store.purged, [ref.id]);
    assert.equal(await agents.remove('d1'), false, 'nothing left');
  });

  it('the boot sweep removes every preview draft and leaves operator agents alone', async () => {
    const store = fakeStore([
      { id: 'p1', slug: previewDraftAgentSlug('a'), name: 'Preview: A', status: 'draft' } as AgentRow,
      { id: 'p2', slug: previewDraftAgentSlug('b'), name: 'Preview: B', status: 'draft' } as AgentRow,
      { id: 'op', slug: 'mira', name: 'Mira', status: 'draft' } as AgentRow,
      // A slug squatter that is not a draft is never removed.
      { id: 'live', slug: previewDraftAgentSlug('c'), name: 'Live', status: 'enabled' } as AgentRow,
    ]);
    const agents = new PreviewDraftAgents(() => store);
    assert.equal(await agents.sweep(), 2);
    assert.deepEqual(store.purged.sort(), ['p1', 'p2']);
    assert.deepEqual(store.rows.map((r) => r.id).sort(), ['live', 'op']);
  });

  it('fails loud instead of running a preview without a draft agent', async () => {
    await assert.rejects(
      () => new PreviewDraftAgents(() => undefined).ensure('d1', 'Weather'),
      PreviewDraftAgentUnavailableError,
    );
    const squatted = fakeStore([
      { id: 'live', slug: previewDraftAgentSlug('d1'), name: 'Live', status: 'enabled' } as AgentRow,
    ]);
    await assert.rejects(
      () => new PreviewDraftAgents(() => squatted).ensure('d1', 'Weather'),
      /not a preview draft/,
    );
  });

  it('the sweep also finishes a removal whose purge failed (a tombstone of a preview draft)', async () => {
    const store = fakeStore(
      [],
      [
        { id: 'stuck', slug: previewDraftAgentSlug('a'), deletedBy: 'plugin-builder-preview' } as AgentTombstone,
        { id: 'operator', slug: 'mira', deletedBy: 'anna@example.com' } as AgentTombstone,
      ],
    );
    assert.equal(await new PreviewDraftAgents(() => store).sweep(), 1);
    assert.deepEqual(store.purged, ['stuck']);
  });

  it('without a store at boot, the first preview sweeps first; a racing create reuses the row', async () => {
    let store: ReturnType<typeof fakeStore> | undefined;
    const agents = new PreviewDraftAgents(() => store);
    assert.equal(await agents.sweep(), 0, 'deferred');
    store = fakeStore([{ id: 'old', slug: previewDraftAgentSlug('x'), name: 'Preview: X', status: 'draft' } as AgentRow]);
    const ref = await agents.ensure('y', 'Weather');
    assert.deepEqual(store.purged, ['old'], 'the stale draft from before is gone');
    assert.equal(ref.slug, previewDraftAgentSlug('y'));

    // Another first turn created the row between our read and our create.
    const raced = fakeStore();
    const createAgent = raced.createAgent.bind(raced);
    raced.createAgent = async (input) => {
      await createAgent(input);
      throw new Error('duplicate key value violates unique constraint');
    };
    const winner = await new PreviewDraftAgents(() => raced).ensure('z', 'Weather');
    assert.equal(winner.slug, previewDraftAgentSlug('z'));
  });

  it('recognises its slugs', () => {
    assert.equal(isPreviewDraftAgentSlug(previewDraftAgentSlug('x')), true);
    assert.equal(isPreviewDraftAgentSlug('mira'), false);
    assert.ok(previewDraftAgentSlug('x'.repeat(200)).length <= 64);
  });
});
