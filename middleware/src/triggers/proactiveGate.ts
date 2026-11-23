/**
 * #2082 / #1035 — what a proactive message must pass before it goes out
 * (spec 2042 §5.12 "Same rules as any turn"), and the delivery itself.
 *
 *   - It goes to the context it was created in (the stored delivery target),
 *     or to an explicit target allowed by a recipient grant (criterion 24).
 *     The grant is checked at creation and again before every firing and
 *     every send; the message goes through the grant's current reference.
 *     The discretion check for the target's readers runs at send time
 *     (`kernelExecutors.ts`).
 *   - Quiet hours and a rate limit per recipient (the target, when there is
 *     one), from the recipient's profile or the instance default. A firing in
 *     quiet hours is deferred before anything runs: no data is read and
 *     nothing is spent. A live meeting is exempt: the people are there.
 */

import { createHash } from 'node:crypto';

import type { SemanticAnswer } from '@omadia/channel-sdk';
import type { Pool } from 'pg';

import type { ProactiveSenderRegistry } from '../plugins/routines/proactiveSender.js';
import { ownBotRefusal, type OwnChannelKey } from './ownBot.js';
import { deliveryAddressOf, targetConversation, type RecipientGrant } from './recipientGrants.js';
import type { SendWindow } from './triggerEngine.js';
import { isHeadless } from './headless.js';
import type { DeliveryOutcome } from './triggerChain.js';
import type { Trigger } from './types.js';

const HOUR_MS = 3_600_000;

export interface QuietHours {
  /** `HH:MM`, local to `timezone`. */
  readonly from: string;
  readonly to: string;
}

export interface RecipientProfile {
  readonly timezone: string;
  readonly quiet: QuietHours | null;
  readonly maxPerHour: number;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** `22:00-07:00` → quiet hours; empty or `off` → none. */
export function parseQuietHours(raw: string): QuietHours | null {
  const v = raw.trim();
  if (v === '' || v === 'off') return null;
  const [from, to] = v.split('-').map((s) => s.trim());
  if (!from || !to || !HHMM.test(from) || !HHMM.test(to) || from === to) {
    throw new Error(`quiet hours must look like 22:00-07:00, got '${raw}'`);
  }
  return { from, to };
}

const minutesOf = (hhmm: string): number => {
  const m = HHMM.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
};

function localMinutes(now: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return hour * 60 + minute;
}

/** When the quiet hours around `now` end, or undefined outside them. */
export function quietUntil(now: Date, timezone: string, quiet: QuietHours | null): Date | undefined {
  if (!quiet) return undefined;
  const local = localMinutes(now, timezone);
  const from = minutesOf(quiet.from);
  const to = minutesOf(quiet.to);
  const inside = from < to ? local >= from && local < to : local >= from || local < to;
  if (!inside) return undefined;
  const left = (to - local + 24 * 60) % (24 * 60);
  const end = new Date(now.getTime() + left * 60_000);
  end.setUTCSeconds(0, 0);
  return end;
}

/** The recipient a trigger's messages go to, as a stable key: the explicit
 *  target's conversation when there is one, else the trigger's own context. */
export function recipientKey(
  trigger: Pick<Trigger, 'contextKind' | 'contextId' | 'deliveryChannel' | 'deliveryRef'> & Partial<Pick<Trigger, 'target'>>,
): string {
  const target = trigger.target ? targetConversation(trigger.target) : undefined;
  if (target) return `${target.channel}:${target.conversationId}`;
  if (trigger.contextKind === 'conversation' || trigger.contextKind === 'meeting') return trigger.contextId;
  const ref = createHash('sha256').update(JSON.stringify(trigger.deliveryRef ?? null)).digest('hex').slice(0, 24);
  return `${trigger.deliveryChannel ?? 'none'}:ref:${ref}`;
}

export class RecipientProfileStore {
  constructor(private readonly pool: Pool) {}

  async get(key: string, defaults: RecipientProfile): Promise<RecipientProfile> {
    const { rows } = await this.pool.query<{
      timezone: string | null;
      quiet_from: string | null;
      quiet_to: string | null;
      max_per_hour: number | null;
    }>('SELECT timezone, quiet_from::text, quiet_to::text, max_per_hour FROM proactive_recipient_profiles WHERE recipient_key = $1', [key]);
    const r = rows[0];
    if (!r) return defaults;
    return {
      timezone: r.timezone ?? defaults.timezone,
      quiet: r.quiet_from && r.quiet_to ? { from: r.quiet_from.slice(0, 5), to: r.quiet_to.slice(0, 5) } : defaults.quiet,
      maxPerHour: r.max_per_hour ?? defaults.maxPerHour,
    };
  }

  async set(key: string, profile: Partial<RecipientProfile>, by: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO proactive_recipient_profiles (recipient_key, timezone, quiet_from, quiet_to, max_per_hour, updated_by)
       VALUES ($1, $2, $3::time, $4::time, $5, $6)
       ON CONFLICT (recipient_key) DO UPDATE SET
         timezone = EXCLUDED.timezone, quiet_from = EXCLUDED.quiet_from, quiet_to = EXCLUDED.quiet_to,
         max_per_hour = EXCLUDED.max_per_hour, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [key, profile.timezone ?? null, profile.quiet?.from ?? null, profile.quiet?.to ?? null, profile.maxPerHour ?? null, by],
    );
  }

  /** Deliveries to `key` since `since`, oldest first (at most `limit`). */
  async deliveriesSince(key: string, since: Date, limit: number): Promise<Date[]> {
    const { rows } = await this.pool.query<{ delivered_at: Date }>(
      'SELECT delivered_at FROM proactive_deliveries WHERE recipient_key = $1 AND delivered_at > $2 ORDER BY delivered_at LIMIT $3',
      [key, since, limit],
    );
    return rows.map((r) => r.delivered_at);
  }

  async recordDelivery(key: string, trigger: Pick<Trigger, 'id' | 'agentSlug'>, at: Date): Promise<void> {
    await this.pool.query(
      'INSERT INTO proactive_deliveries (recipient_key, trigger_id, agent_slug, delivered_at) VALUES ($1, $2, $3, $4)',
      [key, trigger.id, trigger.agentSlug, at],
    );
  }

  async purge(before: Date): Promise<number> {
    const { rowCount } = await this.pool.query('DELETE FROM proactive_deliveries WHERE delivered_at < $1', [before]);
    return rowCount ?? 0;
  }
}

export interface ProactiveGateDeps {
  readonly profiles: RecipientProfileStore;
  readonly defaults: RecipientProfile;
  readonly senders: () => ProactiveSenderRegistry | undefined;
  /** The agent's own bot on a channel (spec 2042 §5.3): a delivery ref that
   *  names a bot is delivered only while that bot is still the agent's. */
  readonly ownChannelKey?: OwnChannelKey;
  /** The recipient grant behind a trigger's explicit target, now (criterion
   *  24). Absent = no grants are wired: a target delivers nothing. */
  readonly grantFor?: (trigger: Trigger) => Promise<RecipientGrant | undefined>;
  readonly now?: () => Date;
  readonly log?: (message: string) => void;
}

export interface ProactiveGate {
  sendWindow(trigger: Trigger, now: Date): Promise<SendWindow>;
  send(trigger: Trigger, message: SemanticAnswer): Promise<DeliveryOutcome>;
}

export function createProactiveGate(deps: ProactiveGateDeps): ProactiveGate {
  const clock = deps.now ?? (() => new Date());
  /** Channel and reference a message goes through now; a string = why it may not go. */
  const addressOf = async (trigger: Trigger): Promise<{ channel: string; ref: unknown } | string> => {
    const address = deliveryAddressOf(trigger);
    if (!address.channel) return 'no delivery target';
    if (!address.target) return { channel: address.channel, ref: address.ref };
    const grant = await deps.grantFor?.(trigger);
    if (!grant) return 'target_not_granted';
    return { channel: grant.channel, ref: grant.deliveryRef };
  };
  return {
    async sendWindow(trigger, now) {
      // A schedule sends nothing: no recipient, no quiet hours, no rate limit.
      if (isHeadless(trigger)) return { ok: true };
      if (!trigger.deliveryChannel) return { ok: false, drop: 'no_delivery_target' };
      const address = await addressOf(trigger);
      if (typeof address === 'string') return { ok: false, drop: address === 'no delivery target' ? 'no_delivery_target' : address };
      // Before any model turn: a bot that is no longer the agent's (spec 2042 §5.3).
      if (ownBotRefusal(address.ref, trigger.agentSlug, address.channel, deps.ownChannelKey)) {
        return { ok: false, drop: 'bot_no_longer_agents' };
      }
      // A live meeting is exempt from quiet hours; a target elsewhere is not.
      if (trigger.liveContext && !trigger.target) return { ok: true };
      const key = recipientKey(trigger);
      const profile = await deps.profiles.get(key, deps.defaults);
      // A routine fires when its owner asked it to: their chosen time wins
      // over the default quiet hours. The rate limit still applies.
      const quietEnd = trigger.origin === 'routine' ? undefined : quietUntil(now, profile.timezone, profile.quiet);
      if (quietEnd) return { ok: false, deferUntil: quietEnd, reason: 'quiet_hours' };
      if (profile.maxPerHour <= 0) return { ok: false, drop: 'recipient_takes_no_proactive_messages' };
      const recent = await deps.profiles.deliveriesSince(key, new Date(now.getTime() - HOUR_MS), profile.maxPerHour);
      if (recent.length >= profile.maxPerHour) {
        const oldest = recent[0] as Date;
        return { ok: false, deferUntil: new Date(oldest.getTime() + HOUR_MS + 1000), reason: 'rate_limit' };
      }
      return { ok: true };
    },
    async send(trigger, message) {
      const address = await addressOf(trigger);
      if (typeof address === 'string') return { delivered: false, reason: address };
      const { channel, ref } = address;
      const sender = deps.senders()?.get(channel);
      if (!sender) return { delivered: false, reason: `no proactive sender for channel '${channel}'` };
      const refused = ownBotRefusal(ref, trigger.agentSlug, channel, deps.ownChannelKey);
      if (refused) return { delivered: false, reason: refused };
      try {
        await sender.checkDeliverable?.(ref);
        await sender.send({ conversationRef: ref, message });
      } catch (err) {
        return { delivered: false, reason: err instanceof Error ? err.message : String(err) };
      }
      await deps.profiles.recordDelivery(recipientKey(trigger), trigger, clock()).catch((err: unknown) => {
        deps.log?.(`[triggers] could not record a delivery: ${err instanceof Error ? err.message : String(err)}`);
      });
      return { delivered: true };
    },
  };
}
