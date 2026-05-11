import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  loadBuildTemplateConfig,
  DEFAULT_BOILERPLATE_PACKAGE_JSON,
} from '../../src/plugins/builder/buildTemplateConfig.js';
import {
  _resetServiceTypeRegistryForTests,
  registerServiceType,
} from '../../src/plugins/builder/serviceTypeRegistry.js';


interface Setup {
  tmpRoot: string;
  pkgJsonPath: string;
  workspacePackagesRoot: string;
  cleanup: () => void;
}

function setup(opts: {
  pkg: Record<string, unknown>;
  workspacePackages?: string[];
}): Setup {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), 'build-template-config-'));
  const pkgJsonPath = path.join(tmpRoot, 'pkg', 'package.json');
  const workspacePackagesRoot = path.join(tmpRoot, 'packages');
  mkdirSync(path.dirname(pkgJsonPath), { recursive: true });
  writeFileSync(pkgJsonPath, JSON.stringify(opts.pkg, null, 2), 'utf8');
  for (const wp of opts.workspacePackages ?? []) {
    mkdirSync(path.join(workspacePackagesRoot, wp), { recursive: true });
  }
  return {
    tmpRoot,
    pkgJsonPath,
    workspacePackagesRoot,
    cleanup() {
      rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}

describe('loadBuildTemplateConfig', () => {
  beforeEach(() => {
    // Phase 5B: clear registry by default. Specific tests opt into
    // seeding via `seedServiceTypeRegistry()` inline — the historical
    // entries point at packages that no longer ship in this repo, so
    // a blanket beforeEach seed makes the loader fail loudly with
    // ENOENT against the missing dirs.
    _resetServiceTypeRegistryForTests();
  });

  it('partitions @omadia/* into workspaceDeps and the rest into npmDeps', async () => {
    const s = setup({
      pkg: {
        dependencies: { '@omadia/plugin-api': '^0.1.0' },
        peerDependencies: { zod: '^3.23.8', typescript: '5.x' },
      },
      workspacePackages: ['plugin-api'],
    });
    try {
      const cfg = await loadBuildTemplateConfig({
        boilerplatePackageJsonPath: s.pkgJsonPath,
        workspacePackagesRoot: s.workspacePackagesRoot,
        includeServiceTypeRegistryDeps: false,
      });
      assert.deepEqual(cfg.npmDeps, {
        zod: '^3.23.8',
        typescript: '5.x',
      });
      assert.equal(Object.keys(cfg.workspaceDeps).length, 1);
      assert.equal(
        cfg.workspaceDeps['@omadia/plugin-api'],
        path.join(s.workspacePackagesRoot, 'plugin-api'),
      );
    } finally {
      s.cleanup();
    }
  });

  it('returns empty workspaceDeps when boilerplate has no @byte5/* deps', async () => {
    const s = setup({
      pkg: { peerDependencies: { zod: '^3.23.8' } },
    });
    try {
      const cfg = await loadBuildTemplateConfig({
        boilerplatePackageJsonPath: s.pkgJsonPath,
        workspacePackagesRoot: s.workspacePackagesRoot,
        includeServiceTypeRegistryDeps: false,
      });
      // BUILD_TIME_ONLY_DEPS (B.6-12.3) injects typescript on top of the
      // boilerplate's runtime deps so the staging dir's `npx tsc` works.
      assert.deepEqual(cfg.npmDeps, {
        zod: '^3.23.8',
        typescript: '^5.4.0',
      });
      assert.deepEqual(cfg.workspaceDeps, {});
    } finally {
      s.cleanup();
    }
  });

  it('still injects build-time-only deps for a dep-less package.json', async () => {
    const s = setup({ pkg: {} });
    try {
      const cfg = await loadBuildTemplateConfig({
        boilerplatePackageJsonPath: s.pkgJsonPath,
        workspacePackagesRoot: s.workspacePackagesRoot,
        includeServiceTypeRegistryDeps: false,
      });
      // typescript still merged in from BUILD_TIME_ONLY_DEPS even when the
      // boilerplate declares zero runtime deps.
      assert.deepEqual(cfg.npmDeps, { typescript: '^5.4.0' });
      assert.deepEqual(cfg.workspaceDeps, {});
    } finally {
      s.cleanup();
    }
  });

  it('fails loud when a @byte5/* dep references a non-existent workspace dir', async () => {
    const s = setup({
      pkg: { dependencies: { '@omadia/missing': '^0.1.0' } },
    });
    try {
      await assert.rejects(
        () =>
          loadBuildTemplateConfig({
            boilerplatePackageJsonPath: s.pkgJsonPath,
            workspacePackagesRoot: s.workspacePackagesRoot,
            includeServiceTypeRegistryDeps: false,
          }),
        /no such directory/,
      );
    } finally {
      s.cleanup();
    }
  });

  it('fails loud when boilerplate package.json is missing', async () => {
    await assert.rejects(
      () =>
        loadBuildTemplateConfig({
          boilerplatePackageJsonPath: '/nonexistent/path/package.json',
          workspacePackagesRoot: '/tmp',
        }),
      /cannot read boilerplate package.json/,
    );
  });

  it('fails loud when boilerplate package.json is malformed', async () => {
    const s = setup({ pkg: {} });
    writeFileSync(s.pkgJsonPath, '{ not valid json', 'utf8');
    try {
      await assert.rejects(
        () =>
          loadBuildTemplateConfig({
            boilerplatePackageJsonPath: s.pkgJsonPath,
            workspacePackagesRoot: s.workspacePackagesRoot,
            includeServiceTypeRegistryDeps: false,
          }),
        /malformed JSON/,
      );
    } finally {
      s.cleanup();
    }
  });

  it('uses real boilerplate path by default (smoke)', async () => {
    // Smoke check: the default-path resolution works and the real boilerplate
    // package.json yields a deterministic config (today: zod only).
    const cfg = await loadBuildTemplateConfig();
    assert.ok('zod' in cfg.npmDeps, 'expected zod in npmDeps');
    // Sanity: the default-path constant points at a valid file
    assert.match(DEFAULT_BOILERPLATE_PACKAGE_JSON, /agent-integration\/package\.json$/);
  });

  it('merges integration packages from serviceTypeRegistry into workspaceDeps (Theme A)', async () => {
    // Phase 5B: the historical assertion checked that the three byte5
    // integration packages (`@omadia/integration-{odoo,confluence,
    // microsoft365}`) auto-merged into workspaceDeps because the registry
    // was hardcoded against them. With the OSS-decoupling those packages
    // live in a separate repo. Test the dynamic-registration contract
    // instead: a registered entry whose package directory exists ends up
    // in workspaceDeps; one whose dir is missing makes the load fail
    // loudly (the loader's `loadBuildTemplateConfig: serviceTypeRegistry
    // references X but Y does not exist` message).
    const s = setup({ pkg: {}, workspacePackages: ['fake-integration-pkg'] });
    try {
      // Re-seed registry with one fake plugin pointing at the temp
      // workspace; the other historical entries are dropped to avoid
      // ENOENT against now-removed package dirs.
      _resetServiceTypeRegistryForTests();
      registerServiceType('fake.svc', {
        providedBy: 'de.byte5.integration.fake',
        typeImport: { from: 'fake-integration-pkg', name: 'FakeClient' },
      });
      const cfg = await loadBuildTemplateConfig({
        boilerplatePackageJsonPath: s.pkgJsonPath,
        workspacePackagesRoot: s.workspacePackagesRoot,
      });
      assert.ok(
        'fake-integration-pkg' in cfg.workspaceDeps,
        'expected fake-integration-pkg in workspaceDeps after registerServiceType',
      );
    } finally {
      s.cleanup();
    }
  });

  it('skips integration packages when includeServiceTypeRegistryDeps=false', async () => {
    const s = setup({ pkg: {} });
    try {
      const cfg = await loadBuildTemplateConfig({
        boilerplatePackageJsonPath: s.pkgJsonPath,
        workspacePackagesRoot: s.workspacePackagesRoot,
        includeServiceTypeRegistryDeps: false,
      });
      // No @byte5/* in workspaceDeps because boilerplate has none and
      // the registry merge is opted out.
      assert.deepEqual(cfg.workspaceDeps, {});
    } finally {
      s.cleanup();
    }
  });
});
