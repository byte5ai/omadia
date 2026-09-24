/**
 * OM-101 — the builder's "no LLM access" verdict, as a class the UI can act on.
 *
 * The round-5 tester ran omadia purely on a Claude subscription, with no API
 * key anywhere. The orchestrator has handled that since round 4; the plugin
 * builder had not caught up. It resolved every Anthropic-family model to the
 * metered API client and the first turn came back as
 * `[builder] turn … ask failed: 401 API key is invalid` — for a key that was
 * never supposed to exist. The message pointed at a problem the operator could
 * not fix, because there was nothing wrong with their setup.
 *
 * Two things follow. The resolver now falls back to the subscription CLI when
 * one is logged in (see `resolveBuilderProvider`), and when no access exists at
 * all the failure carries a code instead of a vendor string, so the UI can say
 * what is actually missing.
 */
export const BUILDER_LLM_ACCESS_MISSING_CODE = 'llm_access_missing';

export class BuilderLlmAccessError extends Error {
  readonly code = BUILDER_LLM_ACCESS_MISSING_CODE;

  constructor(message: string) {
    super(message);
    this.name = 'BuilderLlmAccessError';
  }
}

/**
 * The event `code` the builder + preview streams emit for this failure.
 * Namespaced like the sibling `builder.model_unavailable` so one switch in the
 * UI covers both.
 */
export const BUILDER_LLM_ACCESS_EVENT_CODE = 'builder.llm_access_missing';

/** Pick the stream event code for a resolver failure. */
export function builderResolverErrorCode(err: unknown): string {
  return err instanceof BuilderLlmAccessError
    ? BUILDER_LLM_ACCESS_EVENT_CODE
    : 'builder.model_unavailable';
}
