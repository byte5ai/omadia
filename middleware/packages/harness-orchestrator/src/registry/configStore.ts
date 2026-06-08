import type { Pool } from 'pg';

import {
  AgentGraphStore,
  type ScheduleRow,
  type SkillRow,
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

interface AgentDbRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  privacy_profile: PrivacyProfile;
  status: AgentStatus;
  model_routing: Record<string, unknown> | null;
  canvas_position: CanvasPosition | null;
  created_at: Date;
  updated_at: Date;
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

export class ConfigStore {
  constructor(private readonly pool: Pool) {}

  // ── agents ────────────────────────────────────────────────────────────
  async listAgents(): Promise<readonly AgentRow[]> {
    const { rows } = await this.pool.query<AgentDbRow>(
      'SELECT * FROM agents ORDER BY slug',
    );
    return rows.map(mapAgent);
  }

  async getAgentBySlug(slug: string): Promise<AgentRow | undefined> {
    const { rows } = await this.pool.query<AgentDbRow>(
      'SELECT * FROM agents WHERE slug = $1',
      [slug],
    );
    return rows[0] ? mapAgent(rows[0]) : undefined;
  }

  async getAgentById(id: string): Promise<AgentRow | undefined> {
    const { rows } = await this.pool.query<AgentDbRow>(
      'SELECT * FROM agents WHERE id = $1',
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
      ],
    );
    const row = rows[0];
    if (!row) {
      throw new ConfigValidationError(`agent ${id} not found`);
    }
    return mapAgent(row);
  }

  async deleteAgent(id: string): Promise<void> {
    await this.pool.query('DELETE FROM agents WHERE id = $1', [id]);
  }

  /** Agent Builder — set (or clear, with null) the per-agent model routing.
   *  Direct write (not COALESCE) so the operator can disable routing. */
  async setModelRouting(
    id: string,
    routing: Record<string, unknown> | null,
  ): Promise<AgentRow> {
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
      settings,
      subAgents,
      toolGrants,
      schedules,
      skills,
      mcpServers,
    ] = await Promise.all([
      this.listAgents(),
      this.listAllAgentPlugins(),
      this.listChannelBindings(),
      this.getPlatformSettings(),
      graph.listAllSubAgents(),
      graph.listAllToolGrants(),
      graph.listAllSchedules(),
      graph.listSkills(),
      graph.listMcpServers(),
    ]);
    return {
      agents,
      agentPlugins: plugins,
      channelBindings: bindings,
      platformSettings: settings,
      subAgents,
      toolGrants,
      schedules,
      skills,
      mcpServers,
    };
  }
}

export interface ConfigSnapshot {
  readonly agents: readonly AgentRow[];
  readonly agentPlugins: readonly AgentPluginRow[];
  readonly channelBindings: readonly ChannelBindingRow[];
  readonly platformSettings: PlatformSettingsRow;
  // Agent Builder graph (P0). Optional so pre-existing snapshot literals
  // (tests, fixtures) stay valid; `loadSnapshot` always populates them.
  readonly subAgents?: readonly SubAgentRow[];
  readonly toolGrants?: readonly ToolGrantRow[];
  readonly schedules?: readonly ScheduleRow[];
  readonly skills?: readonly SkillRow[];
  readonly mcpServers?: readonly McpServerRow[];
}

function isUniqueViolation(err: unknown, constraint?: string): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: string }).code;
  if (code !== '23505') return false;
  if (!constraint) return true;
  const c = (err as { constraint?: string }).constraint;
  return c === constraint;
}
