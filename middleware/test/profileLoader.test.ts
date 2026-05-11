import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

import {
  builtInProfilesDir,
  listProfiles,
  loadProfile,
  ProfileLoadError,
} from '../src/plugins/profileLoader.js';

const BUILT_IN_DIR = resolve(
  new URL(import.meta.url).pathname,
  '..',
  '..',
  'profiles',
);

function tmpProfileDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'profile-loader-test-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function writeYaml(dir: string, name: string, body: string): string {
  const file = join(dir, name);
  writeFileSync(file, body);
  return file;
}

describe('profileLoader / built-in profiles', () => {
  it('loads production.yaml with all 8 plugins normalized', async () => {
    const profile = await loadProfile(join(BUILT_IN_DIR, 'production.yaml'));
    assert.equal(profile.id, 'production');
    assert.equal(profile.schema_version, 1);
    assert.equal(profile.plugins.length, 8);
    assert.deepEqual(
      profile.plugins.map((p) => p.id),
      [
        '@omadia/memory',
        '@omadia/knowledge-graph-neon',
        '@omadia/embeddings',
        '@omadia/orchestrator-extras',
        '@omadia/verifier',
        '@omadia/orchestrator',
        'de.byte5.channel.teams',
        'de.byte5.channel.telegram',
      ],
    );
    // string-shorthand entries normalize to empty config object
    for (const p of profile.plugins) {
      assert.deepEqual(p.config, {});
    }
  });

  it('loads minimal-dev.yaml with embeddings included (capability-correct)', async () => {
    const profile = await loadProfile(join(BUILT_IN_DIR, 'minimal-dev.yaml'));
    assert.equal(profile.id, 'minimal-dev');
    const ids = new Set(profile.plugins.map((p) => p.id));
    assert.ok(
      ids.has('@omadia/embeddings'),
      'minimal-dev must include embeddings — orchestrator-extras requires embeddingClient@^1',
    );
    assert.ok(ids.has('@omadia/knowledge-graph-inmemory'));
    assert.ok(!ids.has('@omadia/verifier'));
    assert.ok(!ids.has('de.byte5.channel.telegram'));
  });

  it('loads blank.yaml as empty plugin list', async () => {
    const profile = await loadProfile(join(BUILT_IN_DIR, 'blank.yaml'));
    assert.equal(profile.id, 'blank');
    assert.equal(profile.plugins.length, 0);
  });

  it('listProfiles returns all 3 sorted by filename', async () => {
    const profiles = await listProfiles(builtInProfilesDir());
    assert.equal(profiles.length, 3);
    assert.deepEqual(
      profiles.map((p) => p.id),
      ['blank', 'minimal-dev', 'production'],
    );
  });

  it('listProfiles on missing directory returns []', async () => {
    const profiles = await listProfiles(
      join(tmpdir(), 'definitely-not-a-dir-xyz-123'),
    );
    assert.deepEqual(profiles, []);
  });
});

describe('profileLoader / object-form entries with config', () => {
  it('normalizes object-form plugin entries preserving config', async () => {
    const { dir, cleanup } = tmpProfileDir();
    try {
      const file = writeYaml(
        dir,
        'with-config.yaml',
        [
          'schema_version: 1',
          'id: with-config',
          'name: With Config',
          'description: Mixed string and object plugin entries',
          'plugins:',
          '  - @omadia/memory',
          '  - id: @omadia/knowledge-graph-neon',
          '    config:',
          '      graph_tenant_id: my-tenant',
          '',
        ].join('\n'),
      );
      const profile = await loadProfile(file);
      assert.deepEqual(profile.plugins, [
        { id: '@omadia/memory', config: {} },
        {
          id: '@omadia/knowledge-graph-neon',
          config: { graph_tenant_id: 'my-tenant' },
        },
      ]);
    } finally {
      cleanup();
    }
  });
});

describe('profileLoader / invalid inputs', () => {
  it('rejects missing schema_version', async () => {
    const { dir, cleanup } = tmpProfileDir();
    try {
      const file = writeYaml(
        dir,
        'no-version.yaml',
        ['id: no-version', 'name: x', 'description: x', 'plugins: []'].join(
          '\n',
        ),
      );
      await assert.rejects(loadProfile(file), ProfileLoadError);
    } finally {
      cleanup();
    }
  });

  it('rejects schema_version != 1', async () => {
    const { dir, cleanup } = tmpProfileDir();
    try {
      const file = writeYaml(
        dir,
        'wrong-version.yaml',
        [
          'schema_version: 2',
          'id: wrong-version',
          'name: x',
          'description: x',
          'plugins: []',
        ].join('\n'),
      );
      await assert.rejects(loadProfile(file), ProfileLoadError);
    } finally {
      cleanup();
    }
  });

  it('rejects id mismatch with filename', async () => {
    const { dir, cleanup } = tmpProfileDir();
    try {
      const file = writeYaml(
        dir,
        'foo.yaml',
        [
          'schema_version: 1',
          'id: bar',
          'name: x',
          'description: x',
          'plugins: []',
        ].join('\n'),
      );
      await assert.rejects(loadProfile(file), /id mismatch/);
    } finally {
      cleanup();
    }
  });

  it('rejects duplicate plugin ids', async () => {
    const { dir, cleanup } = tmpProfileDir();
    try {
      const file = writeYaml(
        dir,
        'dup.yaml',
        [
          'schema_version: 1',
          'id: dup',
          'name: x',
          'description: x',
          'plugins:',
          '  - @omadia/memory',
          '  - @omadia/memory',
        ].join('\n'),
      );
      await assert.rejects(loadProfile(file), /duplicate plugin id/);
    } finally {
      cleanup();
    }
  });

  it('rejects non-kebab-case id', async () => {
    const { dir, cleanup } = tmpProfileDir();
    try {
      const file = writeYaml(
        dir,
        'BadID.yaml',
        [
          'schema_version: 1',
          'id: BadID',
          'name: x',
          'description: x',
          'plugins: []',
        ].join('\n'),
      );
      await assert.rejects(loadProfile(file), ProfileLoadError);
    } finally {
      cleanup();
    }
  });

  it('rejects malformed YAML', async () => {
    const { dir, cleanup } = tmpProfileDir();
    try {
      const file = writeYaml(dir, 'broken.yaml', 'plugins: [not closed');
      await assert.rejects(loadProfile(file), /YAML parse failed/);
    } finally {
      cleanup();
    }
  });
});
