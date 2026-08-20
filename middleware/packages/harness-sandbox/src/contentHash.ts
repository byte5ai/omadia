import { createHash } from 'node:crypto';

/**
 * Issue #576 P3 — content-hash fingerprinting for a sandbox's read-only
 * layer (per the issue: "Read-only layers (org files, skills) are
 * materialized by content-hash fingerprint, only re-synced on change").
 *
 * `#576` is deliberately the SUBSTRATE, not the consumer: what actually goes
 * into a scope's RO layer (org files, skills — the issue names both) is a
 * separate concept the issue explicitly says "several other qm concepts …
 * build on" this sandbox, not something #576 itself decides. So this module
 * exports the mechanism — hash a file set, sync only the files whose
 * content changed since the last synced hash — for a future consumer to
 * call with real content. Calling it with a hand-built `files` map is a
 * fully exercised, real code path in `contentHash.test.ts`; there is no
 * unwired surface here — `syncReadOnlyLayer` calls `Sandbox.write` for
 * real, and the "only when the hash changed" behavior is exactly what is
 * under test.
 */

/**
 * Deterministic content hash of a file set. Order-independent (sorted keys)
 * and byte-stable for a given `files` value — the same set of paths and
 * contents always hashes identically, which is what makes "only re-sync on
 * change" possible: a caller persists this string (e.g. in
 * `SandboxRegistry.roLayerHash`) and compares it next time before writing
 * anything.
 */
export function computeContentHash(files: Readonly<Record<string, string>>): string {
  const hash = createHash('sha256');
  for (const path of Object.keys(files).sort()) {
    hash.update(path, 'utf8');
    hash.update('\0', 'utf8');
    hash.update(files[path] as string, 'utf8');
    hash.update('\0', 'utf8');
  }
  return hash.digest('hex');
}

export interface SyncReadOnlyLayerResult {
  readonly hash: string;
  /** False when `previousHash` already matched — nothing was written. */
  readonly synced: boolean;
  /** Paths actually written this call. Empty when `synced` is false. */
  readonly writtenPaths: readonly string[];
}

/**
 * Materialize `files` into `sandbox` — but only when their combined content
 * hash differs from `previousHash`. On a genuine change, every file in the
 * set is (re)written; a partial diff (only the changed files) is
 * deliberately NOT attempted here — the issue's design point is skipping
 * the sync ENTIRELY when nothing changed, not minimizing bytes written on
 * a real change, and per-file diffing would need a per-file hash map this
 * module does not carry (a legitimate future refinement, not a shortfall
 * of this primitive's stated contract).
 */
export async function syncReadOnlyLayer(
  sandbox: { write(relativePath: string, content: string): Promise<{ ok: boolean }> },
  files: Readonly<Record<string, string>>,
  previousHash: string | undefined,
): Promise<SyncReadOnlyLayerResult> {
  const hash = computeContentHash(files);
  if (hash === previousHash) {
    return { hash, synced: false, writtenPaths: [] };
  }
  const writtenPaths: string[] = [];
  for (const path of Object.keys(files).sort()) {
    const result = await sandbox.write(path, files[path] as string);
    if (result.ok) writtenPaths.push(path);
  }
  return { hash, synced: true, writtenPaths };
}
