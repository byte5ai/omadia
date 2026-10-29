import {
  PRIVACY_REDACT_SERVICE_NAME,
  type PluginContext,
  type PrivacyGuardService,
} from '@omadia/plugin-api';
import { type ChatTurnInput, type DataRef } from '@omadia/channel-sdk';
import {
  createRecipeStore,
  createTurnLearner,
  DEFAULT_TIME_ZONE,
  FAST_PATH_SERVICE,
  parseBooleanSetting,
  parseRefreshSource,
  type FastPathService,
  type RecipeStore,
  type RefreshSource,
  type TurnLearner,
} from '@omadia/fast-path';

import { LEGACY_PLANS_PATH } from './canvasProtocol.js';
import { CANVAS_PUBLISH_TOOL } from './canvasPublishHandlers.js';
import { COMPOSER_REASONING, type CompositionLlm, type DataRequirement } from './composition.js';
import { mintDataRef } from './dataRef.js';
import { deriveDatasetRecipe, readDatasetPublish, type ProvenanceStash } from './datasetRecipe.js';
import { createVariantRegistry, parseVariant, type VariantRegistry } from './recipeVariant.js';

/**
 * The shared per-activation context of the canvas turn paths: the composition
 * llm + model, the tools accessor, the canvas-output / deterministic-action
 * allow-sets, the lazily resolved fast-path service, the refresh-recipe store,
 * the recipe-variant registry and the synthesis callbacks built on them.
 * Created ONCE in `activate()`; every turn module takes it as its first arg.
 */

/** A lazily evaluated tool-name allow-set. */
export interface ToolNameSet {
  has(name: string): boolean;
}

export interface CanvasRuntime {
  readonly ctx: PluginContext;
  /** composition model ref (`ui_orchestrator_model`, default `class:fast`) */
  readonly model: string;
  readonly llm: CompositionLlm;
  readonly toolsAccessor: PluginContext['tools'] | undefined;
  readonly canvasOutputTools: ToolNameSet;
  readonly deterministicActionTools: ToolNameSet;
  readonly refreshRecipes: RecipeStore;
  readonly variants: VariantRegistry;
  /** `fast_path_variant_actions` — deterministic month variants on/off */
  readonly derivedVariantsEnabled: boolean;
  canvasFastPath(): FastPathService | undefined;
  fastPathTimeZone(): string;
  migrateLegacyPlans(fp: FastPathService): Promise<void>;
  makeLearner(
    fp: FastPathService | undefined,
    input: ChatTurnInput,
    requirements: readonly DataRequirement[],
    privacyForced: boolean,
  ): TurnLearner | undefined;
  captureSource(canvasSessionId: string): (containerId: string, raw: unknown) => DataRef | undefined;
  registerVariants(canvasSessionId: string): (containerId: string, actions: readonly unknown[]) => void;
  deriveSource(data: unknown): RefreshSource | undefined;
}

/** What `activate()` resolves before the runtime is built. */
export interface CanvasRuntimeDeps {
  model: string;
  toolsAccessor: PluginContext['tools'] | undefined;
  canvasOutputTools: ToolNameSet;
  deterministicActionTools: ToolNameSet;
  publishProvenance: ProvenanceStash;
}

export function createCanvasRuntime(ctx: PluginContext, deps: CanvasRuntimeDeps): CanvasRuntime {
  const { model, toolsAccessor, canvasOutputTools, deterministicActionTools, publishProvenance } = deps;
  const llm: CompositionLlm = ctx.llm ?? {
    complete: () => Promise.reject(new Error('llm unavailable')),
  };

  // Deterministic fast path (`fastPath@1`, @omadia/fast-path): the
  // allow-list/kill switch (`fast_path_tools`), the channel filter
  // (`fast_path_channels` — token `canvas`), the timezone and the ONE
  // tenant-wide learned plan store shared with every other channel. Resolved
  // LAZILY per turn (activation order is not guaranteed); absent, or the
  // canvas filtered out → no fast path, no learning: the agent answers.
  const fastPathService = (): FastPathService | undefined =>
    (ctx.services as PluginContext['services'] | undefined)?.get<FastPathService>(FAST_PATH_SERVICE);
  const canvasFastPath = (): FastPathService | undefined => {
    const fp = fastPathService();
    return fp?.channelEnabled('canvas') === true ? fp : undefined;
  };
  /** `{today}` tokens in fast-path/refresh recipes resolve in this zone. */
  const fastPathTimeZone = (): string => fastPathService()?.timeZone ?? DEFAULT_TIME_ZONE;
  // Plans learned before the store moved to @omadia/fast-path live in THIS
  // plugin's memory (`fastpath/plans.json`): imported once into the shared
  // store on the first canvas turn that sees the service, then emptied.
  let legacyPlansMigrated = false;
  async function migrateLegacyPlans(fp: FastPathService): Promise<void> {
    if (legacyPlansMigrated) return;
    legacyPlansMigrated = true;
    const memory = ctx.memory as PluginContext['memory'] | undefined;
    if (!memory) return;
    try {
      if (!(await memory.exists(LEGACY_PLANS_PATH))) return;
      const raw = await memory.readFile(LEGACY_PLANS_PATH);
      const added = await fp.plans.importPlans(raw);
      await memory.writeFile(
        LEGACY_PLANS_PATH,
        JSON.stringify({ schemaVersion: 1, plans: [], migratedTo: '@omadia/fast-path' }),
      );
      ctx.log(`[ui-orchestrator] legacy learned plans migrated to @omadia/fast-path: ${added}`);
    } catch (err) {
      ctx.log(`[ui-orchestrator] legacy learned plans not migrated: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const makeLearner = (
    fp: FastPathService | undefined,
    input: ChatTurnInput,
    requirements: readonly DataRequirement[],
    privacyForced: boolean,
  ): TurnLearner | undefined => {
    if (
      fp === undefined ||
      privacyForced ||
      input.action !== undefined ||
      input.target !== undefined ||
      input.userMessage.trim().length === 0
    ) {
      return undefined;
    }
    // the stored example is masked through the Privacy Shield's stored-text
    // scope (resolved lazily — activation order is not guaranteed); without
    // it no example is stored (failure-closed, learningCapture.ts)
    const privacy = (ctx.services as PluginContext['services'] | undefined)?.get<PrivacyGuardService>(
      PRIVACY_REDACT_SERVICE_NAME,
    );
    const openScope = privacy?.openStoredTextScope?.bind(privacy);
    return createTurnLearner({
      question: input.userMessage,
      requirements,
      isProducerTool: (name) => name === CANVAS_PUBLISH_TOOL,
      store: fp.plans,
      ...(openScope ? { openStoredTextScope: openScope } : {}),
      log: (m) => ctx.log(m),
    });
  };
  ctx.log(
    `[omadia-ui-orchestrator] composer reasoning: effort=${COMPOSER_REASONING.effort} ` +
      `thinking=${COMPOSER_REASONING.thinking} (hints; the provider applies them where the model supports them)`,
  );

  // LLM-free refresh recipes (omadia-ui#5 phase 2): captured at publish time
  // from the `source` param, replayed via ctx.tools.invoke on canvas_refresh.
  // Persisted per canvas session in THIS plugin's memory (bounded, loaded
  // lazily on the session's first stream after a restart) so a deploy keeps
  // every table's query for refresh and row actions; without ctx.memory
  // in-process only. A recipe-less canvas falls back to the agent path.
  // Plugin-wide tree: a canvas session's recipes must not depend on which
  // Agent answers its turns (the per-Agent view resolves per turn).
  const refreshRecipes = createRecipeStore({
    ...(ctx.memory ? { memory: ctx.memory.pluginWide ?? ctx.memory } : {}),
    log: (m) => ctx.log(m),
  });

  const captureSource = (canvasSessionId: string) => (containerId: string, raw: unknown) => {
    const source = parseRefreshSource(raw);
    if (!source) return undefined;
    refreshRecipes.set(canvasSessionId, containerId, source);
    ctx.log(`[canvas-refresh] recipe captured: ${containerId} via ${source.tool}`);
    // announce refreshability to the client (surface_data_ref_created)
    return mintDataRef(canvasSessionId, containerId);
  };

  // Recipe variants of suggested actions (recipeVariant.ts): registered at
  // publish, looked up + validated against the CURRENT recipe on the click.
  const variants = createVariantRegistry();
  // Deterministic month variants on fast-path tables (previous/next month):
  // LLM-free, derived from the table's own recipe. Default ON (the client
  // keeps "Details anzeigen" next to suggested actions and sends
  // `recipe_variant` clicks); `fast_path_variant_actions` false/off turns
  // them off.
  const derivedVariantsEnabled = parseBooleanSetting(ctx.config?.get<unknown>('fast_path_variant_actions'), true);
  const registerVariants =
    (canvasSessionId: string) =>
    (containerId: string, actions: readonly unknown[]): void => {
      for (const a of actions) {
        const o = (typeof a === 'object' && a !== null ? a : {}) as { id?: unknown; variant?: unknown };
        const variant = parseVariant(o.variant);
        if (typeof o.id === 'string' && variant) variants.set(canvasSessionId, containerId, o.id, variant);
      }
    };

  /** Derived recipe for an agent datasetId publish without a declared
   *  `source` (datasetRecipe.ts) — synthesis then captures it like a declared
   *  one (persisted, dataRef minted) and the learner sees it as the map. */
  const deriveSource = (data: unknown): RefreshSource | undefined => {
    const pub = readDatasetPublish(data);
    if (pub === undefined) return undefined;
    const derived = deriveDatasetRecipe(publishProvenance.take(pub.datasetId), pub.paths);
    if (!derived.ok) {
      ctx.log(`[fast-path] recipe-skip container=${pub.containerId} reason=${derived.reason}`);
      return undefined;
    }
    ctx.log(`[fast-path] recipe derived container=${pub.containerId} tool=${derived.source.tool}`);
    return derived.source;
  };

  return {
    ctx,
    model,
    llm,
    toolsAccessor,
    canvasOutputTools,
    deterministicActionTools,
    refreshRecipes,
    variants,
    derivedVariantsEnabled,
    canvasFastPath,
    fastPathTimeZone,
    migrateLegacyPlans,
    makeLearner,
    captureSource,
    registerVariants,
    deriveSource,
  };
}
