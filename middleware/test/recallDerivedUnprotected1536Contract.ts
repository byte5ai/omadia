/**
 * #1536 — content derived from an unprotected turn stays out of recall under
 * a Privacy Shield: the backend contract for memory, excerpt and plan recall
 * with `excludeUnprotected`. Shared by `recallDerivedUnprotected1536.test.ts`
 * (in-memory graph) and `recallDerivedUnprotected1536.pg.test.ts` (Neon), the
 * same pattern as memoryStoreConformance.ts. `setup` returns `undefined` when
 * the backend is unavailable; each case then skips itself.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { KnowledgeGraph, TurnIngest } from '@omadia/plugin-api';

export const VIEWER = '15361536-0000-4000-8000-000000001536';
export const VECTOR = Array.from({ length: 768 }, (_, i) => (i % 7) / 7 + 0.01);

function turn(scope: string, minute: number, unprotected: boolean | undefined): TurnIngest {
  return {
    scope,
    time: `2026-10-28T09:${String(minute).padStart(2, '0')}:00.000Z`,
    userMessage: 'Wer leitet das Projekt Lilium?',
    assistantAnswer: 'Marc Demo leitet es.',
    entityRefs: [],
    ...(unprotected !== undefined ? { unprotected } : {}),
  };
}

export interface Seeded {
  readonly kg: KnowledgeGraph;
  readonly mk: { readonly fromOpen: string; readonly fromGuarded: string; readonly stamped: string };
}

export type Embed = (externalId: string) => Promise<void>;

export async function seed(kg: KnowledgeGraph, embed: Embed): Promise<Seeded> {
  const open = await kg.ingestTurn(turn('s-open', 1, true));
  const guarded = await kg.ingestTurn(turn('s-guarded', 2, false));
  const legacy = await kg.ingestTurn(turn('s-legacy', 3, undefined));
  const memory = async (
    summary: string,
    extra: { derivedFromTurnIds?: string[]; unprotected?: boolean },
  ): Promise<string> => {
    const res = await kg.createMemorableKnowledge({
      kind: 'reference',
      summary,
      createdBy: `web:${VIEWER}`,
      aclOwners: [VIEWER],
      palaiaExcerpts: { texts: [`${summary} (Auszug)`], source: 'llm' },
      ...extra,
    });
    await embed(res.memorableKnowledgeNodeId);
    for (const ex of await kg.listExcerptsForMemory(res.memorableKnowledgeNodeId)) {
      await embed(ex.id);
    }
    return res.memorableKnowledgeNodeId;
  };
  const mk = {
    fromOpen: await memory('Marc Demo leitet Lilium', { derivedFromTurnIds: [open.turnId] }),
    fromGuarded: await memory('Lilium hat eine Leitung', { derivedFromTurnIds: [guarded.turnId] }),
    stamped: await memory('MCP crm · get_contact: Anita Oliver', { unprotected: true }),
  };
  // Plans: one per turn kind, one never linked to a turn (provenance unknown).
  const plan = async (id: string, turnExternalId?: string): Promise<void> => {
    await kg.ingestPlan({
      planId: id,
      scope: `scope-${id}`,
      ...(turnExternalId ? { turnExternalId } : {}),
      strategy: `Lilium ${id}`,
      createdAt: `2026-10-28T09:0${id.length}:00.000Z`,
    });
  };
  await plan('p-open', open.turnId);
  await plan('p-guarded', guarded.turnId);
  await plan('p-legacy', legacy.turnId);
  await plan('p-orphan');
  return { kg, mk };
}

export function runContract(label: string, setup: () => Promise<Seeded | undefined>): void {
  describe(`#1536 derived recall · ${label}`, () => {
    it('memory search under a shield skips MK derived from or stamped unprotected', async (t) => {
      const s = await setup();
      if (!s) return t.skip('no test database');
      const search = (excludeUnprotected: boolean) =>
        s.kg.searchMemorableKnowledgeByEmbedding({
          queryEmbedding: VECTOR,
          viewerOmadiaUserId: VIEWER,
          minSimilarity: 0,
          limit: 10,
          excludeUnprotected,
        });
      assert.equal((await search(false)).length, 3, 'without the option recall is unchanged');
      assert.deepEqual(
        (await search(true)).map((h) => h.mk.id),
        [s.mk.fromGuarded],
      );
    });

    it('excerpt search follows its parent MK', async (t) => {
      const s = await setup();
      if (!s) return t.skip('no test database');
      const search = (excludeUnprotected: boolean) =>
        s.kg.searchExcerptsByEmbedding({
          queryEmbedding: VECTOR,
          viewerOmadiaUserId: VIEWER,
          minSimilarity: 0,
          limit: 10,
          excludeUnprotected,
        });
      assert.equal((await search(false)).length, 3);
      assert.deepEqual(
        (await search(true)).map((h) => h.parentMkId),
        [s.mk.fromGuarded],
      );
    });

    it('plan recall under a shield keeps only plans of a known, protected turn', async (t) => {
      const s = await setup();
      if (!s) return t.skip('no test database');
      const ids = async (excludeUnprotected: boolean): Promise<string[]> =>
        (await s.kg.listRecentPlans({ limit: 10, excludeUnprotected }))
          .map((p) => String(p.props['planId']))
          .sort();
      assert.deepEqual(await ids(false), ['p-guarded', 'p-legacy', 'p-open', 'p-orphan']);
      // A turn stored before the flag existed counts as protected, as in the
      // turn legs; a plan with no turn has unknown provenance and is dropped.
      assert.deepEqual(await ids(true), ['p-guarded', 'p-legacy']);
    });
  });
}
