import { fillSlotTool } from './fillSlot.js';
import { lintSpecTool } from './lintSpec.js';
import { listCatalogToolsTool } from './listCatalogTools.js';
import { listPackageTypesTool } from './listPackageTypes.js';
import { listReferencesTool } from './listReferences.js';
import { patchSpecTool } from './patchSpec.js';
import { readPackageTypesTool } from './readPackageTypes.js';
import { readReferenceTool } from './readReference.js';
import { setPersonaConfigTool } from './setPersonaConfig.js';
import { setQualityConfigTool } from './setQualityConfig.js';
import { suggestDependsOnTool } from './suggestDependsOn.js';
import type { BuilderTool } from './types.js';

export type {
  BuilderTool,
  BuilderToolContext,
  BuildFailureBudget,
  RebuildScheduler,
  CatalogToolNamesProvider,
  KnownPluginIdsProvider,
  ReferenceCatalogEntry,
  SlotRetryTracker,
} from './types.js';
export type { LintIssue, LintSeverity } from './lintSpec.js';
export {
  fillSlotTool,
  lintSpecTool,
  listCatalogToolsTool,
  listPackageTypesTool,
  listReferencesTool,
  patchSpecTool,
  readPackageTypesTool,
  readReferenceTool,
  setPersonaConfigTool,
  setQualityConfigTool,
  suggestDependsOnTool,
};

/**
 * Canonical ordered list of all Builder tools — exposed to the BuilderAgent
 * (B.4-3) to convert into Anthropic `tool_use` definitions.
 */
export function builderTools(): ReadonlyArray<BuilderTool<unknown, unknown>> {
  return [
    patchSpecTool as unknown as BuilderTool<unknown, unknown>,
    fillSlotTool as unknown as BuilderTool<unknown, unknown>,
    lintSpecTool as unknown as BuilderTool<unknown, unknown>,
    listCatalogToolsTool as unknown as BuilderTool<unknown, unknown>,
    listReferencesTool as unknown as BuilderTool<unknown, unknown>,
    readReferenceTool as unknown as BuilderTool<unknown, unknown>,
    listPackageTypesTool as unknown as BuilderTool<unknown, unknown>,
    readPackageTypesTool as unknown as BuilderTool<unknown, unknown>,
    setQualityConfigTool as unknown as BuilderTool<unknown, unknown>,
    setPersonaConfigTool as unknown as BuilderTool<unknown, unknown>,
    suggestDependsOnTool as unknown as BuilderTool<unknown, unknown>,
  ];
}
