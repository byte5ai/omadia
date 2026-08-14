import { strict as assert } from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  assertEnvFileUsable,
  pinVersion,
  readVersion,
  restoreVersion,
  upsertVersion,
} from '../src/envFile.mjs';

describe('updater env-file pinning (#432)', () => {
  it('replaces an existing assignment in place, keeping order and comments', () => {
    const before = [
      '# omadia stack',
      'VAULT_KEY=abc',
      'OMADIA_VERSION=v0.74.0',
      'NODE_ENV=production',
      '',
    ].join('\n');

    const after = upsertVersion(before, 'v0.75.0');

    assert.equal(
      after,
      ['# omadia stack', 'VAULT_KEY=abc', 'OMADIA_VERSION=v0.75.0', 'NODE_ENV=production', ''].join('\n'),
    );
  });

  it('appends when the key is absent, without eating the last line', () => {
    assert.equal(upsertVersion('VAULT_KEY=abc', 'v1.0.0'), 'VAULT_KEY=abc\nOMADIA_VERSION=v1.0.0\n');
    assert.equal(upsertVersion('', 'v1.0.0'), 'OMADIA_VERSION=v1.0.0\n');
    assert.equal(upsertVersion('A=1\n\n\n', 'v1.0.0'), 'A=1\nOMADIA_VERSION=v1.0.0\n');
  });

  it('leaves a commented-out example untouched and still appends a real pin', () => {
    const content = '# OMADIA_VERSION=v0.1.0 (example)\nA=1\n';
    const result = upsertVersion(content, 'v2.0.0');
    assert.match(result, /# OMADIA_VERSION=v0\.1\.0 \(example\)/);
    assert.match(result, /^OMADIA_VERSION=v2\.0\.0$/m);
  });

  it('rewrites only the first assignment when the file has duplicates', () => {
    const content = 'OMADIA_VERSION=v1.0.0\nA=1\nOMADIA_VERSION=v1.1.0\n';
    const result = upsertVersion(content, 'v2.0.0');
    // dotenv semantics differ between tools, so the loser is left alone rather
    // than silently deleted — the operator can see both lines and decide.
    assert.equal(result, 'OMADIA_VERSION=v2.0.0\nA=1\nOMADIA_VERSION=v1.1.0\n');
  });

  it('reads the pinned value, tolerating whitespace', () => {
    assert.equal(readVersion('  OMADIA_VERSION = v0.9.0 \n'), 'v0.9.0');
    assert.equal(readVersion('A=1\n'), null);
  });

  describe('on disk', () => {
    let dir;
    let file;

    before(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'omadia-updater-'));
      file = path.join(dir, '.env');
    });

    after(async () => {
      await fs.rm(dir, { recursive: true, force: true });
    });

    it('pins, reports the previous value, and restores it on rollback', async () => {
      await fs.writeFile(file, 'A=1\nOMADIA_VERSION=v0.74.0\n', 'utf8');

      const { previous } = await pinVersion(file, 'v0.75.0');
      assert.equal(previous, 'v0.74.0');
      assert.equal(readVersion(await fs.readFile(file, 'utf8')), 'v0.75.0');

      await restoreVersion(file, previous);
      assert.equal(readVersion(await fs.readFile(file, 'utf8')), 'v0.74.0');
    });

    it('removes the key on rollback when it was absent before', async () => {
      await fs.writeFile(file, 'A=1\n', 'utf8');

      const { previous } = await pinVersion(file, 'v0.75.0');
      assert.equal(previous, null);

      await restoreVersion(file, previous);
      const content = await fs.readFile(file, 'utf8');
      // Crucially NOT `OMADIA_VERSION=` — an empty value makes compose resolve
      // the image tag to the empty string instead of defaulting to `latest`.
      assert.equal(readVersion(content), null);
      assert.ok(!content.includes('OMADIA_VERSION'));
    });

    it('refuses at boot when the mount landed as a directory', async () => {
      // The exact failure mode of forgetting `touch .env`: Docker creates a
      // directory for a missing single-file bind source.
      const asDir = path.join(dir, 'dir-env');
      await fs.mkdir(asDir, { recursive: true });
      await assert.rejects(assertEnvFileUsable(asDir), /is a directory/);
    });

    it('refuses at boot when the file does not exist', async () => {
      await assert.rejects(
        assertEnvFileUsable(path.join(dir, 'nope.env')),
        /does not exist/,
      );
    });

    it('accepts a normal writable file', async () => {
      await fs.writeFile(file, 'A=1\n', 'utf8');
      await assertEnvFileUsable(file);
    });

    it('names the uid fix when the file is not writable', async () => {
      const readOnly = path.join(dir, 'ro.env');
      await fs.writeFile(readOnly, 'A=1\n', 'utf8');
      await fs.chmod(readOnly, 0o444);
      // Running as root defeats the permission bit entirely; skip rather than
      // assert something the environment cannot demonstrate.
      if (typeof process.getuid === 'function' && process.getuid() === 0) return;
      await assert.rejects(assertEnvFileUsable(readOnly), /UPDATER_UID/);
    });

    it('keeps the same inode so a single-file bind mount stays intact', async () => {
      await fs.writeFile(file, 'A=1\n', 'utf8');
      const before = await fs.stat(file);
      await pinVersion(file, 'v0.75.0');
      const after = await fs.stat(file);
      assert.equal(after.ino, before.ino);
    });
  });
});
