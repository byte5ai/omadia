import { Router, type Request, type Response } from 'express';

import { modelGatewayMode, uncoveredModelCalls } from '@omadia/usage-telemetry';

import { pluginEgressMode, pluginEgressObservations } from '../platform/pluginEgressGuard.js';

/**
 * Spec 2042 §5.10 — what the model gateway and the plugin network sandbox
 * saw since the process started, for the operator and for the contract
 * step: before `MODEL_GATEWAY_MODE` and `PLUGIN_EGRESS_MODE` go to
 * `enforce`, both lists must be empty on the live instance.
 *
 *   GET /api/v1/admin/model-gateway
 */
export function createModelGatewayStatusRouter(): Router {
  const router = Router();
  router.get('/', (_req: Request, res: Response) => {
    const uncovered = [...uncoveredModelCalls()].map(([key, count]) => {
      const space = key.indexOf(' ');
      return { operation: key.slice(0, space), site: key.slice(space + 1), count };
    });
    res.json({
      model_gateway: { mode: modelGatewayMode(), calls_outside_context: uncovered },
      plugin_egress: {
        mode: pluginEgressMode(),
        observations: pluginEgressObservations().map((o) => ({
          plugin_id: o.pluginId,
          host: o.host,
          reason: o.reason,
          count: o.count,
        })),
      },
    });
  });
  return router;
}
