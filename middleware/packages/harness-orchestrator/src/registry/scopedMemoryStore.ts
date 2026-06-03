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
 *   - `/memories/foo`        — exact path match.
 *   - `/memories/foo/*`      — prefix match (everything under `/memories/foo/`).
 *
 * Unknown patterns are conservative: they match nothing (deny by default)
 * and the constructor surfaces them as a warning so a typo in a manifest
 * shows up in the log without breaking the boot.
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

interface CompiledPattern {
  match(path: string): boolean;
  source: string;
}

function compilePattern(pattern: string): CompiledPattern | undefined {
  if (pattern === 'core') {
    return {
      source: pattern,
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
    const prefix = `/memories/agents/${id}/`;
    return {
      source: pattern,
      match: (p) => p === prefix.slice(0, -1) || p.startsWith(prefix),
    };
  }
  // Per-orchestrator isolation (strict): an Agent's own private tree —
  // `/memories/orchestrators/<slug>/...` — covering both its model-level
  // notes and its per-plugin sub-trees (`.../plugins/<pluginId>/...`).
  const orchMatch = /^orchestrator:([^:]+):\*$/.exec(pattern);
  if (orchMatch) {
    const slug = orchMatch[1]!;
    const prefix = `/memories/orchestrators/${slug}/`;
    return {
      source: pattern,
      match: (p) => p === prefix.slice(0, -1) || p.startsWith(prefix),
    };
  }
  if (pattern === 'session:*') {
    const prefix = '/memories/sessions/';
    return {
      source: pattern,
      match: (p) => p === prefix.slice(0, -1) || p.startsWith(prefix),
    };
  }
  if (pattern.startsWith('/')) {
    if (pattern.endsWith('/*')) {
      const prefix = pattern.slice(0, -1);
      return {
        source: pattern,
        match: (p) => p === prefix.slice(0, -1) || p.startsWith(prefix),
      };
    }
    const exact = pattern;
    return {
      source: pattern,
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
      const c = compilePattern(raw);
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

  private allowed(virtualPath: string): boolean {
    for (const p of this.patterns) if (p.match(virtualPath)) return true;
    return false;
  }

  list(virtualPath: string): Promise<MemoryEntry[]> {
    if (!this.allowed(virtualPath)) {
      // Soft-deny — listing a directory the agent can't see returns empty
      // rather than throwing, so UI surfaces stay stable.
      return Promise.resolve([]);
    }
    return this.options.inner
      .list(virtualPath)
      .then((entries) => entries.filter((e) => this.allowed(e.virtualPath)));
  }

  fileExists(virtualPath: string): Promise<boolean> {
    if (!this.allowed(virtualPath)) return Promise.resolve(false);
    return this.options.inner.fileExists(virtualPath);
  }

  directoryExists(virtualPath: string): Promise<boolean> {
    if (!this.allowed(virtualPath)) return Promise.resolve(false);
    return this.options.inner.directoryExists(virtualPath);
  }

  async readFile(virtualPath: string): Promise<string> {
    if (!this.allowed(virtualPath)) {
      throw new MemoryScopeViolation(this.options.agentSlug, 'read', virtualPath);
    }
    return this.options.inner.readFile(virtualPath);
  }

  async createFile(virtualPath: string, content: string): Promise<void> {
    if (!this.allowed(virtualPath)) {
      throw new MemoryScopeViolation(this.options.agentSlug, 'write', virtualPath);
    }
    return this.options.inner.createFile(virtualPath, content);
  }

  async writeFile(virtualPath: string, content: string): Promise<void> {
    if (!this.allowed(virtualPath)) {
      throw new MemoryScopeViolation(this.options.agentSlug, 'write', virtualPath);
    }
    return this.options.inner.writeFile(virtualPath, content);
  }

  async delete(virtualPath: string): Promise<void> {
    if (!this.allowed(virtualPath)) {
      throw new MemoryScopeViolation(this.options.agentSlug, 'delete', virtualPath);
    }
    return this.options.inner.delete(virtualPath);
  }

  async rename(fromVirtualPath: string, toVirtualPath: string): Promise<void> {
    if (!this.allowed(fromVirtualPath) || !this.allowed(toVirtualPath)) {
      throw new MemoryScopeViolation(
        this.options.agentSlug,
        'rename',
        `${fromVirtualPath} -> ${toVirtualPath}`,
      );
    }
    return this.options.inner.rename(fromVirtualPath, toVirtualPath);
  }
}
