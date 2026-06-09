/**
 * Minimal standard 5-field cron matcher (Agent Builder P6).
 *
 * Fields: minute hour day-of-month month day-of-week. Each field supports
 * a wildcard, a step ("wildcard/n"), an "a-b" range, "a-b/n", and comma lists
 * of those. Day-of-week 0 and 7 both mean Sunday. Evaluated against the supplied
 * `Date`'s UTC parts (timezone handling is a future enhancement — schedules
 * default to UTC).
 *
 * Pure + dependency-free so it unit-tests without a clock or a DB.
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

export function cronMatches(expr: string, date: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;

  const minute = date.getUTCMinutes();
  const hour = date.getUTCHours();
  const dom = date.getUTCDate();
  const month = date.getUTCMonth() + 1;
  const dow = date.getUTCDay(); // 0..6, Sunday = 0

  const values = [minute, hour, dom, month, dow];
  for (let i = 0; i < 5; i++) {
    const set = expandField(fields[i]!, RANGES[i]![0], RANGES[i]![1]);
    if (!set.has(values[i]!)) return false;
  }
  return true;
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
