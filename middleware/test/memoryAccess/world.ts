/**
 * The memory-access world: one fixed set of people, agents, conversations and
 * memory items, each item carrying a canary string found nowhere else. The
 * oracle (`oracle.ts`) says which viewer may see which item; `seed.ts` writes
 * the items into a real store. Later suites read through every entry point and
 * check that a forbidden canary never comes back and an allowed one does.
 *
 * Nothing here is derived from production code. Ids and paths are spelled
 * out; where the seed must place an item where production code expects it
 * (a context tier's key), `seed.ts` computes the place, never the verdict.
 */

export type TenantKey = 'main' | 'other';
export const TENANTS: Readonly<Record<TenantKey, string>> = {
  main: 'memory-access-main',
  other: 'memory-access-other',
};

export type UserKey = 'alice' | 'bob' | 'carol';
export const USER_KEYS: readonly UserKey[] = ['alice', 'bob', 'carol'];
/** Canonical omadia user ids (cluster roots; `acl_owners` validates uuids). */
export const USERS: Readonly<Record<UserKey, string>> = {
  alice: 'a11ce000-0000-4000-8000-0000000a11ce',
  bob: 'b0b00000-0000-4000-8000-000000000b0b',
  carol: 'ca401000-0000-4000-8000-00000ca401ca',
};

export type AgentKey = 'atlas' | 'boreas';
export const AGENT_KEYS: readonly AgentKey[] = ['atlas', 'boreas'];
/** Agent slugs. Graph scopes are `<slug>::<conversation>`. */
export const AGENTS: Readonly<Record<AgentKey, string>> = {
  atlas: 'ma-atlas',
  boreas: 'ma-boreas',
};

/**
 * Where a turn happens.
 *
 *  - `dm`: Alice's 1:1 chat with the agent on Teams (personal scope, user tier).
 *  - `room1`, `room2`: two Teams channels of the SAME team, with different
 *    members. Each has its own channel tier; they share the team tier.
 *  - `web`: a web chat turn. Since #1774 (ADR-0182) it carries the signed-in
 *    account's origin (`webAccountOrigin`): a one-person room per user, its
 *    own `user` tier under enforce/strict and a one-person audience under
 *    members. Each user has their own web conversation.
 */
export type ContextKey = 'dm' | 'room1' | 'room2' | 'web';
export const CONTEXT_KEYS: readonly ContextKey[] = ['dm', 'room1', 'room2', 'web'];

export interface ContextDef {
  readonly key: ContextKey;
  readonly kind: 'personal' | 'group' | 'account' | 'context-free';
  /** Who is present. `web` is one person: whoever sends the turn. */
  readonly members: readonly UserKey[] | 'sender';
}

export const TEAMS_TEAM_ID = '19:ma-team-alpha@thread.tacv2';
export const CONTEXTS: Readonly<Record<ContextKey, ContextDef>> = {
  dm: { key: 'dm', kind: 'personal', members: ['alice'] },
  room1: { key: 'room1', kind: 'group', members: ['alice', 'bob'] },
  room2: { key: 'room2', kind: 'group', members: ['bob', 'carol'] },
  web: { key: 'web', kind: 'account', members: 'sender' },
};

/** The Teams conversation id of each context-bound context. */
export const NATIVE_CONVERSATION: Readonly<Record<Exclude<ContextKey, 'web'>, string>> = {
  dm: 'a:ma-dm-alice',
  room1: '19:ma-room-one@thread.tacv2',
  room2: '19:ma-room-two@thread.tacv2',
};

/** People present in `ctx` when `sender` speaks. */
export function presentIn(ctx: ContextKey, sender: UserKey): readonly UserKey[] {
  const m = CONTEXTS[ctx].members;
  return m === 'sender' ? [sender] : m;
}

/** The conversation part of a graph scope (before agent qualification). */
export function conversationOf(ctx: ContextKey, sender: UserKey): string {
  return ctx === 'web' ? `http-ma-web-${sender}` : `teams-${ctx}`;
}

/** Graph scope `<slug>::<conversation>`; `legacy` is the pre-qualification form. */
export function graphScope(agent: AgentKey | 'legacy', ctx: ContextKey, sender: UserKey): string {
  const conv = conversationOf(ctx, sender);
  return agent === 'legacy' ? conv : `${AGENTS[agent]}::${conv}`;
}

/**
 * A search keyword shared by the turns of one conversation of one agent
 * (`kx<agent><context><sender>`). Plain lowercase letters and digits, so both
 * backends' full-text search treat it as one token, and no keyword contains
 * another. Read paths cap results at 50; querying one keyword returns one
 * group of turns, never a truncated mix.
 */
export function turnKeyword(t: {
  agent: AgentKey | 'legacy';
  context: ContextKey;
  sender: UserKey;
}): string {
  return `kx${t.agent}${t.context}${t.sender}`;
}

// ---------------------------------------------------------------------------
// Viewers
// ---------------------------------------------------------------------------

/**
 * Someone who could obtain memory: a person talking to an agent in a context,
 * in a tenant, with or without a Privacy Shield on the turn.
 */
export interface Viewer {
  readonly tenant: TenantKey;
  readonly user: UserKey;
  readonly agent: AgentKey;
  readonly context: ContextKey;
  readonly shielded: boolean;
}

export function viewerId(v: Viewer): string {
  return `${v.tenant}/${v.user}@${v.agent}/${v.context}${v.shielded ? '+shield' : ''}`;
}

/** Every viewer: each person in each context they belong to, per agent and shield. */
export function allViewers(): Viewer[] {
  const out: Viewer[] = [];
  for (const tenant of ['main', 'other'] as const) {
    for (const agent of AGENT_KEYS) {
      for (const context of CONTEXT_KEYS) {
        for (const user of USER_KEYS) {
          const m = CONTEXTS[context].members;
          if (m !== 'sender' && !m.includes(user)) continue;
          for (const shielded of [false, true])
            out.push({ tenant, user, agent, context, shielded });
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

/** `absent` = the field is omitted on write, so the backend default applies. */
export type OwnerSet = readonly UserKey[] | 'absent';
export const MK_OWNER_SETS: readonly OwnerSet[] = [
  ['alice'],
  ['alice', 'bob'],
  ['bob', 'carol'],
  ['alice', 'bob', 'carol'],
  [],
  'absent',
];

export type MkVisibility = 'private' | 'team' | 'public' | 'shared:room1' | 'absent';
export const MK_VISIBILITIES: readonly MkVisibility[] = [
  'private',
  'team',
  'public',
  'shared:room1',
  'absent',
];

/**
 * Who wrote a memory.
 *  - `conversation`: promoted out of a chat (`created_by` `auto:…`, not authored).
 *  - `operator`: written by a person (`manually_authored`, `created_by` `web:<id>`).
 *  - `auto-durable`: T3 durable auto-promotion, which also sets
 *    `manually_authored` but came out of a conversation (`created_by` `auto:…`).
 */
export type Authorship = 'conversation' | 'operator' | 'auto-durable';
export const AUTHORSHIPS: readonly Authorship[] = ['conversation', 'operator', 'auto-durable'];

/** Privacy Shield provenance (#1507, #1536). */
export type Provenance = 'protected' | 'stamped-unprotected' | 'derived-from-unprotected-turn';
export const PROVENANCES: readonly Provenance[] = [
  'protected',
  'stamped-unprotected',
  'derived-from-unprotected-turn',
];

export interface MkItem {
  readonly store: 'memorable-knowledge';
  readonly canary: string;
  readonly tenant: TenantKey;
  readonly owners: OwnerSet;
  readonly visibility: MkVisibility;
  readonly originAgent: AgentKey | 'none';
  readonly authorship: Authorship;
  readonly provenance: Provenance;
}

/** A Palaia excerpt of a memory. Its own canary; access follows the parent. */
export interface ExcerptItem {
  readonly store: 'excerpt';
  readonly canary: string;
  readonly tenant: TenantKey;
  readonly parent: MkItem;
}

/** `owners` on a turn: who was present (members mode), nobody, or not recorded. */
export type TurnOwners = 'present' | 'none' | 'absent';

export interface TurnItem {
  readonly store: 'turn';
  readonly canary: string;
  readonly tenant: TenantKey;
  /** `legacy` = an unqualified scope from before per-agent scopes. */
  readonly agent: AgentKey | 'legacy';
  readonly context: ContextKey;
  /** Who sent the turn; in a room, one of its members. */
  readonly sender: UserKey;
  readonly owners: TurnOwners;
  readonly unprotected: boolean;
  /** Below the capture threshold: in the session tail only, never recalled (#1096). */
  readonly tailOnly: boolean;
}

/** An entity a turn captured. Entity nodes are global in the tenant. */
export interface EntityItem {
  readonly store: 'entity';
  readonly canary: string;
  readonly tenant: TenantKey;
  readonly capturedBy: TurnItem;
}

/** A plan recorded for a turn, or for no turn (`orphan`). */
export interface PlanItem {
  readonly store: 'plan';
  readonly canary: string;
  readonly tenant: TenantKey;
  readonly agent: AgentKey;
  readonly context: ContextKey;
  readonly sender: UserKey;
  readonly turn: 'protected' | 'unprotected' | 'orphan';
}

/**
 * A file in the `/memories` tree.
 *
 *  - `core`: `/memories/core/…`, shared by every agent.
 *  - `rules`: `/memories/_rules/…` (durable rules, a top-level `_*` tree).
 *  - `agent`: the agent's own tree `/memories/orchestrators/<slug>/…`.
 *  - `transcript`: a session transcript `/memories/sessions/<scope>/…`,
 *    written by the middleware for a turn in `context`.
 *  - `chat-session`: `/memories/chat-sessions/…` for a turn in `context`.
 *  - `context-channel`, `context-user`, `context-team`: the agent's tier for
 *    `context` (room channel tier, DM user tier, the rooms' shared team tier).
 *  - `members`: the agent's tier for exactly the owner set `owners`.
 */
export type ScratchTier =
  | 'core'
  | 'rules'
  | 'agent'
  | 'transcript'
  | 'chat-session'
  | 'context-channel'
  | 'context-user'
  | 'context-team'
  | 'members';

export interface ScratchItem {
  readonly store: 'scratch';
  readonly canary: string;
  readonly tenant: TenantKey;
  readonly tier: ScratchTier;
  /** The agent whose tree it is; `none` for the shared trees. */
  readonly agent: AgentKey | 'none';
  /** For `transcript`, `chat-session`, `context-*`: whose conversation. */
  readonly context?: ContextKey;
  readonly sender?: UserKey;
  /** For `members`: the owner set of the tier. */
  readonly owners?: readonly UserKey[];
}

/** An uploaded dataset. One owner, the importing user. */
export interface DatasetItem {
  readonly store: 'dataset';
  readonly canary: string;
  readonly tenant: TenantKey;
  readonly owner: UserKey;
}

/** A stored process (process memory). Neon only. */
export interface ProcessItem {
  readonly store: 'process';
  readonly canary: string;
  readonly tenant: TenantKey;
  readonly agent: AgentKey;
  readonly context: ContextKey;
  readonly sender: UserKey;
  readonly unprotected: boolean;
}

/** A topic: a label over a cluster of memories (Slice 11). */
export interface TopicItem {
  readonly store: 'topic';
  readonly canary: string;
  readonly tenant: TenantKey;
  /** The memories it groups. */
  readonly members: readonly MkItem[];
}

export type Item =
  | MkItem
  | ExcerptItem
  | TurnItem
  | EntityItem
  | PlanItem
  | ScratchItem
  | DatasetItem
  | ProcessItem
  | TopicItem;

export type Store = Item['store'];

/**
 * A canary: short, distinctive, and never a substring of another one (the
 * numeric part is fixed-width and closed by `Z`).
 */
function canaryFactory(): (store: string) => string {
  let n = 0;
  return (store) => {
    n += 1;
    return `CANARY-${store.toUpperCase().replace(/[^A-Z]/g, '')}-${String(n).padStart(5, '0')}Z`;
  };
}

export interface World {
  readonly items: readonly Item[];
  readonly byStore: { readonly [S in Store]: readonly Extract<Item, { store: S }>[] };
}

/**
 * Build the world. Deterministic: the same call always yields the same items
 * with the same canaries.
 */
export function buildWorld(): World {
  const canary = canaryFactory();
  const items: Item[] = [];
  const turns: TurnItem[] = [];
  const mks: MkItem[] = [];

  for (const tenant of ['main', 'other'] as const) {
    // --- Turns: agent × context × sender × owners × provenance, plus tail-only.
    for (const agent of [...AGENT_KEYS, 'legacy'] as const) {
      for (const context of CONTEXT_KEYS) {
        const senders: readonly UserKey[] =
          context === 'web'
            ? USER_KEYS
            : (CONTEXTS[context].members as readonly UserKey[]).slice(0, 1);
        for (const sender of senders) {
          for (const owners of ['present', 'none', 'absent'] as const) {
            for (const unprotected of [false, true]) {
              turns.push({
                store: 'turn',
                canary: canary('turn'),
                tenant,
                agent,
                context,
                sender,
                owners,
                unprotected,
                tailOnly: false,
              });
            }
          }
          turns.push({
            store: 'turn',
            canary: canary('turn'),
            tenant,
            agent,
            context,
            sender,
            owners: 'present',
            unprotected: false,
            tailOnly: true,
          });
        }
      }
    }

    // --- Memorable knowledge: the full product of the ACL dimensions in the
    // main tenant. The other tenant only has to prove isolation, so it gets
    // the owner × visibility × agent grid alone (keeps the Neon seed fast).
    const full = tenant === 'main';
    for (const owners of MK_OWNER_SETS) {
      for (const visibility of MK_VISIBILITIES) {
        for (const originAgent of [...AGENT_KEYS, 'none'] as const) {
          for (const authorship of full ? AUTHORSHIPS : (['conversation'] as const)) {
            for (const provenance of full ? PROVENANCES : (['protected'] as const)) {
              mks.push({
                store: 'memorable-knowledge',
                canary: canary('mk'),
                tenant,
                owners,
                visibility,
                originAgent,
                authorship,
                provenance,
              });
            }
          }
        }
      }
    }
  }
  items.push(...turns, ...mks);

  for (const parent of mks) {
    items.push({ store: 'excerpt', canary: canary('excerpt'), tenant: parent.tenant, parent });
  }

  for (const t of turns) {
    if (t.owners === 'present' && !t.unprotected && !t.tailOnly) {
      items.push({ store: 'entity', canary: canary('entity'), tenant: t.tenant, capturedBy: t });
    }
  }

  for (const tenant of ['main', 'other'] as const) {
    for (const agent of AGENT_KEYS) {
      for (const context of CONTEXT_KEYS) {
        const sender: UserKey = context === 'room2' ? 'bob' : 'alice';
        for (const turn of ['protected', 'unprotected', 'orphan'] as const) {
          items.push({
            store: 'plan',
            canary: canary('plan'),
            tenant,
            agent,
            context,
            sender,
            turn,
          });
        }
        for (const unprotected of [false, true]) {
          items.push({
            store: 'process',
            canary: canary('process'),
            tenant,
            agent,
            context,
            sender,
            unprotected,
          });
        }
      }
    }

    items.push({
      store: 'scratch',
      canary: canary('scratch'),
      tenant,
      tier: 'core',
      agent: 'none',
    });
    items.push({
      store: 'scratch',
      canary: canary('scratch'),
      tenant,
      tier: 'rules',
      agent: 'none',
    });
    for (const context of CONTEXT_KEYS) {
      const senders: readonly UserKey[] =
        context === 'web' ? USER_KEYS : [context === 'room2' ? 'bob' : 'alice'];
      for (const sender of senders) {
        for (const agent of AGENT_KEYS) {
          items.push({
            store: 'scratch',
            canary: canary('scratch'),
            tenant,
            tier: 'transcript',
            agent,
            context,
            sender,
          });
        }
        items.push({
          store: 'scratch',
          canary: canary('scratch'),
          tenant,
          tier: 'chat-session',
          agent: 'none',
          context,
          sender,
        });
      }
    }
    for (const agent of AGENT_KEYS) {
      items.push({ store: 'scratch', canary: canary('scratch'), tenant, tier: 'agent', agent });
      items.push({
        store: 'scratch',
        canary: canary('scratch'),
        tenant,
        tier: 'context-user',
        agent,
        context: 'dm',
      });
      items.push({
        store: 'scratch',
        canary: canary('scratch'),
        tenant,
        tier: 'context-channel',
        agent,
        context: 'room1',
      });
      items.push({
        store: 'scratch',
        canary: canary('scratch'),
        tenant,
        tier: 'context-channel',
        agent,
        context: 'room2',
      });
      items.push({
        store: 'scratch',
        canary: canary('scratch'),
        tenant,
        tier: 'context-team',
        agent,
        context: 'room1',
      });
      for (const owners of [
        ['alice'],
        ['alice', 'bob'],
        ['bob', 'carol'],
        ['alice', 'bob', 'carol'],
      ] as const) {
        items.push({
          store: 'scratch',
          canary: canary('scratch'),
          tenant,
          tier: 'members',
          agent,
          owners,
        });
      }
    }

    for (const owner of USER_KEYS) {
      items.push({ store: 'dataset', canary: canary('dataset'), tenant, owner });
    }

    // Topics over memories of different reach: one private to Alice, one
    // shared team-wide, one mixing both.
    const tenantMks = mks.filter(
      (m) =>
        m.tenant === tenant &&
        m.authorship === 'conversation' &&
        m.provenance === 'protected' &&
        m.originAgent === 'none',
    );
    const pick = (owners: string, visibility: MkVisibility): MkItem =>
      tenantMks.find((m) => JSON.stringify(m.owners) === owners && m.visibility === visibility)!;
    const alicePrivate = pick('["alice"]', 'private');
    const bobTeam = pick('["bob","carol"]', 'team');
    items.push({ store: 'topic', canary: canary('topic'), tenant, members: [alicePrivate] });
    items.push({ store: 'topic', canary: canary('topic'), tenant, members: [bobTeam] });
    items.push({
      store: 'topic',
      canary: canary('topic'),
      tenant,
      members: [alicePrivate, bobTeam],
    });
  }

  const byStore = {} as Record<Store, Item[]>;
  for (const item of items) (byStore[item.store] ??= []).push(item);
  return { items, byStore: byStore as World['byStore'] };
}
