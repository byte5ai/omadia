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

// Mach-O magic numbers (first 4 bytes). Detecting by magic — not by extension —
// is required because the bundled Postgres binaries (postgres, initdb, pg_ctl …)
// are Mach-O EXECUTABLES with no extension, alongside the .node/.dylib modules.
const MACHO_MAGIC = new Set([0xfeedface, 0xfeedfacf, 0xcafebabe, 0xcefaedfe, 0xcffaedfe, 0xbebafeca]);

function isMachO(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4);
    const n = fs.readSync(fd, buf, 0, 4, 0);
    if (n < 4) return false;
    return MACHO_MAGIC.has(buf.readUInt32BE(0)) || MACHO_MAGIC.has(buf.readUInt32LE(0));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
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
    } else if (st.isFile() && isMachO(p)) {
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

  const developerId = findIdentity();
  // With signing secrets present (MAC_SIGN_EXPECTED=1) a missing identity is a
  // HARD error — silently shipping unsigned nested modules would only fail later
  // at notarization.
  if (!developerId && process.env.MAC_SIGN_EXPECTED === '1') {
    throw new Error(
      '[afterPack] signing was expected (MAC_SIGN_EXPECTED=1) but no Developer ID ' +
        'Application identity is available — the signing keychain was not set up ' +
        'before packaging. Refusing to ship unsigned native modules.',
    );
  }

  // Without a Developer ID we still sign — AD-HOC ("-"), not "not at all".
  //
  // WHY: electron-builder SKIPS its own signing step entirely when no identity
  // exists ("skipped macOS application code signing … 0 identities found"). The
  // packaged .app then has no `Contents/_CodeSignature` at all, while the Electron
  // binary inside it still carries its linker-signed ad-hoc signature. macOS reads
  // that combination as CORRUPT — `codesign --verify` and Apple's own
  // `syspolicy_check` both report "code has no resources but signature indicates
  // they must be present" (Severity: Fatal) — and Gatekeeper refuses to launch the
  // downloaded app with "omadia is damaged and can't be opened."
  //
  // An ad-hoc signature is still not distributable (users need a right-click →
  // Open, and notarization is impossible), but it is STRUCTURALLY VALID, so a
  // cert-less build produces an app that runs instead of one that cannot open.
  const identity = developerId ?? '-';
  const adhoc = !developerId;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  const resources = path.join(appPath, 'Contents', 'Resources');
  // Sign Mach-O in BOTH staged extraResources trees: the middleware native
  // modules (omadia/) and the bundled Postgres engine (omadia-pg/).
  const found = new Set();
  collectMachO(path.join(resources, 'omadia'), found);
  collectMachO(path.join(resources, 'omadia-pg'), found);
  const targets = [...found];

  const keychain = (process.env.MAC_SIGN_KEYCHAIN || '').trim();
  const args = ['--force', '--options', 'runtime'];
  // A secure timestamp needs a real certificate + Apple's timestamp server; it is
  // rejected for ad-hoc signatures, so only request it on the Developer ID path.
  if (!adhoc) args.push('--timestamp');
  if (keychain) args.push('--keychain', keychain);
  args.push('--sign', identity);

  const label = adhoc ? 'ad-hoc' : `"${identity}"`;
  if (targets.length === 0) {
    console.log('[afterPack] no nested Mach-O binaries found under extraResources.');
  } else {
    console.log(`[afterPack] signing ${targets.length} nested Mach-O binaries ${label}`);
    for (const target of targets) {
      execFileSync('codesign', [...args, target], { stdio: 'inherit' });
    }
  }

  // Seal the outer bundle ONLY on the ad-hoc path. On the Developer ID path
  // electron-builder signs the app itself right after this hook (with the correct
  // entitlements and, when requested, notarization) — signing it here would just
  // be overwritten.
  if (adhoc) {
    const entitlements = path.join(__dirname, 'entitlements.mac.plist');
    const frameworks = path.join(appPath, 'Contents', 'Frameworks');

    // Nested code must be signed BOTTOM-UP: each inner bundle's signature is
    // sealed into its parent, so signing the outer app first would be
    // invalidated by every later inner signature. Signing only the outer app
    // leaves e.g. `Electron Framework.framework` unsealed, and macOS then still
    // reports "code has no resources but signature indicates they must be
    // present" for the whole app.
    let entries = [];
    try {
      entries = fs.readdirSync(frameworks);
    } catch {
      /* no Frameworks dir (unexpected for Electron, but non-fatal) */
    }

    // 1. Versioned frameworks — sign `Versions/A`, not the symlinked top level.
    for (const name of entries.filter((n) => n.endsWith('.framework'))) {
      const versionA = path.join(frameworks, name, 'Versions', 'A');
      if (!fs.existsSync(versionA)) continue;
      execFileSync('codesign', ['--force', '--sign', '-', versionA], { stdio: 'inherit' });
    }

    // 2. Helper apps (GPU / Plugin / Renderer / main) — same entitlements as the
    //    outer app so the forked kernel keeps JIT + library-validation relief.
    for (const name of entries.filter((n) => n.endsWith('.app'))) {
      execFileSync(
        'codesign',
        [
          '--force',
          '--options',
          'runtime',
          '--entitlements',
          entitlements,
          '--sign',
          '-',
          path.join(frameworks, name),
        ],
        { stdio: 'inherit' },
      );
    }

    // 3. The outer app last, sealing everything above it.
    console.log(`[afterPack] ad-hoc signing the app bundle → ${appName}`);
    execFileSync(
      'codesign',
      ['--force', '--options', 'runtime', '--entitlements', entitlements, '--sign', '-', appPath],
      { stdio: 'inherit' },
    );

    // Prove the bundle macOS will actually see is valid, nested code included.
    // `--deep` is the check that surfaces an unsealed nested framework — the
    // exact defect that made the shipped v0.56.0 / v0.57.0 apps unopenable.
    execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
    console.log('[afterPack] ad-hoc signature verified (unsigned build — not distributable).');
  }
};
