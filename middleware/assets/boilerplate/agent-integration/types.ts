/**
 * Strukturell-kompatibel zu middleware/src/platform/pluginContext.ts —
 * bewusst dupliziert, damit das Package OHNE Cross-Import standalone
 * kompiliert. Voraussetzung für den Zip-Upload-Flow: das Package darf
 * nichts außerhalb des eigenen Baums referenzieren.
 *
 * Bei Breaking Changes am Host-Interface: diese Datei in allen Packages
 * mitziehen — das ist Absicht, nicht Versehen (strukturelle Boundary).
 */

export interface PluginContext {
  readonly agentId: string;
  readonly secrets: {
    get(key: string): Promise<string | undefined>;
    require(key: string): Promise<string>;
    keys(): Promise<string[]>;
  };
  readonly config: {
    get<T = unknown>(key: string): T | undefined;
    require<T = unknown>(key: string): T;
  };
  /** Cross-plugin service registry. Used by `spec.external_reads` (Theme A)
   *  to consume typed surfaces from depends_on plugins (e.g.
   *  `ctx.services.get<OdooClient>('odoo.client')`). Hosted by
   *  `@omadia/plugin-api`'s `ServicesAccessor`. */
  readonly services: {
    get<T>(name: string): T | undefined;
    has(name: string): boolean;
    provide<T>(name: string, impl: T): () => void;
  };
  /** Express-router mount-point for plugin admin UIs and admin-API
   *  endpoints. `register(prefix, router)` queues a (prefix, router) pair
   *  with the kernel; the kernel mounts the router at `<prefix>` after
   *  activate() resolves and returns a dispose handle that the plugin's
   *  `close()` MUST invoke to symmetrically unmount on deactivate. See
   *  `boilerplate/agent-integration/CLAUDE.md` Baustein 2 for the
   *  Pflicht-Pattern (Express router + ctx.routes.register). In Preview
   *  this is a no-op stub that captures the registration but never
   *  serves traffic — the real mount happens at install-time. */
  readonly routes: {
    register(prefix: string, router: unknown): () => void;
  };
  /** B.12 — Plugin-served UI surface registry. Plugins call
   *  `ctx.uiRoutes.register({routeId, path, title})` to publish a
   *  clickable Dashboard-Tab (Teams Tab, Hub card, web link). The HTTP
   *  route itself is registered separately via `ctx.routes.register('/p/...', router)`;
   *  the descriptor just makes the surface discoverable in the Hub.
   *  Returns a dispose handle the plugin MUST call from `close()`. */
  readonly uiRoutes: {
    register(descriptor: UiRouteDescriptorInput): () => void;
  };
  /** HTTP client with manifest-enforced outbound allow-listing and
   *  per-plugin rate limiting (60 requests/min). Present iff the manifest
   *  declares `permissions.network.outbound` with at least one host. Calls
   *  to undeclared hosts throw `HttpForbiddenError`; rate-limit breaches
   *  throw `HttpRateLimitError`.
   *
   *  Prefer `ctx.http.fetch(url, init)` over the global `fetch` so the
   *  plugin stays future-proof — a hardening pass may block global fetch
   *  entirely for plugins. */
  readonly http?: HttpAccessor;

  /** Single-turn delegation to another agent registered in the host.
   *  Present iff the manifest declares `permissions.subAgents.calls` with
   *  at least one target agentId. Calls to non-whitelisted targets throw
   *  `SubAgentPermissionDeniedError`. Self-recursion (target === own
   *  agentId) throws `SubAgentRecursionError`. Per tool-handler invocation,
   *  a budget caps total calls (default 5). */
  readonly subAgent?: SubAgentAccessor;

  /** Namespaced knowledge-graph accessor. Present iff the manifest
   *  declares `permissions.graph.entity_systems` with at least one
   *  namespace string AND a `knowledgeGraph` provider is installed (e.g.
   *  `@omadia/knowledge-graph-inmemory` or `-neon`).
   *
   *  `ingestEntities` / `ingestFacts` validate the `system` field against
   *  the namespace whitelist — typo-protection for `'odoo'` vs `'odooo'`.
   *  Read methods (`searchTurns`, `findEntityCapturedTurns`, etc.) pass
   *  through unchanged. */
  readonly knowledgeGraph?: KnowledgeGraphAccessor;

  /** Host-LLM accessor. Present iff the manifest declares
   *  `permissions.llm.models_allowed` with at least one entry AND a
   *  `'llm'` provider is registered (host has `ANTHROPIC_API_KEY`).
   *
   *  Plugins use this for natural-language tasks (entity extraction,
   *  summarisation, rephrasing) without managing API keys themselves —
   *  the host pays. Model whitelist + per-invocation call-budget +
   *  per-call max-tokens-clamp are enforced by the manifest. */
  readonly llm?: LlmAccessor;

  /** Per-plugin memory store, scoped to `/memories/agents/<agentId>/`.
   *  All paths are RELATIVE — `notes.md` resolves to
   *  `/memories/agents/<agentId>/notes.md` under the hood. Plugins cannot
   *  read or write other plugins' memory (structural isolation).
   *
   *  Present when the manifest declares `permissions.memory.reads` OR
   *  `permissions.memory.writes` with at least one entry. The Builder
   *  boilerplate's `manifest.yaml` ships those entries pre-populated
   *  (`agent:{{AGENT_ID}}:*`), so this accessor is present at runtime for
   *  every Builder-emitted plugin — but always check `if (ctx.memory)`
   *  defensively so an operator-stripped manifest doesn't crash activate. */
  readonly memory?: MemoryAccessor;

  /** Register cron- or interval-scheduled background jobs. The kernel runs
   *  each job in isolation (per-job AbortController + timeoutMs) and stops
   *  every job belonging to a plugin on deactivate. Jobs declared in the
   *  manifest's `jobs:` block are auto-registered before `activate()` —
   *  programmatic registrations via this accessor are additive.
   *
   *  Always present; no permission gate. Use `register({ name, schedule:
   *  { cron: '0 8 * * MON' } | { intervalMs: 60_000 } }, handler)`. */
  readonly jobs: JobsAccessor;

  /** Theme D: true only when the kernel activated this plugin for a
   *  smoke probe. False during normal `activate()`. Plugins MAY branch
   *  on this to return mock data — most plugins ignore it. */
  readonly smokeMode: boolean;
  log(...args: unknown[]): void;
}

/**
 * Per-plugin memory store (mirror of `MemoryAccessor` from
 * `@omadia/plugin-api`). All paths are relative — the kernel pins the
 * accessor to the plugin's `/memories/agents/<agentId>/` subtree.
 */
export interface MemoryAccessor {
  readFile(relPath: string): Promise<string>;
  writeFile(relPath: string, content: string): Promise<void>;
  /** Create, fail-if-exists. Use when two concurrent writers must not race. */
  createFile(relPath: string, content: string): Promise<void>;
  delete(relPath: string): Promise<void>;
  list(relPath: string): Promise<readonly MemoryEntryInfo[]>;
  exists(relPath: string): Promise<boolean>;
}

export interface MemoryEntryInfo {
  /** Path relative to the plugin's scope — same shape callers pass in. */
  readonly relPath: string;
  readonly isDirectory: boolean;
  readonly sizeBytes: number;
}

/**
 * Schedule for a cron- or interval-driven background job. Pass to
 * `ctx.jobs.register({ name, schedule, ... }, handler)`. Cron uses croner
 * syntax (5- or 6-field, supports `*`, `,`, `-`, `/`, `L`, `MON`-`SUN`).
 */
export type JobSchedule =
  | { readonly cron: string }
  | { readonly intervalMs: number };

export interface JobSpec {
  /** Unique within the plugin — singleton-lock key. */
  readonly name: string;
  readonly schedule: JobSchedule;
  /** Per-run timeout. Default 30_000ms. */
  readonly timeoutMs?: number;
  /** What to do if a tick fires while the previous run is still in flight.
   *  `'skip'` (default) drops the late tick; `'queue'` enqueues exactly one. */
  readonly overlap?: 'skip' | 'queue';
}

/** Handler invoked on each scheduled tick. The supplied AbortSignal is
 *  aborted on plugin deactivate or when `timeoutMs` elapses — respect it
 *  by passing it to `fetch(...)` or checking `signal.aborted` between
 *  work units. Throwing is logged but does NOT cancel future ticks. */
export type JobHandler = (signal: AbortSignal) => Promise<void>;

export interface JobsAccessor {
  /** Register a job. Returns a dispose handle the plugin's `close()` MUST
   *  invoke — failing to dispose leaks the cron timer. Duplicate `name`
   *  within the same plugin throws. */
  register(spec: JobSpec, handler: JobHandler): () => void;
}

export interface UiRouteDescriptorInput {
  /** Stable id within the plugin (e.g. `'dashboard'`, `'inbox'`).
   *  Combined with pluginId to form the catalogue key. */
  readonly routeId: string;
  /** Path relative to the plugin's `/p/<pluginId>` mount (must start
   *  with `/`, e.g. `/dashboard`). */
  readonly path: string;
  /** Human-readable label shown in Hubs, dropdowns, and Tab titles. */
  readonly title: string;
  /** Optional one-line summary surfaced as a tooltip / card subtitle. */
  readonly description?: string;
  /** Optional ordering hint — lower comes first. Defaults to 100. */
  readonly order?: number;
}

// ---------------------------------------------------------------------------
// HTTP accessor (Phase B platform-parity)
// ---------------------------------------------------------------------------

/** Outbound-allowlisted fetch. Same shape as global `fetch`; unknown hosts
 *  throw `HttpForbiddenError`, rate-limit breaches throw `HttpRateLimitError`. */
export interface HttpAccessor {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

// ---------------------------------------------------------------------------
// Sub-agent delegation (Phase B platform-parity)
// ---------------------------------------------------------------------------

export interface SubAgentAccessor {
  /** Ask a registered agent a single question. Returns the final answer.
   *  Throws `SubAgentPermissionDeniedError` when target not in
   *  `permissions.subAgents.calls` whitelist;
   *  `SubAgentRecursionError` on self-call;
   *  `SubAgentBudgetExceededError` when per-tool-handler budget exhausted. */
  ask(targetAgentId: string, question: string): Promise<string>;

  /** True iff the target is currently registered in the host (no permission
   *  filter — use for introspection of what's installed). */
  has(targetAgentId: string): boolean;

  /** All reachable target agentIds (no permission filter). */
  list(): readonly string[];
}

// ---------------------------------------------------------------------------
// Host-LLM accessor (Phase B platform-parity)
// ---------------------------------------------------------------------------

export interface LlmCompleteRequest {
  /** Anthropic model id — MUST match `permissions.llm.models_allowed`. */
  readonly model: string;
  /** Optional system prompt forwarded verbatim. */
  readonly system?: string;
  /** Conversation messages. Plain strings only in v1. */
  readonly messages: ReadonlyArray<{
    readonly role: 'user' | 'assistant';
    readonly content: string;
  }>;
  /** Silently clamped to `permissions.llm.max_tokens_per_call` when
   *  the manifest sets a smaller cap. */
  readonly maxTokens?: number;
  readonly temperature?: number;
}

export interface LlmCompleteResult {
  readonly text: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly stopReason:
    | 'end_turn'
    | 'max_tokens'
    | 'stop_sequence'
    | 'tool_use';
}

export interface LlmAccessor {
  complete(req: LlmCompleteRequest): Promise<LlmCompleteResult>;
  /** Snapshot of the whitelist for plugin-side introspection. */
  readonly modelsAllowed: readonly string[];
}

// ---------------------------------------------------------------------------
// Knowledge-graph accessor (Phase B platform-parity)
// ---------------------------------------------------------------------------

/** Minimal entity-ingest shape — only the fields required by the kernel's
 *  validator. `system` MUST be in `permissions.graph.entity_systems` or
 *  ingestEntities throws `KgEntityNamespaceError`. Extras are free-form. */
export interface EntityIngest {
  readonly system: string;
  readonly model: string;
  readonly id: string;
  readonly displayName: string;
  readonly extras?: Readonly<Record<string, unknown>>;
}

export interface EntityIngestResult {
  readonly inserted: number;
  readonly updated: number;
  readonly skipped: number;
}

/** Atomic subject-predicate-object fact. `mentionedEntityIds` may reference
 *  entities owned by other systems (the KG tolerates dangling refs). */
export interface FactIngest {
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  readonly confidence?: number;
  readonly mentionedEntityIds?: readonly string[];
  readonly extras?: Readonly<Record<string, unknown>>;
}

export interface FactIngestResult {
  readonly inserted: number;
}

export interface KnowledgeGraphAccessor {
  /** Persist entities. `system` of each entry validated against the
   *  manifest's `entity_systems` whitelist. */
  ingestEntities(entities: EntityIngest[]): Promise<EntityIngestResult>;

  /** Persist atomic facts. No namespace check on the predicate strings. */
  ingestFacts(facts: FactIngest[]): Promise<FactIngestResult>;

  /** Read-only: full-text Turn search. Returns implementation-specific hits
   *  — the boilerplate keeps the row type opaque (`unknown`) to avoid
   *  pulling in the whole KG type surface from `@omadia/plugin-api`.
   *  Plugins that need the structured shape: `import type { TurnSearchHit }
   *  from '@omadia/plugin-api'` and add the package as a peerDep. */
  searchTurns(opts: Readonly<Record<string, unknown>>): Promise<readonly unknown[]>;

  /** Read-only: turns mentioning a given entity. */
  findEntityCapturedTurns(
    opts: Readonly<Record<string, unknown>>,
  ): Promise<readonly unknown[]>;

  /** Read-only: graph neighbours of a node. */
  getNeighbors(nodeId: string): Promise<readonly unknown[]>;

  /** Coarse counts for UI/sanity checks. */
  stats(): Promise<Readonly<Record<string, number>>>;

  /** Namespace whitelist passed at construction — useful for choosing a
   *  default `system` when there's only one. */
  readonly entitySystems: readonly string[];
}
