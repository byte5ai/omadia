// electron-builder afterPack hook — sign the native Mach-O binaries that ship
// as extraResources (the staged middleware's node_modules: better-sqlite3,
// argon2, sharp, and any nested .dylib).
//
// WHY: electron-builder signs the app bundle + its OWN dependencies, but it does
// NOT sign extraResources payloads. Under `hardenedRuntime: true` + notarization,
// Apple's notary service rejects bundles that contain unsigned Mach-O binaries
// (and hardened-runtime library validation refuses to load unsigned .node at
// runtime). We must sign these BEFORE electron-builder seals the outer app, so
// afterPack (post-pack, pre-sign) is the correct hook — the outer signature then
// records the now-signed nested binaries.
//
// Fail-soft: if no Developer ID identity is available (unsigned/local build), it
// logs and skips, so dev/ad-hoc builds still work.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Resolves the Developer ID Application identity to sign with.
 *
 * Prefers an explicit `MAC_SIGN_IDENTITY` env (set by CI) so we don't depend on
 * electron-builder's temporary keychain already existing when afterPack runs;
 * falls back to scanning the keychain via `security find-identity`.
 */
function findIdentity() {
  const fromEnv = (process.env.MAC_SIGN_IDENTITY || '').trim();
  if (fromEnv) return fromEnv;
  try {
    const out = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
      encoding: 'utf8',
    });
    const m = out.match(/"(Developer ID Application:[^"]+)"/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function collectMachO(dir, found) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return found;
  }
  for (const name of entries) {
    const p = path.join(dir, name);
    let st;
    try {
      // statSync FOLLOWS symlinks, so symlinked vendor dirs (e.g. sharp's libvips)
      // get walked and symlinked .dylibs resolve to their real target — which we
      // dedupe so we sign each Mach-O once. lstat-based walks miss these and ship
      // them unsigned, which the verify gate (find follows them) would then fail.
      st = fs.statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      collectMachO(p, found);
    } else if (st.isFile() && (name.endsWith('.node') || name.endsWith('.dylib'))) {
      try {
        found.add(fs.realpathSync(p));
      } catch {
        found.add(p);
      }
    }
  }
  return found;
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const identity = findIdentity();
  if (!identity) {
    // With signing secrets present (MAC_SIGN_EXPECTED=1) a missing identity is a
    // HARD error — silently shipping unsigned nested modules would only fail
    // later at notarization. Without secrets, this is the legitimate unsigned
    // (dev / ad-hoc) path, so we skip.
    if (process.env.MAC_SIGN_EXPECTED === '1') {
      throw new Error(
        '[afterPack] signing was expected (MAC_SIGN_EXPECTED=1) but no Developer ID ' +
          'Application identity is available — the signing keychain was not set up ' +
          'before packaging. Refusing to ship unsigned native modules.',
      );
    }
    console.log('[afterPack] no Developer ID identity — skipping nested signing (unsigned build).');
    return;
  }

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const omadiaResources = path.join(context.appOutDir, appName, 'Contents', 'Resources', 'omadia');
  const targets = [...collectMachO(omadiaResources, new Set())];
  if (targets.length === 0) {
    console.log('[afterPack] no nested Mach-O binaries found under extraResources.');
    return;
  }

  const keychain = (process.env.MAC_SIGN_KEYCHAIN || '').trim();
  const args = ['--force', '--options', 'runtime', '--timestamp'];
  if (keychain) args.push('--keychain', keychain);
  args.push('--sign', identity);

  console.log(`[afterPack] signing ${targets.length} nested Mach-O binaries with "${identity}"`);
  for (const target of targets) {
    execFileSync('codesign', [...args, target], { stdio: 'inherit' });
  }
};
