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

/** Lower-cased Entra app ids of the bots with a reference in a conversation. */
export interface BotPresenceStore {
  botAppIdsIn(conversationId: string): Promise<readonly string[]>;
}

export function createBotPresenceStore(pool: Pool, log?: (msg: string) => void): BotPresenceStore {
  return {
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
