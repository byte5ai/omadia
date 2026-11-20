import type { ModelWorkKind } from './modelWorkRuns.js';

/**
 * Spec 2042 §5.10 — every operator job and maintenance run the kernel knows,
 * with its budget, deadline and declared effects. A job makes at most
 * `budgetCalls` model calls and stops at `deadlineMs`; the instance's daily
 * budgets cap all of them together (`OPERATOR_TOOLS_DAILY_MODEL_CALLS`,
 * `MAINTENANCE_DAILY_MODEL_CALLS`).
 */

const MINUTE = 60_000;

/** The issue preview: one note reformulated into a draft in a form. */
export const ISSUE_PREVIEW: ModelWorkKind = {
  kind: 'issue_preview',
  context: 'operator_job',
  budgetCalls: 3,
  deadlineMs: 2 * MINUTE,
  effects: ['draft'],
};

/** A skill verification: the verdict on one skill is stored. */
export const SKILL_VERIFICATION: ModelWorkKind = {
  kind: 'skill_verification',
  context: 'operator_job',
  budgetCalls: 5,
  deadlineMs: 5 * MINUTE,
  effects: ['skill_verdict'],
};

/** Topic regrouping: clusters are named and stored as topics. */
export const TOPIC_REGROUPING: ModelWorkKind = {
  kind: 'topic_regrouping',
  context: 'operator_job',
  budgetCalls: 300,
  deadlineMs: 20 * MINUTE,
  effects: ['topics'],
};

/** Bulk promotion: significance of stored memories is updated. */
export const BULK_PROMOTION: ModelWorkKind = {
  kind: 'bulk_promotion',
  context: 'operator_job',
  budgetCalls: 2_000,
  deadlineMs: 60 * MINUTE,
  effects: ['memory_significance'],
};

/** Inconsistency and duplicate detection: review items are created. */
export const MEMORY_REVIEW_DETECTION: ModelWorkKind = {
  kind: 'memory_review_detection',
  context: 'operator_job',
  budgetCalls: 2_000,
  deadlineMs: 60 * MINUTE,
  effects: ['memory_review_items'],
};

/** A memory written or edited through the REST surface (`/api/v1/memory`):
 *  the entry is embedded and the review detectors run on it. The writing
 *  user is the job's actor. */
export const MEMORY_EDIT: ModelWorkKind = {
  kind: 'memory_edit',
  context: 'operator_job',
  budgetCalls: 50,
  deadlineMs: 5 * MINUTE,
  effects: ['memory'],
};

/** The privacy field-classification recompute (boot, plugin (de)activation,
 *  every 6 h, `POST …/field-classification/recompute`): the schema of each
 *  unclassified or stale model is sent to the classifier model, verdicts and
 *  auto-approved non-personal fields are stored. Not a maintenance run,
 *  because it calls `complete`. */
export const FIELD_CLASSIFICATION: ModelWorkKind = {
  kind: 'privacy_field_classification',
  context: 'operator_job',
  budgetCalls: 200,
  deadlineMs: 15 * MINUTE,
  effects: ['privacy_field_classification'],
};

/** One turn of the Plugin Builder's chat: the draft plugin is changed. */
export const PLUGIN_BUILDER_TURN: ModelWorkKind = {
  kind: 'plugin_builder_turn',
  context: 'operator_job',
  budgetCalls: 150,
  deadlineMs: 20 * MINUTE,
  effects: ['plugin_draft'],
};

/** A preview turn of a draft in the Plugin Builder: output in the admin UI only. */
export const PLUGIN_BUILDER_PREVIEW: ModelWorkKind = {
  kind: 'plugin_builder_preview',
  context: 'operator_job',
  budgetCalls: 60,
  deadlineMs: 10 * MINUTE,
  effects: [],
};

/** The auto-fix loop the Plugin Builder starts after a failed build. */
export const PLUGIN_BUILDER_AUTOFIX: ModelWorkKind = {
  kind: 'plugin_builder_autofix',
  context: 'operator_job',
  budgetCalls: 300,
  deadlineMs: 30 * MINUTE,
  effects: ['plugin_draft'],
};

/** One turn of the Conductor's workflow designer: the workflow draft changes. */
export const WORKFLOW_DESIGNER_TURN: ModelWorkKind = {
  kind: 'workflow_designer_turn',
  context: 'operator_job',
  budgetCalls: 100,
  deadlineMs: 15 * MINUTE,
  effects: ['workflow_draft'],
};

/** One sweep of the embedding backfill: vectors of stored items are written. */
export const EMBEDDING_BACKFILL: ModelWorkKind = {
  kind: 'embedding_backfill',
  context: 'maintenance_run',
  budgetCalls: 5_000,
  deadlineMs: 10 * MINUTE,
  effects: ['embeddings'],
};
