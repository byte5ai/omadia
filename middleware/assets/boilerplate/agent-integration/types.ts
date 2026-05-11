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
  /** Theme D: true only when the kernel activated this plugin for a
   *  smoke probe. False during normal `activate()`. Plugins MAY branch
   *  on this to return mock data — most plugins ignore it. */
  readonly smokeMode: boolean;
  log(...args: unknown[]): void;
}
