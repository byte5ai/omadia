#!/usr/bin/env node
/**
 * fetch-model.mjs — download the keyless embedder's weights, once.
 *
 * WHY A SCRIPT AND NOT A RUNTIME DOWNLOAD
 * `@huggingface/transformers` will happily fetch a missing model on first use.
 * That would put a ~144 MB download inside the first user turn, on a machine
 * that may have no egress, with no integrity check and no way to say no. So
 * the adapter runs with `allowRemoteModels = false` and this script is the only
 * thing that reaches the network.
 *
 * WHY NOT VENDOR THE WEIGHTS
 * `desktop/scripts/stage-runtime.mjs` stages the middleware's FULL node_modules
 * into every installer, so a vendored model would land in the macOS arm64,
 * macOS x64, Windows and Linux builds alike — on top of an installer already
 * near 300 MB — for a provider that operators with a key or an Ollama box never
 * activate.
 *
 * Everything is pinned: repository, commit revision, and a SHA-256 per file.
 * A moved tag or a truncated download fails loudly instead of producing a
 * model that embeds into a slightly different vector space than the corpus
 * already holds — a corruption cosine similarity cannot detect.
 *
 * Usage:
 *   node scripts/fetch-model.mjs [targetDir]      # default: var/embedding-models
 *   OMADIA_EMBEDDING_MODEL_DIR=/data/models node scripts/fetch-model.mjs
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const REPO = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
/** Commit pin. Bump this and the hashes below together, never one alone. */
const REVISION = '2c4055b12046f11709e9df2c122e59ffbdc2f900';
const BASE = 'https://huggingface.co';

/** The four files transformers.js needs to run this model fully offline,
 *  with the size and digest observed at {@link REVISION}. */
const FILES = [
  {
    name: 'config.json',
    bytes: 673,
    sha256: '05b570bff786faa5c4604152aa16f19f77ed6dfc31e47dd0f3dd987078693ac7',
  },
  {
    name: 'tokenizer.json',
    bytes: 17082913,
    sha256: 'b60b6b43406a48bf3638526314f3d232d97058bc93472ff2de930d43686fa441',
  },
  {
    name: 'tokenizer_config.json',
    bytes: 496,
    sha256: '3f5961b9ac86288cccdb97f32fb848d6187c78e1603958c53f3ea1f296b7d8a2',
  },
  {
    name: 'onnx/model_quantized.onnx',
    bytes: 118308126,
    sha256: '66fc00f5f29afcaff34092e1bdd20008ca3918265a82fb9695a551e510cc4ebc',
  },
];

const DEFAULT_DIR = 'var/embedding-models';

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Already there, right size, right digest? Then leave it alone — re-running
 *  this script must be cheap, so a partially-fetched set resumes rather than
 *  starting over. */
function isIntact(file, absolute) {
  try {
    if (statSync(absolute).size !== file.bytes) return false;
    return sha256(readFileSync(absolute)) === file.sha256;
  } catch {
    return false;
  }
}

async function download(file, absolute) {
  const url = `${BASE}/${REPO}/resolve/${REVISION}/${file.name}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GET ${url} → HTTP ${String(res.status)}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  const digest = sha256(buffer);
  if (digest !== file.sha256) {
    throw new Error(
      `${file.name}: expected sha256 ${file.sha256}, got ${digest} — ` +
        'refusing to install weights that do not match the pin',
    );
  }
  if (buffer.byteLength !== file.bytes) {
    throw new Error(
      `${file.name}: expected ${String(file.bytes)} bytes, got ${String(buffer.byteLength)}`,
    );
  }
  // Write to a temporary name and rename: a process killed mid-write must not
  // leave a file that passes an existence check but fails a digest check
  // deep inside onnxruntime.
  const temporary = `${absolute}.partial`;
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(temporary, buffer);
  renameSync(temporary, absolute);
}

async function main() {
  const target =
    process.argv[2] ?? process.env['OMADIA_EMBEDDING_MODEL_DIR'] ?? DEFAULT_DIR;
  const root = path.resolve(target, ...REPO.split('/'));
  console.log(`[fetch-model] ${REPO} @ ${REVISION.slice(0, 8)} → ${root}`);

  let fetched = 0;
  for (const file of FILES) {
    const absolute = path.join(root, ...file.name.split('/'));
    if (isIntact(file, absolute)) {
      console.log(`  ✓ ${file.name} (already present, digest verified)`);
      continue;
    }
    const mb = (file.bytes / 1024 / 1024).toFixed(1);
    console.log(`  ↓ ${file.name} (${mb} MB)`);
    try {
      await download(file, absolute);
    } catch (err) {
      rmSync(`${absolute}.partial`, { force: true });
      throw err;
    }
    fetched += 1;
  }

  const total = FILES.reduce((sum, f) => sum + f.bytes, 0);
  console.log(
    `[fetch-model] done — ${String(fetched)} file(s) fetched, ` +
      `${(total / 1024 / 1024).toFixed(0)} MB on disk.`,
  );
  console.log(
    '[fetch-model] Remember: set process_dedup_threshold=0.45 in the knowledge-graph ' +
      "plugin. This model's cosine scale is not the 0.90 default, and at 0.90 dedup never fires.",
  );
}

main().catch((err) => {
  console.error(`[fetch-model] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
