import fs from 'node:fs';
import path from 'node:path';

import { REQUIRED_MODEL_FILES, missingModelFiles, modelPath } from './localEmbeddingClient.js';

/**
 * OM-97 — where the model weights live, and why not where they used to.
 *
 * THE BUG. The default was `var/embedding-models`, resolved relative to the
 * middleware's working directory. In the desktop app that working directory is
 * `<app bundle>/Resources/omadia/middleware`, i.e. INSIDE the signed
 * application. Downloading ~129 MB there writes into the signed bundle, which
 * on macOS invalidates the code signature: Gatekeeper then refuses the next
 * launch, and the user's only recovery is a reinstall. A cache that can brick
 * the app is not a cache.
 *
 * THE RULE. Weights are mutable per-user state and belong with the rest of it,
 * next to the vault, the embedded database and the plugin uploads — never in
 * the read-only application. Resolution order, most explicit first:
 *
 *   1. the plugin's own `model_dir` setup field (handled by the caller);
 *   2. `OMADIA_EMBEDDING_MODEL_DIR` — what the desktop shell sets, pointing at
 *      Electron's per-user `userData`;
 *   3. `PLATFORM_DATA_DIR/embedding-models` — the kernel's single data-volume
 *      convention (`middleware/src/platform/paths.ts`), which is what a Docker
 *      or Fly deployment already mounts and backs up;
 *   4. the legacy `var/embedding-models`, kept as the last resort so a plain
 *      `npm run dev` checkout behaves exactly as it did.
 *
 * Only (4) can land inside a bundle, and (4) is unreachable in any packaged
 * deployment because both (2) and (3) are set there.
 */

/** Explicit override, ahead of every convention. Set by the desktop shell. */
export const MODEL_DIR_ENV = 'OMADIA_EMBEDDING_MODEL_DIR';
/** The kernel's data-volume convention — see `middleware/src/platform/paths.ts`. */
export const PLATFORM_DATA_DIR_ENV = 'PLATFORM_DATA_DIR';
/** Leaf under the data dir. Sibling of `builder/`, `scratch/`, `vault.enc.json`. */
export const MODEL_DIR_LEAF = 'embedding-models';
/**
 * Where the weights used to default to. Relative, so it resolves against the
 * middleware's cwd — which is the whole problem, and the reason
 * {@link adoptLegacyModelDir} exists.
 */
export const LEGACY_MODEL_DIR = path.join('var', MODEL_DIR_LEAF);

function readEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = env[key];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * The default model directory for this deployment. `env` is a parameter rather
 * than a read of `process.env` so a test can drive all four branches without
 * mutating the process.
 */
export function defaultModelDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = readEnv(env, MODEL_DIR_ENV);
  if (explicit !== undefined) return explicit;
  const dataDir = readEnv(env, PLATFORM_DATA_DIR_ENV);
  if (dataDir !== undefined) return path.join(path.resolve(dataDir), MODEL_DIR_LEAF);
  return LEGACY_MODEL_DIR;
}

/** What one adoption attempt did, for the activation log. */
export interface LegacyAdoption {
  readonly moved: boolean;
  readonly from: string;
  readonly to: string;
  readonly detail: string;
}

/**
 * Carry weights an older build left inside the app bundle over to the new
 * directory, once.
 *
 * Deliberately best-effort and deliberately silent about the common case (no
 * legacy directory, which is every fresh install). It runs only when the NEW
 * location is incomplete: an operator who already has working weights there is
 * never touched, and a half-finished download in the legacy directory is not
 * adopted either — `missingModelFiles` has to come back empty for the source.
 *
 * `rename` first, `copy` as the fallback: the bundle and the user data dir are
 * frequently on the same volume, but on a Docker deployment with the data
 * volume mounted from elsewhere they are not, and `EXDEV` must not abort this.
 * A failed adoption is never fatal — the weights remain downloadable.
 */
export function adoptLegacyModelDir(args: {
  targetDir: string;
  legacyDir?: string;
  log: (msg: string) => void;
}): LegacyAdoption {
  const legacyDir = args.legacyDir ?? LEGACY_MODEL_DIR;
  const from = path.resolve(legacyDir);
  const to = path.resolve(args.targetDir);
  const unchanged = (detail: string): LegacyAdoption => ({
    moved: false,
    from,
    to,
    detail,
  });

  if (from === to) return unchanged('the legacy directory IS the target');
  if (missingModelFiles(to).length === 0) {
    return unchanged('the target already holds a complete model');
  }
  if (missingModelFiles(from).length > 0) {
    return unchanged('the legacy directory holds no complete model');
  }

  try {
    fs.mkdirSync(path.dirname(modelPath(to)), { recursive: true });
    try {
      fs.renameSync(modelPath(from), modelPath(to));
    } catch {
      // EXDEV (separate volumes) and a non-empty destination both land here.
      // `cpSync` handles the first and overwrites into the second, which is
      // safe: the target was established as incomplete above.
      fs.cpSync(modelPath(from), modelPath(to), { recursive: true, force: true });
      fs.rmSync(modelPath(from), { recursive: true, force: true });
    }
  } catch (err) {
    return unchanged(
      `adoption failed (${err instanceof Error ? err.message : String(err)}) — the weights can still be downloaded into the new directory`,
    );
  }

  const stillMissing = missingModelFiles(to);
  if (stillMissing.length > 0) {
    return unchanged(
      `adoption moved files but ${stillMissing.join(', ')} is still missing — re-download`,
    );
  }
  args.log(
    `[embedding-adapter-local] OM-97: adopted the model weights from the legacy location ${modelPath(from)} into ${modelPath(to)} — the old path was inside the application bundle, where writing invalidates the code signature. ${String(REQUIRED_MODEL_FILES.length)} required file(s) verified at the new location.`,
  );
  return { moved: true, from, to, detail: 'adopted' };
}
