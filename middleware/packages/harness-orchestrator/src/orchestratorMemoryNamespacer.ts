import type { MemoryEntry, MemoryStore } from '@omadia/plugin-api';

/**
 * Per-orchestrator memory namespacer.
 *
 * The model-facing `memory` tool emits absolute `/memories/...` paths and is
 * unaware that several Agents share one physical store. This wrapper makes
 * each Agent see a PRIVATE `/memories` root that is physically backed by
 * `/memories/orchestrators/<slug>/...`, while a small allow-list of shared
 * namespaces (`core`, `sessions`, `chat-sessions`, brand `_*`) passes through
 * untouched so cross-agent kernel data (session transcripts, brand files,
 * system rules) stays common.
 *
 * It is a transparent bijection:
 *   - inbound paths are rewritten into the private tree (`toInner`)
 *   - outbound `list` entries are rewritten back out (`toOuter`)
 * so the model only ever sees `/memories/...` and can never address another
 * Agent's tree by construction.
 *
 * Layering (set up in `buildOrchestratorForAgent`):
 *   OrchestratorMemoryNamespacer  (rewrite to private tree)
 *     → ScopedMemoryStore         (enforce `orchestrator:<slug>:*` + `core`)
 *       → FilesystemMemoryStore   (physical I/O)
 * The ScopedMemoryStore is the hard backstop: a rewrite bug surfaces as a
 * `MemoryScopeViolation` rather than a cross-agent leak.
 */

const MEMORIES_ROOT = '/memories';

/**
 * First-segment names under `/memories` that are SHARED across Agents and
 * therefore pass through the namespacer unchanged. Mirrors the `core`
 * pattern in `ScopedMemoryStore` (which also permits top-level `_*` dirs).
 */
const SHARED_SEGMENTS = new Set(['core', 'sessions', 'chat-sessions']);

function firstSegment(rest: string): string {
  // `rest` starts with '/', e.g. '/core/x.md' → 'core'.
  const trimmed = rest.replace(/^\/+/, '');
  const slash = trimmed.indexOf('/');
  return slash === -1 ? trimmed : trimmed.slice(0, slash);
}

function isShared(rest: string): boolean {
  const seg = firstSegment(rest);
  return seg.startsWith('_') || SHARED_SEGMENTS.has(seg);
}

export class OrchestratorMemoryNamespacer implements MemoryStore {
  private readonly privateRoot: string;

  constructor(
    private readonly agentSlug: string,
    private readonly inner: MemoryStore,
  ) {
    this.privateRoot = `${MEMORIES_ROOT}/orchestrators/${agentSlug}`;
  }

  /** Model-facing `/memories/...` → physical path in the private tree. */
  private toInner(path: string): string {
    if (path === MEMORIES_ROOT) return this.privateRoot;
    if (!path.startsWith(`${MEMORIES_ROOT}/`)) return path; // not ours; leave it
    const rest = path.slice(MEMORIES_ROOT.length); // '/...'
    if (isShared(rest)) return path; // shared namespace — passthrough
    return `${this.privateRoot}${rest}`;
  }

  /** Physical path → model-facing `/memories/...` (inverse of `toInner`). */
  private toOuter(path: string): string {
    if (path === this.privateRoot) return MEMORIES_ROOT;
    if (path.startsWith(`${this.privateRoot}/`)) {
      return `${MEMORIES_ROOT}${path.slice(this.privateRoot.length)}`;
    }
    return path; // shared / unmapped — already in the outer namespace
  }

  list(virtualPath: string): Promise<MemoryEntry[]> {
    return this.inner.list(this.toInner(virtualPath)).then((entries) =>
      entries.map((e) => ({ ...e, virtualPath: this.toOuter(e.virtualPath) })),
    );
  }

  fileExists(virtualPath: string): Promise<boolean> {
    return this.inner.fileExists(this.toInner(virtualPath));
  }

  directoryExists(virtualPath: string): Promise<boolean> {
    return this.inner.directoryExists(this.toInner(virtualPath));
  }

  readFile(virtualPath: string): Promise<string> {
    return this.inner.readFile(this.toInner(virtualPath));
  }

  createFile(virtualPath: string, content: string): Promise<void> {
    return this.inner.createFile(this.toInner(virtualPath), content);
  }

  writeFile(virtualPath: string, content: string): Promise<void> {
    return this.inner.writeFile(this.toInner(virtualPath), content);
  }

  delete(virtualPath: string): Promise<void> {
    return this.inner.delete(this.toInner(virtualPath));
  }

  rename(fromVirtualPath: string, toVirtualPath: string): Promise<void> {
    return this.inner.rename(
      this.toInner(fromVirtualPath),
      this.toInner(toVirtualPath),
    );
  }
}
