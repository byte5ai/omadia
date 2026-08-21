/**
 * Service registry for plugin-bereitgestellte (plugin-provided) services.
 *
 * Key distinction from the other Phase-0c registries: these services don't
 * belong to the kernel. The kernel defines the INTERFACE (GraphAccessor,
 * EventBusAccessor, EmbeddingAccessor, …), and a provider-plugin IMPLEMENTS
 * and REGISTERS it. Other plugins then consume the registered provider via
 * their PluginContext (`ctx.graph`, `ctx.bus`, `ctx.embeddings`).
 *
 * Example sequence (post Phase 4):
 *   1. `@omadia/knowledge-graph` activates.
 *   2. In its activate(), it calls `ctx.services.provide('graph', impl)`.
 *   3. Kernel caches the registration keyed to the ServiceName.
 *   4. Later, `@omadia/agent-seo-analyst` activates. The Kernel
 *      resolves its PluginContext's `ctx.graph` proxy to the registered
 *      provider (or leaves it undefined if no provider is installed).
 *
 * For Phase 0c: the registry exists, the `createPluginContext` function is
 * extended to accept it, and `ctx.graph` / `ctx.bus` / `ctx.embeddings` are
 * exposed — all resolving to `undefined` until the KG extraction (Phase 4)
 * lands. No behavior change today; today's built-ins still access graph/bus/
 * embeddings through their existing direct imports, not through ctx.
 *
 * Security note: when a Provider is registered, the kernel WILL (in Phase 4)
 * wrap the accessor with a per-consumer scope filter — e.g. an uploaded agent
 * may only read graph scopes tagged with its own agentId or `public`. The
 * scope wrapping happens in `createPluginContext`, not here. This registry is
 * a naked service-locator; enforcement lives at the consumer seam.
 *
 * That seam now exists (epic #470, B1): `pluginServiceGrants.ts`, called from
 * `createPluginContext`. `ctx.services.get` resolves only capabilities the
 * plugin's manifest declares. This class stays deliberately unenforcing — core
 * resolves its own services through it, and a registry that policed its own
 * callers could not serve both.
 *
 * What this class DOES owe that seam is a fact only it can know: whether a
 * given plugin currently holds a live registration for a name (issue #788).
 * A `provides:` manifest entry is a promise; {@link ServiceRegistry.providedBy}
 * is the evidence. See the ownership bookkeeping around {@link
 * ServiceRegistry.track} — answering the question is not "does `providers` have
 * this key", which would be true of any provider, but "is the entry under this
 * key one that THIS owner registered and has not released".
 */

import {
  isPerCallerService,
  resolvePerCallerService,
  type ServiceCaller,
} from '@omadia/plugin-api';

/** Attribution used when core resolves a service for itself rather than on
 *  behalf of a plugin. A per-caller factory can branch on it to hand the
 *  kernel an unscoped implementation. */
export const KERNEL_SERVICE_CALLER: ServiceCaller = Object.freeze({
  agentId: '@omadia/core',
  pluginId: '@omadia/core',
});

/** The known well-known service names. An open string union so future
 *  additions (e.g. 'diagrams', 'attachments', 'memory') don't require a
 *  cross-module refactor — a provider calls `provide('diagrams', impl)` and
 *  the consumer requests `ctx.services.get<DiagramAccessor>('diagrams')`. */
export type ServiceName =
  | 'graph'
  | 'bus'
  | 'embeddings'
  | 'diagrams'
  | 'attachments'
  | 'memory'
  | (string & {});

/** A registration remembered for its owner so `disposeBySource` can unwind
 *  it. `dispose` reports whether the call actually changed the map — a
 *  registration the plugin already released itself returns false, which is
 *  what makes `disposeBySource` idempotent. */
interface OwnedRegistration {
  readonly name: ServiceName;
  readonly dispose: () => boolean;
}

export class ServiceRegistry {
  private readonly providers = new Map<ServiceName, unknown>();

  /** Dispose handles from `provide`/`replace`, keyed by the plugin that made
   *  them. Core's own boot-time registrations pass no owner and are therefore
   *  never bulk-disposed — nothing tears the kernel down mid-process. */
  private readonly owned = new Map<string, OwnedRegistration[]>();

  /**
   * #788 — LIVE registration count per `(owner, name)`, the evidence behind
   * {@link providedBy}.
   *
   * Counted rather than a boolean set because `replace` stacks: a plugin may
   * hold two registrations for one name (a `provide` and a later `replace` of
   * its own entry), and a single disposal must not report the plugin as having
   * released the name while a registration of its is still live.
   *
   * Kept separate from `owned` on purpose. `owned` is an append-only journal —
   * `disposeBySource` walks it newest-first and a disposed handle stays in the
   * array — so "is there an entry in `owned`" answers "did this plugin EVER
   * register this", which is precisely the question a grant gate must not ask.
   */
  private readonly liveByOwner = new Map<string, Map<ServiceName, number>>();

  /** Register a provider. Throws on duplicate — if two plugins both provide
   *  'graph', the operator needs to uninstall one.
   *
   *  `owner` is the registering plugin's agentId. `createPluginContext`
   *  supplies it from the kernel-known id, so attribution never comes from
   *  the caller. Omitted for core's own registrations. */
  provide<T>(name: ServiceName, impl: T, owner?: string): () => void {
    if (this.providers.has(name)) {
      throw new Error(
        `ServiceRegistry: duplicate provider for '${String(name)}' — uninstall the existing provider first`,
      );
    }
    this.providers.set(name, impl);
    const dispose = (): boolean => {
      if (this.providers.get(name) !== impl) return false;
      this.providers.delete(name);
      return true;
    };
    return this.track(owner, name, dispose);
  }

  /**
   * OB-71 (palaia capture-pipeline): swap an already-registered provider
   * for a wrapped variant. Used by the orchestrator-extras plugin to
   * replace `knowledgeGraph` with a `CaptureFilteringKnowledgeGraph` that
   * decorates the original. Throws if no provider exists yet (use
   * `provide` for the first registration).
   *
   * The dispose handle RESTORES the previous provider reference — i.e.
   * `replace()` is rollback-safe: when the wrapping plugin deactivates,
   * the underlying KG provider stays live for the rest of the system.
   * Stacking multiple replacements is supported (LIFO restore).
   */
  replace<T>(name: ServiceName, impl: T, owner?: string): () => void {
    const previous = this.providers.get(name);
    if (previous === undefined) {
      throw new Error(
        `ServiceRegistry: cannot replace '${String(name)}' — no provider registered (use provide() instead)`,
      );
    }
    this.providers.set(name, impl);
    const dispose = (): boolean => {
      // Only restore if our replacement is still the active one. If a
      // later `replace` already shadowed us, our restore is a no-op.
      if (this.providers.get(name) !== impl) return false;
      this.providers.set(name, previous);
      return true;
    };
    return this.track(owner, name, dispose);
  }

  /**
   * Resolve a provider.
   *
   * When the registration is a {@link perCallerService} factory, it is
   * invoked with `caller` and the result is returned — so a provider that
   * needs to know who is asking gets the id from the kernel rather than from
   * an argument the consumer supplied (epic #470 §2.2).
   *
   * `caller` defaults to {@link KERNEL_SERVICE_CALLER}: core's own direct
   * `.get()` call sites keep working unchanged and are attributed to the
   * kernel, not to whichever plugin happens to be on the stack.
   */
  get<T>(name: ServiceName, caller: ServiceCaller = KERNEL_SERVICE_CALLER): T | undefined {
    const raw = this.providers.get(name);
    if (isPerCallerService<T>(raw)) return resolvePerCallerService(raw, caller);
    return raw as T | undefined;
  }

  has(name: ServiceName): boolean {
    return this.providers.has(name);
  }

  /**
   * #788 — does `owner` currently hold a live registration for `name`?
   *
   * This is the fact `pluginServiceGrants.ts` needs to turn a `provides:`
   * self-declaration into an actual grant. It is deliberately narrower than
   * {@link has}: `has('graphPool')` is true whenever ANY plugin provides the
   * pool, and answering the grant question with it would grant every
   * `provides:` claimant access to whoever really registered the name — the
   * exact bypass #788 reports.
   *
   * Ownership comes from the `owner` argument `createPluginContext` fills from
   * the kernel-known agentId, never from the plugin, so a plugin cannot claim
   * somebody else's registration by naming them.
   */
  providedBy(owner: string, name: ServiceName): boolean {
    return (this.liveByOwner.get(owner)?.get(name) ?? 0) > 0;
  }

  names(): readonly string[] {
    return Array.from(this.providers.keys()) as string[];
  }

  /**
   * Unregister every service the given plugin still holds. Returns the count
   * of registrations actually taken down (0 when the plugin owned none or
   * released them all itself). Idempotent: a second call is a no-op.
   *
   * Used by the kernel on plugin deactivate as a fail-safe — the same shape
   * as `PluginRouteRegistry.disposeBySource`, one layer down. A provider
   * whose `close()` body forgets to call its dispose handle would otherwise
   * leave the service registered against a torn-down module: consumers keep
   * resolving a dead implementation, and the reinstall throws
   * 'duplicate provider' because nothing ever removed the old entry.
   */
  disposeBySource(pluginId: string): number {
    const registrations = this.owned.get(pluginId);
    if (registrations === undefined) return 0;
    this.owned.delete(pluginId);
    let count = 0;
    // LIFO: a `replace` restores whatever was live when it ran, so stacked
    // registrations have to unwind newest-first or an older restore would
    // reinstate a provider a newer one has since shadowed.
    for (let i = registrations.length - 1; i >= 0; i -= 1) {
      const registration = registrations[i];
      if (registration !== undefined && registration.dispose()) count += 1;
    }
    // #788 — belt and braces. Every handle above is a `track` wrapper that
    // already decremented, so this map should be empty; dropping it outright
    // means a deactivated plugin can never be reported as still providing a
    // name, even if a future registration path forgets to route through
    // `track`.
    this.liveByOwner.delete(pluginId);
    return count;
  }

  /**
   * Remember a dispose handle against its owner and hand the caller back a
   * handle that also keeps the live-registration count honest. Unowned (core)
   * registrations are returned untracked — core's boot-time services belong to
   * nobody and no grant gate asks about them.
   *
   * The returned handle WRAPS the caller's `dispose`, so releasing a service
   * decrements the count no matter which of the three routes the release took:
   * the plugin calling its own handle, `disposeBySource` on deactivate, or a
   * stacked `replace` unwinding. Returning the raw handle here — and doing the
   * decrement only in `disposeBySource` — would leave a plugin that tidied up
   * after itself still counted as providing the name.
   */
  private track(
    owner: string | undefined,
    name: ServiceName,
    dispose: () => boolean,
  ): () => void {
    if (owner === undefined) return dispose;

    const live = this.liveByOwner.get(owner) ?? new Map<ServiceName, number>();
    live.set(name, (live.get(name) ?? 0) + 1);
    this.liveByOwner.set(owner, live);

    const tracked = (): boolean => {
      // `dispose` is idempotent and reports whether it actually changed the
      // map, so a second call must not decrement a second time.
      if (!dispose()) return false;
      this.releaseLive(owner, name);
      return true;
    };

    const registrations = this.owned.get(owner) ?? [];
    registrations.push({ name, dispose: tracked });
    this.owned.set(owner, registrations);
    return tracked;
  }

  /** Drop one live registration of `(owner, name)`, pruning empty maps so a
   *  long-lived process does not accumulate an entry per plugin ever seen. */
  private releaseLive(owner: string, name: ServiceName): void {
    const live = this.liveByOwner.get(owner);
    if (live === undefined) return;
    const next = (live.get(name) ?? 0) - 1;
    if (next > 0) live.set(name, next);
    else live.delete(name);
    if (live.size === 0) this.liveByOwner.delete(owner);
  }
}
