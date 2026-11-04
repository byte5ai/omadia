#!/usr/bin/env node
// Stapling changes a DMG after electron-builder has hashed it, so the `.dmg`
// entries of latest-mac.yml end up describing a file that was never published.
// The updater reads the zip entries, which stapling leaves alone, but anything
// checking a DMG against the feed fails. Run after stapling, before the feeds of
// both architectures are merged.
//
//   node scripts/refresh-mac-feed-dmg.mjs release/latest-mac.yml

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { isEntryPoint } from './isEntryPoint.mjs';
import { parseFeed, serializeFeed } from './merge-mac-update-feed.mjs';

/** `feedFile` with each listed DMG's hash and size taken from the file next to it. */
export function refreshDmgEntries(feedText, feedDir, label = 'feed') {
  const feed = parseFeed(feedText, label);
  const files = feed.files.map((entry) => {
    if (!entry.url.endsWith('.dmg')) return entry;
    const bytes = fs.readFileSync(path.join(feedDir, entry.url));
    return {
      ...entry,
      sha512: createHash('sha512').update(bytes).digest('base64'),
      size: String(bytes.length),
    };
  });
  return serializeFeed({ ...feed, files });
}

if (isEntryPoint(import.meta.url)) {
  const feedFile = process.argv[2];
  if (!feedFile) {
    console.error('usage: refresh-mac-feed-dmg.mjs <latest-mac.yml>');
    process.exit(2);
  }
  fs.writeFileSync(
    feedFile,
    refreshDmgEntries(fs.readFileSync(feedFile, 'utf8'), path.dirname(feedFile), feedFile),
  );
  console.log(`[refresh-mac-feed-dmg] ${feedFile} now describes the stapled DMG`);
}
