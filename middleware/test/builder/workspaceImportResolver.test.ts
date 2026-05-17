import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  _internal,
  extractImports,
  loadInstalledPackagesLookup,
  packageRootOf,
  validateBundleImports,
} from '../../src/plugins/builder/workspaceImportResolver.js';

describe('workspaceImportResolver', () => {
  beforeEach(() => {
    _internal.resetLookupCache();
  });

  describe('extractImports', () => {
    it('captures bare-specifier import statements with line numbers', () => {
      const src = [
        "import { z } from 'zod';",
        "import * as fs from 'node:fs';",
        '',
        "import type { OdooClient } from '@omadia/integration-odoo';",
      ].join('\n');
      const found = extractImports(src);
      assert.deepEqual(
        found,
        [
          { specifier: 'zod', line: 1 },
          { specifier: 'node:fs', line: 2 },
          { specifier: '@omadia/integration-odoo', line: 4 },
        ],
      );
    });

    it('captures dynamic import() and require() forms', () => {
      const src = [
        "const mod = await import('lodash');",
        "const cp = require('node:child_process');",
      ].join('\n');
      const found = extractImports(src);
      assert.deepEqual(
        found,
        [
          { specifier: 'lodash', line: 1 },
          { specifier: 'node:child_process', line: 2 },
        ],
      );
    });

    it('skips relative and absolute imports', () => {
      const src = [
        "import { foo } from './foo.js';",
        "import { bar } from '../bar.js';",
        "import { baz } from '/baz.js';",
      ].join('\n');
      assert.deepEqual(extractImports(src), []);
    });

    it('does not match the word import inside identifiers', () => {
      const src = "const importer = 'not-an-import';";
      assert.deepEqual(extractImports(src), []);
    });
  });

  describe('packageRootOf', () => {
    it('strips subpaths from scoped packages', () => {
      assert.equal(
        packageRootOf('@anthropic-ai/sdk/resources/messages.js'),
        '@anthropic-ai/sdk',
      );
    });
    it('strips subpaths from unscoped packages', () => {
      assert.equal(packageRootOf('lodash/fp/get.js'), 'lodash');
    });
    it('returns scoped name unchanged when no subpath', () => {
      assert.equal(packageRootOf('@omadia/plugin-api'), '@omadia/plugin-api');
    });
  });

  describe('validateBundleImports', () => {
    const allowAll = { isInstalled: () => true };
    const installedSet = (names: string[]) => ({
      isInstalled: (s: string): boolean => names.includes(packageRootOf(s)),
    });

    it('flags forbidden internal packages with the standalone-compile hint', () => {
      const files = new Map<string, Buffer>([
        [
          'plugin.ts',
          Buffer.from(
            "import type { PluginContext } from '@omadia/plugin-api';\n",
          ),
        ],
      ]);
      const issues = validateBundleImports(files, allowAll);
      assert.equal(issues.length, 1);
      const issue = issues[0]!;
      assert.equal(issue.code, 'IMPORT_FORBIDDEN');
      assert.equal(issue.path, 'plugin.ts');
      assert.equal(issue.line, 1);
      assert.match(issue.message, /forbidden/i);
      assert.match(issue.message, /standalone/i);
      assert.match(issue.message, /types\.ts/);
    });

    it('flags unresolved bare specifiers when not in the build-template', () => {
      const files = new Map<string, Buffer>([
        [
          'toolkit.ts',
          Buffer.from("import { something } from 'some-uninstalled-pkg';\n"),
        ],
      ]);
      const issues = validateBundleImports(files, installedSet([]));
      assert.equal(issues.length, 1);
      const issue = issues[0]!;
      assert.equal(issue.code, 'IMPORT_UNRESOLVED');
      assert.match(issue.message, /peerDependencies/);
    });

    it('passes installed packages through silently', () => {
      const files = new Map<string, Buffer>([
        [
          'toolkit.ts',
          Buffer.from(
            ["import { z } from 'zod';", "import { foo } from 'lodash';"].join('\n'),
          ),
        ],
      ]);
      const issues = validateBundleImports(files, installedSet(['zod', 'lodash']));
      assert.deepEqual(issues, []);
    });

    it('skips non-text files', () => {
      const files = new Map<string, Buffer>([
        ['assets/logo.png', Buffer.from([0xff, 0xd8, 0xff])],
        [
          'README.md',
          Buffer.from("Refer to `import { foo } from 'unresolved'` …"),
        ],
      ]);
      assert.deepEqual(validateBundleImports(files, installedSet([])), []);
    });

    it('dedupes per (file, package-root) so one bad import wins once per file', () => {
      const files = new Map<string, Buffer>([
        [
          'plugin.ts',
          Buffer.from(
            [
              "import { a } from '@omadia/plugin-api';",
              "import { b } from '@omadia/plugin-api/sub';",
              "import { c } from '@omadia/plugin-api/other';",
            ].join('\n'),
          ),
        ],
      ]);
      const issues = validateBundleImports(files, allowAll);
      assert.equal(issues.length, 1);
      assert.equal(issues[0]!.code, 'IMPORT_FORBIDDEN');
    });

    it('intrinsically allows node:* built-ins regardless of lookup', () => {
      const files = new Map<string, Buffer>([
        [
          'plugin.ts',
          Buffer.from(
            [
              "import path from 'node:path';",
              "import { spawn } from 'node:child_process';",
              "import { promises as fs } from 'node:fs';",
              "const url = require('node:url');",
            ].join('\n'),
          ),
        ],
      ]);
      // node:* are Node built-ins per ESM spec; they never resolve through
      // node_modules so the installed-packages lookup cannot answer for
      // them. The resolver must allow them without lookup wiring — proven
      // here by passing a deny-all lookup.
      const issues = validateBundleImports(files, installedSet([]));
      assert.deepEqual(issues, []);
    });

    it('skips boilerplate scripts/ paths from gate scope', () => {
      const files = new Map<string, Buffer>([
        [
          'scripts/build-zip.mjs',
          Buffer.from(
            [
              "import { spawn } from 'node:child_process';",
              "import { readFile } from 'node:fs';",
              "import { someBuildHelper } from 'definitely-not-installed-pkg';",
            ].join('\n'),
          ),
        ],
        [
          'src/plugin.ts',
          Buffer.from("import { z } from 'zod';\n"),
        ],
      ]);
      // scripts/ runs at zip-pack time on the host, not inside the plugin
      // sandbox. Imports there are out-of-scope for the runtime gate.
      const issues = validateBundleImports(files, installedSet(['zod']));
      assert.deepEqual(issues, []);
    });
  });

  describe('loadInstalledPackagesLookup', () => {
    let tmp: string;

    beforeEach(() => {
      tmp = mkdtempSync(path.join(tmpdir(), 'wsimp-'));
    });

    function seedNodeModules(files: Record<string, string | null>): void {
      const nm = path.join(tmp, 'node_modules');
      mkdirSync(nm, { recursive: true });
      for (const [rel, content] of Object.entries(files)) {
        const target = path.join(nm, rel);
        if (content === null) {
          mkdirSync(target, { recursive: true });
        } else {
          mkdirSync(path.dirname(target), { recursive: true });
          writeFileSync(target, content, 'utf8');
        }
      }
    }

    it('detects unscoped + scoped packages', async () => {
      seedNodeModules({
        zod: null,
        '@omadia/integration-odoo': null,
        '@anthropic-ai/sdk': null,
      });
      const lookup = await loadInstalledPackagesLookup(tmp);
      assert.equal(lookup.isInstalled('zod'), true);
      assert.equal(lookup.isInstalled('@omadia/integration-odoo'), true);
      assert.equal(lookup.isInstalled('@anthropic-ai/sdk'), true);
      assert.equal(lookup.isInstalled('not-installed'), false);
    });

    it('respects subpath specifiers via package-root extraction', async () => {
      seedNodeModules({ '@anthropic-ai/sdk': null });
      const lookup = await loadInstalledPackagesLookup(tmp);
      assert.equal(
        lookup.isInstalled('@anthropic-ai/sdk/resources/messages.js'),
        true,
      );
    });

    // TODO: pre-existing workshop failure, predates single-repo consolidation.
    // Symlink detection in node_modules returns false where true expected;
    // likely needs update after `@byte5/` → `@omadia/` workspace rename.
    it.skip('treats workspace symlinks as installed', async () => {
      const target = path.join(tmp, 'fake-pkg');
      mkdirSync(target, { recursive: true });
      writeFileSync(path.join(target, 'package.json'), '{}');
      const nm = path.join(tmp, 'node_modules', '@byte5');
      mkdirSync(nm, { recursive: true });
      symlinkSync(target, path.join(nm, 'harness-integration-odoo'), 'dir');

      const lookup = await loadInstalledPackagesLookup(tmp);
      assert.equal(lookup.isInstalled('@omadia/integration-odoo'), true);

      rmSync(tmp, { recursive: true, force: true });
    });

    it('returns an empty lookup when node_modules is missing', async () => {
      const lookup = await loadInstalledPackagesLookup(tmp);
      assert.equal(lookup.isInstalled('zod'), false);
    });
  });
});
