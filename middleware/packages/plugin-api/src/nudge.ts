/**
 * `nudgeRegistry@1` — capability contract for the Palaia Phase-8 Nudge-Pipeline.
 *
 * Phase-8 (OB-77) closes the gap between Phase-2 (implicit turn-stream capture)
 * and Phase-7 (explicit agent-driven `write_process`). After every tool_result
 * the orchestrator runs a pipeline of `NudgeProvider`s. Providers inspect the
 * turn (tool-trace, KG-state, processMemory) and may emit a single `Nudge`
 * which is appended to the tool_result content as a `<nudge>` block. The agent
 * (or the channel renderer) acts on it via the optional CTA.
 *
 * HARD-INVARIANTS (siehe HANDOFF-2026-05-08-palaia-phase-8):
 * 1. **Read-only service access** — providers receive typed read-only
 *    services (`NudgeStateReader`, optional `ProcessMemoryService` for
 *    canonical-hash lookups). They MUST NOT mutate state. Mutations go
 *    through `NudgeStateStore` (orchestrator-internal) or via the
 *    published Service capability the CTA invokes (e.g. `processMemory.write`).
 *    Note: deviation from the HANDOFF sketch which proposed a raw `pg.Pool` —
 *    consuming services keeps `plugin-api` driver-free, matching the
 *    `processMemory@1` precedent.
 * 2. **50 ms hard timeout per `evaluate`** — slow providers are skipped (and
 *    logged), the pipeline does not wait. Providers needing heavier work
 *    (embeddings, LLM calls) precompute via background jobs and only
 *    cache-read in `evaluate`.
 * 3. **Tenant-scoped state** — the `NudgeStateStore` provider holds the
 *    tenantId from the boot context; consumers see only `(agentId, nudgeId)`.
 * 4. **No PII in hint strings** — providers reference domains/templates,
 *    never user-names or other personal data.
 * 5. **Pipeline emits at most 1 nudge per tool-call**, capped at 3 per turn —
 *    enforced by the pipeline, not by individual providers.
 *
 * Provider for the durable store: `harness-knowledge-graph-neon`. A
 * `NoopNudgeStateStore` lives here so backends without a persistent schema
 * can publish the capability without consumers needing a special-case branch.
 */

import type { ProcessMemoryService } from './processMemory.js';

export const NUDGE_REGISTRY_SERVICE_NAME = 'nudgeRegistry';
export const NUDGE_REGISTRY_CAPABILITY = 'nudgeRegistry@1';

export const NUDGE_STATE_SERVICE_NAME = 'nudgeStateStore';
export const NUDGE_STATE_CAPABILITY = 'nudgeStateStore@1';

/**
 * Side-channel service for plugins that activate BEFORE the orchestrator
 * but want to contribute providers. The orchestrator pulls this list at
 * its own activate-time and merges entries into its NudgeRegistry —
 * solves the activation-order problem (orchestrator-extras publishes
 * `contextRetriever@1` which the orchestrator needs, so extras runs
 * first; without this side-channel the orchestrator's registry would be
 * empty at the moment extras tries to register against it). Service
 * value is a `readonly NudgeProvider[]`.
 */
export const NUDGE_PROVIDERS_SERVICE_NAME = 'nudgeProviders';
export const NUDGE_PROVIDERS_CAPABILITY = 'nudgeProviders@1';

/**
 * Parsed shape of a `<nudge>` block, suitable for channel renderers.
 * Mirrors the on-the-wire XML emitted by `serialiseNudge` in the
 * orchestrator pipeline. Channel renderers (Web NudgeCard, Teams
 * Adaptive-Card) consume this instead of parsing XML themselves.
 */
export interface ParsedNudge {
  readonly id: string;
  readonly text: string;
  readonly cta?: NudgeCta;
}

export interface NudgeParseResult {
  /** The tool_result content with the `<nudge>...</nudge>` block(s) removed. */
  readonly cleaned: string;
  /**
   * The first parsed nudge, if one was found. Pipeline emits at most one
   * per tool_result, so this is the common case; if multiple ever appear
   * the renderer can still split on the cleaned/parsed contract.
   */
  readonly nudge: ParsedNudge | null;
}

const NUDGE_BLOCK_REGEX = /<nudge\s+id="([^"]+)">\s*<text>([\s\S]*?)<\/text>(?:\s*<cta\s+label="([^"]+)"\s+tool="([^"]+)">\s*([\s\S]*?)\s*<\/cta>)?\s*<\/nudge>/;

function decodeXml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

/**
 * Extract the first `<nudge>` block from `content`. Returns the cleaned
 * content (with the block removed) and the parsed structure. Returns
 * `{ cleaned: content, nudge: null }` when no block is present —
 * channel renderers can call this unconditionally.
 *
 * The parser is forgiving by design: malformed nudge XML is left in
 * place rather than dropped, so an upstream serialisation bug doesn't
 * silently swallow data the agent might still surface.
 */
export function parseNudge(content: string): NudgeParseResult {
  if (!content.includes('<nudge ')) {
    return { cleaned: content, nudge: null };
  }
  const match = NUDGE_BLOCK_REGEX.exec(content);
  if (!match) {
    return { cleaned: content, nudge: null };
  }
  const [block, idAttr, textBody, ctaLabel, ctaTool, ctaArgsJson] = match;
  const id = decodeXml(idAttr ?? '');
  const text = decodeXml((textBody ?? '').trim());

  let cta: NudgeCta | undefined;
  if (ctaLabel !== undefined && ctaTool !== undefined && ctaArgsJson !== undefined) {
    try {
      const args = JSON.parse(ctaArgsJson) as Record<string, unknown>;
      cta = {
        label: decodeXml(ctaLabel),
        toolCall: { name: decodeXml(ctaTool), arguments: args },
      };
    } catch {
      // Malformed JSON in CTA args — fall back to text-only nudge.
      cta = undefined;
    }
  }

  const cleaned = (
    content.slice(0, match.index) + content.slice(match.index + (block ?? '').length)
  ).replace(/\n{3,}/g, '\n\n').trimEnd();

  const parsed: ParsedNudge = cta ? { id, text, cta } : { id, text };
  return { cleaned, nudge: parsed };
}

/**
 * Hard timeout per `provider.evaluate` call. Providers that exceed this
 * are skipped + logged. Originally 50 ms per the HANDOFF sketch, bumped
 * to 500 ms after the live boot-smoke showed `processMemory.query` (the
 * lead heuristic's dedup probe) reliably blowing past 50 ms — embedding
 * compute + Neon round-trip on a cold cache routinely takes 100-300 ms.
 * Providers needing more should still race their own work against this
 * cap (see `ProcessPromoteProvider` for the intra-provider timeout
 * pattern: probe with a sub-budget, fall through on miss).
 */
export const NUDGE_PROVIDER_TIMEOUT_MS = 500;

/** Maximum number of nudges that may be emitted within a single agent turn. */
export const NUDGE_MAX_PER_TURN = 3;

/** Maximum number of nudges that may be emitted per tool-call. Hard 1 per the eckpfeiler. */
export const NUDGE_MAX_PER_TOOL_CALL = 1;

/** Default suppress duration triggered by the channel-side "don't show again" link. */
export const NUDGE_SUPPRESS_DEFAULT_DAYS = 7;

/** Successful follows required before a nudge is retired for the (agent, nudge) pair. */
export const NUDGE_RETIRE_AFTER_STREAK = 3;

/** Trigger-matched turns without success_signal before a regression is recorded. */
export const NUDGE_REGRESSION_AFTER_MISSES = 3;

/**
 * CTA the channel renderer surfaces (1-click button on Web, Adaptive-Card
 * Action.Submit on Teams). Triggers the named tool-call with pre-filled args.
 */
export interface NudgeCta {
  readonly label: string;
  readonly toolCall: {
    readonly name: string;
    readonly arguments: Record<string, unknown>;
  };
}

/**
 * Followup-detection: how to recognise that the agent acted on the nudge.
 * Currently only `tool_call_after` is needed; left open as a discriminated
 * union so other kinds (e.g. user-confirmation) can be added without
 * churning consumers.
 */
export type NudgeSuccessSignal = {
  readonly kind: 'tool_call_after';
  readonly toolName: string;
  readonly withinTurns: number;
};

/** What a provider returns when it wants to coach the agent. */
export interface Nudge {
  /** Identical to the emitting `NudgeProvider.id`. Stored for provenance + lifecycle keys. */
  readonly id: string;
  /** Hint text rendered into the `<nudge>` block. Markdown-allowed, PII-free. */
  readonly text: string;
  /** Optional 1-click action. When absent the nudge is text-only. */
  readonly cta?: NudgeCta;
  /** How the pipeline detects whether the nudge was followed. Defaults to none. */
  readonly successSignal?: NudgeSuccessSignal;
  /**
   * Forensic identifier for the underlying workflow (e.g. canonical-query-hash).
   * Persisted on `nudge_emissions.workflow_hash`. Not state-bearing — the
   * retire/regression logic uses `success_streak` global per (agent, nudge_id).
   */
  readonly workflowHash?: string;
}

/** Single tool-call snapshot passed to providers as part of `ReadonlyTurnContext`. */
export interface ReadonlyToolTraceEntry {
  readonly toolName: string;
  readonly args: unknown;
  readonly result: string;
  readonly status: 'ok' | 'error';
  /**
   * Optional domain bucket for trigger heuristics (e.g. `'confluence'`,
   * `'odoo'`, `'memory'`). Populated by the orchestrator when the tool's
   * plugin declares it; otherwise undefined.
   */
  readonly domain?: string;
  /** Wall-clock duration in milliseconds for the tool-call. */
  readonly durationMs?: number;
}

/**
 * Subset of the active turn surface that providers may read. Truly read-only.
 * Tenant-scoping is implementation-internal (the durable store carries the
 * tenantId from boot config); providers + pipeline never see it.
 */
export interface ReadonlyTurnContext {
  readonly turnId: string;
  readonly agentId: string;
  /** The user's verbatim message that started this turn. */
  readonly userMessage: string;
  /** Tool-calls executed so far in this turn (oldest → newest). */
  readonly toolTrace: readonly ReadonlyToolTraceEntry[];
  /** Session-scope used by CTAs that need to write back into `processMemory`. */
  readonly sessionScope: string;
}

/** Persisted lifecycle state per `(agentId, nudgeId)`. Tenant-scoping is store-internal. */
export interface NudgeStateRecord {
  readonly agentId: string;
  readonly nudgeId: string;
  readonly successStreak: number;
  readonly regressionCount: number;
  readonly suppressedUntil: Date | null;
  readonly retiredAt: Date | null;
  readonly lastEmittedAt: Date | null;
  readonly lastFollowedAt: Date | null;
}

/** Append-only audit row. Persisted on emit; later updated to record follow/regression. */
export interface NudgeEmissionRecord {
  readonly agentId: string;
  readonly nudgeId: string;
  readonly turnId: string;
  readonly toolName: string;
  readonly hintText: string;
  readonly workflowHash?: string;
  readonly cta?: NudgeCta;
}

/** Read-only view passed into `provider.evaluate`. Providers cannot mutate state. */
export interface NudgeStateReader {
  read(agentId: string, nudgeId: string): Promise<NudgeStateRecord | null>;
}

/** Full lifecycle surface — used by the pipeline + the channel-side suppress link. */
export interface NudgeStateStore extends NudgeStateReader {
  /** Persist an emission and bump `last_emitted_at` on the state row. */
  recordEmission(record: NudgeEmissionRecord): Promise<void>;
  /**
   * Increment `success_streak`, reset `regression_count`, mark the most
   * recent unfollowed emission for this `(agent, nudge_id)` as followed.
   * When the streak reaches `NUDGE_RETIRE_AFTER_STREAK`, set `retired_at`.
   */
  recordFollow(agentId: string, nudgeId: string, turnId: string): Promise<void>;
  /**
   * Record a missed success-signal: increment `regression_count`, mark the
   * stale emission. Implementations decide how to react when the count
   * hits `NUDGE_REGRESSION_AFTER_MISSES` (typically: extend
   * `suppressed_until`).
   */
  recordRegression(agentId: string, nudgeId: string): Promise<void>;
  /** Channel-side "don't show again" — set `suppressed_until` to `until`. */
  suppress(agentId: string, nudgeId: string, until: Date): Promise<void>;
}

/** Argument bundle passed to `provider.evaluate`. */
export interface NudgeEvaluationInput {
  readonly turnId: string;
  readonly toolName: string;
  readonly toolArgs: unknown;
  readonly toolResult: string;
  readonly turnContext: ReadonlyTurnContext;
  /** Typed as the read-only view; providers cannot mutate lifecycle state. */
  readonly nudgeStateStore: NudgeStateReader;
  /**
   * Optional `processMemory@1` handle. Present when the orchestrator booted
   * with a durable provider; absent on in-memory backends. The lead
   * heuristic uses it for canonical-query-hash + dedup-conflict probes.
   */
  readonly processMemory?: ProcessMemoryService;
}

/**
 * A pluggable nudge source. Stateless in itself — all persistence flows
 * through the `NudgeStateStore` capability. Implementations live in
 * extras packages (`harness-orchestrator-extras` for the built-in
 * `palaia.process-promote`); operators can publish more via plugins.
 */
export interface NudgeProvider {
  /** Stable ID, e.g. `'palaia.process-promote'`. Used as `nudge_id` in the state table. */
  readonly id: string;
  /** Higher numbers run first. Ties broken by `id` ascending. */
  readonly priority: number;
  /** Must resolve within `NUDGE_PROVIDER_TIMEOUT_MS` or the pipeline skips it. */
  evaluate(input: NudgeEvaluationInput): Promise<Nudge | null>;
}

/**
 * Registry surface providers are published to. The orchestrator pipeline
 * reads `list()` once per tool_result and iterates with early-exit.
 */
export interface NudgeRegistry {
  register(provider: NudgeProvider): void;
  /**
   * Sorted snapshot — `priority` desc, `id` asc. Returning a fresh array
   * each call keeps the pipeline insulated from late `register()`s mid-iteration.
   */
  list(): readonly NudgeProvider[];
}

/** Default registry — published by orchestrator boot; plugins call `register`. */
export class InMemoryNudgeRegistry implements NudgeRegistry {
  private readonly providers: NudgeProvider[] = [];

  register(provider: NudgeProvider): void {
    if (this.providers.some((p) => p.id === provider.id)) {
      throw new Error(`NudgeProvider id collision: ${provider.id}`);
    }
    this.providers.push(provider);
  }

  list(): readonly NudgeProvider[] {
    return [...this.providers].sort((a, b) =>
      b.priority !== a.priority
        ? b.priority - a.priority
        : a.id.localeCompare(b.id),
    );
  }
}

/**
 * No-op store — published by backends without a persistent KG (in-memory
 * boot, dev without Neon). Reads return `null`; writes silently swallow.
 * The pipeline still runs providers, but lifecycle never advances —
 * acceptable for ephemeral dev/test contexts.
 */
export class NoopNudgeStateStore implements NudgeStateStore {
  async read(
    _agentId: string,
    _nudgeId: string,
  ): Promise<NudgeStateRecord | null> {
    return null;
  }

  async recordEmission(_record: NudgeEmissionRecord): Promise<void> {
    // intentional no-op
  }

  async recordFollow(
    _agentId: string,
    _nudgeId: string,
    _turnId: string,
  ): Promise<void> {
    // intentional no-op
  }

  async recordRegression(_agentId: string, _nudgeId: string): Promise<void> {
    // intentional no-op
  }

  async suppress(
    _agentId: string,
    _nudgeId: string,
    _until: Date,
  ): Promise<void> {
    // intentional no-op
  }
}
