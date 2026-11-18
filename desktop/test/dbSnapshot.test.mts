import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  /** Whether the secrets file exists; the database dir follows `exists`. */
  secretsExists?: boolean;
  copyThrows?: Error;
  copyFileThrows?: Error;
  removeThrows?: Error;
} = {}): Recorder {
  const calls: string[] = [];
  const io: SnapshotIo = {
    exists: (target) => {
      calls.push('exists');
      if (target === SECRETS) return options.secretsExists ?? true;
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
    copyFile: (source, destination) => {
      calls.push(`copyFile(${source} -> ${destination.split('/').pop()})`);
      if (options.copyFileThrows) throw options.copyFileThrows;
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
const SECRETS = '/data/secrets.enc';

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
  // one = 3 on disk and never 4 at once. Counted as directories: each pruned
  // snapshot also takes its `.secrets.enc` sibling with it.
  const directoryRemoves = calls.filter(
    (c) => c.startsWith('remove(') && !c.endsWith('.secrets.enc)'),
  );
  assert.equal(directoryRemoves.length, 1);
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

/**
 * The database alone is not a restorable backup: stored credentials and dataset
 * cells in it are encrypted with keys that live in `secrets.enc`, so a snapshot
 * without the matching secrets file can come back unreadable.
 */

test('the secrets file is copied next to the snapshot, after the directory copy', () => {
  const { io, calls } = recorder();
  const name = snapshotDirName('0.140.1', at);
  assert.equal(takeDbSnapshot(io, request({ secretsFile: SECRETS })), `/data/snapshots/${name}`);

  const dirCopy = calls.indexOf(`copy(${name})`);
  const fileCopy = calls.indexOf(`copyFile(${SECRETS} -> ${name}.secrets.enc)`);
  assert.notEqual(dirCopy, -1, calls.join(' '));
  assert.notEqual(fileCopy, -1, `the secrets file must be in the snapshot; got ${calls.join(' ')}`);
  assert.ok(dirCopy < fileCopy, `directory first, then the secrets file; got ${calls.join(' ')}`);
});

test('an absent secrets file is skipped without error', () => {
  const { io, calls } = recorder({ secretsExists: false });
  assert.notEqual(takeDbSnapshot(io, request({ secretsFile: SECRETS })), null);
  assert.equal(calls.filter((c) => c.startsWith('copyFile(')).length, 0);
});

test('a failing secrets copy removes the partial directory and the sibling, and rethrows the cause', () => {
  const { io, calls } = recorder({ copyFileThrows: new Error('EACCES: permission denied') });
  assert.throws(() => takeDbSnapshot(io, request({ secretsFile: SECRETS })), /EACCES/);
  const name = snapshotDirName('0.140.1', at);
  // Half a snapshot is worse than none: it looks restorable and it is not.
  assert.ok(calls.includes(`remove(${name})`), calls.join(' '));
  assert.ok(calls.includes(`remove(${name}.secrets.enc)`), calls.join(' '));
});

test('a failing cleanup after a secrets copy failure does not mask the cause', () => {
  const { io } = recorder({
    copyFileThrows: new Error('EACCES: permission denied'),
    removeThrows: new Error('EBUSY'),
  });
  assert.throws(() => takeDbSnapshot(io, request({ secretsFile: SECRETS })), /EACCES/);
});

test('pruning removes a stale snapshot together with its secrets copy', () => {
  const stale = snapshotDirName('0.139.0', new Date('2026-08-25T10:00:00.000Z'));
  const existing = [
    stale,
    snapshotDirName('0.140.0', new Date('2026-08-26T10:00:00.000Z')),
    snapshotDirName('0.140.1', new Date('2026-08-27T10:00:00.000Z')),
  ];
  const { io, calls } = recorder({ dirs: existing });
  takeDbSnapshot(io, request({ keep: 3, secretsFile: SECRETS }));
  assert.ok(calls.includes(`remove(${stale})`), calls.join(' '));
  assert.ok(calls.includes(`remove(${stale}.secrets.enc)`), calls.join(' '));
});

/**
 * `takeDbSnapshot` copies the secrets file only when it is given one, and the
 * updater is what gives it. That glue runs only inside Electron, so it is
 * pinned as source: without `secretsFile` every test above stays green while
 * each pre-update snapshot silently loses the keys its ciphertexts need.
 */
test('the updater hands the secrets file to the pre-update snapshot (source contract)', () => {
  const updater = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'updater.ts'),
    'utf8',
  );
  assert.match(updater, /snapshot: snapshotDbDir\b/, 'the install preflight takes this snapshot');
  const snapshotCall =
    /function snapshotDbDir\(version: string\): void \{\s*takeDbSnapshot\(realSnapshotIo, \{([^}]*)\}\);/;
  const fields = snapshotCall.exec(updater)?.[1];
  assert.ok(fields !== undefined, 'snapshotDbDir builds its request in one takeDbSnapshot call');
  assert.match(fields, /\bsecretsFile: secretsFile\(\)/);
  assert.match(updater, /import \{[^}]*\bsecretsFile\b[^}]*\} from '\.\/paths';/);
  // The copy holds the same secrets as the original: its mode is set, not inherited.
  assert.match(
    updater,
    /copyFile: \(source, destination\) => \{\s*fs\.copyFileSync\(source, destination\);[^}]*fs\.chmodSync\(destination, 0o600\);/,
  );
});
