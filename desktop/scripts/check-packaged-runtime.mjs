// Files the kernel and the web UI load at startup, checked in the packaged app.
// afterPack runs the check on every platform; electron-builder.yml explains how
// a package could come out without them.

import fs from 'node:fs';
import path from 'node:path';

export const RUNTIME_SENTINELS = [
  'omadia/middleware/dist/index.js',
  'omadia/middleware/node_modules/@omadia/plugin-api/package.json',
  'omadia/middleware/node_modules/@omadia/llm-adapter-anthropic/package.json',
  'omadia/middleware/node_modules/express/package.json',
  'omadia/web-ui/server.js',
  'omadia/web-ui/.next/BUILD_ID',
  'omadia/web-ui/node_modules/next/package.json',
];

/** Sentinels missing under a packaged app's resources directory. */
export function missingRuntimeEntries(resourcesDir) {
  return RUNTIME_SENTINELS.filter((rel) => !fs.existsSync(path.join(resourcesDir, ...rel.split('/'))));
}

export function assertRuntimeComplete(resourcesDir) {
  const missing = missingRuntimeEntries(resourcesDir);
  if (missing.length > 0) {
    throw new Error(
      `[afterPack] the package lacks files the kernel or the web UI loads at startup, ` +
        `so the app would not start; missing under ${resourcesDir}: ${missing.join(', ')}`,
    );
  }
}
