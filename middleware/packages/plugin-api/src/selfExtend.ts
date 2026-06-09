/**
 * Plugin self-extension — the plugin-side SDK contract (additive, plugin-api).
 *
 * This is how a hand-written / side-loaded plugin (one WITHOUT a Builder
 * `AgentSpec` draft, e.g. an integration developed in its own repo and uploaded
 * as a ZIP) opts into operator-gated self-extension. The host cannot codegen a
 * new tool into an arbitrary repo — so the plugin itself ships the materialiser:
 *
 *   - `templates`  — declarative, parametric extension points the plugin
 *                    supports (id + params schema + the privilege sub-surface
 *                    each one needs). The host reads these to (a) offer them to
 *                    the operator and (b) prove `requires ⊆ manifest surface`
 *                    in the escalation guard, BEFORE anything is approved.
 *   - `apply()`    — given an APPROVED extension, the plugin's OWN code builds
 *                    the new tool(s) and registers them via `ctx.tools.register`,
 *                    using the SAME capability-scoped `ctx` it always had. The
 *                    non-escalation guarantee is therefore structural: the
 *                    plugin physically cannot exceed its manifest permissions.
 *
 * The host persists approved extensions per plugin and re-invokes `apply()` on
 * every activation, so a self-extension survives restarts without ever writing
 * into the (read-only) package directory.
 *
 * A plugin opts in by exporting `selfExtend` next to `activate`:
 *   export const selfExtend: SelfExtendContract = { templates: [...], apply };
 */

import type { PluginContext } from './pluginContext.js';

/**
 * The privilege sub-surface a template needs, expressed in the SAME vocabulary
 * as the host's permission surface. Every field is OPTIONAL and defaults to
 * least-privilege; the host checks each listed item is covered by the plugin's
 * installed-manifest surface (wildcards honoured). Most read-only templates
 * (thin wrappers over an existing client) require NOTHING here.
 */
export interface ExtensionRequiredSurface {
  readonly graphReads?: readonly string[];
  readonly graphWrites?: readonly string[];
  readonly graphEntitySystems?: readonly string[];
  readonly subAgentCalls?: readonly string[];
  readonly llmModels?: readonly string[];
  readonly networkOutbound?: readonly string[];
  readonly webScanner?: boolean;
}

/** A declarative, parametric extension point a plugin supports. */
export interface ExtensionTemplate {
  /** Stable id, e.g. `"odata.delta"`. Referenced by an approved extension. */
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /**
   * JSON-Schema for the `params` an operator/agent fills (the plugin validates
   * them in `apply`). Kept as a plain object so plugin-api stays validator-free.
   */
  readonly paramsSchema: Record<string, unknown>;
  /**
   * The privilege sub-surface this template needs. MUST be ⊆ the plugin's
   * installed-manifest surface — the escalation guard auto-denies otherwise.
   * Omit (or leave empty) for a template that only wraps existing capabilities.
   */
  readonly requires?: ExtensionRequiredSurface;
}

/** An operator-approved instantiation of a template. Persisted by the host and
 *  replayed into `apply()` on every activation. */
export interface ApprovedExtension {
  readonly templateId: string;
  readonly params: Record<string, unknown>;
}

/**
 * The contract a self-extendable plugin exports as `selfExtend`. `apply` returns
 * a dispose handle the host calls on deactivation (symmetry with `activate`'s
 * close handle).
 */
export interface SelfExtendContract {
  readonly templates: readonly ExtensionTemplate[];
  apply(
    approved: ApprovedExtension,
    ctx: PluginContext,
  ): Promise<() => void> | (() => void);
}
