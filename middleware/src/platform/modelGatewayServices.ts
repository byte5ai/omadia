import { admitModelCall, type ModelOperation } from '@omadia/llm-provider';

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
]);

const GATED = Symbol.for('omadia.modelGateway.gated');

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
  return new Proxy(impl as object, {
    get(target, prop, receiver) {
      if (prop === GATED) return true;
      const value = Reflect.get(target, prop, receiver) as unknown;
      const operation = methods.get(prop);
      if (operation === undefined || typeof value !== 'function') return value;
      return function gated(this: unknown, ...args: unknown[]): unknown {
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
}
