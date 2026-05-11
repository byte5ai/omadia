/**
 * Theme A live-smoke — Stufe 1.5: tsc against real integration types.
 *
 * Stufe 1 verified the codegen output is structurally correct. Stufe 1.5
 * runs `tsc --noEmit` over the generated files against the actual
 * `@omadia/integration-odoo` + `@omadia/integration-confluence`
 * type surfaces — proves the codegen-emitted method calls compile (or
 * surfaces real method signature mismatches the LLM hallucinations would
 * otherwise leak past).
 *
 * Note (production gap): the harness build-template currently only
 * symlinks the boilerplate's peerDependencies (zod) into node_modules.
 * Integration packages added dynamically by codegen for external_reads
 * are NOT pre-resolved in the shared node_modules. This script wires
 * them manually for the smoke; production needs a follow-up that scans
 * spec.external_reads at staging time and symlinks accordingly.
 */

import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { parseAgentSpec } from '../src/plugins/builder/agentSpec.js';
import { generate } from '../src/plugins/builder/codegen.js';
import { _resetCacheForTests } from '../src/plugins/builder/boilerplateSource.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIDDLEWARE_ROOT = path.resolve(HERE, '..');
const PACKAGES_ROOT = path.join(MIDDLEWARE_ROOT, 'packages');
const BUILD_TEMPLATE_NM = path.join(
  MIDDLEWARE_ROOT,
  'data',
  'builder',
  'build-template',
  'node_modules',
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

async function symlinkExtraPackages(
  stagingNodeModules: string,
  pkgs: ReadonlyArray<{ name: string; from: string }>,
): Promise<void> {
  // node_modules is a symlinked dir → we cannot add new entries directly.
  // Replace it with a real dir mirroring the template's contents + extras.
  await fs.rm(stagingNodeModules, { recursive: true, force: true });
  await fs.mkdir(stagingNodeModules, { recursive: true });
  // Copy/symlink existing entries from build-template/node_modules.
  for (const entry of await fs.readdir(BUILD_TEMPLATE_NM)) {
    const src = path.join(BUILD_TEMPLATE_NM, entry);
    const dst = path.join(stagingNodeModules, entry);
    await fs.symlink(src, dst, 'dir');
  }
  // Add @byte5/<pkg> symlinks (scoped → mkdir @byte5 first).
  const scopedDir = path.join(stagingNodeModules, '@byte5');
  await fs.mkdir(scopedDir, { recursive: true });
  for (const { name, from } of pkgs) {
    const folder = name.replace(/^@byte5\//, '');
    const dst = path.join(scopedDir, folder);
    await fs.symlink(from, dst, 'dir');
  }
}

async function runTsc(
  stagingDir: string,
): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    const tscBin = path.join(BUILD_TEMPLATE_NM, 'typescript', 'bin', 'tsc');
    const child = spawn(
      'node',
      [tscBin, '--noEmit', '--pretty', 'false'],
      { cwd: stagingDir, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const chunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.stderr.on('data', (c: Buffer) => chunks.push(c));
    child.on('close', (code) => {
      resolve({
        exitCode: code ?? 1,
        output: Buffer.concat(chunks).toString('utf-8'),
      });
    });
  });
}

async function main(): Promise<void> {
  _resetCacheForTests();

  // Same UniFi-shaped spec as Stufe 1.
  const spec = parseAgentSpec({
    id: 'de.byte5.agent.unifi-device-tracker',
    name: 'UniFi Device Tracker',
    version: '0.7.0',
    description: 'Tracker für UniFi Cloud Devices',
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
      example_prompts: ['Wer ist gerade im Office?', 'Welche Geräte hat Marcel?'],
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
      // Body of `createClient` — must return a `Client` (ping, search,
      // dispose) per boilerplate/agent-integration/client.ts. We use a
      // minimal stub since this smoke is about external_reads, not the
      // owning UniFi client.
      'client-impl':
        "  void opts;\n" +
        '  return {\n' +
        '    async ping() {},\n' +
        '    async search(_q: string) { return []; },\n' +
        '    async dispose() {},\n' +
        '  };',
      // Body of `createToolkit` — must reference `Client`/`SearchResult`
      // imports to keep tsc's noUnusedLocals happy on the boilerplate's
      // existing imports. Empty tools array is fine.
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

  console.log(`${YELLOW}=== Theme A live-smoke (Stufe 1.5: tsc gate) ===${RESET}`);
  note('codegen → file map');
  const files = await generate({ spec });

  const stagingDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'theme-a-tsc-smoke-'),
  );
  try {
    note(`staging: ${stagingDir}`);
    for (const [rel, content] of files) {
      const abs = path.join(stagingDir, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content);
    }
    note('symlinking node_modules + @omadia/integration-{odoo,confluence}');
    await symlinkExtraPackages(path.join(stagingDir, 'node_modules'), [
      {
        name: '@omadia/integration-odoo',
        from: path.join(PACKAGES_ROOT, 'harness-integration-odoo'),
      },
      {
        name: '@omadia/integration-confluence',
        from: path.join(PACKAGES_ROOT, 'harness-integration-confluence'),
      },
    ]);

    note('running `tsc --noEmit`');
    const { exitCode, output } = await runTsc(stagingDir);

    console.log(`\n${YELLOW}--- tsc output ---${RESET}`);
    console.log(output || '(empty)');
    console.log(`${YELLOW}--- end tsc output (exit ${String(exitCode)}) ---${RESET}\n`);

    if (exitCode === 0) {
      ok('tsc clean — generated plugin.ts compiles against real integration types');
    } else {
      fail(`tsc returned exit ${String(exitCode)} — see errors above`);
    }
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
