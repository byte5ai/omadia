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
  /** Theme D: true only when the kernel activated this plugin for a
   *  smoke probe. False during normal `activate()`. Plugins MAY branch
   *  on this to return mock data — most plugins ignore it. */
  readonly smokeMode: boolean;
  log(...args: unknown[]): void;
}
