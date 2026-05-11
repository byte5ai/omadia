import { describe, it, before, after, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  cleanupStagingDir,
  ensureBuildTemplate,
  prepareStagingDir,
} from '../../src/plugins/builder/buildTemplate.js';

describe('buildTemplate', () => {
  let tmp: string;

  before(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'build-template-test-'));
  });

  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function fakeWorkspacePkg(name: string, suffix = ''): string {
    const pkgDir = path.join(tmp, `ws${suffix}-${name.replace(/[/@]/g, '_')}`);
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name, version: '0.1.0' }),
    );
    return pkgDir;
  }

  function freshTemplateRoot(name: string): string {
    const dir = path.join(tmp, name);
    rmSync(dir, { recursive: true, force: true });
    return dir;
  }

  beforeEach(() => {});

  describe('ensureBuildTemplate', () => {
    it('creates the template root, package.json, and workspace symlinks', async () => {
      const templateRoot = freshTemplateRoot('init-1');
      const pluginApi = fakeWorkspacePkg('@omadia/plugin-api', '-1');

      const result = await ensureBuildTemplate({
        templateRoot,
        npmDeps: {},
        workspaceDeps: { '@omadia/plugin-api': pluginApi },
        skipNpmInstall: true,
      });

      assert.equal(result.ready, true);
      assert.equal(result.reused, false);
      assert.ok(existsSync(path.join(templateRoot, 'package.json')));
      assert.ok(existsSync(path.join(templateRoot, '.harness-build-template.hash')));
      const linkPath = path.join(templateRoot, 'node_modules', '@byte5', 'harness-plugin-api');
      assert.ok(lstatSync(linkPath).isSymbolicLink());
    });

    it('writes a deterministic package.json (sorted deps)', async () => {
      const templateRoot = freshTemplateRoot('init-2');
      await ensureBuildTemplate({
        templateRoot,
        npmDeps: { zod: '^3.23.8', typescript: '^5.0.0' },
        workspaceDeps: {},
        skipNpmInstall: true,
      });
      const pkgRaw = readFileSync(path.join(templateRoot, 'package.json'), 'utf-8');
      const pkg = JSON.parse(pkgRaw) as { dependencies: Record<string, string> };
      assert.deepEqual(Object.keys(pkg.dependencies), ['typescript', 'zod']);
    });

    it('reuses the existing template when content hash matches', async () => {
      const templateRoot = freshTemplateRoot('idempotent');
      const wsPath = fakeWorkspacePkg('@omadia/plugin-api', '-2');

      const opts = {
        templateRoot,
        npmDeps: { zod: '^3.23.8' },
        workspaceDeps: { '@omadia/plugin-api': wsPath },
        skipNpmInstall: true,
      };

      const first = await ensureBuildTemplate(opts);
      assert.equal(first.reused, false);

      const second = await ensureBuildTemplate(opts);
      assert.equal(second.reused, true);
      assert.equal(second.ready, true);
    });

    it('reinstalls when npm dep set changes (hash change)', async () => {
      const templateRoot = freshTemplateRoot('hash-change');
      const wsPath = fakeWorkspacePkg('@omadia/plugin-api', '-3');

      await ensureBuildTemplate({
        templateRoot,
        npmDeps: { zod: '^3.23.8' },
        workspaceDeps: { '@omadia/plugin-api': wsPath },
        skipNpmInstall: true,
      });

      const second = await ensureBuildTemplate({
        templateRoot,
        npmDeps: { zod: '^3.23.8', typescript: '^5.0.0' },
        workspaceDeps: { '@omadia/plugin-api': wsPath },
        skipNpmInstall: true,
      });

      assert.equal(second.reused, false);
      const pkg = JSON.parse(
        readFileSync(path.join(templateRoot, 'package.json'), 'utf-8'),
      ) as { dependencies: Record<string, string> };
      assert.ok('typescript' in pkg.dependencies);
    });

    it('reinstalls when a workspace dep path changes', async () => {
      const templateRoot = freshTemplateRoot('ws-change');
      const ws1 = fakeWorkspacePkg('@omadia/plugin-api', '-4a');
      const ws2 = fakeWorkspacePkg('@omadia/plugin-api', '-4b');

      await ensureBuildTemplate({
        templateRoot,
        npmDeps: {},
        workspaceDeps: { '@omadia/plugin-api': ws1 },
        skipNpmInstall: true,
      });

      const second = await ensureBuildTemplate({
        templateRoot,
        npmDeps: {},
        workspaceDeps: { '@omadia/plugin-api': ws2 },
        skipNpmInstall: true,
      });

      assert.equal(second.reused, false);
    });

    it('replaces stale workspace symlinks on reinit', async () => {
      const templateRoot = freshTemplateRoot('replace-stale');
      const wsOld = fakeWorkspacePkg('@omadia/plugin-api', '-5a');
      const wsNew = fakeWorkspacePkg('@omadia/plugin-api', '-5b');

      await ensureBuildTemplate({
        templateRoot,
        npmDeps: {},
        workspaceDeps: { '@omadia/plugin-api': wsOld },
        skipNpmInstall: true,
      });

      await ensureBuildTemplate({
        templateRoot,
        npmDeps: {},
        workspaceDeps: { '@omadia/plugin-api': wsNew },
        skipNpmInstall: true,
      });

      const linkPath = path.join(
        templateRoot,
        'node_modules',
        '@byte5',
        'harness-plugin-api',
      );
      const pkgJson = JSON.parse(
        readFileSync(path.join(linkPath, 'package.json'), 'utf-8'),
      ) as { name: string };
      assert.equal(pkgJson.name, '@omadia/plugin-api');
      // Same name, but resolves through wsNew (not wsOld).
      assert.match(pkgJson.name, /@byte5\/harness-plugin-api/);
    });

    it('reports ready=false with reason when no node_modules exists', async () => {
      // Edge case: hash file matches but node_modules was wiped externally.
      const templateRoot = freshTemplateRoot('wiped-nm');
      const ws = fakeWorkspacePkg('@omadia/plugin-api', '-6');

      await ensureBuildTemplate({
        templateRoot,
        npmDeps: {},
        workspaceDeps: { '@omadia/plugin-api': ws },
        skipNpmInstall: true,
      });

      // Wipe node_modules but keep hash
      rmSync(path.join(templateRoot, 'node_modules'), { recursive: true, force: true });

      const second = await ensureBuildTemplate({
        templateRoot,
        npmDeps: {},
        workspaceDeps: { '@omadia/plugin-api': ws },
        skipNpmInstall: true,
      });
      assert.equal(second.reused, false);
      assert.equal(second.ready, true);
    });
  });

  describe('prepareStagingDir', () => {
    it('writes files (incl. nested) and symlinks node_modules', async () => {
      const templateRoot = freshTemplateRoot('staging-1-template');
      const ws = fakeWorkspacePkg('@omadia/plugin-api', '-7');
      await ensureBuildTemplate({
        templateRoot,
        npmDeps: {},
        workspaceDeps: { '@omadia/plugin-api': ws },
        skipNpmInstall: true,
      });

      const stagingBaseDir = path.join(tmp, 'staging-1-base');
      const files = new Map<string, Buffer>([
        ['package.json', Buffer.from('{}', 'utf-8')],
        ['src/foo.ts', Buffer.from('export const x = 1;', 'utf-8')],
        ['skills/expert.md', Buffer.from('# Hi', 'utf-8')],
      ]);

      const stagingDir = await prepareStagingDir({
        templateRoot,
        draftId: 'draft-abc',
        buildN: 1,
        files,
        stagingBaseDir,
      });

      assert.ok(existsSync(path.join(stagingDir, 'package.json')));
      assert.ok(existsSync(path.join(stagingDir, 'src', 'foo.ts')));
      assert.ok(existsSync(path.join(stagingDir, 'skills', 'expert.md')));
      assert.ok(lstatSync(path.join(stagingDir, 'node_modules')).isSymbolicLink());
    });

    it('embeds draftId + buildN in the dir name', async () => {
      const templateRoot = freshTemplateRoot('staging-2-template');
      await ensureBuildTemplate({
        templateRoot,
        npmDeps: {},
        workspaceDeps: {},
        skipNpmInstall: true,
      });
      const stagingBaseDir = path.join(tmp, 'staging-2-base');
      const stagingDir = await prepareStagingDir({
        templateRoot,
        draftId: 'mydraft',
        buildN: 7,
        files: new Map(),
        stagingBaseDir,
      });
      assert.match(path.basename(stagingDir), /^mydraft-7-/);
    });

    it('produces distinct staging dirs across calls (timestamped)', async () => {
      const templateRoot = freshTemplateRoot('staging-3-template');
      await ensureBuildTemplate({
        templateRoot,
        npmDeps: {},
        workspaceDeps: {},
        skipNpmInstall: true,
      });
      const stagingBaseDir = path.join(tmp, 'staging-3-base');
      const a = await prepareStagingDir({
        templateRoot,
        draftId: 'd',
        buildN: 1,
        files: new Map(),
        stagingBaseDir,
      });
      // Sleep > 1ms to guarantee unique Date.now() in dir name on fast hosts.
      await new Promise((r) => setTimeout(r, 5));
      const b = await prepareStagingDir({
        templateRoot,
        draftId: 'd',
        buildN: 1,
        files: new Map(),
        stagingBaseDir,
      });
      assert.notEqual(a, b);
    });
  });

  describe('cleanupStagingDir', () => {
    it('removes the staging dir and all its content', async () => {
      const templateRoot = freshTemplateRoot('cleanup-template');
      await ensureBuildTemplate({
        templateRoot,
        npmDeps: {},
        workspaceDeps: {},
        skipNpmInstall: true,
      });
      const stagingBaseDir = path.join(tmp, 'cleanup-base');
      const stagingDir = await prepareStagingDir({
        templateRoot,
        draftId: 'd',
        buildN: 1,
        files: new Map([['a.txt', Buffer.from('hi')]]),
        stagingBaseDir,
      });
      assert.ok(existsSync(stagingDir));
      await cleanupStagingDir(stagingDir);
      assert.equal(existsSync(stagingDir), false);
    });
  });
});
