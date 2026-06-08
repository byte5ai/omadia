/**
 * Agent Builder P6 — cron matcher.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cronMatches, isValidCron } from '../src/scheduler/cron.js';

// 2026-06-08T09:30:00Z is a Monday (getUTCDay === 1).
const MON_0930 = new Date('2026-06-08T09:30:00Z');

test('wildcard every minute always matches', () => {
  assert.equal(cronMatches('* * * * *', MON_0930), true);
});

test('exact minute+hour matches and near-misses do not', () => {
  assert.equal(cronMatches('30 9 * * *', MON_0930), true);
  assert.equal(cronMatches('31 9 * * *', MON_0930), false);
  assert.equal(cronMatches('30 10 * * *', MON_0930), false);
});

test('step and range fields', () => {
  assert.equal(cronMatches('*/15 * * * *', MON_0930), true); // 30 % 15 === 0
  assert.equal(cronMatches('*/7 * * * *', MON_0930), false); // 30 % 7 !== 0
  assert.equal(cronMatches('0-45 9 * * *', MON_0930), true);
  assert.equal(cronMatches('0,15,30,45 9 * * *', MON_0930), true);
});

test('day-of-week (Sunday is both 0 and 7)', () => {
  assert.equal(cronMatches('30 9 * * 1', MON_0930), true); // Monday
  assert.equal(cronMatches('30 9 * * 0', MON_0930), false); // Sunday
  const sun = new Date('2026-06-07T09:30:00Z'); // Sunday
  assert.equal(cronMatches('30 9 * * 7', sun), true);
  assert.equal(cronMatches('30 9 * * 0', sun), true);
});

test('timezone projection: 09:00 fires at local wall-clock, not UTC', () => {
  // 2026-06-08T07:30Z = 09:30 in Europe/Berlin (CEST, UTC+2).
  const utc0730 = new Date('2026-06-08T07:30:00Z');
  assert.equal(cronMatches('30 9 * * *', utc0730, 'Europe/Berlin'), true);
  assert.equal(cronMatches('30 9 * * *', utc0730, 'UTC'), false);
  assert.equal(cronMatches('30 7 * * *', utc0730, 'UTC'), true);
});

test('invalid timezone falls back to UTC', () => {
  assert.equal(cronMatches('30 9 * * *', MON_0930, 'Not/AZone'), true);
});

test('isValidCron rejects malformed expressions', () => {
  assert.equal(isValidCron('* * * * *'), true);
  assert.equal(isValidCron('*/15 9 * * 1-5'), true);
  assert.equal(isValidCron('* * * *'), false); // 4 fields
  assert.equal(isValidCron('99 * * * *'), false); // out of range
  assert.equal(isValidCron('*/0 * * * *'), false); // bad step
});
