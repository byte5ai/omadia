import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { computeContentHash, syncReadOnlyLayer } from '../../packages/harness-sandbox/src/contentHash.js';

describe('computeContentHash', () => {
  it('is deterministic for the same file set', () => {
    const files = { 'a.txt': 'hello', 'b.txt': 'world' };
    assert.equal(computeContentHash(files), computeContentHash({ ...files }));
  });

  it('is order-independent (key insertion order does not matter)', () => {
    const a = computeContentHash({ 'a.txt': '1', 'b.txt': '2' });
    const b = computeContentHash({ 'b.txt': '2', 'a.txt': '1' });
    assert.equal(a, b);
  });

  it('changes when any file content changes', () => {
    const before = computeContentHash({ 'a.txt': 'hello' });
    const after = computeContentHash({ 'a.txt': 'hello!' });
    assert.notEqual(before, after);
  });

  it('changes when the file SET changes (added/removed path), not just content', () => {
    const base = computeContentHash({ 'a.txt': 'x' });
    const added = computeContentHash({ 'a.txt': 'x', 'b.txt': 'y' });
    assert.notEqual(base, added);
  });

  it('does not collide on a naive path+content concatenation ambiguity', () => {
    // Without a separator, {'ab':'c', 'a':'bc'} would concatenate to the same
    // string as {'a':'bc'} minus... this asserts the NUL-separated encoding
    // actually distinguishes shifted boundaries.
    const a = computeContentHash({ ab: 'c' });
    const b = computeContentHash({ a: 'bc' });
    assert.notEqual(a, b);
  });
});

describe('syncReadOnlyLayer', () => {
  function stubSandbox() {
    const writes: Array<{ path: string; content: string }> = [];
    return {
      writes,
      write: async (path: string, content: string) => {
        writes.push({ path, content });
        return { ok: true };
      },
    };
  }

  it('writes every file and returns synced:true when previousHash is undefined', async () => {
    const sandbox = stubSandbox();
    const files = { 'a.txt': 'hello', 'b.txt': 'world' };
    const result = await syncReadOnlyLayer(sandbox, files, undefined);
    assert.equal(result.synced, true);
    assert.deepEqual(sandbox.writes.map((w) => w.path).sort(), ['a.txt', 'b.txt']);
    assert.equal(result.hash, computeContentHash(files));
  });

  it('skips ALL writes when the hash matches — the whole point of the fingerprint', async () => {
    const sandbox = stubSandbox();
    const files = { 'a.txt': 'hello' };
    const previousHash = computeContentHash(files);
    const result = await syncReadOnlyLayer(sandbox, files, previousHash);
    assert.equal(result.synced, false);
    assert.equal(sandbox.writes.length, 0);
    assert.deepEqual(result.writtenPaths, []);
  });

  it('re-syncs (writes again) when the content changed since previousHash', async () => {
    const sandbox = stubSandbox();
    const oldFiles = { 'a.txt': 'v1' };
    const newFiles = { 'a.txt': 'v2' };
    const previousHash = computeContentHash(oldFiles);
    const result = await syncReadOnlyLayer(sandbox, newFiles, previousHash);
    assert.equal(result.synced, true);
    assert.equal(sandbox.writes.length, 1);
    assert.equal(sandbox.writes[0]!.content, 'v2');
  });
});
