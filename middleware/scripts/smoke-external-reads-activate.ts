/**
 * Theme A — Stufe 2.5: end-to-end activate smoke (preview-services regression test).
 *
 * The structural smokes (`smoke-external-reads.ts` and -tsc, -pipeline)
 * verify that codegen output is right and that tsc passes against the
 * real integration types. None of them invoke `previewRuntime.activate()`.
 * That gap let the preview-services-undefined regression slip through —
 * the boilerplate types deliver `services` to the plugin, but the
 * preview-runtime stub never did.
 *
 * This smoke closes the gap: it runs the FULL preview pipeline against
 * a Theme-A spec and asserts that the agent's own null-guard throws the
 * descriptive error message — NOT a `TypeError: Cannot read properties
 * of undefined`.
 *
 * Pipeline:
 *   1. codegen → file map
 *   2. ensureBuildTemplate (one-time install of integration packages)
 *   3. prepareStagingDir
 *   4. buildSandbox.build() → real zip (runs tsc + zip)
 *   5. previewRuntime.activate({ zipBuffer })  — extracts + dynamic-imports
 *   6. expect: rejected with `service 'odoo.client' is not registered …`
 *
 * Run:  npx tsx middleware/scripts/smoke-external-reads-activate.ts
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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
import { build as runBuildSandbox } from '../src/plugins/builder/buildSandbox.js';
import { PreviewRuntime } from '../src/plugins/builder/previewRuntime.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIDDLEWARE_ROOT = path.resolve(HERE, '..');
const TEMPLATE_ROOT = path.join(MIDDLEWARE_ROOT, 'data', 'builder', 'build-template');

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
  console.log(`${YELLOW}=== Theme A activate-smoke ===${RESET}`);

  // 1. Spec with external_reads — no toolkit slot using services, just
  //    the codegen-emitted lookup.
  const spec = parseAgentSpec({
    id: 'de.byte5.agent.activate-smoke',
    name: 'Activate Smoke',
    version: '0.1.0',
    description: 'fixture for activate-time external_reads smoke',
    category: 'other',
    depends_on: ['de.byte5.integration.odoo'],
    setup_fields: [
      { key: 'api_token', type: 'secret', required: true },
      { key: 'base_url', type: 'string', required: true },
    ],
    tools: [
      {
        id: 'do_thing',
        description: 'placeholder tool to keep tools[] non-empty',
        input: { type: 'object' },
      },
    ],
    skill: { role: 'fixture' },
    playbook: { when_to_use: 'fixture', not_for: ['fixture'], example_prompts: ['x', 'y'] },
    network: { outbound: ['api.example.com'] },
    external_reads: [
      {
        id: 'list_employees',
        description: 'list odoo employees',
        service: 'odoo.client',
        method: 'execute',
        args: [{ model: 'hr.employee', method: 'search_read', positionalArgs: [], kwargs: {} }],
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
      'skill-prompt': '# Rolle: smoke fixture',
    },
  });

  note('codegen → file map');
  const files = await generate({ spec });

  note('ensureBuildTemplate');
  const cfg = await loadBuildTemplateConfig();
  const tplResult = await ensureBuildTemplate({
    templateRoot: TEMPLATE_ROOT,
    npmDeps: cfg.npmDeps,
    workspaceDeps: cfg.workspaceDeps,
  });
  if (!tplResult.ready) {
    fail(`build-template not ready: ${tplResult.reason ?? 'unknown'}`);
    return;
  }

  note('prepareStagingDir');
  const stagingDir = await prepareStagingDir({
    templateRoot: TEMPLATE_ROOT,
    draftId: 'activate-smoke',
    buildN: Date.now(),
    files,
  });

  let zipBuffer: Buffer | undefined;
  try {
    note('buildSandbox.build (tsc + zip, may take ~5s)');
    const buildRes = await runBuildSandbox({
      stagingDir,
      timeoutMs: 60_000,
    });
    if (!buildRes.ok) {
      fail(
        `buildSandbox failed: reason=${buildRes.reason}, errors=${String(buildRes.errors.length)}`,
      );
      console.log(buildRes.stderrTail || '(no stderr)');
      console.log(buildRes.stdoutTail || '(no stdout)');
      return;
    }
    zipBuffer = buildRes.zip;
    ok(`build sandbox produced a ${String(zipBuffer.byteLength)}-byte zip`);
  } finally {
    await cleanupStagingDir(stagingDir);
  }

  // 5. previewRuntime.activate() — uses real extract + real dynamic import.
  //    Production previewsRoot lives inside MIDDLEWARE_ROOT so Node's module
  //    resolver finds `zod` etc. via tree-walk into middleware/node_modules.
  //    A previewsRoot under os.tmpdir() would crash on `Cannot find package
  //    'zod'` because the import scope can't reach the middleware install.
  void os; // keep import for future use
  const previewsRoot = await fs.mkdtemp(
    path.join(MIDDLEWARE_ROOT, 'data', 'builder', '.activate-smoke-'),
  );
  try {
    const runtime = new PreviewRuntime({
      previewsRoot,
      logger: () => {},
    });

    note('previewRuntime.activate (smokeMode=false, expect agent-side throw)');
    let thrown: Error | undefined;
    try {
      const handle = await runtime.activate({
        zipBuffer: zipBuffer!,
        draftId: 'activate-smoke',
        rev: 1,
        // Boilerplate's default activate-body reads these (different casing
        // than spec.setup_fields — case-quirk in the boilerplate). We
        // satisfy them so activate() reaches the external-reads-init region
        // where the regression actually fires.
        configValues: {
          base_url: 'https://example.invalid',
          request_timeout_ms: 1000,
        },
        secretValues: { API_TOKEN: 'fake' },
      });
      // If we got here, the activation didn't throw — that's a regression.
      await handle.close();
      fail(
        'activate() unexpectedly succeeded — preview should hit the codegen null-guard',
      );
      return;
    } catch (err) {
      thrown = err as Error;
    }

    const msg = thrown.message ?? '';
    if (msg.includes('Cannot read properties of undefined')) {
      fail(
        `regression: TypeError surfaced — services stub missing? msg=${JSON.stringify(msg)}`,
      );
      return;
    }
    if (
      msg.includes("service 'odoo.client' is not registered") ||
      msg.includes("'odoo.client' is not registered")
    ) {
      ok(`agent threw the descriptive error from the codegen null-guard`);
      ok(`  message: ${msg.slice(0, 140)}${msg.length > 140 ? '…' : ''}`);
    } else {
      fail(`unexpected error message: ${msg}`);
    }
  } finally {
    await fs.rm(previewsRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
