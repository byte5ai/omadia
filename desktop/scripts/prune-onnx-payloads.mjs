/**
 * Drop the onnxruntime payloads a given installer can never load.
 *
 * OM-84 (byte5ai/omadia#1003) — the keyless embedding adapter
 * (`@omadia/embedding-adapter-local`) pulls in `@huggingface/transformers`,
 * which depends on BOTH onnxruntime builds and ships prebuilt native libraries
 * for six platform/arch triples. Unpruned that is ~365 MB and several thousand
 * files added to every installer, for a provider many operators never activate
 * — and the file count is the harder limit of the two: macOS signing hashes
 * every file in the bundle and dies with EMFILE well before it runs out of disk
 * (see `stage-runtime.mjs`).
 *
 * What is safe to remove is decided by the package's OWN export map, not by
 * guesswork. `@huggingface/transformers` resolves `node` → `import` to
 * `dist/transformers.node.mjs` and `node` → `require` to
 * `dist/transformers.node.cjs`; nothing reachable under the `node` condition
 * touches the browser WASM blobs. And `onnxruntime-web` IS the browser
 * backend — the Node path goes through `onnxruntime-node`, which lays its
 * prebuilt libraries out as `bin/napi-vN` then one directory per platform and
 * one per architecture, leaving five of six triples as dead weight on any
 * given installer.
 *
 * This lives in its own module rather than inline in `stage-runtime.mjs` so it
 * can be run against a throwaway tree and then have a sentence embedded
 * through it — reading the export map is not proof that the survivors load.
 */

import fs from 'node:fs';
import path from 'node:path';

/** `<platform>/<arch>` of the machine this installer is being built for. */
export function hostTriple() {
  return `${process.platform}/${process.arch}`;
}

/**
 * @param {string} root staged middleware root (the parent of `node_modules`)
 * @param {string} [keepTriple] defaults to {@link hostTriple}
 * @returns {{bytes: number, files: number}}
 */
export function pruneUnloadableOnnxPayloads(root, keepTriple = hostTriple()) {
  const modules = path.join(root, 'node_modules');
  let bytes = 0;
  let files = 0;

  const drop = (target) => {
    let stats;
    try {
      stats = fs.lstatSync(target);
    } catch {
      return; // not installed in this configuration — nothing to prune
    }
    if (stats.isDirectory()) {
      for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
        drop(path.join(target, entry.name));
      }
      fs.rmSync(target, { recursive: true, force: true });
      return;
    }
    bytes += stats.size;
    files += 1;
    fs.rmSync(target, { force: true });
  };

  // 1. The browser backend in its entirety.
  drop(path.join(modules, 'onnxruntime-web'));

  // 2. Every native onnxruntime triple except this installer's own.
  const ortBin = path.join(modules, 'onnxruntime-node', 'bin');
  for (const napi of readDirs(ortBin)) {
    for (const osDir of readDirs(napi)) {
      for (const archDir of readDirs(osDir)) {
        const triple = `${path.basename(osDir)}/${path.basename(archDir)}`;
        if (triple === keepTriple) continue;
        drop(archDir);
      }
    }
  }

  // 3. The browser WASM blobs inside transformers.js — ~21 MB each and
  //    unreachable under the `node` export condition.
  const hfDist = path.join(modules, '@huggingface', 'transformers', 'dist');
  for (const file of readFiles(hfDist)) {
    if (file.endsWith('.wasm')) drop(file);
  }

  return { bytes, files };
}

function readDirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

function readFiles(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}
