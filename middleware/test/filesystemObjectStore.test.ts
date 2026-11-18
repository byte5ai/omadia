/**
 * The filesystem object store behind the kernel's `tigrisStore` service when a
 * single-machine install has no S3 bucket (the desktop app's "Attachments"
 * switch sets `ATTACHMENT_STORE_DIR`).
 *
 * Two things matter beyond "it stores bytes":
 *
 * - It answers exactly like the S3 store its consumers were written against:
 *   `exists` / `put` / `getStream`, the same default content type, and a
 *   missing key that `isNotFound()` from `@omadia/diagrams` recognises.
 * - A key is caller data. `read_attachment` passes a storage key the model
 *   chose, and an S3 bucket answers a hostile key with a harmless 404. A
 *   directory joined with that key would read and write wherever the process
 *   can, so the confinement tests below are the point of this file.
 */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { afterEach, describe, it } from 'node:test';

import { isNotFound } from '@omadia/diagrams';

import { createFilesystemObjectStore } from '../src/platform/filesystemObjectStore.js';

const POSIX = process.platform !== 'win32';
const RUNNING_AS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

async function drain(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

/** Every regular file below `dir`, as absolute paths. */
function filesBelow(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesBelow(full));
    else out.push(full);
  }
  return out;
}

const sandboxes: string[] = [];

/** A private parent directory; the store lives in `<parent>/attachments`. */
function sandbox(): { parent: string; root: string } {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'omadia-fs-object-store-'));
  sandboxes.push(parent);
  return { parent, root: path.join(parent, 'attachments') };
}

afterEach(() => {
  for (const dir of sandboxes.splice(0)) {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      /* already gone */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('createFilesystemObjectStore — the S3 store contract', () => {
  it('round-trips bytes, content type and length', async () => {
    const { root } = sandbox();
    const store = createFilesystemObjectStore(root);
    const body = Buffer.from('%PDF-1.7 synthetic test document');

    await store.put('teams-attachments/tenant/conv/report.pdf', body, 'application/pdf');

    assert.equal(await store.exists('teams-attachments/tenant/conv/report.pdf'), true);
    const got = await store.getStream('teams-attachments/tenant/conv/report.pdf');
    assert.equal(got.contentType, 'application/pdf');
    assert.equal(got.contentLength, body.length);
    assert.deepEqual(await drain(got.stream), body);
  });

  it('keeps the S3 store default content type when none is given', async () => {
    const store = createFilesystemObjectStore(sandbox().root);
    await store.put('diagrams/dev/abc.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const got = await store.getStream('diagrams/dev/abc.png');
    // Not consumed, so release the file handle like a caller that gives up would.
    got.stream.destroy();
    assert.equal(got.contentType, 'image/png');
  });

  it('answers a key it never stored the way the S3 store does', async () => {
    const store = createFilesystemObjectStore(sandbox().root);
    assert.equal(await store.exists('never/stored'), false);
    await assert.rejects(store.getStream('never/stored'), (err: unknown) => {
      assert.equal(isNotFound(err), true, 'isNotFound() must recognise the miss');
      return true;
    });
  });

  it('overwrites an existing key, bytes and type together', async () => {
    const store = createFilesystemObjectStore(sandbox().root);
    await store.put('brand/logo', Buffer.from('old'), 'image/png');
    await store.put('brand/logo', Buffer.from('new logo'), 'image/svg+xml');
    const got = await store.getStream('brand/logo');
    assert.equal(got.contentType, 'image/svg+xml');
    assert.equal((await drain(got.stream)).toString(), 'new logo');
  });

  it('leaves no temporary files behind after a put', async () => {
    const { root } = sandbox();
    const store = createFilesystemObjectStore(root);
    await store.put('a', Buffer.from('1'), 'text/plain');
    await store.put('a', Buffer.from('2'), 'text/plain');
    await store.put('b', Buffer.from('3'), 'text/plain');
    assert.deepEqual(filesBelow(root).filter((f) => f.endsWith('.tmp')), []);
  });
});

describe('createFilesystemObjectStore — keys never become paths', () => {
  const HOSTILE_KEYS = [
    '../../../../../../etc/passwd',
    '/etc/passwd',
    '..\\..\\..\\Windows\\win.ini',
    'C:\\Windows\\win.ini',
    'a/../../outside',
    'teams-attachments/../../../escape.txt',
    'nul\u0000byte',
    '.',
    '..',
  ];

  it('writes every key, however it is spelled, inside the store directory', async () => {
    const { parent, root } = sandbox();
    const store = createFilesystemObjectStore(root);
    for (const key of HOSTILE_KEYS) {
      await store.put(key, Buffer.from(`payload for ${key}`), 'text/plain');
    }
    // Nothing next to the store: the sandbox holds exactly the store directory.
    assert.deepEqual(fs.readdirSync(parent), ['attachments']);
    for (const file of filesBelow(root)) {
      const rel = path.relative(root, file);
      assert.ok(!rel.startsWith('..') && !path.isAbsolute(rel), `${file} escaped the store`);
    }
    // …and each key still reads back its own bytes.
    for (const key of HOSTILE_KEYS) {
      const got = await store.getStream(key);
      assert.equal((await drain(got.stream)).toString(), `payload for ${key}`);
    }
  });

  it('cannot read a file outside the store through a traversal key', async () => {
    const { parent, root } = sandbox();
    fs.writeFileSync(path.join(parent, 'secret.txt'), 'outside the store');
    const store = createFilesystemObjectStore(root);
    for (const key of ['../secret.txt', path.join(parent, 'secret.txt')]) {
      assert.equal(await store.exists(key), false, key);
      await assert.rejects(store.getStream(key), (err: unknown) => isNotFound(err), key);
    }
  });

  it('treats an empty or oversized key as not found on read and refuses it on write', async () => {
    const store = createFilesystemObjectStore(sandbox().root);
    const oversized = 'k'.repeat(1025);
    for (const key of ['', oversized]) {
      assert.equal(await store.exists(key), false);
      await assert.rejects(store.getStream(key), (err: unknown) => isNotFound(err));
      await assert.rejects(store.put(key, Buffer.from('x')), /key/);
    }
  });
});

describe('createFilesystemObjectStore — the directory', () => {
  it('creates its directory at construction', () => {
    const { root } = sandbox();
    createFilesystemObjectStore(root);
    assert.equal(fs.statSync(root).isDirectory(), true);
  });

  it('keeps the directory and every object owner-only', { skip: !POSIX }, async () => {
    const { root } = sandbox();
    const store = createFilesystemObjectStore(root);
    await store.put('private/scan.pdf', Buffer.from('synthetic'), 'application/pdf');
    assert.equal(fs.statSync(root).mode & 0o777, 0o700);
    const files = filesBelow(root);
    assert.ok(files.length > 0);
    for (const file of files) {
      assert.equal(fs.statSync(file).mode & 0o077, 0, `${file} is readable by others`);
    }
  });

  it('refuses to start on a directory it cannot write', { skip: !POSIX || RUNNING_AS_ROOT }, () => {
    const { root } = sandbox();
    fs.mkdirSync(root, { mode: 0o500 });
    fs.chmodSync(root, 0o500);
    try {
      assert.throws(() => createFilesystemObjectStore(root));
    } finally {
      fs.chmodSync(root, 0o700);
    }
  });
});
