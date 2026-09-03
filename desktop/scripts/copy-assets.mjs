// Mirrors `src`-adjacent static assets (icons) into `dist/assets` (#888).
//
// The packaged app only ships `dist/**` (see `files:` in electron-builder.yml),
// so anything the running shell reads at runtime has to be inside dist. The
// tray template and the window icon are read through `app.getAppPath()`, which
// resolves to the asar in a packaged app and to `desktop/` in a dev run —
// `src/icons.ts` tries `dist/assets` first and `assets` second for exactly that
// reason, so this copy is what makes the packaged path work.
//
// Runs as part of `npm run build`, next to copy-renderer.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', 'assets');
const dest = path.join(here, '..', 'dist', 'assets');

if (!fs.existsSync(src)) {
  // A build with no assets directory would silently produce an app with no
  // icons — the OM-53/OM-63 failure mode. Fail instead.
  console.error(
    `[copy-assets] missing ${src}. Run \`npm run icons\` to generate the icon assets.`,
  );
  process.exit(1);
}

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });
fs.cpSync(src, dest, { recursive: true });

const copied = fs.readdirSync(dest).sort();
console.log(`[copy-assets] ${src} → ${dest} (${copied.join(', ')})`);
