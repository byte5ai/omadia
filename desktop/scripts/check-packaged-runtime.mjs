// What the packaged app needs before its kernel and web UI can start: the
// node_modules of both, shipped as extraResources. electron-builder 26 leaves
// out the top-level node_modules of every extraResources source
// (app-builder-lib util/filter.js), which is why electron-builder.yml gives each
// of them an entry of its own. A package without them installs fine and fails
// at its first start with ERR_MODULE_NOT_FOUND, so afterPack checks a few
// modules each process loads at startup, on every platform.

import fs from 'node:fs';
import path from 'node:path';

export const RUNTIME_SENTINELS = [
  'omadia/middleware/node_modules/@omadia/plugin-api/package.json',
  'omadia/middleware/node_modules/@omadia/llm-adapter-anthropic/package.json',
  'omadia/middleware/node_modules/express/package.json',
  'omadia/web-ui/node_modules/next/package.json',
];

/** The resources directory electron-builder packs into, per platform. */
export function packagedResourcesDir(platform, appOutDir, productFilename) {
  return platform === 'darwin'
    ? path.join(appOutDir, `${productFilename}.app`, 'Contents', 'Resources')
    : path.join(appOutDir, 'resources');
}

/** Sentinels missing under a packaged app's resources directory. */
export function missingRuntimeEntries(resourcesDir) {
  return RUNTIME_SENTINELS.filter((rel) => !fs.existsSync(path.join(resourcesDir, ...rel.split('/'))));
}

export function assertRuntimeComplete(resourcesDir) {
  const missing = missingRuntimeEntries(resourcesDir);
  if (missing.length > 0) {
    throw new Error(
      `[afterPack] the packaged runtime is incomplete and the app would not start; ` +
        `missing under ${resourcesDir}: ${missing.join(', ')}`,
    );
  }
}
