import type { Pool } from 'pg';

/**
 * Maps a user (in Conductor's identity space — the same id used as a role holder / await responder,
 * e.g. session.sub / email / channel-native id) to the opaque channel conversation reference needed
 * to proactively reach them (US5 reminders). Populated per inbound turn from the kernel-side
 * `captureRoutineTurn` hook; read by the await worker when sending a reminder.
 *
 * IDENTITY CONTRACT: the `userId` key here MUST be the same id a human step's principal resolves to
 * (a `user:<id>` ref, or a role holder id). The capture hook writes the channel-native turn user id;
 * delivery therefore resolves only when role/user principals are expressed in that same id space —
 * otherwise the reminder is flagged `unreachable` (never silently dropped, never a hang).
 */
export class ConductorChannelBindingStore {
  constructor(private readonly pool: Pool) {}

  /** Upsert a user's conversation reference for a channel (idempotent per inbound turn). */
  async upsert(userId: string, channelType: string, conversationRef: unknown): Promise<void> {
    if (!userId || !channelType) return;
    await this.pool.query(
      `INSERT INTO conductor_channel_bindings (user_id, channel_type, conversation_ref)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (user_id, channel_type)
         DO UPDATE SET conversation_ref = EXCLUDED.conversation_ref, updated_at = now()`,
      [userId, channelType, JSON.stringify(conversationRef ?? null)],
    );
  }

  /** The conversation reference to reach `userId` on `channelType`, or null if none is bound. */
  async get(userId: string, channelType: string): Promise<unknown | null> {
    const r = await this.pool.query<{ conversation_ref: unknown }>(
      `SELECT conversation_ref FROM conductor_channel_bindings WHERE user_id = $1 AND channel_type = $2`,
      [userId, channelType],
    );
    return r.rows[0]?.conversation_ref ?? null;
  }

  /** Conversation references for many users on one channel in a single query (reminder fan-out). */
  async getMany(userIds: string[], channelType: string): Promise<Map<string, unknown>> {
    const out = new Map<string, unknown>();
    if (userIds.length === 0) return out;
    const r = await this.pool.query<{ user_id: string; conversation_ref: unknown }>(
      `SELECT user_id, conversation_ref FROM conductor_channel_bindings
        WHERE channel_type = $2 AND user_id = ANY($1::text[])`,
      [userIds, channelType],
    );
    for (const row of r.rows) out.set(row.user_id, row.conversation_ref);
    return out;
  }
}
