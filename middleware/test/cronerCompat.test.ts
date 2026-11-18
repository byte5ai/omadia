/**
 * croner 9.x compatibility layer — stored cron strings keep their 9.x
 * meaning under croner 11. Expected run lists were produced with croner
 * 9.1.0 against the same reference instant.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  LegacyCronSyntaxError,
  createCron,
  normalizeLegacyCron,
} from '../src/scheduler/cronerCompat.js';

const REF = new Date('2026-11-18T10:07:30Z'); // Wednesday

function nextRuns(pattern: string, count = 4): string[] {
  const job = createCron(pattern, { paused: true, timezone: 'UTC' });
  try {
    return job.nextRuns(count, REF).map((d) => d.toISOString().slice(0, 16));
  } finally {
    job.stop();
  }
}

describe('createCron — numeric-prefix stepping (croner 9.x semantics)', () => {
  it('N/S in minutes steps from N to the field maximum', () => {
    assert.deepEqual(nextRuns('0/15 * * * *'), [
      '2026-11-18T10:15',
      '2026-11-18T10:30',
      '2026-11-18T10:45',
      '2026-11-18T11:00',
    ]);
    assert.deepEqual(nextRuns('5/15 * * * *'), [
      '2026-11-18T10:20',
      '2026-11-18T10:35',
      '2026-11-18T10:50',
      '2026-11-18T11:05',
    ]);
    assert.deepEqual(nextRuns('30/30 * * * *', 2), ['2026-11-18T10:30', '2026-11-18T11:30']);
  });

  it('missing prefix (/S) means */S', () => {
    assert.deepEqual(nextRuns('/10 * * * *', 2), ['2026-11-18T10:10', '2026-11-18T10:20']);
  });

  it('N/S works in hour, month and day-of-week fields', () => {
    assert.deepEqual(nextRuns('0 0/2 * * *', 2), ['2026-11-18T12:00', '2026-11-18T14:00']);
    assert.deepEqual(nextRuns('0 9 * * 5/2', 2), ['2026-11-20T09:00', '2026-11-27T09:00']);
    assert.deepEqual(nextRuns('0 9 1 JAN/3 *', 2), ['2027-01-01T09:00', '2027-04-01T09:00']);
  });

  it('leaves standard patterns untouched', () => {
    assert.deepEqual(nextRuns('*/15 9 * * 1-5', 2), ['2026-11-19T09:00', '2026-11-19T09:15']);
    assert.deepEqual(nextRuns('0 9 * * MON-FRI', 3), [
      '2026-11-19T09:00',
      '2026-11-20T09:00',
      '2026-11-23T09:00',
    ]);
    assert.deepEqual(nextRuns('0 12 * * 5#L', 1), ['2026-11-27T12:00']);
    assert.deepEqual(nextRuns('0 9 L * *', 1), ['2026-11-30T09:00']);
  });

  it('still rejects what croner 9.x rejected', () => {
    for (const bad of ['*/0 * * * *', '5-50/0 * * * *', '99 * * * *', '* * * *', 'not a cron']) {
      assert.throws(() => createCron(bad, { paused: true }), bad);
    }
  });
});

describe('normalizeLegacyCron — `?` means "value at construction time" (croner 9.x)', () => {
  // Local-time constructor: the substitution reads local fields, like 9.x.
  const NOW = new Date(2026, 10, 18, 10, 13, 45); // Wed 18 Nov 2026 10:13:45

  it('replaces ? in every 5-field position with the current value', () => {
    assert.equal(normalizeLegacyCron('? * * * *', NOW), '13 * * * *');
    assert.equal(normalizeLegacyCron('0 ? * * *', NOW), '0 10 * * *');
    assert.equal(normalizeLegacyCron('0 9 ? * *', NOW), '0 9 18 * *');
    assert.equal(normalizeLegacyCron('0 9 1 ? *', NOW), '0 9 1 11 *');
    assert.equal(normalizeLegacyCron('0 9 * * ?', NOW), '0 9 * * 3');
  });

  it('handles day-of-month and day-of-week together (OR logic as in 9.x)', () => {
    assert.equal(normalizeLegacyCron('0 9 ? * MON', NOW), '0 9 18 * MON');
    assert.equal(normalizeLegacyCron('0 9 1 * ?', NOW), '0 9 1 * 3');
    assert.equal(normalizeLegacyCron('0 9 ? ? ?', NOW), '0 9 18 11 3');
  });

  it('6-field patterns substitute seconds too', () => {
    assert.equal(normalizeLegacyCron('? ? * * * *', NOW), '45 13 * * * *');
  });

  it('only the first ? per field is a placeholder; ?/S and ranges keep working', () => {
    assert.equal(normalizeLegacyCron('?/5 * * * *', NOW), '13/5 * * * *');
    assert.equal(normalizeLegacyCron('0 ?-20 * * *', NOW), '0 10-20 * * *');
    assert.throws(() => normalizeLegacyCron('?,? * * * *', NOW), LegacyCronSyntaxError);
  });

  it('passes through patterns without ?, nicknames and 7-field patterns', () => {
    assert.equal(normalizeLegacyCron('*/5 * * * *', NOW), '*/5 * * * *');
    assert.equal(normalizeLegacyCron('@weekly', NOW), '@weekly');
    assert.equal(normalizeLegacyCron('0 0 9 ? * * 2027', NOW), '0 0 9 ? * * 2027');
  });

  it('collapses irregular whitespace like the croner parser does', () => {
    assert.equal(normalizeLegacyCron('  0   9 ?  * MON ', NOW), '0 9 18 * MON');
  });

  it('createCron applies the substitution (0 9 ? * * is not daily)', () => {
    const job = createCron('0 9 ? * *', { paused: true });
    try {
      const runs = job.nextRuns(2, REF);
      assert.equal(runs.length, 2);
      // Same day-of-month each time = monthly, as under croner 9.x.
      assert.equal(runs[0]!.getDate(), runs[1]!.getDate());
    } finally {
      job.stop();
    }
  });
});
