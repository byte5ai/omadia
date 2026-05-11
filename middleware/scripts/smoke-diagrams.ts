#!/usr/bin/env tsx
/**
 * Local end-to-end smoke test for the diagram-rendering feature.
 *
 * Pre-reqs (all local):
 *   - `docker compose up -d` at repo root  (Kroki + MinIO + bucket init)
 *   - middleware running with `npm run dev` and diagram env vars set
 *
 * Exercises:
 *   1. Render a Mermaid + Graphviz + PlantUML diagram via DiagramService
 *      (hitting real Kroki and uploading to real MinIO).
 *   2. Fetch the returned signed URLs through the live middleware proxy.
 *   3. Assert: status 200, content-type image/png, PNG magic bytes,
 *      cacheHit flips to true on repeat render.
 *
 * Exits 0 on success, 1 on any failure.
 */
import { fetch as undiciFetch } from 'undici';
import { config } from '../src/config.js';
import {
  DiagramService,
  createKrokiClient,
  createTigrisStore,
  type DiagramKind,
} from '@omadia/diagrams';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Unique per-run marker so the cache-key is fresh every invocation. Without
// this the MinIO volume accumulates earlier renders, and the "first render"
// check fires a cache-hit instead of a real Kroki round-trip.
const RUN_TAG = `smoke-${String(Date.now())}`;

const SAMPLES: Record<DiagramKind, string> = {
  mermaid: `%% ${RUN_TAG}\ngraph TD\n  A[Bestellung] --> B[Rechnung]\n  B --> C[Zahlung]\n`,
  graphviz: `/* ${RUN_TAG} */\ndigraph G { A -> B -> C; A -> C }`,
  plantuml: `@startuml\n' ${RUN_TAG}\nAlice -> Bob: Login\nBob --> Alice: OK\n@enduml`,
  vegalite: JSON.stringify({
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    description: `Smoke-test bar chart · ${RUN_TAG}`,
    data: {
      values: [
        { category: 'A', amount: 28 },
        { category: 'B', amount: 55 },
        { category: 'C', amount: 43 },
        { category: 'D', amount: 91 },
        { category: 'E', amount: 81 },
      ],
    },
    mark: 'bar',
    encoding: {
      x: { field: 'category', type: 'nominal' },
      y: { field: 'amount', type: 'quantitative' },
    },
  }),
};

function requireEnv(name: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} must be set for this smoke test`);
  }
  return value;
}

async function main(): Promise<void> {
  const baseUrl = requireEnv('KROKI_BASE_URL', config.KROKI_BASE_URL);
  const endpoint = requireEnv('AWS_ENDPOINT_URL_S3', config.AWS_ENDPOINT_URL_S3);
  const bucket = requireEnv('BUCKET_NAME', config.BUCKET_NAME);
  const accessKey = requireEnv('AWS_ACCESS_KEY_ID', config.AWS_ACCESS_KEY_ID);
  const secretKey = requireEnv('AWS_SECRET_ACCESS_KEY', config.AWS_SECRET_ACCESS_KEY);
  const secret = requireEnv('DIAGRAM_URL_SECRET', config.DIAGRAM_URL_SECRET);
  const publicBase = requireEnv(
    'DIAGRAM_PUBLIC_BASE_URL',
    config.DIAGRAM_PUBLIC_BASE_URL,
  );

  const kroki = createKrokiClient({ baseUrl });
  const store = createTigrisStore({
    endpoint,
    accessKeyId: accessKey,
    secretAccessKey: secretKey,
    bucket,
  });
  const service = new DiagramService({
    kroki,
    store,
    tenantId: config.GRAPH_TENANT_ID,
    secret,
    publicBaseUrl: publicBase,
    signedUrlTtlSec: 60,
    maxSourceBytes: config.DIAGRAM_MAX_SOURCE_BYTES,
    maxPngBytes: config.DIAGRAM_MAX_PNG_BYTES,
    log: (msg) => console.log(msg),
  });

  let failures = 0;
  for (const kind of Object.keys(SAMPLES) as DiagramKind[]) {
    try {
      console.log(`\n--- ${kind} ---`);
      const first = await service.render({ kind, source: SAMPLES[kind] });
      assertEqual(first.cacheHit, false, `first render cacheHit should be false for ${kind}`);
      const second = await service.render({ kind, source: SAMPLES[kind] });
      assertEqual(
        second.cacheHit,
        true,
        `second render cacheHit should be true for ${kind}`,
      );

      // Fetch through the middleware proxy. This verifies: route mounted,
      // signature valid, streaming works, content-type image/png.
      const res = await undiciFetch(first.url, { redirect: 'error' });
      assertEqual(res.status, 200, `proxy GET ${kind} should return 200`);
      assertEqual(
        res.headers.get('content-type'),
        'image/png',
        `proxy GET ${kind} content-type should be image/png`,
      );
      const body = Buffer.from(await res.arrayBuffer());
      const magic = body.subarray(0, PNG_MAGIC.length);
      if (!magic.equals(PNG_MAGIC)) {
        throw new Error(`${kind} proxy response did not start with PNG magic bytes`);
      }
      console.log(
        `${kind}: OK — ${String(body.byteLength)} bytes, cacheHit round-trip confirmed`,
      );
    } catch (err) {
      failures++;
      console.error(`${kind} FAILED:`, err instanceof Error ? err.message : err);
    }
  }

  if (failures > 0) {
    console.error(`\n${String(failures)}/${String(Object.keys(SAMPLES).length)} kinds failed`);
    process.exit(1);
  }
  console.log('\n✓ all diagram kinds rendered, cached, and proxied correctly');
}

function assertEqual<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg} — expected ${String(expected)}, got ${String(actual)}`);
  }
}

main().catch((err) => {
  console.error('smoke-diagrams failed:', err);
  process.exit(1);
});
