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
import {
  ChatSessionStore,
  contextTierRoot,
  membersTierKey,
  membersTierRoot,
} from '@omadia/orchestrator';
import type { KnowledgeGraph, MemoryStore, ProcessMemoryService } from '@omadia/plugin-api';

import {
  AGENTS,
  AGENT_KEYS,
  CONTEXT_KEYS,
  USER_KEYS,
  MK_OWNER_SETS,
  MK_VISIBILITIES,
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
  type UserKey,
  type World,
  turnKeyword,
} from './world.js';

export interface TenantStores {
  readonly graph: KnowledgeGraph;
  readonly memory: MemoryStore;
  readonly processes?: ProcessMemoryService;
}

/** Writes a vector for a graph node (in-memory: `setEmbedding`; Neon: SQL). */
export type Embed = (
  tenant: TenantKey,
  externalId: string,
  vector: readonly number[],
) => Promise<void>;

/** Vector width of the Neon embedding columns (migration 0005). */
export const EMBEDDING_DIM = 768;

/**
 * Search groups. Read paths cap results at 50, so every memory and excerpt is
 * embedded on the one-hot axis of its (owners × visibility) group: a query on
 * that axis with `minSimilarity` 0.5 returns that group and nothing else
 * (≤ 27 items). Turns sit on the axis of their conversation keyword.
 */
export function mkGroup(mk: Pick<MkItem, 'owners' | 'visibility'>): number {
  return (
    MK_OWNER_SETS.findIndex((o) => JSON.stringify(o) === JSON.stringify(mk.owners)) *
      MK_VISIBILITIES.length +
    MK_VISIBILITIES.indexOf(mk.visibility)
  );
}
export const MK_GROUP_COUNT = MK_OWNER_SETS.length * MK_VISIBILITIES.length;

export function axis(index: number): number[] {
  const v = Array.from({ length: EMBEDDING_DIM }, () => 0);
  v[index] = 1;
  return v;
}

const TURN_AXIS_BASE = 100;
function turnAxis(t: TurnItem): number {
  const agent = [...AGENT_KEYS, 'legacy'].indexOf(t.agent);
  return (
    TURN_AXIS_BASE +
    (agent * CONTEXT_KEYS.length + CONTEXT_KEYS.indexOf(t.context)) * USER_KEYS.length +
    USER_KEYS.indexOf(t.sender)
  );
}

/** The vector a turn search for `t`'s conversation uses. */
export function turnQueryVector(t: Pick<TurnItem, 'agent' | 'context' | 'sender'>): number[] {
  return axis(turnAxis(t as TurnItem));
}

/** omadia user ids, minted per store: tenant → person → cluster id. */
export type UserIds = Readonly<Record<TenantKey, Readonly<Record<UserKey, string>>>>;

export interface Seeded {
  readonly world: World;
  /**
   * Each person's omadia user id in each store, minted by identity
   * resolution like a real login or channel message. `USERS` holds their
   * Teams (AAD) ids, the channel side.
   */
  readonly users: UserIds;
  readonly stores: Readonly<Record<TenantKey, TenantStores>>;
  /** canary → where it was written (node id, dataset id, file path, …). */
  readonly location: ReadonlyMap<string, string>;
  /** Items the stores could not take (process memory on the in-memory graph). */
  readonly skipped: readonly Item[];
}

const TIME_BASE = Date.UTC(2026, 9, 1, 8, 0, 0);
const time = (n: number): string => new Date(TIME_BASE + n * 1000).toISOString();


/** Path of a scratch item. Tier keys come from the binder's own helpers. */
/** A web chat tab's id (`ChatSessionStore`): the canary, lower-cased. */
export function chatSessionId(s: ScratchItem): string {
  return s.canary.toLowerCase();
}

export function scratchPath(s: ScratchItem, users: UserIds): string {
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
      return `/memories/chat-sessions/${chatSessionId(s)}.json`;
    case 'context-user':
      return `${contextTierRoot(slug, 'user', memoryContextKey('teams', USERS.alice))}/${file}`;
    case 'context-channel':
      return `${contextTierRoot(slug, 'channel', memoryContextKey('teams', NATIVE_CONVERSATION[s.context as 'room1']))}/${file}`;
    case 'context-team':
      return `${contextTierRoot(slug, 'team', memoryContextKey('teams', TEAMS_TEAM_ID))}/${file}`;
    case 'members':
      return `${membersTierRoot(slug, membersTierKey(s.owners!.map((u) => users[s.tenant][u])))}/${file}`;
  }
}

export async function seedWorld(
  world: World,
  stores: Readonly<Record<TenantKey, TenantStores>>,
  embed: Embed,
): Promise<Seeded> {
  const location = new Map<string, string>();
  const skipped: Item[] = [];

  // People first: one user cluster per person and store, through the same
  // identity resolution a Teams message runs.
  const users = {} as Record<TenantKey, Record<UserKey, string>>;
  for (const tenant of ['main', 'other'] as const) {
    users[tenant] = {} as Record<UserKey, string>;
    for (const u of USER_KEYS) {
      const res = await stores[tenant].graph.resolveOrCreateChannelIdentity({
        channelKind: 'teams',
        channelUserId: USERS[u],
        aadObjectId: USERS[u],
        displayName: u,
      });
      users[tenant][u] = res.omadiaUserId;
    }
  }
  const ids = (tenant: TenantKey, owners: readonly UserKey[]): string[] =>
    owners.map((u) => users[tenant][u]);
  /**
   * The `userId` a turn of `sender` carries: the session's omadia id on the
   * web, the raw channel id on Teams (orchestratorDispatcher: "`userId` stays
   * the raw channel-native id").
   */
  const turnUserId = (tenant: TenantKey, context: string, sender: UserKey): string =>
    context === 'web' ? users[tenant][sender] : USERS[sender];
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
      userMessage: `Notiz ${t.canary} ${turnKeyword(t)}`,
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
      userId: turnUserId(t.tenant, t.context, t.sender),
      unprotected: t.unprotected,
      ...(t.tailOnly ? { tailOnly: true } : {}),
      ...(t.owners === 'present'
        ? { owners: ids(t.tenant, presentIn(t.context, t.sender)).sort() }
        : {}),
      ...(t.owners === 'none' ? { owners: [] } : {}),
    });
    turnIds.set(t, res.turnId);
    // The run trace links the turn to its sender's cluster (BELONGS_TO).
    const at = time(clock++);
    await stores[t.tenant].graph.ingestRun({
      turnId: res.turnId,
      scope: graphScope(t.agent, t.context, t.sender),
      userId: users[t.tenant][t.sender],
      startedAt: at,
      finishedAt: at,
      durationMs: 1,
      status: 'success',
      iterations: 1,
      orchestratorToolCalls: [],
      agentInvocations: [],
    });
    location.set(t.canary, res.turnId);
    if (entity) location.set(entity, res.turnId);
    await embed(t.tenant, res.turnId, axis(turnAxis(t)));
  }

  const unprotectedTurn = (tenant: TenantKey): string =>
    turnIds.get(
      world.byStore.turn.find((t) => t.tenant === tenant && t.unprotected && !t.tailOnly)!,
    )!;

  const excerptOf = new Map(world.byStore.excerpt.map((e) => [e.parent, e.canary]));
  for (const mk of world.byStore['memorable-knowledge']) {
    // Production stores both id forms: a memory promoted out of a Teams turn
    // is owned by the raw channel id (`aclOwners: [input.userId]`), one from
    // the web or a members room by cluster ids. Each owner is listed in both,
    // so every read path finds the person in the form it uses.
    const owners =
      mk.owners === 'absent' ? undefined : [...ids(mk.tenant, mk.owners), ...mk.owners.map((u) => USERS[u])];
    const involved = mk.owners === 'absent' ? [] : ids(mk.tenant, mk.owners);
    const creator = owners?.[0] ?? users[mk.tenant].alice;
    const excerpt = excerptOf.get(mk)!;
    const res = await stores[mk.tenant].graph.createMemorableKnowledge({
      kind: 'reference',
      summary: `Wissen ${mk.canary}`,
      createdBy: mk.authorship === 'operator' ? `web:${users[mk.tenant].alice}` : `auto:${creator}`,
      // Promotion and the memory API name the owners as involved, too.
      ...(owners ? { aclOwners: owners, involvedOmadiaUserIds: involved } : {}),
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
    await embed(mk.tenant, id, axis(mkGroup(mk)));
    for (const ex of await stores[mk.tenant].graph.listExcerptsForMemory(id)) {
      await embed(mk.tenant, ex.id, axis(mkGroup(mk)));
    }
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
      userId: turnUserId(p.tenant, p.context, p.sender),
      strategy: `Plan ${p.canary}`,
      createdBy: 'manual',
      createdAt: time(clock++),
    });
    location.set(p.canary, res.planExternalId);
  }

  for (const s of world.byStore.scratch) {
    const path = scratchPath(s, users);
    const memory = stores[s.tenant].memory;
    if (s.tier === 'chat-session') {
      // A web chat tab, stored the way the web UI's store writes it.
      const at = TIME_BASE + clock++ * 1000;
      await new ChatSessionStore(memory).save({
        id: chatSessionId(s),
        title: `Chat ${s.canary}`,
        createdAt: at,
        updatedAt: at,
        messages: [{ id: 'm1', role: 'user', content: `Notiz ${s.canary}`, startedAt: at }],
        // #1762 — the account that chats in it owns it (the session's `sub`).
        ...(s.sender ? { ownerUserId: users[s.tenant][s.sender] } : {}),
      });
      location.set(s.canary, path);
      continue;
    }
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
      ownerOmadiaUserId: users[d.tenant][d.owner],
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

  return { world, users, stores, location, skipped };
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
      const owner = seeded.users[item.tenant][item.owner];
      const rows = await graph.queryDatasetRows(at, owner);
      const summary = await graph.getDataset(at, owner);
      return JSON.stringify({ summary, rows });
    }
    case 'process':
      return JSON.stringify((await processes?.get(at)) ?? null);
    case 'topic':
      return JSON.stringify(await graph.getTopic(at));
  }
}
