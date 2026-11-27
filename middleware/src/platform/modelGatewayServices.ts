import { admitModelCall, type ModelOperation } from '@omadia/llm-provider';
import { isPerCallerService, perCallerService, resolvePerCallerService } from '@omadia/plugin-api';
import { currentExecutionContext, runInExecutionContext } from '@omadia/usage-telemetry';

/**
 * Spec 2042 §5.10 — embedding and transcription models go through the model
 * gateway too.
 *
 * Text generation is gated inside every provider adapter
 * (`admitModelCall('complete')`). The embedding and transcription adapters
 * are plugins that publish a service (`embeddingClient`, `transcription`)
 * with their own clients. Instead of trusting every such adapter to call the
 * gate, the service registry wraps what they publish: every consumer, kernel
 * or plugin, only ever holds the wrapped object, so no embedding or
 * transcription runs past the gate. Everything else on the object (model id,
 * dimensions, provider id) passes through unchanged.
 */

/** Service name → the methods that run the model, and the operation each is. */
const GATED_SERVICES: ReadonlyMap<string, ReadonlyMap<PropertyKey, ModelOperation>> = new Map([
  ['embeddingClient', new Map<PropertyKey, ModelOperation>([['embed', 'embed']])],
  [
    'transcription',
    new Map<PropertyKey, ModelOperation>([
      ['transcribeFile', 'transcribe'],
      ['transcribeStream', 'transcribe'],
    ]),
  ],
  // The decision model (`decisionModel@1`, the Jev model plugin): a small
  // model that picks among options; every call is a `complete` in the
  // caller's context (fast lane, verifier and recall judge in the agent's
  // turn, the significance scorer in its turn or operator job).
  [
    'decisionModel',
    new Map<PropertyKey, ModelOperation>([
      ['choose', 'complete'],
      ['decideAll', 'complete'],
    ]),
  ],
]);

const GATED = Symbol.for('omadia.modelGateway.gated');

/**
 * #1817 / ADR-0194 — gated wrappers whose registration was disposed. A
 * consumer that still holds one (it captured the object before the provider
 * was uninstalled, deactivated or reactivated) gets a refusal instead of a
 * call into the removed adapter: an OpenAI-compatible client keeps its key and
 * base URL after `close()`, so without this a removed provider kept receiving
 * text until a restart.
 */
const withdrawnServices = new WeakSet<object>();

/**
 * #2298 — a per-caller factory registration (`perCallerService`) hands out a
 * fresh object per caller, so withdrawing "the" wrapper cannot reach them.
 * Every object the gated factory hands out carries its registration's token;
 * withdrawing the factory withdraws the token, and with it every object it
 * ever handed out, whoever still holds one.
 */
const registrationTokenOf = new WeakMap<object, object>();
const factoryTokenOf = new WeakMap<object, object>();
const withdrawnTokens = new WeakSet<object>();

function isWithdrawn(proxy: object): boolean {
  if (withdrawnServices.has(proxy)) return true;
  const token = registrationTokenOf.get(proxy);
  return token !== undefined && withdrawnTokens.has(token);
}

/** Raised when a model service is called after its provider withdrew it. */
export class ModelServiceWithdrawnError extends Error {
  constructor(readonly serviceName: string) {
    super(
      `the provider of '${serviceName}' was withdrawn (uninstalled, deactivated or replaced); resolve the service again`,
    );
    this.name = 'ModelServiceWithdrawnError';
  }
}

/**
 * Mark a wrapper returned by {@link gateModelService} as withdrawn. Every
 * later model call through it refuses. No-op for anything that is not a gated
 * wrapper (plain services keep their own lifecycle).
 */
export function withdrawModelService(impl: unknown): void {
  if (impl === null || typeof impl !== 'object') return;
  if ((impl as Record<symbol, unknown>)[GATED] !== true) return;
  const token = factoryTokenOf.get(impl);
  if (token !== undefined) withdrawnTokens.add(token);
  else withdrawnServices.add(impl);
}

/** The bare service name of a registry key (`embeddingClient@2` → `embeddingClient`). */
function baseName(name: PropertyKey): string {
  return typeof name === 'string' ? name.split('@')[0] ?? name : String(name);
}

/**
 * The object the registry stores for `name`: `impl` itself, or for a model
 * service a proxy whose model methods pass the gate first. Idempotent: a
 * wrapper handed back in (a `replace` that decorates the current provider)
 * is not wrapped twice.
 */
export function gateModelService<T>(name: PropertyKey, impl: T): T {
  const methods = GATED_SERVICES.get(baseName(name));
  if (!methods || impl === null || typeof impl !== 'object') return impl;
  if ((impl as Record<symbol, unknown>)[GATED] === true) return impl;
  if (isPerCallerService(impl)) return gatePerCallerFactory(name, impl) as T;
  return gateObject(name, methods, impl);
}

/**
 * #2298 — a per-caller factory of a model service: every object it hands out
 * is gated and tied to this registration, so disposing the registration
 * withdraws them all (ADR-0194 rule 3 for factories).
 */
function gatePerCallerFactory(name: PropertyKey, factory: object): object {
  const methods = GATED_SERVICES.get(baseName(name));
  const token = {};
  const gatedOf = new WeakMap<object, unknown>();
  const gated = perCallerService((caller) => {
    const instance = resolvePerCallerService(factory as Parameters<typeof resolvePerCallerService>[0], caller);
    if (!methods || instance === null || typeof instance !== 'object') return instance;
    const known = gatedOf.get(instance);
    if (known !== undefined) return known;
    const proxy = gateObject(name, methods, instance);
    registrationTokenOf.set(proxy as object, token);
    gatedOf.set(instance, proxy);
    return proxy;
  });
  Object.defineProperty(gated, GATED, { value: true });
  factoryTokenOf.set(gated, token);
  return gated;
}

function gateObject<T>(
  name: PropertyKey,
  methods: ReadonlyMap<PropertyKey, ModelOperation>,
  impl: T,
): T {
  const serviceName = baseName(name);
  const proxy: T = new Proxy(impl as object, {
    get(target, prop, receiver) {
      if (prop === GATED) return true;
      const value = Reflect.get(target, prop, receiver) as unknown;
      const operation = methods.get(prop);
      if (operation === undefined || typeof value !== 'function') return value;
      return function gated(this: unknown, ...args: unknown[]): unknown {
        if (isWithdrawn(proxy as object)) {
          const refusal = new ModelServiceWithdrawnError(serviceName);
          if (prop === 'transcribeStream') throw refusal;
          return Promise.reject(refusal);
        }
        if (prop === 'transcribeStream') {
          // An async iterable: the gate runs when the stream is called, like
          // a provider's `stream()`.
          admitModelCall(operation);
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        }
        try {
          admitModelCall(operation);
        } catch (err) {
          return Promise.reject(err);
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as T;
  return proxy;
}

/**
 * Spec 2042 §5.10 — inbound processing: what a channel plugin does with a
 * message before the addressed agent's turn. Two kernel services are used
 * that way: `transcription.transcribeFile` (a voice message) and
 * `topicDetector.classify` (does the message start a new topic, which
 * decides how much history the turn gets). The service a channel plugin
 * resolves runs those methods in an `inbound_processing` context owned by
 * that channel, with only the operations they need, when no other context is
 * around the call. Inside an agent turn or an execution scope (a live
 * session) the call stays that context's. The context comes from the
 * kernel, which knows the caller is a channel plugin; the plugin cannot name
 * one itself.
 */
const INBOUND_METHODS: ReadonlyMap<string, { readonly method: string; readonly operations: readonly ModelOperation[] }> =
  new Map([
    ['transcription', { method: 'transcribeFile', operations: ['transcribe'] as const }],
    ['topicDetector', { method: 'classify', operations: ['embed', 'complete'] as const }],
  ]);

/** Whether a channel plugin's resolve of `name` is wrapped as inbound processing. */
export function isInboundProcessingService(name: string): boolean {
  return INBOUND_METHODS.has(baseName(name));
}

export function inboundProcessing<T>(name: string, impl: T, channelPluginId: string): T {
  const spec = INBOUND_METHODS.get(baseName(name));
  if (!spec || impl === null || typeof impl !== 'object') return impl;
  return new Proxy(impl as object, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (prop !== spec.method || typeof value !== 'function') return value;
      return function inbound(this: unknown, ...args: unknown[]): unknown {
        const call = (): Promise<unknown> => (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        if (currentExecutionContext()) return call();
        return runInExecutionContext(
          { kind: 'inbound_processing', ownerId: channelPluginId, operations: spec.operations },
          call,
        );
      };
    },
  }) as T;
}

/** The transcription case of {@link inboundProcessing}. */
export function inboundTranscription<T>(impl: T, channelPluginId: string): T {
  return inboundProcessing('transcription', impl, channelPluginId);
}
