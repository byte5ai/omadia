import type { EmbeddingClient } from '@omadia/plugin-api';

/**
 * #1815 / ADR-0194 — where a consumer gets its embedding client from.
 *
 * Either a fixed client (tests, callers that own one) or a resolver that is
 * asked on EVERY use. The plugin passes the resolver: the active
 * `embeddingClient@1` provider can be reactivated, switched or uninstalled
 * while this plugin stays up, and a client captured in `activate()` would
 * keep the boot answer until the next restart — recall, merge and
 * contradiction detection and topic detection all ran without vectors after
 * a successful "Reactivate provider", and with the previous model after a
 * switch.
 *
 * A resolver that returns `undefined` means "no provider right now", which
 * every consumer treats exactly like the old absent client: skip the vector
 * leg, no error.
 */
export type EmbeddingClientSource =
  | EmbeddingClient
  | (() => EmbeddingClient | undefined);

/** The client to use for THIS call, or `undefined` when none is published. */
export function currentEmbeddingClient(
  source: EmbeddingClientSource | undefined,
): EmbeddingClient | undefined {
  return typeof source === 'function' ? source() : source;
}
