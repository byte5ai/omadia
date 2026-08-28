import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareInstall } from '../src/installPreflight.ts';
import type { StopOutcome } from '../src/supervisor.ts';

const clean: StopOutcome = { clean: true, survivors: [] };
const dirty: StopOutcome = { clean: false, survivors: ['kernel', 'embedded-postgres'] };

test('a clean stop plus a good snapshot clears the install', async () => {
  const snapshotted: string[] = [];
  const result = await prepareInstall(
    { stop: async () => clean, snapshot: (v) => snapshotted.push(v) },
    '0.140.1',
  );
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(snapshotted, ['0.140.1']);
});

test('an unclean stop blocks the install and never snapshots', async () => {
  let snapshots = 0;
  const result = await prepareInstall(
    {
      stop: async () => dirty,
      snapshot: () => {
        snapshots += 1;
      },
    },
    '0.140.1',
  );
  // The whole point of #926: a stack that did not come down must not be handed
  // to the installer, and copying the database of a live cluster is unsafe too.
  assert.deepEqual(result, {
    ok: false,
    reason: 'unclean',
    survivors: ['kernel', 'embedded-postgres'],
  });
  assert.equal(snapshots, 0);
});

test('a throwing snapshot blocks the install and reports the reason', async () => {
  const result = await prepareInstall(
    {
      stop: async () => clean,
      snapshot: () => {
        throw new Error('ENOSPC: no space left on device');
      },
    },
    '0.140.1',
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason === 'failed' && result.error.includes('ENOSPC'), true);
});

test('a throwing stop blocks the install', async () => {
  const result = await prepareInstall(
    {
      stop: async () => {
        throw new Error('supervisor exploded');
      },
      snapshot: () => {},
    },
    '0.140.1',
  );
  assert.deepEqual(result, { ok: false, reason: 'failed', error: 'supervisor exploded' });
});

test('with no supervisor to stop the snapshot still runs', async () => {
  const snapshotted: string[] = [];
  const result = await prepareInstall(
    { stop: null, snapshot: (v) => snapshotted.push(v) },
    '0.141.0',
  );
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(snapshotted, ['0.141.0']);
});
