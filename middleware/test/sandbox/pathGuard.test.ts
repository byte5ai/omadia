import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  clampSandboxPath,
  clampSandboxPathPosix,
} from '../../packages/harness-sandbox/src/pathGuard.js';

/**
 * #576 P1 — traversal hardening for the sandbox filesystem primitives, same
 * discipline as the #772 broker and `zipExtractor.ts`'s zip-slip guard.
 */
describe('clampSandboxPathPosix', () => {
  it('accepts an ordinary relative path and resolves it under the root', () => {
    const r = clampSandboxPathPosix('/workspace', 'notes/todo.md');
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.absolutePath, '/workspace/notes/todo.md');
      assert.equal(r.relativePath, 'notes/todo.md');
    }
  });

  it('accepts the root itself via "." or ""', () => {
    const dot = clampSandboxPathPosix('/workspace', '.');
    assert.equal(dot.ok, true);
    if (dot.ok) assert.equal(dot.absolutePath, '/workspace');
  });

  it('rejects a simple ".." escape', () => {
    const r = clampSandboxPathPosix('/workspace', '../etc/passwd');
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'escape');
  });

  it('rejects a deeply nested ".." escape', () => {
    const r = clampSandboxPathPosix('/workspace', 'a/b/../../../etc/passwd');
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'escape');
  });

  it('rejects an absolute path even when it looks harmless', () => {
    const r = clampSandboxPathPosix('/workspace', '/etc/passwd');
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'absolute');
  });

  it('rejects an empty or whitespace-only path', () => {
    const r1 = clampSandboxPathPosix('/workspace', '');
    assert.equal(r1.ok, false);
    if (!r1.ok) assert.equal(r1.reason, 'empty');
    const r2 = clampSandboxPathPosix('/workspace', '   ');
    assert.equal(r2.ok, false);
    if (!r2.ok) assert.equal(r2.reason, 'empty');
  });

  it('rejects a path carrying a NUL byte', () => {
    const r = clampSandboxPathPosix('/workspace', 'notes\0/etc/passwd');
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'null_byte');
  });

  it('a sibling directory that merely shares the root as a string prefix does not escape (no path.sep boundary bug)', () => {
    // Regression guard: a naive `startsWith(root)` check (without the
    // trailing separator) would let '/workspace-evil/x' pass because it
    // string-starts-with '/workspace'. clampSandboxPathPosix resolves
    // relative to the root, so this can only ever produce a path *under*
    // /workspace — there is no way to spell '/workspace-evil' as a
    // "relative" input once resolution has already anchored it.
    const r = clampSandboxPathPosix('/workspace', 'x');
    assert.equal(r.ok, true);
    if (r.ok) assert.ok(r.absolutePath.startsWith('/workspace/'));
  });
});

describe('clampSandboxPath (host-path variant)', () => {
  it('rejects a ".." escape against a host root', () => {
    const r = clampSandboxPath('/tmp/sandbox-root', '../../etc/passwd');
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'escape');
  });

  it('accepts a plain relative path under a host root', () => {
    const r = clampSandboxPath('/tmp/sandbox-root', 'a/b.txt');
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.absolutePath, '/tmp/sandbox-root/a/b.txt');
  });
});
