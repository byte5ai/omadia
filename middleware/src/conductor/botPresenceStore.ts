// Which bots can be heard in a conversation.
//
// WHY NOT THE ROSTER. The obvious source looks like the conversation roster,
// and it is wrong: Teams' roster API (`TeamsInfo.getPagedMembers`) returns
// PEOPLE. Bots are not listed as members — the group-primitives adapter has to
// synthesise the single `self` entry from the cached reference precisely
// because the API never mentions it. Filtering that roster for bots therefore
// yields nothing, always. Observed live: a chat with four provisioned bots
// answered "partners here: none", and the agent concluded no partner existed.
//
// The real signal is `teams_conversation_refs`: one row per (conversation, bot),
// written when that bot sees an activity there — which includes being ADDED to
// the chat, since membership changes capture a reference too. A row means the
// bot has a handle to speak through; no row means anything it says would be
// generated and then dropped. That is exactly the question being asked.
//
// The table is kernel-owned (graph migration 0031), so reading it here is not a
// reach into plugin territory; the Teams plugin's own store documents the same
// ownership.

import type { Pool } from 'pg';

/** One conversation a given bot holds a reference in — the reverse lookup. */
export interface BotConversation {
  readonly conversationId: string;
  /** Teams' `conversationType` as captured with the reference: `groupChat`,
   *  `channel`, `personal`, or null on legacy rows. */
  readonly teamsType: string | null;
  /** The chat's topic/name when the reference captured one. Group chats
   *  without a set topic carry none — the id is then the only handle. */
  readonly name: string | null;
  readonly updatedAt: Date;
  /** Lower-cased app ids of EVERY bot with a reference there (the asked-for
   *  bot included). What the operator needs to see is who else is there. */
  readonly botAppIds: readonly string[];
}

/** Lower-cased Entra app ids of the bots with a reference in a conversation. */
export interface BotPresenceStore {
  botAppIdsIn(conversationId: string): Promise<readonly string[]>;
  /**
   * Which conversations THIS bot can be heard in — the operator-facing
   * reverse of {@link botAppIdsIn}. The peer-chat picker on the agent page is
   * built on it: the only chats worth offering for agent-to-agent talk are
   * the ones the agent's own bot actually holds a handle to; a typed-in id
   * for any other chat would be accepted and then never used.
   */
  conversationsOf(botAppId: string): Promise<readonly BotConversation[]>;
}

export function createBotPresenceStore(pool: Pool, log?: (msg: string) => void): BotPresenceStore {
  return {
    async conversationsOf(botAppId) {
      const wanted = botAppId.trim().toLowerCase();
      if (wanted.length === 0) return [];
      try {
        const { rows } = await pool.query<{
          conversation_id: string;
          teams_type: string | null;
          name: string | null;
          updated_at: Date;
          bot_app_ids: string[] | null;
        }>(
          `SELECT r.conversation_id,
                  r.teams_type,
                  r.ref #>> '{conversation,name}' AS name,
                  r.updated_at,
                  (SELECT array_agg(DISTINCT lower(o.bot_app_id))
                     FROM teams_conversation_refs o
                    WHERE o.conversation_id = r.conversation_id AND o.bot_app_id <> '') AS bot_app_ids
             FROM teams_conversation_refs r
            WHERE lower(r.bot_app_id) = $1
            ORDER BY r.updated_at DESC`,
          [wanted],
        );
        return rows.map((r) => ({
          conversationId: r.conversation_id,
          teamsType: r.teams_type,
          name: r.name && r.name.trim().length > 0 ? r.name : null,
          updatedAt: r.updated_at,
          botAppIds: (r.bot_app_ids ?? []).filter((id) => id.length > 0),
        }));
      } catch (err) {
        // Same degradation as below: no table / transient failure reads as
        // "no chat this bot is known to be in". The picker then shows the
        // empty hint instead of an error, and nothing gets enabled blindly.
        log?.(
          `[conductor] bot-conversation lookup for '${wanted}' failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return [];
      }
    },
    async botAppIdsIn(conversationId) {
      try {
        const { rows } = await pool.query<{ bot_app_id: string }>(
          `SELECT DISTINCT lower(bot_app_id) AS bot_app_id
             FROM teams_conversation_refs
            WHERE conversation_id = $1 AND bot_app_id <> ''`,
          [conversationId],
        );
        return rows.map((r) => r.bot_app_id).filter((id) => id.length > 0);
      } catch (err) {
        // Missing table (a deployment that never ran 0031) or a transient
        // failure both mean "cannot prove presence". Returning empty is the
        // honest answer: it refuses a discussion rather than starting one whose
        // second voice may never arrive.
        log?.(
          `[conductor] bot-presence lookup for '${conversationId}' failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return [];
      }
    },
  };
}
