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

/** The three context tiers a turn can reach (design #870 §2). */
export type MemoryAxis = 'team' | 'channel' | 'user';

/**
 * The memory axes a turn may reach, in the scope grammar of design #870 §3.
 *
 * **This is a structural mirror of `MemoryAxes` in `@omadia/channel-sdk`
 * (`src/turnOrigin.ts`), not a second definition of it.** The canonical type
 * and its only producer — `memoryAxesForOrigin` — belong to the channel SDK,
 * because the axes are derived from a `TurnOrigin` that only a channel adapter
 * can build. This module CONSUMES them.
 *
 * It is declared here rather than imported because the SDK-side contract lands
 * in a sibling change; TypeScript is structural, so the SDK's `MemoryAxes` is
 * assignable to this one and the swap is a one-line diff:
 *
 * ```ts
 * import type { MemoryAxes } from '@omadia/channel-sdk';
 * ```
 *
 * Keep the two shapes in lockstep until then — and note which way a drift
 * fails: an axis this module cannot recognise is dropped, never honoured
 * (see {@link effectiveMemoryScope}).
 */
export interface MemoryAxes {
  readonly isContextFree: boolean;
  /** Scope patterns in the §3 grammar, e.g. `['channel:teams~…:*', 'team:teams~…:*']`. */
  readonly patterns: readonly string[];
  /** Narrowest tier — drives the namespacer's `privateRoot`. */
  readonly narrowest?: { readonly axis: MemoryAxis; readonly ctxKey: string };
}

/**
 * How strictly a context turn is quarantined from the agent-global tree.
 *
 *  - `'enforce'` — the default. A context turn READS the agent tier
 *    (`ro:orchestrator:<slug>:*`) so existing knowledge stays quotable, but
 *    cannot write to it.
 *  - `'enforce-strict'` — design §10 Q3: full quarantine of legacy knowledge.
 *    A context turn cannot even read the agent tier.
 *
 * `'off'` is deliberately absent: it is a *routing* decision made one layer up
 * (the binder hands over the context-free axes and never calls this with a
 * mode), not a second fail-open branch inside the scope resolver.
 */
export type ContextMemoryEnforcement = 'enforce' | 'enforce-strict';

export interface EffectiveMemoryScopeOptions {
  /** Default `'enforce'`. */
  readonly mode?: ContextMemoryEnforcement;
  /** Structured warn-level sink. Never throws; see {@link effectiveMemoryScope}. */
  readonly log?: (msg: string, fields?: Record<string, unknown>) => void;
}

/**
 * The only patterns {@link effectiveMemoryScope} will accept from `MemoryAxes`.
 *
 * An allowlist rather than a passthrough, because `axes.patterns` crosses a
 * package boundary from an independently versioned channel plugin, and a
 * passthrough would make that boundary scope-granting: a plugin that emitted
 * `'core'`, `'orchestrator:<other-agent>:*'` or `'/memories/*'` would widen the
 * turn's scope instead of narrowing it. Everything outside the three context
 * tiers is dropped and logged.
 *
 * `[^:]+` on the key mirrors the tier patterns' own regexes and is what makes
 * `memoryContextKey`'s "never a `:` in a key" guarantee load-bearing here: a
 * key that smuggled a `:` in could otherwise re-parse as a different tier.
 */
const CONTEXT_AXIS_PATTERN = /^(?:team|channel|user):[^:]+:\*$/;

/**
 * The effective memory scope for one turn: the static agent scope intersected
 * with the dynamic context axes, fail-closed (design #870 §2, §4 step 7).
 *
 * ```
 * scope = axes.isContextFree
 *   ? ['core', `orchestrator:${slug}:*`]                      // exactly today
 *   : ['core', `ro:orchestrator:${slug}:*`, …axes.patterns]   // e.g. team:…, channel:…
 * ```
 *
 * Three properties are the whole point, and each fails in the safe direction:
 *
 *  1. **Fail-closed.** A missing `origin`, an `unscoped` scope, an unknown
 *     `channelType` — every one of them reaches this function as
 *     `isContextFree: true` and gets row 1 of the §2 table: byte-identical to
 *     what a turn does today, with NO context tree reachable. So does a
 *     context turn whose patterns are all unusable. The context-free branch
 *     delegates to {@link orchestratorMemoryScope} rather than re-spelling it,
 *     which is what keeps the golden comparison true by construction instead
 *     of by test.
 *  2. **The agent tier is read-only from context turns.** Without the `ro:`
 *     modifier, "note this globally" in team A would be a permanent leak
 *     channel into team B — the exact hole this design closes. New knowledge
 *     leaves a context only through the operator promote action.
 *  3. **Never a throw on the message path.** A malformed `axes` is a bug in a
 *     channel plugin, not a reason to drop a user's turn; it degrades to the
 *     agent-private scope and says so in the log. Never a throw, never a wider
 *     scope.
 *
 * Note what this function does NOT do: it decides no path, it only names
 * scopes. `ScopedMemoryStore` compiles the emitted tokens and stays the
 * backstop that turns a mapping bug into a `MemoryScopeViolation` rather than a
 * leak — including for a token it does not recognise, which it soft-denies.
 * That is also why emitting `ro:orchestrator:<slug>:*` before the grammar knows
 * `ro:` is safe: an unknown token matches nothing, so the interim behaviour is
 * *narrower* than the target, not wider.
 *
 * Pure and synchronous, so the security decision is testable as a table.
 */
export function effectiveMemoryScope(
  agentSlug: string,
  axes: MemoryAxes,
  options: EffectiveMemoryScopeOptions = {},
): readonly string[] {
  const strict = options.mode === 'enforce-strict';

  // `agentSlug` is interpolated into `orchestrator:<slug>:*`, whose compiled
  // regex is `[^:]+`. A slug carrying a `:` therefore produces a token that
  // matches nothing — fail-closed, and identical to how
  // `orchestratorMemoryScope` already behaves for such a slug.
  const contextFree = (reason: string): readonly string[] => {
    if (strict) {
      options.log?.(
        '[security-audit] effectiveMemoryScope: no resolvable turn context — agent-private scope',
        { agentSlug, reason, mode: 'enforce-strict' },
      );
    }
    return orchestratorMemoryScope(agentSlug);
  };

  // Defensive on the whole object: it crosses a plugin boundary, and a missing
  // one must not become a TypeError on the message path.
  if (axes === undefined || axes === null) return contextFree('axes-missing');
  if (axes.isContextFree !== false) {
    // Anything but an explicit `false` is treated as context-free, so a
    // half-built axes object cannot open a context tree by omission. Stray
    // patterns on a context-free axes are ignored by construction.
    return contextFree('context-free');
  }

  const patterns: string[] = [];
  const seen = new Set<string>();
  for (const raw of axes.patterns ?? []) {
    if (typeof raw !== 'string' || !CONTEXT_AXIS_PATTERN.test(raw)) {
      options.log?.('effectiveMemoryScope: dropping non-context axis pattern — deny-default', {
        agentSlug,
        pattern: raw,
      });
      continue;
    }
    if (seen.has(raw)) continue;
    seen.add(raw);
    patterns.push(raw);
  }

  // A context turn that named no usable tier is indistinguishable from one that
  // named no tier at all. Both take row 1.
  if (patterns.length === 0) return contextFree('no-usable-context-pattern');

  return strict
    ? ['core', ...patterns]
    : ['core', `ro:orchestrator:${agentSlug}:*`, ...patterns];
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
