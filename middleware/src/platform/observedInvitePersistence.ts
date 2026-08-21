// Write-through backing store for the kernel-side invite index (#330
// follow-up). The in-memory map in ObservedConversationInvites stays the hot
// path; this store only makes it survive restarts — a deploy between the
// Teams invite and the facilitation start must not force a re-invite.

import type { Pool } from 'pg';

import type { ObservedInvite } from './observedConversationInvites.js';

export interface PersistedInviteRow {
  /** Key columns — authoritative for map keys and deletes. The JSONB payload
   *  must agree with them; hydration drops rows where it does not. */
  channelType: string;
  conversationId: string;
  invite: ObservedInvite;
  seenAt: number;
}

export interface ObservedInvitePersistence {
  upsert(invite: ObservedInvite, seenAtMs: number): Promise<void>;
  delete(channelType: string, conversationId: string): Promise<void>;
  /** Rows seen at or after `minSeenAtMs`; anything older is pruned. */
  loadFresh(minSeenAtMs: number): Promise<PersistedInviteRow[]>;
}

export class PgObservedInvitePersistence implements ObservedInvitePersistence {
  constructor(private readonly pool: Pool) {}

  async upsert(invite: ObservedInvite, seenAtMs: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO observed_conversation_invites (channel_type, conversation_id, invite, seen_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (channel_type, conversation_id)
       DO UPDATE SET invite = EXCLUDED.invite, seen_at = EXCLUDED.seen_at`,
      [invite.channelType, invite.conversationId, JSON.stringify(invite), seenAtMs],
    );
  }

  async delete(channelType: string, conversationId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM observed_conversation_invites WHERE channel_type = $1 AND conversation_id = $2`,
      [channelType, conversationId],
    );
  }

  async loadFresh(minSeenAtMs: number): Promise<PersistedInviteRow[]> {
    // Prune first so the table stays bounded by the TTL, not by history.
    await this.pool.query(`DELETE FROM observed_conversation_invites WHERE seen_at < $1`, [minSeenAtMs]);
    const r = await this.pool.query<{
      channel_type: string;
      conversation_id: string;
      invite: ObservedInvite;
      seen_at: string;
    }>(`SELECT channel_type, conversation_id, invite, seen_at FROM observed_conversation_invites`);
    return r.rows.map((row) => ({
      channelType: row.channel_type,
      conversationId: row.conversation_id,
      invite: row.invite,
      seenAt: Number(row.seen_at),
    }));
  }
}
