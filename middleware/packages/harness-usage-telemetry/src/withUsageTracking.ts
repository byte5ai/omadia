/**
 * Wraps an Anthropic client so every non-streaming `messages.create` call is
 * recorded by the usage telemetry singleton, transparently. Used for the
 * background Haiku callers (verifier ClaimExtractor/EvidenceJudge, the
 * orchestrator-extras scorers/extractors) that call `.messages.create()`
 * directly and would otherwise discard the `usage` block.
 *
 * The orchestrator + sub-agent STREAMING path is recorded separately inside
 * `streamMessageEvents`, where the final usage and model are already in hand —
 * so this wrapper only needs to cover `.create`. `.stream` and every other
 * client method/property pass through untouched.
 *
 * Implemented with nested Proxies so the wrapped client is a drop-in for the
 * real one: identical surface, only `.messages.create` is intercepted.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { normalizeUsage } from './pricing.js';
import { recordUsage } from './recorder.js';

export interface UsageTrackingOptions {
  /** Logical origin tag stored on each row (e.g. 'verifier', 'extras'). */
  readonly source: string;
  readonly tenantId?: string | undefined;
}

// The Anthropic SDK's create() is heavily overloaded; we only need to observe
// the resolved Message, so we treat the boundary loosely and re-narrow.
/* eslint-disable @typescript-eslint/no-explicit-any */

function wrapMessages(messages: any, opts: UsageTrackingOptions): any {
  return new Proxy(messages, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== 'create' || typeof value !== 'function') return value;

      return function create(this: unknown, ...args: any[]): any {
        const result = value.apply(target, args);
        // create() returns a Promise<Message> in the non-streaming path.
        if (result && typeof result.then === 'function') {
          return result.then((message: any) => {
            try {
              const model = (args[0]?.model ?? message?.model ?? 'unknown') as string;
              if (message?.usage) {
                recordUsage({
                  source: opts.source,
                  model,
                  tenantId: opts.tenantId,
                  ...normalizeUsage(message.usage),
                });
              }
            } catch {
              // Telemetry must never disturb the call.
            }
            return message;
          });
        }
        return result;
      };
    },
  });
}

/**
 * Returns a usage-tracking proxy over `client`. The original is not mutated.
 */
export function withUsageTracking(
  client: Anthropic,
  opts: UsageTrackingOptions,
): Anthropic {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'messages' && value && typeof value === 'object') {
        return wrapMessages(value, opts);
      }
      return value;
    },
  }) as Anthropic;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
