import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_INSTALL_ATTEMPTS,
  clearUpdateAttempts,
  installKeepsFailing,
  nextAttempt,
  readUpdateAttempts,
  writeUpdateAttempts,
} from '../src/updateAttempts.ts';

function tmpMarker(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omadia-update-attempts-'));
  return path.join(dir, 'update-attempts.json');
}

test('a missing marker reads as no history', () => {
  assert.equal(readUpdateAttempts(tmpMarker()), null);
});

test('a marker round-trips', () => {
  const file = tmpMarker();
  writeUpdateAttempts(file, { version: '0.140.1', attempts: 1, lastAttemptAt: 'now' });
  assert.deepEqual(readUpdateAttempts(file), {
    version: '0.140.1',
    attempts: 1,
    lastAttemptAt: 'now',
  });
});

test('a corrupt marker reads as no history instead of throwing', () => {
  const file = tmpMarker();
  fs.writeFileSync(file, 'not json at all', 'utf8');
  assert.equal(readUpdateAttempts(file), null);
});

test('a structurally wrong marker reads as no history', () => {
  const file = tmpMarker();
  fs.writeFileSync(file, JSON.stringify({ version: 42, attempts: 'lots' }), 'utf8');
  assert.equal(readUpdateAttempts(file), null);
});

test('clearing a marker is idempotent and safe when absent', () => {
  const file = tmpMarker();
  clearUpdateAttempts(file);
  writeUpdateAttempts(file, { version: '0.140.1', attempts: 1, lastAttemptAt: '' });
  clearUpdateAttempts(file);
  clearUpdateAttempts(file);
  assert.equal(readUpdateAttempts(file), null);
});

test('attempts accumulate for the same version', () => {
  const first = nextAttempt(null, '0.140.1', new Date('2026-08-28T10:07:31Z'));
  assert.equal(first.attempts, 1);
  const second = nextAttempt(first, '0.140.1', new Date('2026-08-28T10:14:11Z'));
  assert.equal(second.attempts, 2);
  assert.equal(second.lastAttemptAt, '2026-08-28T10:14:11.000Z');
});

test('a different version starts counting again', () => {
  const previous = { version: '0.140.1', attempts: 2, lastAttemptAt: '' };
  assert.equal(nextAttempt(previous, '0.141.0', new Date()).attempts, 1);
});

test('no history means nothing is failing', () => {
  assert.equal(installKeepsFailing(null, '0.140.1', '0.139.1'), false);
});

test('a single failed attempt is not yet a verdict', () => {
  const record = { version: '0.140.1', attempts: 1, lastAttemptAt: '' };
  assert.equal(installKeepsFailing(record, '0.140.1', '0.139.1'), false);
});

test('repeated attempts on a version we are still not running is the loop', () => {
  // The reported case: 0.140.1 handed to the installer while the machine stayed
  // on 0.139.1 (#926).
  const record = { version: '0.140.1', attempts: MAX_INSTALL_ATTEMPTS, lastAttemptAt: '' };
  assert.equal(installKeepsFailing(record, '0.140.1', '0.139.1'), true);
});

test('a successful install is never reported as failing', () => {
  const record = { version: '0.140.1', attempts: 5, lastAttemptAt: '' };
  assert.equal(installKeepsFailing(record, '0.140.1', '0.140.1'), false);
});

test('history for an older version does not block a newer one', () => {
  const record = { version: '0.140.1', attempts: 5, lastAttemptAt: '' };
  assert.equal(installKeepsFailing(record, '0.141.0', '0.139.1'), false);
});
