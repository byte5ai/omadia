import { Router } from 'express';
import type { Request, Response } from 'express';

import { getLastTurnOutcome } from '../platform/lastTurnOutcome.js';

/**
 * OM-100b — `GET /api/v1/admin/last-turn`.
 *
 * The Systemstatus cards each answer a configuration question ("is a
 * credential present", "is an agent configured") and were all green through a
 * beta round in which every turn died. This endpoint adds the runtime
 * question: did the last chat turn come back, and if not, which error class
 * was it. `null` means no turn has run since the process started — an honest
 * "unknown", not a green light.
 */
export function createAdminLastTurnRouter(): Router {
  const router = Router();

  router.get('/', (_req: Request, res: Response) => {
    res.json({ lastTurn: getLastTurnOutcome() ?? null });
  });

  return router;
}
