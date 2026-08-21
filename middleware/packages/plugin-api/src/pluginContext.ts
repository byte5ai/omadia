/**
 * Plugin-facing contract for the @byte5/harness kernel.
 *
 * A PluginContext is the single, auditable surface through which a plugin's
 * code reaches platform-owned resources. Plugin code never imports the vault,
 * the registry, or the host config directly; it receives a ctx scoped to its
 * own identity and goes through ctx.* for everything.
 *
 * v1 (this file): secrets + config + log. Future additions (llm, memory,
 * graph, entities, fs.scratchDir, ...) land here as the runtime matures —
 * each one an additive change, not a breaking one.
 *
 * Invariant: ctx is scoped to exactly one plugin. The kernel's vault and
 * registry lookups are pinned to agentId. There is no API that lets a plugin
 * ask for another plugin's secrets — the boundary is structural.
 */

import type { Socket } from 'node:net';

import type { WriteCapability } from './writeCapabilities.js';

import type {
  EntityCapturedTurnsHit,
  EntityCapturedTurnsOptions,
  EntityIngest,
  EntityIngestResult,
  FactIngest,
  FactIngestResult,
  GraphNode,
  GraphStats,
  SearchTurnsOptions,
  TurnSearchHit,
} from './knowledgeGraph.js';

export interface PluginContext {
  readonly agentId: string;

  /**
   * OB-77 (Palaia Phase 8) — first-class plugin Domain.
   *
   * Manifest-declared (`identity.domain`) lowercase dotted identifier (e.g.
   * `confluence`, `odoo.hr`, `m365.calendar`). Required at the manifest
   * level; the loader auto-fallbacks to `unknown.<plugin-id>` with a warn
   * when a plugin ships without one. Plugins read it via `ctx.domain` to
   * inherit it onto every tool they register (`NativeToolSpec.domain`
   * overrides per-spec when a plugin contributes tools that semantically
   * span multiple domains — rare).
   *
   * Consumed by the Phase-8 Nudge-Pipeline's multi-domain trigger and by
   * the Operator Admin UI for cross-agent grouping. Future consumers
   * (OB-78 Agent-Profile, permission scopes) may build on the same field.
   *
   * Naming-Convention enforced via `PLUGIN_DOMAIN_REGEX`.
   */
  readonly domain: string;

  readonly secrets: SecretsAccessor;
  readonly config: ConfigAccessor;
  readonly services: ServicesAccessor;

  /** Epic #470 C7 / G4 — plugin-owned Postgres schema. Present ONLY when the
   *  manifest declares `permissions.sql` AND the operator granted it. A plugin
   *  that owns tables reaches them through the `graphPool` capability (also
   *  gated by the same permission); this accessor is the migration side of
   *  that — a shared, advisory-locked runner so eight plugins do not hand-roll
   *  eight racy ones. Guard with `if (ctx.sql)`: an older core, an undeclared
   *  permission and a withheld grant are all indistinguishable from the
   *  plugin's side, and all three mean "do not touch the database". */
  readonly sql?: SqlAccessor;

  /** True only when the kernel activated this plugin specifically for a
   *  smoke probe (Theme D — admin-route schema check). False during
   *  normal `activate()` calls. Plugins MAY branch on this to return
   *  mock data instead of hitting non-idempotent production APIs during
   *  the probe. Reading the flag is optional — most plugins ignore it. */
  readonly smokeMode: boolean;

  /** Per-plugin scratch directory. Present only when the manifest declares
   *  `filesystem.scratch: true`. Undefined otherwise — plugins that need
   *  temp files must declare the capability so the operator can see it in
   *  the permissions summary at install time. */
  readonly scratch?: ScratchDirAccessor;

  /** HTTP client with manifest-enforced outbound allow-listing and
   *  per-plugin rate limiting. Present when `permissions.network.outbound`
   *  declares at least one host. Undefined otherwise — plugins that don't
   *  declare network access should not reach the internet at all (global
   *  `fetch` is not blocked today, but will be in a future hardening pass;
   *  relying on ctx.http means the plugin stays future-proof). */
  readonly http?: HttpAccessor;

  /** Raw-TCP egress for line protocols `ctx.http` cannot speak (SMTP, IMAP,
   *  …). Present only when the manifest declares
   *  `permissions.network.outbound_tcp` and the referenced operator config
   *  resolves to a concrete host:port. Every `connect` is pinned to that
   *  exact allow-listed target. Undefined otherwise — guard with `if
   *  (ctx.net)` so a Hub plugin tolerates an older core that lacks it. */
  readonly net?: NetAccessor;

  /** Per-plugin memory store, scoped to `/memories/agents/<agentId>/`.
   *  Paths passed to this accessor are relative — `notes.md` resolves to
   *  `/memories/agents/<agentId>/notes.md` under the hood. Plugins cannot
   *  read or write other plugins' memory (structural isolation, not ACL).
   *  Present when the manifest declares `permissions.memory.reads` OR
   *  `permissions.memory.writes` with at least one entry; absent otherwise. */
  readonly memory?: MemoryAccessor;

  /** Contribute native tools to the orchestrator. A tool registered here
   *  appears in the system-prompt tool list, becomes dispatchable via
   *  Claude's tool-use flow, and can optionally produce per-turn attachments
   *  (e.g. image URLs for rich channel cards). */
  readonly tools: ToolsAccessor;

  /** Mount Express routers contributed by the plugin. Each registration
   *  gets a path prefix (e.g. `/diagrams`) and an opaque router instance;
   *  the kernel calls `app.use(prefix, router)` at mount time. Deactivate
   *  unmounts via the returned dispose handle. */
  readonly routes: RoutesAccessor;

  /** Cross-channel notification fan-out. Plugins emit outbound events
   *  via `notifications.send(...)`; channel plugins register handlers
   *  via `notifications.registerChannel(...)`. v1 broadcasts to every
   *  registered channel; per-user channel preference comes later. */
  readonly notifications: NotificationsAccessor;

  /** Plugin-served UI surface catalogue. Plugins register clickable
   *  surfaces (Teams Tabs, Hub cards) via `uiRoutes.register(...)`.
   *  channel-teams' Hub + Tab-Config consume the catalogue at request
   *  time, so new uploads surface automatically without code changes
   *  elsewhere. */
  readonly uiRoutes: UiRoutesAccessor;

  /** Register cron- or interval-scheduled background jobs. The kernel runs
   *  each job in isolation (per-job AbortController + timeout) and stops
   *  every job belonging to a plugin when the plugin deactivates. Jobs
   *  declared in the manifest's `jobs:` block are auto-registered before
   *  `activate()` returns control; programmatic registrations via this
   *  accessor coexist with them. */
  readonly jobs: JobsAccessor;

  /** US4 (Conductor Surface) — emit a domain event the plugin declared. Present iff the manifest
   *  declares `permissions.events.emit: true`. A plugin may only emit an event id it declared via an
   *  `{ id, event_emit: true }` capability (deny-by-default → `EventNotDeclaredError`). `emit` throws
   *  `ConductorUnavailableError` when no Conductor event router is registered in this host (e.g. the
   *  in-memory backend, or during boot before Conductor has wired) — presence of the accessor does
   *  NOT guarantee the router. A successful emit is routed to every subscribed Conductor workflow. */
  readonly events?: EventsAccessor;

  /** OB-29-1 — delegate a single-turn question to another agent registered
   *  in the host. Present iff the manifest declares
   *  `permissions.subAgents.calls` with at least one entry. Plugins without
   *  the permission see `ctx.subAgent === undefined`; runtime calls to
   *  agentIds outside the manifest whitelist throw
   *  `SubAgentPermissionDeniedError`. */
  readonly subAgent?: SubAgentAccessor;

  /** OB-29-2 — namespaced knowledge-graph accessor. Present iff the
   *  manifest declares `permissions.graph.entity_systems` with at least
   *  one namespace string AND a `knowledgeGraph` provider is registered.
   *  Wraps the underlying `KnowledgeGraph` service with namespace-
   *  validation: ingestEntities/ingestFacts calls whose `system` string
   *  isn't in the manifest declaration throw `KgEntityNamespaceError`.
   *  Read methods (searchTurns, findEntityCapturedTurns, getNeighbors)
   *  pass through unchanged. */
  readonly knowledgeGraph?: KnowledgeGraphAccessor;

  /** OB-29-3 — host-LLM accessor. Present iff the manifest declares
   *  `permissions.llm.models_allowed` with at least one entry AND a
   *  'llm' provider service is registered (host with ANTHROPIC_API_KEY).
   *  Wraps the host's Anthropic client with model-whitelist + per-
   *  invocation call-budget + max-tokens-clamp. Plugins use it for
   *  natural-language tasks (entity extraction, summarisation,
   *  rephrasing) without managing API keys themselves — the host pays. */
  readonly llm?: LlmAccessor;

  /** Epic #459 W5 (issue #458) — host-pooled MCP tool access. Present iff the
   *  manifest declares `permissions.mcp` AND the host wires an MCP service.
   *  Scoped to servers the operator has EXPLICITLY granted to this plugin —
   *  never ambient access to every registered server. Calls route through
   *  the host's shared connection pool, the scan-verdict dispatch guard, and
   *  the call audit log (attributed to this plugin). Guard with
   *  `if (ctx.mcp)` — a Hub plugin may land on an older core that lacks it. */
  readonly mcp?: McpAccessor;

  /** Spec 004 — redirect/callback flow toolkit. Present iff the manifest
   *  declares `permissions.flows: true`. Supplies the three things a plugin
   *  needs to run a credential-acquisition round-trip on its OWN route:
   *  the public callback URL (`publicUrl`), and a CSRF-safe, plugin-audience-
   *  bound state token (`signState`/`verifyState`). The signing key is held by
   *  the kernel and never reaches plugin code — a token signed for plugin A
   *  fails `verifyState` in plugin B. Used by the GitHub App-Manifest flow;
   *  re-usable by any future device/OAuth dance. Guard with `if (ctx.flows)` —
   *  a Hub plugin may land on an older core that lacks it. */
  readonly flows?: FlowsAccessor;

  /** Spec 005 — broker-acquired OAuth access tokens. Present iff the manifest
   *  declares a `type:oauth` setup field (resolved through an `oauth_providers`
   *  descriptor) AND the core ships the broker. `get(fieldKey)` returns a
   *  valid access token, refreshing under a 5-minute margin kernel-side; the
   *  refresh token never reaches plugin code. Guard with `if (ctx.oauthTokens)`
   *  — a Hub plugin may land on an older core without the broker. */
  readonly oauthTokens?: OAuthTokensAccessor;

  /** Issue #438 follow-up — kernel-published operator-session verifier. Present
   *  iff the host wires a session-verification backend into
   *  `createPluginContext` (production always does; older kernels or narrow
   *  test/migration contexts may not). Lets a plugin gate its OWN admin-only
   *  HTTP surface behind the SAME operator session cookie the kernel's own
   *  `requireAuth` middleware checks, WITHOUT re-implementing (and risking
   *  drifting from) that verification logic. Per {@link RoutesAccessor}'s doc
   *  comment the kernel does NOT inject auth middleware around a contributed
   *  router — a plugin whose admin surface needs operator-only access MUST
   *  check this itself, and MUST fail closed (refuse to serve, never silently
   *  mount unauthenticated) when it is undefined. Guard with `if
   *  (ctx.operatorAuth)`. */
  readonly operatorAuth?: OperatorAuthAccessor;

  /** Report an operator-facing action status (e.g. "not connected yet"). The
   *  kernel holds the latest value per plugin and the admin UI renders it as a
   *  badge on the plugin card + a banner on the detail page that clears when
   *  the plugin reports `ok`. Always present, ungated — a plugin reports only
   *  its OWN status. In-memory: re-report on `activate()` so it self-heals
   *  after a restart. */
  readonly status: StatusAccessor;

  log(...args: unknown[]): void;
}

/**
 * Spec for a background job a plugin contributes to the kernel scheduler.
 *
 * `name` MUST be unique within the plugin — it is the singleton-lock key.
 * The kernel does not collide-check across plugins (plugin-A's "sync" and
 * plugin-B's "sync" are different jobs) but does enforce uniqueness inside
 * one plugin's own registrations.
 *
 * `schedule` is either a 5- or 6-field cron expression (`"*\/5 * * * *"`,
 * croner syntax) or a fixed interval in milliseconds. Cron triggers are
 * timezone-agnostic — the kernel uses local server time today; an explicit
 * `tz` field can land later without breaking existing manifests.
 *
 * `timeoutMs` defaults to 30_000. A handler that runs longer is signalled
 * via the AbortSignal it received and the run is marked failed; the next
 * scheduled tick still fires.
 *
 * `overlap` controls what happens when a tick arrives while the previous
 * run is still in flight. `'skip'` (default) drops the late tick — typical
 * for idempotent sync jobs. `'queue'` enqueues exactly one run; further
 * ticks while still waiting fall back to skip. Higher fan-in is not
 * supported in v1.
 */
export interface JobSpec {
  readonly name: string;
  readonly schedule: JobSchedule;
  readonly timeoutMs?: number;
  readonly overlap?: 'skip' | 'queue';
}

export type JobSchedule = { readonly cron: string } | { readonly intervalMs: number };

/** Default per-run timeout when `JobSpec.timeoutMs` is omitted. */
export const JOB_DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Handler the kernel calls on every scheduled tick. The supplied
 * `AbortSignal` is aborted on plugin deactivate or when `timeoutMs`
 * elapses — long-running handlers must respect it (e.g. pass it to fetch
 * or check `signal.aborted` between work units). Throwing is logged but
 * does NOT cancel future ticks; if the operator wants the job stopped, they
 * deactivate the plugin.
 */
export type JobHandler = (signal: AbortSignal) => Promise<void>;

export interface JobsAccessor {
  /** Register a job. Returns a dispose handle the plugin's `close()` MUST
   *  invoke — failing to dispose leaks the cron timer. Jobs declared in
   *  the manifest's `jobs:` block are pre-registered; calling `register`
   *  with a duplicate `name` for the same plugin throws. */
  register(spec: JobSpec, handler: JobHandler): () => void;
}

export class JobValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobValidationError';
  }
}

export class JobAlreadyRegisteredError extends Error {
  constructor(agentId: string, name: string) {
    super(`plugin '${agentId}' already registered job '${name}'`);
    this.name = 'JobAlreadyRegisteredError';
  }
}

/** Outcome of emitting a domain event — how many Conductor workflows matched and started. */
export interface EmitResult {
  eventId: string;
  matchedWorkflows: number;
  startedRuns: Array<{ workflowSlug: string; runId: string }>;
}

export interface EventsAccessor {
  /** Emit a declared domain event with a JSON payload. Routes to every subscribed Conductor
   *  workflow (matched by event id + optional payload filter). Throws if the plugin did not
   *  declare `id` as an emittable event. */
  emit(id: string, payload: Record<string, unknown>): Promise<EmitResult>;
}

export class EventNotDeclaredError extends Error {
  constructor(agentId: string, eventId: string) {
    super(`plugin '${agentId}' did not declare event '${eventId}' (add an { id, event_emit: true } capability)`);
    this.name = 'EventNotDeclaredError';
  }
}

/** Thrown by `ctx.events.emit` when no Conductor event router is registered in this host — e.g. the
 *  in-memory backend, or before the Conductor subsystem has finished wiring. A typed error so plugins
 *  can detect "Conductor not available here" and degrade, rather than parsing a generic message. */
export class ConductorUnavailableError extends Error {
  constructor() {
    super('Conductor event router is not available in this host');
    this.name = 'ConductorUnavailableError';
  }
}

// ---------------------------------------------------------------------------
// Capabilities — manifest-declared contracts between plugins
// ---------------------------------------------------------------------------

/**
 * Capability system (manifest-only in v1).
 *
 * A capability is a versioned contract that one plugin `provides` and another
 * plugin `requires`. Before activation, the kernel checks every `requires`
 * has a matching `provides` — if not, boot fails with a clear error naming
 * the missing provider. Capability-names are ALSO used as service-registry
 * keys: a provider deklariert `provides: ["memory.kv@1"]` im Manifest and
 * calls `ctx.services.provide("memory.kv", impl)` at activate-time;
 * consumers reach the same impl via `ctx.services.get("memory.kv")`.
 *
 * v1 versioning is major-only: `"<name>@<major>"` for provides, optionally
 * `"<name>@^<major>"` for requires (the `^` is accepted but redundant — minor
 * /patch don't exist). A provider at major N matches any requires at major N.
 * This keeps the surface trivially dep-free; a later revision can introduce
 * proper semver when a real breakage case appears.
 *
 * Difference to `depends_on`:
 *   - `depends_on` names a SPECIFIC plugin id (`@omadia/memory`).
 *     Tight coupling — only that exact plugin satisfies the link.
 *   - `requires` names a CAPABILITY. Any provider that matches the name+major
 *     satisfies the link. Lets the memory layer be swapped (filesystem-impl
 *     vs. redis-impl) without touching consumers' manifests.
 */
export interface CapabilityRef {
  /** The capability name — used as both the manifest key and the
   *  service-registry lookup key. Example: `"memory.kv"`. */
  readonly name: string;
  /** Major version. In v1 a consumer at major N matches any provider at
   *  major N exactly. */
  readonly major: number;
}

export class CapabilityParseError extends Error {
  constructor(raw: string, detail: string) {
    super(`invalid capability string '${raw}': ${detail}`);
    this.name = 'CapabilityParseError';
  }
}

/**
 * Parse a capability string. Accepts both `<name>@<major>` and
 * `<name>@^<major>` — the `^` is optional and has the same semantics in v1.
 * Throws {@link CapabilityParseError} on malformed input.
 */
export function parseCapabilityRef(raw: string): CapabilityRef {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (trimmed.length === 0) {
    throw new CapabilityParseError(String(raw), 'empty capability string');
  }
  const at = trimmed.indexOf('@');
  if (at <= 0 || at === trimmed.length - 1) {
    throw new CapabilityParseError(
      trimmed,
      "must use '<name>@<major>' or '<name>@^<major>'",
    );
  }
  const name = trimmed.slice(0, at);
  let versionPart = trimmed.slice(at + 1);
  if (versionPart.startsWith('^')) versionPart = versionPart.slice(1);
  const major = Number(versionPart);
  if (!Number.isInteger(major) || major < 0) {
    throw new CapabilityParseError(
      trimmed,
      `major '${versionPart}' must be a non-negative integer`,
    );
  }
  return { name, major };
}

/** Same name + same major. */
export function capabilitiesMatch(
  provider: CapabilityRef,
  consumer: CapabilityRef,
): boolean {
  return provider.name === consumer.name && provider.major === consumer.major;
}

// ---------------------------------------------------------------------------
// Service resolution — the grant gate and per-caller attribution (epic #470 B1)
// ---------------------------------------------------------------------------

/**
 * Who is asking for a service. Every field is the **kernel-known** installed
 * plugin id — `createPluginContext` fills it from the id the kernel activated
 * the plugin under, never from an argument the caller supplies. A provider can
 * therefore trust it for attribution, scoping and per-tenant filtering.
 *
 * `agentId` and `pluginId` are the same value under two names: the kernel's
 * internal term is `agentId`, the manifest/registry term is `pluginId`. Both
 * are present so a provider can read whichever name its own domain uses
 * without a lookup table.
 */
export interface ServiceCaller {
  /** Kernel-known installed plugin id (kernel-internal name for it). */
  readonly agentId: string;
  /** The same kernel-known id under the manifest's name for it. */
  readonly pluginId: string;
}

/** Brand for {@link PerCallerFactory}. A unique symbol, so a plain value a
 *  plugin happens to register can never be mistaken for a factory — including
 *  a value that *is* a function, which is why the factory is wrapped in a
 *  branded object rather than detected by `typeof impl === 'function'`. */
const PER_CALLER_FACTORY = Symbol.for('@omadia/plugin-api.perCallerService');

/**
 * A service registration that mints one implementation **per consuming
 * plugin** instead of sharing a single instance.
 *
 * Build one with {@link perCallerService}; it is otherwise opaque. Resolution
 * is memoized by the FACTORY OBJECT and then by `caller.pluginId`, so one
 * provider instance is reused for repeat reads by the same consuming plugin,
 * while a re-registered provider starts cold automatically because it is a
 * different factory object.
 */
export interface PerCallerFactory<T> {
  readonly [PER_CALLER_FACTORY]: (caller: ServiceCaller) => T;
}

/**
 * Per-caller factory cache.
 *
 * Keying first on the wrapper object means a provider swap self-invalidates:
 * `ctx.services.replace(name, perCallerService(...))` registers a fresh object,
 * so the old cache becomes unreachable without any explicit lifecycle hook.
 * Keying second on `caller.pluginId` makes the contract literal: one
 * implementation per consuming plugin.
 */
const perCallerFactoryCache = new WeakMap<
  PerCallerFactory<unknown>,
  Map<string, unknown>
>();

/**
 * Wrap a factory so the kernel invokes it once per consuming plugin, handing
 * it the {@link ServiceCaller}. The factory must therefore be idempotent for a
 * given caller: repeat reads by the same plugin receive the cached result, not
 * a freshly constructed instance.
 *
 *   ctx.services.provide(
 *     'repoGrants',
 *     perCallerService((caller) => grantsScopedTo(caller.pluginId)),
 *   );
 *
 * Why this exists (epic #470 §2.2): before it, a provider that needed to know
 * which plugin was calling had exactly one option — take the id as an argument
 * from the consumer (`listGrantedRepoIds(myOwnPluginId)`). That is
 * self-attribution: the caller names itself, and nothing stops it naming
 * someone else. Routing attribution through the kernel closes that by
 * construction.
 *
 * Value providers are unaffected: `provide(name, impl)` with a plain value
 * keeps returning that exact value to every consumer.
 */
export function perCallerService<T>(
  factory: (caller: ServiceCaller) => T,
): PerCallerFactory<T> {
  return { [PER_CALLER_FACTORY]: factory };
}

/** Narrow an arbitrary registration to a per-caller factory. */
export function isPerCallerService<T = unknown>(
  value: unknown,
): value is PerCallerFactory<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<symbol, unknown>)[PER_CALLER_FACTORY] === 'function'
  );
}

/** Invoke a per-caller factory. Exported for the kernel's registry; plugins
 *  never need it — `ctx.services.get` already resolves the factory. */
export function resolvePerCallerService<T>(
  factory: PerCallerFactory<T>,
  caller: ServiceCaller,
): T {
  let byPlugin = perCallerFactoryCache.get(factory);
  if (!byPlugin) {
    byPlugin = new Map<string, unknown>();
    perCallerFactoryCache.set(factory, byPlugin);
  }
  if (byPlugin.has(caller.pluginId)) {
    return byPlugin.get(caller.pluginId) as T;
  }
  const resolved = factory[PER_CALLER_FACTORY](caller);
  byPlugin.set(caller.pluginId, resolved);
  return resolved;
}

/**
 * Thrown by `ctx.services.get(name)` when the plugin's manifest does not
 * declare `name` as a capability it `requires` (or `provides`).
 *
 * Typed so a plugin can distinguish "the operator has not installed a
 * provider" (`get` returns `undefined`) from "I forgot to declare this"
 * (this throw) — two very different bugs that used to look identical.
 */
export class ServiceNotDeclaredError extends Error {
  public readonly pluginId: string;
  public readonly capability: string;
  /** The manifest field that would grant it. */
  public readonly manifestField = 'requires';
  constructor(pluginId: string, capability: string) {
    super(
      `plugin '${pluginId}' called ctx.services.get('${capability}') but its manifest does not declare that capability — ` +
        `add '${capability}@<major>' to the manifest's \`requires:\` list (or \`optional_requires:\` when absence is survivable, ` +
        `or \`provides:\` if this plugin is the provider)`,
    );
    this.name = 'ServiceNotDeclaredError';
    this.pluginId = pluginId;
    this.capability = capability;
  }
}

/**
 * Accessor for plugin-bereitgestellte (plugin-provided) services.
 *
 * Difference from secrets/config: those are kernel-owned per-plugin resources.
 * Services come from OTHER plugins — e.g. `@omadia/knowledge-graph`
 * provides 'graph', 'bus', 'embeddings'. A consumer plugin accesses them
 * generically:
 *
 *   const graph = ctx.services.get<GraphAccessor>('graph');
 *   if (!graph) { // provider not installed — handle gracefully }
 *
 * **`get` is manifest-gated (epic #470 B1).** The service-registry key IS the
 * capability name, so a plugin may only resolve names it declared in its
 * manifest's `requires:` (or `provides:`, for reading back its own
 * registration). An undeclared name throws {@link ServiceNotDeclaredError}
 * instead of handing over the implementation. Before this gate any installed
 * plugin could ask for any service — including `graphPool`, the same Postgres
 * pool core uses — with no manifest declaration and nothing in the install
 * dialog.
 *
 * `has` stays ungated: it answers a yes/no existence question and hands over
 * no capability, so gating it would only turn feature-probing into
 * exception-handling.
 *
 * Well-known service names and their accessor interfaces are documented
 * alongside the providing plugin. Plugins that depend on a specific service
 * should declare the provider in their manifest's `depends_on` so the
 * installer can enforce ordering.
 */
export interface ServicesAccessor {
  /** Returns the registered provider for the given service, or undefined
   *  if no provider is installed.
   *
   *  Throws {@link ServiceNotDeclaredError} when this plugin's manifest does
   *  not declare `name` — that is a manifest bug, not a missing provider, and
   *  the two must not be reported the same way. */
  get<T>(name: string): T | undefined;
  /**
   * Resolve a capability the plugin declared as OPTIONAL
   * (`optional_requires:` in the manifest), where "no provider installed"
   * is a supported steady state rather than a misconfiguration.
   *
   * Declaration-gated on exactly the same terms as {@link get}: a name in
   * neither `requires:`, `optional_requires:` nor `provides:` throws
   * {@link ServiceNotDeclaredError}, because a typo must not silently
   * become `undefined`.
   *
   * The difference from {@link get} is the contract it advertises, not the
   * lookup. `get` is paired with `requires:`, which the installer and the
   * boot loop both treat as a hard prerequisite — so a `get` that returns
   * `undefined` normally means something upstream failed. `getOptional` is
   * paired with `optional_requires:`, which neither gate enforces, so
   * `undefined` here is an expected answer and the caller is expected to
   * carry a degradation path for it.
   *
   * Note the ordering caveat that comes with optionality: an optional
   * dependency contributes no activation edge, so a provider that IS
   * installed may not have activated yet when the consumer's `activate()`
   * runs. Resolve optional services lazily (at first use) rather than
   * caching the result of a single call during activation.
   */
  getOptional<T>(name: string): T | undefined;
  /** Whether a provider is currently registered. Ungated — see the interface
   *  doc. */
  has(name: string): boolean;
  /** Register THIS plugin as the provider for the given service name.
   *  Returns a dispose handle — the plugin's `close()` MUST invoke it to
   *  symmetrically unregister the service on deactivate. Throws on
   *  duplicate-provider (two plugins cannot both claim the same name; the
   *  operator must uninstall one).
   *
   *  `impl` is normally the shared implementation every consumer receives.
   *  Wrap it in {@link perCallerService} instead to mint one implementation
   *  per consuming plugin, with the kernel-known caller id supplied by the
   *  kernel. */
  provide<T>(name: string, impl: T | PerCallerFactory<T>): () => void;
  /**
   * OB-71 (palaia capture-pipeline): wrap an already-registered provider
   * with a decorator. The previous provider stays live behind the wrapper;
   * the dispose handle restores it on plugin deactivate. Throws if no
   * provider exists yet — use `provide` for the first registration.
   *
   * Intentionally privileged: only call when this plugin is the canonical
   * decorator for the named capability (e.g. `harness-orchestrator-extras`
   * wrapping `knowledgeGraph` with the capture-filter). Treat the swap as
   * a coordinated handoff, not a competing provider.
   *
   * Accepts a {@link perCallerService} wrapper on the same terms as
   * `provide`.
   */
  replace<T>(name: string, impl: T | PerCallerFactory<T>): () => void;
}

/**
 * Native-tool specification in the shape Anthropic's Messages API accepts.
 * Plugins emit this when they register a top-level orchestrator tool via
 * `ctx.tools.register(...)`. The kernel is responsible for feeding the spec
 * into the system-prompt tool list and for routing `tool_use` events with
 * a matching `name` to the plugin's handler.
 */
export interface NativeToolSpec {
  readonly name: string;
  readonly description: string;
  readonly input_schema: {
    readonly type: 'object';
    readonly properties: Record<string, unknown>;
    readonly required?: readonly string[];
  };
  /**
   * OB-77 (Palaia Phase 8) — per-spec Domain override.
   *
   * Optional. When omitted, the kernel inherits `ctx.domain` (the plugin's
   * manifest-declared domain) at registration time. Set explicitly only
   * when a plugin contributes tools spanning multiple semantic domains
   * (rare). Same naming convention as `ctx.domain` —
   * `PLUGIN_DOMAIN_REGEX`.
   */
  readonly domain?: string;
}
// NOTE (Omadia UI): a tool's `writeCapabilities` annotation is deliberately NOT
// a field on `NativeToolSpec` — the whole spec is sent verbatim into the
// Anthropic tools list (`buildToolsList`), and Anthropic's tool-spec contract
// rejects unknown fields (same reason `piiFields` lives on the LocalSubAgentTool
// wrapper, not on its spec). The `WriteCapability` contract + the deterministic
// `deriveMutabilityCapabilities` derivation live in `./writeCapabilities.ts`;
// their attachment to a non-model-facing carrier (manifest annotation /
// registration metadata) is wired with the first consumer (PR-9).

/**
 * OB-77 (Palaia Phase 8) — Naming-Convention für Plugin-Domains.
 *
 * Lowercase, dotted hierarchy. Each segment may contain alphanumerics +
 * single hyphens (kebab-case mid-segment), but cannot start or end with a
 * hyphen and cannot contain `--`. Erlaubte Beispiele: `confluence`,
 * `odoo`, `odoo.hr`, `core.knowledge-graph`, `quality.response-guard`,
 * `m365.calendar`, `infra.unifi.devices`. Hierarchy ist vorerst
 * informativ — die Phase-8-Pipeline behandelt jeden String als opake
 * Domain (Hierarchy-Auswertung kommt mit OB-78).
 */
export const PLUGIN_DOMAIN_REGEX =
  /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)*$/;

/**
 * Validation helper for domain strings — used by the manifest loader and
 * by tests that exercise the contract. Returns the validated domain or a
 * structured error so callers can decide between fail-fast and warn-fallback.
 */
export function validatePluginDomain(
  value: unknown,
): { ok: true; domain: string } | { ok: false; message: string } {
  if (typeof value !== 'string') {
    return { ok: false, message: 'domain must be a string' };
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { ok: false, message: 'domain must not be empty' };
  }
  if (!PLUGIN_DOMAIN_REGEX.test(trimmed)) {
    return {
      ok: false,
      message: `domain "${trimmed}" must match ${String(PLUGIN_DOMAIN_REGEX)} (lowercase, dotted hierarchy)`,
    };
  }
  return { ok: true, domain: trimmed };
}

/** Handler a plugin hands the kernel together with the tool spec. Must return
 *  a string — the tool-use reply sent back to Claude. Kernel wraps thrown
 *  errors into `Error: <message>` for symmetry with built-in tools. */
export type NativeToolHandler = (input: unknown) => Promise<string>;

/**
 * Optional per-turn attachment sink. Called once at the end of each orchestrator
 * turn so the plugin can return any media (image URLs, cards, …) produced during
 * this turn and clear its internal buffer. The kernel forwards the returned
 * attachments to the channel adapter for inline rendering (Teams cards, web UI,
 * etc.). Return `undefined` if the tool did not fire during this turn — that's
 * the common case and MUST be cheap.
 */
export type NativeToolAttachmentSink = () =>
  | NativeToolAttachment[]
  | undefined;

/** Opaque attachment payload. The shape is kernel-internal; channel adapters
 *  downcast to their own richer types. Kept as `unknown` on the plugin-API
 *  surface so a new attachment kind can land without breaking the type. */
export interface NativeToolAttachment {
  readonly kind: string;
  readonly payload: unknown;
}

/**
 * Contributes a tool to the orchestrator. Returns a dispose handle that
 * unregisters the tool — callers who get one at `activate()`-time MUST
 * invoke it at `close()`-time so deactivation really removes the tool
 * from the system-prompt and dispatch table.
 */
export interface ToolsAccessor {
  register(
    spec: NativeToolSpec,
    handler: NativeToolHandler,
    options?: ToolRegistrationOptions,
  ): () => void;
  /** Register a handler for a tool whose spec the kernel emits itself
   *  (e.g. the Anthropic-native `memory_20250818` tool, whose wire shape is
   *  `{type, name}` rather than `{name, description, input_schema}`).
   *  Dispatch still routes `tool_use` events named `name` through this
   *  handler; prompt-list emission stays kernel-owned. Returns a dispose
   *  handle the plugin's `close()` MUST invoke. */
  registerHandler(
    name: string,
    handler: NativeToolHandler,
    options?: ToolRegistrationOptions,
  ): () => void;
  /** Invoke a registered native tool OUTSIDE the orchestrator turn loop.
   *  Powers the deterministic canvas refresh (omadia-ui#5): a recorded
   *  source query is re-executed with no LLM in the seat. Resolves to the
   *  handler's string result; rejects when the tool is unknown or was
   *  registered without a handler. NOTE: this bypasses the per-turn
   *  dispatch hooks (privacy guard, telemetry) — callers replay only
   *  inputs a real turn of the same user already executed. Optional so
   *  narrow test contexts need not implement it. */
  invoke?(name: string, input: unknown): Promise<string>;
}

export interface ToolRegistrationOptions {
  /** System-prompt documentation block for this tool. The kernel splices it
   *  into the tool-list section of the system prompt verbatim, prefixed by
   *  a bullet. Keep it to one paragraph (≈4–8 sentences). */
  readonly promptDoc?: string;
  /** Per-turn attachment collector. See NativeToolAttachmentSink docs. */
  readonly attachmentSink?: NativeToolAttachmentSink;
  /**
   * #542 prerequisite — declare that dispatching this tool may MUTATE data.
   *
   * This is the plugin-facing end of the `WriteCapability` contract in
   * `./writeCapabilities.ts` (see the NOTE under `NativeToolSpec` for why it
   * rides the options bag rather than the spec: the spec is forwarded verbatim
   * to Anthropic, which rejects unknown fields). The kernel stores it on the
   * registry entry, where `ToolDispatchService` reads it.
   *
   * Declaring it opts the tool into duplicate-write protection: a dispatch that
   * carries an idempotency key is deduplicated, and the MCP transport's
   * transient retry is suppressed for it (a retry cannot tell "failed before
   * writing" from "wrote, then lost the response"). A tool that mutates data and
   * omits this gets no such protection — for an Odoo or M365 write reachable from
   * a public endpoint, that means a duplicate is possible.
   */
  readonly writeCapabilities?: readonly WriteCapability[];
}

/**
 * Epic #470 C6 / G2 — how a contributed route is authenticated.
 *
 *  - `'session'` — **the default**. The kernel composes the same operator
 *    session gate core mounts at `/api`, per route. Under `/api` that is
 *    defence-in-depth (the blanket gate already ran); outside `/api`
 *    (`/diagrams`, `/documents`, `/p/…`) it is the only session gate there is.
 *    CSRF posture is core's own: a `SameSite=Lax` session cookie, no token
 *    layer — a browser never attaches the session to a cross-site request.
 *  - `'public'` — no kernel authentication. Registration THROWS unless the
 *    prefix lies beneath a path this plugin declared in
 *    `permissions.public_paths`. Whether it is actually served without a
 *    session additionally requires operator consent (epic #470 C4/H1).
 *  - `'custom'` — same registration constraint as `'public'`; the plugin
 *    asserts it authenticates every request itself. A webhook verifying an
 *    HMAC over `req.rawBody` is the canonical case.
 *
 * There is deliberately no `'none'`: a plugin cannot self-declare its way out
 * of authentication, only ask the operator for a prefix and be granted it.
 */
export type RouteAuthMode = 'session' | 'public' | 'custom';

/**
 * Epic #470 C6 / G3 — how the request body reaches the contributed router.
 *
 *  - `'json'` — **the default**. Parsed JSON at core's own limit (10 MB).
 *  - `'raw'` — untouched bytes as a `Buffer`, on BOTH `req.body` and
 *    `req.rawBody`, at a 512 KB default limit. The kernel parses these ahead
 *    of its global JSON parser, so the bytes an HMAC is computed over are the
 *    bytes that arrived. Do NOT re-serialise `req.body` to verify a signature.
 *  - `'none'` — the kernel mounts no parser for this route; the plugin owns the
 *    stream (uploads, proxying, streaming responses). It does NOT disable the
 *    kernel's global JSON parser: an `application/json` request has still been
 *    read upstream. Use `'raw'` when you need the bytes as they arrived.
 */
export type RouteBodyMode = 'json' | 'raw' | 'none';

export interface RouteRegisterOptions {
  /** Default `'session'`. See {@link RouteAuthMode}. */
  readonly auth?: RouteAuthMode;
  /** Default `'json'`. See {@link RouteBodyMode}. */
  readonly body?: RouteBodyMode;
  /** Express body-parser limit string (`'1mb'`, `'512kb'`). Defaults to 10 MB
   *  for `'json'` and 512 KB for `'raw'`. Ignored for `'none'`.
   *
   *  Only `'raw'` gives it a real effect. Raw bodies are captured before the
   *  kernel's global parser (they have to be), which is also before the session
   *  gate — so raising it raises how much an ANONYMOUS caller can make the
   *  kernel buffer. State a bigger number only when the payload needs it.
   *
   *  On `'json'` the kernel's global 10 MB parser has already run, so a larger
   *  value here cannot raise the effective ceiling. */
  readonly bodyLimit?: string;
}

/**
 * Contributes an Express router to the kernel. The kernel mounts it at the
 * given prefix via `app.use(prefix, router)`.
 *
 * Since epic #470 C6 the kernel DOES inject middleware around the contributed
 * router, in a fixed order:
 *
 *     [deactivation guard] → [auth] → [body parser] → your router
 *
 * The deactivation guard is first, so a deactivated plugin's prefix stops
 * existing before any authentication or body buffering happens. CORS and rate
 * limiting remain the plugin's responsibility.
 */
export interface RoutesAccessor {
  register(
    prefix: string,
    router: unknown,
    options?: RouteRegisterOptions,
  ): () => void;
}

/**
 * Spec 004 — toolkit for plugins that run a redirect/callback flow on their
 * own route (`permissions.flows: true`). The kernel owns the public-URL
 * topology and the state-signing key; the plugin owns its route handler and
 * the provider-specific logic (what to POST, how to parse the response).
 *
 * Threat model: the state token is the CSRF guard for the whole round-trip.
 * The kernel auto-binds its audience to the calling plugin id, so a token
 * minted by (or for) one plugin cannot be replayed against another's
 * callback. The HS512 signing key is kernel-held; `signState`/`verifyState`
 * close over it without ever exposing it.
 */
export interface FlowsAccessor {
  /**
   * Resolve the browser-facing absolute URL for one of this plugin's own
   * routes — the value to hand an external IdP as a `redirect_url`.
   *
   * Mirrors how the store-detail page reaches a plugin's admin UI: the
   * plugin's route is mounted on the middleware under `/api/<…>`, and the
   * browser reaches it through the `/bot-api/*` → `/api/*` proxy. So a route
   * registered at prefix `/api/github` with `relPath = 'flow/callback'`
   * resolves to `{FLOW_PUBLIC_BASE_URL}/bot-api/github/flow/callback`.
   *
   * The prefix is the plugin's sole registered route prefix; when the plugin
   * registered several, pass `opts.prefix` to disambiguate. `relPath` is
   * relative (a leading slash is tolerated). Throws if no route is registered
   * yet (register the route before calling) or if the prefix is ambiguous.
   */
  publicUrl(relPath: string, opts?: { prefix?: string }): string;
  /**
   * Sign arbitrary claims into a short-lived (10-min default) HS512 state
   * token. The kernel sets `iss=omadia`, `aud=plugin:<thisPluginId>`, and the
   * issued-at/expiry — the plugin only supplies its own claims (e.g. a nonce,
   * a return path). Use the result as the `state` query-param of the flow.
   */
  signState(
    claims: Record<string, unknown>,
    opts?: { ttl?: string },
  ): Promise<string>;
  /**
   * Verify a state token returned on the callback. Rejects (throws) a token
   * whose signature is invalid, whose `aud` is not this plugin, or whose TTL
   * has expired. Returns the decoded claims (including the standard `iss`,
   * `aud`, `iat`, `exp`) on success.
   */
  verifyState(token: string): Promise<Record<string, unknown>>;
}

/**
 * Normalized, operator-facing health of a plugin. `ok` = nothing to do;
 * `needs_action` = a required setup/connection step is pending (rendered as an
 * amber badge + banner with a call-to-action toward the plugin's admin UI);
 * `error` = misconfigured/failing (red). The kernel maps these to the UI;
 * `title`/`detail` let the plugin phrase the specifics ("Nicht verbunden" /
 * "Erstelle die GitHub App in der Admin-UI").
 */
export type PluginActionState = 'ok' | 'needs_action' | 'error';

export interface PluginActionStatus {
  readonly state: PluginActionState;
  /** Short label for the badge/banner (e.g. "Nicht verbunden"). */
  readonly title?: string;
  /** One-line detail / next step (e.g. "Verbindung in der Admin-UI herstellen"). */
  readonly detail?: string;
  /**
   * ISO timestamp of when this status was reported — STAMPED BY THE KERNEL at
   * `report()` time, never trusted from the plugin, so "geprüft um <Zeit>"
   * cannot lie about when the check actually ran. Field-test follow-up
   * (OM-16/24/33): a connection verdict without a time reads as a permanent
   * fact; with one it reads as what it is — the result of the last probe.
   */
  readonly checked_at?: string;
}

/**
 * Push-based status reporter. A plugin calls `report(...)` whenever its
 * operator-facing state changes (typically from its discovery/health check),
 * and `clear()` once everything is fine. The kernel keeps only the latest
 * value per plugin; there is no history. Reporting another plugin's status is
 * impossible — the accessor is bound to the calling plugin's id.
 *
 * `state: 'ok'` semantics: a BARE ok (no `title`) is equivalent to `clear()`
 * and renders nothing — existing callers keep their behaviour. An ok WITH a
 * `title` (e.g. "Verbunden") is stored and rendered as a positive badge with
 * the kernel-stamped `checked_at`, so an integration can surface "connection
 * verified at <time>" instead of silence.
 */
export interface StatusAccessor {
  report(status: PluginActionStatus): void;
  clear(): void;
}

/**
 * Spec 005 — read-side of the kernel OAuth broker. `get(fieldKey)` returns a
 * currently-valid access token for the named `type:oauth` connection,
 * transparently refreshing it within a 5-minute expiry margin. The kernel runs
 * the refresh, rotates the stored refresh token, and returns only the access
 * token — the refresh token NEVER reaches plugin code.
 *
 * Throws an {@link OAuthTokenError}: `not_connected` when no token is stored
 * (the operator hasn't completed Connect), `refresh_failed` when a refresh was
 * rejected (credential revoked → operator must re-connect).
 */
export interface OAuthTokensAccessor {
  get(fieldKey: string): Promise<string>;
}

export type OAuthTokenErrorCode = 'not_connected' | 'refresh_failed';

/**
 * Issue #438 follow-up — kernel-published operator-session verifier (see the
 * `PluginContext.operatorAuth` doc comment for the full contract). The kernel
 * implementation reuses the EXACT SAME verification logic as its own
 * `requireAuth` middleware — same cookie name, same signing key, same
 * Entra-whitelist rule — so there is exactly one code path that decides
 * session validity, never two that can drift apart. Deliberately decoupled
 * from Express (this package never imports express types, see
 * {@link RoutesAccessor}): the caller hands over the raw `Cookie` header
 * string, not a `Request`.
 */
export interface OperatorAuthAccessor {
  /**
   * Resolves `true` iff the raw `Cookie` request header carries a currently
   * valid operator session. Never throws — a missing header, a malformed
   * cookie, an expired/invalid session token, or (for Entra-issued sessions)
   * an email that fell off the admin whitelist all resolve `false`.
   */
  hasValidSession(cookieHeader: string | undefined): Promise<boolean>;
}

export class OAuthTokenError extends Error {
  readonly code: OAuthTokenErrorCode;
  constructor(code: OAuthTokenErrorCode, message: string) {
    super(message);
    this.name = 'OAuthTokenError';
    this.code = code;
  }
}

/**
 * Plugin-served UI surface registry. Plugins call
 * `uiRoutes.register({routeId, path, title})` from their `activate()`
 * to publish a clickable surface (Teams Tab, Hub card, web link).
 * The kernel auto-fills `pluginId` from the calling plugin's agentId
 * so plugins can't spoof other plugins' surfaces.
 *
 * The descriptor catalogue is the source of truth for downstream
 * surfaces — channel-teams' Hub iterates it for cards, and Tab-Config
 * queries it for the target-route dropdown. The HTTP route itself is
 * registered separately via `ctx.routes.register('/p/...', router)`;
 * the descriptor just makes the surface discoverable.
 */
export interface UiRoutesAccessor {
  /**
   * Publish a uiRoute descriptor. Returns a dispose handle the plugin
   * MUST call from its `close()` so a hot-swap doesn't leak entries
   * into the catalogue.
   */
  register(descriptor: UiRouteDescriptorInput): () => void;

  /**
   * Publish a top-level navigation entry for the operator web UI.
   *
   * This is deliberately separate from `register()`: a uiRoute
   * descriptor addresses a plugin-served surface *relative to* the
   * plugin's `/p/<pluginId>` mount, whereas a nav entry addresses an
   * absolute in-app route. A plugin whose UI ships as compiled
   * web-ui pages (a built-in package) has a nav entry and no uiRoute;
   * a plugin serving its own HTML has both.
   *
   * Supply either a literal `href` (validated as a canonical in-app path)
   * or `pluginUi: true`, which asks the kernel to render the canonical
   * path to this plugin's own bundled UI — the only way a scoped plugin
   * id can express a nav destination, since that path must be
   * percent-encoded and a literal href may not be.
   *
   * Returns a dispose handle the plugin MUST call from its `close()`.
   * The kernel additionally drops every entry by source on deactivate,
   * so a leaked handle cannot outlive the plugin.
   */
  registerNav(entry: UiNavEntryInput): () => void;
}

export interface UiRouteDescriptorInput {
  /** Stable id within the plugin (e.g. `'dashboard'`, `'absences'`).
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

/**
 * Catalogue-resolved descriptor — pluginId injected by the kernel from
 * the registering plugin's agentId.
 */
export interface UiRouteDescriptor extends UiRouteDescriptorInput {
  readonly pluginId: string;
}

/**
 * A navigation entry contributed by a plugin to the operator web UI.
 *
 * Labels are plugin-owned and localized here rather than in web-ui's
 * `messages/*.json`, because the shell cannot know a third-party
 * plugin's strings at build time. The kernel resolves the label for
 * the requested locale before it ever reaches the browser, so the UI
 * never has to merge a second message catalogue at runtime.
 */
export interface UiNavEntryInput {
  /** Stable id within the plugin. Combined with pluginId as the key. */
  readonly navId: string;
  /**
   * Absolute in-app path (e.g. `/admin/reports`). Must start with exactly
   * one `/` — protocol-relative (`//host`) and scheme-bearing values are
   * rejected so a manifest cannot point the nav off-origin. Segments are
   * confined to the RFC 3986 unreserved set: no query, no fragment, no
   * percent-encoding, no dot-segments.
   *
   * Mutually exclusive with {@link pluginUi}; exactly one of the two must
   * be supplied.
   */
  readonly href?: string;
  /**
   * Point the entry at THIS plugin's own bundled UI instead of a literal
   * path, and let the kernel spell the URL.
   *
   * A plugin that ships a compiled SPA is served at `/p/<pluginId>/ui/`
   * and embedded by the shell's host page at `/plugin-ui/<pluginId>`. For
   * a scoped id like `@acme/widget` the only URL that resolves is the
   * percent-encoded one (`%40acme%2Fwidget`) — and percent-encoding is
   * exactly what the `href` validator refuses, deliberately, because a
   * literal href has to be comparable to a core path by string equality.
   *
   * So the plugin states the intent and the kernel renders the canonical
   * encoded path from the id it already knows. A plugin never hand-builds
   * an encoded href, and the literal-href rule stays strict.
   */
  readonly pluginUi?: true;
  /**
   * Optional cluster to nest under (e.g. `adminCluster`). Rendered as a
   * top-level entry when omitted, or when the shell has no cluster by
   * that key.
   */
  readonly cluster?: string;
  /** Ordering hint within the cluster — lower comes first. Default 100. */
  readonly order?: number;
  /**
   * Locale code → label. An `en` entry is required as the fallback for
   * locales the plugin does not translate.
   */
  readonly label: Readonly<Record<string, string>>;
}

/**
 * Catalogue-resolved nav entry — `pluginId` injected by the kernel, and
 * `href` no longer optional: a `pluginUi: true` input is resolved to the
 * canonical host-page path at registration, so every stored entry carries
 * a concrete destination.
 */
export interface UiNavEntry extends Omit<UiNavEntryInput, 'href'> {
  readonly pluginId: string;
  readonly href: string;
}

/**
 * A nav entry flattened for one locale. This is the shape the HTTP
 * surface returns and the web UI consumes; `label` is already resolved,
 * so no locale negotiation happens in the browser.
 */
export interface ResolvedUiNavEntry {
  readonly pluginId: string;
  readonly navId: string;
  readonly href: string;
  readonly cluster?: string;
  readonly order: number;
  readonly label: string;
  /**
   * Present iff the entry was registered with `pluginUi: true`. The shell
   * uses it to re-derive `href` from `pluginId` locally instead of
   * trusting the transmitted string — the middleware is a separate
   * deployable, and a percent-encoded href is the one shape the shell's
   * own defensive href rule cannot check character by character.
   */
  readonly pluginUi?: true;
}

/**
 * Cross-channel notifications. Plugins emit outbound events through
 * `send()`; channel plugins register inbound handlers via
 * `registerChannel()`. The router fans every emitted event out to every
 * registered channel — v1 broadcast model. Per-user channel preference
 * routing lands in a later slice.
 */
export interface NotificationsAccessor {
  /**
   * Dispatch a notification to all registered channel handlers. The
   * pluginId is auto-injected from the caller's PluginContext; plugins
   * MUST NOT set it themselves.
   *
   * Returns a per-channel dispatch result so callers can surface partial
   * failures. The accessor itself never throws on handler errors — a
   * crashing channel handler must not break the calling plugin's flow.
   */
  send(payload: NotificationPayload): Promise<NotificationDispatchResult>;

  /**
   * Channel plugins register an inbound handler keyed by channelId
   * (e.g. `'teams'`, `'telegram'`). Returns a dispose handle the channel
   * MUST call from its `close()` so a hot-swap doesn't leak handlers.
   * Re-registering the same channelId without disposing first throws.
   */
  registerChannel(
    channelId: string,
    handler: ChannelNotificationHandler,
  ): () => void;
}

export interface NotificationPayload {
  readonly title: string;
  readonly body: string;
  /**
   * Optional relative path users land on when they activate the
   * notification. Channel handlers resolve it against the operator-facing
   * web-ui origin (Teams deep-link, Telegram start-param, etc.).
   */
  readonly deepLink?: string;
  /**
   * v1 supports `'broadcast'` only — each channel handler decides what
   * 'broadcast' means in its world (Teams: activity feed for tenant
   * members; Telegram: pinned chat post; etc.). v2 will accept a
   * concrete list of user IDs for targeted delivery.
   */
  readonly recipients?: 'broadcast' | readonly string[];
}

export interface NotificationDispatchResult {
  /** channelIds whose handler completed without throwing. */
  readonly delivered: readonly string[];
  /** channelIds whose handler threw, with the error message. */
  readonly failed: readonly { readonly channelId: string; readonly error: string }[];
  /** Whether the router has any registered handlers. False here means
   *  the notification went nowhere — plugins MAY surface this to the
   *  operator. */
  readonly anyHandlerPresent: boolean;
}

export type ChannelNotificationHandler = (
  payload: ResolvedNotificationPayload,
) => Promise<void>;

/**
 * Payload as it lands inside a channel handler — the kernel has filled
 * in `pluginId` from the emitting plugin and normalised `recipients`.
 */
export interface ResolvedNotificationPayload {
  readonly pluginId: string;
  readonly title: string;
  readonly body: string;
  readonly deepLink?: string;
  readonly recipients: 'broadcast' | readonly string[];
}

/**
 * Accessor for a per-plugin scratch directory. The kernel guarantees:
 *   - The directory is isolated to the plugin (no other plugin sees it).
 *   - The path is stable across invocations within one activation (restarts
 *     or re-installs may allocate a fresh directory).
 *   - The directory is created lazily on first `path()` call.
 *   - Cleanup on deactivate/uninstall is best-effort (the operator may see
 *     leftover entries on crash or aborted uninstall — plugins must not
 *     depend on cleanup for correctness).
 *
 * The kernel does NOT enforce a size quota in v1. Plugins that write large
 * files are responsible for their own cleanup. A future accessor revision
 * may add `sizeBytes()` / `reserve(bytes)` APIs.
 */
export interface ScratchDirAccessor {
  /** Absolute path to the scratch directory. Creates it on first call. */
  path(): Promise<string>;
}

/**
 * HTTP accessor — a thin wrapper around global `fetch` that enforces the
 * outbound allow-list declared in the plugin's manifest and applies a
 * per-plugin rate limit.
 *
 * Allow-list matching (v1):
 *   - Exact hostname: `api.example.com` matches only `api.example.com`
 *   - Leading-wildcard: `*.example.com` matches any single-level subdomain
 *     like `api.example.com` but NOT `example.com` itself
 *   - Port is ignored — a manifest entry for `api.example.com` permits both
 *     :80 and :443. Port-specific allow-listing is reserved for a later
 *     hardening pass.
 *
 * Rate-limit (v1): simple token bucket, 60 requests per rolling minute.
 * Violations throw `HttpRateLimitError`. Per-plugin config override lands
 * in a future revision alongside `permissions.network.rate_limit`.
 *
 * Errors: unknown-host requests throw `HttpForbiddenError`. Network /
 * transport failures surface as whatever fetch itself throws.
 */
export interface HttpAccessor {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

export class HttpForbiddenError extends Error {
  constructor(agentId: string, host: string) {
    super(
      `plugin '${agentId}' is not permitted to reach '${host}' — missing from permissions.network.outbound`,
    );
    this.name = 'HttpForbiddenError';
  }
}

export class HttpRateLimitError extends Error {
  constructor(agentId: string) {
    super(`plugin '${agentId}' exceeded its per-minute HTTP request budget`);
    this.name = 'HttpRateLimitError';
  }
}

/**
 * Raw outbound TCP connection options for `ctx.net.connect`.
 *
 * Unlike `ctx.http` (HTTP/HTTPS only), `ctx.net` opens a raw TCP — or, with
 * `tls: true`, an implicitly-encrypted — socket to a host:port the operator
 * configured. It exists for line protocols the HTTP accessor cannot speak:
 * SMTP/IMAP/POP3 and the like. The target is gated against
 * `permissions.network.outbound_tcp` (see `NetAccessor`).
 */
export interface NetConnectOptions {
  readonly host: string;
  readonly port: number;
  /**
   * When true the kernel performs the TLS handshake and resolves with an
   * already-encrypted socket (implicit TLS — e.g. SMTPS on :465). When false
   * or omitted a plain TCP socket is returned and the caller may upgrade it
   * itself (e.g. SMTP STARTTLS on :587, which nodemailer negotiates over the
   * plain socket). Either way the connection only reaches the allow-listed
   * host:port.
   */
  readonly tls?: boolean;
  /** TLS SNI servername; defaults to `host`. Ignored when `tls` is falsy. */
  readonly servername?: string;
}

/**
 * Raw-TCP egress accessor. Present only when the manifest declares
 * `permissions.network.outbound_tcp` with at least one target the plugin's
 * config resolves to a concrete host:port. Every `connect` is gated against
 * that resolved allow-list (exact host + port match) and a per-minute
 * connection budget — an unlisted target throws `NetForbiddenError`, an
 * over-budget caller `NetRateLimitError`.
 *
 * The allow-list is resolved from operator config, NOT static manifest
 * hostnames: a generic mail plugin does not know the SMTP host at authoring
 * time, so the manifest references config fields (`host: "$config.smtp_host"`)
 * and the kernel pins egress to exactly what the operator entered. That also
 * means an internal relay on a private IP is reachable — the operator chose
 * it — without opening a general SSRF hole.
 */
export interface NetAccessor {
  connect(options: NetConnectOptions): Promise<Socket>;
}

export class NetForbiddenError extends Error {
  constructor(agentId: string, target: string) {
    super(
      `plugin '${agentId}' is not permitted to open a TCP connection to '${target}' — missing from permissions.network.outbound_tcp (or its config-referenced host/port is unset)`,
    );
    this.name = 'NetForbiddenError';
  }
}

export class NetRateLimitError extends Error {
  constructor(agentId: string) {
    super(`plugin '${agentId}' exceeded its per-minute TCP connection budget`);
    this.name = 'NetRateLimitError';
  }
}

/**
 * Memory accessor — per-plugin filesystem-backed key-value-ish store.
 *
 * All paths are RELATIVE to the plugin's own scope. Absolute paths, `..`
 * segments, and null bytes are rejected. The kernel transparently prepends
 * `/memories/agents/<agentId>/` to every call, so a plugin writing
 * `notes/today.md` stores data at `/memories/agents/<agentId>/notes/today.md`
 * on the host's memory store.
 *
 * Scope isolation is structural, not permission-based: the accessor literally
 * has no way to reach another plugin's path. A future revision may add an
 * opt-in shared-space concept (e.g. `ctx.memory.shared('public')`) once the
 * KG / shared-knowledge extraction lands.
 */
export interface MemoryAccessor {
  /** Read a file. Throws on missing path or if the path is a directory. */
  readFile(relPath: string): Promise<string>;
  /** Create-or-overwrite. Intermediate directories are created as needed. */
  writeFile(relPath: string, content: string): Promise<void>;
  /** Create, fail-if-exists. Use when two concurrent writers must not race. */
  createFile(relPath: string, content: string): Promise<void>;
  /** Remove a file or directory (recursive). */
  delete(relPath: string): Promise<void>;
  /** List immediate entries under `relPath`. */
  list(relPath: string): Promise<readonly MemoryEntryInfo[]>;
  /** True if the path resolves to an existing file OR directory. */
  exists(relPath: string): Promise<boolean>;
}

export interface MemoryEntryInfo {
  /** Path relative to the plugin's scope — the same shape callers pass in. */
  readonly relPath: string;
  readonly isDirectory: boolean;
  readonly sizeBytes: number;
}

export class MemoryPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryPathError';
  }
}

/**
 * Host-side memory store contract. The unscoped, root-level interface that
 * a memory-provider plugin (e.g. `@omadia/memory`) implements and
 * publishes into the kernel's ServiceRegistry under the well-known name
 * `memoryStore`. All paths passed in are absolute virtual paths starting
 * with `/memories/...`; the backend maps them into its own namespace
 * (filesystem, Postgres, …).
 *
 * Plugin code does NOT receive a `MemoryStore` directly — it receives the
 * scoped `MemoryAccessor` above, which the kernel constructs from a
 * `MemoryStore` pinned to the plugin's `/memories/agents/<agentId>/`
 * subtree. The `MemoryStore` contract lives on the plugin-api surface
 * because it is a cross-plugin service boundary: the memory-provider
 * plugin emits it, downstream plugins (via `ctx.services.get('memoryStore')`)
 * and kernel glue (chat-session store, graph backfill, admin router)
 * consume it. Keeping the interface here means neither side has to
 * depend on the provider plugin's package directly.
 */
export interface MemoryStore {
  /** List entries (files + directories) up to 2 levels deep under `virtualPath`. */
  list(virtualPath: string): Promise<MemoryEntry[]>;
  /** Check whether a file exists at `virtualPath`. Directories return `false`. */
  fileExists(virtualPath: string): Promise<boolean>;
  /** Check whether a directory exists at `virtualPath`. */
  directoryExists(virtualPath: string): Promise<boolean>;
  /** Read a file's full content. Throws if missing or if it's a directory. */
  readFile(virtualPath: string): Promise<string>;
  /** Create a file with content. Throws if it already exists. */
  createFile(virtualPath: string, content: string): Promise<void>;
  /** Overwrite a file's content (used by str_replace/insert). */
  writeFile(virtualPath: string, content: string): Promise<void>;
  /** Delete a file or directory (recursive). */
  delete(virtualPath: string): Promise<void>;
  /** Rename/move a file or directory. */
  rename(fromVirtualPath: string, toVirtualPath: string): Promise<void>;
}

export interface MemoryEntry {
  virtualPath: string;
  isDirectory: boolean;
  sizeBytes: number;
}

export interface SecretsAccessor {
  /** Returns the secret, or undefined if not present. */
  get(key: string): Promise<string | undefined>;
  /** Returns the secret, or throws a MissingSecretError. */
  require(key: string): Promise<string>;
  /** Keys present in the vault for this plugin. Never returns values. */
  keys(): Promise<string[]>;
  /** Spec 004 — create or overwrite a secret in THIS plugin's namespace.
   *  Present only when the manifest declares `permissions.secrets.runtime_write`
   *  (otherwise `undefined`). Used by runtime credential-acquisition flows to
   *  persist an acquired secret (e.g. a GitHub App private key). Cannot reach
   *  another plugin's namespace. Guard with `if (ctx.secrets.set)`. */
  set?(key: string, value: string): Promise<void>;
  /** Spec 004 — remove a secret from this plugin's namespace. No-op if absent.
   *  Present only with `permissions.secrets.runtime_write`. */
  delete?(key: string): Promise<void>;
}

/**
 * Write-capable secrets accessor. The kernel only hands this out inside an
 * `onMigrate` hook — normal plugin code receives the read-only `SecretsAccessor`.
 * Scope is the same (per-plugin namespace); a migration cannot reach other
 * plugins' secrets.
 */
export interface SecretsReadWriteAccessor extends SecretsAccessor {
  /** Create or overwrite a secret. */
  set(key: string, value: string): Promise<void>;
  /** Remove a secret. No-op if absent. */
  delete(key: string): Promise<void>;
}

export interface ConfigAccessor {
  /** Returns the config value, or undefined if not present. */
  get<T = unknown>(key: string): T | undefined;
  /** Returns the config value, or throws a MissingConfigError. */
  require<T = unknown>(key: string): T;
  /** Spec 004 — persist a NON-secret config value to this plugin's own
   *  installed-registry config. The key MUST be a declared, non-secret setup
   *  field (secrets go through `secrets.set`). Present only when the manifest
   *  declares `permissions.secrets.runtime_write`. Guard with
   *  `if (ctx.config.set)`. */
  set?(key: string, value: unknown): Promise<void>;
}

// ---------------------------------------------------------------------------
// Sub-agent delegation (OB-29-1) — `ctx.subAgent.ask(targetAgentId, q)`.
// ---------------------------------------------------------------------------

/**
 * Accessor for delegating a single-turn natural-language question to another
 * agent registered in the host. Resolves the target via the kernel's service
 * registry (each agent's `DomainTool` is published as `subAgent:<agentId>`)
 * and runs the wrapped `LocalSubAgent.ask()` to completion.
 *
 * Lifetime: one `ask()` call is a complete sub-agent run from question to
 * final-text. There is no persistent session between calls — each call
 * constructs a fresh messages-array on the sub-agent side.
 *
 * Permission model (v1, opt-in):
 *   - Manifest must declare `permissions.subAgents.calls: ['<agentId>', ...]`
 *     (wildcards allowed: `'de.byte5.agent.*'`).
 *   - `ctx.subAgent` is `undefined` when the manifest entry is missing or
 *     empty.
 *   - At runtime, each `ask()` checks the resolved targetAgentId against
 *     the whitelist; mismatches throw `SubAgentPermissionDeniedError`.
 *   - Self-recursion (target === own agentId) throws
 *     `SubAgentRecursionError`. Indirect cycles (A→B→A) are not detected
 *     here in v1; LocalSubAgent.maxIterations is the backstop.
 *   - Per tool-handler invocation, a budget caps the number of calls
 *     (default 5, override via `permissions.subAgents.calls_per_invocation`).
 *     Exceeding it throws `SubAgentBudgetExceededError`.
 */
export interface SubAgentAccessor {
  /**
   * Ask the named agent a question. Returns the final answer string.
   *
   * @param targetAgentId The full agent id, e.g. `'@omadia/agent-seo-analyst'`.
   * @param question Natural-language question. Forwarded as the first user
   *   message to the sub-agent.
   * @throws {UnknownSubAgentError} no such agent registered in the host
   * @throws {SubAgentPermissionDeniedError} target not in manifest whitelist
   * @throws {SubAgentRecursionError} target === own agentId
   * @throws {SubAgentBudgetExceededError} per-invocation call budget exhausted
   */
  ask(targetAgentId: string, question: string): Promise<string>;

  /** Whether a given target agent is currently reachable (registered in
   *  the kernel's service registry). Permission filter is NOT applied —
   *  use this to introspect what's installed. */
  has(targetAgentId: string): boolean;

  /** Snapshot of every reachable target agentId (no permission filter). */
  list(): readonly string[];
}

export class UnknownSubAgentError extends Error {
  constructor(callerAgentId: string, targetAgentId: string) {
    super(
      `plugin '${callerAgentId}' tried to call unknown sub-agent '${targetAgentId}' — no such agent registered`,
    );
    this.name = 'UnknownSubAgentError';
  }
}

export class SubAgentPermissionDeniedError extends Error {
  constructor(callerAgentId: string, targetAgentId: string) {
    super(
      `plugin '${callerAgentId}' is not permitted to call sub-agent '${targetAgentId}' — add it to manifest's permissions.subAgents.calls whitelist`,
    );
    this.name = 'SubAgentPermissionDeniedError';
  }
}

export class SubAgentRecursionError extends Error {
  constructor(agentId: string) {
    super(
      `plugin '${agentId}' tried to call itself via subAgent.ask — direct self-recursion is rejected`,
    );
    this.name = 'SubAgentRecursionError';
  }
}

export class SubAgentBudgetExceededError extends Error {
  constructor(callerAgentId: string, budget: number) {
    super(
      `plugin '${callerAgentId}' exceeded its per-tool-handler subAgent.ask budget of ${budget} call(s) — raise via manifest permissions.subAgents.calls_per_invocation`,
    );
    this.name = 'SubAgentBudgetExceededError';
  }
}

// ---------------------------------------------------------------------------
// Knowledge-graph delegation (OB-29-2) — `ctx.knowledgeGraph.ingestEntities`.
// ---------------------------------------------------------------------------

/**
 * Plugin-facing knowledge-graph accessor. Wraps the host's `knowledgeGraph`
 * service with namespace-validation on writes, and exposes a curated subset
 * of read methods. Plugins MUST declare their custom system namespaces in
 * `manifest.permissions.graph.entity_systems` to enable writes; the builtin
 * systems `'odoo'` and `'confluence'` are reserved for the host integrations
 * and rejected for plugin-side ingest even if listed.
 *
 * Why a wrapper?
 *   1. Auditable: ops can inspect every plugin's declared entity_systems
 *      without grepping plugin source.
 *   2. Defensive: a plugin bug that constructs `system: 'odoo'` (e.g. typo,
 *      copy-paste) cannot silently corrupt the Odoo namespace.
 *   3. Symmetric: parallels `SubAgentAccessor` (whitelist + permission
 *      errors) and `MemoryAccessor` (scope-isolation).
 *
 * Read methods (searchTurns, findEntityCapturedTurns, getNeighbors, stats)
 * pass through unchanged — read access is governed by `permissions.graph.reads`
 * which lives separately and is not yet enforced at the kernel boundary.
 */
export interface KnowledgeGraphAccessor {
  /**
   * Persist entities into the graph as `PluginEntity` nodes (system, model,
   * id, displayName, extras). Each `system` string MUST be in the
   * manifest's `permissions.graph.entity_systems` list, otherwise throws
   * `KgEntityNamespaceError`.
   */
  ingestEntities(entities: EntityIngest[]): Promise<EntityIngestResult>;

  /**
   * Persist atomic facts. `mentionedEntityIds` may reference entities the
   * plugin previously ingested OR entities owned by other systems (the KG
   * tolerates dangling references). The `subject`/`predicate`/`object`
   * fields are free-form strings — no validation here, but the kernel may
   * truncate over-long values defensively in a future pass.
   */
  ingestFacts(facts: FactIngest[]): Promise<FactIngestResult>;

  /** Full-text search over Turn nodes. Read-only, no namespace check. */
  searchTurns(opts: SearchTurnsOptions): Promise<TurnSearchHit[]>;

  /** Entity-anchored Turn lookup. Read-only, no namespace check. */
  findEntityCapturedTurns(
    opts: EntityCapturedTurnsOptions,
  ): Promise<EntityCapturedTurnsHit[]>;

  /** Direct neighbours of a node. Read-only, no namespace check. */
  getNeighbors(nodeId: string): Promise<GraphNode[]>;

  /** Coarse counts for the UI / sanity checks. */
  stats(): Promise<GraphStats>;

  /** The namespaces this accessor was created with. Useful for plugin-side
   *  introspection (e.g. choosing a default namespace when there's only one). */
  readonly entitySystems: readonly string[];
}

export class KgEntityNamespaceError extends Error {
  constructor(callerAgentId: string, system: string) {
    super(
      `plugin '${callerAgentId}' tried to ingest entity with system='${system}' — not in manifest's permissions.graph.entity_systems whitelist`,
    );
    this.name = 'KgEntityNamespaceError';
  }
}

export class KgServiceUnavailableError extends Error {
  constructor(callerAgentId: string) {
    super(
      `plugin '${callerAgentId}' has ctx.knowledgeGraph but no 'knowledgeGraph' provider is registered — install @omadia/knowledge-graph-inmemory or -neon`,
    );
    this.name = 'KgServiceUnavailableError';
  }
}

// ---------------------------------------------------------------------------
// LLM-Service (OB-29-3) — `ctx.llm.complete(req)`.
// ---------------------------------------------------------------------------

/**
 * Plugin-facing accessor for the host's LLM. Wraps the host's Anthropic
 * client (or any future provider) with manifest-declared model-whitelist
 * and per-invocation call-budget. The host pays the bill — plugins do NOT
 * bring their own API keys.
 *
 * Cost-control:
 *   - `models_allowed` whitelist (with `*`-suffix wildcard) limits which
 *     models the plugin can target. Helps the operator pin a fast/cheap
 *     model for an analytics plugin while keeping Opus available for the
 *     orchestrator.
 *   - `calls_per_invocation` (default 5) caps total calls per
 *     `createPluginContext` lifetime — analogous to SubAgentAccessor.
 *   - `max_tokens_per_call` (default 4096) silently clamps `req.maxTokens`
 *     down to the manifest cap (no throw — predictable plugin code).
 */
export interface LlmAccessor {
  complete(req: LlmCompleteRequest): Promise<LlmCompleteResult>;
  /** Snapshot of the model whitelist for plugin-side introspection. */
  readonly modelsAllowed: readonly string[];
}

export interface LlmCompleteRequest {
  /** Anthropic model id (e.g. `'claude-haiku-4-5'`, `'claude-sonnet-4-6'`).
   *  MUST match the manifest whitelist or `LlmModelNotAllowedError` throws. */
  readonly model: string;
  /** Optional system prompt. Forwarded verbatim to Anthropic. */
  readonly system?: string;
  /** Conversation messages. Plain strings only in v1 — content blocks
   *  (image, document) are a v2 add-on. */
  readonly messages: ReadonlyArray<{
    readonly role: 'user' | 'assistant';
    readonly content: string;
  }>;
  /** Cap on output tokens. Silently clamped to
   *  `permissions.llm.max_tokens_per_call` when manifest sets a smaller cap. */
  readonly maxTokens?: number;
  readonly temperature?: number;
}

/** One discovered MCP tool, as the host's manager reports it (issue #458). */
export interface McpAccessorToolDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
}

/**
 * Host-pooled MCP access for plugins (epic #459 W5, issue #458). Server ids
 * are the host's `mcp_servers` ids; only operator-granted servers resolve —
 * everything else throws `McpServerNotGrantedError`-shaped errors as plain
 * `Error` (plugin-api stays dependency-free). `callTool` mirrors the host
 * manager's contract: it never throws on tool failure, it returns an
 * `Error: …` string (including scan-policy denials).
 */
export interface McpAccessor {
  /** Server ids the operator has granted to this plugin. */
  listServers(): Promise<readonly string[]>;
  listTools(serverId: string): Promise<readonly McpAccessorToolDescriptor[]>;
  callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<string>;
}

// ---------------------------------------------------------------------------
// A DORMANT CAPABILITY WAS REMOVED HERE.
//
// One accessor and its six types used to sit at this point in the file. The
// backing host service was never provided by anything, so the accessor threw on
// every invocation, and no manifest in this repo, in the private byte5 plugin
// set, or in any sibling repo ever declared its permission. It was surface
// area that only looked like a contract. The exact names are listed once, in
// `packages/plugin-api/CHANGELOG.md`, so a consumer grepping its own source for
// a removed type lands on the entry that explains where it went. Per epic
// #470 (see the spec set under `specs/`) the subsystem that would have used it
// now lives in its own repository and defines these types for itself.
//
// The reason this is a comment and not just a deletion: a plugin that still
// declares the retired permission installs and activates UNCHANGED. Unknown
// permission keys are ignored by `adaptManifestV1` and the accessor is simply
// absent (it was already unusable). That is the property that makes a
// capability removable at all, and it is regression-tested in
// `test/manifestRetiredPermissionKey.test.ts`.
// ---------------------------------------------------------------------------

export interface LlmCompleteResult {
  /** Concatenated text content of the assistant turn. Tool-use finish reasons
   *  produce empty `text` — plugins should branch on `finishReason` if they
   *  enable tool-use (which is uncommon at the plugin layer; the orchestrator
   *  handles tool-loops itself). */
  readonly text: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Provider-neutral completion-end signal — branch on THIS, not the legacy
   *  vendor `stopReason`. `end_turn`/`stop_sequence` collapse to `'stop'`;
   *  `tool_use` → `'tool_calls'`. Always populated by the host. */
  readonly finishReason: 'stop' | 'tool_calls' | 'max_tokens';
  /**
   * @deprecated Anthropic-specific stop reason, kept for v1 back-compat. Use
   * `finishReason` instead — it is provider-neutral. Still populated by the
   * host (the Anthropic adapter passes its raw value through) and remains
   * valid for installs pinned to Anthropic.
   */
  readonly stopReason:
    | 'end_turn'
    | 'max_tokens'
    | 'stop_sequence'
    | 'tool_use';
}

export class LlmServiceUnavailableError extends Error {
  constructor(callerAgentId: string) {
    super(
      `plugin '${callerAgentId}' has ctx.llm but no 'llm' provider is registered — the host needs an LLM provider connected (e.g. via the admin provider/setup flow)`,
    );
    this.name = 'LlmServiceUnavailableError';
  }
}

export class LlmModelNotAllowedError extends Error {
  constructor(callerAgentId: string, model: string) {
    super(
      `plugin '${callerAgentId}' tried to call model '${model}' — not in manifest's permissions.llm.models_allowed whitelist`,
    );
    this.name = 'LlmModelNotAllowedError';
  }
}

export class LlmBudgetExceededError extends Error {
  constructor(callerAgentId: string, budget: number) {
    super(
      `plugin '${callerAgentId}' exceeded its per-invocation llm.complete budget of ${budget} call(s) — raise via manifest permissions.llm.calls_per_invocation`,
    );
    this.name = 'LlmBudgetExceededError';
  }
}

/**
 * Provider contract — ServiceRegistry-keyed under `'llm'`. The host
 * registers an instance backed by its Anthropic client; the plugin-side
 * `LlmAccessor` resolves it lazily on first complete() call.
 */
export interface LlmProvider {
  complete(req: LlmCompleteRequest): Promise<LlmCompleteResult>;
}

export class MissingSecretError extends Error {
  constructor(agentId: string, key: string) {
    super(`plugin '${agentId}' has no secret '${key}' in vault`);
    this.name = 'MissingSecretError';
  }
}

export class MissingConfigError extends Error {
  constructor(agentId: string, key: string) {
    super(`plugin '${agentId}' has no config value '${key}'`);
    this.name = 'MissingConfigError';
  }
}

/**
 * Context passed to `onMigrate` when a plugin package is uploaded in a new
 * version while the previous version is still installed. The hook returns the
 * new config that replaces the old one in the InstalledRegistry atomically on
 * success — or throws to abort the upload (old version stays active).
 *
 * Lifetime: the hook runs synchronously during the zip-upload flow, BEFORE the
 * v2 package swap becomes visible to the runtime. Any `ctx.secrets.set(...)` /
 * `ctx.memory.writeFile(...)` calls succeed immediately (there is no queue
 * that rolls back). If the hook throws after some writes already happened,
 * those writes are visible — the plugin author is responsible for keeping
 * migrations idempotent (re-running a partially applied migration should be a
 * no-op rather than a double-apply).
 *
 * The hook's return value MUST be JSON-serialisable — the registry persists it
 * verbatim. Secret-shaped values should be stored via `ctx.secrets.set(...)`
 * and referenced by key in the config, not inlined into newConfig.
 */
export interface MigrationContext extends Omit<PluginContext, 'secrets'> {
  /** Manifest version that is currently installed (being replaced). */
  readonly fromVersion: string;
  /** Manifest version coming in via the upload. */
  readonly toVersion: string;
  /** Snapshot of the v1 config from InstalledRegistry at the moment the hook
   *  fires. Read-only — returning a mutated copy would be lost. */
  readonly previousConfig: Record<string, unknown>;
  /** Secrets accessor with `set`/`delete`, scoped to this plugin. Read-only
   *  plugin code (activate, tools) never gets this variant. */
  readonly secrets: SecretsReadWriteAccessor;
}

/** Return value of an `onMigrate` hook. */
export interface MigrationResult {
  /** Replaces the plugin's config in InstalledRegistry. Must be JSON-serialisable.
   *  If the migration does not touch config, return `previousConfig` unchanged. */
  newConfig: Record<string, unknown>;
}

/** Signature a plugin exports for migrations. Opt-in — absence means the
 *  kernel carries over `previousConfig` 1:1. */
export type MigrationHook = (ctx: MigrationContext) => Promise<MigrationResult>;

/** Default timeout for an `onMigrate` invocation. Overridable per plugin via
 *  `manifest.lifecycle.onMigrate.timeout_ms`. */
export const MIGRATION_TIMEOUT_MS_DEFAULT = 10_000;

export class MigrationTimeoutError extends Error {
  constructor(
    agentId: string,
    fromVersion: string,
    toVersion: string,
    timeoutMs: number,
  ) {
    super(
      `plugin '${agentId}' onMigrate hook (${fromVersion} → ${toVersion}) timed out after ${timeoutMs}ms`,
    );
    this.name = 'MigrationTimeoutError';
  }
}

export class MigrationHookError extends Error {
  public readonly migrationCause: unknown;
  constructor(
    agentId: string,
    fromVersion: string,
    toVersion: string,
    cause: unknown,
  ) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    super(
      `plugin '${agentId}' onMigrate hook (${fromVersion} → ${toVersion}) threw: ${msg}`,
    );
    this.name = 'MigrationHookError';
    this.migrationCause = cause;
  }
}

// ── Plugin-owned SQL schema (epic #470 C7 / G4) ─────────────────────────────
//
// "Plugins can own tables." Three things had to become true for that sentence
// to be safe rather than merely possible:
//
//   1. Reaching a Postgres pool must be a DECLARED, GRANTED permission — not a
//      side effect of `ctx.services.get('graphPool')` resolving for anyone who
//      asked (bug B1). `permissions.sql` is that declaration; the operator's
//      grant is the other half.
//   2. The ledger a plugin writes its applied-migration rows into must be
//      unambiguously ITS ledger. A plugin that could name any table could
//      forge another plugin's migration history and thereby suppress that
//      plugin's schema changes at its next boot.
//   3. Applying migrations must be serialised. `implementation.md` B3 recorded
//      core migrators racing on multi-replica boot; shipping a fresh pattern
//      for plugins to copy would have multiplied the bug rather than
//      contained it.
//
// The kernel owns all three. A plugin only ever calls `ctx.sql.runMigrations()`.

/**
 * The shape of `permissions.sql` in a plugin manifest.
 *
 * ```yaml
 * permissions:
 *   sql:
 *     migrations: migrations   # optional; directory inside the package
 *     ledger: omadia_verifier_migrations
 *     handoff: handoff-plan.json  # optional; run before `migrations`
 * ```
 */
export interface SqlPermission {
  /** Directory (relative to the package root) holding `*.sql` / `*.js` /
   *  `*.mjs` migration files. Defaults to `migrations`. When the manifest
   *  declares it, the kernel runs the directory automatically at activate. */
  readonly migrations?: string;
  /** The plugin-owned table recording which migrations have been applied.
   *  Must match `^[a-z][a-z0-9_]{2,62}$` AND begin with the plugin's sanitized
   *  id, so a manifest cannot nominate another plugin's ledger. */
  readonly ledger: string;
  /**
   * Path (relative to the package root) to a JSON ledger-handoff plan the
   * kernel runs BEFORE {@link SqlPermission.migrations} — epic #470 C15.
   *
   * ```json
 * {
 *   "entries": [
 *     { "filename": "0001_x.js", "witnessSql": "SELECT to_regclass('public.x') IS NOT NULL" }
 *   ],
 *   "dryRun": false
   * }
   * ```
   *
   * Same shape {@link SqlAccessor.seedLedger} accepts, and the same shape the
   * operator CLI (`middleware/scripts/plugin-ledger-handoff.mjs --plan`)
   * reads, so one file serves all three readers. A shared file MAY carry
   * `"dryRun": false`; `"dryRun": true` is refused on the kernel-run path.
   * Preview mode belongs to the CLI flag, not to plugin data: if core read a
   * plan that asked it to "write nothing", then core's own migration runner
   * would immediately apply every file underneath it, silently recreating the
   * exact "0 seeded, 9 already seeded" failure C15 exists to remove.
   *
   * DECLARE THIS RATHER THAN CALLING `seedLedger` YOURSELF when the manifest
   * also declares `migrations`. The kernel runs that directory before your
   * `activate()`, so a `seedLedger` call inside `activate()` arrives after
   * every ledger row is already written and can only ever report
   * `alreadySeeded` — the `skippedNoWitness` alarm never fires. Keeping the
   * in-`activate` call as well is safe and is the right fallback for older
   * kernels, where it does the work instead.
   */
  readonly handoff?: string;
}

/** What one `runMigrations` pass did. Returned rather than logged so a plugin
 *  (and a test) can assert on it instead of grepping stdout. */
export interface MigrationReport {
  /** Filenames applied by THIS pass, in the order they ran. */
  readonly applied: readonly string[];
  /** Filenames already in the ledger and therefore not re-run. */
  readonly skipped: readonly string[];
  /** The ledger table the pass wrote to — echoed back so a caller that took
   *  the default cannot misreport which table it touched. */
  readonly ledger: string;
  /** Wall-clock duration of the pass, including lock wait. */
  readonly durationMs: number;
}

/** Options for one `ctx.sql.runMigrations()` call. Every field is optional —
 *  the manifest already carries the answers. */
export interface RunMigrationsOptions {
  /** Override the manifest's `permissions.sql.migrations` directory. Still
   *  resolved inside the package root and rejected if it escapes. */
  readonly dir?: string;
  /**
   * Accept a file whose content changed after it was applied.
   *
   * Off by default, and the default is the point: an edited migration means
   * the database and the package disagree about what ran, and every
   * environment that already applied the old bytes is now silently different
   * from every environment that applies the new ones. The escape hatch exists
   * for the one legitimate case — a cosmetic edit (a comment, a reformat) the
   * author has verified is semantically identical.
   */
  readonly allowChecksumDrift?: boolean;
}

// ── Migration handoff (epic #470 C11) ───────────────────────────────────────
//
// A plugin extracted from core inherits installations whose schema core
// already created, recorded in a CORE ledger the plugin cannot see. Its own
// ledger is empty, so its migration runner would re-apply every file.
//
// The naive fix — copy the core rows and skip those files — destroys an
// installation in one case, silently: rows present, tables ABSENT (a restore,
// a version-skewed rollback, an operator who dropped a table during an
// incident). The plugin activates green and every request 500s.
//
// So the core ledger is corroboration, never authority. Each file carries a
// WITNESS: one query against the live catalog that is true only if the schema
// object that file creates is actually there. The witness decides; the core
// row is reported so the DISAGREEMENT between the two is visible before
// anything is written.

/** One file's claim on the core ledger, and the proof that backs it. */
export interface LedgerSeedEntry {
  /** The plugin's OWN migration filename, exactly as it ships. Matched against
   *  the core ledger by stem, so `0022_x.js` adopts core's `0022_x.sql`. */
  readonly filename: string;
  /**
   * A single-row, single-column boolean SELECT that is true only when this
   * file's schema object exists.
   *
   * SQL text rather than a callback on purpose. A callback cannot be printed,
   * and the whole value of `dryRun` is that an operator reads the plan — WHICH
   * query proved WHICH file — before a production handoff writes anything.
   *
   * It must be safe against a database where the objects are missing, which is
   * the case it exists to detect: `to_regclass('public.t') IS NOT NULL` is
   * safe, `'public.t'::regclass` throws. Prefer catalog lookups over casts.
   */
  readonly witnessSql: string;
}

/** Options for one `ctx.sql.seedLedger()` call. */
export interface SeedLedgerOptions {
  /** The files to consider. A file absent from this list is never seeded. */
  readonly entries: readonly LedgerSeedEntry[];
  /** Compute and report the plan; write nothing. Defaults to false. */
  readonly dryRun?: boolean;
  /** Override the manifest's migrations directory, as `runMigrations` does. */
  readonly dir?: string;
}

/** What one `seedLedger` pass did, or — under `dryRun` — would have done. */
export interface LedgerSeedReport {
  /** Written into this plugin's ledger by this pass. */
  readonly seeded: readonly string[];
  /** Everything `runMigrations` still has to apply afterwards. Superset of
   *  {@link LedgerSeedReport.skippedNoWitness}. */
  readonly applied: readonly string[];
  /** The subset that should worry you: the core ledger records these, but
   *  their witness says the schema object is not there. Empty on a healthy
   *  installation; non-empty means a restore or a rollback, and the migration
   *  runner is about to repair it. */
  readonly skippedNoWitness: readonly string[];
  /** Already in this plugin's ledger before the pass — a re-run, or a peer
   *  replica that got there first. */
  readonly alreadySeeded: readonly string[];
  /** Which requested files the core ledger actually records. Reported, not
   *  obeyed. */
  readonly donorRecorded: readonly string[];
  /** This plugin's ledger table. */
  readonly ledger: string;
  /** The core ledger the rows were read from. Core-supplied — a plugin does
   *  not name it and cannot choose it. */
  readonly donorLedger: string;
  readonly dryRun: boolean;
  readonly durationMs: number;
}

/** Plugin-facing migration runner. See {@link PluginContext.sql}. */
export interface SqlAccessor {
  /** The ledger table this plugin owns, as resolved from its manifest. */
  readonly ledger: string;
  /**
   * Apply every not-yet-applied migration in the plugin's migrations
   * directory, in filename order, inside ONE transaction held under an
   * advisory lock keyed on the ledger.
   *
   * `.sql` files are executed verbatim. `.js` / `.mjs` files must
   * `export default async (client) => { … }` and receive the same
   * transaction-bound client — that is the codegen target described in
   * `implementation.md` D6, where a plugin compiles its `.sql` into JS.
   *
   * Throws rather than returning a partial result: an empty directory
   * ({@link SqlMigrationError}) is a misconfiguration, and a checksum change
   * on an already-applied file is a divergence. Both are conditions where
   * continuing quietly is worse than failing loudly.
   */
  runMigrations(opts?: RunMigrationsOptions): Promise<MigrationReport>;
  /**
   * Adopt an existing installation's schema: record files as applied when a
   * witness proves the schema object they create is already there.
   *
   * Call this BEFORE {@link SqlAccessor.runMigrations}, and guard it — the
   * method was added in plugin-api 1.3.0 and is `undefined` on an older core,
   * where the correct behaviour is simply to let `runMigrations` apply the
   * (idempotent) files:
   *
   * ```ts
   * await ctx.sql.seedLedger?.({ entries: HANDOFF_ENTRIES });
   * await ctx.sql.runMigrations();
   * ```
   *
   * Never deletes anything from the core ledger. Those rows are the rollback
   * path: while core still ships the same files, removing them would make
   * core's own migrator re-run them on the next boot.
   */
  seedLedger?(opts: SeedLedgerOptions): Promise<LedgerSeedReport>;
}

/**
 * Thrown when a plugin reaches for a database capability it has not been
 * cleared for.
 *
 * Deliberately distinct from {@link ServiceNotDeclaredError}: that one means
 * "your manifest is missing a line", which the plugin author fixes alone. This
 * one can additionally mean "the operator has not agreed", which the author
 * cannot fix at all — so the two must not be reported the same way.
 */
export class SqlPermissionError extends Error {
  public readonly pluginId: string;
  public readonly capability: string;
  /** `undeclared` → the manifest lacks `permissions.sql`.
   *  `ungranted`  → declared, but no operator grant is on record. */
  public readonly reason: 'undeclared' | 'ungranted';
  constructor(
    pluginId: string,
    capability: string,
    reason: 'undeclared' | 'ungranted',
  ) {
    super(
      reason === 'undeclared'
        ? `plugin '${pluginId}' reached for the database capability '${capability}' but its manifest does not declare \`permissions.sql\` — ` +
            'add a `permissions.sql` block (with a `ledger:` this plugin owns) so the operator can see the request at install time'
        : `plugin '${pluginId}' declares \`permissions.sql\` but the operator has not granted it — ` +
            `'${capability}' stays unavailable until the grant is recorded`,
    );
    this.name = 'SqlPermissionError';
    this.pluginId = pluginId;
    this.capability = capability;
    this.reason = reason;
  }
}

/**
 * Thrown when a manifest nominates a ledger table this plugin may not own.
 *
 * The name is interpolated into DDL as a quoted identifier, so it is also the
 * one plugin-supplied string in this subsystem that reaches SQL outside a bind
 * parameter. It is validated against a charset allowlist BEFORE it is quoted,
 * never by escaping afterwards — an allowlist that rejects `"` cannot be
 * defeated by a cleverer `"`.
 */
export class LedgerNameError extends Error {
  public readonly pluginId: string;
  public readonly ledger: string;
  constructor(pluginId: string, ledger: string, why: string) {
    super(`plugin '${pluginId}' cannot use ledger table '${ledger}': ${why}`);
    this.name = 'LedgerNameError';
    this.pluginId = pluginId;
    this.ledger = ledger;
  }
}

/** Thrown for migration-run failures that are the plugin package's fault:
 *  an empty or missing directory, or a file whose bytes changed after it was
 *  applied. Both are recoverable by fixing the package, which is why they are
 *  one type and not folded into a generic Error. */
export class SqlMigrationError extends Error {
  public readonly pluginId: string;
  public readonly ledger: string;
  constructor(pluginId: string, ledger: string, why: string) {
    super(`plugin '${pluginId}' migrations (ledger '${ledger}') failed: ${why}`);
    this.name = 'SqlMigrationError';
    this.pluginId = pluginId;
    this.ledger = ledger;
  }
}
