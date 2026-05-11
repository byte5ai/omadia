/**
 * Registry for extension-contributed system-prompt blocks.
 *
 * Today the top-level Orchestrator's system prompt is assembled in-place
 * from (a) a hardcoded preamble with integrity rules, (b) a list of
 * registered DomainTools, (c) a per-turn ContextRetriever block, and
 * (d) the current date header. Two of those (integrity rules referencing
 * the Verifier by name, ContextRetriever's "Früher besprochene Entitäten"
 * block) are logically owned by extension concerns (Verifier, KG) that will
 * live in their own packages post-extraction.
 *
 * This registry is the seam. A PromptContributor returns either a **static**
 * block (registered once, cached) or a **per-turn dynamic** block (resolved
 * every turn — the ContextRetriever's pattern). Ordering is explicit via
 * priority: lower priority sorts earlier in the prompt. Ties break by
 * registration order.
 *
 * v1 (this file): registry exists, nothing registers yet. The existing
 * Orchestrator prompt-assembly logic stays byte-for-byte identical — that
 * migration happens in Phase 4 (KG) and Phase 5 (Verifier), at which point
 * those packages register their contributions here and the kernel stops
 * hardcoding them.
 *
 * Caching note: the Orchestrator caches system blocks across iterations
 * within one turn for prompt-caching hits on Anthropic's side. A contributor
 * that returns identical text across the same turn preserves that property.
 * A contributor returning turn-dependent text (e.g. ContextRetriever) is
 * fine too — the orchestrator calls the registry once per turn before the
 * tool loop and holds the resolved blocks byte-identical across iterations.
 */

export interface PromptContributionContext {
  readonly turnId: string;
  readonly sessionScope?: string;
  readonly userId?: string;
  readonly userMessage: string;
  readonly freshCheck?: boolean;
}

export type PromptContributor = (
  ctx: PromptContributionContext,
) => string | undefined | Promise<string | undefined>;

interface ContributorEntry {
  readonly contribute: PromptContributor;
  readonly priority: number;
  readonly label: string;
}

export interface PromptContributionRegistration {
  readonly contribute: PromptContributor;
  /** Lower priority sorts earlier. Default 100 (kernel integrity rules sit
   *  below 100, extensions typically in 100–200, date header above 200). */
  readonly priority?: number;
  /** Diagnostic label — shown in logs when the contributor throws. */
  readonly label: string;
}

export class PromptContributionRegistry {
  private readonly entries: ContributorEntry[] = [];

  constructor(
    private readonly log: (msg: string, err: unknown) => void = (msg, err) => {
      const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      console.error(`${msg}: ${detail}`);
    },
  ) {}

  register(reg: PromptContributionRegistration): () => void {
    const entry: ContributorEntry = {
      contribute: reg.contribute,
      priority: reg.priority ?? 100,
      label: reg.label,
    };
    this.entries.push(entry);
    this.entries.sort((a, b) => a.priority - b.priority);
    return () => {
      const idx = this.entries.indexOf(entry);
      if (idx >= 0) this.entries.splice(idx, 1);
    };
  }

  /** Collect every contributor's block for this turn. Blocks are returned
   *  in priority order. Failing contributors are logged and skipped — a
   *  broken extension must not block the turn. */
  async collect(ctx: PromptContributionContext): Promise<string[]> {
    const out: string[] = [];
    for (const entry of this.entries) {
      try {
        const block = await entry.contribute(ctx);
        if (typeof block === 'string' && block.trim().length > 0) {
          out.push(block);
        }
      } catch (err) {
        this.log(`[prompt-contribution] ${entry.label} threw`, err);
      }
    }
    return out;
  }

  labels(): readonly string[] {
    return this.entries.map((e) => e.label);
  }

  count(): number {
    return this.entries.length;
  }
}
