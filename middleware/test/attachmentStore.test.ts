/**
 * Which attachment store the kernel publishes as `tigrisStore`, and how it
 * reports that on `/health`.
 *
 * The desktop app's "Attachments" switch was stored in `setup.json` and never
 * reached the kernel: whatever the user picked, the same stack booted. It now
 * sets `ATTACHMENT_STORE_DIR`, and this file pins the kernel half of that
 * wiring: the variable selects a local store, S3 keeps precedence, an unusable
 * directory degrades loudly instead of crashing boot, and `/health` says which
 * store is live so the desktop supervisor can check the switch took.
 *
 * The last block drives the composition root's source text, like
 * `778RouteMounts.wiring.test.ts`: `src/index.ts` boots the whole server at
 * import, so the one-line wiring cannot be exercised any other way.
 */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { TigrisStore } from '@omadia/diagrams';

import {
  attachmentStoreHealth,
  selectAttachmentStore,
  type AttachmentStoreFactories,
} from '../src/platform/attachmentStore.js';

const S3 = {
  BUCKET_NAME: 'synthetic-bucket',
  AWS_ENDPOINT_URL_S3: 'http://127.0.0.1:9000',
  AWS_ACCESS_KEY_ID: 'synthetic-access-key',
  AWS_SECRET_ACCESS_KEY: 'synthetic-secret-key',
} as const;

const FAKE_STORE: TigrisStore = {
  exists: async () => false,
  put: async () => undefined,
  getStream: async () => {
    throw new Error('not used');
  },
};

/** Factories that record what was built instead of touching S3 or the disk. */
function recordingFactories(opts: { filesystemThrows?: Error } = {}): {
  factories: AttachmentStoreFactories;
  built: string[];
} {
  const built: string[] = [];
  return {
    built,
    factories: {
      s3: (options) => {
        built.push(`s3:${options.bucket}`);
        return FAKE_STORE;
      },
      filesystem: (dir) => {
        if (opts.filesystemThrows) throw opts.filesystemThrows;
        built.push(`filesystem:${dir}`);
        return FAKE_STORE;
      },
    },
  };
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('selectAttachmentStore', () => {
  it('keeps S3 when all four S3 values are set, even with ATTACHMENT_STORE_DIR', () => {
    const { factories, built } = recordingFactories();
    const selection = selectAttachmentStore({ ...S3, ATTACHMENT_STORE_DIR: '/data/attachments' }, factories);
    assert.equal(selection.backend, 's3');
    assert.equal(selection.store, FAKE_STORE);
    assert.deepEqual(built, ['s3:synthetic-bucket']);
    assert.match(selection.message, /ATTACHMENT_STORE_DIR/, 'the ignored directory is named in the log line');
  });

  it('uses the local directory when ATTACHMENT_STORE_DIR is set and S3 is not', async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'omadia-attachment-select-'));
    tmpDirs.push(parent);
    const dir = path.join(parent, 'attachments');

    const selection = selectAttachmentStore({ ATTACHMENT_STORE_DIR: dir });

    assert.equal(selection.backend, 'filesystem');
    assert.ok(selection.store, 'a store is published');
    await selection.store.put('probe', Buffer.from('ok'), 'text/plain');
    assert.equal(await selection.store.exists('probe'), true);
    assert.equal(fs.statSync(dir).isDirectory(), true);
  });

  it('falls back to the local directory when the S3 values are incomplete', () => {
    const { factories, built } = recordingFactories();
    const selection = selectAttachmentStore(
      { BUCKET_NAME: S3.BUCKET_NAME, ATTACHMENT_STORE_DIR: '/data/attachments' },
      factories,
    );
    assert.equal(selection.backend, 'filesystem');
    assert.deepEqual(built, ['filesystem:/data/attachments']);
  });

  it('publishes nothing when neither is configured', () => {
    const { factories, built } = recordingFactories();
    for (const env of [{}, { ATTACHMENT_STORE_DIR: '   ' }, { ATTACHMENT_STORE_DIR: '' }]) {
      const selection = selectAttachmentStore(env, factories);
      assert.equal(selection.backend, 'none');
      assert.equal(selection.store, undefined);
      assert.match(selection.message, /DISABLED/);
    }
    assert.deepEqual(built, []);
  });

  it('degrades to no store, with the reason, when the directory is unusable', () => {
    const { factories } = recordingFactories({ filesystemThrows: new Error('EACCES: permission denied') });
    const selection = selectAttachmentStore({ ATTACHMENT_STORE_DIR: '/read-only/attachments' }, factories);
    assert.equal(selection.backend, 'none');
    assert.equal(selection.store, undefined);
    assert.match(selection.message, /DISABLED/);
    assert.match(selection.message, /EACCES/);
  });
});

describe('attachmentStoreHealth', () => {
  it('reports which store is live, and nothing that locates it', () => {
    const { factories } = recordingFactories();
    const s3 = selectAttachmentStore({ ...S3 }, factories);
    const local = selectAttachmentStore({ ATTACHMENT_STORE_DIR: '/Users/someone/omadia/attachments' }, factories);
    const none = selectAttachmentStore({}, factories);

    assert.deepEqual(attachmentStoreHealth(s3), { store: 's3' });
    assert.deepEqual(attachmentStoreHealth(local), { store: 'filesystem' });
    assert.deepEqual(attachmentStoreHealth(none), { store: 'none' });
    // /health is unauthenticated: no bucket, endpoint or path may appear.
    const serialized = JSON.stringify([s3, local, none].map(attachmentStoreHealth));
    for (const secretish of ['synthetic-bucket', '127.0.0.1', 'someone', 'attachments/']) {
      assert.ok(!serialized.includes(secretish), `${secretish} leaked into /health`);
    }
  });
});

describe('src/index.ts publishes the selection and reports it on /health', () => {
  const middlewareRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const live = fs
    .readFileSync(path.join(middlewareRoot, 'src', 'index.ts'), 'utf8')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');

  it('selects the store from the parsed config', () => {
    assert.match(live, /const (\w+) = selectAttachmentStore\(config\);/);
  });

  it('provides the selected store as the tigrisStore service', () => {
    const selection = /const (\w+) = selectAttachmentStore\(config\);/.exec(live)?.[1];
    assert.ok(selection);
    assert.ok(
      live.includes(`serviceRegistry.provide('tigrisStore', ${selection}.store)`),
      'the selected store must be what consumers resolve as tigrisStore',
    );
  });

  it('reports the store on /health', () => {
    const selection = /const (\w+) = selectAttachmentStore\(config\);/.exec(live)?.[1];
    assert.ok(selection);
    assert.ok(
      live.includes(`attachments: attachmentStoreHealth(${selection})`),
      '/health must carry the attachments block the desktop supervisor reads',
    );
  });

  it('no longer builds an S3 client of its own for attachments', () => {
    assert.ok(!/createTigrisStore\(/.test(live), 'index.ts must go through selectAttachmentStore');
  });
});
