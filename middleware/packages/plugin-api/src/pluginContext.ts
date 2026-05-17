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
 * Well-known service names and their accessor interfaces are documented
 * alongside the providing plugin. Plugins that depend on a specific service
 * should declare the provider in their manifest's `depends_on` so the
 * installer can enforce ordering.
 */
export interface ServicesAccessor {
  /** Returns the registered provider for the given service, or undefined
   *  if no provider is installed. */
  get<T>(name: string): T | undefined;
  /** Whether a provider is currently registered. */
  has(name: string): boolean;
  /** Register THIS plugin as the provider for the given service name.
   *  Returns a dispose handle — the plugin's `close()` MUST invoke it to
   *  symmetrically unregister the service on deactivate. Throws on
   *  duplicate-provider (two plugins cannot both claim the same name; the
   *  operator must uninstall one). */
  provide<T>(name: string, impl: T): () => void;
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
   */
  replace<T>(name: string, impl: T): () => void;
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
}

export interface ToolRegistrationOptions {
  /** System-prompt documentation block for this tool. The kernel splices it
   *  into the tool-list section of the system prompt verbatim, prefixed by
   *  a bullet. Keep it to one paragraph (≈4–8 sentences). */
  readonly promptDoc?: string;
  /** Per-turn attachment collector. See NativeToolAttachmentSink docs. */
  readonly attachmentSink?: NativeToolAttachmentSink;
}

/**
 * Contributes an Express router to the kernel. The kernel mounts it at the
 * given prefix via `app.use(prefix, router)`. Authentication / CORS / rate
 * limiting remain the plugin's responsibility — the kernel does not inject
 * middleware around the contributed router.
 */
export interface RoutesAccessor {
  register(prefix: string, router: unknown): () => void;
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

export interface LlmCompleteResult {
  /** Concatenated text content of the assistant turn. Tool-use stop reasons
   *  produce empty `text` — plugins should branch on `stopReason` if they
   *  enable tool-use (which is uncommon at the plugin layer; the orchestrator
   *  handles tool-loops itself). */
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

export class LlmServiceUnavailableError extends Error {
  constructor(callerAgentId: string) {
    super(
      `plugin '${callerAgentId}' has ctx.llm but no 'llm' provider is registered — host needs ANTHROPIC_API_KEY configured at boot`,
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
