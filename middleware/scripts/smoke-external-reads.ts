/**
 * Theme A live-smoke — Stufe 1.
 *
 * Synthesises a UniFi-Tracker-shaped spec, attaches external_reads for
 * `odoo.client` (the lessons-learned target — the LLM hallucinated
 * `odoo.execute_kw` from training memory) plus a `confluence.client`
 * read for cross-service deduplication coverage, runs the live codegen,
 * and prints the generated plugin.ts + package.json output. Greps for the
 * done-criteria signals from the hand-off:
 *
 *   ✓ service-lookup line lives inside the codegen-managed marker region
 *     (NOT inside any LLM-supplied fill_slot)
 *   ✓ peerDependencies in package.json carries the integration packages
 *   ✓ shared service is looked up exactly once across multiple reads
 *
 * Run:  npx tsx middleware/scripts/smoke-external-reads.ts
 */

import { parseAgentSpec } from '../src/plugins/builder/agentSpec.js';
import {
  generate,
  CodegenError,
} from '../src/plugins/builder/codegen.js';
import { _resetCacheForTests } from '../src/plugins/builder/boilerplateSource.js';

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

  // UniFi-Tracker-shaped spec, with external_reads added.
  const spec = parseAgentSpec({
    id: 'de.byte5.agent.unifi-device-tracker',
    name: 'UniFi Device Tracker',
    version: '0.7.0',
    description:
      'Tracker für UniFi Cloud Devices mit Odoo HR-Mitarbeiterzuordnung',
    category: 'other',
    depends_on: [
      'de.byte5.integration.odoo',
      'de.byte5.integration.confluence',
    ],
    setup_fields: [
      { key: 'unifi_api_key', type: 'secret', required: true },
      { key: 'unifi_console_id', type: 'string', required: true },
      { key: 'unifi_site_id', type: 'string', required: false },
      { key: 'poll_interval_seconds', type: 'string', required: false },
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
      example_prompts: [
        'Wer ist gerade im Office?',
        'Welche Geräte hat Marcel?',
      ],
    },
    network: { outbound: ['api.ui.com'] },
    admin_ui_path: '/api/unifi-device-tracker/admin/index.html',
    external_reads: [
      {
        id: 'list_odoo_employees',
        description: 'Mitarbeiterliste aus Odoo HR (Name + E-Mail)',
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
        result_mapping: { employees: 'data' },
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
        '  // unifi client placeholder\n' +
        '  return {\n' +
        '    async ping() {},\n' +
        "    async listSites() { return []; },\n" +
        '    async dispose() {},\n' +
        '  };',
      'toolkit-impl':
        '// unifi toolkit\n' +
        'export function createToolkit(opts: ToolkitOptions): Toolkit {\n' +
        '  const tools: ToolDescriptor<unknown, unknown>[] = [];\n' +
        '  return { tools, async close() { await opts.client.dispose(); } };\n' +
        '}',
      'skill-prompt':
        '# Rolle: UniFi Recherche-Assistent\n\nDu hilfst MAC↔Person-Zuordnungen.',
    },
  });

  console.log(`\n${YELLOW}=== Theme A live-smoke (Stufe 1) ===${RESET}`);
  console.log(`spec.id           = ${spec.id}`);
  console.log(`spec.depends_on   = ${JSON.stringify(spec.depends_on)}`);
  console.log(`external_reads    = ${spec.external_reads.length} entries`);
  for (const er of spec.external_reads) {
    console.log(`  • ${er.id}  →  ${er.service}.${er.method}`);
  }

  let files: Map<string, Buffer>;
  try {
    files = await generate({ spec });
  } catch (err) {
    if (err instanceof CodegenError) {
      console.log(`\n${RED}Codegen failed:${RESET}`);
      for (const issue of err.issues) {
        console.log(`  [${issue.code}] ${issue.detail}`);
      }
      process.exit(1);
    }
    throw err;
  }

  const pluginText = files.get('plugin.ts')?.toString('utf-8') ?? '';
  const packageText = files.get('package.json')?.toString('utf-8') ?? '';

  // --- Dump for visual inspection ---
  console.log(`\n${YELLOW}--- generated plugin.ts ---${RESET}`);
  console.log(pluginText);
  console.log(`${YELLOW}--- end plugin.ts ---${RESET}\n`);

  console.log(`${YELLOW}--- generated package.json ---${RESET}`);
  console.log(packageText);
  console.log(`${YELLOW}--- end package.json ---${RESET}\n`);

  // --- Done-criteria checks ---
  console.log(`${YELLOW}=== Verification ===${RESET}`);

  // 1. Type imports for both services
  if (
    /import type \{ OdooClient \} from '@byte5\/harness-integration-odoo';/.test(
      pluginText,
    )
  ) {
    ok('plugin.ts has `import type { OdooClient } from \'@omadia/integration-odoo\'`');
  } else {
    fail('missing OdooClient type import');
  }
  if (
    /import type \{ ConfluenceClient \} from '@byte5\/harness-integration-confluence';/.test(
      pluginText,
    )
  ) {
    ok('plugin.ts has `import type { ConfluenceClient } from \'@omadia/integration-confluence\'`');
  } else {
    fail('missing ConfluenceClient type import');
  }

  // 2. Service lookups inside the codegen marker region — NOT in any
  //    LLM-supplied fill_slot.
  const initRegionMatch = pluginText.match(
    /\/\/ #region builder:external-reads-init\n([\s\S]*?)\n\s*\/\/ #endregion/,
  );
  if (!initRegionMatch) {
    fail('external-reads-init region not found in plugin.ts');
  } else {
    const initBody = initRegionMatch[1] ?? '';
    if (
      /const __svc_odoo_client = ctx\.services\.get<OdooClient>\('odoo\.client'\);/.test(
        initBody,
      )
    ) {
      ok('odoo.client service lookup lives INSIDE external-reads-init region');
    } else {
      fail('odoo.client lookup not inside external-reads-init region');
    }
    if (
      /const __svc_confluence_client = ctx\.services\.get<ConfluenceClient>\('confluence\.client'\);/.test(
        initBody,
      )
    ) {
      ok('confluence.client service lookup lives INSIDE external-reads-init region');
    } else {
      fail('confluence.client lookup not inside external-reads-init region');
    }
  }

  // 3. Activate-body slot (LLM-supplied) does NOT contain ctx.services.get
  const activateBodyMatch = pluginText.match(
    /\/\/ #region builder:activate-body\n([\s\S]*?)\n\s*\/\/ #endregion/,
  );
  if (!activateBodyMatch) {
    fail('activate-body region not found in plugin.ts');
  } else if (activateBodyMatch[1]?.includes('ctx.services.get')) {
    fail('activate-body slot contains ctx.services.get — should only live in external-reads-init');
  } else {
    ok('activate-body slot is free of ctx.services.get (lookups are codegen-managed)');
  }

  // 4. Tool descriptors pushed to toolkit
  if (/__externalReadsTools\.push\(\{[\s\S]*id: "list_odoo_employees"/.test(pluginText)) {
    ok('list_odoo_employees pushed onto toolkit');
  } else {
    fail('list_odoo_employees push not found');
  }
  if (/__externalReadsTools\.push\(\{[\s\S]*id: "fetch_office_wifi_doc"/.test(pluginText)) {
    ok('fetch_office_wifi_doc pushed onto toolkit');
  } else {
    fail('fetch_office_wifi_doc push not found');
  }

  // 5. Result_mapping rendered for the entry that has it
  if (/__mapped\["employees"\] = __src\?\.\["data"\];/.test(pluginText)) {
    ok('result_mapping for list_odoo_employees rendered correctly');
  } else {
    fail('result_mapping body missing');
  }

  // 6. Each unique service looked up exactly once (no duplicate service-lookup
  //    blocks even though multiple reads use it).
  const odooLookups = (
    pluginText.match(/ctx\.services\.get<OdooClient>\('odoo\.client'\)/g) ?? []
  ).length;
  if (odooLookups === 1) {
    ok('odoo.client looked up exactly 1× (deduplicated)');
  } else {
    fail(`expected 1 odoo.client lookup, got ${String(odooLookups)}`);
  }

  // 7. peerDependencies updated correctly
  const pkgJson = JSON.parse(packageText) as {
    peerDependencies?: Record<string, string>;
  };
  const peers = pkgJson.peerDependencies ?? {};
  if (peers['zod']) {
    ok(`package.json keeps existing peerDep zod=${peers['zod']}`);
  } else {
    fail('package.json lost the zod peerDep');
  }
  if (peers['@omadia/integration-odoo'] === '*') {
    ok('package.json gained @omadia/integration-odoo peerDep');
  } else {
    fail('@omadia/integration-odoo peerDep missing from package.json');
  }
  if (peers['@omadia/integration-confluence'] === '*') {
    ok('package.json gained @omadia/integration-confluence peerDep');
  } else {
    fail('@omadia/integration-confluence peerDep missing from package.json');
  }

  // 8. The `return` statement lives OUTSIDE activate-body (boilerplate
  //    restructure precondition for external-reads-init reachability).
  const activateBodyText = activateBodyMatch?.[1] ?? '';
  if (/^\s*return\s*\{/m.test(activateBodyText)) {
    fail(
      'boilerplate regression: `return { ... }` is INSIDE activate-body — ' +
        'external-reads-init becomes unreachable',
    );
  } else {
    ok('return statement lives outside activate-body (external-reads-init reachable)');
  }

  if (process.exitCode === 1) {
    note('one or more checks failed — see above');
  } else {
    note('all checks passed');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
