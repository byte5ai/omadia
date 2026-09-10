import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, mock } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  adaptManifestV1,
  loadManifestFromPath,
  PluginCatalog,
} from '../src/plugins/manifestLoader.js';
import type { UnknownPermissionKeys } from '../src/plugins/manifestLoader.js';

const DEFAULT_MANIFEST_DIR = fileURLToPath(
  new URL('../../docs/harness-platform/examples', import.meta.url),
);
const PACKAGES_DIR = fileURLToPath(new URL('../packages/', import.meta.url));

function manifest(
  id: string,
  permissions?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    schema_version: '1',
    identity: {
      id,
      kind: 'integration',
      domain: 'test',
      name: id,
      version: '1.0.0',
    },
    ...(permissions === undefined ? {} : { permissions }),
  };
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'manifest-boot-'));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

interface CapturedLogs {
  readonly warnings: string[];
  readonly debug: string[];
}

async function withCapturedLogs(
  run: (logs: CapturedLogs) => Promise<void>,
): Promise<void> {
  const logs: CapturedLogs = { warnings: [], debug: [] };
  const warn = mock.method(console, 'warn', (...args: unknown[]): void => {
    logs.warnings.push(args.map(String).join(' '));
  });
  const debug = mock.method(console, 'debug', (...args: unknown[]): void => {
    logs.debug.push(args.map(String).join(' '));
  });
  try {
    await run(logs);
  } finally {
    warn.mock.restore();
    debug.mock.restore();
  }
}

async function withManifestDirEnv(
  value: string | undefined,
  run: () => Promise<void>,
): Promise<void> {
  const previous = process.env['PLUGIN_MANIFEST_DIR'];
  if (value === undefined) delete process.env['PLUGIN_MANIFEST_DIR'];
  else process.env['PLUGIN_MANIFEST_DIR'] = value;
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env['PLUGIN_MANIFEST_DIR'];
    else process.env['PLUGIN_MANIFEST_DIR'] = previous;
  }
}

async function withDefaultDirectoryError(
  code: string,
  run: (error: NodeJS.ErrnoException) => Promise<void>,
): Promise<void> {
  const error: NodeJS.ErrnoException = Object.assign(new Error(code), { code });
  // OM-93: the local-only default may exist on a developer machine. Inject
  // its failure without removing their docs or changing another source's I/O.
  const readdir = mock.method(fs, 'readdir', async (dir: unknown) => {
    assert.equal(dir, DEFAULT_MANIFEST_DIR);
    throw error;
  });
  try {
    await run(error);
  } finally {
    readdir.mock.restore();
  }
}

async function writeManifest(
  file: string,
  id: string,
  permissions?: Record<string, unknown>,
): Promise<void> {
  await fs.writeFile(file, JSON.stringify(manifest(id, permissions)));
}

describe('OM-89 catalog permission diagnostics', { concurrency: false }, () => {
  it('accepts filesystem as a live permission without reporting it', () => {
    const reports: (readonly UnknownPermissionKeys[])[] = [];
    for (const permissions of [
      { filesystem: { scratch: true } },
      { filesystem: { scratch: false } },
      {},
      undefined,
    ]) {
      const plugin = adaptManifestV1(
        manifest('test.filesystem', permissions),
        (diagnostics) => reports.push(diagnostics),
      );
      assert.ok(plugin);
    }
    assert.deepEqual(reports, []);
  });

  it('reports unknown keys as data while still adapting the manifest', () => {
    const reports: (readonly UnknownPermissionKeys[])[] = [];
    const plugin = adaptManifestV1(
      manifest('test.unknown', {
        foo: true,
        filesystem: { scratch: true },
        bar: { retired_option: true },
        flows: true,
      }),
      (diagnostics) => reports.push(diagnostics),
    );
    assert.ok(plugin);
    assert.equal(plugin.permissions_summary.flows, true);
    assert.equal(Object.hasOwn(plugin.permissions_summary, 'foo'), false);
    assert.equal(Object.hasOwn(plugin.permissions_summary, 'bar'), false);
    assert.deepEqual(reports, [
      [{ pluginId: 'test.unknown', keys: ['bar', 'foo'] }],
    ]);
  });

  it('preserves the default warning for direct adapt callers', async () => {
    await withCapturedLogs(async ({ warnings }) => {
      assert.ok(adaptManifestV1(manifest('test.direct', { foo: true })));
      assert.equal(warnings.length, 1);
      assert.equal(
        warnings[0],
        '[catalog] 1 plugin(s) declare unknown permission key(s) permissions.foo: test.direct' +
          ' — ignored. Check the spelling, or the core version this manifest was written against.',
      );
    });
  });

  it('forwards a direct single-file load diagnostic to its collector', async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, 'manifest.yaml');
      await writeManifest(file, 'test.single-file', { foo: true });
      const reports: (readonly UnknownPermissionKeys[])[] = [];
      const entry = await loadManifestFromPath(file, (diagnostics) => reports.push(diagnostics));
      assert.ok(entry);
      assert.equal(entry.plugin.id, 'test.single-file');
      assert.deepEqual(entry.manifest, manifest('test.single-file', { foo: true }));
      assert.deepEqual(reports, [
        [{ pluginId: 'test.single-file', keys: ['foo'] }],
      ]);
    });
  });

  it('preserves the default warning for direct single-file load callers', async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, 'manifest.yaml');
      await writeManifest(file, 'test.direct-file', { foo: true });
      await withCapturedLogs(async ({ warnings }) => {
        const entry = await loadManifestFromPath(file);
        assert.ok(entry);
        assert.equal(entry.plugin.id, 'test.direct-file');
        assert.deepEqual(warnings, [
          '[catalog] 1 plugin(s) declare unknown permission key(s) permissions.foo: test.direct-file' +
            ' — ignored. Check the spelling, or the core version this manifest was written against.',
        ]);
      });
    });
  });

  it('collects both sources once and clears diagnostics on the next catalog build', async () => {
    await withTempDir(async (dir) => {
      const legacyFile = path.join(dir, 'first.manifest.yaml');
      const packageRoot = path.join(dir, 'extra');
      const extraFile = path.join(packageRoot, 'manifest.yaml');
      await fs.mkdir(packageRoot);
      await writeManifest(legacyFile, 'test.first', { foo: true });
      await writeManifest(extraFile, 'test.second', { bar: true });
      const reports: (readonly UnknownPermissionKeys[])[] = [];
      const catalog = new PluginCatalog({
        manifestDir: dir,
        extraSources: () => [{ packageRoot }],
        reportUnknownPermissions: (diagnostics) => reports.push(diagnostics),
      });

      await catalog.load();
      assert.deepEqual(reports, [[
        { pluginId: 'test.first', keys: ['foo'] },
        { pluginId: 'test.second', keys: ['bar'] },
      ]]);
      assert.equal(catalog.list().length, 2, 'unknown keys never reject a plugin');

      await writeManifest(legacyFile, 'test.first', { filesystem: { scratch: true } });
      await writeManifest(extraFile, 'test.second', {});
      await catalog.load();
      assert.equal(reports.length, 1, 'the clean reload must not re-report old diagnostics');
      assert.equal(catalog.list().length, 2);

      await writeManifest(extraFile, 'test.second', { baz: true });
      await catalog.load();
      assert.deepEqual(reports[1], [{ pluginId: 'test.second', keys: ['baz'] }]);
      assert.equal(reports.length, 2, 'each nonempty build reports once');
      assert.deepEqual(reports[0], [
        { pluginId: 'test.first', keys: ['foo'] },
        { pluginId: 'test.second', keys: ['bar'] },
      ], 'later builds must not mutate a previous report');
    });
  });

  it('emits one deterministic warning naming both plugin ids and unique keys', async () => {
    await withTempDir(async (dir) => {
      await writeManifest(path.join(dir, 'a.manifest.yaml'), 'test.zed', { foo: true });
      await writeManifest(path.join(dir, 'b.manifest.yaml'), 'test.alpha', { foo: true, bar: true });
      await withCapturedLogs(async ({ warnings }) => {
        await new PluginCatalog({ manifestDir: dir }).load();
        assert.deepEqual(warnings, [
          '[catalog] 2 plugin(s) declare unknown permission key(s) permissions.bar, permissions.foo: test.alpha, test.zed' +
            ' — ignored. Check the spelling, or the core version this manifest was written against.',
        ]);
      });
    });
  });

  it('loads all 24 built-in filesystem manifests without an unknown-key report', async () => {
    await withTempDir(async (dir) => {
      const packageRoots: string[] = [];
      for (const entry of await fs.readdir(PACKAGES_DIR, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const packageRoot = path.join(PACKAGES_DIR, entry.name);
        let raw: string;
        try {
          raw = await fs.readFile(path.join(packageRoot, 'manifest.yaml'), 'utf-8');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        if (/^ {2}filesystem:\s*$/m.test(raw)) packageRoots.push(packageRoot);
      }
      assert.ok(packageRoots.length >= 24, 'all 24 current built-in declarations must be covered');
      const reports: (readonly UnknownPermissionKeys[])[] = [];
      const catalog = new PluginCatalog({
        manifestDir: dir,
        extraSources: () => packageRoots.map((packageRoot) => ({ packageRoot, origin: 'bundled' })),
        reportUnknownPermissions: (diagnostics) => reports.push(diagnostics),
      });
      await catalog.load();
      assert.equal(catalog.list().length, packageRoots.length);
      assert.deepEqual(reports, []);
    });
  });
});

describe('OM-93 manifest directory optionality', { concurrency: false }, () => {
  it('logs a missing unconfigured default at debug level without warning', async () => {
    await withManifestDirEnv(undefined, async () => {
      await withDefaultDirectoryError('ENOENT', async () => {
        await withCapturedLogs(async ({ warnings, debug }) => {
          const catalog = new PluginCatalog();
          await catalog.load();
          assert.deepEqual(warnings, []);
          assert.equal(debug.length, 1);
          assert.ok(debug[0]?.includes(DEFAULT_MANIFEST_DIR));
          assert.deepEqual(catalog.list(), []);
        });
      });
    });
  });

  it('warns when an explicitly configured options directory is missing', async () => {
    await withTempDir(async (dir) => {
      const missing = path.join(dir, 'operator-configured-missing');
      await withCapturedLogs(async ({ warnings, debug }) => {
        const catalog = new PluginCatalog({ manifestDir: missing });
        await catalog.load();
        assert.deepEqual(warnings, [`[catalog] directory does not exist, skipping: ${missing}`]);
        assert.deepEqual(debug, []);
        assert.deepEqual(catalog.list(), []);
      });
    });
  });

  it('warns for a missing PLUGIN_MANIFEST_DIR set after module import', async () => {
    await withTempDir(async (dir) => {
      const missing = path.join(dir, 'docker-configured-missing');
      const catalog = new PluginCatalog();
      await withManifestDirEnv(missing, async () => {
        await withCapturedLogs(async ({ warnings, debug }) => {
          await catalog.load();
          assert.deepEqual(warnings, [`[catalog] directory does not exist, skipping: ${missing}`]);
          assert.deepEqual(debug, []);
        });
      });
    });
  });

  it('treats an explicitly configured default path as required', async () => {
    await withManifestDirEnv(DEFAULT_MANIFEST_DIR, async () => {
      await withDefaultDirectoryError('ENOENT', async () => {
        await withCapturedLogs(async ({ warnings, debug }) => {
          await new PluginCatalog().load();
          assert.deepEqual(warnings, [
            `[catalog] directory does not exist, skipping: ${DEFAULT_MANIFEST_DIR}`,
          ]);
          assert.deepEqual(debug, []);
        });
      });
    });
  });

  it('keeps an explicit options directory ahead of the environment source', async () => {
    await withTempDir(async (dir) => {
      await writeManifest(path.join(dir, 'plugin.manifest.yaml'), 'test.options-priority');
      await withManifestDirEnv(path.join(dir, 'missing-env-source'), async () => {
        await withCapturedLogs(async ({ warnings, debug }) => {
          const catalog = new PluginCatalog({ manifestDir: dir });
          await catalog.load();
          assert.ok(catalog.get('test.options-priority'));
          assert.deepEqual(warnings, []);
          assert.deepEqual(debug, []);
        });
      });
    });
  });

  it('rethrows a non-ENOENT error from the optional source unchanged', async () => {
    await withManifestDirEnv(undefined, async () => {
      await withDefaultDirectoryError('EACCES', async (expected) => {
        await withCapturedLogs(async ({ warnings, debug }) => {
          await assert.rejects(new PluginCatalog().load(), (error: unknown) => error === expected);
          assert.deepEqual(warnings, []);
          assert.deepEqual(debug, []);
        });
      });
    });
  });

  it('rethrows a real non-ENOENT readdir failure from a required source', async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, 'not-a-directory');
      await fs.writeFile(file, 'ordinary file');
      await withCapturedLogs(async ({ warnings, debug }) => {
        await assert.rejects(new PluginCatalog({ manifestDir: file }).load(), {
          code: 'ENOTDIR',
        });
        assert.deepEqual(warnings, []);
        assert.deepEqual(debug, []);
      });
    });
  });
});
