/**
 * Writes the memory-access world (`world.ts`) into real stores: one knowledge
 * graph per tenant, one `/memories` store per tenant, and optionally a
 * process-memory store per tenant (Neon only; the in-memory graph has none).
 *
 * The seed decides WHERE an item lives, never WHO may see it: the verdict is
 * `oracle.ts`'s alone. Where production code dictates a location (a context
 * tier's key, a members tier's key), the seed asks the same helper the binder
 * uses, so the item sits where a real turn would have written it.
 *
 * `readBack` reads each item straight from its store, with no viewer, so a
 * suite can check its positive control: the canary really is in the store.
 */
import { memoryContextKey } from '@omadia/channel-sdk';
import { contextTierRoot, membersTierKey, membersTierRoot } from '@omadia/orchestrator';
import type { KnowledgeGraph, MemoryStore, ProcessMemoryService } from '@omadia/plugin-api';

import {
  AGENTS,
  NATIVE_CONVERSATION,
  TEAMS_TEAM_ID,
  USERS,
  graphScope,
  presentIn,
  type Item,
  type MkItem,
  type ScratchItem,
  type TenantKey,
  type TurnItem,
  type World,
} from './world.js';

export interface TenantStores {
  readonly graph: KnowledgeGraph;
  readonly memory: MemoryStore;
  readonly processes?: ProcessMemoryService;
}

/** Writes a vector for a graph node (in-memory: `setEmbedding`; Neon: SQL). */
export type Embed = (tenant: TenantKey, externalId: string) => Promise<void>;

export interface Seeded {
  readonly world: World;
  readonly stores: Readonly<Record<TenantKey, TenantStores>>;
  /** canary → where it was written (node id, dataset id, file path, …). */
  readonly location: ReadonlyMap<string, string>;
  /** Items the stores could not take (process memory on the in-memory graph). */
  readonly skipped: readonly Item[];
}

const TIME_BASE = Date.UTC(2026, 9, 1, 8, 0, 0);
const time = (n: number): string => new Date(TIME_BASE + n * 1000).toISOString();

const ids = (owners: readonly (keyof typeof USERS)[]): string[] => owners.map((u) => USERS[u]);

/** Path of a scratch item. Tier keys come from the binder's own helpers. */
export function scratchPath(s: ScratchItem): string {
  const file = `${s.canary.toLowerCase()}.md`;
  const slug = s.agent === 'none' ? '' : AGENTS[s.agent];
  switch (s.tier) {
    case 'core':
      return `/memories/core/${file}`;
    case 'rules':
      return `/memories/_rules/${file}`;
    case 'agent':
      return `/memories/orchestrators/${slug}/${file}`;
    case 'transcript':
      return `/memories/sessions/${graphScope(s.agent as 'atlas', s.context!, s.sender!)}/2026-10-01.md`;
    case 'chat-session':
      return `/memories/chat-sessions/${graphScope('legacy', s.context!, s.sender!)}/${file}`;
    case 'context-user':
      return `${contextTierRoot(slug, 'user', memoryContextKey('teams', USERS.alice))}/${file}`;
    case 'context-channel':
      return `${contextTierRoot(slug, 'channel', memoryContextKey('teams', NATIVE_CONVERSATION[s.context as 'room1']))}/${file}`;
    case 'context-team':
      return `${contextTierRoot(slug, 'team', memoryContextKey('teams', TEAMS_TEAM_ID))}/${file}`;
    case 'members':
      return `${membersTierRoot(slug, membersTierKey(ids(s.owners!)))}/${file}`;
  }
}

export async function seedWorld(
  world: World,
  stores: Readonly<Record<TenantKey, TenantStores>>,
  embed: Embed,
): Promise<Seeded> {
  const location = new Map<string, string>();
  const skipped: Item[] = [];
  const turnIds = new Map<TurnItem, string>();
  const mkIds = new Map<MkItem, string>();
  let clock = 0;

  // Turns first: entities, plans and derived memories point at them.
  const entitiesByTurn = new Map<TurnItem, string>();
  for (const e of world.byStore.entity) entitiesByTurn.set(e.capturedBy, e.canary);
  for (const t of world.byStore.turn) {
    const entity = entitiesByTurn.get(t);
    const res = await stores[t.tenant].graph.ingestTurn({
      scope: graphScope(t.agent, t.context, t.sender),
      time: time(clock++),
      userMessage: `Notiz ${t.canary}`,
      assistantAnswer: 'Notiert.',
      entityRefs: entity
        ? [
            {
              system: 'odoo',
              model: 'res.partner',
              id: 7000 + clock,
              displayName: entity,
              op: 'read',
            },
          ]
        : [],
      userId: USERS[t.sender],
      unprotected: t.unprotected,
      ...(t.tailOnly ? { tailOnly: true } : {}),
      ...(t.owners === 'present' ? { owners: ids(presentIn(t.context, t.sender)).sort() } : {}),
      ...(t.owners === 'none' ? { owners: [] } : {}),
    });
    turnIds.set(t, res.turnId);
    location.set(t.canary, res.turnId);
    if (entity) location.set(entity, res.turnId);
    await embed(t.tenant, res.turnId);
  }

  const unprotectedTurn = (tenant: TenantKey): string =>
    turnIds.get(
      world.byStore.turn.find((t) => t.tenant === tenant && t.unprotected && !t.tailOnly)!,
    )!;

  const excerptOf = new Map(world.byStore.excerpt.map((e) => [e.parent, e.canary]));
  for (const mk of world.byStore['memorable-knowledge']) {
    const owners = mk.owners === 'absent' ? undefined : ids(mk.owners);
    const creator = owners?.[0] ?? USERS.alice;
    const excerpt = excerptOf.get(mk)!;
    const res = await stores[mk.tenant].graph.createMemorableKnowledge({
      kind: 'reference',
      summary: `Wissen ${mk.canary}`,
      createdBy: mk.authorship === 'operator' ? `web:${USERS.alice}` : `auto:${creator}`,
      ...(owners ? { aclOwners: owners } : {}),
      ...(mk.visibility === 'absent' ? {} : { visibility: mk.visibility }),
      ...(mk.originAgent === 'none' ? {} : { originAgent: AGENTS[mk.originAgent] }),
      ...(mk.authorship === 'conversation' ? {} : { manuallyAuthored: true }),
      ...(mk.provenance === 'stamped-unprotected' ? { unprotected: true } : {}),
      ...(mk.provenance === 'derived-from-unprotected-turn'
        ? { derivedFromTurnIds: [unprotectedTurn(mk.tenant)] }
        : {}),
      palaiaExcerpts: { texts: [`Auszug ${excerpt}`], source: 'llm' },
    });
    const id = res.memorableKnowledgeNodeId;
    mkIds.set(mk, id);
    location.set(mk.canary, id);
    location.set(excerpt, id);
    await embed(mk.tenant, id);
    for (const ex of await stores[mk.tenant].graph.listExcerptsForMemory(id))
      await embed(mk.tenant, ex.id);
  }

  for (const p of world.byStore.plan) {
    const match = (unprotected: boolean) =>
      world.byStore.turn.find(
        (t) =>
          t.tenant === p.tenant &&
          t.agent === p.agent &&
          t.context === p.context &&
          t.sender === p.sender &&
          t.unprotected === unprotected &&
          !t.tailOnly,
      )!;
    const turn = p.turn === 'orphan' ? undefined : turnIds.get(match(p.turn === 'unprotected'));
    const planId = `ma-plan-${p.canary.toLowerCase()}`;
    const res = await stores[p.tenant].graph.ingestPlan({
      planId,
      scope: graphScope(p.agent, p.context, p.sender),
      ...(turn ? { turnExternalId: turn } : {}),
      userId: USERS[p.sender],
      strategy: `Plan ${p.canary}`,
      createdBy: 'manual',
      createdAt: time(clock++),
    });
    location.set(p.canary, res.planExternalId);
  }

  for (const s of world.byStore.scratch) {
    const path = scratchPath(s);
    const memory = stores[s.tenant].memory;
    // Several transcript turns may share one day file; append like the logger does.
    if (await memory.fileExists(path)) {
      await memory.writeFile(path, `${await memory.readFile(path)}\n${s.canary}\n`);
    } else {
      await memory.createFile(path, `${s.canary}\n`);
    }
    location.set(s.canary, path);
  }

  for (const d of world.byStore.dataset) {
    const res = await stores[d.tenant].graph.ingestDataset({
      ownerOmadiaUserId: USERS[d.owner],
      name: `Tabelle ${d.canary}`,
      sourceFileName: `${d.canary.toLowerCase()}.csv`,
      columns: [{ name: 'note', type: 'string' }],
      rows: [{ note: d.canary }],
    });
    location.set(d.canary, res.datasetId);
  }

  for (const p of world.byStore.process) {
    const processes = stores[p.tenant].processes;
    if (!processes) {
      skipped.push(p);
      continue;
    }
    const res = await processes.write({
      title: `Ablauf ${p.canary}: Schritte`,
      steps: [`Schritt ${p.canary}`],
      scope: graphScope(p.agent, p.context, p.sender),
      unprotected: p.unprotected,
    });
    if (!res.ok) throw new Error(`process ${p.canary} not written: ${res.reason}`);
    location.set(p.canary, res.record.id);
  }

  for (const t of world.byStore.topic) {
    const res = await stores[t.tenant].graph.createTopic({
      name: `Thema ${t.canary}`,
      description: `Gruppe ${t.canary}`,
      namingSource: 'fallback',
      memberMkIds: t.members.map((m) => mkIds.get(m)!),
    });
    location.set(t.canary, res.id);
  }

  return { world, stores, location, skipped };
}

/**
 * The text an item's store holds for it, read without a viewer (dataset reads
 * need one, so its owner is used). `undefined` = the item is not there.
 */
export async function readBack(seeded: Seeded, item: Item): Promise<string | undefined> {
  const { graph, memory, processes } = seeded.stores[item.tenant];
  const at = seeded.location.get(item.canary);
  if (at === undefined) return undefined;
  switch (item.store) {
    case 'turn':
    case 'entity': {
      const t = item.store === 'turn' ? item : item.capturedBy;
      const session = await graph.getSession(graphScope(t.agent, t.context, t.sender));
      return JSON.stringify(session?.turns ?? []);
    }
    case 'memorable-knowledge':
      return JSON.stringify((await graph.getMemorableKnowledge(at))?.props ?? null);
    case 'excerpt':
      return JSON.stringify(await graph.listExcerptsForMemory(at));
    case 'plan':
      return JSON.stringify((await graph.getPlan(at))?.props ?? null);
    case 'scratch':
      return (await memory.fileExists(at)) ? memory.readFile(at) : undefined;
    case 'dataset': {
      const rows = await graph.queryDatasetRows(at, USERS[item.owner]);
      const summary = await graph.getDataset(at, USERS[item.owner]);
      return JSON.stringify({ summary, rows });
    }
    case 'process':
      return JSON.stringify((await processes?.get(at)) ?? null);
    case 'topic':
      return JSON.stringify(await graph.getTopic(at));
  }
}
