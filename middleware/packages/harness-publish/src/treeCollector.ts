import type { Sandbox } from '@omadia/sandbox';

import { PublishTreeTooLargeError } from './publishManifest.js';

/**
 * Issue #581 — reads the directory a `publish` call names entirely through
 * `Sandbox.list`/`Sandbox.read`. This is deliberate: those two methods are
 * ALREADY traversal-clamped against the sandbox's own root (`pathGuard.ts`
 * in `@omadia/sandbox`), so an agent-supplied `dir` or an agent-authored
 * filename inside it can never walk this collector outside the sandbox —
 * there is no raw filesystem path anywhere in this module, only paths the
 * `Sandbox` itself just enumerated via `list()` and re-validates on every
 * `read()`/`list()` call.
 */
const DEFAULT_MAX_FILES = 2_000;
const DEFAULT_MAX_DEPTH = 32;

export interface CollectTreeOptions {
  readonly maxFiles?: number;
  readonly maxDepth?: number;
}

/** Collects every regular file under `dir` (recursively) as `relativePath
 *  (relative to `dir`, POSIX-joined) -> content`. Throws
 *  `PublishTreeTooLargeError` rather than truncating silently — a publish
 *  that hit the cap should fail loudly, not ship a partial app. */
export async function collectTree(
  sandbox: Pick<Sandbox, 'list' | 'read'>,
  dir: string,
  appIdForErrors: string,
  options: CollectTreeOptions = {},
): Promise<Map<string, string>> {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const files = new Map<string, string>();

  async function walk(sandboxPath: string, relativePath: string, depth: number): Promise<void> {
    if (depth > maxDepth) throw new PublishTreeTooLargeError(appIdForErrors, maxFiles);
    const listing = await sandbox.list(sandboxPath);
    if (!listing.ok) return; // an empty/missing directory publishes zero files, not an error here
    for (const entry of listing.entries) {
      const childSandboxPath = sandboxPath === '.' || sandboxPath === '' ? entry.name : `${sandboxPath}/${entry.name}`;
      const childRelativePath = relativePath === '' ? entry.name : `${relativePath}/${entry.name}`;
      if (entry.kind === 'dir') {
        await walk(childSandboxPath, childRelativePath, depth + 1);
        continue;
      }
      if (entry.kind !== 'file') continue;
      if (files.size >= maxFiles) throw new PublishTreeTooLargeError(appIdForErrors, maxFiles);
      const read = await sandbox.read(childSandboxPath);
      if (read.ok) files.set(childRelativePath, read.content);
      // A file that vanished or became unreadable between list() and
      // read() is skipped, not fatal — the same "best effort over a live
      // tree" posture `syncReadOnlyLayer` takes in `@omadia/sandbox`.
    }
  }

  await walk(dir, '', 0);
  return files;
}
