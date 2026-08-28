import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SNAPSHOT_PREFIX,
  parseSnapshotName,
  snapshotDirName,
  snapshotsToPrune,
} from '../src/snapshotRetention.ts';

const at = (iso: string): Date => new Date(iso);

test('a snapshot name carries the version and a filesystem-safe stamp', () => {
  const name = snapshotDirName('0.140.1', at('2026-08-28T13:05:32.119Z'));
  assert.equal(name, `${SNAPSHOT_PREFIX}0.140.1-20260828T130532119Z`);
  assert.equal(/[:.]/.test(name.slice(SNAPSHOT_PREFIX.length + '0.140.1'.length)), false);
});

test('two attempts on the same version get different directories', () => {
  const first = snapshotDirName('0.140.1', at('2026-08-28T10:11:17.000Z'));
  const second = snapshotDirName('0.140.1', at('2026-08-28T10:15:13.000Z'));
  // The regression this guards: the old scheme wrote both to the same name and
  // deleted the first one on the way in (#934).
  assert.notEqual(first, second);
});

test('names round-trip through the parser, dotted versions included', () => {
  const parsed = parseSnapshotName(snapshotDirName('1.2.3-rc.4', at('2026-01-02T03:04:05.006Z')));
  assert.deepEqual(parsed, { version: '1.2.3-rc.4', stamp: '20260102T030405006Z' });
});

test('a legacy stampless snapshot is still recognised as a snapshot', () => {
  assert.deepEqual(parseSnapshotName('pgdata-pre-0.139.1'), {
    version: '0.139.1',
    stamp: null,
  });
});

test('unrelated directory names are not snapshots', () => {
  assert.equal(parseSnapshotName('pgdata'), null);
  assert.equal(parseSnapshotName('snapshots'), null);
  assert.equal(parseSnapshotName(SNAPSHOT_PREFIX), null);
});

test('nothing is pruned while under the cap', () => {
  const names = [
    snapshotDirName('0.140.1', at('2026-08-28T10:00:00.000Z')),
    snapshotDirName('0.140.2', at('2026-08-28T11:00:00.000Z')),
  ];
  assert.deepEqual(snapshotsToPrune(names, 3), []);
});

test('the oldest snapshots are pruned down to the cap', () => {
  const oldest = snapshotDirName('0.139.0', at('2026-08-25T10:00:00.000Z'));
  const older = snapshotDirName('0.140.0', at('2026-08-26T10:00:00.000Z'));
  const newer = snapshotDirName('0.140.1', at('2026-08-27T10:00:00.000Z'));
  const newest = snapshotDirName('0.140.2', at('2026-08-28T10:00:00.000Z'));
  assert.deepEqual(snapshotsToPrune([newer, oldest, newest, older], 2), [older, oldest]);
});

test('stampless legacy snapshots are pruned before stamped ones', () => {
  const legacy = 'pgdata-pre-0.130.0';
  const stamped = snapshotDirName('0.140.2', at('2026-08-28T10:00:00.000Z'));
  assert.deepEqual(snapshotsToPrune([legacy, stamped], 1), [legacy]);
});

test('non-snapshot directories are never proposed for deletion', () => {
  const stamped = snapshotDirName('0.140.2', at('2026-08-28T10:00:00.000Z'));
  const pruned = snapshotsToPrune(['pgdata', 'logs', 'platform-data', stamped], 0);
  assert.deepEqual(pruned, [stamped]);
});
