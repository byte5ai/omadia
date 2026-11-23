/**
 * Spec 2042 §5.12 "Same rules as any turn", criterion 24 — recipient grants.
 *
 * A proactive message goes to the context its trigger was created in, or to
 * an explicit target an operator allowed for that agent: a recipient grant.
 * The grant names the conversation (channel + id) and carries the channel's
 * conversation reference the message is sent through, so neither the agent
 * nor its model ever supplies a delivery handle.
 *
 * A grant is checked at creation (the trigger is refused without one) and
 * again at every send (a revoked grant delivers nothing). The discretion of
 * the target's readers is checked at send time, with the roster of that
 * moment (`conversationReaders.ts`), never with a snapshot.
 */

import { createHash } from 'node:crypto';

import type { Pool } from 'pg';

import type { Trigger, TriggerTarget } from './types.js';

export interface RecipientGrant {
  readonly id: string;
  readonly agentId: string;
  readonly channel: string;
  readonly conversationId: string;
  readonly deliveryRef: unknown;
  readonly label: string | null;
  readonly grantedBy: string;
  readonly grantedAt: Date;
}

export interface NewRecipientGrant {
  readonly agentId: string;
  readonly channel: string;
  readonly conversationId: string;
  readonly deliveryRef: unknown;
  readonly label: string | null;
  readonly grantedBy: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A conversation id from a channel's opaque conversation reference.
 *
 * A Bot Framework reference (Teams) carries `conversation.id` AND a top-level
 * `channelId: 'msteams'` naming the platform, not the conversation: the
 * nested id wins over `channelId`, or every Teams chat would be "msteams".
 */
export function conversationIdOf(ref: unknown): string {
  if (isRecord(ref)) {
    for (const key of ['conversationId', 'sessionId', 'chatId']) {
      const v = ref[key];
      if (typeof v === 'string' && v.length > 0) return v;
    }
    const conv = ref['conversation'];
    if (isRecord(conv) && typeof conv['id'] === 'string' && conv['id'].length > 0) return conv['id'];
    for (const key of ['channelId', 'threadId']) {
      const v = ref[key];
      if (typeof v === 'string' && v.length > 0) return v;
    }
  }
  return `ref-${createHash('sha256').update(JSON.stringify(ref ?? null)).digest('hex').slice(0, 24)}`;
}

/** The conversation an explicit target names, or undefined for a person target. */
export function targetConversation(target: TriggerTarget): { readonly channel: string; readonly conversationId: string } | undefined {
  if (target.kind !== 'conversation') return undefined;
  return { channel: target.channel, conversationId: conversationIdOf(target.ref) };
}

/** Where a trigger's messages go: its explicit target, else its own context. */
export interface DeliveryAddress {
  readonly channel: string | null;
  readonly ref: unknown;
  /** The explicit target's conversation, when there is one. */
  readonly target?: { readonly channel: string; readonly conversationId: string };
}

export function deliveryAddressOf(trigger: Pick<Trigger, 'target' | 'deliveryChannel' | 'deliveryRef'>): DeliveryAddress {
  const target = trigger.target ? targetConversation(trigger.target) : undefined;
  if (trigger.target && target) return { channel: target.channel, ref: trigger.target.ref, target };
  return { channel: trigger.deliveryChannel, ref: trigger.deliveryRef };
}

interface GrantRow {
  id: string;
  agent_id: string;
  channel: string;
  conversation_id: string;
  delivery_ref: unknown;
  label: string | null;
  granted_by: string;
  granted_at: Date;
}

const toGrant = (r: GrantRow): RecipientGrant => ({
  id: r.id,
  agentId: r.agent_id,
  channel: r.channel,
  conversationId: r.conversation_id,
  deliveryRef: r.delivery_ref,
  label: r.label,
  grantedBy: r.granted_by,
  grantedAt: r.granted_at,
});

const COLUMNS = 'id, agent_id, channel, conversation_id, delivery_ref, label, granted_by, granted_at';

export class RecipientGrantStore {
  constructor(private readonly pool: Pool) {}

  async list(agentId?: string): Promise<RecipientGrant[]> {
    const { rows } = agentId
      ? await this.pool.query<GrantRow>(`SELECT ${COLUMNS} FROM agent_recipient_grants WHERE agent_id = $1 ORDER BY granted_at`, [agentId])
      : await this.pool.query<GrantRow>(`SELECT ${COLUMNS} FROM agent_recipient_grants ORDER BY agent_id, granted_at`);
    return rows.map(toGrant);
  }

  async get(id: string): Promise<RecipientGrant | undefined> {
    const { rows } = await this.pool.query<GrantRow>(`SELECT ${COLUMNS} FROM agent_recipient_grants WHERE id = $1`, [id]);
    return rows[0] ? toGrant(rows[0]) : undefined;
  }

  async find(agentId: string, channel: string, conversationId: string): Promise<RecipientGrant | undefined> {
    const { rows } = await this.pool.query<GrantRow>(
      `SELECT ${COLUMNS} FROM agent_recipient_grants WHERE agent_id = $1 AND channel = $2 AND conversation_id = $3`,
      [agentId, channel, conversationId],
    );
    return rows[0] ? toGrant(rows[0]) : undefined;
  }

  /** Grant (or re-grant with a new reference and label). */
  async grant(input: NewRecipientGrant): Promise<RecipientGrant> {
    const { rows } = await this.pool.query<GrantRow>(
      `INSERT INTO agent_recipient_grants (agent_id, channel, conversation_id, delivery_ref, label, granted_by)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)
       ON CONFLICT (agent_id, channel, conversation_id) DO UPDATE SET
         delivery_ref = EXCLUDED.delivery_ref, label = EXCLUDED.label,
         granted_by = EXCLUDED.granted_by, granted_at = now()
       RETURNING ${COLUMNS}`,
      [input.agentId, input.channel, input.conversationId, JSON.stringify(input.deliveryRef), input.label, input.grantedBy],
    );
    return toGrant(rows[0] as GrantRow);
  }

  async revoke(id: string): Promise<RecipientGrant | undefined> {
    const { rows } = await this.pool.query<GrantRow>(`DELETE FROM agent_recipient_grants WHERE id = $1 RETURNING ${COLUMNS}`, [id]);
    return rows[0] ? toGrant(rows[0]) : undefined;
  }

  /** Whether `agentId` may send to `target` right now. Person targets have no grant kind: never. */
  async allows(agentId: string, target: TriggerTarget): Promise<boolean> {
    const conv = targetConversation(target);
    if (!conv) return false;
    return (await this.find(agentId, conv.channel, conv.conversationId)) !== undefined;
  }
}
