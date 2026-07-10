// Workflow template-provenance hint (#478). Split out of templateRoutes.ts
// purely for file size — consumed by the workflow list/detail routes in
// routes.ts.

import type { ConductorWorkflow } from './workflowStore.js';
import type { ConductorRouterDeps } from './routes.js';

/** Template-provenance hint on the workflow wire shape (#478, additive).
 *  `updateAvailable` is true only while the template stays visible to the
 *  viewer AND carries a newer manifest version than the one instantiated. */
export interface WorkflowTemplateHint {
  id: string;
  version: number;
  latestVersion: number;
  updateAvailable: boolean;
}

export type WorkflowWithTemplateHint = ConductorWorkflow & { template?: WorkflowTemplateHint };

/**
 * Decorate workflow rows carrying template provenance with the update hint.
 * One catalog list per call (not per row); viewer-scoped, so a template the
 * viewer cannot see degrades to `latestVersion = version, updateAvailable:
 * false` instead of leaking its existence. Best-effort: a catalog failure
 * returns the rows undecorated — the hint is informational, never load-bearing.
 */
export async function attachTemplateHints(
  workflows: ConductorWorkflow[],
  deps: Pick<ConductorRouterDeps, 'templateCatalog'>,
  viewer: string,
): Promise<WorkflowWithTemplateHint[]> {
  if (!deps.templateCatalog || !workflows.some((wf) => typeof wf.templateId === 'string')) return workflows;
  let latestById: Map<string, number>;
  try {
    latestById = new Map((await deps.templateCatalog.list(viewer)).map((s) => [s.id, s.latestVersion]));
  } catch (err) {
    console.warn('[conductor] template hint lookup failed:', err instanceof Error ? err.message : String(err));
    return workflows;
  }
  return workflows.map((wf) => {
    if (typeof wf.templateId !== 'string') return wf;
    const version = wf.templateVersion ?? 1;
    const latest = latestById.get(wf.templateId);
    return {
      ...wf,
      template: {
        id: wf.templateId,
        version,
        latestVersion: latest ?? version,
        updateAvailable: latest !== undefined && latest > version,
      },
    };
  });
}
