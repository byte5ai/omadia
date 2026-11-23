// #2043 D8 — what a target picker can offer WITHOUT enumerating the tenant.
//
// The instance already knows conversations: every chat one of its bots was
// added to or wrote in left a conversation reference
// (`teams_conversation_refs`, kernel-owned). Those are the chats an operator
// is most likely to want for the next agent, they cost one indexed query
// instead of a minute of Graph paging, and they are the default list of the
// picker. Everything else is found by search or typed as an id or a link.
//
// Only conversations that are INSTALL TARGETS are offered: a Graph chat id.
// A Bot Framework personal conversation (`a:…`) is not one, and a channel
// reference does not carry the team id an install needs (teams come from the
// team list, which is short).

import type { TeamsTargetKind } from '../platform/teamsInstallTarget.js';

/** One stored conversation, as the reference table knows it. */
export interface RecentTeamsConversation {
  readonly conversationId: string;
  /** Teams' own type of the conversation (`groupChat`, `personal`, `channel`). */
  readonly teamsType: string | null;
  readonly name: string | null;
  readonly updatedAt: Date;
  /** Lower-cased app ids of the bots that hold a reference there. */
  readonly botAppIds: readonly string[];
}

export type RecentTeamsConversationSource = (limit: number) => Promise<readonly RecentTeamsConversation[]>;

export interface RecentTeamsTarget {
  readonly id: string;
  readonly kind: Exclude<TeamsTargetKind, 'team'>;
  readonly label: string | null;
  /** This agent's own bot already holds a reference there. */
  readonly knownToThisBot: boolean;
  readonly updatedAt: string;
}

export type RecentTeamsTargets =
  | { readonly available: true; readonly items: readonly RecentTeamsTarget[] }
  | { readonly available: false; readonly reason: 'unavailable' | 'lookup_failed' };

export const RECENT_TEAMS_TARGETS_LIMIT = 50;
/** Rows read to end up with that many targets after filtering. */
const SCAN_LIMIT = 400;

/** The Graph chat id inside a stored conversation id, or `undefined` when the
 *  conversation is not something an app can be installed into as a chat. */
export function chatTargetOf(conversationId: string): { id: string; kind: RecentTeamsTarget['kind'] } | undefined {
  // A reference can carry the thread suffix of the message it was taken from.
  const id = conversationId.split(';')[0]?.trim() ?? '';
  if (!id.startsWith('19:')) return undefined;
  if (id.endsWith('@unq.gbl.spaces')) return { id, kind: 'one-on-one-chat' };
  if (id.endsWith('@thread.v2') || id.endsWith('@thread.skype')) return { id, kind: 'group-chat' };
  return undefined;
}

export function projectRecentTeamsTargets(
  rows: readonly RecentTeamsConversation[],
  ownAppId: string | null,
  limit = RECENT_TEAMS_TARGETS_LIMIT,
): readonly RecentTeamsTarget[] {
  const own = ownAppId?.trim().toLowerCase() ?? '';
  const seen = new Set<string>();
  const targets: RecentTeamsTarget[] = [];
  for (const row of rows) {
    const target = chatTargetOf(row.conversationId);
    if (!target || seen.has(target.id)) continue;
    seen.add(target.id);
    targets.push({
      ...target,
      label: row.name !== null && row.name.trim() !== '' ? row.name.trim() : null,
      knownToThisBot: own !== '' && row.botAppIds.includes(own),
      updatedAt: row.updatedAt.toISOString(),
    });
  }
  // This agent's own conversations first, then the most recent of the others.
  return targets
    .sort((a, b) => Number(b.knownToThisBot) - Number(a.knownToThisBot) || b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit);
}

/**
 * The recent list for one agent. Never throws: a picker without it still has
 * search and the id field.
 */
export async function recentTeamsTargets(
  deps: {
    readonly recentConversations?: RecentTeamsConversationSource;
    readonly store: { getByAgentId(agentId: string): Promise<{ readonly appId: string | null } | undefined> };
  },
  agentId: string,
): Promise<RecentTeamsTargets> {
  if (!deps.recentConversations) return { available: false, reason: 'unavailable' };
  try {
    const [rows, identity] = await Promise.all([
      deps.recentConversations(SCAN_LIMIT),
      deps.store.getByAgentId(agentId).catch(() => undefined),
    ]);
    return { available: true, items: projectRecentTeamsTargets(rows, identity?.appId ?? null) };
  } catch (err) {
    console.warn('[teams-targets] recent conversations lookup failed:', err instanceof Error ? err.message : err);
    return { available: false, reason: 'lookup_failed' };
  }
}
