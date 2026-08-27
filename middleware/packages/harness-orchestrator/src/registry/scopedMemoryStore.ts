import type { MemoryEntry, MemoryStore } from '@omadia/plugin-api';

/**
 * `ScopedMemoryStore` (US8 / T034).
 *
 * Per-Agent wrapper around the kernel-owned `MemoryStore`. Every operation
 * is filtered by the Agent's effective memory scope (computed in T033):
 *
 *  - Paths inside the scope are forwarded to the underlying store unchanged.
 *  - Paths outside the scope cause read operations to "behave as if absent"
 *    (`fileExists` returns false, `list` filters the entry out) and write
 *    operations to throw `MemoryScopeViolation`.
 *
 * The read-degrades-soft / write-throws-hard split keeps user-facing
 * surfaces (list a directory, render a memory file) UI-stable when an
 * Agent loses a plugin: the entry vanishes for the Agent but the underlying
 * data is untouched — re-enabling the plugin makes it visible again
 * (matches SC-003: "removed-plugin entry persists but invisible").
 *
 * Scope pattern syntax:
 *
 *   - `core`                 — matches `/memories/core/...`, `/memories/sessions/...`,
 *                              `/memories/chat-sessions/...`, `/memories/_*\/...`
 *                              (the shared kernel namespaces).
 *   - `agent:<id>:*`         — matches `/memories/agents/<id>/...`.
 *   - `orchestrator:<slug>:*` — matches `/memories/orchestrators/<slug>/...`
 *                              (strict per-orchestrator isolation: the
 *                              Agent's own model-notes + its per-plugin
 *                              sub-trees under `.../plugins/<pluginId>/`).
 *   - `session:*`            — matches `/memories/sessions/...`.
 *   - `team:<ctxKey>:*`      — matches `/memories/contexts/<agentSlug>/team/<ctxKey>/...`.
 *   - `channel:<ctxKey>:*`   — matches `/memories/contexts/<agentSlug>/channel/<ctxKey>/...`.
 *   - `user:<ctxKey>:*`      — matches `/memories/contexts/<agentSlug>/user/<ctxKey>/...`.
 *   - `ro:<pattern>`         — access modifier: `<pattern>` counts for reads
 *                              (read / list / exists) only; write, delete and
 *                              rename against it raise `MemoryScopeViolation`.
 *   - `/memories/foo`        — exact path match.
 *   - `/memories/foo/*`      — prefix match (everything under `/memories/foo/`).
 *
 * Unknown patterns are conservative: they match nothing (deny by default)
 * and the constructor surfaces them as a warning so a typo in a manifest
 * shows up in the log without breaking the boot.
 *
 * Chat-context tiers (`team:` / `channel:` / `user:`) deliberately live under
 * the NEW top-level segment `/memories/contexts/` and NOT under
 * `/memories/orchestrators/<slug>/`: the already-compiled `orchestrator:<slug>:*`
 * pattern would otherwise match every context tree of that agent, so a
 * legacy agent scope would silently unlock all chat contexts. Keeping the
 * trees in disjoint top-level segments is what makes the two grammars
 * collision-free: no legacy scope reaches a context tree and no context
 * scope reaches the agent tree. Do not "tidy" the two trees together.
 *
 * `<ctxKey>` never contains `:` (guaranteed by the key derivation in the
 * channel SDK), which is what lets the token be parsed with a plain
 * `/^team:([^:]+):\*$/`-style regex.
 */

/**
 * The strict per-orchestrator memory scope for an Agent: its own private
 * orchestrator tree plus the shared `core` namespace. Single source of truth
 * used both by the registry (metadata / snapshot) and by
 * `buildOrchestratorForAgent` (the store that actually enforces it). Lives in
 * this leaf module so `buildOrchestrator` can import it without a cycle
 * through `registry/index`.
 */
export function orchestratorMemoryScope(agentSlug: string): readonly string[] {
  return ['core', `orchestrator:${agentSlug}:*`];
}

export class MemoryScopeViolation extends Error {
  readonly agentSlug: string;
  readonly virtualPath: string;
  readonly op: string;
  constructor(agentSlug: string, op: string, virtualPath: string) {
    super(
      `agent "${agentSlug}" is not permitted to ${op} "${virtualPath}" — path is outside the agent's memory scope`,
    );
    this.name = 'MemoryScopeViolation';
    this.agentSlug = agentSlug;
    this.virtualPath = virtualPath;
    this.op = op;
  }
}

const CORE_PREFIXES = [
  '/memories/core/',
  '/memories/sessions/',
  '/memories/chat-sessions/',
];

/** Access modifier prefix: `ro:<pattern>` — read/list/exists only. */
const READ_ONLY_PREFIX = 'ro:';

/** `team:<ctxKey>:*` / `channel:<ctxKey>:*` / `user:<ctxKey>:*`. */
const CONTEXT_TOKEN = /^(team|channel|user):([^:]+):\*$/;

/** Root of the chat-context trees — a top-level segment of its own. */
const CONTEXTS_ROOT = '/memories/contexts';

interface CompiledPattern {
  match(path: string): boolean;
  source: string;
  /** `true` for `ro:`-prefixed patterns — they grant reads but never writes. */
  readOnly: boolean;
}

/** Matches `prefix` itself (without its trailing slash) and everything below it. */
function prefixMatcher(prefix: string): (path: string) => boolean {
  const root = prefix.slice(0, -1);
  return (p) => p === root || p.startsWith(prefix);
}

function compilePattern(
  pattern: string,
  agentSlug: string,
): CompiledPattern | undefined {
  if (pattern.startsWith(READ_ONLY_PREFIX)) {
    // Single level only: `ro:ro:<x>` is not a pattern, it is a typo — falls
    // through to the unknown-pattern soft-deny below.
    const inner = compileAccessPattern(
      pattern.slice(READ_ONLY_PREFIX.length),
      agentSlug,
    );
    if (!inner) return undefined;
    return { source: pattern, match: inner.match, readOnly: true };
  }
  return compileAccessPattern(pattern, agentSlug);
}

function compileAccessPattern(
  pattern: string,
  agentSlug: string,
): CompiledPattern | undefined {
  if (pattern === 'core') {
    return {
      source: pattern,
      readOnly: false,
      match: (p) => {
        for (const pre of CORE_PREFIXES) {
          if (p === pre.slice(0, -1) || p.startsWith(pre)) return true;
        }
        // Allow top-level shared `_*` directories used by some plugins for
        // shared brand / convention files.
        if (/^\/memories\/_[^/]+(\/.*)?$/.test(p)) return true;
        return false;
      },
    };
  }
  const agentMatch = /^agent:([^:]+):\*$/.exec(pattern);
  if (agentMatch) {
    const id = agentMatch[1]!;
    return {
      source: pattern,
      readOnly: false,
      match: prefixMatcher(`/memories/agents/${id}/`),
    };
  }
  // Chat-context tiers — always relative to THIS agent's slug, so a context
  // key alone can never address another agent's tree.
  const ctxMatch = CONTEXT_TOKEN.exec(pattern);
  if (ctxMatch) {
    const axis = ctxMatch[1]!;
    const ctxKey = ctxMatch[2]!;
    return {
      source: pattern,
      readOnly: false,
      match: prefixMatcher(`${CONTEXTS_ROOT}/${agentSlug}/${axis}/${ctxKey}/`),
    };
  }
  // Per-orchestrator isolation (strict): an Agent's own private tree —
  // `/memories/orchestrators/<slug>/...` — covering both its model-level
  // notes and its per-plugin sub-trees (`.../plugins/<pluginId>/...`).
  const orchMatch = /^orchestrator:([^:]+):\*$/.exec(pattern);
  if (orchMatch) {
    const slug = orchMatch[1]!;
    return {
      source: pattern,
      readOnly: false,
      match: prefixMatcher(`/memories/orchestrators/${slug}/`),
    };
  }
  if (pattern === 'session:*') {
    return {
      source: pattern,
      readOnly: false,
      match: prefixMatcher('/memories/sessions/'),
    };
  }
  if (pattern.startsWith('/')) {
    if (pattern.endsWith('/*')) {
      return {
        source: pattern,
        readOnly: false,
        match: prefixMatcher(pattern.slice(0, -1)),
      };
    }
    const exact = pattern;
    return {
      source: pattern,
      readOnly: false,
      match: (p) => p === exact,
    };
  }
  // Unknown pattern — soft-deny (matches nothing) and surface to the caller.
  return undefined;
}

export interface ScopedMemoryStoreOptions {
  readonly agentSlug: string;
  readonly scope: readonly string[];
  readonly inner: MemoryStore;
  /** Warn on unknown patterns; never throws. */
  readonly log?: (msg: string, fields?: Record<string, unknown>) => void;
}

export class ScopedMemoryStore implements MemoryStore {
  private readonly patterns: readonly CompiledPattern[];

  constructor(private readonly options: ScopedMemoryStoreOptions) {
    const compiled: CompiledPattern[] = [];
    for (const raw of options.scope) {
      const c = compilePattern(raw, options.agentSlug);
      if (c) {
        compiled.push(c);
      } else {
        options.log?.(`scopedMemoryStore: unknown scope pattern — deny-default`, {
          agentSlug: options.agentSlug,
          pattern: raw,
        });
      }
    }
    this.patterns = compiled;
  }

  /**
   * Read access — every compiled pattern counts, `ro:` ones included.
   * Denial stays SOFT on the read paths that have a "not there" answer
   * (`list` filters, `*Exists` returns false); an explicit `readFile` still
   * throws so a caller cannot mistake a denial for an empty file.
   */
  private allowedRead(virtualPath: string): boolean {
    for (const p of this.patterns) if (p.match(virtualPath)) return true;
    return false;
  }

  /**
   * Write access — `ro:` patterns are skipped, so a path that is only
   * covered by a read-only pattern raises `MemoryScopeViolation` on
   * write / delete / rename. Denial is always HARD here.
   */
  private allowedWrite(virtualPath: string): boolean {
    for (const p of this.patterns) {
      if (!p.readOnly && p.match(virtualPath)) return true;
    }
    return false;
  }

  list(virtualPath: string): Promise<MemoryEntry[]> {
    if (!this.allowedRead(virtualPath)) {
      // Soft-deny — listing a directory the agent can't see returns empty
      // rather than throwing, so UI surfaces stay stable.
      return Promise.resolve([]);
    }
    return this.options.inner
      .list(virtualPath)
      .then((entries) => entries.filter((e) => this.allowedRead(e.virtualPath)));
  }

  fileExists(virtualPath: string): Promise<boolean> {
    if (!this.allowedRead(virtualPath)) return Promise.resolve(false);
    return this.options.inner.fileExists(virtualPath);
  }

  directoryExists(virtualPath: string): Promise<boolean> {
    if (!this.allowedRead(virtualPath)) return Promise.resolve(false);
    return this.options.inner.directoryExists(virtualPath);
  }

  async readFile(virtualPath: string): Promise<string> {
    if (!this.allowedRead(virtualPath)) {
      throw new MemoryScopeViolation(this.options.agentSlug, 'read', virtualPath);
    }
    return this.options.inner.readFile(virtualPath);
  }

  async createFile(virtualPath: string, content: string): Promise<void> {
    if (!this.allowedWrite(virtualPath)) {
      throw new MemoryScopeViolation(this.options.agentSlug, 'write', virtualPath);
    }
    return this.options.inner.createFile(virtualPath, content);
  }

  async writeFile(virtualPath: string, content: string): Promise<void> {
    if (!this.allowedWrite(virtualPath)) {
      throw new MemoryScopeViolation(this.options.agentSlug, 'write', virtualPath);
    }
    return this.options.inner.writeFile(virtualPath, content);
  }

  async delete(virtualPath: string): Promise<void> {
    if (!this.allowedWrite(virtualPath)) {
      throw new MemoryScopeViolation(this.options.agentSlug, 'delete', virtualPath);
    }
    return this.options.inner.delete(virtualPath);
  }

  async rename(fromVirtualPath: string, toVirtualPath: string): Promise<void> {
    if (
      !this.allowedWrite(fromVirtualPath) ||
      !this.allowedWrite(toVirtualPath)
    ) {
      throw new MemoryScopeViolation(
        this.options.agentSlug,
        'rename',
        `${fromVirtualPath} -> ${toVirtualPath}`,
      );
    }
    return this.options.inner.rename(fromVirtualPath, toVirtualPath);
  }
}
