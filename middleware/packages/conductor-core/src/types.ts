// Pure type definitions for the Conductor engine. No I/O, no runtime dependencies.
// Mirrors the graph shape in specs/005-omadia-conductor/data-model.md.

/** A JSON-serializable value. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

// ---------------------------------------------------------------------------
// Predicate AST — the serializable guard / exit-postcondition language.
// Evaluated against an EvalScope; never executed as code (no eval).
// ---------------------------------------------------------------------------

/** Compare a dot-path value against a literal. Ordering ops apply to number/number
 *  and string/string only; any other pairing is `false`. */
export interface ComparePredicate {
  op: 'eq' | 'ne' | 'gt' | 'lt' | 'gte' | 'lte';
  path: string;
  value: JsonValue;
}

/** True iff the dot-path resolves to a defined value. */
export interface ExistsPredicate {
  op: 'exists';
  path: string;
}

/** True iff the dot-path value deep-equals one of the listed values. */
export interface InPredicate {
  op: 'in';
  path: string;
  value: JsonValue[];
}

/** True iff the dot-path resolves to a string matching the (RegExp) pattern. */
export interface MatchesPredicate {
  op: 'matches';
  path: string;
  value: string;
}

export interface AndPredicate {
  op: 'and';
  args: Predicate[];
}

export interface OrPredicate {
  op: 'or';
  args: Predicate[];
}

export interface NotPredicate {
  op: 'not';
  arg: Predicate;
}

/** Constant predicates. `always` ≡ true, `never` ≡ false. */
export type ConstPredicate = { op: 'always' } | { op: 'never' };

export type Predicate =
  | ComparePredicate
  | ExistsPredicate
  | InPredicate
  | MatchesPredicate
  | AndPredicate
  | OrPredicate
  | NotPredicate
  | ConstPredicate;

/** The scope a predicate is evaluated against: the run's accumulated context and the
 *  just-completed step's result. Paths are rooted here — e.g. "ctx.base",
 *  "stepResult.approved", "stepResult.items.0.id". */
export interface EvalScope {
  ctx: JsonObject;
  stepResult: JsonValue;
}

// ---------------------------------------------------------------------------
// Workflow graph
// ---------------------------------------------------------------------------

export type StepKind = 'agent' | 'action' | 'human';

export type PrincipalKind = 'user' | 'role';

export interface Principal {
  kind: PrincipalKind;
  /** user uuid (kind='user') or role key (kind='role'). */
  ref: string;
}

export type Quorum = 'any' | 'all';

export interface HumanStepConfig {
  principal: Principal;
  channel: string;
  message: string;
  /** ISO-8601 duration; null/absent = no reminders. */
  reminderInterval?: string | null;
  /** ISO-8601 duration relative to step entry; null/absent = no deadline. */
  deadline?: string | null;
  /** default 'any'. */
  quorum?: Quorum;
  responseSchema?: JsonObject;
}

export interface CanvasPosition {
  x: number;
  y: number;
}

export interface Step {
  id: string;
  kind: StepKind;
  /** required when kind='agent'. The **slug of an Agent (orchestrator instance)** in the
   *  multi-orchestrator registry (e.g. "fallback") — NOT a sub-agent or a bare model. The
   *  Conductor resolves it live via the registry and runs a real turn on that orchestrator. */
  agentId?: string;
  /** required when kind='action'. The deterministic-action / connector tool id to invoke. */
  actionId?: string;
  /** kind='agent': the message sent to the orchestrator turn. Supports `{{ctx.path}}` /
   *  `{{steps.stepId.field}}` interpolation against the run context. */
  prompt?: string;
  /** kind='action': the input object passed to the connector action. */
  input?: JsonObject;
  /** required when kind='human'. */
  human?: HumanStepConfig;
  /** the step's exit postcondition; absent ≡ always met. */
  postcondition?: Predicate;
  /** id of the transition fired when the postcondition is unmet, or when no happy-path
   *  guard matches. Required for a deadline-bearing human step (validated). */
  fallbackTransitionId?: string;
  position?: CanvasPosition;
}

export interface Transition {
  id: string;
  source: string;
  target: string;
  /** guard evaluated against the source step's result/context; absent ≡ always true. */
  guard?: Predicate;
}

export type TriggerKind =
  | 'manual'
  | 'cron'
  | 'channel'
  | 'agent'
  | 'webhook'
  | 'workflow'
  | 'event';

export interface Trigger {
  id: string;
  kind: TriggerKind;
  /** for kind='event': the catalog event id. */
  eventId?: string;
  /** for kind='event': an optional payload filter (predicate over the event payload). */
  filter?: Predicate;
  /** for kind='cron': a cron expression. */
  cron?: string;
}

export interface WorkflowGraph {
  entryStepId: string;
  steps: Step[];
  transitions: Transition[];
  triggers?: Trigger[];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type ValidationCode =
  | 'shape'
  | 'unknown_entry_step'
  | 'duplicate_step_id'
  | 'duplicate_transition_id'
  | 'transition_unknown_source'
  | 'transition_unknown_target'
  | 'fallback_unknown_transition'
  | 'fallback_wrong_source'
  | 'unreachable_step'
  | 'unguarded_cycle'
  | 'deadline_without_fallback'
  | 'quorum_all_requires_deadline_fallback'
  | 'agent_step_missing_agent'
  | 'action_step_missing_action'
  | 'human_step_missing_config'
  | 'unknown_agent_ref'
  | 'unknown_action_ref'
  | 'unknown_role_ref'
  | 'unknown_event_ref'
  // Template-manifest integrity codes (checkTemplateManifest in template.ts).
  | 'template_missing_metadata'
  | 'template_invalid_localized_text'
  | 'template_duplicate_slot_key'
  | 'template_undeclared_slot'
  | 'template_unused_slot'
  | 'template_malformed_slot_ref';

export interface ValidationError {
  code: ValidationCode;
  message: string;
  /** the offending node id(s) — steps, transitions, or triggers. */
  nodeIds: string[];
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
}

/** Optional known-reference sets supplied by the kernel so the pure engine can verify that
 *  referenced agents/actions/roles/events resolve against the live catalog. An absent set is
 *  not checked (structural presence only), keeping the engine usable standalone. */
export interface KnownRefs {
  agentIds?: readonly string[];
  actionIds?: readonly string[];
  roleKeys?: readonly string[];
  eventIds?: readonly string[];
}

// ---------------------------------------------------------------------------
// Workflow templates ("workflow templates" user-facing; slot-parameterized graphs)
// ---------------------------------------------------------------------------

/** The five slot kinds a template graph can parameterize. Referenced from graph ref
 *  fields with the kind-SINGULAR placeholder syntax `slot:<kind-singular>:<key>`
 *  (e.g. kind 'agents' → `slot:agent:<key>`). Placeholders appear ONLY in ref fields
 *  (`step.agentId`, `step.actionId`, role `step.human.principal.ref`,
 *  `step.human.channel`, `trigger.eventId`) — never in `step.prompt` /
 *  `human.message`, whose `{{...}}` syntax is run-context interpolation. */
export type TemplateSlotKind = 'agents' | 'actions' | 'roles' | 'events' | 'channels';

/** Per-locale text record carried by a manifest. `en` is the required base and the
 *  universal fallback; any further locale key ('de', ...) is optional. */
export interface LocalizedTextMap {
  en: string;
  [locale: string]: string | undefined;
}

/** Manifest-borne localizable text: either a plain string (treated as English) or a
 *  per-locale record with `en` required. Templates are data -- v2 distributes them
 *  outside the repo -- so localization travels WITH the manifest instead of living in
 *  the app's message catalogs. Resolve with `resolveLocalizedText` (template.ts). */
export type LocalizedText = string | LocalizedTextMap;

export interface TemplateSlot {
  /** unique within its kind; referenced from the graph as `slot:<kind-singular>:<key>`. */
  key: string;
  /** human-readable, shown in the mapping form. */
  label: LocalizedText;
  /** authored help text for the mapping form. */
  description?: LocalizedText;
}

export interface TemplateSlots {
  agents?: TemplateSlot[];
  actions?: TemplateSlot[];
  roles?: TemplateSlot[];
  events?: TemplateSlot[];
  channels?: TemplateSlot[];
}

export interface TemplateManifest {
  /** stable kebab-case catalog id, e.g. "expense-approval". */
  id: string;
  name: LocalizedText;
  /** the business problem it solves, plain language. */
  description: LocalizedText;
  /** category tag: 'approval' | 'escalation' | 'reporting' | 'onboarding' | free string. */
  useCase: LocalizedText;
  /** suggested workflow slug, operator-editable. */
  defaultSlug: string;
  /** complete graph with `slot:` placeholders in ref fields. */
  graph: WorkflowGraph;
  slots: TemplateSlots;
}

/** slot key → install-local entity id, per kind. */
export type TemplateSlotMapping = Partial<Record<TemplateSlotKind, Record<string, string>>>;

/** One placeholder found in a template graph, with every node referencing it. */
export interface TemplateSlotRef {
  kind: TemplateSlotKind;
  key: string;
  /** steps/triggers referencing the slot. */
  nodeIds: string[];
}

/** A declared slot missing from a mapping (missingSlotMappings result item). The label
 *  is resolved to plain English so the wire envelope stays a flat string -- clients
 *  localize from the manifest they already hold, keyed by kind+key. */
export interface TemplateMissingSlot {
  kind: TemplateSlotKind;
  key: string;
  label: string;
}

// ---------------------------------------------------------------------------
// Engine decision
// ---------------------------------------------------------------------------

export type PostconditionOutcome = 'met' | 'unmet' | 'n/a';

export type AdvanceReason =
  | 'guard_matched'
  | 'postcondition_unmet_fallback'
  | 'no_transition_matched_fallback';

export type StuckCode =
  | 'unknown_step'
  | 'postcondition_unmet_no_fallback'
  | 'no_transition_no_fallback'
  | 'ambiguous_guards'
  | 'fallback_transition_missing';

export type Decision =
  | {
      kind: 'advance';
      transitionId: string;
      targetStepId: string;
      reason: AdvanceReason;
      postcondition: PostconditionOutcome;
    }
  | { kind: 'complete'; postcondition: PostconditionOutcome }
  | {
      kind: 'stuck';
      code: StuckCode;
      message: string;
      nodeIds: string[];
      postcondition: PostconditionOutcome;
    };
