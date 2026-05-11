/**
 * Theme A live-smoke — Stufe 1.5b: full pipeline (no manual symlinks).
 *
 * Re-runs Stufe 1.5 but against the ACTUAL production build-template
 * pipeline:
 *   1. loadBuildTemplateConfig() — reads boilerplate package.json + merges
 *      integration packages from serviceTypeRegistry into workspaceDeps
 *   2. ensureBuildTemplate() — runs `npm install` once + symlinks all
 *      workspace packages into the shared node_modules. Re-uses cached
 *      install when the hash matches; auto-reinstalls on mismatch.
 *   3. prepareStagingDir() — writes generated agent files to a fresh
 *      staging dir, symlinks node_modules from the template
 *   4. typecheckStaging() — `tsc --noEmit` over the staging dir
 *
 * If this passes: the production gap is closed end-to-end. Builder UI →
 * Build → Install pipeline can handle external_reads agents without any
 * per-build setup.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseAgentSpec } from '../src/plugins/builder/agentSpec.js';
import { generate } from '../src/plugins/builder/codegen.js';
import { _resetCacheForTests } from '../src/plugins/builder/boilerplateSource.js';
import {
  ensureBuildTemplate,
  prepareStagingDir,
  cleanupStagingDir,
} from '../src/plugins/builder/buildTemplate.js';
import { loadBuildTemplateConfig } from '../src/plugins/builder/buildTemplateConfig.js';
import { typecheckStaging } from '../src/plugins/builder/typecheck.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIDDLEWARE_ROOT = path.resolve(HERE, '..');
const TEMPLATE_ROOT = path.join(
  MIDDLEWARE_ROOT,
  'data',
  'builder',
  'build-template',
);

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

const ok = (msg: string) => console.log(`${GREEN}✓${RESET} ${msg}`);
const fail = (msg: string) => {
  console.log(`${RED}✗${RESET} ${msg}`);
  process.exitCode = 1;
};
const note = (msg: string) => console.log(`${YELLOW}⋯${RESET} ${msg}`);

async function main(): Promise<void> {
  _resetCacheForTests();

  console.log(
    `${YELLOW}=== Theme A live-smoke (Stufe 1.5b: full pipeline) ===${RESET}`,
  );

  // 1. Load build-template config — must include integration packages
  //    from serviceTypeRegistry now (Theme A production-gap fix).
  note('loadBuildTemplateConfig (with serviceTypeRegistry deps)');
  const cfg = await loadBuildTemplateConfig();
  const integrationPkgs = Object.keys(cfg.workspaceDeps).filter((p) =>
    p.startsWith('@omadia/integration-'),
  );
  if (integrationPkgs.length === 0) {
    fail(
      'no harness-integration-* packages in workspaceDeps — production-gap fix did not land',
    );
    return;
  }
  ok(`workspaceDeps includes ${integrationPkgs.length} integration packages: ${integrationPkgs.join(', ')}`);

  // 2. Ensure the build-template node_modules is fresh. ensureBuildTemplate
  //    detects the hash change from the new workspaceDeps and re-installs.
  note('ensureBuildTemplate (may run npm install for ~30s on first call)');
  const tStart = Date.now();
  const result = await ensureBuildTemplate({
    templateRoot: TEMPLATE_ROOT,
    npmDeps: cfg.npmDeps,
    workspaceDeps: cfg.workspaceDeps,
  });
  const tElapsed = Date.now() - tStart;
  if (!result.ready) {
    fail(`ensureBuildTemplate not ready: ${result.reason ?? 'unknown'}`);
    return;
  }
  ok(
    `build-template ready (${result.reused ? 'reused' : 'rebuilt'}, ${String(tElapsed)}ms)`,
  );

  // Verify @omadia/integration-* are actually in node_modules.
  const nm = path.join(TEMPLATE_ROOT, 'node_modules', '@byte5');
  const scoped = await fs.readdir(nm).catch(() => [] as string[]);
  for (const expected of [
    'harness-integration-odoo',
    'harness-integration-confluence',
    'harness-integration-microsoft365',
  ]) {
    if (scoped.includes(expected)) {
      ok(`node_modules/@byte5/${expected} symlinked`);
    } else {
      fail(`node_modules/@byte5/${expected} missing — boot install incomplete`);
    }
  }

  // 3. Generate the same UniFi-shaped spec.
  const spec = parseAgentSpec({
    id: 'de.byte5.agent.unifi-device-tracker-smoke',
    name: 'UniFi Smoke',
    version: '0.7.0',
    description: 'Smoke fixture',
    category: 'other',
    depends_on: [
      'de.byte5.integration.odoo',
      'de.byte5.integration.confluence',
    ],
    setup_fields: [
      { key: 'unifi_api_key', type: 'secret', required: true },
      { key: 'unifi_console_id', type: 'string', required: true },
    ],
    tools: [
      {
        id: 'list_unifi_sites',
        description: 'Liste UniFi-Sites der Console',
        input: { type: 'object' },
      },
    ],
    skill: { role: 'ein präziser UniFi-Recherche-Assistent' },
    playbook: {
      when_to_use: 'User fragt nach Geräten/MAC-Adressen aus dem Office-WLAN',
      not_for: ['historische Klima-Daten'],
      example_prompts: ['x', 'y'],
    },
    network: { outbound: ['api.ui.com'] },
    external_reads: [
      {
        id: 'list_odoo_employees',
        description: 'Mitarbeiterliste aus Odoo HR',
        service: 'odoo.client',
        method: 'execute',
        args: [
          {
            model: 'hr.employee',
            method: 'search_read',
            positionalArgs: [],
            kwargs: { fields: ['id', 'name', 'work_email'] },
          },
        ],
      },
      {
        id: 'fetch_office_wifi_doc',
        description: 'Confluence-Page mit Office-WiFi-MAC-Liste',
        service: 'confluence.client',
        method: 'getPage',
        args: ['98765'],
      },
    ],
    slots: {
      'client-impl':
        '  void opts;\n' +
        '  return {\n' +
        '    async ping() {},\n' +
        '    async search(_q: string) { return []; },\n' +
        '    async dispose() {},\n' +
        '  };',
      'toolkit-impl':
        'const tools: ToolDescriptor<unknown, unknown>[] = [];\n' +
        'void ({} as { client: Client; result: SearchResult });\n' +
        'export function createToolkit(opts: ToolkitOptions): Toolkit {\n' +
        '  return { tools, async close() { await opts.client.dispose(); } };\n' +
        '}',
      'skill-prompt':
        '# Rolle: UniFi Recherche-Assistent\n\nDu hilfst MAC↔Person-Zuordnungen.',
    },
  });

  note('codegen → file map');
  const files = await generate({ spec });

  note('prepareStagingDir + typecheckStaging');
  const stagingDir = await prepareStagingDir({
    templateRoot: TEMPLATE_ROOT,
    draftId: 'theme-a-smoke',
    buildN: Date.now(),
    files,
  });
  try {
    const tcResult = await typecheckStaging({ stagingDir });
    if (tcResult.ok) {
      ok(`tsc clean over real pipeline (${String(tcResult.durationMs)}ms)`);
    } else {
      fail(`tsc failed: reason=${tcResult.reason}, errors=${String(tcResult.errors.length)}`);
      console.log(`${YELLOW}--- tsc tail ---${RESET}`);
      console.log(tcResult.stdoutTail || '(empty stdout)');
      console.log(tcResult.stderrTail || '(empty stderr)');
      console.log(`${YELLOW}--- end tail ---${RESET}`);
    }
  } finally {
    await cleanupStagingDir(stagingDir);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
