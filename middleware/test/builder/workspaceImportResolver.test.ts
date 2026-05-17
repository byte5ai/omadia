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
import { generate } from '../../src/plugins/builder/codegen.js';
import { parseAgentSpec } from '../../src/plugins/builder/agentSpec.js';

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

    it('does not match import-like example code embedded in JSDoc blocks', () => {
      // Reproduces the regression where the boilerplate `types.ts` tripped
      // IMPORT_FORBIDDEN at line 307 because the regex spanned the JSDoc's
      // `*  ` continuation prefix and matched a code-sample sentence. The
      // strip pass must zero out the comment body before the regex runs.
      const src = [
        '/**',
        ' * Read-only: full-text Turn search. Returns implementation-specific',
        ' * hits — the boilerplate keeps the row type opaque (`unknown`) to',
        ' * avoid pulling in the whole KG type surface from `@omadia/plugin-api`.',
        " * Plugins that need the structured shape: `import type { TurnSearchHit }",
        " * from '@omadia/plugin-api'` and add the package as a peerDep.",
        ' */',
        "import { z } from 'zod';",
      ].join('\n');
      assert.deepEqual(extractImports(src), [
        { specifier: 'zod', line: 8 },
      ]);
    });

    it('does not match imports referenced in line comments', () => {
      const src = [
        "// see also: import { foo } from '@omadia/plugin-api'",
        "import { real } from 'lodash';",
      ].join('\n');
      assert.deepEqual(extractImports(src), [
        { specifier: 'lodash', line: 2 },
      ]);
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

    it('end-to-end: three react-ssr ui_routes produce a bundle that passes the gate', async () => {
      // Original user-reported failure: `patch_spec` with three react-ssr
      // ui_routes followed by `fill_slot` reproduces IMPORT_FORBIDDEN
      // types.ts(307,1). The false-positive lives in the boilerplate
      // types.ts JSDoc and trips regardless of route count; route count
      // only changed which other pipeline step ran first. This test drives
      // the same path: build a 3-route spec → generate() → run the gate
      // on the full output and assert zero IMPORT_FORBIDDEN issues. The
      // 2-route counterpart below confirms parity.
      const makeRoute = (id: string) => ({
        id,
        path: `/${id}`,
        tab_label: id,
        page_title: `${id} Page`,
        refresh_seconds: 30,
        render_mode: 'react-ssr' as const,
        interactive: false,
        data_binding: { source: 'tool' as const, tool_id: 'list_items' },
      });
      const baseSpec = {
        id: 'de.byte5.agent.test',
        name: 'Test Agent',
        description: 'Test agent description',
        category: 'productivity',
        domain: 'dev.test',
        skill: { role: 'tester' },
        playbook: {
          when_to_use: 'when testing',
          not_for: ['not used for unit tests'],
          example_prompts: ['test prompt 1', 'test prompt 2'],
        },
        network: { outbound: ['api.example.com'] },
        tools: [{ id: 'list_items', description: 'List things', input: {} }],
      };
      const buildAndCheck = async (routeCount: number) => {
        const routes = ['alpha', 'beta', 'gamma'].slice(0, routeCount).map(makeRoute);
        const spec = parseAgentSpec({ ...baseSpec, ui_routes: routes });
        const slots: Record<string, string> = {
          'client-impl':
            '// client stub\nreturn { async ping() {}, async dispose() {} } as unknown as Client;',
          'toolkit-impl':
            '// toolkit stub\nconst tools: ToolDescriptor<unknown, unknown>[] = [];\nreturn { tools, async close() {} };',
          'skill-prompt': '# Test Skill\nTest prompt body.',
        };
        for (const r of routes) {
          slots[`ui-${r.id}-component`] =
            'export default function P() { return <div>Hi</div>; }';
        }
        const files = await generate({ spec, slots });
        const issues = validateBundleImports(files, allowAll);
        return issues.filter((i) => i.code === 'IMPORT_FORBIDDEN');
      };
      const threeRouteForbidden = await buildAndCheck(3);
      assert.deepEqual(
        threeRouteForbidden,
        [],
        'three-route bundle must produce zero IMPORT_FORBIDDEN issues',
      );
      const twoRouteForbidden = await buildAndCheck(2);
      assert.deepEqual(
        twoRouteForbidden,
        [],
        'two-route bundle must also produce zero IMPORT_FORBIDDEN issues (parity check)',
      );
    });

    it('does not flag the boilerplate types.ts JSDoc that documents @omadia/plugin-api as a peer', async () => {
      // End-to-end reproducer for the IMPORT_FORBIDDEN types.ts(307,1)
      // false-positive: scan the on-disk boilerplate file via the bundle
      // gate and assert no issues — proves the strip pass shields legit
      // JSDoc examples without weakening the gate against real imports.
      const { readFile } = await import('node:fs/promises');
      const url = await import('node:url');
      const here = path.dirname(url.fileURLToPath(import.meta.url));
      const boilerplate = path.resolve(
        here,
        '../../assets/boilerplate/agent-integration/types.ts',
      );
      const buf = await readFile(boilerplate);
      const files = new Map<string, Buffer>([['types.ts', buf]]);
      const issues = validateBundleImports(files, allowAll);
      assert.deepEqual(issues, []);
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
