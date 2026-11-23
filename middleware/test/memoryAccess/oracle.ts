/**
 * The memory-access oracle: may this viewer obtain this item, through any
 * entry point a turn of this agent has, when the agent runs in this
 * context-memory mode?
 *
 * Hand-written from documented intent, NOT from production code:
 *
 *  - `documented`: the rule is stated in the docs, specs, ADRs, CHANGELOG or
 *    the plugin-api contract comments. `source` names where.
 *  - `pinned`: nothing documents the rule. The verdict is what the code does
 *    today (read once, by hand, 2026-11-23) and is tagged
 *    "pinned, not decided". Changing it is a product decision, not a test fix.
 *
 * Where the docs contradict each other, the newer statement wins and `source`
 * names both. Where documented intent and today's code disagree, the oracle
 * follows the docs and the row is listed in `EXPECTED_DIVERGENCES`, so the
 * contract suite (step 2) can show them failing by design instead of
 * quietly encoding the leak.
 *
 * Source abbreviations:
 *   H   docs/middleware-agent-handoff.md
 *   S   docs/security-architecture.md
 *   C   docs/CHANGELOG.md
 *   PA  packages/plugin-api/src/knowledgeGraph.ts (contract comments)
 *   SP  specs/2042-agents-as-virtual-employees/spec.md
 */
import {
  CONTEXTS,
  presentIn,
  type ContextKey,
  type DatasetItem,
  type EntityItem,
  type ExcerptItem,
  type Item,
  type MkItem,
  type PlanItem,
  type ProcessItem,
  type ScratchItem,
  type TopicItem,
  type TurnItem,
  type UserKey,
  type Viewer,
} from './world.js';

export type Mode = 'off' | 'enforce' | 'enforce-strict' | 'members';
export const MODES: readonly Mode[] = ['off', 'enforce', 'enforce-strict', 'members'];

export const PINNED = 'pinned, not decided';

export interface Verdict {
  readonly allowed: boolean;
  readonly basis: 'documented' | 'pinned';
  /** Why: the rule and where it is stated. */
  readonly source: string;
}

const doc = (allowed: boolean, source: string): Verdict => ({
  allowed,
  basis: 'documented',
  source,
});
const pin = (allowed: boolean, source: string): Verdict => ({
  allowed,
  basis: 'pinned',
  source: `${PINNED}: ${source}`,
});

// ---------------------------------------------------------------------------
// The turn's memory regime
// ---------------------------------------------------------------------------

/**
 * Only turns with a `TurnOrigin` are context-bound; web/API turns emit none
 * and stay context-free in every mode (S "Only turns that carry a TurnOrigin
 * are context-bound"; H Rollout "HTTP/API-Turns emittieren kein origin").
 * `off` is context-free for every turn (H Effective Scope, row 1).
 */
export function isContextBound(v: Viewer, mode: Mode): boolean {
  return mode !== 'off' && CONTEXTS[v.context].kind !== 'context-free';
}

/** `owners` ⊇ `audience`, both as canonical id sets. */
function covers(owners: readonly UserKey[], audience: readonly UserKey[]): boolean {
  return audience.length > 0 && audience.every((u) => owners.includes(u));
}

/** The viewer's own conversation: same agent, same graph scope. */
function isOwnConversation(
  v: Viewer,
  agent: string,
  context: ContextKey,
  sender: UserKey,
): boolean {
  if (agent !== v.agent || context !== v.context) return false;
  // A room is one conversation for everyone in it; a web chat belongs to its sender.
  return CONTEXTS[context].kind === 'context-free' ? sender === v.user : true;
}

// ---------------------------------------------------------------------------
// The oracle
// ---------------------------------------------------------------------------

export function expected(v: Viewer, mode: Mode, item: Item): Verdict {
  if (item.tenant !== v.tenant) {
    return doc(
      false,
      'tenant isolation: every KG query is tenant-scoped, no admin override (S tenant_id; cross-channel-memory.md "No admin override")',
    );
  }
  switch (item.store) {
    case 'memorable-knowledge':
      return memorableKnowledge(v, mode, item);
    case 'excerpt':
      return excerpt(v, mode, item);
    case 'turn':
      return turn(v, mode, item);
    case 'entity':
      return entity(v, mode, item);
    case 'plan':
      return plan(v, mode, item);
    case 'process':
      return process(v, mode, item);
    case 'scratch':
      return scratch(v, mode, item);
    case 'dataset':
      return dataset(v, item);
    case 'topic':
      return topic(v, mode, item);
  }
}

function memorableKnowledge(v: Viewer, mode: Mode, mk: MkItem): Verdict {
  if (v.shielded && mk.provenance !== 'protected') {
    return doc(
      false,
      '#1536: under a shield, MK stamped unprotected or DERIVED_FROM an unprotected turn is skipped (S #1536, PA excludeUnprotected)',
    );
  }
  const agentOk = mk.originAgent === 'none' || mk.originAgent === v.agent;
  const owners = mk.owners === 'absent' ? [] : mk.owners;

  if (mode === 'members' && isContextBound(v, mode)) {
    // H "Modus members": usable when everyone present is an owner AND it
    // belongs to the same agent. S/C (newer than H, PA): the operator
    // exception needs manually_authored AND a created_by that is not
    // `auto:…`; T3 durable auto-promotion sets manually_authored too.
    // Visibility does not widen it (S "teamVisibility does not widen the rule").
    if (!agentOk)
      return doc(
        false,
        'members: knowledge must belong to the same agent (H "demselben Agenten gehört")',
      );
    if (covers(owners, presentIn(v.context, v.user)))
      return doc(true, 'members: everyone present owns it (H "Anwesende ⊆ Owner")');
    if (mk.authorship === 'operator')
      return doc(
        true,
        'members: operator-authored rows pass (S, C: manually_authored and created_by not auto:)',
      );
    return doc(
      false,
      'members: someone present is not an owner; visibility does not widen (S, PA audienceOwners)',
    );
  }

  const shared =
    mk.visibility === 'team' || mk.visibility === 'public' || mk.visibility === 'absent';
  const sharedSource =
    mk.visibility === 'absent'
      ? pin(
          true,
          "an MK written without visibility counts as team (Neon COALESCE(visibility, 'team'))",
        ).source
      : 'team/public knowledge is shared by construction (C #575; PA teamVisibility)';

  if (mode === 'enforce-strict' && isContextBound(v, mode)) {
    // Strict narrows recall to the own conversation (H, S table). Curated MK
    // has no conversation; the code applies the #575 shared-tier floor
    // (sharedOnly). Nothing documents which MK a strict turn may see.
    if (shared)
      return pin(true, `enforce-strict: only the shared tier (sharedOnly floor). ${sharedSource}`);
    return pin(
      false,
      'enforce-strict: rows the user owns privately stay out of a context-bound turn (sharedOnly floor, C #575 reasoning)',
    );
  }

  // off / enforce / context-free turns: the viewer ACL.
  if (owners.includes(v.user) && agentOk) {
    return doc(
      true,
      'owner branch: viewer in acl_owners, origin_agent is this agent or unset (PA viewerAgentSlug)',
    );
  }
  if (shared) {
    // KG_RECALL_TEAM_VISIBILITY is undocumented; today it defaults to true.
    return pin(
      true,
      `team branch on by default (KG_RECALL_TEAM_VISIBILITY undocumented, default true); team/public crosses agents (PA viewerAgentSlug). ${sharedSource}`,
    );
  }
  if (mk.visibility === 'shared:room1') {
    return pin(
      false,
      'shared:<x> is never read as team or public; only owners see it (nothing writes or parses <x> on MK)',
    );
  }
  if (owners.includes(v.user))
    return doc(
      false,
      "owner of another agent's private MK: viewerAgentSlug constrains the owner branch (PA)",
    );
  return doc(
    false,
    'private MK, viewer not an owner (PA teamVisibility: "private stays strictly owner-only")',
  );
}

function excerpt(v: Viewer, mode: Mode, ex: ExcerptItem): Verdict {
  const parent = memorableKnowledge(v, mode, ex.parent);
  return {
    ...parent,
    source: `${parent.source} [excerpt follows its parent MK, PA ExcerptSearchOptions]`,
  };
}

function turn(v: Viewer, mode: Mode, t: TurnItem): Verdict {
  if (t.agent !== v.agent) {
    return t.agent === 'legacy'
      ? pin(false, 'an unqualified (pre-agent) scope belongs to the `default` agent only')
      : doc(
          false,
          "another agent's turn: reads are constrained to `<slug>::` (PA qualifyScope; SP INV-2)",
        );
  }
  const own = isOwnConversation(v, t.agent, t.context, t.sender);

  if (mode === 'members' && isContextBound(v, mode)) {
    // The tail is audience-filtered too (H: audienceOwners an getSession, der Tail).
    if (t.owners !== 'present')
      return doc(
        false,
        'members: a turn without owners belongs to nobody (H "Kein Backfill"; PA TurnIngest.owners)',
      );
    if (t.tailOnly && !own)
      return doc(
        false,
        'tail-only turns are never recalled cross-session (PA TurnIngest.tailOnly, #1096)',
      );
    if (v.shielded && t.unprotected && !own)
      return doc(false, 'under a shield, unprotected turns are excluded from search (S #1507)');
    return covers(presentIn(t.context, t.sender), presentIn(v.context, v.user))
      ? doc(true, 'members: everyone present owns the turn')
      : doc(false, 'members: someone present does not own the turn');
  }
  if (own)
    return doc(
      true,
      'the turn\'s own conversation (session tail keeps every turn, S #1507 "the same chat\'s tail")',
    );
  if (mode === 'enforce-strict' && isContextBound(v, mode)) {
    return doc(false, 'enforce-strict: recall is limited to the own conversation (H, S table)');
  }
  if (t.tailOnly)
    return doc(false, 'tail-only turns are never recalled cross-session (PA TurnIngest.tailOnly)');
  if (v.shielded && t.unprotected)
    return doc(false, 'under a shield, unprotected turns are excluded from search (S #1507)');
  if (t.sender !== v.user)
    return doc(
      false,
      'cross-session recall returns the user\'s own other chats (S "hits from the user\'s other chats")',
    );
  return doc(
    true,
    'off/enforce: graph recall is agent-wide across the user\'s chats (H "teilen weiter agentweit")',
  );
}

function entity(v: Viewer, mode: Mode, e: EntityItem): Verdict {
  if ((mode === 'members' || mode === 'enforce-strict') && isContextBound(v, mode)) {
    const via = turn(v, mode, e.capturedBy);
    return {
      ...via,
      source: `${via.source} [strict/members: entities are reached through the turns that captured them, H query_knowledge_graph view]`,
    };
  }
  return doc(true, 'entity nodes are global in the tenant (PA "Entity NODES stay global")');
}

function plan(v: Viewer, mode: Mode, p: PlanItem): Verdict {
  if ((mode === 'members' || mode === 'enforce-strict') && isContextBound(v, mode)) {
    return doc(false, 'strict/members: plans carry no owners and are skipped (S)');
  }
  if (p.agent !== v.agent)
    return doc(
      false,
      'another agent\'s plan: plan recall is agent-scoped (PA qualifyScope "turns/plans")',
    );
  if (v.shielded && p.turn !== 'protected')
    return doc(false, '#1536: under a shield only plans of a known, protected turn (S)');
  return pin(true, 'plans of the same agent are visible to every user of it; no per-user filter');
}

function process(v: Viewer, mode: Mode, p: ProcessItem): Verdict {
  if ((mode === 'members' || mode === 'enforce-strict') && isContextBound(v, mode)) {
    return doc(false, 'strict/members: processes carry no owners and are skipped (S)');
  }
  if (v.shielded && p.unprotected)
    return doc(false, '#1540: unprotected processes are skipped under a shield (S)');
  if (p.agent !== v.agent) return doc(false, "SP INV-2: an agent gets no other agent's memory");
  return pin(
    true,
    'processes of the same agent are visible to every user of it (default visibility team)',
  );
}

function dataset(v: Viewer, d: DatasetItem): Verdict {
  return d.owner === v.user
    ? doc(true, "the importing user is the dataset's sole owner (PA DatasetIngest)")
    : doc(false, 'datasets are owner-only, checked on every read (PA DatasetIngest)');
}

function topic(v: Viewer, mode: Mode, t: TopicItem): Verdict {
  if ((mode === 'members' || mode === 'enforce-strict') && isContextBound(v, mode)) {
    return pin(false, 'strict/members: no topic leg in recall');
  }
  // A topic's name is written from its members' summaries, and today every
  // topic is listed to everyone in the tenant. Nothing documents it.
  void t;
  return pin(
    true,
    'topics are listed tenant-wide; members are filtered per viewer, the topic itself is not',
  );
}

/** Which `/memories` trees a turn can read (H Effective Scope, W3 members). */
function scratch(v: Viewer, mode: Mode, s: ScratchItem): Verdict {
  const bound = isContextBound(v, mode);
  const strictOrMembers = bound && (mode === 'enforce-strict' || mode === 'members');

  switch (s.tier) {
    case 'core':
    case 'rules':
      return doc(
        true,
        'core and top-level _* stay readable in every mode (H "ro:core-notes": /memories/core/ und _* bleiben lesbar)',
      );
    case 'transcript':
      if (v.shielded) return doc(false, '#1540: /memories/sessions/ is refused under a shield (C)');
      if (strictOrMembers)
        return doc(false, 'strict/members: transcripts are not readable (H ro:core-notes)');
      return doc(
        true,
        'transcripts are shared under core/sessions, flat, without agent (H decision A3a)',
      );
    case 'chat-session':
      if (strictOrMembers)
        return doc(false, 'strict/members: chat-sessions are not readable (H ro:core-notes)');
      return doc(
        true,
        'chat-sessions are a shared tree passed through unchanged (H Effective Scope)',
      );
    case 'agent':
      if (s.agent !== v.agent) return doc(false, "another agent's tree (H orchestrator:<slug>:*)");
      if (strictOrMembers)
        return doc(false, 'strict/members: no agent tier (H Effective Scope; W3 "no agent tier")');
      return doc(true, "the agent's own tree (rw context-free, ro in enforce)");
    case 'context-user':
    case 'context-channel':
    case 'context-team': {
      if (s.agent !== v.agent)
        return doc(false, "another agent's context tier (H contextTierRoot per slug)");
      if (!bound)
        return doc(false, 'context tiers are unreachable from a context-free turn (H Fail-closed)');
      if (mode === 'members')
        return doc(false, 'members replaces channel, team and user tiers (H W3 forAudience)');
      const sameTeam =
        s.tier === 'context-team' && (v.context === 'room1' || v.context === 'room2');
      const sameTier = s.tier !== 'context-team' && s.context === v.context;
      return sameTeam || sameTier
        ? doc(true, "the turn's own context tier (H Scope-Grammatik)")
        : doc(
            false,
            "another context's tier: Team A ↮ Team B, Kanal ↮ Kanal, User ↮ User (H memoryContextIsolation)",
          );
    }
    case 'members': {
      if (s.agent !== v.agent) return doc(false, "another agent's members tier");
      if (!(mode === 'members' && bound))
        return doc(false, 'members tiers are granted only by the members binder (H W3)');
      return covers(s.owners ?? [], presentIn(v.context, v.user))
        ? doc(
            true,
            'members: the own owner set, or a larger one containing everyone present (ro) (H W3)',
          )
        : doc(false, 'members: an owner set that does not contain everyone present (H W3)');
    }
  }
}

// ---------------------------------------------------------------------------
// Where today's code is believed to disagree with the documented rows above.
// Read from code on 2026-11-23, NOT yet run. Step 2 confirms or clears each;
// a confirmed one stays as a failing-by-design test and is reported.
// ---------------------------------------------------------------------------

export interface Divergence {
  readonly id: string;
  readonly oracle: string;
  readonly code: string;
}

export const EXPECTED_DIVERGENCES: readonly Divergence[] = [
  {
    id: 'kg-tool-tenant-wide',
    oracle:
      "off/enforce: another agent's and another user's turns are not readable (SP INV-2; S \"user's other chats\")",
    code: 'query_knowledge_graph runs without a view in off/enforce: listSessions/getSession/search over the whole tenant',
  },
  {
    id: 'strict-durable-leg',
    oracle: 'enforce-strict context-bound: privately owned MK stays out',
    code: 'the durable recall leg gets no sharedOnly, so owned manually_authored private MK is recalled',
  },
  {
    id: 'empty-audience-inmemory',
    oracle: 'an empty audience matches nothing (PA ownersCoverAudience)',
    code: 'InMemory MK/excerpt search with audienceOwners [] still admits operator-authored rows; Neon returns []',
  },
  {
    id: 'process-cross-agent',
    oracle: "another agent's process is not readable (SP INV-2)",
    code: 'process memory query/get filter only on tenant, scope and unprotected',
  },
  {
    id: 'excerpt-parent-recheck',
    oracle: 'an excerpt of a team-visible MK is visible to a non-owner when its parent is',
    code: 'excerpt-only hits re-read the parent with getMemorableKnowledge(id, viewer), which is owner-only',
  },
];
