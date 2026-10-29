import { type PluginContext } from '@omadia/plugin-api';

import {
  CANVAS_CHOICE_TOOL,
  CANVAS_LUMEN_TOOL,
  CANVAS_PUBLISH_TOOL,
  V4_RENDER_TOOL,
} from './canvasPublishHandlers.js';
import { type ToolNameSet } from './canvasRuntime.js';

/** The canvas-output and deterministic-action allow-sets, resolved from the
 *  operator config at activation; the registry halves are looked up LAZILY
 *  per check. */
export interface CanvasAllowSets {
  /** the statically configured canvas-output tools (logged at activation) */
  configuredCanvasOutputTools: ReadonlySet<string>;
  canvasOutputTools: ToolNameSet;
  deterministicActionTools: ToolNameSet;
}

export function resolveCanvasAllowSets(ctx: PluginContext): CanvasAllowSets {
  // Our own producer tools are always authorised; the operator config extends
  // the allow-set with additional sentinel-emitting tools (override path).
  const configuredCanvasOutputTools: ReadonlySet<string> = new Set([
    CANVAS_PUBLISH_TOOL,
    CANVAS_CHOICE_TOOL,
    CANVAS_LUMEN_TOOL,
    // Privacy Shield v4 table renders tap a full `_pendingCanvasTree`
    // snapshot into the raw-sentinel sink (#1402); synthesis must authorise
    // the tool to take it.
    V4_RENDER_TOOL,
    ...(ctx.config?.get<string>('canvas_output_tools') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  ]);
  // Canvas-output autodiscovery (declare → resolve → derive): plugins declare
  // `canvas_output: true` per manifest capability; the kernel resolves those
  // into the `canvasOutputRegistry` service as plugins (de)activate. The
  // lookup is LAZY per check — a plugin installed after this activation is
  // authorised without re-activating the orchestrator. Deny-by-default is
  // unchanged: no declaration + no config entry → sentinel ignored.
  const canvasOutputTools: { has(name: string): boolean } = {
    has: (name: string): boolean =>
      configuredCanvasOutputTools.has(name) ||
      ctx.services
        ?.get<{ has(name: string): boolean }>('canvasOutputRegistry')
        ?.has(name) === true,
  };

  // Deterministic-action allow-set (declare → resolve → derive, same shape as
  // canvas-output): a tool listed here owns a FULLY plugin-determined result —
  // a structured UI action whose `type` names it is dispatched DIRECTLY (no
  // model turn), its `_pendingCanvasTree`/`_pendingSurfacePatch` sentinel
  // synthesised straight into surface events. This is the "the application
  // layer already has this value, don't spend an LLM turn" path: saved-page
  // recalls, status flips, list views. Deny-by-default — a tool not declared
  // here still goes through the agent loop. Operator override via the
  // `deterministic_action_tools` config field; `deterministicActionRegistry`
  // is the forward-compat manifest-autodiscovery hook (absent today = no-op).
  const configuredDeterministicActionTools: ReadonlySet<string> = new Set([
    // A Lumen publish is fully plugin-determined (no data/LLM needed) — when a
    // canvas action names it, dispatch it DIRECTLY so a click renders the Lumen
    // with no model turn (also sidesteps LLM tool-call reliability).
    CANVAS_LUMEN_TOOL,
    ...(ctx.config?.get<string>('deterministic_action_tools') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  ]);
  const deterministicActionTools: { has(name: string): boolean } = {
    has: (name: string): boolean =>
      configuredDeterministicActionTools.has(name) ||
      ctx.services
        ?.get<{ has(name: string): boolean }>('deterministicActionRegistry')
        ?.has(name) === true,
  };
  return { configuredCanvasOutputTools, canvasOutputTools, deterministicActionTools };
}
