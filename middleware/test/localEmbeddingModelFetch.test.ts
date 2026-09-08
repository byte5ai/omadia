import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  PINNED_MODEL_FILES,
  PINNED_MODEL_TOTAL_BYTES,
  fetchLocalEmbeddingModel,
  isFileIntact,
  modelFileUrl,
} from '../packages/embedding-adapter-local/src/fetchModel.js';
import { createLocalEmbeddingModelFetcher } from '../packages/embedding-adapter-local/src/modelFetcherService.js';
import { modelPath } from '../packages/embedding-adapter-local/src/localEmbeddingClient.js';

/**
 * The weight download (OM-84 follow-up), with no network anywhere.
 *
 * `fetchImpl` is injected in every case. A test that actually reached
 * huggingface.co would move 135 MB per run and would pass or fail on someone
 * else's uptime — and the thing worth pinning here is not that HTTP works, it
 * is that a WRONG payload is refused. Digests are what stand between a corpus
 * and a silently mixed vector space, so each rejection has its own case.
 */

const temporaries: string[] = [];
after(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'omadia-fetchmodel-'));
  temporaries.push(root);
  return root;
}

/** The real pinned bytes are unknowable here, so the fake server answers with
 *  the digest each file declares — proving the CHECK, not the content. */
function serverWithCorrectDigests(bodies: Map<string, Buffer>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const body = bodies.get(url);
    if (!body) return new Response('not found', { status: 404 });
    return new Response(new Uint8Array(body), { status: 200 });
  }) as unknown as typeof fetch;
}

/** Bodies whose sha256 matches the pin — built by brute-forcing nothing: the
 *  test replaces the pinned list instead where content matters. */
describe('fetchLocalEmbeddingModel — the refusals', () => {
  it('refuses a payload whose digest does not match the pin', async () => {
    const root = scratch();
    const bodies = new Map<string, Buffer>();
    for (const file of PINNED_MODEL_FILES) {
      bodies.set(modelFileUrl(file), Buffer.from('wrong content'));
    }
    await assert.rejects(
      () => fetchLocalEmbeddingModel({ targetDir: root, fetchImpl: serverWithCorrectDigests(bodies) }),
      /expected sha256 .* got .* refusing to install weights that do not match the pin/s,
    );
    // And nothing may be left behind that a later existence check would accept.
    const first = PINNED_MODEL_FILES[0];
    assert.ok(first);
    const landed = path.join(modelPath(root), ...first.name.split('/'));
    assert.throws(() => statSync(landed), /ENOENT/);
    assert.throws(() => statSync(`${landed}.partial`), /ENOENT/);
  });

  it('surfaces an HTTP failure with the URL it asked for', async () => {
    const root = scratch();
    const empty = serverWithCorrectDigests(new Map());
    await assert.rejects(
      () => fetchLocalEmbeddingModel({ targetDir: root, fetchImpl: empty }),
      /HTTP 404/,
    );
  });

  it('pins the revision into every URL', () => {
    for (const file of PINNED_MODEL_FILES) {
      const url = modelFileUrl(file);
      assert.match(url, /^https:\/\/huggingface\.co\//);
      // A `resolve/main` URL would silently follow a moved branch — the whole
      // reason the digests exist is that the bytes must not change under us.
      assert.doesNotMatch(url, /\/resolve\/main\//);
      assert.match(url, /\/resolve\/[0-9a-f]{40}\//);
    }
  });

  it('states a total that matches the sum of the parts', () => {
    const summed = PINNED_MODEL_FILES.reduce((s, f) => s + f.bytes, 0);
    assert.equal(PINNED_MODEL_TOTAL_BYTES, summed);
    // The UI promises this number to the operator before a 135 MB download.
    assert.ok(summed > 100 * 1024 * 1024, 'expected a nine-figure byte total');
  });
});

describe('isFileIntact', () => {
  it('is false for a missing file, a short file and a wrong-digest file', () => {
    const root = scratch();
    const file = PINNED_MODEL_FILES[0];
    assert.ok(file);
    const absolute = path.join(root, 'config.json');

    assert.equal(isFileIntact(file, absolute), false, 'missing');

    writeFileSync(absolute, Buffer.alloc(file.bytes - 1, 0x61));
    assert.equal(isFileIntact(file, absolute), false, 'short');

    // Right SIZE, wrong CONTENT — the case a size check alone lets through,
    // and the one that would poison the corpus.
    writeFileSync(absolute, Buffer.alloc(file.bytes, 0x62));
    assert.equal(isFileIntact(file, absolute), false, 'right size, wrong bytes');
  });
});

describe('createLocalEmbeddingModelFetcher', () => {
  function fetcher(root: string, fetchImpl: typeof fetch) {
    const logs: string[] = [];
    return {
      logs,
      instance: createLocalEmbeddingModelFetcher({
        modelDir: root,
        log: (m) => logs.push(m),
        fetchImpl,
      }),
    };
  }

  const neverResolves = (() =>
    new Promise<Response>(() => {
      /* held open on purpose */
    })) as unknown as typeof fetch;

  it('reports the missing files before anything runs', () => {
    const { instance } = fetcher(scratch(), neverResolves);
    const status = instance.status();
    assert.equal(status.job.state, 'idle');
    assert.deepEqual(
      [...status.missingFiles],
      PINNED_MODEL_FILES.map((f) => f.name),
    );
    assert.equal(status.totalBytes, PINNED_MODEL_TOTAL_BYTES);
  });

  it('is single-flight — a second start while running is refused', () => {
    const { instance } = fetcher(scratch(), neverResolves);
    assert.equal(instance.start(), true);
    assert.equal(instance.status().job.state, 'running');
    // Two runs would write the same `.partial` paths and race the renames.
    assert.equal(instance.start(), false);
    assert.equal(instance.start(), false);
  });

  it('returns immediately — start() must not await the download', () => {
    // The caller is an HTTP handler and this moves 135 MB. If start() awaited,
    // the request would sit open behind whatever proxy is in front and time
    // out, which is indistinguishable from a broken download.
    const { instance } = fetcher(scratch(), neverResolves);
    const before = Date.now();
    instance.start();
    assert.ok(Date.now() - before < 500, 'start() blocked');
  });

  it('records a failure with its message and stays queryable', async () => {
    const failing = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    const { instance, logs } = fetcher(scratch(), failing);
    instance.start();
    await waitFor(() => instance.status().job.state === 'failed');
    const status = instance.status();
    assert.match(status.job.error ?? '', /HTTP 500/);
    assert.match(logs.join('\n'), /weight download failed/);
    // A failed run must be retryable, not a dead end.
    assert.equal(instance.start(), true);
  });

  it('a run that finds everything intact reaches done without a single request', async () => {
    // Driven by a test-owned file list so the digests are ones this test can
    // actually produce. The pinned list is exercised by the refusal cases
    // above; what matters here is the SKIP path, and a "resume" test whose
    // files could never satisfy the digest check would have silently been
    // testing the download path instead.
    const root = scratch();
    const files = writePinnedSet(root, ['config.json', 'onnx/model_quantized.onnx']);
    let calls = 0;
    const counting = (async () => {
      calls += 1;
      return new Response('should not be called', { status: 500 });
    }) as unknown as typeof fetch;

    const result = await fetchLocalEmbeddingModel({
      targetDir: root,
      files,
      fetchImpl: counting,
    });
    assert.equal(calls, 0, 'an intact file must not be re-downloaded');
    assert.equal(result.fetched, 0);
  });

  it('fetches only the files that are missing', async () => {
    const root = scratch();
    const present = writePinnedSet(root, ['config.json']);
    const missing = pinnedFor('tokenizer_config.json', Buffer.from('fresh bytes'));
    const served = new Map([[modelFileUrl(missing), Buffer.from('fresh bytes')]]);

    const progress: number[] = [];
    const result = await fetchLocalEmbeddingModel({
      targetDir: root,
      files: [...present, missing],
      fetchImpl: serverWithCorrectDigests(served),
      onProgress: (p) => progress.push(p.downloadedBytes),
    });

    assert.equal(result.fetched, 1, 'only the missing file');
    const landed = path.join(modelPath(root), 'tokenizer_config.json');
    assert.equal(readFileSync(landed, 'utf8'), 'fresh bytes');
    // Progress must be monotonic, or a UI reading it would jump backwards.
    assert.deepEqual([...progress].sort((a, b) => a - b), progress);
  });
});

/** A pinned descriptor for `content`, with the digest computed from it. */
function pinnedFor(name: string, content: Buffer) {
  return {
    name,
    bytes: content.byteLength,
    sha256: createHash('sha256').update(content).digest('hex'),
  };
}

/** Write `names` into the model dir and return their true descriptors. */
function writePinnedSet(root: string, names: readonly string[]) {
  return names.map((name) => {
    const content = Buffer.from(`content of ${name}`);
    const absolute = path.join(modelPath(root), ...name.split('/'));
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
    return pinnedFor(name, content);
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('condition not reached in time');
}
