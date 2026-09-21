/**
 * OM-102 — which LLM the background memory features run on.
 *
 * WHAT WAS WRONG
 * --------------
 * This plugin resolved exactly one provider — `llm_provider` defaulted to
 * `anthropic` — and did it with a bare `resolveLlmProvider({providerId,
 * getSecret})`, i.e. WITHOUT the kernel's `llmProviderCatalog`. Two bugs fell
 * out of that on a subscription-only install (round-5 beta):
 *
 *   1. Nobody ever assigns `llm_provider` on THIS plugin — the operator
 *      assigns the orchestrator and reasonably expects memory to follow. So
 *      the candidate stayed `anthropic`, no key existed, and FactExtractor,
 *      TopicDetector and the scratch-promotion reaper all stayed off while a
 *      perfectly usable `claude-cli` subscription sat right there.
 *   2. Even WITH the assignment, a catalog-less resolve of `claude-cli` picks
 *      the `openai-compatible` wire format (the non-anthropic default) and
 *      then throws on the missing baseURL. The descriptor that says
 *      `wireFormat: 'claude-cli'` and `requiresApiKey: false` lives in the
 *      catalog, which was never passed.
 *
 * THE CHAIN
 * ---------
 * Candidates in intent order:
 *   1. explicit `llm_provider` on this plugin — the operator asking directly;
 *   2. `anthropic`, but ONLY when this plugin's own vault scope holds the key
 *      (see `ownScopeAnthropic`) — so an install that already pays for a key
 *      is not silently migrated onto a subscription quota;
 *   3. the orchestrator's assignment, read through the kernel's cross-plugin
 *      config reader, because this plugin activates BEFORE the orchestrator
 *      and cannot ask it directly. This is the step that fixes the abo case;
 *   4. `anthropic` as the historical default.
 * The first candidate that any source can actually build wins.
 *
 * Sources in credential order: this plugin's OWN vault scope first (that is
 * where `anthropic_api_key` has always been stored), then the kernel pool,
 * which reads the orchestrator's scope and holds the catalog. Keyless
 * providers such as `claude-cli` resolve from either.
 *
 * NOTE on capability: `claude-cli` serves ONLY completions and forced
 * single-tool structured output (`claudeCliAdapter.ts` throws on a general
 * tool loop). All three consumers here — FactExtractor, TopicDetector,
 * significance scorer — issue a plain `complete()` with a JSON/keyword
 * instruction and no `tools`, so they are inside that envelope.
 */
import type { LlmProvider } from '@omadia/llm-provider';

/** The historical default, kept as the last candidate. */
export const DEFAULT_EXTRAS_PROVIDER_ID = 'anthropic';

/** The one method this module needs from an `LlmProviderPool`. Structural so a
 *  test passes a two-line stub and the real pool fits without a cast. */
export interface ProviderSource {
  /** A label for the log line — which credential scope answered. */
  readonly label: string;
  get(providerId: string): Promise<LlmProvider | undefined>;
}

export interface ProviderCandidateInput {
  /** `llm_provider` configured on THIS plugin, if any. */
  readonly configured?: string | undefined;
  /**
   * This plugin's own vault scope can build the Anthropic default — i.e. the
   * operator stored `anthropic_api_key` here.
   *
   * WHY IT OUTRANKS THE INHERITED ASSIGNMENT: without it, an existing install
   * that has a paid Anthropic key on this plugin AND an orchestrator on
   * `claude-cli` would silently migrate three background jobs off the key it
   * pays for and onto the operator's personal Claude subscription quota — a
   * spend/quota change nobody asked for, announced only by a log line. An
   * explicitly-configured `llm_provider` still wins over both: that IS the
   * operator asking.
   */
  readonly ownScopeAnthropic?: boolean;
  /** `llm_provider` configured on the orchestrator plugin, if readable. */
  readonly orchestrator?: string | undefined;
}

const clean = (value: string | undefined): string | undefined => {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

/**
 * The ordered, de-duplicated candidate chain. Always non-empty: the Anthropic
 * default terminates it, so a host with neither assignment behaves exactly as
 * it did before OM-102.
 */
export function buildProviderCandidates(
  input: ProviderCandidateInput,
): readonly string[] {
  const ordered = [
    clean(input.configured),
    // See `ownScopeAnthropic` — keeps a pre-OM-102 install on the key it
    // already pays for instead of migrating it onto a subscription quota.
    input.ownScopeAnthropic === true ? DEFAULT_EXTRAS_PROVIDER_ID : undefined,
    clean(input.orchestrator),
    DEFAULT_EXTRAS_PROVIDER_ID,
  ].filter((id): id is string => id !== undefined);
  return Object.freeze([...new Set(ordered)]);
}

export interface ResolvedExtrasProvider {
  readonly provider: LlmProvider;
  readonly providerId: string;
  /** Which `ProviderSource` built it — diagnostics only. */
  readonly source: string;
}

export interface ResolveExtrasProviderInput {
  readonly candidates: readonly string[];
  readonly sources: readonly ProviderSource[];
  readonly log?: (message: string) => void;
}

/**
 * First candidate that any source can build, candidate-major: an explicit
 * assignment on this plugin outranks the orchestrator's no matter which vault
 * scope happens to hold the credential.
 *
 * A source that THROWS (e.g. an openai-compatible id with no baseURL) is
 * logged and skipped rather than failing activation — one misconfigured
 * candidate must not take the whole memory pipeline down when a later
 * candidate would have worked.
 */
export async function resolveExtrasLlmProvider(
  input: ResolveExtrasProviderInput,
): Promise<ResolvedExtrasProvider | undefined> {
  for (const providerId of input.candidates) {
    for (const source of input.sources) {
      try {
        const provider = await source.get(providerId);
        if (provider) return { provider, providerId, source: source.label };
      } catch (err) {
        input.log?.(
          `[harness-orchestrator-extras] provider '${providerId}' via ${source.label} failed to build: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }
  return undefined;
}
