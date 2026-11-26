import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  checkCronSchedule,
  cronMatchesInZone,
  formatInTimeZone,
  isValidTimeZone,
  nextCronRun,
  resolveTimeZone,
  zonedCalendarParts,
} from '../src/scheduler/zonedCron.js';

// 2026-11-26 10:00 UTC = 11:00 in Berlin (CET, winter).
const NOW = new Date('2026-11-26T10:00:00Z');

describe('zonedCron (#1743 / #1714, ADR 0240)', () => {
  it('validates and resolves IANA zones, falling back to UTC', () => {
    assert.equal(isValidTimeZone('Europe/Berlin'), true);
    assert.equal(isValidTimeZone('Mars/Base'), false);
    assert.equal(isValidTimeZone(''), false);
    assert.equal(resolveTimeZone(undefined, 'Nope/Zone', 'Europe/Berlin'), 'Europe/Berlin');
    assert.equal(resolveTimeZone(null, undefined), 'UTC');
  });

  it('evaluates a pattern on the wall clock of its zone', () => {
    const next = nextCronRun('0 9 * * *', 'Europe/Berlin', NOW);
    assert.equal(next?.toISOString(), '2026-11-27T08:00:00.000Z');
    assert.equal(formatInTimeZone(next!, 'Europe/Berlin'), '2026-11-27 09:00 (Europe/Berlin)');
    // Summer time moves the UTC instant, not the wall clock.
    const summer = nextCronRun('0 9 * * *', 'Europe/Berlin', new Date('2026-07-01T00:00:00Z'));
    assert.equal(summer?.toISOString(), '2026-07-01T07:00:00.000Z');
  });

  it('matches the minimal matcher against the zone wall clock (Conductor minute poll)', () => {
    const at = new Date('2026-11-27T08:00:00Z');
    assert.equal(cronMatchesInZone('0 9 * * *', at, 'Europe/Berlin'), true);
    assert.equal(cronMatchesInZone('0 9 * * *', at, 'UTC'), false);
    assert.equal(cronMatchesInZone('0 8 * * *', at, 'UTC'), true);
    assert.equal(zonedCalendarParts(at, 'Europe/Berlin').weekday, 5);
  });

  it('accepts a recurring 5-field pattern and reports its next run', () => {
    const r = checkCronSchedule('0 9 * * 1-5', 'Europe/Berlin', NOW, { minGapSeconds: 900 });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.timeZone, 'Europe/Berlin');
      assert.equal(r.nextRun.toISOString(), '2026-11-27T08:00:00.000Z');
    }
  });

  for (const [cron, code] of [
    ['0 9 31 2 *', 'fires_at_most_once'],
    ['@daily', 'unsupported_syntax'],
    ['0 9 * * 5L', 'unsupported_syntax'],
    ['2026-12-01T09:00:00', 'unsupported_syntax'],
    ['? ? * * *', 'question_mark'],
    ['* * * * *', 'too_frequent'],
    ['not a cron', 'unsupported_syntax'],
  ] as const) {
    it(`refuses '${cron}' as ${code}`, () => {
      const r = checkCronSchedule(cron, 'Europe/Berlin', NOW, { minGapSeconds: 900 });
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.code, code);
    });
  }

  it('refuses an unknown zone', () => {
    const r = checkCronSchedule('0 9 * * *', 'Mars/Base', NOW);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'invalid_timezone');
  });
});
