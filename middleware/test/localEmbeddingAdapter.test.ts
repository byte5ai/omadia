import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import type { EmbeddingProvider, PluginContext } from '../packages/plugin-api/src/index.js';
import {
  LOCAL_EMBEDDING_DIMENSIONS,
  LOCAL_EMBEDDING_MODEL,
  RECOMMENDED_DEDUP_THRESHOLD,
  REQUIRED_MODEL_FILES,
  createLocalEmbeddingClient,
  missingModelFiles,
  modelPath,
} from '../packages/embedding-adapter-local/src/localEmbeddingClient.js';
import { activate } from '../packages/embedding-adapter-local/src/plugin.js';

/**
 * OM-84 / byte5ai/omadia#1003, second half — the keyless embedding provider.
 *
 * Nothing here loads onnxruntime. The pipeline is injected, because what needs
 * proving is the ADAPTER's behaviour: when it publishes the capability, when it
 * refuses to, and which refusals are loud. The model itself was measured
 * separately (the numbers are in the client's header) and re-verified against a
 * pruned staging tree; a unit test cannot check a 118 MB quantized model and
 * pretending otherwise would be the kind of green-for-the-wrong-reason this
 * repo has already been bitten by several times.
 */

const temporaries: string[] = [];

after(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});

/** A model directory with every required file present (contents irrelevant —
 *  the loader is injected, so nothing parses them). */
function completeModelDir(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'omadia-localemb-'));
  temporaries.push(root);
  for (const file of REQUIRED_MODEL_FILES) {
    const absolute = path.join(modelPath(root), ...file.split('/'));
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, 'x');
  }
  return root;
}

function emptyModelDir(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'omadia-localemb-'));
  temporaries.push(root);
  return root;
}

interface Ctx {
  ctx: PluginContext;
  services: Map<string, unknown>;
  logs: string[];
}

function makeCtx(config: Record<string, unknown> = {}): Ctx {
  const services = new Map<string, unknown>();
  const logs: string[] = [];
  const ctx = {
    log: (msg: string) => logs.push(msg),
    config: { get: <T>(key: string): T | undefined => config[key] as T | undefined },
    services: {
      get: <T>(name: string): T | undefined => services.get(name) as T | undefined,
      provide: (name: string, impl: unknown) => {
        services.set(name, impl);
        return () => services.delete(name);
      },
    },
  } as unknown as PluginContext;
  return { ctx, services, logs };
}

/** A fake feature extractor emitting `dims` deterministic values. */
function fakeLoader(dims = LOCAL_EMBEDDING_DIMENSIONS) {
  const seen: string[] = [];
  let loads = 0;
  const loadPipeline = async () => {
    loads += 1;
    return async (text: string) => {
      seen.push(text);
      return { data: Array.from({ length: dims }, (_, i) => (i + 1) / dims) };
    };
  };
  return { loadPipeline, seen, loadCount: () => loads };
}

describe('missingModelFiles', () => {
  it('names every required file when the directory is empty', () => {
    assert.deepEqual(missingModelFiles(emptyModelDir()), [...REQUIRED_MODEL_FILES]);
  });

  it('is empty once all required files exist', () => {
    assert.deepEqual(missingModelFiles(completeModelDir()), []);
  });

  it('names the one file a half-finished download left out', () => {
    // The realistic failure: the directory exists and looks fetched. Reporting
    // "model not found" would send the operator hunting for a path problem
    // instead of re-running the fetch.
    const root = completeModelDir();
    rmSync(path.join(modelPath(root), 'onnx', 'model_quantized.onnx'));
    assert.deepEqual(missingModelFiles(root), ['onnx/model_quantized.onnx']);
  });
});

describe('activate — when the capability is published', () => {
  it('publishes nothing and names the fetch command when weights are missing', async () => {
    const root = emptyModelDir();
    const { ctx, services, logs } = makeCtx({ model_dir: root });

    const handle = await activate(ctx, { loadPipeline: fakeLoader().loadPipeline });

    assert.equal(services.has('embeddingClient'), false);
    const log = logs.join('\n');
    assert.match(log, /capability not published/);
    assert.match(log, /npm run fetch-model/);
    // The missing file has to be in there, not just "weights missing".
    assert.match(log, /onnx\/model_quantized\.onnx/);
    await handle.close();
  });

  it('publishes an embeddingClient once the weights are in place', async () => {
    const { ctx, services, logs } = makeCtx({ model_dir: completeModelDir() });

    const handle = await activate(ctx, { loadPipeline: fakeLoader().loadPipeline });

    const client = services.get('embeddingClient') as EmbeddingProvider | undefined;
    assert.ok(client, 'expected the capability to be published');
    assert.equal(client.dimensions, LOCAL_EMBEDDING_DIMENSIONS);
    assert.match(client.modelId, /^local:/);
    assert.equal(client.modelId, 'local:paraphrase-multilingual-MiniLM-L12-v2');
    assert.match(logs.join('\n'), /keyless, in-process/);
    await handle.close();
    assert.equal(services.has('embeddingClient'), false);
  });

  it('states the dedup threshold this model needs — the 0.90 default never fires', async () => {
    // The whole point of #1003 was a capability that was off while the product
    // claimed otherwise. Publishing a client whose cosine scale silently
    // disables dedup would be the same bug wearing a different hat, so the
    // number has to reach the operator at activation, not only in a manifest
    // nobody re-reads.
    const { ctx, logs } = makeCtx({ model_dir: completeModelDir() });
    const handle = await activate(ctx, { loadPipeline: fakeLoader().loadPipeline });
    const log = logs.join('\n');
    assert.match(log, /process_dedup_threshold=0\.45/);
    assert.match(log, /0\.90 default/);
    assert.equal(RECOMMENDED_DEDUP_THRESHOLD, 0.45);
    await handle.close();
  });

  it('stands down instead of throwing when another provider already won', async () => {
    // Both this adapter and @omadia/embeddings are extension-kind built-ins
    // with no secret field, i.e. both auto-installed. An operator who fetches
    // the weights while Ollama is still configured must not get a plugin whose
    // activate() throws — a throwing activate means the plugin does not come
    // up at all.
    const { ctx, services, logs } = makeCtx({ model_dir: completeModelDir() });
    const incumbent = { modelId: 'ollama:nomic-embed-text', dimensions: 768 };
    services.set('embeddingClient', incumbent);
    // Mirror the real registry: a second provide under the same name throws.
    const guarded = {
      ...ctx,
      services: {
        get: <T>(name: string): T | undefined => services.get(name) as T | undefined,
        provide: (name: string) => {
          if (services.has(name)) throw new Error(`service '${name}' is already provided`);
          return () => services.delete(name);
        },
      },
    } as unknown as PluginContext;

    const handle = await activate(guarded, { loadPipeline: fakeLoader().loadPipeline });

    assert.equal(services.get('embeddingClient'), incumbent, 'the incumbent must survive');
    const log = logs.join('\n');
    assert.match(log, /already active/);
    assert.match(log, /standing down/);
    await handle.close();
    assert.equal(services.get('embeddingClient'), incumbent, 'close must not evict the incumbent');
  });

  it('does not load the model during activate — boot must not pay for it', async () => {
    const loader = fakeLoader();
    const { ctx, services } = makeCtx({ model_dir: completeModelDir() });

    const handle = await activate(ctx, { loadPipeline: loader.loadPipeline });
    assert.equal(loader.loadCount(), 0, 'activate must not build the pipeline');

    const client = services.get('embeddingClient') as EmbeddingProvider;
    await client.embed('erste Anfrage');
    assert.equal(loader.loadCount(), 1);
    await client.embed('zweite Anfrage');
    assert.equal(loader.loadCount(), 1, 'the pipeline must be memoised');
    await handle.close();
  });
});

describe('createLocalEmbeddingClient — the refusals', () => {
  it('refuses empty and whitespace-only text', async () => {
    const client = createLocalEmbeddingClient({
      modelDir: completeModelDir(),
      maxInputChars: 100,
      loadPipeline: fakeLoader().loadPipeline,
    });
    await assert.rejects(() => client.embed(''), /refusing to embed empty text/);
    await assert.rejects(() => client.embed('   \n\t '), /refusing to embed empty text/);
  });

  it('refuses a model whose width is not the promised one', async () => {
    // A wrong-width model would write vectors of a second space into one
    // column. Cosine similarity cannot see that, and no later check repairs it.
    const client = createLocalEmbeddingClient({
      modelDir: completeModelDir(),
      maxInputChars: 100,
      loadPipeline: fakeLoader(768).loadPipeline,
    });
    await assert.rejects(
      () => client.embed('irgendein Text'),
      /emitted 768 dimensions, expected 384/,
    );
  });

  it('truncates before tokenization rather than rejecting long input', async () => {
    const loader = fakeLoader();
    const client = createLocalEmbeddingClient({
      modelDir: completeModelDir(),
      maxInputChars: 10,
      loadPipeline: loader.loadPipeline,
    });
    await client.embed('a'.repeat(50));
    assert.deepEqual(loader.seen, ['aaaaaaaaaa']);
  });

  it('retries after a failed load instead of caching the failure forever', async () => {
    // A half-written file replaced since, or a mount that came back: the first
    // caller must not condemn the process to no embeddings until restart.
    let attempts = 0;
    const client = createLocalEmbeddingClient({
      modelDir: completeModelDir(),
      maxInputChars: 100,
      loadPipeline: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('onnxruntime session failed');
        return async () => ({
          data: Array.from({ length: LOCAL_EMBEDDING_DIMENSIONS }, () => 0.5),
        });
      },
    });

    await assert.rejects(() => client.embed('erster Versuch'), /could not be loaded/);
    const vector = await client.embed('zweiter Versuch');
    assert.equal(vector.length, LOCAL_EMBEDDING_DIMENSIONS);
    assert.equal(attempts, 2);
  });

  it('reports the model path in the load failure, not just the error', async () => {
    const root = completeModelDir();
    const client = createLocalEmbeddingClient({
      modelDir: root,
      maxInputChars: 100,
      loadPipeline: async () => {
        throw new Error('protobuf parsing failed');
      },
    });
    await assert.rejects(() => client.embed('text'), (err: Error) => {
      assert.match(err.message, /protobuf parsing failed/);
      assert.ok(
        err.message.includes(modelPath(root)),
        'the failure must name the directory it looked in',
      );
      return true;
    });
  });
});

describe('the pin', () => {
  it('model, width and threshold are stated together', () => {
    // These three travel as a set: a model swap that leaves the width or the
    // threshold behind produces a corpus that mixes vector spaces or a dedup
    // that never fires. Pinning them in one assertion makes a partial change
    // fail here rather than in production.
    assert.equal(LOCAL_EMBEDDING_MODEL, 'Xenova/paraphrase-multilingual-MiniLM-L12-v2');
    assert.equal(LOCAL_EMBEDDING_DIMENSIONS, 384);
    assert.equal(RECOMMENDED_DEDUP_THRESHOLD, 0.45);
  });
});
