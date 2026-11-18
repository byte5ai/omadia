import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseFeed } from './merge-mac-update-feed.mjs';
import { refreshDmgEntries } from './refresh-mac-feed-dmg.mjs';

const FEED = `version: 1.2.3
files:
  - url: omadia-1.2.3-arm64-mac.zip
    sha512: zipHash==
    size: 10
  - url: omadia-1.2.3-arm64.dmg
    sha512: staleHash==
    size: 20
path: omadia-1.2.3-arm64-mac.zip
sha512: zipHash==
releaseDate: '2026-11-04T00:00:00.000Z'
`;

describe('refreshDmgEntries', () => {
  it('rewrites only the DMG entry, from the stapled file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-'));
    const stapled = Buffer.from('stapled dmg bytes');
    fs.writeFileSync(path.join(dir, 'omadia-1.2.3-arm64.dmg'), stapled);

    const feed = parseFeed(refreshDmgEntries(FEED, dir), 'out');

    const dmg = feed.files.find((f) => f.url.endsWith('.dmg'));
    assert.equal(dmg.sha512, createHash('sha512').update(stapled).digest('base64'));
    assert.equal(dmg.size, String(stapled.length));
    const zip = feed.files.find((f) => f.url.endsWith('.zip'));
    assert.deepEqual([zip.sha512, zip.size], ['zipHash==', '10']);
    assert.equal(feed.scalars.path, 'omadia-1.2.3-arm64-mac.zip');
    assert.equal(feed.scalars.sha512, 'zipHash==');
  });

  it('rewrites the file when run as a script, also through a symlinked path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-'));
    fs.writeFileSync(path.join(dir, 'omadia-1.2.3-arm64.dmg'), 'stapled');
    const feedFile = path.join(dir, 'latest-mac.yml');
    fs.writeFileSync(feedFile, FEED);
    const link = path.join(dir, 'refresh-link.mjs');
    fs.symlinkSync(fileURLToPath(new URL('./refresh-mac-feed-dmg.mjs', import.meta.url)), link);

    execFileSync(process.execPath, [link, feedFile]);

    assert.doesNotMatch(fs.readFileSync(feedFile, 'utf8'), /staleHash/);
  });

  it('fails when a listed DMG is missing, rather than publishing a stale hash', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-'));
    assert.throws(() => refreshDmgEntries(FEED, dir), /ENOENT/);
  });
});
