import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { readArtifact } from '../src/phaseRunner.js';

/**
 * Forge W2 #2 — the phase artifact read runs over HOSTILE repo content. A phase
 * session could try to turn the shim's read into an exfiltration primitive
 * (symlink the artifact path at a secret) or a memory bomb (a huge blob). These
 * assert the read refuses all of that and only accepts a bounded regular file
 * inside the workspace.
 */
describe('dev-runner-shim — readArtifact refuses a hostile artifact', () => {
  let ws = '';
  let outside = '';

  before(async () => {
    ws = await mkdtemp(path.join(tmpdir(), 'artifact-ws-'));
    outside = await mkdtemp(path.join(tmpdir(), 'artifact-secret-'));
  });
  after(async () => {
    await rm(ws, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('reads a normal JSON artifact inside the workspace', async () => {
    const file = path.join(ws, 'artifact-plan-0.json');
    await writeFile(file, '  {"ok":true}  ');
    assert.equal(await readArtifact(file, ws), '{"ok":true}');
  });

  it('REJECTS a symlink at the artifact path (exfiltration attempt) — never follows it', async () => {
    const secret = path.join(outside, 'runner-credentials');
    await writeFile(secret, 'SUPER-SECRET-TOKEN');
    const file = path.join(ws, 'artifact-plan-1.json');
    await symlink(secret, file);
    const content = await readArtifact(file, ws);
    assert.equal(content, null, 'a symlink is refused, so the secret is never read');
    assert.notEqual(content, 'SUPER-SECRET-TOKEN');
  });

  it('REJECTS an oversized artifact before reading it into memory', async () => {
    const file = path.join(ws, 'artifact-plan-2.json');
    await writeFile(file, 'x'.repeat(3 * 1024 * 1024)); // > 2 MiB cap
    assert.equal(await readArtifact(file, ws), null);
  });

  it('REJECTS a directory at the artifact path', async () => {
    const dir = path.join(ws, 'artifact-plan-3.json');
    await mkdir(dir);
    assert.equal(await readArtifact(dir, ws), null);
  });

  it('returns null for a missing file', async () => {
    assert.equal(await readArtifact(path.join(ws, 'nope.json'), ws), null);
  });

  it('returns null for an empty file', async () => {
    const file = path.join(ws, 'artifact-plan-4.json');
    await writeFile(file, '   ');
    assert.equal(await readArtifact(file, ws), null);
  });
});
