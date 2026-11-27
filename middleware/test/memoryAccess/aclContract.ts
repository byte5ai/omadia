/**
 * ACL contract for memorable knowledge and excerpts (memory-ACL plan, step 2).
 * Backend-agnostic, same pattern as memoryStoreConformance.ts: run by
 * `aclContract.test.ts` (in-memory graph) and `aclContract.pg.test.ts` (Neon).
 *
 * For every viewer and context-memory mode, the search is called with the
 * options a turn of that mode passes to the store:
 *
 *   off / enforce, and every context-free turn:
 *     viewer ACL + teamVisibility (setting) + viewerAgentSlug
 *   enforce-strict, context-bound:
 *     viewer ACL + sharedOnly (#575 floor, C) + viewerAgentSlug
 *   members, context-bound:
 *     audienceOwners = everyone present (H "Modus members") + viewerAgentSlug
 *   any turn under a Privacy Shield: + excludeUnprotected (S #1507/#1536)
 *
 * The result set must equal the oracle's allowed set, item for item: a
 * forbidden canary is a leak, a missing allowed one is a broken read. Each
 * query covers one embedding group (owners × visibility), so the 50-row cap
 * of the read paths never hides a row.
 */
import { strict as assert } from 'node:assert';
import { it } from 'node:test';

import type { ExcerptSearchOptions, MemorableKnowledgeSearchOptions } from '@omadia/plugin-api';

import {
  DEFAULT_SETTINGS,
  MODES,
  expected,
  isContextBound,
  type Mode,
  type Settings,
} from './oracle.js';
import { MK_GROUP_COUNT, axis, mkGroup, type Seeded, type UserIds } from './seed.js';
import { AGENTS, allViewers, presentIn, viewerId, type Viewer } from './world.js';

type SearchOptions = Omit<
  MemorableKnowledgeSearchOptions,
  'queryEmbedding' | 'limit' | 'minSimilarity'
>;

/** The store options a turn of `v` in `mode` passes. */
export function turnSearchOptions(
  v: Viewer,
  mode: Mode,
  settings: Settings,
  users: UserIds,
): SearchOptions {
  const bound = isContextBound(v, mode);
  const base = {
    viewerOmadiaUserId: users[v.tenant][v.user],
    viewerAgentSlug: AGENTS[v.agent],
    ...(v.shielded ? { excludeUnprotected: true } : {}),
  };
  if (bound && mode === 'members') {
    return {
      ...base,
      audienceOwners: presentIn(v.context, v.user)
        .map((u) => users[v.tenant][u])
        .sort(),
    };
  }
  if (bound && mode === 'enforce-strict') return { ...base, sharedOnly: true };
  return { ...base, teamVisibility: settings.teamVisibility };
}

export const CANARY = /CANARY-[A-Z]+-\d{5}Z/g;
export const canariesIn = (text: string): string[] => text.match(CANARY) ?? [];

interface Mismatch {
  readonly viewer: string;
  readonly mode: Mode;
  readonly canary: string;
  readonly kind: 'leak' | 'missing';
  readonly why: string;
}

function report(count: number, mismatches: readonly Mismatch[]): string {
  const leaks = mismatches.filter((m) => m.kind === 'leak').length;
  const lines = mismatches
    .slice(0, 25)
    .map((m) => `  ${m.kind} ${m.canary} · ${m.viewer} · ${m.mode} · oracle: ${m.why}`);
  return `${count} mismatch(es); first ${mismatches.length} sampled, ${leaks} of them leaks:\n${lines.join('\n')}`;
}

/**
 * Viewers worth querying: every main-tenant viewer, plus one from the other
 * tenant (it reads its own graph, so a main canary there is a tenant leak).
 */
export function contractViewers(): Viewer[] {
  const all = allViewers();
  return [
    ...all.filter((v) => v.tenant === 'main'),
    ...all.filter(
      (v) => v.tenant === 'other' && v.user === 'alice' && v.context === 'web' && !v.shielded,
    ),
  ];
}

export type ContractStore = 'memorable-knowledge' | 'excerpt';

const LIMIT = 50;
/**
 * Every group's axis is orthogonal to every other, so an item outside the
 * queried groups scores exactly 0 and one inside scores 1/√k for k groups.
 * 0.1 admits every member up to k = 100; the world has 30 groups.
 */
export const MIN_SIMILARITY = 0.1;

function batchVector(groups: readonly number[]): number[] {
  const v = axis(groups[0]!);
  for (const g of groups.slice(1)) v[g] = 1;
  return v;
}

async function search(
  seeded: Seeded,
  v: Viewer,
  store: ContractStore,
  options: SearchOptions,
  groups: readonly number[],
): Promise<{ canaries: string[]; full: boolean }> {
  const graph = seeded.stores[v.tenant].graph;
  const query = {
    ...options,
    queryEmbedding: batchVector(groups),
    minSimilarity: MIN_SIMILARITY,
    limit: LIMIT,
  };
  const hits =
    store === 'memorable-knowledge'
      ? (await graph.searchMemorableKnowledgeByEmbedding(query)).map((h) => h.mk.props)
      : (await graph.searchExcerptsByEmbedding(query as ExcerptSearchOptions)).map(
          (h) => h.excerpt.props,
        );
  return { canaries: canariesIn(JSON.stringify(hits)), full: hits.length >= LIMIT };
}

/**
 * Every canary `options` admits in `groups`. A result that fills the cap may
 * be truncated, so the groups are split in half and asked again; a single
 * group (≤ 27 items) never reaches the cap.
 */
export async function admittedIn(
  seeded: Seeded,
  v: Viewer,
  store: ContractStore,
  options: SearchOptions,
  groups: readonly number[],
): Promise<Set<string>> {
  const res = await search(seeded, v, store, options, groups);
  if (!res.full) return new Set(res.canaries);
  assert.ok(
    groups.length > 1,
    `group ${groups[0]} alone fills the ${LIMIT}-row cap; the world outgrew its groups`,
  );
  const mid = Math.ceil(groups.length / 2);
  const left = await admittedIn(seeded, v, store, options, groups.slice(0, mid));
  const right = await admittedIn(seeded, v, store, options, groups.slice(mid));
  return new Set([...left, ...right]);
}

/** Rows a planned batch is expected to return; leaves room below the cap. */
const PLAN_ROWS = 40;

/**
 * Every canary `options` admits, in as few queries as the cap allows. The
 * oracle's expected count per group only PLANS the batches: if the store
 * returns more than expected, the batch fills the cap and is split again, so
 * a leak cannot hide behind the plan.
 */
async function admitted(
  seeded: Seeded,
  v: Viewer,
  store: ContractStore,
  options: SearchOptions,
  expectedPerGroup: readonly number[],
): Promise<Set<string>> {
  const out = new Set<string>();
  let batch: number[] = [];
  let rows = 0;
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    for (const c of await admittedIn(seeded, v, store, options, batch)) out.add(c);
    batch = [];
    rows = 0;
  };
  for (let g = 0; g < MK_GROUP_COUNT; g++) {
    if (rows + expectedPerGroup[g]! > PLAN_ROWS) await flush();
    batch.push(g);
    rows += expectedPerGroup[g]!;
  }
  await flush();
  return out;
}

export function runAclContract(
  label: string,
  store: ContractStore,
  setup: () => Promise<Seeded | undefined>,
  settings: Settings = DEFAULT_SETTINGS,
): void {
  it(`memory ACL contract · ${label} · ${store} · teamVisibility=${String(settings.teamVisibility)}: every viewer × mode gets exactly the oracle's set`, async (t) => {
    const seeded = await setup();
    if (!seeded) return t.skip('no test database');
    const mismatches: Mismatch[] = [];
    let mismatchCount = 0;
    let allowedSeen = 0;
    // A badly broken predicate yields thousands; keep a readable sample.
    const record = (m: Mismatch): void => {
      mismatchCount++;
      if (mismatches.length < 200) mismatches.push(m);
    };
    const items = {
      main: seeded.world.byStore[store].filter((i) => i.tenant === 'main'),
      other: seeded.world.byStore[store].filter((i) => i.tenant === 'other'),
    };
    const canaries = {
      main: new Set(items.main.map((i) => i.canary)),
      other: new Set(items.other.map((i) => i.canary)),
    };

    // Identical option sets (e.g. off and enforce) are queried once.
    const cache = new Map<string, Set<string>>();
    for (const v of contractViewers()) {
      for (const mode of MODES) {
        const options = turnSearchOptions(v, mode, settings, seeded.users);
        const key = JSON.stringify([v.tenant, options]);
        let got = cache.get(key);
        if (!got) {
          const perGroup = Array.from({ length: MK_GROUP_COUNT }, () => 0);
          for (const item of items[v.tenant]) {
            if (expected(v, mode, item, settings).allowed)
              perGroup[mkGroup(item.store === 'excerpt' ? item.parent : item)]!++;
          }
          got = await admitted(seeded, v, store, options, perGroup);
          cache.set(key, got);
        }
        for (const item of items[v.tenant]) {
          const verdict = expected(v, mode, item, settings);
          const present = got.has(item.canary);
          if (verdict.allowed && present) allowedSeen++;
          if (verdict.allowed !== present) {
            record({
              viewer: viewerId(v),
              mode,
              canary: item.canary,
              kind: present ? 'leak' : 'missing',
              why: verdict.source,
            });
          }
        }
        // A canary of the other tenant can never be in this tenant's graph.
        for (const c of got) {
          if (!canaries[v.tenant].has(c)) {
            record({
              viewer: viewerId(v),
              mode,
              canary: c,
              kind: 'leak',
              why: 'not an item of this tenant',
            });
          }
        }
      }
    }
    // Positive control: an empty store would make every leak check pass.
    assert.ok(allowedSeen > 0, 'no allowed item was ever returned');
    assert.equal(mismatchCount, 0, report(mismatchCount, mismatches));
  });
}

/**
 * An empty audience is not an audience and matches nothing (PA
 * `ownersCoverAudience`: "an empty audience is not an audience and matches
 * nothing"). No turn sends one today (a members turn with an unknown audience
 * skips recall), so this guards the store contract itself.
 *
 * `knownDivergence`: the backend is known to break the rule. The case still
 * runs and reports, as a `todo`, so it neither blocks CI nor disappears; it
 * passes the day the backend is fixed, and the marker is then removed.
 */
export function runEmptyAudienceContract(
  label: string,
  setup: () => Promise<Seeded | undefined>,
  knownDivergence?: string,
): void {
  it(
    `memory ACL contract · ${label} · an empty audience matches nothing`,
    knownDivergence ? { todo: `known divergence: ${knownDivergence}` } : {},
    async (t) => {
      const seeded = await setup();
      if (!seeded) return t.skip('no test database');
      const graph = seeded.stores.main.graph;
      const query = {
        queryEmbedding: batchVector(Array.from({ length: MK_GROUP_COUNT }, (_, i) => i)),
        viewerOmadiaUserId: seeded.users.main.alice,
        audienceOwners: [] as string[],
        minSimilarity: MIN_SIMILARITY,
        limit: LIMIT,
      };
      // Positive control: the same query with a real audience returns rows.
      const control = await graph.searchMemorableKnowledgeByEmbedding({
        ...query,
        audienceOwners: [seeded.users.main.alice],
      });
      assert.ok(control.length > 0, 'the control audience got nothing back');
      const mk = canariesIn(
        JSON.stringify(
          (await graph.searchMemorableKnowledgeByEmbedding(query)).map((h) => h.mk.props),
        ),
      );
      const ex = canariesIn(
        JSON.stringify((await graph.searchExcerptsByEmbedding(query)).map((h) => h.excerpt.props)),
      );
      assert.deepEqual({ mk, ex }, { mk: [], ex: [] });
    },
  );
}
