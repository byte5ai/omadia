#!/usr/bin/env node
/**
 * fetch-model.mjs — download the keyless embedder's weights, once.
 *
 * A thin wrapper. The implementation lives in `src/fetchModel.ts` because the
 * admin UI drives the same download (see `modelFetcherService.ts`), and the
 * pinned revision plus the four SHA-256 digests must exist in exactly one
 * place — they are what stands between a corpus and a silently mixed vector
 * space.
 *
 * Usage:
 *   npm run build --workspace @omadia/embedding-adapter-local
 *   node scripts/fetch-model.mjs [targetDir]      # default: see modelDir.ts
 *   OMADIA_EMBEDDING_MODEL_DIR=/data/models node scripts/fetch-model.mjs
 *
 * Without an argument the target is `defaultModelDir()` — the SAME resolution
 * order the plugin uses (OM-97): `OMADIA_EMBEDDING_MODEL_DIR`, then
 * `PLATFORM_DATA_DIR/embedding-models`, then the legacy `var/embedding-models`.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const built = path.join(here, '..', 'dist', 'fetchModel.js');

if (!existsSync(built)) {
  console.error(
    `[fetch-model] ${built} is missing — run:\n` +
      '  npm run build --workspace @omadia/embedding-adapter-local',
  );
  process.exit(1);
}

const { PINNED_MODEL_TOTAL_BYTES, fetchLocalEmbeddingModel } = await import(built);
// OM-97 — imported rather than re-spelled. This script used to hard-code
// `OMADIA_EMBEDDING_MODEL_DIR ?? 'var/embedding-models'`, which silently
// skipped the `PLATFORM_DATA_DIR` branch: on a Docker or Fly deployment the
// download landed in `var/` while the plugin looked in the mounted data
// volume, and the adapter reported missing weights that had just been fetched.
// `index.ts` claims the three consumers agree on "one resolution order"; this
// is what makes that true instead of aspirational.
const { defaultModelDir } = await import(path.join(here, '..', 'dist', 'modelDir.js'));

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);

const target = process.argv[2] ?? defaultModelDir(process.env);

console.log(
  `[fetch-model] ${mb(PINNED_MODEL_TOTAL_BYTES)} MB → ${path.resolve(target)}`,
);

let lastFile;
try {
  const result = await fetchLocalEmbeddingModel({
    targetDir: target,
    onProgress: ({ downloadedBytes, totalBytes, currentFile }) => {
      if (currentFile && currentFile !== lastFile) {
        lastFile = currentFile;
        console.log(`  ↓ ${currentFile}`);
      }
      if (!currentFile) {
        const pct = ((downloadedBytes / totalBytes) * 100).toFixed(0);
        console.log(`    ${pct}% (${mb(downloadedBytes)} / ${mb(totalBytes)} MB)`);
      }
    },
  });
  console.log(
    `[fetch-model] done — ${String(result.fetched)} file(s) fetched into ${result.modelDir}.`,
  );
  console.log(
    '[fetch-model] Remember: set process_dedup_threshold=0.45 in the knowledge-graph ' +
      "plugin. This model's cosine scale is not the 0.90 default, and at 0.90 dedup never fires.",
  );
} catch (err) {
  console.error(`[fetch-model] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
