/**
 * Minimal standard 5-field cron matcher (Agent Builder P6).
 *
 * Fields: minute hour day-of-month month day-of-week. Each field supports
 * a wildcard, a step ("wildcard/n"), an "a-b" range, "a-b/n", and comma lists
 * of those. Day-of-week 0 and 7 both mean Sunday. Evaluated against the
 * supplied `Date` projected into the given IANA timezone (default 'UTC') via
 * `Intl.DateTimeFormat` — so "0 9 * * *" in "Europe/Berlin" fires at Berlin
 * 09:00 regardless of server TZ or DST.
 *
 * Pure + dependency-free (Intl is built in) so it unit-tests without a clock
 * or a DB.
 */

const RANGES: ReadonlyArray<readonly [number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 6], // day of week (after 7→0 normalisation)
];

export function isValidCron(expr: string): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((f, i) => {
    try {
      return expandField(f, RANGES[i]![0], RANGES[i]![1]).size > 0;
    } catch {
      return false;
    }
  });
}

export function cronMatches(
  expr: string,
  date: Date,
  timezone = 'UTC',
): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;

  const { minute, hour, dom, month, dow } = zonedParts(date, timezone);
  const values = [minute, hour, dom, month, dow];
  for (let i = 0; i < 5; i++) {
    const set = expandField(fields[i]!, RANGES[i]![0], RANGES[i]![1]);
    if (!set.has(values[i]!)) return false;
  }
  return true;
}

const WEEKDAY_TO_NUM: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

interface ZonedParts {
  minute: number;
  hour: number;
  dom: number;
  month: number;
  dow: number;
}

/** Project a Date into a timezone's wall-clock fields. Falls back to UTC when
 *  the timezone id is invalid. */
export function zonedParts(date: Date, timezone: string): ZonedParts {
  if (timezone === 'UTC') {
    return {
      minute: date.getUTCMinutes(),
      hour: date.getUTCHours(),
      dom: date.getUTCDate(),
      month: date.getUTCMonth() + 1,
      dow: date.getUTCDay(),
    };
  }
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
    });
    const map: Record<string, string> = {};
    for (const p of fmt.formatToParts(date)) map[p.type] = p.value;
    return {
      minute: Number(map['minute']),
      hour: Number(map['hour']) % 24,
      dom: Number(map['day']),
      month: Number(map['month']),
      dow: WEEKDAY_TO_NUM[map['weekday'] ?? 'Sun'] ?? 0,
    };
  } catch {
    return {
      minute: date.getUTCMinutes(),
      hour: date.getUTCHours(),
      dom: date.getUTCDate(),
      month: date.getUTCMonth() + 1,
      dow: date.getUTCDay(),
    };
  }
}

function expandField(field: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    let step = 1;
    let body = part;
    const slash = part.indexOf('/');
    if (slash >= 0) {
      step = parseInt(part.slice(slash + 1), 10);
      body = part.slice(0, slash);
      if (!Number.isFinite(step) || step <= 0) {
        throw new Error(`bad step in "${part}"`);
      }
    }

    let lo = min;
    let hi = max;
    if (body !== '*') {
      const dash = body.indexOf('-');
      if (dash >= 0) {
        lo = parseInt(body.slice(0, dash), 10);
        hi = parseInt(body.slice(dash + 1), 10);
      } else {
        lo = parseInt(body, 10);
        hi = lo;
      }
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
        throw new Error(`bad range in "${part}"`);
      }
    }

    for (let v = lo; v <= hi; v += step) {
      // day-of-week: 7 → 0 (Sunday)
      const normalised = max === 6 && v === 7 ? 0 : v;
      if (normalised < min || normalised > max) {
        throw new Error(`value ${String(v)} out of [${String(min)},${String(max)}]`);
      }
      out.add(normalised);
    }
  }
  return out;
}
