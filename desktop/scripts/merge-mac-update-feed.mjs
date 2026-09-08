// Merges the per-architecture `latest-mac.yml` files that electron-updater reads.
//
// WHY THIS EXISTS
// arm64 and x64 have to be built on separate runners: the omadia runtime ships as
// unpacked extraResources (native node modules + the embedded Postgres engine),
// which electron-builder copies verbatim and cannot arch-split. Each run therefore
// emits its OWN `latest-mac.yml` listing only its own artifacts, and both would be
// uploaded to the same release — last write wins.
//
// That silently half-breaks auto-update, because MacUpdater picks the download by
// looking for "arm64" in the file URL:
//
//   const isArm64 = (file) => file.url.pathname.includes("arm64") || ...
//
// A feed containing only arm64 entries leaves Intel users with no matching file;
// a feed containing only x64 entries pushes every Apple Silicon user onto the
// Rosetta build. Merging the `files` arrays fixes both.
//
// Usage: node merge-mac-update-feed.mjs <primary.yml> <secondary.yml> <out.yml>
// The PRIMARY feed supplies the legacy top-level `path`/`sha512` fields, which
// pre-arch-aware updaters follow — pass the arm64 feed as primary.
//
// Deliberately dependency-free: this runs in a CI job that does not `npm ci`.
// The input is machine-generated with a fixed shape, so the parser is strict and
// throws on anything it does not recognise rather than guessing — a malformed
// merge would break updates for every user at once.
import fs from 'node:fs';

import { isEntryPoint } from './isEntryPoint.mjs';

const SCALARS = new Set(['version', 'path', 'sha512', 'releaseDate']);

/** Strips one layer of YAML quoting. electron-builder quotes only releaseDate. */
function unquote(v) {
  const t = v.trim();
  if (t.length >= 2) {
    const q = t[0];
    if ((q === "'" || q === '"') && t.endsWith(q)) return t.slice(1, -1);
  }
  return t;
}

/**
 * Parses the exact shape electron-builder emits:
 *   version: <scalar>
 *   files:
 *     - url: <scalar>
 *       sha512: <scalar>
 *       size: <number>
 *   path: <scalar>
 *   sha512: <scalar>
 *   releaseDate: <quoted scalar>
 * Throws on any line that does not fit.
 */
export function parseFeed(text, label) {
  const out = { scalars: {}, files: [] };
  let inFiles = false;
  let current = null;

  text.split('\n').forEach((rawLine, i) => {
    const line = rawLine.replace(/\r$/, '');
    if (line.trim() === '') return;
    const where = `${label}:${i + 1}`;

    const topLevel = line.match(/^([a-zA-Z0-9_]+):\s*(.*)$/);
    if (topLevel) {
      const [, key, value] = topLevel;
      if (key === 'files') {
        if (value.trim() !== '') throw new Error(`${where}: expected "files:" to start a block`);
        inFiles = true;
        current = null;
        return;
      }
      if (!SCALARS.has(key)) throw new Error(`${where}: unexpected top-level key "${key}"`);
      inFiles = false;
      current = null;
      out.scalars[key] = unquote(value);
      return;
    }

    if (!inFiles) throw new Error(`${where}: indented line outside the files block: "${line}"`);

    const entryStart = line.match(/^\s*-\s+([a-zA-Z0-9_]+):\s*(.*)$/);
    if (entryStart) {
      current = {};
      out.files.push(current);
      current[entryStart[1]] = unquote(entryStart[2]);
      return;
    }

    const entryProp = line.match(/^\s+([a-zA-Z0-9_]+):\s*(.*)$/);
    if (entryProp) {
      if (current == null) throw new Error(`${where}: property before any list entry`);
      current[entryProp[1]] = unquote(entryProp[2]);
      return;
    }

    throw new Error(`${where}: unparseable line: "${line}"`);
  });

  if (!out.scalars.version) throw new Error(`${label}: no "version" field`);
  if (out.files.length === 0) throw new Error(`${label}: no files listed`);
  for (const f of out.files) {
    for (const k of ['url', 'sha512', 'size']) {
      if (f[k] === undefined) throw new Error(`${label}: file entry missing "${k}": ${JSON.stringify(f)}`);
    }
  }
  return out;
}

/** Re-emits the structure in electron-builder's own formatting. */
export function serializeFeed(feed) {
  const lines = [`version: ${feed.scalars.version}`, 'files:'];
  for (const f of feed.files) {
    lines.push(`  - url: ${f.url}`);
    lines.push(`    sha512: ${f.sha512}`);
    lines.push(`    size: ${f.size}`);
  }
  if (feed.scalars.path) lines.push(`path: ${feed.scalars.path}`);
  if (feed.scalars.sha512) lines.push(`sha512: ${feed.scalars.sha512}`);
  if (feed.scalars.releaseDate) lines.push(`releaseDate: '${feed.scalars.releaseDate}'`);
  return lines.join('\n') + '\n';
}

export function mergeFeeds(primary, secondary) {
  if (primary.scalars.version !== secondary.scalars.version) {
    throw new Error(
      `version mismatch: primary=${primary.scalars.version} secondary=${secondary.scalars.version} — ` +
        'the two architectures were built from different sources; refusing to merge.',
    );
  }
  const seen = new Set();
  const files = [];
  for (const f of [...primary.files, ...secondary.files]) {
    if (seen.has(f.url)) continue; // same artifact listed twice — keep the first
    seen.add(f.url);
    files.push(f);
  }
  // An updater that finds no arch-matching entry cannot update at all, so make
  // the arch split explicit rather than discovering it in the field.
  const arm = files.filter((f) => f.url.includes('arm64')).length;
  const intel = files.length - arm;
  if (arm === 0 || intel === 0) {
    throw new Error(
      `merged feed covers only one architecture (arm64=${arm}, x64=${intel}) — ` +
        'auto-update would break for the other. Refusing to write it.',
    );
  }
  return { scalars: { ...primary.scalars }, files };
}

const isMain = isEntryPoint(import.meta.url);
if (isMain) {
  const [primaryPath, secondaryPath, outPath] = process.argv.slice(2);
  if (!primaryPath || !secondaryPath || !outPath) {
    console.error('usage: merge-mac-update-feed.mjs <primary.yml> <secondary.yml> <out.yml>');
    process.exit(1);
  }
  const primary = parseFeed(fs.readFileSync(primaryPath, 'utf8'), primaryPath);
  const secondary = parseFeed(fs.readFileSync(secondaryPath, 'utf8'), secondaryPath);
  const merged = mergeFeeds(primary, secondary);
  fs.writeFileSync(outPath, serializeFeed(merged));
  const arm = merged.files.filter((f) => f.url.includes('arm64')).length;
  console.log(
    `[merge-mac-update-feed] ${merged.files.length} file(s) — ${arm} arm64, ${merged.files.length - arm} x64 → ${outPath}`,
  );
  for (const f of merged.files) console.log(`  ${f.url}`);
}
