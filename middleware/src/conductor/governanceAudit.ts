import type { Request } from 'express';

import { auditActorFromRequest, type AuditEntryInput } from '../auth/adminAuditLog.js';
import type { ConductorRouterDeps } from './routes.js';

export async function recordGovernanceAudit(
  deps: Pick<ConductorRouterDeps, 'auditGovernanceChange'>,
  req: Request,
  change: Omit<AuditEntryInput, 'actor'>,
): Promise<void> {
  try {
    await deps.auditGovernanceChange?.({ ...change, actor: auditActorFromRequest(req) });
  } catch (err) {
    console.error('[conductor] governance audit write failed:', err);
  }
}
