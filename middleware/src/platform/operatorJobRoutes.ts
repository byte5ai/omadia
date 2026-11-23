// Spec 2042 §5.10, criterion 37 — the admin functions that call a model, each
// one operator job (`modelWorkRuns.ts`): the Agent Builder's skill
// verification, the Plugin Builder's turns and previews, the workflow
// designer, and the memory and issue tools. None of them is an agent: a job
// has an actor (the operator), a budget, a deadline and declared effects, and
// its model calls are admitted by the gateway in that context.
//
// Mounted by the kernel ahead of the routers that implement them (only POSTs
// start a job), so the job wraps the rest of the request.

import {
  BULK_PROMOTION,
  ISSUE_PREVIEW,
  MEMORY_REVIEW_DETECTION,
  PLUGIN_BUILDER_PREVIEW,
  PLUGIN_BUILDER_TURN,
  SKILL_VERIFICATION,
  TOPIC_REGROUPING,
  WORKFLOW_DESIGNER_TURN,
} from './modelWorkKinds.js';
import type { ModelWorkKind } from './modelWorkRuns.js';

export const OPERATOR_JOB_ROUTES: readonly (readonly [string, ModelWorkKind])[] = [
  ['/api/v1/issues/preview', ISSUE_PREVIEW],
  ['/api/v1/admin/bulk-promote', BULK_PROMOTION],
  ['/api/v1/admin/topics/recluster', TOPIC_REGROUPING],
  ['/api/v1/admin/inconsistencies/bulk-detect', MEMORY_REVIEW_DETECTION],
  ['/api/v1/admin/inconsistencies/detect', MEMORY_REVIEW_DETECTION],
  ['/api/v1/admin/duplicates/bulk-detect', MEMORY_REVIEW_DETECTION],
  ['/api/v1/admin/duplicates/detect', MEMORY_REVIEW_DETECTION],
  ['/api/v1/admin/duplicates/excerpts/bulk-detect', MEMORY_REVIEW_DETECTION],
  ['/api/v1/admin/duplicates/excerpts/detect', MEMORY_REVIEW_DETECTION],
  // The Agent Builder (`routes/agentBuilder.ts`): its one model-backed step
  // is the verdict on a skill.
  ['/api/v1/operator/skills/:id/verdict/llm-scan', SKILL_VERIFICATION],
  ['/api/v1/operator/skills/import', SKILL_VERIFICATION],
  ['/api/v1/operator/skills', SKILL_VERIFICATION],
  ['/api/v1/operator/skills/:id/fork', SKILL_VERIFICATION],
  // The Plugin Builder.
  ['/api/v1/builder/drafts/:id/turn', PLUGIN_BUILDER_TURN],
  ['/api/v1/builder/drafts/:id/preview/chat/turn', PLUGIN_BUILDER_PREVIEW],
  ['/api/v1/builder/drafts/:id/preview/tool-call', PLUGIN_BUILDER_PREVIEW],
  ['/api/v1/operator/conductors/builder/turn', WORKFLOW_DESIGNER_TURN],
];
