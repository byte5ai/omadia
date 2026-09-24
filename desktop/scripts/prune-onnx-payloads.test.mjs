// Tests for the onnxruntime staging prune (OM-84 / byte5ai/omadia#1003).
//
// The prune deletes ~287 MB and ~700 files from every installer, so what it
// keeps matters as much as what it removes: delete one file the Node path
// actually resolves and the keyless embedder is dead in the shipped app, with
// nothing in CI to notice — the desktop build does not run inference.
//
// These tests pin the RULES against a synthetic tree. That the survivors
// actually load was established separately, by running the real prune over a
// real install and then embedding a sentence through it (376 MB / 2456 files →
// 88 MB / 1750 files, and the embedding still returned 384 dimensions with
// paraphrase 0.580 vs unrelated -0.108). A unit test cannot hold a 118 MB
// model, and pretending otherwise is how a guard ends up green for the wrong
// reason.
//
// Run: node --test desktop/scripts/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { hostTriple, pruneUnloadableOnnxPayloads } from './prune-onnx-payloads.mjs';

const TRIPLES = [
  ['darwin', 'arm64'],
  ['darwin', 'x64'],
  ['linux', 'arm64'],
  ['linux', 'x64'],
  ['win32', 'arm64'],
  ['win32', 'x64'],
];

/** A staged tree shaped like the real one, with a byte of content per file. */
function stagedTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omadia-ortprune-'));
  const write = (relative, size = 1) => {
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, Buffer.alloc(size, 0x61));
  };

  // onnxruntime-node: one native library per triple, plus shared JS.
  for (const [platform, arch] of TRIPLES) {
    write(`node_modules/onnxruntime-node/bin/napi-v3/${platform}/${arch}/onnxruntime_binding.node`, 1024);
    write(`node_modules/onnxruntime-node/bin/napi-v3/${platform}/${arch}/libonnxruntime.so`, 2048);
  }
  write('node_modules/onnxruntime-node/lib/index.js');
  write('node_modules/onnxruntime-node/package.json');

  // onnxruntime-web: the browser backend, several files.
  write('node_modules/onnxruntime-web/dist/ort.min.js', 4096);
  write('node_modules/onnxruntime-web/dist/ort-wasm.wasm', 8192);
  write('node_modules/onnxruntime-web/package.json');

  // transformers.js: the node entrypoints, the browser bundles, the WASM.
  write('node_modules/@huggingface/transformers/dist/transformers.node.mjs', 512);
  write('node_modules/@huggingface/transformers/dist/transformers.node.cjs', 512);
  write('node_modules/@huggingface/transformers/dist/transformers.web.js', 512);
  write('node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.wasm', 16384);
  write('node_modules/@huggingface/transformers/src/transformers.js', 256);
  write('node_modules/@huggingface/transformers/package.json');

  // An unrelated package, to catch a prune that walks too far.
  write('node_modules/pg/lib/index.js');

  return root;
}

const exists = (root, relative) => fs.existsSync(path.join(root, relative));

function withTree(run) {
  const root = stagedTree();
  try {
    return run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('keeps the host triple and removes the other five', () => {
  withTree((root) => {
    pruneUnloadableOnnxPayloads(root, 'linux/x64');
    assert.ok(
      exists(root, 'node_modules/onnxruntime-node/bin/napi-v3/linux/x64/onnxruntime_binding.node'),
      'the kept triple must survive intact',
    );
    for (const [platform, arch] of TRIPLES) {
      if (`${platform}/${arch}` === 'linux/x64') continue;
      assert.equal(
        exists(root, `node_modules/onnxruntime-node/bin/napi-v3/${platform}/${arch}`),
        false,
        `${platform}/${arch} should be gone`,
      );
    }
  });
});

test('keeps onnxruntime-node itself — only its foreign binaries go', () => {
  withTree((root) => {
    pruneUnloadableOnnxPayloads(root, 'darwin/arm64');
    assert.ok(exists(root, 'node_modules/onnxruntime-node/lib/index.js'));
    assert.ok(exists(root, 'node_modules/onnxruntime-node/package.json'));
  });
});

test('removes onnxruntime-web entirely — Node resolves onnxruntime-node', () => {
  withTree((root) => {
    pruneUnloadableOnnxPayloads(root, 'darwin/arm64');
    assert.equal(exists(root, 'node_modules/onnxruntime-web'), false);
  });
});

test("removes transformers.js WASM but keeps both node entrypoints", () => {
  withTree((root) => {
    pruneUnloadableOnnxPayloads(root, 'darwin/arm64');
    const dist = 'node_modules/@huggingface/transformers/dist';
    assert.equal(exists(root, `${dist}/ort-wasm-simd-threaded.jsep.wasm`), false);
    // The export map's `node` condition resolves import → .mjs and
    // require → .cjs. Losing either breaks the adapter in the shipped app.
    assert.ok(exists(root, `${dist}/transformers.node.mjs`), 'node ESM entry must survive');
    assert.ok(exists(root, `${dist}/transformers.node.cjs`), 'node CJS entry must survive');
    assert.ok(exists(root, 'node_modules/@huggingface/transformers/src/transformers.js'));
  });
});

test('leaves unrelated packages alone', () => {
  withTree((root) => {
    pruneUnloadableOnnxPayloads(root, 'darwin/arm64');
    assert.ok(exists(root, 'node_modules/pg/lib/index.js'));
  });
});

test('reports the bytes and files it actually removed', () => {
  withTree((root) => {
    const { bytes, files } = pruneUnloadableOnnxPayloads(root, 'linux/x64');
    // 5 foreign triples x 2 native files            = 10
    // + onnxruntime-web in full (2 dist + package.json) = 3
    // + the transformers.js WASM blob                = 1
    assert.equal(files, 14);
    // 5 x (1024 + 2048) + (4096 + 8192 + 1) + 16384
    assert.equal(bytes, 44033);
    // Exact numbers on purpose. A `> 0` assertion here would have passed
    // while this very expectation was miscounted — onnxruntime-web's
    // package.json is a third file, not a second.
  });
});

test('is idempotent — a second staging pass removes nothing more', () => {
  withTree((root) => {
    pruneUnloadableOnnxPayloads(root, 'linux/x64');
    const second = pruneUnloadableOnnxPayloads(root, 'linux/x64');
    assert.deepEqual(second, { bytes: 0, files: 0 });
  });
});

test('does nothing when the embedder is not installed at all', () => {
  // The adapter is optional; a tree without onnxruntime must not throw.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omadia-ortprune-bare-'));
  try {
    fs.mkdirSync(path.join(root, 'node_modules', 'pg'), { recursive: true });
    assert.deepEqual(pruneUnloadableOnnxPayloads(root, 'linux/x64'), { bytes: 0, files: 0 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('hostTriple matches the running platform', () => {
  assert.equal(hostTriple(), `${process.platform}${'/'}${process.arch}`);
});
