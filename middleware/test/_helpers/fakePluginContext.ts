import type { PluginContext } from '@omadia/plugin-api';

/**
 * #1077 — a `PluginContext` a test can hand to a plugin's real `activate()`.
 *
 * Only the members harness plugins actually touch at activation are real:
 * `config.get`, `secrets.get`, `log`, and a `services` registry backed by a
 * Map. Everything a test does NOT pre-seed resolves to `undefined`, which is
 * how the kernel answers for an absent optional service, so the plugin takes
 * its documented degrade path instead of hitting a stub that pretends.
 *
 * `provided` records what the plugin published (the thing most tests assert
 * on); `replaced` records `services.replace` calls, which the extras plugin
 * uses to wrap `knowledgeGraph`. The shape follows the inline fake in
 * `signedUrlRoutesPublicPath.test.ts`, lifted here because two `activate()`
 * suites need it.
 */
export interface FakePluginContext {
  readonly ctx: PluginContext;
  /** Services the plugin published via `provide`, by name. Disposal removes. */
  readonly provided: Map<string, unknown>;
  /** Services the plugin swapped via `replace`, by name. */
  readonly replaced: Map<string, unknown>;
  /** Every `ctx.log` line, in order. */
  readonly logs: string[];
}

export interface FakePluginContextOptions {
  /** Setup-field values, read by `ctx.config.get`. */
  readonly config?: Readonly<Record<string, unknown>>;
  /** Vault values, read by `ctx.secrets.get`. Absent keys → undefined. */
  readonly secrets?: Readonly<Record<string, string>>;
  /** Services the kernel (or earlier plugins) already published. */
  readonly services?: Readonly<Record<string, unknown>>;
  readonly agentId?: string;
}

export function fakePluginContext(
  options: FakePluginContextOptions = {},
): FakePluginContext {
  const config = options.config ?? {};
  const secrets = options.secrets ?? {};
  const registry = new Map<string, unknown>(Object.entries(options.services ?? {}));
  const provided = new Map<string, unknown>();
  const replaced = new Map<string, unknown>();
  const logs: string[] = [];

  const lookup = <T>(name: string): T | undefined => registry.get(name) as T | undefined;

  const ctx = {
    agentId: options.agentId ?? '@omadia/test-plugin',
    domain: 'test.plugin',
    smokeMode: false,
    log: (...args: unknown[]): void => {
      logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    },
    config: {
      get: <T>(key: string): T | undefined => config[key] as T | undefined,
      require: <T>(key: string): T => {
        const value = config[key];
        if (value === undefined) throw new Error(`missing config ${key}`);
        return value as T;
      },
    },
    secrets: {
      get: async (key: string): Promise<string | undefined> => secrets[key],
      require: async (key: string): Promise<string> => {
        const value = secrets[key];
        if (value === undefined) throw new Error(`missing secret ${key}`);
        return value;
      },
      keys: async (): Promise<string[]> => Object.keys(secrets),
    },
    services: {
      get: lookup,
      getOptional: lookup,
      has: (name: string): boolean => registry.has(name),
      provide: (name: string, value: unknown): (() => void) => {
        if (registry.has(name)) throw new Error(`duplicate provider for ${name}`);
        registry.set(name, value);
        provided.set(name, value);
        return () => {
          registry.delete(name);
          provided.delete(name);
        };
      },
      replace: (name: string, value: unknown): (() => void) => {
        const previous = registry.get(name);
        registry.set(name, value);
        replaced.set(name, value);
        return () => {
          registry.set(name, previous);
          replaced.delete(name);
        };
      },
    },
    tools: { register: () => () => undefined },
    routes: { register: () => () => undefined },
  } as unknown as PluginContext;

  return { ctx, provided, replaced, logs };
}
