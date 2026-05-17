import { z } from 'zod';

import { PLUGIN_DOMAIN_REGEX } from '@omadia/plugin-api';

import type { JsonSchema } from '../zodToJsonSchema.js';
import { isReservedToolId } from '../reservedNames.js';
import { UiRouteSchema } from './uiRouteSchema.js';

/**
 * AgentSpec — structured description of an uploaded/builder-generated agent.
 *
 * The spec is the data contract between the Builder UI (formulation chat,
 * inline editor) and the CodegenEngine (B.1-3). It is stored verbatim in
 * the draft store as JSON, so all values must be JSON-serialisable. Slots
 * carry the LLM-generated code chunks that get injected into marker regions
 * inside the boilerplate.
 *
 * Multi-template:
 *   The MVP ships a single template (`agent-integration` — the
 *   client-plus-toolkit shape that today's seo-analyst uses), but the spec
 *   is template-aware from day one. New templates register at boot via
 *   `registerAgentTemplate(id)` (BoilerplateSource will do this in B.1-2).
 *   The CodegenEngine resolves slot keys against the chosen template's
 *   manifest, not against a hardcoded list — adding `agent-pure-compute`
 *   or `agent-sub-orchestrator` later is a doc drop, not a codegen patch.
 *
 * `slots` is a free-form `Record<string, string>` here. Per-template slot
 * key validation runs in CodegenEngine (B.1-3), where the active template
 * manifest declares which keys are valid.
 */

// Tool ids are snake_case so they line up with how tool-names appear in the
// Anthropic tool-use payload and how `Orchestrator.registerDomainTool` keys
// them.
const ToolIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, 'Tool ID must be snake_case (lowercase, digits, underscore)');

// DNS-label compatible — agent IDs become URL-safe directory names and
// flow into the manifest as the package id.
const AgentIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9.-]*$/, 'Agent ID must be a DNS-label-compatible reverse-FQDN');

// `depends_on` and (transitively) downstream cross-plugin references must
// also accept npm-scoped IDs (`@omadia/agent-seo-analyst`, `@omadia/memory`)
// because the legacy hand-coded plugins ship with scoped package names, NOT
// reverse-FQDN. Without this Builder-emitted plugins can't reference any
// existing platform plugin at all — Zod rejects the `@`/`/` characters at
// parse time, long before the manifestLinter's catalog check runs.
//
// `spec.id` itself stays restricted to reverse-FQDN (Builder-convention) —
// only depends_on (and capability/service refs that ride on the same naming
// space) is widened.
const DependsOnIdSchema = z
  .string()
  .regex(
    /^(?:@[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*|[a-z][a-z0-9.-]*)$/,
    'depends_on entry must be a reverse-FQDN (`de.byte5.agent.foo`) ' +
      'OR an npm-scoped name (`@omadia/agent-foo`)',
  );

const SemverSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?$/, 'Version must be semver (x.y.z[-prerelease])');

// Tool input shape is JSON-Schema. We accept any JSON object here; deeper
// JSON-Schema-draft-2020-12 conformance is checked by lint_spec (B.4).
const InputJsonSchemaShape: z.ZodType<JsonSchema> = z
  .object({})
  .passthrough() as unknown as z.ZodType<JsonSchema>;

export const ToolSpecSchema = z.object({
  id: ToolIdSchema,
  description: z.string().min(1),
  // Default to an empty schema so pure-LLM agents — which don't take
  // structured tool args — don't fail validation when the Builder LLM
  // omits the field. The lint_spec pass (B.4) still flags missing
  // schemas as warnings for tools that look like they should have args.
  input: InputJsonSchemaShape.default({} as JsonSchema),
});
// Note: NOT `.strict()` — the Builder LLM frequently adds advisory
// metadata fields it learned from other tool schemas (`side_effects`,
// `idempotent`, `autonomous`, `timeout_ms`, etc.). Zod's default
// behaviour silently strips unrecognized keys, which is the right
// trade-off: we'd rather move forward with a clean spec than block the
// build on metadata that nothing downstream consumes.

export type ToolSpec = z.infer<typeof ToolSpecSchema>;

// B.11-6: Optional spec.test_cases[] — Operator-promoted tool-test
// records. Persisted in spec.yaml so a clone-from-installed picks them
// up; consumed by B.10's behavior-eval-runner (the field is nominal
// until B.10 lights up). The schema is intentionally permissive on
// `input` and `expected` because tools have heterogeneous shapes; only
// `toolId` is constrained, against the same regex as ToolSpec.id.
export const TestCaseSchema = z
  .object({
    toolId: ToolIdSchema,
    description: z.string().optional(),
    input: z.unknown(),
    expected: z.unknown(),
  })
  .strict();

export type TestCase = z.infer<typeof TestCaseSchema>;

// Mirrors PluginSetupField['type'] from manifestLoader.isSetupFieldType.
// `password` is intentionally NOT a member — secrets use `type: 'secret'`.
const SetupFieldSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_]*$/),
    type: z.enum(['string', 'url', 'secret', 'oauth', 'enum', 'boolean', 'integer']),
    required: z.boolean().optional(),
    description: z.string().optional(),
    default: z.unknown().optional(),
    enum_values: z.array(z.string()).optional(),
  })
  .strict();

export type SetupField = z.infer<typeof SetupFieldSchema>;

// --- Scheduled job --------------------------------------------------------
// Cron- or interval-driven background work. Codegen writes the entries
// verbatim into `manifest.yaml:jobs[]`; the kernel auto-registers them
// before `activate()` returns. Programmatic registrations via
// `ctx.jobs.register(...)` in activate-body are additive.
//
// `name` must be unique within the plugin (singleton-lock key). croner
// 5- or 6-field cron syntax — `*/5 * * * *`, `0 8 * * MON`, etc. Interval
// triggers are simple `intervalMs`. Tests + manifest-linter share the
// validator so a typo in spec.jobs[i].schedule.cron fails at lint-time,
// not at first tick.

const JobScheduleSchema = z.union([
  z.object({ cron: z.string().min(1, 'cron expression is required') }).strict(),
  z.object({ intervalMs: z.number().int().positive() }).strict(),
]);

const JobSpecSchema = z
  .object({
    name: z
      .string()
      .regex(
        /^[a-z][a-z0-9-]*$/,
        'job name must be kebab-case (e.g. `weekly-digest`, `poll-inbox`)',
      ),
    schedule: JobScheduleSchema,
    /** Per-run timeout in ms. Default 30_000. */
    timeoutMs: z.number().int().positive().max(15 * 60_000).optional(),
    overlap: z.enum(['skip', 'queue']).optional(),
  })
  .strict();

export type JobSpec = z.infer<typeof JobSpecSchema>;

// --- Permissions (Phase B) ------------------------------------------------
// Manifest-mirrored permission block. Each sub-key gates a corresponding
// `ctx.*` accessor at runtime:
//   permissions.graph.entity_systems   → ctx.knowledgeGraph
//   permissions.subAgents.calls        → ctx.subAgent
//   permissions.llm.models_allowed     → ctx.llm
// `permissions.memory.{reads,writes}` lives in the boilerplate manifest
// template directly (auto-populated with `agent:<id>:*`) so memory is
// available without any spec-side declaration. `network.outbound` stays
// on the top-level `spec.network` field for backwards-compat (codegen
// already maps it to manifest.permissions.network.outbound).
//
// Each block is OPTIONAL. Omitted → no permission written → corresponding
// ctx accessor stays `undefined` at runtime. This keeps the principle of
// least authority: plugins explicitly opt into each capability.

const GraphPermissionSchema = z
  .object({
    /** Entity-system namespaces this plugin owns (e.g. 'audit-reports',
     *  'personal-notes'). The kernel rejects `ingestEntities` calls whose
     *  `system` field is outside this list. Reserved names ('odoo',
     *  'confluence', etc.) are stripped at manifest-load time. */
    entity_systems: z.array(z.string().min(1)).default([]),
    reads: z.array(z.string()).default([]),
    writes: z.array(z.string()).default([]),
  })
  .strict();

const SubAgentsPermissionSchema = z
  .object({
    /** Full agent-ids this plugin may delegate to via `ctx.subAgent.ask`.
     *  Format mirrors `depends_on`: reverse-FQDN OR npm-scoped. */
    calls: z
      .array(
        z
          .string()
          .regex(
            /^(?:@[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*|[a-z][a-z0-9.-]*)$/,
            'subAgents.calls entry must be reverse-FQDN or @scope/name',
          ),
      )
      .default([]),
    /** Per-tool-handler invocation cap. Default 5 in kernel. */
    calls_per_invocation: z.number().int().positive().max(50).optional(),
  })
  .strict();

const LlmPermissionSchema = z
  .object({
    /** Anthropic model whitelist. Supports `*`-suffix wildcards
     *  (`'claude-haiku-4-5*'`). Empty list = no LLM access at runtime
     *  (ctx.llm stays undefined). */
    models_allowed: z.array(z.string().min(1)).default([]),
    /** Per-tool-handler invocation cap. Default 5 in kernel. */
    calls_per_invocation: z.number().int().positive().max(50).optional(),
    /** Output-tokens hard cap. Silently clamped per call. Default 4096. */
    max_tokens_per_call: z.number().int().positive().max(64_000).optional(),
  })
  .strict();

export const PermissionsSchema = z
  .object({
    graph: GraphPermissionSchema.optional(),
    subAgents: SubAgentsPermissionSchema.optional(),
    llm: LlmPermissionSchema.optional(),
  })
  .strict();

export type Permissions = z.infer<typeof PermissionsSchema>;

// --- ExternalRead ---------------------------------------------------------
// Theme A — declarative cross-integration data-pull. Each entry produces:
//   - a service lookup (`ctx.services.get<T>('<service>')`) in the
//     plugin.ts external-reads-init region
//   - a tool descriptor pushed onto the toolkit, that calls
//     `<service>.<method>(...args, kwargs)` and (optionally) reshapes the
//     raw result via `result_mapping` before returning to the LLM
// Replaces hand-coded service-lookup + toolkit-impl patterns the LLM had
// to write from training memory (lessons-learned 2026-05-04: the LLM
// invented `odoo.execute_kw(...)` because the real surface
// `odoo.execute({...})` was only documented in INTEGRATION.md).
//
// Surface validity is checked by manifestLinter.validateSpec against
// `serviceTypeRegistry`; a missing entry blocks codegen there, not here.
export const ExternalReadSchema = z
  .object({
    id: ToolIdSchema,
    description: z.string().min(1),
    service: z.string().min(1),
    model: z.string().optional(),
    method: z.string().min(1),
    args: z.array(z.unknown()).default([]),
    kwargs: z.record(z.string(), z.unknown()).default({}),
    result_mapping: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export type ExternalRead = z.infer<typeof ExternalReadSchema>;

// --- Template registry ----------------------------------------------------

const knownTemplates = new Set<string>(['agent-integration', 'agent-pure-llm']);

export function registerAgentTemplate(id: string): void {
  if (!id) {
    throw new Error('agentSpec: template id must be non-empty');
  }
  knownTemplates.add(id);
}

export function getKnownAgentTemplates(): readonly string[] {
  return [...knownTemplates].sort();
}

// Aliases the Builder LLM tends to emit when it picks a template via
// `patch_spec` — the reference-catalog exposes them as e.g.
// `boilerplate-pure-llm`, the LLM strips the prefix and we end up with a
// short form that doesn't match the canonical template id on disk. Coerce
// here so a stray `pure-llm` doesn't fail validation; the canonical id is
// what every downstream codepath (codegen, manifest loader, install path)
// expects.
const AGENT_TEMPLATE_ALIASES: Record<string, string> = {
  'pure-llm': 'agent-pure-llm',
  'integration': 'agent-integration',
};

const AgentTemplateSchema = z
  .string()
  .transform((val) => AGENT_TEMPLATE_ALIASES[val] ?? val)
  .refine((val) => knownTemplates.has(val), {
    message: 'Unknown agent template',
  });

// --- Builder settings -----------------------------------------------------
// Per-draft operator preferences that influence the BUILDER UX, not the
// runtime artefact. Codegen + manifestLinter ignore this branch entirely
// (`builder_settings` is not in the field-iteration of either) — it survives
// install only because the install path persists the spec verbatim, and on
// the next clone it is irrelevant for runtime.
//
// `auto_fix_enabled` (Option-C, C-3): when true the AutoFixOrchestrator
// (C-4) fires a synthetic Builder turn after every build_status:failed or
// runtime_smoke_status:failed to attempt a self-fix without operator click.
// Default off — the operator opts in per draft.

export const BuilderSettingsSchema = z
  .object({
    auto_fix_enabled: z.boolean().default(false),
  })
  .strict()
  .default({ auto_fix_enabled: false });

export type BuilderSettings = z.infer<typeof BuilderSettingsSchema>;

// --- Quality config -------------------------------------------------------
// Phase-1 of the Kemia integration. Optional `quality:` block in the spec
// is the canonical home for per-profile sycophancy + boundary settings.
// Mirrors the `ProfileQualityConfig` shape on the plugin-api surface; the
// `responseGuard@1` provider plugin reads (a flattened version of) this
// block per turn. AGENT.md frontmatter readers (Phase 2.1+) emit into the
// same field, so Builder-side and frontmatter-side payloads converge.
//
// All fields optional — a profile without a `quality:` block falls back
// to the provider plugin's configured defaults.

export const SycophancyLevelSpecSchema = z.enum(['off', 'low', 'medium', 'high']);

export const QualityConfigSchema = z
  .object({
    sycophancy: SycophancyLevelSpecSchema.optional(),
    boundaries: z
      .object({
        presets: z.array(z.string().min(1)).default([]),
        custom: z.array(z.string().min(1)).default([]),
      })
      .strict()
      .optional(),
  })
  .strict();

export type QualityConfig = z.infer<typeof QualityConfigSchema>;

// --- Persona config -------------------------------------------------------
// Phase 3 of the Kemia integration (OB-67). Optional `persona:` block in
// the spec is the canonical home for per-profile character shaping (12
// axes 0–100 + optional template name + free-text custom_notes). The
// shape is the inline-Phase-3 mirror of the schema documented in
// docs/harness-platform/specs/persona-ui-v1.md §4 — Phase 4 will move it
// to plugin-api/src/persona.ts when the `personaCompose@1` provider
// plugin lands. Until then, the field is data-only: the Builder writes
// it via `set_persona_config`, the bridge serialiser mirrors it into
// `agent.md` frontmatter, and the orchestrator-side compose hook is a
// no-op (Phase 4 deferred — conditional on Phase-1 ops data).
//
// All fields optional. The 12 axes mirror Kemia's persona-dimensions.ts;
// Core (8) drives 80% of the Browser-View, Extended (4) is opt-in tuning.

const PersonaAxisValueSchema = z.number().int().min(0).max(100);

export const PersonaAxesSchema = z
  .object({
    // Core (8) — primary slider block in the UI
    formality: PersonaAxisValueSchema.optional(),
    directness: PersonaAxisValueSchema.optional(),
    warmth: PersonaAxisValueSchema.optional(),
    humor: PersonaAxisValueSchema.optional(),
    sarcasm: PersonaAxisValueSchema.optional(),
    conciseness: PersonaAxisValueSchema.optional(),
    proactivity: PersonaAxisValueSchema.optional(),
    autonomy: PersonaAxisValueSchema.optional(),
    // Extended (4) — secondary slider block
    risk_tolerance: PersonaAxisValueSchema.optional(),
    creativity: PersonaAxisValueSchema.optional(),
    drama: PersonaAxisValueSchema.optional(),
    philosophy: PersonaAxisValueSchema.optional(),
  })
  .strict();

export type PersonaAxes = z.infer<typeof PersonaAxesSchema>;

export const PersonaConfigSchema = z
  .object({
    template: z.string().min(1).optional(),
    axes: PersonaAxesSchema.optional(),
    custom_notes: z.string().max(2000).optional(),
  })
  .strict();

export type PersonaConfig = z.infer<typeof PersonaConfigSchema>;

/** The 8 core axes — the primary slider block in the Browser-View. */
export const CORE_PERSONA_AXES = [
  'formality',
  'directness',
  'warmth',
  'humor',
  'sarcasm',
  'conciseness',
  'proactivity',
  'autonomy',
] as const satisfies ReadonlyArray<keyof PersonaAxes>;

/** The 4 extended axes — secondary slider block, eingeklappt by default. */
export const EXTENDED_PERSONA_AXES = [
  'risk_tolerance',
  'creativity',
  'drama',
  'philosophy',
] as const satisfies ReadonlyArray<keyof PersonaAxes>;

// --- AgentSpec ------------------------------------------------------------

export const AgentSpecSchema = z
  .object({
    template: AgentTemplateSchema.default('agent-integration'),

    // Identity
    id: AgentIdSchema,
    name: z.string().min(1),
    version: SemverSchema.default('0.1.0'),
    description: z.string().min(1),
    category: z.enum([
      'productivity',
      'crm',
      'documents',
      'communication',
      'analysis',
      'other',
    ]),
    // OB-77 (Palaia Phase 8) — first-class plugin Domain. Required at the
    // spec level so codegen can write `identity.domain` into the manifest
    // without relying on the loader's auto-fallback. Lowercase, dotted,
    // kebab-case mid-segment OK (`confluence`, `odoo.hr`,
    // `m365.calendar`, `core.knowledge-graph`). Validated against the
    // same regex used by the manifest loader so authoring + boot-time
    // checks agree.
    domain: z
      .string()
      .regex(
        PLUGIN_DOMAIN_REGEX,
        'Domain muss lowercase + dotted sein (z.B. "odoo.hr", "m365.calendar"). Segmente dürfen Bindestriche enthalten, aber nicht beginnen/enden mit Bindestrich oder doppelten Bindestrichen.',
      ),

    // Inheritance — drives Vault-Scope and primary integration parent.
    depends_on: z.array(DependsOnIdSchema).default([]),

    // Capabilities
    tools: z.array(ToolSpecSchema).default([]),
    skill: z
      .object({
        role: z.string().min(1),
        tonality: z.string().optional(),
      })
      .strict(),

    // Runtime config
    setup_fields: z.array(SetupFieldSchema).default([]),

    // Scheduled background jobs. Codegen writes these into manifest.yaml's
    // `jobs:` block; kernel auto-registers before activate(). Plugin
    // discovers ctx.jobs.register(...) as an additive surface for runtime
    // job creation in activate-body.
    jobs: z.array(JobSpecSchema).default([]),

    // Phase B platform-parity — gate-block for the higher-privilege ctx
    // accessors (ctx.knowledgeGraph, ctx.subAgent, ctx.llm). Codegen maps
    // each sub-block into manifest.permissions.<key>; the kernel only
    // hands out the corresponding accessor when the permission is present
    // and non-empty. Omit to keep the principle of least authority.
    permissions: PermissionsSchema.optional(),
    playbook: z
      .object({
        when_to_use: z.string().min(1),
        not_for: z.array(z.string()).default([]),
        example_prompts: z.array(z.string()).default([]),
      })
      .strict(),

    // Maps to manifest.permissions.network.outbound
    network: z
      .object({
        outbound: z.array(z.string()).default([]),
      })
      .strict()
      .default({ outbound: [] }),

    // S+7.7 — Optional Operator-Admin-UI path. When set, the codegen
    // injects this as a top-level `admin_ui_path` field in manifest.yaml;
    // web-ui embeds the URL as an iframe on the store-detail page once
    // the plugin is installed. The plugin must additionally mount its UI
    // routes via `ctx.routes.register()` in its activate-body — see
    // `boilerplate/agent-integration/CLAUDE.md` (Optional-Admin-UI).
    // Path MUST be absolute (start with `/`); the recommended shape is
    // `/api/<slug>/admin/index.html`.
    admin_ui_path: z
      .string()
      .regex(/^\/[\w./~%-]+$/, 'admin_ui_path must be an absolute path starting with `/`')
      .optional(),

    // Theme A — declarative cross-integration reads. See
    // ExternalReadSchema docstring. Codegen synthesises both the service
    // lookup and the resulting tool descriptor from these entries; the
    // LLM no longer hand-writes either side.
    external_reads: z.array(ExternalReadSchema).default([]),

    // B.12 — Dashboard-capable Builder. Optional list of UI-Routes
    // (Browser-/Teams-Tab-fähige Dashboard-Pfade), die Codegen zu
    // dedizierten Express-UiRouters + `ctx.uiRoutes.register(...)`-
    // Eintragungen im activate-body-Slot expandiert. Drei Render-Modes
    // (library / react-ssr / free-form-html) — siehe uiRouteSchema.ts.
    // Default `[]` — legacy drafts ohne UI bleiben kompatibel.
    ui_routes: z.array(UiRouteSchema).default([]),

    // LLM-generated code chunks. Slot key set is template-defined.
    slots: z.record(z.string(), z.string()).default({}),

    // Operator-only preferences. Not emitted to manifest.yaml. See
    // BuilderSettingsSchema docstring above.
    builder_settings: BuilderSettingsSchema,

    // B.11-6: Operator-promoted tool-test records (see TestCaseSchema).
    // Nominal until B.10 lights up the behavior-eval-runner; codegen
    // ignores this branch and the manifestLinter does not gate on it.
    test_cases: z.array(TestCaseSchema).default([]),

    // Phase-1 Kemia: optional response-quality block. See
    // QualityConfigSchema docstring. Omitted in legacy drafts; the
    // responseGuard@1 provider falls back to its configured defaults.
    quality: QualityConfigSchema.optional(),

    // Phase-3 Kemia (OB-67): optional persona block. See
    // PersonaConfigSchema docstring. Phase 4 (`personaCompose@1`,
    // conditional) will consume this field; Phase 3 only writes/reads
    // it via the Browser-View. Omitted in legacy drafts.
    persona: PersonaConfigSchema.optional(),
  })
  .strict();

export type AgentSpec = z.infer<typeof AgentSpecSchema>;

/**
 * OB-77 (Palaia Phase 8) — legacy-draft migration: drafts that pre-date
 * Slice 3d have no `domain` field, but the schema requires it. We
 * synthesise a `unknown.<sanitised-id>` fallback so existing drafts
 * stay loadable; the operator sees the placeholder in the SpecOverview
 * and can patch_spec a real domain. New drafts always carry a domain
 * because the Builder prompt elicits it before fill_slot runs.
 */
function migrateMissingDomain(input: unknown): unknown {
  if (typeof input !== 'object' || input === null) return input;
  const obj = input as Record<string, unknown>;
  const existing = obj['domain'];
  if (typeof existing === 'string' && existing.trim().length > 0) {
    return input;
  }
  const id = typeof obj['id'] === 'string' ? obj['id'] : '';
  const safeSegments = id
    .toLowerCase()
    .split(/[./]/)
    .map((p) => p.replace(/[^a-z0-9]/g, ''))
    .filter((p) => p.length > 0 && /^[a-z]/.test(p));
  const safeId = safeSegments.length > 0 ? safeSegments.join('.') : 'plugin';
  return { ...obj, domain: `unknown.${safeId}` };
}

export function parseAgentSpec(input: unknown): AgentSpec {
  return AgentSpecSchema.parse(migrateMissingDomain(input));
}

/**
 * Safe-parse companion that runs the same legacy-domain migration. Use
 * from tools that consume `safeParse` so they see migrated specs (and
 * surface only real validation issues, not "missing domain" on every
 * legacy draft).
 */
export function safeParseAgentSpec(
  input: unknown,
): z.SafeParseReturnType<unknown, AgentSpec> {
  return AgentSpecSchema.safeParse(migrateMissingDomain(input));
}

// --- Higher-level validation (post-parse) ---------------------------------

export type SpecValidationIssue = {
  code:
    | 'reserved_tool_id'
    | 'duplicate_tool_id'
    | 'self_dependency'
    | 'external_read_id_collides_with_tool'
    | 'ui_route_data_binding_unknown_tool'
    | 'ui_route_library_missing_template'
    | 'ui_route_library_missing_item_template'
    | 'ui_route_react_ssr_missing_component_slot'
    | 'ui_route_free_form_missing_render_slot'
    | 'ui_route_interactive_not_supported';
  toolId?: string;
  /** Route id when the issue refers to a ui_routes entry. */
  routeId?: string;
  reason: string;
};

/**
 * Runs cross-field checks the Zod schema can't express:
 * reserved-prefix collision, duplicate tool ids, self-dependency.
 * Returns issues; caller decides whether to throw or surface in the UI.
 */
export function validateSpecForCodegen(
  spec: AgentSpec,
  /**
   * Additional slots that exist outside `spec.slots` — used by the codegen
   * pipeline to surface slots that were merged in from `opts.slots`
   * (fillSlot writes to `draft.slots`, which is a separate column from
   * `draft.spec.slots`). Without this the validator would report
   * `ui_route_react_ssr_missing_component_slot` for a slot that the very
   * same caller is about to merge into `allSlots` — Catch-22.
   */
  additionalSlots: Readonly<Record<string, string>> = {},
): SpecValidationIssue[] {
  const issues: SpecValidationIssue[] = [];

  for (const tool of spec.tools) {
    const result = isReservedToolId(tool.id);
    if (result.reserved) {
      issues.push({
        code: 'reserved_tool_id',
        toolId: tool.id,
        reason: result.reason,
      });
    }
  }

  const seen = new Set<string>();
  for (const tool of spec.tools) {
    if (seen.has(tool.id)) {
      issues.push({
        code: 'duplicate_tool_id',
        toolId: tool.id,
        reason: `Tool ID '${tool.id}' appears more than once in spec.tools`,
      });
    }
    seen.add(tool.id);
  }

  if (spec.depends_on.includes(spec.id)) {
    issues.push({
      code: 'self_dependency',
      reason: `Agent '${spec.id}' lists itself in depends_on`,
    });
  }

  // Theme A: external_reads ids share the toolkit namespace with tools[].
  // A reserved-tool-id check on each entry preserves the same namespace
  // protections as ToolSpec; a collision between an external_read.id and a
  // tools[].id would otherwise produce two registrations under the same
  // tool-name at runtime (last-write-wins, silently).
  for (const er of spec.external_reads) {
    const reservedCheck = isReservedToolId(er.id);
    if (reservedCheck.reserved) {
      issues.push({
        code: 'reserved_tool_id',
        toolId: er.id,
        reason: reservedCheck.reason,
      });
    }
  }
  const toolIds = new Set(spec.tools.map((t) => t.id));
  for (const er of spec.external_reads) {
    if (toolIds.has(er.id)) {
      issues.push({
        code: 'external_read_id_collides_with_tool',
        toolId: er.id,
        reason:
          `external_reads id '${er.id}' collides with a tools[] id — ` +
          'each tool name must be unique across spec.tools and spec.external_reads.',
      });
    }
  }
  const erSeen = new Set<string>();
  for (const er of spec.external_reads) {
    if (erSeen.has(er.id)) {
      issues.push({
        code: 'duplicate_tool_id',
        toolId: er.id,
        reason: `external_reads id '${er.id}' appears more than once`,
      });
    }
    erSeen.add(er.id);
  }

  // B.12 — ui_routes cross-field checks. Zod handled syntax + enum
  // membership; this pass handles binding-existence and mode-vs-slot
  // contracts that span fields. tab_label + path uniqueness lives in
  // manifestLinter.ts so it shares the violations-pipeline with other
  // path-collision checks.
  const knownToolIds = new Set(spec.tools.map((t) => t.id));
  // Merge spec.slots with any caller-supplied additionalSlots (typically
  // `opts.slots` from the codegen pipeline — see fillSlot Catch-22 above)
  // before checking ui_route slot-existence. Only non-empty values count
  // as filled, mirroring the codegen's own check.
  const mergedSlots: Record<string, string> = { ...spec.slots };
  for (const [k, v] of Object.entries(additionalSlots)) {
    if (typeof v === 'string' && v.length > 0) mergedSlots[k] = v;
  }
  const slotKeys = new Set(Object.keys(mergedSlots));

  for (const route of spec.ui_routes) {
    // 1. data_binding references a known tool
    if (route.data_binding && !knownToolIds.has(route.data_binding.tool_id)) {
      issues.push({
        code: 'ui_route_data_binding_unknown_tool',
        routeId: route.id,
        reason:
          `ui_routes['${route.id}'].data_binding.tool_id '${route.data_binding.tool_id}' ` +
          'is not in spec.tools[]. Add the tool first, or correct the reference.',
      });
    }

    // 2. library-mode needs a template + item-template (for list-card)
    if (route.render_mode === 'library') {
      if (!route.ui_template) {
        issues.push({
          code: 'ui_route_library_missing_template',
          routeId: route.id,
          reason:
            `ui_routes['${route.id}'].render_mode='library' requires ui_template ` +
            "(one of 'list-card', 'kpi-tiles').",
        });
      }
      if (route.ui_template === 'list-card' && !route.item_template) {
        issues.push({
          code: 'ui_route_library_missing_item_template',
          routeId: route.id,
          reason:
            `ui_routes['${route.id}'].ui_template='list-card' requires ` +
            'item_template { title, [subtitle], [meta], [url] }.',
        });
      }
    }

    // 3. react-ssr needs the component-slot filled (`ui-<id>-component`)
    if (route.render_mode === 'react-ssr') {
      const slotKey = `ui-${route.id}-component`;
      if (!slotKeys.has(slotKey) || !mergedSlots[slotKey]) {
        issues.push({
          code: 'ui_route_react_ssr_missing_component_slot',
          routeId: route.id,
          reason:
            `ui_routes['${route.id}'].render_mode='react-ssr' requires the ` +
            `slot '${slotKey}' to be filled with a TSX component (default-exported). ` +
            'Run fill_slot for that key.',
        });
      }
    }

    // 4. free-form-html needs the render-slot filled (`ui-<id>-render`)
    if (route.render_mode === 'free-form-html') {
      const slotKey = `ui-${route.id}-render`;
      if (!slotKeys.has(slotKey) || !mergedSlots[slotKey]) {
        issues.push({
          code: 'ui_route_free_form_missing_render_slot',
          routeId: route.id,
          reason:
            `ui_routes['${route.id}'].render_mode='free-form-html' requires the ` +
            `slot '${slotKey}' to be filled with an html-template-literal body. ` +
            'Run fill_slot for that key.',
        });
      }
    }

    // 5. B.13 — interactive=true ist NUR für react-ssr-mode unterstützt.
    //    Library + free-form-html sind SSR-only (interpolierte html-Strings
    //    bzw. operator-frei-gewählter renderRoute-Body; in beiden Fällen
    //    gibt's keine React-Komponente zum Hydraten). Wer interactive=true
    //    für die anderen Modes setzt: schalt auf 'react-ssr' um.
    if (route.interactive && route.render_mode !== 'react-ssr') {
      issues.push({
        code: 'ui_route_interactive_not_supported',
        routeId: route.id,
        reason:
          `ui_routes['${route.id}'].interactive=true wird nur für ` +
          "render_mode='react-ssr' unterstützt. Library- und free-form-html-Modes " +
          'haben keine hydratable React-Komponente. Setze render_mode auf "react-ssr" oder ' +
          'interactive auf false.',
      });
    }
  }

  return issues;
}
