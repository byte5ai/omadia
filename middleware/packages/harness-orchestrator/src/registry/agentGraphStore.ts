import type { Pool } from 'pg';

import { ConfigValidationError } from './configStore.js';
import { computeSkillHash } from './skillHash.js';

/**
 * Agent Builder graph store (P0).
 *
 * Pure CRUD against the editable graph tables introduced by
 * `0003_agent_builder_graph.sql` (skills, mcp_servers, agent_subagents,
 * agent_tool_grants, agent_schedules). Kept separate from `ConfigStore` so the
 * latter stays under the 500-line cap; `ConfigStore.loadSnapshot` composes the
 * `list*` methods here into the registry snapshot.
 *
 * Like `ConfigStore`, this enforces only what the DB enforces (PK uniqueness,
 * FK cascades, CHECK constraints) — graph-level validation (cycles, privacy
 * conflicts) lives in the REST edge-create validator (P2).
 */

// ── row shapes (camelCase, mapped from snake_case DB rows) ──────────────────

export interface CanvasPos {
  readonly x: number;
  readonly y: number;
}

export interface SubAgentRow {
  readonly id: string;
  readonly parentAgentId: string;
  readonly name: string;
  readonly skillId: string | null;
  readonly model: string | null;
  readonly maxTokens: number | null;
  readonly maxIterations: number | null;
  readonly systemPromptOverride: string | null;
  readonly status: 'enabled' | 'disabled';
  readonly position: CanvasPos | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface SkillRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly body: string;
  readonly frontmatter: Record<string, unknown>;
  readonly source: 'db' | 'file';
  readonly sourcePath: string | null;
  /** sha256 of the canonical {frontmatter + body}; null until first write. */
  readonly contentHash: string | null;
  /** Origin skill id when this row is an editable fork of an imported skill. */
  readonly forkedFrom: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface McpServerRow {
  readonly id: string;
  readonly name: string;
  readonly transport: 'stdio' | 'http' | 'sse';
  readonly endpoint: string | null;
  readonly headers: Record<string, unknown>;
  readonly secretRef: string | null;
  readonly status: 'enabled' | 'disabled';
  readonly lastDiscoveredAt: Date | null;
  readonly discoveredTools: readonly unknown[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ToolGrantRow {
  readonly id: string;
  readonly agentId: string | null;
  readonly subAgentId: string | null;
  readonly toolKind: 'native' | 'mcp';
  readonly toolRef: string;
  readonly mcpServerId: string | null;
  readonly config: Record<string, unknown>;
  readonly createdAt: Date;
}

export interface ScheduleRow {
  readonly id: string;
  readonly agentId: string;
  readonly cron: string;
  readonly payload: Record<string, unknown>;
  readonly timezone: string;
  readonly status: 'enabled' | 'disabled';
  readonly lastRunAt: Date | null;
  readonly createdAt: Date;
}

// ── inputs ──────────────────────────────────────────────────────────────────

export interface SubAgentInput {
  readonly parentAgentId: string;
  readonly name: string;
  readonly skillId?: string | null;
  readonly model?: string | null;
  readonly maxTokens?: number | null;
  readonly maxIterations?: number | null;
  readonly systemPromptOverride?: string | null;
  readonly status?: 'enabled' | 'disabled';
  readonly position?: CanvasPos | null;
}

export interface SubAgentPatch {
  readonly name?: string;
  readonly skillId?: string | null;
  readonly model?: string | null;
  readonly maxTokens?: number | null;
  readonly maxIterations?: number | null;
  readonly systemPromptOverride?: string | null;
  readonly status?: 'enabled' | 'disabled';
  readonly position?: CanvasPos | null;
}

export interface SkillInput {
  readonly slug: string;
  readonly name: string;
  readonly description?: string | null;
  readonly body?: string;
  readonly frontmatter?: Record<string, unknown>;
  readonly source?: 'db' | 'file';
  readonly sourcePath?: string | null;
  /** Set only when creating an editable fork of an imported skill (#397). */
  readonly forkedFrom?: string | null;
}

export interface SkillPatch {
  readonly name?: string;
  readonly description?: string | null;
  readonly body?: string;
  readonly frontmatter?: Record<string, unknown>;
}

export interface McpServerInput {
  readonly name: string;
  readonly transport: 'stdio' | 'http' | 'sse';
  readonly endpoint?: string | null;
  readonly headers?: Record<string, unknown>;
  readonly secretRef?: string | null;
  readonly status?: 'enabled' | 'disabled';
}

export interface ToolGrantInput {
  readonly agentId?: string | null;
  readonly subAgentId?: string | null;
  readonly toolKind: 'native' | 'mcp';
  readonly toolRef: string;
  readonly mcpServerId?: string | null;
  readonly config?: Record<string, unknown>;
}

export interface ScheduleInput {
  readonly agentId: string;
  readonly cron: string;
  readonly payload?: Record<string, unknown>;
  readonly timezone?: string;
  readonly status?: 'enabled' | 'disabled';
}

// ── DB row shapes ─────────────────────────────────────────────────────────

interface SubAgentDbRow {
  id: string;
  parent_agent_id: string;
  name: string;
  skill_id: string | null;
  model: string | null;
  max_tokens: number | null;
  max_iterations: number | null;
  system_prompt_override: string | null;
  status: 'enabled' | 'disabled';
  position: CanvasPos | null;
  created_at: Date;
  updated_at: Date;
}

interface SkillDbRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  body: string;
  frontmatter: Record<string, unknown>;
  source: 'db' | 'file';
  source_path: string | null;
  content_hash: string | null;
  forked_from: string | null;
  created_at: Date;
  updated_at: Date;
}

interface McpServerDbRow {
  id: string;
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  endpoint: string | null;
  headers: Record<string, unknown>;
  secret_ref: string | null;
  status: 'enabled' | 'disabled';
  last_discovered_at: Date | null;
  discovered_tools: unknown[];
  created_at: Date;
  updated_at: Date;
}

interface ToolGrantDbRow {
  id: string;
  agent_id: string | null;
  subagent_id: string | null;
  tool_kind: 'native' | 'mcp';
  tool_ref: string;
  mcp_server_id: string | null;
  config: Record<string, unknown>;
  created_at: Date;
}

interface ScheduleDbRow {
  id: string;
  agent_id: string;
  cron: string;
  payload: Record<string, unknown>;
  timezone: string;
  status: 'enabled' | 'disabled';
  last_run_at: Date | null;
  created_at: Date;
}

// ── mappers ─────────────────────────────────────────────────────────────────

function mapSubAgent(r: SubAgentDbRow): SubAgentRow {
  return {
    id: r.id,
    parentAgentId: r.parent_agent_id,
    name: r.name,
    skillId: r.skill_id,
    model: r.model,
    maxTokens: r.max_tokens,
    maxIterations: r.max_iterations,
    systemPromptOverride: r.system_prompt_override,
    status: r.status,
    position: r.position,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapSkill(r: SkillDbRow): SkillRow {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    description: r.description,
    body: r.body,
    frontmatter: r.frontmatter,
    source: r.source,
    sourcePath: r.source_path,
    contentHash: r.content_hash,
    forkedFrom: r.forked_from,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapMcpServer(r: McpServerDbRow): McpServerRow {
  return {
    id: r.id,
    name: r.name,
    transport: r.transport,
    endpoint: r.endpoint,
    headers: r.headers,
    secretRef: r.secret_ref,
    status: r.status,
    lastDiscoveredAt: r.last_discovered_at,
    discoveredTools: r.discovered_tools,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapToolGrant(r: ToolGrantDbRow): ToolGrantRow {
  return {
    id: r.id,
    agentId: r.agent_id,
    subAgentId: r.subagent_id,
    toolKind: r.tool_kind,
    toolRef: r.tool_ref,
    mcpServerId: r.mcp_server_id,
    config: r.config,
    createdAt: r.created_at,
  };
}

function mapSchedule(r: ScheduleDbRow): ScheduleRow {
  return {
    id: r.id,
    agentId: r.agent_id,
    cron: r.cron,
    payload: r.payload,
    timezone: r.timezone,
    status: r.status,
    lastRunAt: r.last_run_at,
    createdAt: r.created_at,
  };
}

function isUniqueViolation(err: unknown, constraint?: string): boolean {
  if (!err || typeof err !== 'object') return false;
  if ((err as { code?: string }).code !== '23505') return false;
  if (!constraint) return true;
  return (err as { constraint?: string }).constraint === constraint;
}

export class AgentGraphStore {
  constructor(private readonly pool: Pool) {}

  // ── sub-agents ───────────────────────────────────────────────────────────
  async listAllSubAgents(): Promise<readonly SubAgentRow[]> {
    const { rows } = await this.pool.query<SubAgentDbRow>(
      'SELECT * FROM agent_subagents ORDER BY parent_agent_id, name',
    );
    return rows.map(mapSubAgent);
  }

  async createSubAgent(input: SubAgentInput): Promise<SubAgentRow> {
    try {
      const { rows } = await this.pool.query<SubAgentDbRow>(
        `INSERT INTO agent_subagents
           (parent_agent_id, name, skill_id, model, max_tokens, max_iterations,
            system_prompt_override, status, position)
         VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,'enabled'),$9::jsonb)
         RETURNING *`,
        [
          input.parentAgentId,
          input.name,
          input.skillId ?? null,
          input.model ?? null,
          input.maxTokens ?? null,
          input.maxIterations ?? null,
          input.systemPromptOverride ?? null,
          input.status ?? null,
          input.position ? JSON.stringify(input.position) : null,
        ],
      );
      return mapSubAgent(rows[0]!);
    } catch (err) {
      if (isUniqueViolation(err, 'agent_subagents_parent_agent_id_name_key')) {
        throw new ConfigValidationError(
          `sub-agent "${input.name}" already exists for this agent`,
        );
      }
      throw err;
    }
  }

  async updateSubAgent(id: string, patch: SubAgentPatch): Promise<SubAgentRow> {
    const { rows } = await this.pool.query<SubAgentDbRow>(
      `UPDATE agent_subagents SET
         name                   = COALESCE($2, name),
         skill_id               = COALESCE($3, skill_id),
         model                  = COALESCE($4, model),
         max_tokens             = COALESCE($5, max_tokens),
         max_iterations         = COALESCE($6, max_iterations),
         system_prompt_override = COALESCE($7, system_prompt_override),
         status                 = COALESCE($8, status),
         position               = COALESCE($9::jsonb, position),
         updated_at             = now()
       WHERE id = $1
       RETURNING *`,
      [
        id,
        patch.name ?? null,
        patch.skillId ?? null,
        patch.model ?? null,
        patch.maxTokens ?? null,
        patch.maxIterations ?? null,
        patch.systemPromptOverride ?? null,
        patch.status ?? null,
        patch.position ? JSON.stringify(patch.position) : null,
      ],
    );
    const row = rows[0];
    if (!row) throw new ConfigValidationError(`sub-agent ${id} not found`);
    return mapSubAgent(row);
  }

  /** Set or clear (null) a sub-agent's skill. Direct write so the canvas can
   *  detach a skill edge. */
  async setSubAgentSkill(
    id: string,
    skillId: string | null,
  ): Promise<SubAgentRow> {
    const { rows } = await this.pool.query<SubAgentDbRow>(
      `UPDATE agent_subagents SET skill_id = $2, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, skillId],
    );
    const row = rows[0];
    if (!row) throw new ConfigValidationError(`sub-agent ${id} not found`);
    return mapSubAgent(row);
  }

  async deleteSubAgent(id: string): Promise<void> {
    await this.pool.query('DELETE FROM agent_subagents WHERE id = $1', [id]);
  }

  async listSchedulesForAgent(agentId: string): Promise<readonly ScheduleRow[]> {
    const { rows } = await this.pool.query<ScheduleDbRow>(
      'SELECT * FROM agent_schedules WHERE agent_id = $1 ORDER BY created_at',
      [agentId],
    );
    return rows.map(mapSchedule);
  }

  // ── skills ─────────────────────────────────────────────────────────────────
  async listSkills(): Promise<readonly SkillRow[]> {
    const { rows } = await this.pool.query<SkillDbRow>(
      'SELECT * FROM skills ORDER BY slug',
    );
    return rows.map(mapSkill);
  }

  async getSkill(id: string): Promise<SkillRow | undefined> {
    const { rows } = await this.pool.query<SkillDbRow>(
      'SELECT * FROM skills WHERE id = $1',
      [id],
    );
    const row = rows[0];
    return row ? mapSkill(row) : undefined;
  }

  /**
   * Look up a skill by exact content hash — for import dedup / convergence.
   * Pass `source` to scope the match (import dedup scopes to `'file'` so a
   * host-authored skill with identical content is never mistaken for a prior
   * import).
   */
  async getSkillByContentHash(
    contentHash: string,
    source?: 'db' | 'file',
  ): Promise<SkillRow | undefined> {
    const { rows } = source
      ? await this.pool.query<SkillDbRow>(
          'SELECT * FROM skills WHERE content_hash = $1 AND source = $2 LIMIT 1',
          [contentHash, source],
        )
      : await this.pool.query<SkillDbRow>(
          'SELECT * FROM skills WHERE content_hash = $1 LIMIT 1',
          [contentHash],
        );
    const row = rows[0];
    return row ? mapSkill(row) : undefined;
  }

  /** Look up a skill by its unique slug — for import update-vs-create routing. */
  async getSkillBySlug(slug: string): Promise<SkillRow | undefined> {
    const { rows } = await this.pool.query<SkillDbRow>(
      'SELECT * FROM skills WHERE slug = $1',
      [slug],
    );
    const row = rows[0];
    return row ? mapSkill(row) : undefined;
  }

  async upsertSkill(input: SkillInput): Promise<SkillRow> {
    // content_hash is derived here (never caller-supplied) over the same
    // effective values the row stores, so it always matches the content.
    const contentHash = computeSkillHash(input.frontmatter ?? {}, input.body ?? '');
    const { rows } = await this.pool.query<SkillDbRow>(
      `INSERT INTO skills (slug, name, description, body, frontmatter, source, source_path, content_hash, forked_from)
       VALUES ($1,$2,$3,COALESCE($4,''),COALESCE($5::jsonb,'{}'::jsonb),COALESCE($6,'db'),$7,$8,$9)
       ON CONFLICT (slug) DO UPDATE SET
         name         = EXCLUDED.name,
         description  = EXCLUDED.description,
         body         = EXCLUDED.body,
         frontmatter  = EXCLUDED.frontmatter,
         content_hash = EXCLUDED.content_hash,
         updated_at   = now()
       RETURNING *`,
      [
        input.slug,
        input.name,
        input.description ?? null,
        input.body ?? null,
        input.frontmatter ? JSON.stringify(input.frontmatter) : null,
        input.source ?? null,
        input.sourcePath ?? null,
        contentHash,
        input.forkedFrom ?? null,
      ],
    );
    return mapSkill(rows[0]!);
  }

  /**
   * Insert a new skill, never touching an existing row: `ON CONFLICT (slug) DO
   * NOTHING`. Returns undefined when the slug is already taken, so callers can
   * disambiguate + retry instead of clobbering an existing (db or file) skill —
   * the race-safe create path for import.
   */
  async insertSkill(input: SkillInput): Promise<SkillRow | undefined> {
    const contentHash = computeSkillHash(input.frontmatter ?? {}, input.body ?? '');
    const { rows } = await this.pool.query<SkillDbRow>(
      `INSERT INTO skills (slug, name, description, body, frontmatter, source, source_path, content_hash, forked_from)
       VALUES ($1,$2,$3,COALESCE($4,''),COALESCE($5::jsonb,'{}'::jsonb),COALESCE($6,'db'),$7,$8,$9)
       ON CONFLICT (slug) DO NOTHING
       RETURNING *`,
      [
        input.slug,
        input.name,
        input.description ?? null,
        input.body ?? null,
        input.frontmatter ? JSON.stringify(input.frontmatter) : null,
        input.source ?? null,
        input.sourcePath ?? null,
        contentHash,
        input.forkedFrom ?? null,
      ],
    );
    const row = rows[0];
    return row ? mapSkill(row) : undefined;
  }

  async updateSkill(id: string, patch: SkillPatch): Promise<SkillRow> {
    // Read-modify-write so content_hash is recomputed from the *effective*
    // body + frontmatter (a name-only patch must not stale the hash, and a
    // partial content patch must hash against the untouched other half).
    // Wrapped in a transaction with SELECT ... FOR UPDATE so concurrent
    // patches on the same row can't interleave and persist a content_hash
    // that disagrees with the stored body/frontmatter.
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: cur } = await client.query<SkillDbRow>(
        'SELECT * FROM skills WHERE id = $1 FOR UPDATE',
        [id],
      );
      const current = cur[0];
      if (!current) throw new ConfigValidationError(`skill ${id} not found`);
      const nextBody = patch.body ?? current.body;
      const nextFrontmatter = patch.frontmatter ?? current.frontmatter;
      const contentHash = computeSkillHash(nextFrontmatter, nextBody);
      const { rows } = await client.query<SkillDbRow>(
        `UPDATE skills SET
           name         = COALESCE($2, name),
           description  = COALESCE($3, description),
           body         = COALESCE($4, body),
           frontmatter  = COALESCE($5::jsonb, frontmatter),
           content_hash = $6,
           updated_at   = now()
         WHERE id = $1
         RETURNING *`,
        [
          id,
          patch.name ?? null,
          patch.description ?? null,
          patch.body ?? null,
          patch.frontmatter ? JSON.stringify(patch.frontmatter) : null,
          contentHash,
        ],
      );
      await client.query('COMMIT');
      return mapSkill(rows[0]!);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async deleteSkill(id: string): Promise<void> {
    await this.pool.query('DELETE FROM skills WHERE id = $1', [id]);
  }

  /**
   * Sub-agents that reference a given skill — the reverse of
   * `SubAgentRow.skillId`, backed by `agent_subagents_skill_idx`. Powers the
   * "used by N agents" affordance and safe fork/delete reference migration.
   */
  async listSubAgentsBySkillId(skillId: string): Promise<readonly SubAgentRow[]> {
    const { rows } = await this.pool.query<SubAgentDbRow>(
      'SELECT * FROM agent_subagents WHERE skill_id = $1 ORDER BY name',
      [skillId],
    );
    return rows.map(mapSubAgent);
  }

  // ── mcp_servers ─────────────────────────────────────────────────────────────
  async listMcpServers(): Promise<readonly McpServerRow[]> {
    const { rows } = await this.pool.query<McpServerDbRow>(
      'SELECT * FROM mcp_servers ORDER BY name',
    );
    return rows.map(mapMcpServer);
  }

  async createMcpServer(input: McpServerInput): Promise<McpServerRow> {
    try {
      const { rows } = await this.pool.query<McpServerDbRow>(
        `INSERT INTO mcp_servers (name, transport, endpoint, headers, secret_ref, status)
         VALUES ($1,$2,$3,COALESCE($4::jsonb,'{}'::jsonb),$5,COALESCE($6,'enabled'))
         RETURNING *`,
        [
          input.name,
          input.transport,
          input.endpoint ?? null,
          input.headers ? JSON.stringify(input.headers) : null,
          input.secretRef ?? null,
          input.status ?? null,
        ],
      );
      return mapMcpServer(rows[0]!);
    } catch (err) {
      if (isUniqueViolation(err, 'mcp_servers_name_key')) {
        throw new ConfigValidationError(
          `MCP server "${input.name}" already exists`,
        );
      }
      throw err;
    }
  }

  async setMcpDiscoveredTools(
    id: string,
    tools: readonly unknown[],
  ): Promise<void> {
    await this.pool.query(
      `UPDATE mcp_servers
         SET discovered_tools = $2::jsonb, last_discovered_at = now(), updated_at = now()
       WHERE id = $1`,
      [id, JSON.stringify(tools)],
    );
  }

  async deleteMcpServer(id: string): Promise<void> {
    await this.pool.query('DELETE FROM mcp_servers WHERE id = $1', [id]);
  }

  // ── tool grants ───────────────────────────────────────────────────────────
  async listAllToolGrants(): Promise<readonly ToolGrantRow[]> {
    const { rows } = await this.pool.query<ToolGrantDbRow>(
      'SELECT * FROM agent_tool_grants ORDER BY created_at',
    );
    return rows.map(mapToolGrant);
  }

  async createToolGrant(input: ToolGrantInput): Promise<ToolGrantRow> {
    if (!input.agentId && !input.subAgentId) {
      throw new ConfigValidationError(
        'tool grant must target an agent or a sub-agent',
      );
    }
    const { rows } = await this.pool.query<ToolGrantDbRow>(
      `INSERT INTO agent_tool_grants
         (agent_id, subagent_id, tool_kind, tool_ref, mcp_server_id, config)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6::jsonb,'{}'::jsonb))
       RETURNING *`,
      [
        input.agentId ?? null,
        input.subAgentId ?? null,
        input.toolKind,
        input.toolRef,
        input.mcpServerId ?? null,
        input.config ? JSON.stringify(input.config) : null,
      ],
    );
    return mapToolGrant(rows[0]!);
  }

  async deleteToolGrant(id: string): Promise<void> {
    await this.pool.query('DELETE FROM agent_tool_grants WHERE id = $1', [id]);
  }

  // ── schedules ─────────────────────────────────────────────────────────────
  async listAllSchedules(): Promise<readonly ScheduleRow[]> {
    const { rows } = await this.pool.query<ScheduleDbRow>(
      'SELECT * FROM agent_schedules ORDER BY agent_id, created_at',
    );
    return rows.map(mapSchedule);
  }

  async createSchedule(input: ScheduleInput): Promise<ScheduleRow> {
    const { rows } = await this.pool.query<ScheduleDbRow>(
      `INSERT INTO agent_schedules (agent_id, cron, payload, timezone, status)
       VALUES ($1,$2,COALESCE($3::jsonb,'{}'::jsonb),COALESCE($4,'UTC'),COALESCE($5,'enabled'))
       RETURNING *`,
      [
        input.agentId,
        input.cron,
        input.payload ? JSON.stringify(input.payload) : null,
        input.timezone ?? null,
        input.status ?? null,
      ],
    );
    return mapSchedule(rows[0]!);
  }

  async deleteSchedule(id: string): Promise<void> {
    await this.pool.query('DELETE FROM agent_schedules WHERE id = $1', [id]);
  }

  /** Stamp a schedule's last fire time (scheduler worker). */
  async markScheduleRun(id: string): Promise<void> {
    await this.pool.query(
      'UPDATE agent_schedules SET last_run_at = now() WHERE id = $1',
      [id],
    );
  }
}
