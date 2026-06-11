import type { PluginContext } from '@omadia/plugin-api';

import { validateTree, validateSurfaceEvent } from './validator.js';

/**
 * @omadia/canvas-core — generic protocol plugin (kind: extension).
 *
 * Provides the canonical canvas protocol validator as a kernel service so any
 * agent plugin that PRODUCES canvas trees (e.g. @omadia/agent-x-studio) can
 * declare `depends_on: ["@omadia/canvas-core"]` + `requires:
 * ["canvasValidator@^1"]` and validate against ONE canonical contract instead
 * of vendoring its own schema copy. validateTree/validateSurfaceEvent are
 * precompiled standalone (no eval / no runtime schema path), so the service is
 * available the moment this plugin activates.
 *
 * TypeScript consumers additionally import the protocol types directly from the
 * `@omadia/canvas-core` package (compile-time only).
 */

export const CANVAS_VALIDATOR_SERVICE = 'canvasValidator';

export interface CanvasValidatorService {
  validateTree: typeof validateTree;
  validateSurfaceEvent: typeof validateSurfaceEvent;
}

export interface CanvasCorePluginHandle {
  close(): Promise<void>;
}

export async function activate(ctx: PluginContext): Promise<CanvasCorePluginHandle> {
  const service: CanvasValidatorService = { validateTree, validateSurfaceEvent };
  const dispose = ctx.services.provide(CANVAS_VALIDATOR_SERVICE, service);
  ctx.log('[canvas-core] canvas protocol provided (canvasValidator@1)');

  return {
    async close(): Promise<void> {
      dispose();
    },
  };
}
