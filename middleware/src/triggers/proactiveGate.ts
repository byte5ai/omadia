/**
 * #2082 / #1035 — what a proactive message must pass before it goes out
 * (spec 2042 §5.12 "Same rules as any turn"), and the delivery itself.
 *
 *   - It goes to the context it was created in (the stored delivery target).
 *     Any other target is refused at creation (`targetAllowed`): until the
 *     discretion flow rule (INV-9) can label contexts, a message born in one
 *     conversation never reaches another one.
 *   - Quiet hours and a rate limit per recipient, from the recipient's
 *     profile or the instance default. A firing in quiet hours is deferred
 *     before anything runs: no data is read and nothing is spent. A live
 *     meeting is exempt: the people are there.
 */

import { createHash } from 'node:crypto';

import type { SemanticAnswer } from '@omadia/channel-sdk';
import type { Pool } from 'pg';

import type { ProactiveSenderRegistry } from '../plugins/routines/proactiveSender.js';
import type { SendWindow } from './triggerEngine.js';
import type { DeliveryOutcome } from './triggerChain.js';
import type { Trigger } from './types.js';

const HOUR_MS = 3_600_000;
const MAX_TABLE_ROWS = 50;
const MAX_CELL = 200;

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

/** The recipient a trigger's messages go to, as a stable key. */
export function recipientKey(trigger: Pick<Trigger, 'contextKind' | 'contextId' | 'deliveryChannel' | 'deliveryRef'>): string {
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
  readonly now?: () => Date;
  readonly log?: (message: string) => void;
}

export interface ProactiveGate {
  sendWindow(trigger: Trigger, now: Date): Promise<SendWindow>;
  send(trigger: Trigger, message: SemanticAnswer): Promise<DeliveryOutcome>;
}

export function createProactiveGate(deps: ProactiveGateDeps): ProactiveGate {
  const clock = deps.now ?? (() => new Date());
  return {
    async sendWindow(trigger, now) {
      if (!trigger.deliveryChannel) return { ok: false, drop: 'no_delivery_target' };
      if (trigger.liveContext) return { ok: true };
      const key = recipientKey(trigger);
      const profile = await deps.profiles.get(key, deps.defaults);
      const quietEnd = quietUntil(now, profile.timezone, profile.quiet);
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
      const channel = trigger.deliveryChannel;
      if (!channel) return { delivered: false, reason: 'no delivery target' };
      const sender = deps.senders()?.get(channel);
      if (!sender) return { delivered: false, reason: `no proactive sender for channel '${channel}'` };
      try {
        await sender.checkDeliverable?.(trigger.deliveryRef);
        await sender.send({ conversationRef: trigger.deliveryRef, message });
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

const cell = (v: unknown): string => {
  const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  const flat = s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
  return flat.length > MAX_CELL ? `${flat.slice(0, MAX_CELL - 1)}…` : flat;
};

/**
 * The side-channel rendering of a data result as plain markdown: the rows go
 * from the tool straight to the recipients, no model in between.
 */
export function renderDataTable(rows: readonly unknown[], columns: readonly string[], title: string | undefined): string {
  const head = title ? `**${title}**\n\n` : '';
  if (rows.length === 0) return `${head}—`;
  const cols = columns.length > 0 ? columns : ['value'];
  const lines = [`| ${cols.map(cell).join(' | ')} |`, `| ${cols.map(() => '---').join(' | ')} |`];
  for (const row of rows.slice(0, MAX_TABLE_ROWS)) {
    const rec = typeof row === 'object' && row !== null && !Array.isArray(row) ? (row as Record<string, unknown>) : { value: row };
    lines.push(`| ${cols.map((c) => cell(rec[c])).join(' | ')} |`);
  }
  const more = rows.length > MAX_TABLE_ROWS ? `\n\n_… ${String(rows.length - MAX_TABLE_ROWS)} weitere_` : '';
  return `${head}${lines.join('\n')}${more}`;
}
