/**
 * AI-Act Art. 50 — the channel-agnostic carrier for the AI disclosure in the
 * outgoing contract. Issue #643 (epic #642).
 *
 * The disclosure is HARNESS-owned, computed OUTSIDE the LLM's output stream: a
 * model can ignore a system-prompt instruction and the persona config overrides
 * it anyway (epic #642), so the marking lives here, behind the model, in the
 * outgoing contract. Two carriers, deliberately:
 *
 *   - the structured {@link AiDisclosure} → `SemanticAnswer.aiDisclosure`, for
 *     channels with a rich UI (badge, footer);
 *   - the same line folded into `SemanticAnswer.text` — the ONE field every
 *     connector MUST render (outgoing.ts) — so the marking reaches the wire-only
 *     channels (Teams, Telegram, Slack, Discord, WhatsApp) that have no
 *     provenance slot. Direct precedent: `withMcpInputPrompt` folds a card into
 *     `text` for the same "honest degradation" reason (toSemanticAnswer.ts).
 *
 * This module ships the reusable primitives — the shipping-default policy, the
 * DE/EN text composer, the first-turn-per-scope fold decision and the
 * apply step. Per-turn resolution (which channel, which locale, operator setup
 * fields) is wired in the orchestrator in #644; the machine-readable envelope
 * marker for the API/MCP paths is the separate #647 (provenance.ts).
 */

/**
 * Disclosure verbosity. `'off'` is reachable ONLY through explicit operator
 * configuration — never the shipping default, and not settable from within a
 * turn (a turn does not construct an operator-sourced policy; only the
 * operator's instance config does). See {@link applyAiDisclosure}, which
 * refuses an `'off'` that is not operator-sourced.
 */
export type AiDisclosureLevel = 'standard' | 'concise' | 'off';

/**
 * The structured disclosure carried on `SemanticAnswer.aiDisclosure`. Built by
 * the harness, never by the model. Present on every turn the disclosure is
 * active (even when the line is NOT folded into `text` — see the
 * `directLineSession` rationale in outgoing.ts: a field that appears only when
 * folded cannot tell a client the state is still active). Absent only when an
 * operator turned it `'off'`.
 */
export interface AiDisclosure {
  /** The composed, ready-to-render disclosure line (the same text folded into
   *  `SemanticAnswer.text`). Plain text — no markup a screen reader would trip on. */
  readonly text: string;
  /** The active level. `'off'` never appears here — an off policy produces no
   *  {@link AiDisclosure} at all. */
  readonly level: Exclude<AiDisclosureLevel, 'off'>;
  /** The locale the line was composed in, normalized to `'de'` / `'en'`. Lets a
   *  rich-UI channel label or localize its own chrome around the line. */
  readonly locale: string;
  /** Where the effective level came from: the shipping default, or the
   *  operator's instance config. Makes a deviation from the delivered state
   *  visible instead of silent (epic #642). */
  readonly source: 'default' | 'operator';
}

/**
 * The operator-resolvable policy for one channel. The shipping default is
 * {@link DEFAULT_AI_DISCLOSURE_POLICY}; an operator overrides `level`, `locale`
 * and, by doing so, flips `source` to `'operator'`. Per-channel resolution
 * (operator config → a policy per channel) and the setup fields that feed it
 * land with the orchestrator in #644; this module carries the shape and the
 * shipping default only.
 */
export interface AiDisclosurePolicy {
  readonly level: AiDisclosureLevel;
  readonly source: 'default' | 'operator';
  /** Operator locale override; absent → the per-turn / channel locale, then `'de'`. */
  readonly locale?: string;
}

/**
 * The delivered state: active, standard verbosity, and `source: 'default'` so a
 * later operator override is distinguishable from it. Frozen so no caller can
 * mutate the value every path shares (same guard as ENVELOPE_PROVENANCE in
 * provenance.ts).
 */
export const DEFAULT_AI_DISCLOSURE_POLICY: AiDisclosurePolicy = Object.freeze({
  level: 'standard',
  source: 'default',
});

/**
 * Records which conversation scopes have already been shown the folded
 * disclosure, so it is folded into `text` only on the FIRST turn of a scope
 * (the structured field still rides every turn). Deliberately tiny — the kernel
 * wires a concrete instance in #644.
 *
 * Fail-safe is the CALLER's contract, not the store's: {@link applyAiDisclosure}
 * folds whenever the store is absent, the scope is unknown, or `hasSeen` throws.
 * A missing disclosure is a compliance gap; a repeated one is only noise —
 * so on any doubt we repeat.
 */
export interface DisclosureSeenStore {
  /** True when this scope has already had the disclosure folded into `text`. */
  hasSeen(scope: string): boolean;
  /** Mark this scope as having had the disclosure folded in. */
  markSeen(scope: string): void;
}

/**
 * Process-local {@link DisclosureSeenStore}. A restart clears it — which is the
 * fail-safe direction: the next turn per scope folds again rather than skipping
 * the marking. Mirrors the in-memory store pattern channel-sdk already ships
 * (InMemoryConversationHistoryStore).
 */
export class InMemoryDisclosureSeenStore implements DisclosureSeenStore {
  readonly #seen = new Set<string>();
  hasSeen(scope: string): boolean {
    return this.#seen.has(scope);
  }
  markSeen(scope: string): void {
    this.#seen.add(scope);
  }
}

/** Options for {@link composeDisclosureText}. */
export interface ComposeDisclosureOptions {
  /**
   * Assistant display name to weave into the sentence when the operator gave
   * the assistant one. The shipping default is name-less — a generic
   * AI-system disclosure that is correct without any configuration.
   */
  readonly assistantName?: string;
}

/**
 * Normalize an arbitrary locale tag to the two languages this module composes.
 * DE is the shipping default (the assistant is German-first — cf. the German
 * `withMcpInputPrompt` block); any non-`en` or unknown tag resolves to `'de'`,
 * never to an empty or accidentally-English line.
 */
function normalizeLocale(locale: string | undefined): 'de' | 'en' {
  return locale !== undefined && /^en\b/i.test(locale) ? 'en' : 'de';
}

/**
 * Compose the disclosure line in DE or EN, plain text. `level` excludes `'off'`
 * at the type level — an off policy never reaches text composition.
 */
export function composeDisclosureText(
  locale: string | undefined,
  level: Exclude<AiDisclosureLevel, 'off'>,
  opts: ComposeDisclosureOptions = {},
): string {
  const lang = normalizeLocale(locale);
  const name = opts.assistantName?.trim();
  switch (level) {
    case 'concise':
      return lang === 'en' ? 'AI-generated.' : 'KI-generiert.';
    case 'standard':
      if (lang === 'en') {
        return name
          ? `This response was generated by ${name}, an AI system.`
          : 'This response was generated by an AI system.';
      }
      return name
        ? `Diese Antwort wurde von ${name}, einem KI-System, erzeugt.`
        : 'Diese Antwort wurde von einem KI-System erzeugt.';
  }
}

/** Inputs to {@link applyAiDisclosure}. All optional — the zero-config call
 *  resolves the shipping default and folds it (AC1). */
export interface ApplyAiDisclosureContext {
  /** Resolved operator policy for this channel; absent → the shipping default. */
  readonly policy?: AiDisclosurePolicy;
  /** A disclosure the orchestrator already resolved this turn (#644). When
   *  present it is used verbatim and `policy` is not consulted — the single
   *  derivation, reused (cf. deriveAgentsConsulted). */
  readonly disclosure?: AiDisclosure;
  /** Per-turn locale; absent → the policy locale, then `'de'`. */
  readonly locale?: string;
  /** Conversation scope for the first-turn fold decision. */
  readonly scope?: string;
  /** Seen-store backing the first-turn fold decision. */
  readonly seen?: DisclosureSeenStore;
  /** Assistant display name to weave into the line. */
  readonly assistantName?: string;
}

/** Result of {@link applyAiDisclosure}: the (possibly folded) text plus the
 *  structured field to forward. `aiDisclosure` is omitted only for an
 *  operator `'off'`. */
export interface ApplyAiDisclosureResult {
  readonly text: string;
  readonly aiDisclosure?: AiDisclosure;
}

/** Resolve the structured disclosure from a policy, enforcing the `'off'`
 *  invariant. Returns `undefined` only for a legitimate operator `'off'`. */
function resolveFromPolicy(ctx: ApplyAiDisclosureContext): AiDisclosure | undefined {
  const policy = ctx.policy ?? DEFAULT_AI_DISCLOSURE_POLICY;
  // AC2: `'off'` is reachable ONLY through explicit operator configuration. An
  // off policy that is not operator-sourced (the shipping default is never off;
  // a turn cannot silence itself) is not a legitimate opt-out — fall back to the
  // shipping default rather than honour it.
  const effective =
    policy.level === 'off' && policy.source !== 'operator' ? DEFAULT_AI_DISCLOSURE_POLICY : policy;
  if (effective.level === 'off') return undefined;
  const locale = normalizeLocale(ctx.locale ?? effective.locale);
  return Object.freeze({
    text: composeDisclosureText(locale, effective.level, {
      ...(ctx.assistantName !== undefined ? { assistantName: ctx.assistantName } : {}),
    }),
    level: effective.level,
    locale,
    source: effective.source,
  });
}

/**
 * Decide whether to fold the disclosure line into `text` this turn. Folds on the
 * first turn of a scope; suppresses it thereafter (the structured field still
 * rides every turn). Fail-safe: an undeterminable scope — no scope, no store, or
 * a throwing store (restart, unknown backend, corrupt state) — folds. (AC3)
 */
function shouldFold(scope: string | undefined, seen: DisclosureSeenStore | undefined): boolean {
  if (scope === undefined || seen === undefined) return true;
  try {
    if (seen.hasSeen(scope)) return false;
    seen.markSeen(scope);
    return true;
  } catch {
    return true;
  }
}

/** Fold the disclosure line into the answer as its own paragraph — the same
 *  honest-degradation fold `withMcpInputPrompt` uses so the line never runs
 *  into the model's prose. */
function foldDisclosure(answer: string, line: string): string {
  return answer.trim().length > 0 ? `${answer}\n\n${line}` : line;
}

/**
 * The single per-turn derivation: resolve the structured {@link AiDisclosure}
 * (from a pre-resolved value, else the policy — shipping default when none) and
 * fold its line into `text` on the first turn of the scope.
 *
 * Zero-config (`applyAiDisclosure(answer)`) resolves the shipping default and
 * folds it — the marking is present with no configuration at all (AC1). An
 * operator `'off'` returns the answer untouched and no structured field (AC2).
 * An undeterminable scope folds rather than omits (AC3).
 */
export function applyAiDisclosure(
  answer: string,
  ctx: ApplyAiDisclosureContext = {},
): ApplyAiDisclosureResult {
  const aiDisclosure = ctx.disclosure ?? resolveFromPolicy(ctx);
  if (aiDisclosure === undefined) return { text: answer };
  const text = shouldFold(ctx.scope, ctx.seen) ? foldDisclosure(answer, aiDisclosure.text) : answer;
  return { text, aiDisclosure };
}
