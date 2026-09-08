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
 *   node scripts/fetch-model.mjs [targetDir]      # default: var/embedding-models
 *   OMADIA_EMBEDDING_MODEL_DIR=/data/models node scripts/fetch-model.mjs
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

const DEFAULT_DIR = 'var/embedding-models';
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);

const target =
  process.argv[2] ?? process.env['OMADIA_EMBEDDING_MODEL_DIR'] ?? DEFAULT_DIR;

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
