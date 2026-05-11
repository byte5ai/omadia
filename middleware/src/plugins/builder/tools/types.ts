import type { z } from 'zod';

import type { DraftStore } from '../draftStore.js';
import type { SlotTypecheckService } from '../slotTypecheckPipeline.js';
import type { SpecEventBus } from '../specEventBus.js';

/**
 * Resolves catalog tool names that newly-built agents must not collide with.
 * Returns the union of orchestrator-native tool names and reserved-prefix
 * matches from the platform's installed/built-in tools at call time.
 */
export type CatalogToolNamesProvider = () => readonly string[];

/**
 * Resolves the set of plugin ids known to the platform — built-in
 * plugins + everything currently in the install catalog. Used by the
 * B.8 manifestLinter to validate `spec.depends_on` cross-refs.
 */
export type KnownPluginIdsProvider = () => readonly string[];

/**
 * Schedules a debounced preview rebuild for a draft. Wraps
 * `PreviewRebuildScheduler.schedule` so tests can inject a spy without
 * spinning up the full scheduler.
 */
export interface RebuildScheduler {
  schedule(userEmail: string, draftId: string): void;
}

/**
 * Per-call context passed to every Builder tool. The BuilderAgent constructs
 * one of these for each turn (with `userEmail`/`draftId` pinned) and hands it
 * to every tool the LLM invokes within that turn.
 */
export interface ReferenceCatalogEntry {
  /** Absolute path to the reference root. */
  readonly root: string;
  /** Short human description shown by `list_references`. */
  readonly description: string;
}

/**
 * Per-turn counter for `fill_slot` failures (B.7-4). The BuilderAgent
 * creates a fresh tracker each turn so the agent's retry budget resets
 * between user messages. `fill_slot` calls `recordFail(slotKey)` after
 * a failed gate run; if the returned attempt count crosses the
 * configured ceiling (default 3), the tool emits an `agent_stuck` event
 * exactly once and lets the LLM stop on its own. On a clean tsc run,
 * `reset(slotKey)` is called so subsequent failures start counting from
 * zero again.
 */
export interface SlotRetryTracker {
  recordFail(slotKey: string): number;
  reset(slotKey: string): void;
}

/**
 * Per-turn budget for *consecutive* slot-typecheck failures across all
 * slots in the same turn. Orthogonal to `SlotRetryTracker` (which counts
 * fails per slotKey): this counter cuts off the agent when it churns
 * through different slots without any of them ever turning green —
 * the runaway-loop pattern observed in Theme E1 (draft 6fe00ba1) where
 * the agent hallucinated SDK methods, tsc kept failing, and the loop
 * only stopped at `maxIterations`.
 *
 * `recordFail()` returns the new consecutive count. `reset()` is called
 * on every successful slot-typecheck so a working slot wipes the budget.
 * When the count crosses the configured ceiling, `fill_slot` returns an
 * Error: result that the bridge converts into a `tool_use` stop signal.
 */
export interface BuildFailureBudget {
  recordFail(): number;
  reset(): void;
  readonly limit: number;
}

export interface BuilderToolContext {
  readonly userEmail: string;
  readonly draftId: string;
  readonly draftStore: DraftStore;
  readonly bus: SpecEventBus;
  readonly rebuildScheduler: RebuildScheduler;
  readonly catalogToolNames: CatalogToolNamesProvider;
  /** Provider for installed/built-in plugin ids — used by the B.8
   *  manifestLinter to resolve `spec.depends_on` entries. */
  readonly knownPluginIds: KnownPluginIdsProvider;
  /** Per-turn `fill_slot` retry counter (B.7-4). */
  readonly slotRetryTracker: SlotRetryTracker;
  /**
   * Per-turn cap on *consecutive* slot-typecheck failures. Cuts off the
   * agent when it can't make any slot pass tsc — addresses the runaway
   * loop where the agent hallucinated SDK methods and burned 11+ build
   * iterations without convergence.
   */
  readonly buildFailureBudget: BuildFailureBudget;
  /**
   * Absolute path to the build template root (`<templateRoot>` —
   * matches the path used by `BuildPipeline`/`SlotTypecheckPipeline`).
   * Used by `list_package_types` / `read_package_types` to resolve
   * package metadata from the shared `<templateRoot>/node_modules`
   * (per-staging dirs symlink back to the same install).
   */
  readonly templateRoot: string;
  /**
   * Read-only reference catalog: name → { root, description }. The
   * `read_reference` tool accepts a `name` and resolves the file relative
   * to the matching `root`. `list_references` returns the catalog so the
   * LLM can pick the closest existing implementation (e.g. an
   * HTTP-integration agent for an API-integration draft, not just the
   * SEO-analyst). Override in tests.
   *
   * The first key is treated as the default when the LLM omits the
   * `name` field on `read_reference`.
   */
  readonly referenceCatalog: Readonly<Record<string, ReferenceCatalogEntry>>;
  /**
   * tsc-gate fed by `fill_slot` (B.7-2). After persisting a slot, the tool
   * runs codegen → staging → tsc against the freshly produced file map and
   * surfaces any errors to the agent so it can self-correct in the same
   * turn — without waiting for the (debounced) preview rebuild.
   */
  readonly slotTypechecker: SlotTypecheckService;
  /**
   * The user's most recent chat message for this turn, if available. The
   * Content-Guard (B.7-3) inside `patch_spec` uses this string to detect
   * explicit removal intent — if a removed tool/capability/depends_on
   * id appears as a substring in the user's message, the silent-removal
   * guard is bypassed.
   */
  readonly userMessage?: string;
}

/**
 * A Builder tool — pure data + run-fn. Schemas use Zod so the BuilderAgent
 * can convert them to JSON-Schema for Anthropic's `tool_use` request body.
 *
 * The run-fn returns a JSON-serializable result; the BuilderAgent JSON-
 * stringifies it for the LLM and emits a `tool_result` event for the UI.
 */
export interface BuilderTool<I = unknown, O = unknown> {
  readonly id: string;
  readonly description: string;
  readonly input: z.ZodType<I>;
  run(input: I, ctx: BuilderToolContext): Promise<O>;
}
