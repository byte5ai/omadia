/**
 * Round-trip smoke: zip-upload a minimal `kind: tool` plugin through
 * PackageUploadService, activate via ToolPluginRuntime, verify the plugin's
 * handler landed in the native-tool registry.
 *
 * Exercises the same code paths the production /api/v1/install/packages
 * endpoint uses, minus auth + Express — so a successful run is evidence that
 * Phase 1 extractions (kind: tool / kind: extension) survive the full
 * upload→activate→dispatch loop.
 *
 * Usage: npx tsx scripts/smoke-package-roundtrip.ts
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JobScheduler } from '../src/plugins/jobScheduler.js';
import { PluginCatalog } from '../src/plugins/manifestLoader.js';
import { PackageUploadService } from '../src/plugins/packageUploadService.js';
import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';
import { UploadedPackageStore } from '../src/plugins/uploadedPackageStore.js';
import { ToolPluginRuntime } from '../src/plugins/toolPluginRuntime.js';
import { ServiceRegistry } from '../src/platform/serviceRegistry.js';
import { PluginRouteRegistry } from '../src/platform/pluginRouteRegistry.js';
import { NativeToolRegistry } from '../src/services/nativeToolRegistry.js';
import { InMemorySecretVault } from '../src/secrets/vault.js';

const PLUGIN_ID = 'de.byte5.smoke.hello-tool';
const PLUGIN_VERSION = '1.0.0';

async function main(): Promise<void> {
  const workRoot = mkdtempSync(join(tmpdir(), 'harness-roundtrip-'));
  const pkgRoot = join(workRoot, 'pkg');
  const packagesDir = join(workRoot, 'packages');
  const zipPath = join(workRoot, 'plugin.zip');

  mkdirSync(join(pkgRoot, 'dist'), { recursive: true });
  mkdirSync(packagesDir, { recursive: true });

  // ── 1. Build a minimal kind:tool plugin in a temp dir ────────────────────
  const manifestYaml = `schema_version: "1"
identity:
  id: "${PLUGIN_ID}"
  name: "Smoke Hello Tool"
  version: "${PLUGIN_VERSION}"
  kind: "tool"
  description: "Round-trip smoke plugin — registers a hello native tool."
  license: "Proprietary"
compat:
  core: ">=1.0 <2.0"
  node: ">=20"
lifecycle:
  entry: "dist/plugin.js"
permissions:
  memory:
    reads: []
    writes: []
  graph:
    reads: []
    writes: []
  network:
    outbound: []
  filesystem:
    scratch: false
`;
  writeFileSync(join(pkgRoot, 'manifest.yaml'), manifestYaml);
  writeFileSync(
    join(pkgRoot, 'package.json'),
    JSON.stringify({ name: PLUGIN_ID, version: PLUGIN_VERSION, type: 'module' }, null, 2),
  );
  writeFileSync(
    join(pkgRoot, 'dist/plugin.js'),
    `export async function activate(ctx) {
  ctx.tools.registerHandler('hello_smoke', async (input) => {
    return JSON.stringify({ ok: true, echo: input });
  });
  return { close: async () => {} };
}
`,
  );

  // ── 2. Zip it up ─────────────────────────────────────────────────────────
  execFileSync('zip', ['-qr', zipPath, '.'], { cwd: pkgRoot });
  const fileBuffer = readFileSync(zipPath);
  console.log(`[smoke] zip built: ${fileBuffer.byteLength} bytes`);

  // ── 3. Wire real PackageUploadService + runtime ──────────────────────────
  const catalog = new PluginCatalog({
    extraSources: () => [
      // UploadedPackageStore entries get folded in via catalog.load() — no
      // static sources here, so only the uploaded plugin will appear.
    ],
  });
  await catalog.load();

  const uploadedStore = new UploadedPackageStore(
    join(packagesDir, 'index.json'),
    packagesDir,
  );
  await uploadedStore.load();

  const registry = new InMemoryInstalledRegistry();
  const vault = new InMemorySecretVault();
  const serviceRegistry = new ServiceRegistry();
  const nativeToolRegistry = new NativeToolRegistry();
  const pluginRouteRegistry = new PluginRouteRegistry();

  // Reload the catalog whenever an uploaded package lands — Phase 1.3 activation
  // depends on catalog.get(id) returning the manifest.
  const catalogWithUploads = new PluginCatalog({
    extraSources: () => uploadedStore.list().map((p) => ({ packageRoot: p.path })),
  });
  await catalogWithUploads.load();

  const uploadService = new PackageUploadService({
    store: uploadedStore,
    catalog: catalogWithUploads,
    packagesDir,
    limits: {
      maxBytes: 10 * 1024 * 1024,
      maxExtractedBytes: 50 * 1024 * 1024,
      maxEntries: 200,
    },
    hostDependencies: {},
    registry,
    log: (m) => console.log(m),
  });

  // ── 4. Ingest ─────────────────────────────────────────────────────────────
  const ingestResult = await uploadService.ingest({
    fileBuffer,
    originalFilename: 'plugin.zip',
    uploadedBy: 'smoke-roundtrip',
  });
  if (!ingestResult.ok) {
    throw new Error(
      `[smoke] ingest FAILED: ${ingestResult.code} — ${ingestResult.message}`,
    );
  }
  console.log(
    `[smoke] ingest OK: id=${ingestResult.plugin_id} version=${ingestResult.version}`,
  );

  // The upload flow only ingests the zip — it doesn't mark the plugin
  // installed. Mimic what the install router does after an upload:
  await registry.register({
    id: PLUGIN_ID,
    installed_version: PLUGIN_VERSION,
    installed_at: new Date().toISOString(),
    status: 'active',
    config: {},
  });

  // ── 5. Activate via ToolPluginRuntime ────────────────────────────────────
  const toolRuntime = new ToolPluginRuntime({
    catalog: catalogWithUploads,
    registry,
    vault,
    uploadedStore,
    serviceRegistry,
    nativeToolRegistry,
    pluginRouteRegistry,
    jobScheduler: new JobScheduler({ log: () => {} }),
    log: (m) => console.log(m),
  });
  await toolRuntime.activateAllInstalled();

  if (!toolRuntime.isActive(PLUGIN_ID)) {
    throw new Error(`[smoke] plugin not active after activateAllInstalled`);
  }
  console.log(`[smoke] runtime reports ${PLUGIN_ID} active`);

  // ── 6. Exercise the handler ──────────────────────────────────────────────
  const reg = nativeToolRegistry.get('hello_smoke');
  if (!reg || !reg.handler) {
    throw new Error(`[smoke] hello_smoke handler not found in NativeToolRegistry`);
  }
  const response = await reg.handler({ msg: 'ping' });
  console.log(`[smoke] handler response: ${String(response)}`);
  if (!String(response).includes('"ok":true')) {
    throw new Error(`[smoke] handler response did not include ok:true`);
  }

  // ── 7. Deactivate + cleanup ──────────────────────────────────────────────
  await toolRuntime.deactivate(PLUGIN_ID);
  rmSync(workRoot, { recursive: true, force: true });

  console.log('[smoke] round-trip PASSED');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
