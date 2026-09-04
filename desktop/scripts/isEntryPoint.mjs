// Is this module the process entry point? — the one guard, two call sites.
//
// WHY THIS IS NOT A ONE-LINER
// The obvious form compares `import.meta.url` against a `file://` URL built by
// concatenating `process.argv[1]`. That puts a filesystem path where a URL
// belongs and is wrong in three separate ways, each of which turns a CLI script
// into a SILENT NO-OP that exits 0:
//
//   1. Windows. `process.argv[1]` is `D:\a\omadia\…`; `import.meta.url` is
//      `file:///D:/a/omadia/…`. Never equal. This is why every Windows
//      installer up to and including v0.149.2 shipped as
//      `omadia.Setup.0.1.0.exe` while the macOS and Linux artifacts of the very
//      same release carried the real version: `set-desktop-version.mjs` ran,
//      matched nothing, wrote nothing, and CI called the step a success.
//   2. Percent-encoding. A path containing a space, `#` or `?` is encoded in
//      the URL (`desktop dir` -> `desktop%20dir`) and spelled literally in
//      argv. Breaks on macOS and Linux too.
//   3. Symlinks. Node resolves `import.meta.url` through realpath; argv[1] is
//      not resolved. On macOS `os.tmpdir()` is `/var/folders/…`, a symlink to
//      `/private/var/folders/…` — so even a correct `fileURLToPath` comparison
//      fails there. Any checkout reached through a symlink has the same shape.
//
// So: cross the URL/path boundary with `fileURLToPath`, then realpath BOTH
// sides. Realpathing the module too is not redundant — it keeps the comparison
// honest under `--preserve-symlinks-main`, where Node leaves `import.meta.url`
// unresolved while argv[1] still resolves.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * @param {string} moduleUrl - the caller's `import.meta.url`
 * @returns {boolean} true when Node was started with this very file
 */
export function isEntryPoint(moduleUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return (
      fs.realpathSync(fileURLToPath(moduleUrl)) ===
      fs.realpathSync(path.resolve(entry))
    );
  } catch {
    // A vanished or unreadable entry path is not this module — and a guard is
    // the wrong place to throw.
    return false;
  }
}
