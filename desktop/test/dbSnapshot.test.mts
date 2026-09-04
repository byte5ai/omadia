import { test } from 'node:test';
import assert from 'node:assert/strict';
import { takeDbSnapshot, type SnapshotIo, type SnapshotRequest } from '../src/dbSnapshot.ts';
import { snapshotDirName } from '../src/snapshotRetention.ts';

/**
 * The ordering invariant behind the ENOSPC lockout (#934/#926): pruning must
 * happen BEFORE the copy, and to one below the cap.
 */

interface Recorder {
  readonly io: SnapshotIo;
  readonly calls: string[];
}

function recorder(options: {
  dirs?: string[];
  exists?: boolean;
  copyThrows?: Error;
  removeThrows?: Error;
} = {}): Recorder {
  const calls: string[] = [];
  const io: SnapshotIo = {
    exists: () => {
      calls.push('exists');
      return options.exists ?? true;
    },
    listDirectories: () => {
      calls.push('list');
      return options.dirs ?? [];
    },
    copy: (source, destination) => {
      calls.push(`copy(${destination.split('/').pop()})`);
      if (options.copyThrows) throw options.copyThrows;
    },
    remove: (dir) => {
      calls.push(`remove(${dir.split('/').pop()})`);
      if (options.removeThrows) throw options.removeThrows;
    },
    info: () => {},
    error: (m) => calls.push(`error(${m.slice(0, 24)})`),
  };
  return { io, calls };
}

const at = new Date('2026-08-28T10:11:17.000Z');

function request(overrides: Partial<SnapshotRequest> = {}): SnapshotRequest {
  return {
    sourceDir: '/data/pgdata',
    snapshotRoot: '/data/snapshots',
    version: '0.140.1',
    now: at,
    keep: 3,
    ...overrides,
  };
}

test('nothing happens when there is no database to snapshot', () => {
  const { io, calls } = recorder({ exists: false });
  assert.equal(takeDbSnapshot(io, request()), null);
  assert.deepEqual(calls, ['exists']);
});

test('pruning happens before the copy, not after', () => {
  const existing = [
    snapshotDirName('0.139.0', new Date('2026-08-25T10:00:00.000Z')),
    snapshotDirName('0.140.0', new Date('2026-08-26T10:00:00.000Z')),
    snapshotDirName('0.140.1', new Date('2026-08-27T10:00:00.000Z')),
  ];
  const { io, calls } = recorder({ dirs: existing });
  takeDbSnapshot(io, request());

  const removeIndex = calls.findIndex((c) => c.startsWith('remove('));
  const copyIndex = calls.findIndex((c) => c.startsWith('copy('));
  assert.notEqual(removeIndex, -1, 'the surplus snapshot should have been pruned');
  assert.notEqual(copyIndex, -1);
  // The regression: copying first meant ENOSPC threw before anything was ever
  // reclaimed, so every later update attempt failed identically.
  assert.ok(removeIndex < copyIndex, `pruning must precede the copy; got ${calls.join(' ')}`);
});

test('pruning targets one below the cap, so peak usage is the cap', () => {
  const existing = [
    snapshotDirName('0.139.0', new Date('2026-08-25T10:00:00.000Z')),
    snapshotDirName('0.140.0', new Date('2026-08-26T10:00:00.000Z')),
    snapshotDirName('0.140.1', new Date('2026-08-27T10:00:00.000Z')),
  ];
  const { io, calls } = recorder({ dirs: existing });
  takeDbSnapshot(io, request({ keep: 3 }));
  // Three existing, keep 3 => one must go before the copy, leaving 2 + the new
  // one = 3 on disk and never 4 at once.
  assert.equal(calls.filter((c) => c.startsWith('remove(')).length, 1);
});

test('a copy failure removes the partial directory and rethrows the real cause', () => {
  const enospc = new Error('ENOSPC: no space left on device');
  const { io, calls } = recorder({ copyThrows: enospc });
  assert.throws(() => takeDbSnapshot(io, request()), /ENOSPC/);
  const expected = snapshotDirName('0.140.1', at);
  assert.ok(
    calls.includes(`remove(${expected})`),
    `the partial snapshot must be removed; got ${calls.join(' ')}`,
  );
});

test('a failing cleanup does not mask the original copy failure', () => {
  const enospc = new Error('ENOSPC: no space left on device');
  const { io } = recorder({ copyThrows: enospc, removeThrows: new Error('EACCES') });
  // The dialog has to name the cause the user can act on, not a secondary
  // error from our own tidying up.
  assert.throws(() => takeDbSnapshot(io, request()), /ENOSPC/);
});

test('a pruning failure does not stop the snapshot', () => {
  const { io, calls } = recorder({
    dirs: ['pgdata-pre-0.1.0', 'pgdata-pre-0.2.0', 'pgdata-pre-0.3.0', 'pgdata-pre-0.4.0'],
    removeThrows: new Error('EACCES'),
  });
  const created = takeDbSnapshot(io, request());
  assert.ok(created !== null, 'the snapshot itself must still be taken');
  assert.ok(calls.some((c) => c.startsWith('copy(')));
});
