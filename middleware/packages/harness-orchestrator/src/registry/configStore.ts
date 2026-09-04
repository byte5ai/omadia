import type { Pool } from 'pg';

import { resolveModelRef } from '@omadia/llm-provider';

import type { ContextMemoryMode } from '../memoryBinder.js';
import {
  parseAgentToAgentMode,
  type AgentChannelPolicyInput,
  type AgentChannelPolicyRow,
  type AgentToAgentMode,
} from './agentToAgent.js';
import { parseModelPolicy } from './modelPolicy.js';
import type { ModelPolicy } from '@omadia/plugin-api';

import {
  AgentGraphStore,
  type PersonaSkillRow,
  type ScheduleRow,
  type SkillRow,
  type SkillToolBindingRow,
  type SubAgentRow,
  type McpServerRow,
  type ToolGrantRow,
} from './agentGraphStore.js';

/**
 * Multi-orchestrator config store (US4 / T014).
 *
 * Pure CRUD against the four config tables introduced by
 * `0001_multi_orchestrator.sql`. The OrchestratorRegistry (T015) reads from
 * this store on boot; the `agents:apply` CLI (T017), the US7 channel
 * resolver, and the US9 REST surface all write through it.
 *
 * Validation that requires looking at runtime state (multi_instance:false on
 * a second Agent, unsatisfiable permissions) lives in T016 / the registry —
 * this store enforces only what the DB itself can enforce (composite PK
 * uniqueness, FK cascades, CHECK constraints).
 */

export type PrivacyProfile = 'strict' | 'default';
export type AgentStatus = 'enabled' | 'disabled';

export interface CanvasPosition {
  readonly x: number;
  readonly y: number;
}

export interface AgentRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly privacyProfile: PrivacyProfile;
  readonly status: AgentStatus;
  /** Per-agent model routing (Agent Builder P0). Raw JSONB; shaped to
   *  `ModelRoutingConfig` at the API boundary. `null`/absent = inherit
   *  platform default. Optional so pre-existing AgentRow fixtures stay valid. */
  readonly modelRouting?: Record<string, unknown> | null;
  /** Cosmetic canvas coordinate; `null`/absent until first laid out. */
  readonly canvasPosition?: CanvasPosition | null;
  /**
   * W5 memory-ACL — per-agent rollout switch for chat-context-scoped memory
   * (`agents.context_memory`, migration 0050). Lifted into
   * `AgentRuntimeConfig.contextMemory`, where the `MemoryBinder` consumes it.
   *
   * Optional on the row type so pre-existing `AgentRow` fixtures stay valid;
   * absent and every unrecognised value both resolve to `'off'` — today's
   * behaviour — in {@link parseContextMemoryMode}. Fail-closed applies to the
   * flag itself, not just to the scope it controls.
   */
  readonly contextMemory?: ContextMemoryMode;
  /**
   * #1018 — the agent's own agent-to-agent switch (`agents.agent_to_agent`,
   * migration 0058). One half of the AND rule; the other half is the
   * `(channel, agent)` policy row. Optional and deny-default for the same
   * reasons as `contextMemory` (see {@link parseAgentToAgentMode}).
   */
  readonly agentToAgent?: AgentToAgentMode;
  /**
   * #1033 — the agent's model policy (`agents.model_policy`, migration 0059),
   * narrowed deny-default by {@link parseModelPolicy}: absent column or an
   * unrecognised shape both read as `{primary: auto, fallback: none}`, which
   * is today's behaviour.
   */
  readonly modelPolicy?: ModelPolicy;
  /**
   * #1033 — the compiled identity prompt PER MODEL FAMILY
   * (`agent_identities.composed_prompts`), for every family the policy names.
   * `instructions` stays the primary family's text; this map is what the
   * fallback path picks from so a cross-family fallback never speaks a prompt
   * composed for the other family.
   */
  readonly instructionsByFamily?: Readonly<Record<string, string>>;
  /**
   * #914 — the agent's authored behaviour text (`agent_identities.
   * instructions`). Read-only here: the identity is written through
   * `platform/agentIdentityStore.ts`, and this column is joined in so the
   * registry can build the Agent's system prompt from it without a second
   * round trip per Agent.
   *
   * `null`/absent means "not authored" — the platform-wide assistant identity
   * applies, exactly as before this column existed.
   */
  readonly instructions?: string | null;
  /**
   * #967 — the agent's authored NAME (`agent_identities.display_name`), joined
   * in beside {@link instructions} and read the same way: read-only here,
   * written through `platform/agentIdentityStore.ts`.
   *
   * Distinct from {@link name}, which is the registry label an operator gave
   * the agent row (`hr`, `Sales Agent`). This one is the name the bot WEARS —
   * the Teams manifest name, and the name it must introduce itself with. It
   * is deliberately NOT resolved against `name` here: falling back would put
   * a registry label into the system prompt of every agent that never
   * authored an identity, changing prompts that are correct today.
   *
   * `null`/absent means "no authored name" — the assistant identity is used
   * verbatim, exactly as before this column was joined.
   */
  readonly identityName?: string | null;
  /**
   * #967 follow-up — the agent's authored SELF-DESCRIPTION
   * (`agent_identities.short_description` / `.long_description`, the operator's
   * "Steckbrief" tab), joined in beside {@link identityName} and read the same
   * way: read-only here, written through `platform/agentIdentityStore.ts`.
   *
   * These reached the Teams app package and nothing else, so an operator who
   * filled in what the agent IS got a store listing that said one thing and a
   * bot that could not say it. They describe the agent rather than instruct it,
   * which is why they are LAYERED onto the identity text rather than replacing
   * it — see `withAgentSelfDescription`.
   *
   * `null`/absent means "not authored": nothing is added, and the prompt is
   * byte-identical to one built before these were joined.
   */
  readonly identityShortDescription?: string | null;
  readonly identityLongDescription?: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AgentPluginRow {
  readonly agentId: string;
  readonly pluginId: string;
  readonly config: Record<string, unknown>;
  readonly enabled: boolean;
  readonly createdAt: Date;
}

export interface ChannelBindingRow {
  readonly channelType: string;
  readonly channelKey: string;
  readonly agentId: string;
  readonly createdAt: Date;
}

/**
 * A channel key that IS an agent's own provisioned identity — not an
 * operator's routing preference.
 *
 * WHY THIS IS NOT A `channel_bindings` ROW
 * ----------------------------------------
 * `channel_bindings` is the operator's table: one flat (type, key) namespace
 * they fill in by hand or that the auto-bind sweep fills in for an observed
 * conversation. An identity is a different kind of fact. Provisioning an
 * agent's own Microsoft Teams bot registers an Entra app, an Azure bot and an
 * app package that exist SOLELY to be that agent's face — the mapping is
 * already persisted (`agent_teams_identities.app_id`) and it is not a
 * preference anyone may override.
 *
 * Copying it into `channel_bindings` would create a second copy of a mapping
 * that already exists, and the two would drift the first time an identity is
 * reset, re-provisioned or hand-edited. So routing READS the identity table
 * instead: one source of truth, no backfill, and deleting the identity
 * un-routes the bot for free.
 *
 * Exclusivity is the other half. Several provisioned bots share one group
 * chat, so a binding on that CONVERSATION cannot say which bot a turn is for;
 * only the bot key can. An identity therefore outranks every binding — see
 * `OrchestratorRegistry.identityForChannel`.
 */
export interface ChannelIdentityRow {
  readonly channelType: string;
  readonly channelKey: string;
  readonly agentId: string;
}

export interface PlatformSettingsRow {
  readonly fallbackAgentId: string | null;
  readonly updatedAt: Date;
}

export interface AgentInput {
  readonly slug: string;
  readonly name: string;
  readonly description?: string | null;
  readonly privacyProfile?: PrivacyProfile;
  readonly status?: AgentStatus;
}

export interface AgentPatch {
  readonly name?: string;
  readonly description?: string | null;
  readonly privacyProfile?: PrivacyProfile;
  readonly status?: AgentStatus;
  readonly modelRouting?: Record<string, unknown> | null;
  readonly canvasPosition?: CanvasPosition | null;
  /**
   * W5 memory-ACL rollout switch (#899). Absent leaves the stored value
   * untouched: the UPDATE below uses `COALESCE`, so a patch that does not
   * mention the flag can never silently reset an enforcing agent back to
   * `'off'`. The column's CHECK constraint (migration 0050) covers the same
   * three values, so a widened union cannot reach the database either.
   */
  readonly contextMemory?: ContextMemoryMode;
  /** #1018 — same COALESCE contract as `contextMemory`: absent leaves it. */
  readonly agentToAgent?: AgentToAgentMode;
  /** #1033 — validated by the caller ({@link validateModelPolicy}); absent leaves it. */
  readonly modelPolicy?: ModelPolicy;
}

export interface AgentPluginInput {
  readonly pluginId: string;
  readonly config?: Record<string, unknown>;
  readonly enabled?: boolean;
}

export interface ChannelBindingInput {
  readonly channelType: string;
  readonly channelKey: string;
}

/**
 * Surfaced when a write violates a domain rule (validation rules in T016).
 * Distinct class so callers (CLI, REST handlers) can map to a 4xx instead of
 * leaking the raw `pg` error.
 */
export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/**
 * Validate persisted `model_routing` JSON before write. Shape:
 *   { mode: 'single'|'triage', main: <ref>, triage?: <ref>, simple?: <ref> }
 * Each `<ref>` must resolve via `resolveModelRef` (provider-qualified id,
 * legacy alias, bare vendor id, or `class:*`). An empty `main` is illegal —
 * use `null` to clear. Optional fields may be absent or empty-string (latter
 * treated as absent so a UI dropdown's "(default)" choice round-trips cleanly).
 */
export function validateModelRoutingShape(
  routing: Record<string, unknown>,
  activeProvider?: string,
): void {
  const mode = routing['mode'];
  if (mode !== 'single' && mode !== 'triage') {
    throw new ConfigValidationError(
      `modelRouting.mode must be 'single' or 'triage' (got ${JSON.stringify(mode)})`,
    );
  }
  const main = routing['main'];
  if (typeof main !== 'string' || main.trim() === '') {
    throw new ConfigValidationError(
      `modelRouting.main is required (clear routing by passing null instead)`,
    );
  }
  validateModelRef(`modelRouting.main`, main.trim(), activeProvider);
  if (mode === 'triage') {
    for (const key of ['triage', 'simple'] as const) {
      const raw = routing[key];
      if (raw === undefined || raw === null) continue;
      if (typeof raw !== 'string') {
        throw new ConfigValidationError(
          `modelRouting.${key} must be a string (got ${typeof raw})`,
        );
      }
      const trimmed = raw.trim();
      if (trimmed === '') continue;
      validateModelRef(`modelRouting.${key}`, trimmed, activeProvider);
    }
  }
}

/**
 * Throw `ConfigValidationError` when `ref` is non-empty and does not resolve
 * to any model registered with `@omadia/llm-provider`. Used by every persisted
 * model-id surface (orchestrator routing, sub-agent overrides) so the operator
 * cannot pin runtime to an id the live provider set does not serve — an
 * unknown id would 404 at every turn. Empty / whitespace `ref` is rejected —
 * callers should skip the validator when clearing the field instead.
 *
 * When `activeProvider` is given (the orchestrator's single configured
 * provider), the ref is resolved in that provider's context AND a ref that
 * resolves to a DIFFERENT provider is rejected: cross-provider routing is out
 * of scope (issue #296) and would be silently dropped to the platform default
 * at build, so the picker must not be able to persist a model the Agent never
 * actually runs on. Without it the check is provider-agnostic (legacy).
 */
export function validateModelRef(
  field: string,
  ref: string,
  activeProvider?: string,
): void {
  if (typeof ref !== 'string' || ref.trim() === '') {
    throw new ConfigValidationError(
      `${field} must be a non-empty model ref (clear with null instead)`,
    );
  }
  const info = resolveModelRef(
    ref.trim(),
    activeProvider ? { defaultProvider: activeProvider } : {},
  );
  if (info === undefined) {
    throw new ConfigValidationError(
      `${field} '${ref}' is not registered with any installed LLM provider`,
    );
  }
  if (activeProvider && info.provider !== activeProvider) {
    throw new ConfigValidationError(
      `${field} '${ref}' resolves to provider '${info.provider}', but the ` +
        `orchestrator runs on '${activeProvider}' — cross-provider model ` +
        `selection is not supported; pick a '${activeProvider}' model`,
    );
  }
}

interface AgentDbRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  privacy_profile: PrivacyProfile;
  status: AgentStatus;
  model_routing: Record<string, unknown> | null;
  canvas_position: CanvasPosition | null;
  /** W5 — `agents.context_memory`; absent on a DB that predates migration 0050. */
  context_memory?: string | null;
  /** #1018 — `agents.agent_to_agent`; absent on a DB that predates 0058. */
  agent_to_agent?: string | null;
  /** #1033 — `agents.model_policy`; absent on a DB that predates 0059. */
  model_policy?: unknown;
  /** #1033 — `agent_identities.composed_prompts`, joined by the read queries. */
  identity_composed_prompts?: Record<string, unknown> | null;
  /** #914 — `agent_identities.instructions`, joined in by the three read
   *  queries below. Absent on the RETURNING rows of the write paths, which do
   *  not join: a write never changes the identity, and a caller that needs it
   *  re-reads. */
  identity_instructions?: string | null;
  /** #967 — `agent_identities.display_name`, joined in by the same three read
   *  queries and absent on the same write paths as `identity_instructions`. */
  identity_display_name?: string | null;
  /** #967 follow-up — `agent_identities.short_description` / `.long_description`,
   *  joined in by the same three read queries and absent on the same write
   *  paths as `identity_instructions`. */
  identity_short_description?: string | null;
  identity_long_description?: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Narrow the persisted `context_memory` text to the typed rollout mode.
 *
 * Deny-default: anything the running code does not recognise — a NULL from a
 * pre-0050 database, a value written by a NEWER middleware during a rolling
 * deploy, a hand-edited row — resolves to `'off'`, which is today's
 * agent-global behaviour. The alternative failure direction (treating an
 * unknown value as `'enforce'`) would change memory routing on a rollback, and
 * the safe direction here is the one that changes nothing.
 */
function parseContextMemoryMode(raw: unknown): ContextMemoryMode {
  return raw === 'enforce' || raw === 'enforce-strict' ? raw : 'off';
}

interface AgentPluginDbRow {
  agent_id: string;
  plugin_id: string;
  config: Record<string, unknown>;
  enabled: boolean;
  created_at: Date;
}

interface ChannelBindingDbRow {
  channel_type: string;
  channel_key: string;
  agent_id: string;
  created_at: Date;
}

interface PlatformSettingsDbRow {
  fallback_agent_id: string | null;
  updated_at: Date;
}

interface AgentChannelPolicyDbRow {
  channel_type: string;
  channel_key: string;
  agent_id: string;
  agent_to_agent: boolean;
  created_at: Date;
  updated_at: Date;
}

function mapAgentChannelPolicy(row: AgentChannelPolicyDbRow): AgentChannelPolicyRow {
  return {
    channelType: row.channel_type,
    channelKey: row.channel_key,
    agentId: row.agent_id,
    agentToAgent: row.agent_to_agent === true,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAgent(row: AgentDbRow): AgentRow {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    privacyProfile: row.privacy_profile,
    status: row.status,
    modelRouting: row.model_routing ?? null,
    canvasPosition: row.canvas_position ?? null,
    contextMemory: parseContextMemoryMode(row.context_memory),
    agentToAgent: parseAgentToAgentMode(row.agent_to_agent),
    modelPolicy: parseModelPolicy(row.model_policy),
    ...(row.identity_composed_prompts && typeof row.identity_composed_prompts === 'object'
      ? {
          instructionsByFamily: Object.fromEntries(
            Object.entries(row.identity_composed_prompts).filter(
              (e): e is [string, string] => typeof e[1] === 'string' && e[1].trim().length > 0,
            ),
          ),
        }
      : {}),
    instructions: row.identity_instructions ?? null,
    identityName: row.identity_display_name ?? null,
    identityShortDescription: row.identity_short_description ?? null,
    identityLongDescription: row.identity_long_description ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAgentPlugin(row: AgentPluginDbRow): AgentPluginRow {
  return {
    agentId: row.agent_id,
    pluginId: row.plugin_id,
    config: row.config,
    enabled: row.enabled,
    createdAt: row.created_at,
  };
}

function mapBinding(row: ChannelBindingDbRow): ChannelBindingRow {
  return {
    channelType: row.channel_type,
    channelKey: row.channel_key,
    agentId: row.agent_id,
    createdAt: row.created_at,
  };
}

function mapPlatformSettings(
  row: PlatformSettingsDbRow,
): PlatformSettingsRow {
  return {
    fallbackAgentId: row.fallback_agent_id,
    updatedAt: row.updated_at,
  };
}

/**
 * #914 — every agent read joins the agent's authored identity, so the
 * registry can build an Agent's system prompt from it without a per-Agent
 * second query. `a.*` keeps the row shape every existing caller already gets;
 * the LEFT JOIN keeps an agent without an identity intact.
 *
 * COALESCE, not a raw column: `composed_prompt` is the identity's authored
 * text WITH its persona, boundaries and sycophancy sections compiled in
 * (migration 0053), and it is what the agent should actually speak with. It
 * is NULL for a row written before those existed, or for one whose settings
 * compile to nothing — and then the raw `instructions` is exactly right. The
 * compilers live in the middleware, which this package cannot import; that
 * is why the composition is stored rather than done here.
 *
 * The two description columns (#967 follow-up) ride along because they are the
 * other half of what the operator authored about this agent: `composed_prompt`
 * says how it behaves, they say what it IS. Joining them here rather than in a
 * per-Agent second query keeps the cost of a rebuild at one round trip.
 *
 * Only text is joined. The identity's avatar columns are BYTEA and this query
 * runs on every dashboard load and every registry rebuild — and `accent_color`
 * is left out for the same reason it never reaches a prompt: it is a rendering
 * decision, not something an agent can act on.
 */
const AGENT_SELECT =
  'SELECT a.*, COALESCE(i.composed_prompt, i.instructions) AS identity_instructions, ' +
  'i.composed_prompts AS identity_composed_prompts, ' +
  'i.display_name AS identity_display_name, ' +
  'i.short_description AS identity_short_description, ' +
  'i.long_description AS identity_long_description ' +
  'FROM agents a LEFT JOIN agent_identities i ON i.agent_id = a.id';

export class ConfigStore {
  constructor(private readonly pool: Pool) {}

  // ── agents ────────────────────────────────────────────────────────────
  async listAgents(): Promise<readonly AgentRow[]> {
    const { rows } = await this.pool.query<AgentDbRow>(
      `${AGENT_SELECT} ORDER BY a.slug`,
    );
    return rows.map(mapAgent);
  }

  async getAgentBySlug(slug: string): Promise<AgentRow | undefined> {
    const { rows } = await this.pool.query<AgentDbRow>(
      `${AGENT_SELECT} WHERE a.slug = $1`,
      [slug],
    );
    return rows[0] ? mapAgent(rows[0]) : undefined;
  }

  async getAgentById(id: string): Promise<AgentRow | undefined> {
    const { rows } = await this.pool.query<AgentDbRow>(
      `${AGENT_SELECT} WHERE a.id = $1`,
      [id],
    );
    return rows[0] ? mapAgent(rows[0]) : undefined;
  }

  async createAgent(input: AgentInput): Promise<AgentRow> {
    if (!SLUG_RE.test(input.slug)) {
      throw new ConfigValidationError(
        `agent slug "${input.slug}" is not URL-safe (lowercase, digits, hyphens; 1..64 chars)`,
      );
    }
    try {
      const { rows } = await this.pool.query<AgentDbRow>(
        `INSERT INTO agents (slug, name, description, privacy_profile, status)
         VALUES ($1, $2, $3, COALESCE($4, 'default'), COALESCE($5, 'enabled'))
         RETURNING *`,
        [
          input.slug,
          input.name,
          input.description ?? null,
          input.privacyProfile ?? null,
          input.status ?? null,
        ],
      );
      // INSERT ... RETURNING with non-zero rowcount always yields exactly
      // one row; the assertion is here for the type narrowing.
      const row = rows[0];
      if (!row) {
        throw new Error('createAgent: INSERT RETURNING produced no row');
      }
      return mapAgent(row);
    } catch (err) {
      if (isUniqueViolation(err, 'agents_slug_key')) {
        throw new ConfigValidationError(
          `agent slug "${input.slug}" already exists`,
        );
      }
      throw err;
    }
  }

  async updateAgent(id: string, patch: AgentPatch): Promise<AgentRow> {
    const { rows } = await this.pool.query<AgentDbRow>(
      `UPDATE agents SET
         name            = COALESCE($2, name),
         description     = COALESCE($3, description),
         privacy_profile = COALESCE($4, privacy_profile),
         status          = COALESCE($5, status),
         model_routing   = COALESCE($6::jsonb, model_routing),
         canvas_position = COALESCE($7::jsonb, canvas_position),
         context_memory  = COALESCE($8, context_memory),
         agent_to_agent  = COALESCE($9, agent_to_agent),
         model_policy    = COALESCE($10::jsonb, model_policy),
         updated_at      = now()
       WHERE id = $1
       RETURNING *`,
      [
        id,
        patch.name ?? null,
        patch.description ?? null,
        patch.privacyProfile ?? null,
        patch.status ?? null,
        patch.modelRouting ? JSON.stringify(patch.modelRouting) : null,
        patch.canvasPosition ? JSON.stringify(patch.canvasPosition) : null,
        patch.contextMemory ?? null,
        patch.agentToAgent ?? null,
        patch.modelPolicy ? JSON.stringify(patch.modelPolicy) : null,
      ],
    );
    const row = rows[0];
    if (!row) {
      throw new ConfigValidationError(`agent ${id} not found`);
    }
    return mapAgent(row);
  }

  // ── #1018 — per-(channel, agent) peer policies (migration 0058) ──────

  async listAgentChannelPolicies(agentId: string): Promise<AgentChannelPolicyRow[]> {
    const { rows } = await this.pool.query<AgentChannelPolicyDbRow>(
      `SELECT channel_type, channel_key, agent_id, agent_to_agent, created_at, updated_at
         FROM agent_channel_policies
        WHERE agent_id = $1
        ORDER BY channel_type, channel_key`,
      [agentId],
    );
    return rows.map(mapAgentChannelPolicy);
  }

  /** All policies for one chat — what the relay needs to filter partners. */
  async listChannelPeerPolicies(
    channelType: string,
    channelKey: string,
  ): Promise<AgentChannelPolicyRow[]> {
    const { rows } = await this.pool.query<AgentChannelPolicyDbRow>(
      `SELECT channel_type, channel_key, agent_id, agent_to_agent, created_at, updated_at
         FROM agent_channel_policies
        WHERE channel_type = $1 AND channel_key = $2`,
      [channelType, channelKey],
    );
    return rows.map(mapAgentChannelPolicy);
  }

  async getAgentChannelPolicy(
    channelType: string,
    channelKey: string,
    agentId: string,
  ): Promise<AgentChannelPolicyRow | undefined> {
    const { rows } = await this.pool.query<AgentChannelPolicyDbRow>(
      `SELECT channel_type, channel_key, agent_id, agent_to_agent, created_at, updated_at
         FROM agent_channel_policies
        WHERE channel_type = $1 AND channel_key = $2 AND agent_id = $3`,
      [channelType, channelKey, agentId],
    );
    const row = rows[0];
    return row ? mapAgentChannelPolicy(row) : undefined;
  }

  async upsertAgentChannelPolicy(
    input: AgentChannelPolicyInput,
  ): Promise<AgentChannelPolicyRow> {
    const { rows } = await this.pool.query<AgentChannelPolicyDbRow>(
      `INSERT INTO agent_channel_policies
         (channel_type, channel_key, agent_id, agent_to_agent)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (channel_type, channel_key, agent_id)
       DO UPDATE SET agent_to_agent = EXCLUDED.agent_to_agent, updated_at = now()
       RETURNING channel_type, channel_key, agent_id, agent_to_agent, created_at, updated_at`,
      [input.channelType, input.channelKey, input.agentId, input.agentToAgent],
    );
    const row = rows[0];
    if (!row) {
      throw new Error('upsertAgentChannelPolicy: INSERT RETURNING produced no row');
    }
    return mapAgentChannelPolicy(row);
  }

  async deleteAgentChannelPolicy(
    channelType: string,
    channelKey: string,
    agentId: string,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM agent_channel_policies
        WHERE channel_type = $1 AND channel_key = $2 AND agent_id = $3`,
      [channelType, channelKey, agentId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async deleteAgent(id: string): Promise<void> {
    await this.pool.query('DELETE FROM agents WHERE id = $1', [id]);
  }

  /** Agent Builder — set (or clear, with null) the per-agent model routing.
   *  Direct write (not COALESCE) so the operator can disable routing.
   *
   *  Validates `main`/`triage`/`simple` against `@omadia/llm-provider` so an
   *  operator (or a stale REST client) cannot pin an agent to a model id that
   *  no installed provider serves — that would crash every turn at runtime
   *  with `404 not_found_error`. `null` clears routing back to the platform
   *  default and skips validation. */
  async setModelRouting(
    id: string,
    routing: Record<string, unknown> | null,
    activeProvider?: string,
  ): Promise<AgentRow> {
    if (routing) validateModelRoutingShape(routing, activeProvider);
    const { rows } = await this.pool.query<AgentDbRow>(
      `UPDATE agents SET model_routing = $2::jsonb, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, routing ? JSON.stringify(routing) : null],
    );
    const row = rows[0];
    if (!row) throw new ConfigValidationError(`agent ${id} not found`);
    return mapAgent(row);
  }

  /** Agent Builder — persist an agent's cosmetic canvas coordinate. */
  async setCanvasPosition(
    id: string,
    pos: CanvasPosition | null,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE agents SET canvas_position = $2::jsonb WHERE id = $1`,
      [id, pos ? JSON.stringify(pos) : null],
    );
  }

  /** Agent Builder — persist a channel binding's cosmetic canvas coordinate. */
  async setChannelBindingPosition(
    channelType: string,
    channelKey: string,
    pos: CanvasPosition | null,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE channel_bindings SET canvas_position = $3::jsonb
       WHERE channel_type = $1 AND channel_key = $2`,
      [channelType, channelKey, pos ? JSON.stringify(pos) : null],
    );
  }

  // ── agent_plugins ─────────────────────────────────────────────────────
  async listAgentPlugins(
    agentId: string,
  ): Promise<readonly AgentPluginRow[]> {
    const { rows } = await this.pool.query<AgentPluginDbRow>(
      'SELECT * FROM agent_plugins WHERE agent_id = $1 ORDER BY plugin_id',
      [agentId],
    );
    return rows.map(mapAgentPlugin);
  }

  async listAllAgentPlugins(): Promise<readonly AgentPluginRow[]> {
    const { rows } = await this.pool.query<AgentPluginDbRow>(
      'SELECT * FROM agent_plugins ORDER BY agent_id, plugin_id',
    );
    return rows.map(mapAgentPlugin);
  }

  async upsertAgentPlugin(
    agentId: string,
    input: AgentPluginInput,
  ): Promise<AgentPluginRow> {
    const { rows } = await this.pool.query<AgentPluginDbRow>(
      `INSERT INTO agent_plugins (agent_id, plugin_id, config, enabled)
       VALUES ($1, $2, COALESCE($3::jsonb, '{}'::jsonb), COALESCE($4, true))
       ON CONFLICT (agent_id, plugin_id) DO UPDATE SET
         config  = EXCLUDED.config,
         enabled = EXCLUDED.enabled
       RETURNING *`,
      [
        agentId,
        input.pluginId,
        input.config ? JSON.stringify(input.config) : null,
        input.enabled ?? null,
      ],
    );
    const row = rows[0];
    if (!row) {
      throw new Error('upsertAgentPlugin: RETURNING produced no row');
    }
    return mapAgentPlugin(row);
  }

  async removeAgentPlugin(agentId: string, pluginId: string): Promise<void> {
    await this.pool.query(
      'DELETE FROM agent_plugins WHERE agent_id = $1 AND plugin_id = $2',
      [agentId, pluginId],
    );
  }

  // ── channel_bindings ──────────────────────────────────────────────────
  async listChannelBindings(): Promise<readonly ChannelBindingRow[]> {
    const { rows } = await this.pool.query<ChannelBindingDbRow>(
      'SELECT * FROM channel_bindings ORDER BY channel_type, channel_key',
    );
    return rows.map(mapBinding);
  }

  async listChannelBindingsForAgent(
    agentId: string,
  ): Promise<readonly ChannelBindingRow[]> {
    const { rows } = await this.pool.query<ChannelBindingDbRow>(
      `SELECT * FROM channel_bindings
       WHERE agent_id = $1
       ORDER BY channel_type, channel_key`,
      [agentId],
    );
    return rows.map(mapBinding);
  }

  async resolveBinding(
    channelType: string,
    channelKey: string,
  ): Promise<ChannelBindingRow | undefined> {
    const { rows } = await this.pool.query<ChannelBindingDbRow>(
      `SELECT * FROM channel_bindings
       WHERE channel_type = $1 AND channel_key = $2`,
      [channelType, channelKey],
    );
    return rows[0] ? mapBinding(rows[0]) : undefined;
  }

  async createChannelBinding(
    agentId: string,
    input: ChannelBindingInput,
  ): Promise<ChannelBindingRow> {
    try {
      const { rows } = await this.pool.query<ChannelBindingDbRow>(
        `INSERT INTO channel_bindings (channel_type, channel_key, agent_id)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [input.channelType, input.channelKey, agentId],
      );
      const row = rows[0];
      if (!row) {
        throw new Error('createChannelBinding: RETURNING produced no row');
      }
      return mapBinding(row);
    } catch (err) {
      if (isUniqueViolation(err, 'channel_bindings_pkey')) {
        throw new ConfigValidationError(
          `channel binding (${input.channelType}, ${input.channelKey}) already bound to another agent`,
        );
      }
      throw err;
    }
  }

  async removeChannelBinding(
    channelType: string,
    channelKey: string,
  ): Promise<void> {
    await this.pool.query(
      `DELETE FROM channel_bindings
       WHERE channel_type = $1 AND channel_key = $2`,
      [channelType, channelKey],
    );
  }

  // ── channel identities (provisioned bots) ─────────────────────────────
  /**
   * Every provisioned Microsoft Teams bot as a routing key.
   *
   * `agent_teams_identities` already holds the only mapping that matters —
   * `app_id` (the bot's Entra application id) against the agent it was
   * provisioned for. The Bot-Framework identity the middleware sees on an
   * inbound activity is `activity.recipient.id`, i.e. `28:<appId>`
   * lowercased; the Teams plugin builds the same string with its
   * `teamsBotKey()` helper and exact string equality is what routes, so the
   * projection is done here in SQL rather than anywhere a second spelling
   * could creep in.
   *
   * Rows without an `app_id` are provisioning runs that have not reached the
   * app-registration step — there is no bot to route to yet, so they are
   * skipped rather than projected to a `28:null` key.
   *
   * MISSING TABLE IS NOT AN ERROR. This package is embeddable without the
   * platform's migration series (`agent_teams_identities` arrives in
   * middleware/migrations/0049). "No identity table" means "no provisioned
   * bots", which is exactly the pre-existing behaviour — so an
   * undefined_table degrades to an empty list instead of taking the whole
   * snapshot load, and with it the registry boot, down with it.
   */
  async listChannelIdentities(): Promise<readonly ChannelIdentityRow[]> {
    try {
      const { rows } = await this.pool.query<{
        agent_id: string;
        channel_key: string;
      }>(
        `SELECT agent_id, '28:' || lower(app_id) AS channel_key
           FROM agent_teams_identities
          WHERE app_id IS NOT NULL AND app_id <> ''
          ORDER BY channel_key`,
      );
      return rows.map((r) => ({
        channelType: 'teams',
        channelKey: r.channel_key,
        agentId: r.agent_id,
      }));
    } catch (err) {
      if (isUndefinedTable(err)) return [];
      throw err;
    }
  }

  // ── multi_orchestrator_settings ─────────────────────────────────────────────────
  async getPlatformSettings(): Promise<PlatformSettingsRow> {
    const { rows } = await this.pool.query<PlatformSettingsDbRow>(
      'SELECT fallback_agent_id, updated_at FROM multi_orchestrator_settings WHERE id = true',
    );
    if (rows[0]) return mapPlatformSettings(rows[0]);
    // Migration seeds a row, but defensively upsert in case it was wiped.
    await this.pool.query(
      'INSERT INTO multi_orchestrator_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING',
    );
    return { fallbackAgentId: null, updatedAt: new Date() };
  }

  async setFallbackAgentId(agentId: string | null): Promise<PlatformSettingsRow> {
    const { rows } = await this.pool.query<PlatformSettingsDbRow>(
      `INSERT INTO multi_orchestrator_settings (id, fallback_agent_id, updated_at)
       VALUES (true, $1, now())
       ON CONFLICT (id) DO UPDATE SET
         fallback_agent_id = EXCLUDED.fallback_agent_id,
         updated_at        = now()
       RETURNING fallback_agent_id, updated_at`,
      [agentId],
    );
    const row = rows[0];
    if (!row) {
      throw new Error('setFallbackAgentId: RETURNING produced no row');
    }
    return mapPlatformSettings(row);
  }

  // ── aggregate read for the registry ───────────────────────────────────
  /**
   * Single-snapshot read of every config table. The registry calls this on
   * boot (and again on each `agents_changed` notification in US5) so the
   * registry sees a consistent view across all four tables without holding a
   * cross-table transaction.
   *
   * NOT transactional — concurrent writes during the call may produce a
   * mildly-stale snapshot. The US5 reload bus catches up on the next NOTIFY.
   */
  async loadSnapshot(): Promise<ConfigSnapshot> {
    const graph = new AgentGraphStore(this.pool);
    const [
      agents,
      plugins,
      bindings,
      identities,
      settings,
      subAgents,
      toolGrants,
      schedules,
      skills,
      mcpServers,
      personaSkillLinks,
      skillToolBindings,
    ] = await Promise.all([
      this.listAgents(),
      this.listAllAgentPlugins(),
      this.listChannelBindings(),
      this.listChannelIdentities(),
      this.getPlatformSettings(),
      graph.listAllSubAgents(),
      graph.listAllToolGrants(),
      graph.listAllSchedules(),
      graph.listSkills(),
      graph.listMcpServers(),
      graph.listAllPersonaSkillLinks(),
      graph.listAllSkillToolBindings(),
    ]);
    return {
      agents,
      agentPlugins: plugins,
      channelBindings: bindings,
      channelIdentities: identities,
      platformSettings: settings,
      subAgents,
      toolGrants,
      schedules,
      skills,
      mcpServers,
      personaSkillLinks,
      skillToolBindings,
    };
  }
}

export interface ConfigSnapshot {
  readonly agents: readonly AgentRow[];
  readonly agentPlugins: readonly AgentPluginRow[];
  readonly channelBindings: readonly ChannelBindingRow[];
  /**
   * Provisioned channel identities (see {@link ChannelIdentityRow}). Optional
   * so snapshot literals written before this existed — tests, fixtures, an
   * embedding host — stay valid and keep their pre-existing routing; a
   * deployment with no provisioned bots is indistinguishable from one that
   * never had the field.
   */
  readonly channelIdentities?: readonly ChannelIdentityRow[];
  readonly platformSettings: PlatformSettingsRow;
  // Agent Builder graph (P0). Optional so pre-existing snapshot literals
  // (tests, fixtures) stay valid; `loadSnapshot` always populates them.
  readonly subAgents?: readonly SubAgentRow[];
  readonly toolGrants?: readonly ToolGrantRow[];
  readonly schedules?: readonly ScheduleRow[];
  readonly skills?: readonly SkillRow[];
  /** Wave 8 — Agent → direct-answer persona-skill links. */
  readonly personaSkillLinks?: readonly PersonaSkillRow[];
  readonly mcpServers?: readonly McpServerRow[];
  /** Epic #459 W4 — operator bindings of skill capability contracts. */
  readonly skillToolBindings?: readonly SkillToolBindingRow[];
}

/** Postgres `undefined_table` (42P01) — the relation does not exist. */
function isUndefinedTable(err: unknown): boolean {
  return (
    !!err &&
    typeof err === 'object' &&
    (err as { code?: string }).code === '42P01'
  );
}

function isUniqueViolation(err: unknown, constraint?: string): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: string }).code;
  if (code !== '23505') return false;
  if (!constraint) return true;
  const c = (err as { constraint?: string }).constraint;
  return c === constraint;
}
