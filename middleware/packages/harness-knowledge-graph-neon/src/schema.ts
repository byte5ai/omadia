import { z } from 'zod';

export const GRAPH_NODE_TYPES = [
  'Session',
  'Turn',
  'OdooEntity',
  'ConfluencePage',
  // OB-29-2 — generic plugin-namespaced entity. Maps from
  // EntityIngest.system != 'odoo' && != 'confluence'. system+model+id live
  // on `props`; the namespace string is what the plugin declared in
  // permissions.graph.entity_systems.
  'PluginEntity',
  // Agentic-run-graph additions (Track B1).
  'User',
  'Run',
  'AgentInvocation',
  'ToolCall',
  // Graph-RAG Phase E: atomic facts distilled out of turns via Haiku.
  'Fact',
  // NorthData Phase 1: commercial register companies + natural persons
  // (managing directors, shareholders). Own labels so verflechtungs-queries
  // (Person)-[:MANAGES]->(Company) can hit an index instead of scanning a
  // generic OdooEntity payload.
  'Company',
  'Person',
  // Creditworthiness-relevant: one structured snapshot per (Company, fiscalYear).
  // Mirrors NorthData's `Financials{date, consolidated, items[]}` shape —
  // `items` stays open-ended because indicator ids are a moving target (see
  // northdata.com/_financials).
  'FinancialSnapshot',
] as const;

export const GRAPH_EDGE_TYPES = [
  'IN_SESSION',
  'NEXT_TURN',
  'CAPTURED',
  // Agentic-run-graph additions.
  'BELONGS_TO',
  'EXECUTED',
  'INVOKED_AGENT',
  'INVOKED_TOOL',
  'PRODUCED',
  // Graph-RAG Phase E: Fact provenance + entity mentions.
  'DERIVED_FROM',
  'MENTIONS',
  // NorthData Phase 1: verflechtungs-graph.
  // (Person)-[:MANAGES {role,since,until}]->(Company)
  // (Person|Company)-[:SHAREHOLDER_OF {sharePercent,since,until}]->(Company)
  // (Company)-[:SUCCEEDED_BY {reason}]->(Company)
  // (Company)-[:REFERS_TO]->(OdooEntity) — cross-link via VAT/HRB
  // (Company)-[:HAS_FINANCIALS {fiscalYear,consolidated}]->(FinancialSnapshot)
  'MANAGES',
  'SHAREHOLDER_OF',
  'SUCCEEDED_BY',
  'REFERS_TO',
  'HAS_FINANCIALS',
] as const;

export const GraphNodeTypeSchema = z.enum(GRAPH_NODE_TYPES);
export const GraphEdgeTypeSchema = z.enum(GRAPH_EDGE_TYPES);

export type GraphNodeTypeName = (typeof GRAPH_NODE_TYPES)[number];
export type GraphEdgeTypeName = (typeof GRAPH_EDGE_TYPES)[number];

const SessionPropsSchema = z
  .object({
    scope: z.string().min(1),
    firstSeenAt: z.string().datetime(),
    lastSeenAt: z.string().datetime(),
  })
  .passthrough();

const TurnPropsSchema = z
  .object({
    scope: z.string().min(1),
    time: z.string().datetime(),
    userMessage: z.string(),
    assistantAnswer: z.string(),
    toolCalls: z.number().int().nonnegative().optional(),
    iterations: z.number().int().nonnegative().optional(),
  })
  .passthrough();

const OdooEntityPropsSchema = z
  .object({
    system: z.literal('odoo'),
    model: z.string(),
    id: z.union([z.string(), z.number()]),
    displayName: z.string().optional(),
  })
  .passthrough();

const ConfluencePagePropsSchema = z
  .object({
    system: z.literal('confluence'),
    model: z.string(),
    id: z.union([z.string(), z.number()]),
    displayName: z.string().optional(),
  })
  .passthrough();

// OB-29-2 — generic plugin-namespaced entity. `system` is any string EXCEPT
// the host-reserved 'odoo'/'confluence' (those land in dedicated node types
// above). `model` is plugin-defined ("Person", "Topic", "Note", …).
const PluginEntityPropsSchema = z
  .object({
    system: z
      .string()
      .min(1)
      .refine((s) => s !== 'odoo' && s !== 'confluence', {
        message:
          "PluginEntity must use a non-reserved system namespace ('odoo'/'confluence' are host-only)",
      }),
    model: z.string().min(1),
    id: z.union([z.string(), z.number()]),
    displayName: z.string().optional(),
  })
  .passthrough();

const UserPropsSchema = z
  .object({
    userId: z.string().min(1),
    firstSeenAt: z.string().datetime(),
    lastSeenAt: z.string().datetime(),
  })
  .passthrough();

const RunStatusSchema = z.enum(['success', 'error']);

const RunPropsSchema = z
  .object({
    turnId: z.string().min(1),
    scope: z.string().min(1),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime(),
    durationMs: z.number().int().nonnegative(),
    status: RunStatusSchema,
    iterations: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
    error: z.string().optional(),
  })
  .passthrough();

const AgentInvocationPropsSchema = z
  .object({
    runId: z.string().min(1),
    agentName: z.string().min(1),
    index: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
    subIterations: z.number().int().nonnegative(),
    subToolCount: z.number().int().nonnegative(),
    status: RunStatusSchema,
  })
  .passthrough();

const ToolCallPropsSchema = z
  .object({
    runId: z.string().min(1),
    toolName: z.string().min(1),
    durationMs: z.number().int().nonnegative(),
    isError: z.boolean(),
    /** Orchestrator-level tool, or the name of the sub-agent that owned it. */
    agentContext: z.string().optional(),
  })
  .passthrough();

// Fact severity — our own axis, not from any upstream source. Lets generic
// Fact consumers rank insolvency events above a name change without having to
// pattern-match predicates.
export const FACT_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type FactSeverity = (typeof FACT_SEVERITIES)[number];

const FactPropsSchema = z
  .object({
    sourceTurnId: z.string().min(1),
    subject: z.string().min(1).max(200),
    predicate: z.string().min(1).max(200),
    object: z.string().min(1).max(500),
    confidence: z.number().min(0).max(1).optional(),
    severity: z.enum(FACT_SEVERITIES).optional(),
    extractedAt: z.string().datetime(),
  })
  .passthrough();

// Company.status enum — verified against NorthData swagger (only these three
// values). Insolvenz is explicitly NOT a status — it's an event. We promote a
// company to riskLevel='critical' when an unresolved insolvency event is on
// file, without fabricating a fourth status bucket.
export const COMPANY_STATUSES = ['active', 'liquidation', 'terminated'] as const;
export type CompanyStatus = (typeof COMPANY_STATUSES)[number];

// Derived risk-level, computed deterministically at ingest time out of
// status + recent critical events + financial indicators. Never comes from
// NorthData directly — the API has no credit score field.
export const RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

// One NorthData company entry.
// - externalId = `register.uniqueKey` (the only stable id NorthData exposes;
//   see data-api-userguide, "Identifying a company by register ID").
//   Internal `id` is explicitly NOT stable and must not be persisted.
// - Top-level fields are kept narrow to what's truly on the Company object —
//   `vatId` / email / phone live under `extras.items[id=...]` in the API and
//   are hoisted into `extras` on ingest only when opt-in `extras=true` was
//   requested. We intentionally drop the speculative `foundedAt` field: the
//   API has no direct founding-date property; it's derivable from the
//   Incorporation event type or the history block.
const CompanyPropsSchema = z
  .object({
    system: z.literal('northdata'),
    /** register.uniqueKey — stable, canonical NorthData identifier. */
    externalId: z.string().min(1),
    /** Display name. Pulled from `name.name` in the API response. */
    name: z.string().min(1),
    /** Pre-normalised raw name from register source, useful for disambiguation. */
    rawName: z.string().optional(),
    /** From `name.legalForm`. */
    legalForm: z.string().optional(),
    /** From `register.city` — court city (empty in non-DE jurisdictions). */
    registerCourt: z.string().optional(),
    /** From `register.id` — the register filing id, e.g. `HRB 12345`. */
    registerNumber: z.string().optional(),
    /** From `register.country` — two-letter ISO. */
    registerCountry: z.string().length(2).optional(),
    status: z.enum(COMPANY_STATUSES).optional(),
    /** Terminal-state mirror of status; API publishes both. */
    terminated: z.boolean().optional(),
    /** Formatted, human-readable current address. */
    address: z.string().optional(),
    /** Hoisted from `extras.items[id=vatId]` when extras=true was requested. */
    vatId: z.string().optional(),
    /** `proxyPolicy` — Vertretungsregel (free text, localized). */
    proxyPolicy: z.string().optional(),
    /** NorthData web page for the company (useful for UI deep-link). */
    northDataUrl: z.string().url().optional(),
    /** segmentCodes per standard (naics, isic, nace, wz, uksic). */
    segmentCodes: z.record(z.string(), z.array(z.string())).optional(),
    /** Derived. Deterministic function of status + events + financials. */
    riskLevel: z.enum(RISK_LEVELS).optional(),
    /** Derived. Short machine-readable signal ids, e.g. `insolvency_opened_2024-11`. */
    riskSignals: z.array(z.string()).optional(),
    lastSyncedAt: z.string().datetime(),
    /** Watchlist flag; NorthDataWatcher (Phase 5) polls only nodes with this set. */
    isWatched: z.boolean().optional(),
  })
  .passthrough();

// Natural person surfaced by NorthData (managing director, shareholder, …).
//
// Stable-id problem: NorthData's `Person.id` is documented as internal/unstable
// ("may change over time"). We therefore derive `externalId` as a sha1-based
// synthetic hash of `(lastName|firstName|birthDate|city)` — see
// `personSyntheticId()` in knowledgeGraph.ts. `internalNorthDataId` is kept as
// a soft lookup field for freshness checks, not as an identity key.
//
// DSGVO: birthDate is public-register data (HR publications surface it).
// Address-level data is restricted to city — no street.
const PersonPropsSchema = z
  .object({
    system: z.literal('northdata'),
    /** sha1(lastName|firstName|birthDate|city), first 16 hex chars. */
    externalId: z.string().min(1),
    name: z.string().min(1),
    firstName: z.string().optional(),
    lastName: z.string().min(1),
    /** ISO date `YYYY-MM-DD`. Public-register data. */
    birthDate: z.string().optional(),
    city: z.string().optional(),
    /** The API's internal (NOT stable) id. Stored for lookup, not identity. */
    internalNorthDataId: z.string().optional(),
    lastSyncedAt: z.string().datetime(),
  })
  .passthrough();

// One structured financial snapshot per (Company, fiscalYear). `items` is a
// free-form array of `{id,name,value,unit,estimate,note}` — we preserve the
// NorthData indicator shape verbatim rather than projecting into a fixed set
// of fields (revenue/ebit/equity) because the indicator list is documented as
// dynamic at northdata.com/_financials.
const FinancialSnapshotPropsSchema = z
  .object({
    companyExternalId: z.string().min(1),
    fiscalYear: z.number().int().min(1900).max(2100),
    /** ISO date the figures were published for. */
    date: z.string().optional(),
    consolidated: z.boolean().optional(),
    sourceName: z.string().optional(),
    items: z
      .array(
        z
          .object({
            id: z.string().min(1),
            name: z.string().optional(),
            value: z.number().optional(),
            unit: z.string().optional(),
            estimate: z.boolean().optional(),
            note: z.string().optional(),
          })
          .passthrough(),
      )
      .default([]),
    lastSyncedAt: z.string().datetime(),
  })
  .passthrough();

export const NodePropsSchemaByType: Record<
  GraphNodeTypeName,
  z.ZodType<Record<string, unknown>>
> = {
  Session: SessionPropsSchema,
  Turn: TurnPropsSchema,
  OdooEntity: OdooEntityPropsSchema,
  ConfluencePage: ConfluencePagePropsSchema,
  PluginEntity: PluginEntityPropsSchema,
  User: UserPropsSchema,
  Run: RunPropsSchema,
  AgentInvocation: AgentInvocationPropsSchema,
  ToolCall: ToolCallPropsSchema,
  Fact: FactPropsSchema,
  Company: CompanyPropsSchema,
  Person: PersonPropsSchema,
  FinancialSnapshot: FinancialSnapshotPropsSchema,
};

export function validateNodeProps(
  type: GraphNodeTypeName,
  props: Record<string, unknown>,
): Record<string, unknown> {
  return NodePropsSchemaByType[type].parse(props);
}
