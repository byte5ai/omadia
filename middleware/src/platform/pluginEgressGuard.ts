import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildHostMatcher } from './httpAccessor.js';
import { isPublicIp } from './ssrfGuard.js';

/**
 * Spec 2042 §5.10, ADR-0017 — the network sandbox of plugins.
 *
 * `ctx.http` enforces a plugin's allow-list, but the global `fetch` and
 * `node:http(s)` are reachable from plugin code too. This guard sits on
 * those process-wide entries and decides, for a request a PLUGIN's code
 * makes, whether its effective network permission covers the host:
 *
 *   - the static hosts of its manifest (`permissions.network.outbound`,
 *     including `$config.*` hosts the operator entered), the operator's
 *     `host_list` hosts in `allowlist` mode, or any public host in
 *     `public-web` mode (literal private addresses refused);
 *   - never the endpoints of the installed model providers, unless the
 *     plugin is a model plugin: every other plugin reaches models only
 *     through the kernel's model gateway (`ctx.llm`).
 *
 * WHO makes the request is read from the call stack: the innermost frame
 * that is neither Node's own nor a dependency of the kernel. A frame inside
 * an installed package's directory (its code or its own dependencies) makes
 * it that plugin's request; a frame in kernel code makes it the kernel's,
 * which is what a request on a plugin's behalf through `ctx.http`, `ctx.llm`
 * or a kernel service is. Packages that ship inside the image are kernel
 * code (system modules, built-in adapters) and are not guarded here.
 *
 * Modes (`PLUGIN_EGRESS_MODE`): `observe` lets the request through and
 * records it once per plugin, host and reason (the expand step: the plugin
 * release train moves the last plugins onto `ctx.http` and the gateway);
 * `enforce` refuses it.
 *
 * Not covered (documented, `docs/security-architecture.md`): a plugin that
 * imports its own `undici` or opens sockets with `node:net`/`node:tls`
 * directly, and the DNS-rebinding check, which only `ctx.http`'s guarded
 * dispatcher does. The guard is a policy for plugins that run in-process,
 * not a boundary against hostile code.
 */

export type PluginEgressMode = 'observe' | 'enforce';

export type EgressRefusalReason = 'model_provider' | 'not_allowed' | 'private_address';

export interface PluginEgressPermission {
  /** A model plugin may reach model provider endpoints. */
  readonly isModelPlugin: boolean;
  /** Host patterns (`api.example.com`, `*.example.com`) the plugin may reach. */
  readonly hosts: readonly string[];
  /** `public-web` mode: any public host. */
  readonly publicWeb: boolean;
}

export interface PluginEgressSource {
  /** Package root directories of installed (not bundled) plugins. */
  readonly pluginRoots: () => ReadonlyArray<{ readonly root: string; readonly pluginId: string }>;
  readonly permissionOf: (pluginId: string) => PluginEgressPermission | undefined;
  /** Hostnames (lowercase) of the installed model providers. */
  readonly modelProviderHosts: () => ReadonlySet<string>;
}

export interface PluginEgressObservation {
  readonly pluginId: string;
  readonly host: string;
  readonly reason: EgressRefusalReason;
}

export class PluginEgressRefusedError extends Error {
  readonly code = 'plugin.egress_refused';
  constructor(
    readonly pluginId: string,
    readonly host: string,
    readonly reason: EgressRefusalReason,
  ) {
    super(`plugin '${pluginId}' may not reach '${host}' (${REASON_TEXT[reason]}); use ctx.http or ctx.llm (spec 2042 §5.10)`);
    this.name = 'PluginEgressRefusedError';
  }
}

const REASON_TEXT: Record<EgressRefusalReason, string> = {
  model_provider: 'a model provider endpoint: models are reached only through the model gateway',
  not_allowed: 'not in its network permission',
  private_address: 'a private or loopback address',
};

/**
 * Whether `permission` covers `host`. Pure. The model provider block comes
 * first: no allow-list entry and no `public-web` mode reaches a model
 * provider for a plugin that is not a model plugin.
 */
export function decideEgress(
  permission: PluginEgressPermission,
  host: string,
  modelHosts: ReadonlySet<string>,
): EgressRefusalReason | undefined {
  const h = normaliseHost(host);
  if (!permission.isModelPlugin && modelHosts.has(h)) return 'model_provider';
  if (permission.hosts.some((pattern) => buildHostMatcher(pattern)(h))) return undefined;
  if (permission.publicWeb) {
    return isIP(h) !== 0 && !isPublicIp(h) ? 'private_address' : undefined;
  }
  return 'not_allowed';
}

function normaliseHost(host: string): string {
  const lower = host.trim().toLowerCase();
  return lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower;
}

/** A stack frame's file path, or `undefined` for Node's own and native frames. */
function framePath(frame: string): string | undefined {
  const match = /\(?((?:file:\/\/)?\/[^():]+|[A-Za-z]:\\[^():]+):\d+:\d+\)?\s*$/.exec(frame);
  const raw = match?.[1];
  if (!raw) return undefined;
  if (raw.startsWith('file://')) {
    try {
      return fileURLToPath(raw);
    } catch {
      return undefined;
    }
  }
  return raw;
}

/** This module's own frames say nothing about who called. */
const OWN_FILE = /pluginEgressGuard\.[cm]?[jt]s$/;

/**
 * The plugin whose code made the request, from a stack trace; `undefined`
 * for the kernel. Pure.
 */
export function attributeStack(
  stack: string,
  roots: ReadonlyArray<{ readonly root: string; readonly pluginId: string }>,
): string | undefined {
  const withSep = roots.map((r) => ({ prefix: r.root.endsWith(path.sep) ? r.root : r.root + path.sep, pluginId: r.pluginId }));
  for (const frame of stack.split('\n').slice(1)) {
    const file = framePath(frame);
    if (!file || OWN_FILE.test(file)) continue;
    const owner = withSep.find((r) => file.startsWith(r.prefix));
    if (owner) return owner.pluginId;
    // A dependency of the kernel (undici, an SDK) carries on to its caller.
    if (file.includes(`${path.sep}node_modules${path.sep}`)) continue;
    return undefined;
  }
  return undefined;
}

/** Frames enough to reach past an SDK's own layers to the plugin's code. */
const STACK_FRAMES = 64;

function captureStack(): string {
  const previous = Error.stackTraceLimit;
  Error.stackTraceLimit = STACK_FRAMES;
  try {
    return new Error().stack ?? '';
  } finally {
    Error.stackTraceLimit = previous;
  }
}

function hostOfFetchInput(input: unknown): string | undefined {
  try {
    if (typeof input === 'string') return new URL(input).hostname;
    if (input instanceof URL) return input.hostname;
    if (input !== null && typeof input === 'object' && 'url' in input) {
      const url = (input as { url: unknown }).url;
      return typeof url === 'string' ? new URL(url).hostname : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function hostOfRequestArgs(args: readonly unknown[]): string | undefined {
  const [first, second] = args;
  if (typeof first === 'string' || first instanceof URL) {
    try {
      return new URL(String(first)).hostname;
    } catch {
      return undefined;
    }
  }
  const options = (first ?? second) as Record<string, unknown> | undefined;
  if (!options || typeof options !== 'object') return undefined;
  if (typeof options['socketPath'] === 'string') return undefined;
  const hostname = options['hostname'] ?? options['host'];
  if (typeof hostname !== 'string' || hostname.length === 0) return 'localhost';
  // `host` may carry a port; an IPv6 literal is bracketed when it does.
  if (hostname.startsWith('[')) return hostname.slice(1, hostname.indexOf(']'));
  return isIP(hostname) === 6 ? hostname : (hostname.split(':')[0] ?? hostname);
}

interface GuardState {
  mode: PluginEgressMode;
  source: PluginEgressSource | undefined;
  onObservation: ((o: PluginEgressObservation & { readonly mode: PluginEgressMode }) => void) | undefined;
  readonly observed: Map<string, { observation: PluginEgressObservation; count: number }>;
  restore: (() => void) | undefined;
}

const STATE_SLOT = Symbol.for('omadia.platform.pluginEgressGuard');

function state(): GuardState {
  const slots = globalThis as unknown as Record<symbol, GuardState | undefined>;
  const existing = slots[STATE_SLOT];
  if (existing) return existing;
  const created: GuardState = { mode: 'observe', source: undefined, onObservation: undefined, observed: new Map(), restore: undefined };
  slots[STATE_SLOT] = created;
  return created;
}

/**
 * The check behind every guarded entry: throws {@link PluginEgressRefusedError}
 * in `enforce` mode, records in `observe` mode, returns otherwise. Any fault
 * of the guard itself lets the request through: the guard never takes the
 * kernel's own network down.
 */
function check(host: string | undefined): void {
  const s = state();
  const source = s.source;
  if (!source || host === undefined) return;
  let refusal: PluginEgressObservation | undefined;
  try {
    const roots = source.pluginRoots();
    if (roots.length === 0) return;
    const pluginId = attributeStack(captureStack(), roots);
    if (pluginId === undefined) return;
    const permission = source.permissionOf(pluginId) ?? { isModelPlugin: false, hosts: [], publicWeb: false };
    const reason = decideEgress(permission, host, source.modelProviderHosts());
    if (reason === undefined) return;
    refusal = { pluginId, host: normaliseHost(host), reason };
  } catch {
    return;
  }
  const key = `${refusal.pluginId} ${refusal.host} ${refusal.reason}`;
  const seen = s.observed.get(key);
  if (seen) seen.count += 1;
  else {
    s.observed.set(key, { observation: refusal, count: 1 });
    s.onObservation?.({ ...refusal, mode: s.mode });
  }
  if (s.mode === 'enforce') throw new PluginEgressRefusedError(refusal.pluginId, refusal.host, refusal.reason);
}

type AnyFn = (...args: unknown[]) => unknown;

/**
 * Install the guard on `globalThis.fetch` and `node:http(s)`'s `request` and
 * `get`. Idempotent: a second call only updates mode, source and listener.
 */
export function installPluginEgressGuard(options: {
  readonly mode: PluginEgressMode;
  readonly source: PluginEgressSource;
  readonly onObservation?: (o: PluginEgressObservation & { readonly mode: PluginEgressMode }) => void;
}): void {
  const s = state();
  s.mode = options.mode;
  s.source = options.source;
  s.onObservation = options.onObservation;
  if (s.restore) return;

  const originalFetch = globalThis.fetch;
  const guardedFetch = function fetch(this: unknown, input: unknown, init?: unknown): Promise<Response> {
    try {
      check(hostOfFetchInput(input));
    } catch (err) {
      return Promise.reject(err);
    }
    return (originalFetch as AnyFn).call(this, input, init) as Promise<Response>;
  };
  globalThis.fetch = guardedFetch as typeof globalThis.fetch;

  const patched: Array<{ module: Record<string, unknown>; name: string; original: unknown }> = [];
  for (const mod of [http, https] as unknown as Array<Record<string, unknown>>) {
    for (const name of ['request', 'get']) {
      const original = mod[name] as AnyFn;
      patched.push({ module: mod, name, original });
      mod[name] = function guarded(this: unknown, ...args: unknown[]): unknown {
        check(hostOfRequestArgs(args));
        return original.apply(this, args);
      };
    }
  }
  // ESM named imports (`import { request } from 'node:https'`) read the
  // builtin's exports as they were synced last.
  syncBuiltinESMExports();

  s.restore = () => {
    if (globalThis.fetch === guardedFetch) globalThis.fetch = originalFetch;
    for (const p of patched) p.module[p.name] = p.original;
    syncBuiltinESMExports();
  };
}

/** What the guard saw so far, with counts (observe and enforce alike). */
export function pluginEgressObservations(): ReadonlyArray<PluginEgressObservation & { readonly count: number }> {
  return [...state().observed.values()].map((e) => ({ ...e.observation, count: e.count }));
}

export function pluginEgressMode(): PluginEgressMode {
  return state().mode;
}

/** Tests only: uninstall and forget. */
export function resetPluginEgressGuardForTests(): void {
  const s = state();
  s.restore?.();
  s.restore = undefined;
  s.source = undefined;
  s.onObservation = undefined;
  s.mode = 'observe';
  s.observed.clear();
}
