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
};

export function validateNodeProps(
  type: GraphNodeTypeName,
  props: Record<string, unknown>,
): Record<string, unknown> {
  return NodePropsSchemaByType[type].parse(props);
}
