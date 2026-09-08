import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { LOCAL_EMBEDDING_MODEL, modelPath } from './localEmbeddingClient.js';

/**
 * Downloading the keyless embedder's weights, once — programmatically.
 *
 * WHY THIS IS A MODULE AND NOT JUST THE CLI IT USED TO BE
 * The CLI (`scripts/fetch-model.mjs`) covers a developer. It does not cover the
 * person this whole adapter exists for: a subscription user on the desktop app,
 * who has no terminal in the flow and for whom "run npm run fetch-model" is
 * indistinguishable from "you cannot have this". So the admin UI drives the same
 * download, and both entry points share this one implementation rather than two
 * copies of a pinned digest list.
 *
 * `@huggingface/transformers` would happily fetch a missing model on first use.
 * That would put a ~135 MB download inside the first user turn, on a machine
 * that may have no egress, with no integrity check and no way to say no — so
 * the adapter runs with `allowRemoteModels = false` and this is the only code
 * that reaches the network.
 *
 * Everything is pinned: repository, commit revision, and a SHA-256 per file. A
 * moved tag or a truncated download fails loudly instead of producing a model
 * that embeds into a slightly different space than the corpus already holds —
 * a corruption cosine similarity cannot detect and no later check repairs.
 */

/** Commit pin. Bump this and the digests below together, never one alone. */
export const MODEL_REVISION = '2c4055b12046f11709e9df2c122e59ffbdc2f900';

const HUGGINGFACE_BASE = 'https://huggingface.co';

export interface PinnedModelFile {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
}

/** The four files transformers.js needs to run this model fully offline, with
 *  the size and digest observed at {@link MODEL_REVISION}. */
export const PINNED_MODEL_FILES: readonly PinnedModelFile[] = [
  {
    name: 'config.json',
    bytes: 673,
    sha256: '05b570bff786faa5c4604152aa16f19f77ed6dfc31e47dd0f3dd987078693ac7',
  },
  {
    name: 'tokenizer.json',
    bytes: 17_082_913,
    sha256: 'b60b6b43406a48bf3638526314f3d232d97058bc93472ff2de930d43686fa441',
  },
  {
    name: 'tokenizer_config.json',
    bytes: 496,
    sha256: '3f5961b9ac86288cccdb97f32fb848d6187c78e1603958c53f3ea1f296b7d8a2',
  },
  {
    name: 'onnx/model_quantized.onnx',
    bytes: 118_308_126,
    sha256: '66fc00f5f29afcaff34092e1bdd20008ca3918265a82fb9695a551e510cc4ebc',
  },
];

/** Total download size — what a UI has to be honest about before starting. */
export const PINNED_MODEL_TOTAL_BYTES = PINNED_MODEL_FILES.reduce(
  (sum, file) => sum + file.bytes,
  0,
);

export interface FetchProgress {
  /** Bytes of fully verified, installed files. Never a partial file: a
   *  half-downloaded file is not progress the operator can rely on. */
  readonly downloadedBytes: number;
  readonly totalBytes: number;
  /** File currently being fetched, or `undefined` once everything is in. */
  readonly currentFile?: string;
}

export interface FetchModelOptions {
  readonly targetDir: string;
  readonly onProgress?: (progress: FetchProgress) => void;
  /** Injectable for tests — no test may reach huggingface.co. */
  readonly fetchImpl?: typeof fetch;
  /**
   * The file set to verify and fetch. Defaults to {@link PINNED_MODEL_FILES},
   * which is what production always uses.
   *
   * It is a parameter so the skip / download / refuse logic can be tested
   * against digests a test can actually produce. The alternative was a test
   * that writes files of the right LENGTH and pretends their digest matches —
   * which cannot be true, and would have quietly turned the resume case into a
   * download case. Better an honest seam than a test that lies about what it
   * exercised.
   */
  readonly files?: readonly PinnedModelFile[];
}

export interface FetchModelResult {
  readonly modelDir: string;
  /** Files actually downloaded; 0 means everything was already verified. */
  readonly fetched: number;
  readonly totalBytes: number;
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Already there, right size, right digest?
 *
 * Re-running must be cheap, so a partially-fetched set resumes instead of
 * starting over — and the digest is re-checked rather than trusted, because
 * the failure this guards against (a file that exists but is wrong) is exactly
 * the one a size check alone lets through.
 */
export function isFileIntact(file: PinnedModelFile, absolute: string): boolean {
  try {
    if (statSync(absolute).size !== file.bytes) return false;
    return sha256(readFileSync(absolute)) === file.sha256;
  } catch {
    return false;
  }
}

export function modelFileUrl(file: PinnedModelFile): string {
  return `${HUGGINGFACE_BASE}/${LOCAL_EMBEDDING_MODEL}/resolve/${MODEL_REVISION}/${file.name}`;
}

async function downloadOne(
  file: PinnedModelFile,
  absolute: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const url = modelFileUrl(file);
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`GET ${url} → HTTP ${String(response.status)}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
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
  // Write to a temporary name and rename. A process killed mid-write must not
  // leave a file that passes an existence check and then fails a digest check
  // deep inside onnxruntime.
  const temporary = `${absolute}.partial`;
  mkdirSync(path.dirname(absolute), { recursive: true });
  try {
    writeFileSync(temporary, buffer);
    renameSync(temporary, absolute);
  } catch (err) {
    rmSync(temporary, { force: true });
    throw err;
  }
}

/** Fetch every pinned file that is not already present and verified. */
export async function fetchLocalEmbeddingModel(
  options: FetchModelOptions,
): Promise<FetchModelResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const files = options.files ?? PINNED_MODEL_FILES;
  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  const root = modelPath(options.targetDir);
  let downloadedBytes = 0;
  let fetched = 0;

  for (const file of files) {
    const absolute = path.join(root, ...file.name.split('/'));
    if (isFileIntact(file, absolute)) {
      downloadedBytes += file.bytes;
      options.onProgress?.({
        downloadedBytes,
        totalBytes,
      });
      continue;
    }
    options.onProgress?.({
      downloadedBytes,
      totalBytes,
      currentFile: file.name,
    });
    await downloadOne(file, absolute, fetchImpl);
    downloadedBytes += file.bytes;
    fetched += 1;
    options.onProgress?.({
      downloadedBytes,
      totalBytes,
    });
  }

  return { modelDir: root, fetched, totalBytes };
}
