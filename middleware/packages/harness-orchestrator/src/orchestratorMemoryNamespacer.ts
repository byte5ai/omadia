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
 *
 * `ContextMemoryNamespacer` (below) is the same bijection with a per-CONTEXT
 * private root — see its doc comment.
 */

const MEMORIES_ROOT = '/memories';

/**
 * First-segment names under `/memories` that are SHARED across Agents and
 * therefore pass through the namespacer unchanged. Mirrors the `core`
 * pattern in `ScopedMemoryStore` (which also permits top-level `_*` dirs).
 *
 * `contexts` is deliberately NOT in here: the per-context trees are private
 * per Agent × context, never shared.
 */
const SHARED_SEGMENTS = new Set(['core', 'sessions', 'chat-sessions']);

/**
 * Reserved model-facing first segments, recognised ONLY in context mode.
 * The `~` prefix is safe by construction: the namespacer never emits a `~`
 * segment outward, so no pre-existing physical path can collide with them.
 */
const TEAM_SEGMENT = '~team';
const AGENT_SEGMENT = '~agent';

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

/** One model-facing prefix ↔ one physical root. */
interface RootBinding {
  /** Model-facing prefix, e.g. `/memories` or `/memories/~team`. */
  readonly outer: string;
  /** Physical root it is backed by. */
  readonly inner: string;
}

/**
 * Shared machinery for both namespacers: a bijection between the model-facing
 * `/memories` namespace and one or more physical roots.
 *
 * `reservedSegments` names the model-facing first segments that are resolved
 * through a binding instead of through the private root. A reserved segment
 * WITHOUT a bound root (e.g. `~team` on a turn that has no team axis) is left
 * in the outer namespace untouched — it then matches no compiled pattern, so
 * the `ScopedMemoryStore` soft-denies the read and raises
 * `MemoryScopeViolation` on the write. Enforcement stays in the store; this
 * mapper never throws.
 */
abstract class MemoryNamespacerBase implements MemoryStore {
  /** Physical roots, longest first, so nested roots resolve unambiguously. */
  private readonly bindings: readonly RootBinding[];

  protected constructor(
    private readonly inner: MemoryStore,
    private readonly privateRoot: string,
    /** Model-facing segment (without slashes) → physical root. */
    private readonly reservedRoots: ReadonlyMap<string, string>,
    /** Segments recognised as reserved, bound or not. */
    private readonly reservedSegments: ReadonlySet<string>,
  ) {
    const bindings: RootBinding[] = [
      { outer: MEMORIES_ROOT, inner: privateRoot },
    ];
    for (const [segment, root] of reservedRoots) {
      bindings.push({ outer: `${MEMORIES_ROOT}/${segment}`, inner: root });
    }
    this.bindings = bindings.sort((a, b) => b.inner.length - a.inner.length);
  }

  /** Model-facing `/memories/...` → physical path. */
  protected toInner(path: string): string {
    if (path === MEMORIES_ROOT) return this.privateRoot;
    if (!path.startsWith(`${MEMORIES_ROOT}/`)) return path; // not ours; leave it
    const rest = path.slice(MEMORIES_ROOT.length); // '/...'

    const seg = firstSegment(rest);
    if (this.reservedSegments.has(seg)) {
      const root = this.reservedRoots.get(seg);
      // Unbound reserved segment → leave it outside every compiled scope.
      if (root === undefined) return path;
      return `${root}${rest.slice(rest.indexOf(seg) + seg.length)}`;
    }

    if (isShared(rest)) return path; // shared namespace — passthrough
    return `${this.privateRoot}${rest}`;
  }

  /** Physical path → model-facing `/memories/...` (inverse of `toInner`). */
  protected toOuter(path: string): string {
    for (const binding of this.bindings) {
      if (path === binding.inner) return binding.outer;
      if (path.startsWith(`${binding.inner}/`)) {
        return `${binding.outer}${path.slice(binding.inner.length)}`;
      }
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

const NO_RESERVED_ROOTS: ReadonlyMap<string, string> = new Map();
const NO_RESERVED_SEGMENTS: ReadonlySet<string> = new Set<string>();

export class OrchestratorMemoryNamespacer extends MemoryNamespacerBase {
  constructor(agentSlug: string, inner: MemoryStore) {
    super(
      inner,
      `${MEMORIES_ROOT}/orchestrators/${agentSlug}`,
      NO_RESERVED_ROOTS,
      NO_RESERVED_SEGMENTS,
    );
  }
}

/**
 * Physical roots for one context-scoped turn. PLAIN STRINGS by design: the
 * axes → roots translation belongs to the `MemoryBinder`, so this mapper
 * carries no channel-SDK dependency and stays testable in isolation.
 */
export interface ContextMemoryNamespacerOptions {
  /**
   * Physical root the model's bare `/memories/...` maps to — the NARROWEST
   * tier of the turn, e.g. `/memories/contexts/<slug>/channel/<ctxKey>` or
   * `/memories/contexts/<slug>/user/<ctxKey>`. A context-FREE turn passes the
   * Agent tree (`/memories/orchestrators/<slug>`) here and then behaves
   * exactly like `OrchestratorMemoryNamespacer`.
   */
  readonly privateRoot: string;
  /**
   * Physical root of the team tier, e.g.
   * `/memories/contexts/<slug>/team/<teamKey>`. Omitted when the turn has no
   * team axis — `/memories/~team/...` is then left unmapped and the
   * `ScopedMemoryStore` denies it.
   */
  readonly teamRoot?: string;
  /**
   * Physical root of the Agent tier, i.e. `/memories/orchestrators/<slug>`.
   * Read-only from a context turn — enforced by the `ro:` pattern in the
   * `ScopedMemoryStore`, NOT by this mapper.
   */
  readonly agentRoot?: string;
}

/**
 * Context-scoped memory namespacer — the same bijection as
 * `OrchestratorMemoryNamespacer`, but with a per-CONTEXT private root plus two
 * reserved model-facing segments:
 *
 * ```
 * /memories/...        → <privateRoot>/...   (narrowest tier: channel | user)
 * /memories/~team/...  → <teamRoot>/...      (only when a team axis exists)
 * /memories/~agent/... → <agentRoot>/...     (read-only via the `ro:` pattern)
 * /memories/core/...   → unchanged           (shared passthrough)
 * /memories/_rules/... → unchanged           (shared passthrough)
 * ```
 *
 * `list` never leaks a physical `contexts/...` path outward: every entry is
 * mapped back through `toOuter`.
 *
 * A rewrite bug here yields a path outside the compiled scope, which the
 * `ScopedMemoryStore` turns into a `MemoryScopeViolation` — the backstop
 * guarantee of the layering is preserved.
 */
export class ContextMemoryNamespacer extends MemoryNamespacerBase {
  constructor(options: ContextMemoryNamespacerOptions, inner: MemoryStore) {
    const roots = new Map<string, string>();
    // A wider root identical to the private root would break the bijection
    // (two outer paths for one physical path) — the private root wins.
    if (options.teamRoot && options.teamRoot !== options.privateRoot) {
      roots.set(TEAM_SEGMENT, options.teamRoot);
    }
    if (options.agentRoot && options.agentRoot !== options.privateRoot) {
      roots.set(AGENT_SEGMENT, options.agentRoot);
    }
    super(
      inner,
      options.privateRoot,
      roots,
      new Set([TEAM_SEGMENT, AGENT_SEGMENT]),
    );
  }
}
