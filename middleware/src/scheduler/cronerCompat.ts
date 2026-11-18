import { Cron, type CronCallback, type CronOptions } from 'croner';

/**
 * croner 9.x compatibility layer for every `new Cron(...)` in the kernel.
 *
 * Cron strings are persisted (routines in Postgres, plugin job specs in
 * manifests) and were validated against croner 9.x when they were stored.
 * croner 10/11 changed two things that would silently break or re-mean them:
 *
 *  1. Numeric-prefix stepping (`0/15`, `5/15`, `/10`) is rejected by default.
 *     croner's own `sloppyRanges: true` restores the 9.x parser exactly
 *     (`N/S` = from N to the field maximum in steps of S, `/S` = `*\/S`).
 *  2. `?` is a plain `*` alias. In 9.x the first `?` in each field was
 *     replaced by the current time's value of that field when the job was
 *     constructed (seconds, minutes, hours, day-of-month, month, weekday —
 *     local time, as we pass no timezone), and any further `?` was an
 *     illegal character. {@link normalizeLegacyCron} reproduces that.
 *
 * New syntax croner 11 added (7-field years, `W`, `+`, `@midnight`) passes
 * through unchanged.
 */

const LEGACY_OPTIONS = { sloppyRanges: true } as const satisfies CronOptions;

/** Field count (5 = no seconds, 6 = with seconds) croner 9.x accepted. */
const LEGACY_FIELD_COUNTS: ReadonlySet<number> = new Set([5, 6]);

export class LegacyCronSyntaxError extends TypeError {}

function legacyFieldValues(now: Date): readonly number[] {
  return [
    now.getSeconds(),
    now.getMinutes(),
    now.getHours(),
    now.getDate(),
    now.getMonth() + 1,
    now.getDay(),
  ];
}

/**
 * Rewrite `?` the way croner 9.x interpreted it. Patterns without `?`, and
 * patterns 9.x could not parse anyway (nicknames, 7 fields), come back
 * untouched.
 */
export function normalizeLegacyCron(pattern: string, now: Date = new Date()): string {
  if (!pattern.includes('?') || pattern.includes('@')) return pattern;
  const fields = pattern.trim().split(/\s+/);
  if (!LEGACY_FIELD_COUNTS.has(fields.length)) return pattern;

  const values = legacyFieldValues(now);
  const offset = fields.length === 5 ? 1 : 0; // 5-field patterns have no seconds
  const rewritten = fields.map((field, i) => field.replace('?', String(values[i + offset])));
  if (rewritten.some((field) => field.includes('?'))) {
    throw new LegacyCronSyntaxError(
      `CronPattern: '${pattern}' uses '?' more than once in a field, which is not allowed.`,
    );
  }
  return rewritten.join(' ');
}

/** `new Cron(...)` with croner 9.x pattern semantics. */
export function createCron(
  pattern: string,
  options: CronOptions = {},
  fn?: CronCallback,
): Cron {
  const merged = { ...options, ...LEGACY_OPTIONS };
  const normalized = normalizeLegacyCron(pattern);
  return fn ? new Cron(normalized, merged, fn) : new Cron(normalized, merged);
}
