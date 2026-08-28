// Persistence for ephemeral attachments (#330 C2a): the auto-provisioned
// conversation binding + per-conversation initiator role tied to one
// facilitation. Lifecycle mirrors the ephemeral workflow — 'pending' from
// auto-bind until facilitation_start, 'attached' once a workflow exists,
// gone after the reap callback (or the pending-expiry sweep) cleaned up.

import type { Pool } from 'pg';

export interface EphemeralAttachment {
  id: string;
  workflowId: string | null;
  agentSlug: string;
  channelType: string;
  channelKey: string;
  roleKey: string | null;
  state: 'pending' | 'attached';
  expiresAt: Date;
}

interface AttachmentRow {
  id: string;
  workflow_id: string | null;
  agent_slug: string;
  channel_type: string;
  channel_key: string;
  role_key: string | null;
  state: 'pending' | 'attached';
  expires_at: Date;
}

const COLS = 'id, workflow_id, agent_slug, channel_type, channel_key, role_key, state, expires_at';

function toAttachment(r: AttachmentRow): EphemeralAttachment {
  return {
    id: String(r.id),
    workflowId: r.workflow_id,
    agentSlug: r.agent_slug,
    channelType: r.channel_type,
    channelKey: r.channel_key,
    roleKey: r.role_key,
    state: r.state,
    expiresAt: r.expires_at,
  };
}

export class ConductorEphemeralAttachmentsStore {
  constructor(private readonly pool: Pool) {}

  /** Record the auto-bind for a conversation. Idempotent per conversation:
   *  a repeated invite refreshes the pending expiry (and re-stamps the owning
   *  agent, review L2) but never resets an 'attached' row back to pending —
   *  the running facilitation owns it. */
  async upsertPending(input: {
    agentSlug: string;
    channelType: string;
    channelKey: string;
    expiresAt: Date;
  }): Promise<EphemeralAttachment> {
    const r = await this.pool.query<AttachmentRow>(
      `INSERT INTO conductor_ephemeral_attachments (agent_slug, channel_type, channel_key, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (channel_type, channel_key) DO UPDATE
         SET expires_at = CASE
               WHEN conductor_ephemeral_attachments.state = 'pending' THEN EXCLUDED.expires_at
               ELSE conductor_ephemeral_attachments.expires_at
             END,
             agent_slug = CASE
               WHEN conductor_ephemeral_attachments.state = 'pending' THEN EXCLUDED.agent_slug
               ELSE conductor_ephemeral_attachments.agent_slug
             END
       RETURNING ${COLS}`,
      [input.agentSlug, input.channelType, input.channelKey, input.expiresAt],
    );
    return toAttachment(r.rows[0]!);
  }

  /** Tie the attachment to its facilitation run. Guarded (review M1): only a
   *  'pending' row owned by the SAME agent can be attached — a foreign or
   *  already-attached row is left untouched (undefined return). */
  async attachToWorkflow(input: {
    agentSlug: string;
    channelType: string;
    channelKey: string;
    workflowId: string;
    roleKey: string | null;
    expiresAt: Date;
  }): Promise<EphemeralAttachment | undefined> {
    const r = await this.pool.query<AttachmentRow>(
      `UPDATE conductor_ephemeral_attachments
          SET workflow_id = $4, role_key = $5, state = 'attached', expires_at = $6
        WHERE channel_type = $2 AND channel_key = $3
          AND agent_slug = $1 AND state = 'pending'
      RETURNING ${COLS}`,
      [input.agentSlug, input.channelType, input.channelKey, input.workflowId, input.roleKey, input.expiresAt],
    );
    return r.rows[0] ? toAttachment(r.rows[0]) : undefined;
  }

  async getByConversation(channelType: string, channelKey: string): Promise<EphemeralAttachment | undefined> {
    const r = await this.pool.query<AttachmentRow>(
      `SELECT ${COLS} FROM conductor_ephemeral_attachments
        WHERE channel_type = $1 AND channel_key = $2`,
      [channelType, channelKey],
    );
    return r.rows[0] ? toAttachment(r.rows[0]) : undefined;
  }

  /** #330 field report — restart rehydration: the agent's own non-expired
   *  attachments. Expired rows are the sweep's business, not the caller's. */
  async listByAgent(agentSlug: string, now: Date): Promise<EphemeralAttachment[]> {
    const r = await this.pool.query<AttachmentRow>(
      `SELECT ${COLS} FROM conductor_ephemeral_attachments
        WHERE agent_slug = $1 AND expires_at > $2
        ORDER BY created_at ASC`,
      [agentSlug, now],
    );
    return r.rows.map(toAttachment);
  }

  async getByWorkflow(workflowId: string): Promise<EphemeralAttachment[]> {
    const r = await this.pool.query<AttachmentRow>(
      `SELECT ${COLS} FROM conductor_ephemeral_attachments WHERE workflow_id = $1`,
      [workflowId],
    );
    return r.rows.map(toAttachment);
  }

  /** Pending rows past their expiry — invites that never became a
   *  facilitation. The sweep unbinds them so a blank invite cannot hold a
   *  group's conversation binding forever. */
  async listExpiredPending(now: Date): Promise<EphemeralAttachment[]> {
    const r = await this.pool.query<AttachmentRow>(
      `SELECT ${COLS} FROM conductor_ephemeral_attachments
        WHERE state = 'pending' AND expires_at <= $1`,
      [now],
    );
    return r.rows.map(toAttachment);
  }

  /** Attached rows past their expiry — the RETRY path (review H2): a row only
   *  disappears after successful cleanup, so an attachment whose reap-time
   *  disposal failed (or ran before the cleanup impl was wired at boot) is
   *  picked up again here once its workflow TTL horizon has passed. */
  async listExpiredAttached(now: Date): Promise<EphemeralAttachment[]> {
    const r = await this.pool.query<AttachmentRow>(
      `SELECT ${COLS} FROM conductor_ephemeral_attachments
        WHERE state = 'attached' AND expires_at <= $1`,
      [now],
    );
    return r.rows.map(toAttachment);
  }

  async delete(id: string): Promise<void> {
    await this.pool.query('DELETE FROM conductor_ephemeral_attachments WHERE id = $1', [id]);
  }
}
