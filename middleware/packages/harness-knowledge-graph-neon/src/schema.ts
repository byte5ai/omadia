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
  // Slice 1b — User-Cluster + ChannelIdentity. `User` is now the
  // channel-agnostic Omadia identity (cluster root, opaque omadiaUserId).
  // `ChannelIdentity` is the channel-bound leaf that carries the raw
  // platform id (AAD oid, Telegram chat-id, …) plus optional verified email
  // for cross-channel cluster-merge.
  'User',
  'ChannelIdentity',
  'Run',
  'AgentInvocation',
  'ToolCall',
  // Graph-RAG Phase E: atomic facts distilled out of turns via Haiku.
  'Fact',
  // Slice 2 — first-class curated memory entity between atomic Fact and
  // verbatim Turn. Carries the ACL (Slice 3) and is the sink for the
  // Palaia significance-promotion pipeline (Slice 4).
  'MemorableKnowledge',
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
  // Slice 1b — ChannelIdentity → User-Cluster cross-link. 1:N from a
  // single User-Cluster's perspective; exactly 1 outbound per identity.
  'IS_IDENTITY_OF',
  // Slice 2 — MemorableKnowledge relationships.
  //   MK -[INVOLVED]-> User      participating cluster-roots (multi)
  //   MK -[REQUIRES]-> Entity    referenced domain entity (Odoo/Confluence/Plugin)
  //   MK -[DERIVED_FROM]-> Turn  uses existing edge type for provenance
  'INVOLVED',
  'REQUIRES',
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

// Slice 1b — User is now a channel-agnostic cluster root. `omadiaUserId` is
// an opaque uuid the host generates on first identity-resolve (not derived
// from any platform id). `displayName` is seeded from the first
// ChannelIdentity that joins the cluster and is otherwise user-controlled.
const UserPropsSchema = z
  .object({
    omadiaUserId: z.string().uuid(),
    firstSeenAt: z.string().datetime(),
    lastSeenAt: z.string().datetime(),
    displayName: z.string().min(1).optional(),
  })
  .passthrough();

// Slice 1b — ChannelIdentity is the channel-bound leaf node. `channelKind`
// pins the platform; `channelUserId` is the raw platform id (Teams AAD oid,
// Telegram numeric chat-id, …). `email` + `emailVerified` enable
// cross-channel cluster-merge: when an incoming identity carries a verified
// email that matches an existing ChannelIdentity in the same tenant, both
// land on the same User-Cluster. Without verified email (default for
// Telegram), each identity gets its own 1:1 cluster.
// Slice 1b-channel-web adds 'web' — the Admin UI as a first-class channel.
// Channel-bound id is the users-table row id; emailVerified follows the
// auth provider (entra → true, local → false). 'admin-ui' would have been
// more specific but the broader 'web' label keeps the door open for a
// future end-user chat surface without another migration.
export const CHANNEL_KINDS = ['teams', 'telegram', 'slack', 'email', 'web'] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

const ChannelIdentityPropsSchema = z
  .object({
    channelKind: z.enum(CHANNEL_KINDS),
    channelUserId: z.string().min(1),
    displayName: z.string().min(1).optional(),
    email: z.string().email().optional(),
    emailVerified: z.boolean().optional(),
    /** Microsoft AAD object id (claims.oid). First-class merge key —
     *  used by the resolver to deterministically link AAD-authenticated
     *  identities across channels (Web admin UI + Teams). Indexed
     *  partially via migration 0014. */
    aadObjectId: z.string().min(1).optional(),
    firstSeenAt: z.string().datetime(),
    lastSeenAt: z.string().datetime(),
    /** Free-form channel-side payload (Telegram from-object, etc.). */
    internalChannelData: z.record(z.string(), z.unknown()).optional(),
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

// Slice 2 — MemorableKnowledge taxonomy. `decision` carries a chosen
// course of action; `insight` an observation worth recalling; `preference`
// a stable user-level setting; `reference` a pointer-style note (link, doc
// excerpt). One MK = one kind — split into multiple nodes if a turn
// produces several.
export const MEMORABLE_KINDS = [
  'decision',
  'insight',
  'preference',
  'reference',
] as const;
export type MemorableKind = (typeof MEMORABLE_KINDS)[number];

const MemorableKnowledgePropsSchema = z
  .object({
    kind: z.enum(MEMORABLE_KINDS),
    /** Short human-readable headline. The thing the user (or the LLM
     *  recalling it) sees first. Hard limit 2k chars to keep the recall
     *  prompt cheap. */
    summary: z.string().min(1).max(2000),
    /** Optional longer-form reasoning. The "why" behind the decision /
     *  insight. Up to 10k chars; longer evidence belongs on a Turn. */
    rationale: z.string().min(1).max(10000).optional(),
    /** Palaia-scored significance in [0, 1]. Optional because Slice 2
     *  ships before the Slice-4 promotion pipeline — early creators
     *  may write MK without a score. */
    significance: z.number().min(0).max(1).optional(),
    /** Cluster-root omadiaUserIds (uuid) that count as owners. Empty
     *  in Slice 2; populated by Slice 3 from the involved-Users
     *  snapshot at creation time. */
    acl_owners: z.array(z.string().uuid()).default([]),
    created_at: z.string().datetime(),
    /** ChannelIdentity external_id of the channel-bound identity that
     *  produced the MK (audit trail — not the cluster root). */
    created_by: z.string().min(1),
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
  ChannelIdentity: ChannelIdentityPropsSchema,
  Run: RunPropsSchema,
  AgentInvocation: AgentInvocationPropsSchema,
  ToolCall: ToolCallPropsSchema,
  Fact: FactPropsSchema,
  MemorableKnowledge: MemorableKnowledgePropsSchema,
};

export function validateNodeProps(
  type: GraphNodeTypeName,
  props: Record<string, unknown>,
): Record<string, unknown> {
  return NodePropsSchemaByType[type].parse(props);
}
