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
 *   - `team:<ctxKey>:*`      — matches `/memories/contexts/<agentSlug>/team/<ctxKey>/...`
 *   - `channel:<ctxKey>:*`   — matches `/memories/contexts/<agentSlug>/channel/<ctxKey>/...`
 *   - `user:<ctxKey>:*`      — matches `/memories/contexts/<agentSlug>/user/<ctxKey>/...`
 *   - `ro:<pattern>`         — access modifier: `<pattern>` grants read/list/exists
 *                              only; write/delete/rename throw `MemoryScopeViolation`.
 *   - `/memories/foo`        — exact path match.
 *   - `/memories/foo/*`      — prefix match (everything under `/memories/foo/`).
 *
 * Unknown patterns are conservative: they match nothing (deny by default)
 * and the constructor surfaces them as a warning so a typo in a manifest
 * shows up in the log without breaking the boot.
 *
 * ## Chat-context tiers (W5, design spec #870 §3)
 *
 * The three context tokens address a NEW top-level segment `/memories/contexts/`.
 * That placement is load-bearing: `orchestrator:<slug>:*` matches exclusively
 * `/memories/orchestrators/<slug>/...`, so no legacy agent scope can reach a
 * context tree and no context scope can reach the agent tree. `<ctxKey>` never
 * contains `:` (guaranteed by `memoryContextKey`), which is what keeps the
 * `team:<key>:*` regex unambiguous.
 *
 * `ro:` exists because a context turn must still READ the agent's pre-existing
 * notes (compat) while being unable to WRITE into them — otherwise "note this
 * globally" would be a permanent leak channel from team A into team B.
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
  /** `ro:`-modified patterns grant read/list/exists but never write. */
  readOnly: boolean;
}

/** The three chat-context tiers, in the order the design spec lists them. */
export const CONTEXT_AXES = Object.freeze(['team', 'channel', 'user'] as const);
export type ContextAxis = (typeof CONTEXT_AXES)[number];

/**
 * Physical root of one context tier for one Agent. Single source of truth for
 * both the pattern compiler here and the namespacer that rewrites into it.
 */
export function contextTierRoot(
  agentSlug: string,
  axis: ContextAxis,
  ctxKey: string,
): string {
  return `/memories/contexts/${agentSlug}/${axis}/${ctxKey}`;
}

/** `<axis>:<ctxKey>:*` — `<ctxKey>` may not contain `:` (see `memoryContextKey`). */
const CONTEXT_PATTERN = /^(team|channel|user):([^:]+):\*$/;

function prefixMatcher(root: string): (p: string) => boolean {
  const prefix = `${root}/`;
  return (p) => p === root || p.startsWith(prefix);
}

function compilePattern(
  pattern: string,
  agentSlug: string,
): CompiledPattern | undefined {
  // Access modifier — compile the inner pattern, then downgrade it to read-only.
  // Applied first so `ro:` composes with every token below, present and future.
  if (pattern.startsWith('ro:')) {
    const inner = compilePattern(pattern.slice('ro:'.length), agentSlug);
    if (!inner) return undefined;
    return { source: pattern, match: inner.match, readOnly: true };
  }
  const contextMatch = CONTEXT_PATTERN.exec(pattern);
  if (contextMatch) {
    const axis = contextMatch[1] as ContextAxis;
    const ctxKey = contextMatch[2]!;
    return {
      source: pattern,
      readOnly: false,
      match: prefixMatcher(contextTierRoot(agentSlug, axis, ctxKey)),
    };
  }
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
      match: prefixMatcher(`/memories/agents/${id}`),
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
      match: prefixMatcher(`/memories/orchestrators/${slug}`),
    };
  }
  if (pattern === 'session:*') {
    return {
      source: pattern,
      readOnly: false,
      match: prefixMatcher('/memories/sessions'),
    };
  }
  if (pattern.startsWith('/')) {
    if (pattern.endsWith('/*')) {
      return {
        source: pattern,
        readOnly: false,
        match: prefixMatcher(pattern.slice(0, -2)),
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

  /** Read/list/exists permission — `ro:` patterns count here. */
  private allowedRead(virtualPath: string): boolean {
    for (const p of this.patterns) if (p.match(virtualPath)) return true;
    return false;
  }

  /** Mutation permission — `ro:` patterns deliberately do NOT count here. */
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
    if (!this.allowedWrite(fromVirtualPath) || !this.allowedWrite(toVirtualPath)) {
      throw new MemoryScopeViolation(
        this.options.agentSlug,
        'rename',
        `${fromVirtualPath} -> ${toVirtualPath}`,
      );
    }
    return this.options.inner.rename(fromVirtualPath, toVirtualPath);
  }
}
