/**
 * #1743 / #1714 — cron patterns evaluated in a named IANA time zone (ADR 0240).
 *
 * A stored cron pattern says "09:00", which means nothing without a zone. The
 * kernel evaluated routines in the process zone (UTC on every container) and
 * Conductor schedules in UTC, and no surface said so. This module is the one
 * place that answers "when does this pattern fire, in which zone" for every
 * scheduler: routines (via their trigger), trigger `wake_every`, Conductor
 * schedules (minute poll, `cronMatchesInZone`).
 *
 * Pure apart from `Intl`; no clock of its own (callers pass `from`/`now`).
 */

import { cronMatches, isValidCron } from './cron.js';
import { createCron, LegacyCronSyntaxError } from './cronerCompat.js';

/** The zone a schedule falls back to when nothing better is known. */
export const UTC_ZONE = 'UTC';

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

/** Whether `tz` is an IANA zone this runtime knows. */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.trim() === '') return false;
  try {
    partsFormatter(tz);
    return true;
  } catch {
    return false;
  }
}

/**
 * The first valid zone among `candidates` (e.g. the creator's zone, then the
 * instance default), else UTC. Never throws: an invalid zone is skipped, not
 * guessed at.
 */
export function resolveTimeZone(...candidates: ReadonlyArray<string | null | undefined>): string {
  for (const c of candidates) if (isValidTimeZone(c)) return c;
  return UTC_ZONE;
}

export interface ZonedCalendarParts {
  readonly year: number;
  readonly month: number; // 1–12
  readonly day: number; // 1–31
  readonly hour: number; // 0–23
  readonly minute: number; // 0–59
  readonly weekday: number; // 0 = Sunday … 6
}

const WEEKDAYS: Readonly<Record<string, number>> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** The wall-clock parts of `date` in `timeZone`. Throws on an unknown zone. */
export function zonedCalendarParts(date: Date, timeZone: string): ZonedCalendarParts {
  const out: Record<string, string> = {};
  for (const p of partsFormatter(timeZone).formatToParts(date)) out[p.type] = p.value;
  return {
    year: Number(out['year']),
    month: Number(out['month']),
    day: Number(out['day']),
    hour: Number(out['hour']),
    minute: Number(out['minute']),
    weekday: WEEKDAYS[out['weekday'] ?? ''] ?? 0,
  };
}

/**
 * The minimal 5-field matcher of `cron.ts`, evaluated against the wall clock
 * of `timeZone` instead of UTC. For the Conductor's minute poll (#1714).
 */
export function cronMatchesInZone(expr: string, date: Date, timeZone: string): boolean {
  const p = zonedCalendarParts(date, timeZone);
  // `cronMatches` reads UTC parts; hand it a date whose UTC parts ARE the
  // zone's wall clock.
  return cronMatches(expr, new Date(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute)));
}

/** The next `count` runs of `cron` in `timeZone` after `from`. Throws on an invalid pattern. */
export function nextCronRuns(cron: string, timeZone: string, from: Date, count: number): Date[] {
  return createCron(cron, { timezone: timeZone }).nextRuns(count, from);
}

/** The next run of `cron` in `timeZone` after `from`, or undefined when it never fires again. */
export function nextCronRun(cron: string, timeZone: string, from: Date): Date | undefined {
  return nextCronRuns(cron, timeZone, from, 1)[0];
}

/** `2026-11-27 09:00 (Europe/Berlin)` — a run time as a person in that zone reads it. */
export function formatInTimeZone(date: Date, timeZone: string): string {
  const p = zonedCalendarParts(date, timeZone);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${String(p.year)}-${two(p.month)}-${two(p.day)} ${two(p.hour)}:${two(p.minute)} (${timeZone})`;
}

export type CronScheduleRefusal =
  | 'invalid_pattern'
  | 'invalid_timezone'
  | 'question_mark'
  | 'unsupported_syntax'
  | 'fires_at_most_once'
  | 'too_frequent';

export type CronScheduleCheck =
  | { readonly ok: true; readonly nextRun: Date; readonly timeZone: string; readonly minGapSeconds: number }
  | { readonly ok: false; readonly code: CronScheduleRefusal; readonly message: string };

/** Digits, `*`, `,`, `-`, `/` only: `parseInt('5L')` would read Quartz's
 *  "last Friday" as plain Friday. */
const PLAIN_PATTERN = /^[0-9*,\-/]+(\s+[0-9*,\-/]+){4}$/;

/** How many upcoming runs are sampled for the gap check (covers a year of a monthly pattern). */
const SAMPLE_RUNS = 16;

/**
 * #1750 — everything a recurring schedule must satisfy before it is stored,
 * checked synchronously so the caller can refuse it with a reason:
 *
 *  - the zone is a known IANA zone;
 *  - the pattern parses and contains no `?` (croner 9.x read it as "the value
 *    at construction", so it moved with every restart — never accepted for
 *    new schedules; stored ones keep their legacy meaning, see `cronerCompat`);
 *  - it is a plain 5-field pattern (minute hour day month weekday): the
 *    trigger engine validates with the minimal matcher of `cron.ts`, so a
 *    nickname (`@daily`) or a Quartz extension (`5L`, `W`, `#`) that croner
 *    would accept was stored here and then refused when it was scheduled;
 *  - it fires at least twice (a pattern that fires once or never is a
 *    one-shot, not a routine);
 *  - its shortest gap is at least `minGapSeconds`.
 */
export function checkCronSchedule(
  cron: string,
  timeZone: string,
  now: Date,
  opts: { readonly minGapSeconds?: number } = {},
): CronScheduleCheck {
  if (!isValidTimeZone(timeZone)) {
    return { ok: false, code: 'invalid_timezone', message: `'${timeZone}' is not an IANA time zone (e.g. Europe/Berlin)` };
  }
  if (cron.includes('?')) {
    return { ok: false, code: 'question_mark', message: "'?' is not supported in a cron pattern; use '*' or an explicit value" };
  }
  if (!PLAIN_PATTERN.test(cron.trim()) || !isValidCron(cron)) {
    return {
      ok: false,
      code: 'unsupported_syntax',
      message: `cron pattern '${cron}' must have exactly 5 fields (minute hour day-of-month month day-of-week) using numbers, '*', ranges, lists and steps; nicknames like @daily and L/W/# are not supported`,
    };
  }
  let runs: Date[];
  try {
    runs = nextCronRuns(cron, timeZone, now, SAMPLE_RUNS);
  } catch (err) {
    const why = err instanceof LegacyCronSyntaxError || err instanceof Error ? err.message : String(err);
    return { ok: false, code: 'invalid_pattern', message: `invalid cron pattern '${cron}': ${why}` };
  }
  if (runs.length < 2) {
    return {
      ok: false,
      code: 'fires_at_most_once',
      message: `cron pattern '${cron}' fires ${runs.length === 0 ? 'never' : 'only once'} from now on; a routine must recur`,
    };
  }
  let minGap = Number.POSITIVE_INFINITY;
  for (let i = 1; i < runs.length; i += 1) {
    minGap = Math.min(minGap, ((runs[i] as Date).getTime() - (runs[i - 1] as Date).getTime()) / 1000);
  }
  const floor = opts.minGapSeconds ?? 0;
  if (minGap < floor) {
    return {
      ok: false,
      code: 'too_frequent',
      message: `cron pattern '${cron}' runs every ${formatGap(minGap)}; the minimum is every ${formatGap(floor)}`,
    };
  }
  return { ok: true, nextRun: runs[0] as Date, timeZone, minGapSeconds: minGap };
}

function formatGap(seconds: number): string {
  if (seconds % 3600 === 0 && seconds >= 3600) return `${String(seconds / 3600)} h`;
  if (seconds % 60 === 0 && seconds >= 60) return `${String(seconds / 60)} min`;
  return `${String(seconds)} s`;
}
