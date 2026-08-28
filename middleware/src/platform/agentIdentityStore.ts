/**
 * `agent_identities` store (#914) — backing migration 0051.
 *
 * The identity of a DEPLOYED agent: what it is called, what it says about
 * itself, how it behaves, what colour and face it wears. Sits
 * next to `agentTeamsIdentityStore.ts` (0049) by design — that one owns the
 * PROVISIONING state machine of a Teams bot, this one owns the content that
 * machine renders into a package. Neither writes the other's columns.
 *
 * SINGLE WRITER. Every write goes through this class, and every write that
 * changes content bumps `revision`. The revision is not decoration: it is the
 * Teams manifest version (`1.0.<revision>`), which Teams requires to increase
 * before it accepts a catalog update. A no-op save leaves it alone, so
 * re-saving an unchanged form does not queue a pointless re-publish.
 *
 * NULL MEANS INHERIT, NOT EMPTY. A text column that was never authored — or
 * that the operator cleared — is `null`, and {@link resolveAgentIdentity}
 * falls back to the registry's `agents.name` / `agents.description`. That is
 * what makes this table optional: an agent without a row behaves exactly as
 * it did before #914.
 *
 * BINARY STAYS OUT OF THE HOT PATH. The record type carries avatar METADATA
 * (etag, whether one exists), never the bytes. Icons are fetched explicitly
 * by the one caller that needs them (provisioning) and by the one route that
 * serves the preview, so a dashboard read never drags three PNGs along.
 */

import type { Pool } from 'pg';

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** The authored text of an identity. `null` = not authored, inherit. */
export interface AgentIdentityText {
  readonly displayName: string | null;
  readonly shortDescription: string | null;
  readonly longDescription: string | null;
  readonly instructions: string | null;
  /** `#RRGGBB`, validated by the route AND by the migration's CHECK. */
  readonly accentColor: string | null;
}

/** What the record says about the avatar without carrying it. */
export interface AgentIdentityAvatarMeta {
  /** SHA-256 of the ORIGINAL upload — cache key and change detector. */
  readonly etag: string;
}

export interface AgentIdentityRecord extends AgentIdentityText {
  readonly agentId: string;
  /** Monotonic; rendered as the Teams manifest version `1.0.<revision>`. */
  readonly revision: number;
  /** `null` while no avatar was uploaded (the packaged default is used). */
  readonly avatar: AgentIdentityAvatarMeta | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * A full replacement of the authored text — a PUT, not a PATCH. Every field
 * is stated on every write; `null` clears one back to inherited. Making this
 * a replace is what lets the UI form round-trip without a per-field dirty
 * map, and it removes the "did absent mean clear or keep?" question that
 * `AgentPatch` needs a COALESCE to answer.
 */
export type AgentIdentityTextInput = AgentIdentityText;

/** The three PNGs of one avatar upload, already derived by the route. */
export interface AgentIdentityAvatarInput {
  /** The upload as received — kept so a future derivation can re-run. */
  readonly original: Uint8Array;
  /** 192×192 Teams colour icon. */
  readonly color: Uint8Array;
  /**
   * 32×32 Teams outline icon, or `null` when the upload is fully opaque and
   * no silhouette could be derived from it — provisioning then keeps the
   * packaged default outline. A white 32×32 square would be worse than the
   * default: Teams renders the outline monochrome in the app bar.
   */
  readonly outline: Uint8Array | null;
  readonly etag: string;
}

/** What provisioning needs: the agent's colour icon, and its outline if one
 *  could be derived. `undefined` from the store = no avatar at all. */
export interface AgentIdentityIcons {
  readonly color: Uint8Array;
  readonly outline: Uint8Array | null;
}

/** What the preview route serves. */
export interface AgentIdentityAvatarBytes {
  readonly bytes: Uint8Array;
  readonly etag: string;
}

// ---------------------------------------------------------------------------
// Resolution against the registry row
// ---------------------------------------------------------------------------

/** The registry facts an unauthored identity falls back to. */
export interface AgentIdentityFallback {
  readonly name: string;
  readonly description: string | null;
}

/**
 * Identity as every CONSUMER should see it: authored value if present,
 * registry value otherwise. Callers must not re-implement this fallback —
 * `displayName` in particular is the bot's name in Teams, and two call sites
 * disagreeing about it would ship two different names for one agent.
 */
export interface ResolvedAgentIdentity {
  readonly displayName: string;
  readonly shortDescription: string | null;
  readonly longDescription: string | null;
  readonly instructions: string | null;
  readonly accentColor: string | null;
  readonly revision: number;
  readonly hasAvatar: boolean;
}

/** Default accent colour — Odoo purple, the value hard-coded before #914. */
export const DEFAULT_AGENT_ACCENT_COLOR = '#714B67';

export function resolveAgentIdentity(
  identity: AgentIdentityRecord | undefined,
  fallback: AgentIdentityFallback,
): ResolvedAgentIdentity {
  return {
    displayName: nonEmpty(identity?.displayName) ?? fallback.name,
    shortDescription:
      nonEmpty(identity?.shortDescription) ?? nonEmpty(fallback.description),
    longDescription: nonEmpty(identity?.longDescription),
    instructions: nonEmpty(identity?.instructions),
    accentColor: nonEmpty(identity?.accentColor),
    revision: identity?.revision ?? 1,
    hasAvatar: identity?.avatar !== null && identity?.avatar !== undefined,
  };
}

/** Blank-but-present is the same as absent — a form submits `''`, not null. */
function nonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** Everything except the three BYTEA columns. */
const META_COLUMNS =
  'agent_id, display_name, short_description, long_description, instructions, accent_color, avatar_etag, revision, created_at, updated_at';

interface AgentIdentityMetaRow {
  agent_id: string;
  display_name: string | null;
  short_description: string | null;
  long_description: string | null;
  instructions: string | null;
  accent_color: string | null;
  avatar_etag: string | null;
  revision: number;
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: AgentIdentityMetaRow): AgentIdentityRecord {
  return {
    agentId: row.agent_id,
    displayName: row.display_name,
    shortDescription: row.short_description,
    longDescription: row.long_description,
    instructions: row.instructions,
    accentColor: row.accent_color,
    // `revision` is an INT; `pg` hands INT4 back as a number, but a driver
    // that ever changes its mind must not turn the manifest version into
    // `1.0.[object Object]`.
    revision: Number(row.revision),
    avatar: row.avatar_etag === null ? null : { etag: row.avatar_etag },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Text equality across the five authored columns — the no-op-save guard. */
function sameText(
  a: AgentIdentityText | undefined,
  b: AgentIdentityText,
): boolean {
  if (!a) return false;
  return (
    nonEmpty(a.displayName) === nonEmpty(b.displayName) &&
    nonEmpty(a.shortDescription) === nonEmpty(b.shortDescription) &&
    nonEmpty(a.longDescription) === nonEmpty(b.longDescription) &&
    nonEmpty(a.instructions) === nonEmpty(b.instructions) &&
    nonEmpty(a.accentColor) === nonEmpty(b.accentColor)
  );
}

export class AgentIdentityStore {
  constructor(private readonly pool: Pool) {}

  /** `undefined` = this agent has no authored identity. Failures surface. */
  async getByAgentId(
    agentId: string,
  ): Promise<AgentIdentityRecord | undefined> {
    const res = await this.pool.query<AgentIdentityMetaRow>(
      `SELECT ${META_COLUMNS} FROM agent_identities WHERE agent_id = $1`,
      [agentId],
    );
    const row = res.rows[0];
    return row ? mapRow(row) : undefined;
  }

  /**
   * Replace the authored text. Creates the row when absent, bumps `revision`
   * only when the stored text actually differs — an unchanged save must not
   * queue a Teams re-publish, and `updated_at` must not start lying about
   * when the identity last changed.
   */
  async saveText(
    agentId: string,
    input: AgentIdentityTextInput,
  ): Promise<AgentIdentityRecord> {
    const existing = await this.getByAgentId(agentId);
    if (sameText(existing, input)) return existing as AgentIdentityRecord;
    const values = [
      agentId,
      nonEmpty(input.displayName),
      nonEmpty(input.shortDescription),
      nonEmpty(input.longDescription),
      nonEmpty(input.instructions),
      nonEmpty(input.accentColor),
    ];
    const res = await this.pool.query<AgentIdentityMetaRow>(
      `INSERT INTO agent_identities (
         agent_id, display_name, short_description, long_description,
         instructions, accent_color
       ) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (agent_id) DO UPDATE SET
         display_name      = EXCLUDED.display_name,
         short_description = EXCLUDED.short_description,
         long_description  = EXCLUDED.long_description,
         instructions      = EXCLUDED.instructions,
         accent_color      = EXCLUDED.accent_color,
         revision          = agent_identities.revision + 1,
         updated_at        = now()
       RETURNING ${META_COLUMNS}`,
      values,
    );
    return mapRow(res.rows[0] as AgentIdentityMetaRow);
  }

  /**
   * Store one avatar and its two derived Teams icons. Always bumps
   * `revision`: the bytes are opaque here, and re-deriving them to compare
   * would cost more than the occasional redundant re-publish.
   */
  async setAvatar(
    agentId: string,
    avatar: AgentIdentityAvatarInput,
  ): Promise<AgentIdentityRecord> {
    const res = await this.pool.query<AgentIdentityMetaRow>(
      `INSERT INTO agent_identities (
         agent_id, avatar_png, icon_color_png, icon_outline_png, avatar_etag
       ) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (agent_id) DO UPDATE SET
         avatar_png       = EXCLUDED.avatar_png,
         icon_color_png   = EXCLUDED.icon_color_png,
         icon_outline_png = EXCLUDED.icon_outline_png,
         avatar_etag      = EXCLUDED.avatar_etag,
         revision         = agent_identities.revision + 1,
         updated_at       = now()
       RETURNING ${META_COLUMNS}`,
      [
        agentId,
        Buffer.from(avatar.original),
        Buffer.from(avatar.color),
        avatar.outline === null ? null : Buffer.from(avatar.outline),
        avatar.etag,
      ],
    );
    return mapRow(res.rows[0] as AgentIdentityMetaRow);
  }

  /**
   * Drop the avatar back to the packaged default. `undefined` when the agent
   * had no identity row at all — there is nothing to clear, and creating an
   * empty row to record a deletion would be worse than saying so.
   */
  async clearAvatar(
    agentId: string,
  ): Promise<AgentIdentityRecord | undefined> {
    const res = await this.pool.query<AgentIdentityMetaRow>(
      `UPDATE agent_identities SET
         avatar_png       = NULL,
         icon_color_png   = NULL,
         icon_outline_png = NULL,
         avatar_etag      = NULL,
         revision         = revision + 1,
         updated_at       = now()
       WHERE agent_id = $1 AND avatar_etag IS NOT NULL
       RETURNING ${META_COLUMNS}`,
      [agentId],
    );
    const row = res.rows[0];
    if (row) return mapRow(row);
    // No avatar to clear: report the current row (or its absence) unchanged
    // rather than inventing a revision bump.
    return this.getByAgentId(agentId);
  }

  /** The two Teams icons, or `undefined` when this agent has no avatar. */
  async getIcons(agentId: string): Promise<AgentIdentityIcons | undefined> {
    const res = await this.pool.query<{
      icon_color_png: Buffer | null;
      icon_outline_png: Buffer | null;
    }>(
      `SELECT icon_color_png, icon_outline_png FROM agent_identities WHERE agent_id = $1`,
      [agentId],
    );
    const row = res.rows[0];
    if (!row || row.icon_color_png === null) return undefined;
    return { color: row.icon_color_png, outline: row.icon_outline_png };
  }

  /** The original upload, for the operator UI's preview. */
  async getAvatar(
    agentId: string,
  ): Promise<AgentIdentityAvatarBytes | undefined> {
    const res = await this.pool.query<{
      avatar_png: Buffer | null;
      avatar_etag: string | null;
    }>(`SELECT avatar_png, avatar_etag FROM agent_identities WHERE agent_id = $1`, [
      agentId,
    ]);
    const row = res.rows[0];
    if (!row || row.avatar_png === null || row.avatar_etag === null) {
      return undefined;
    }
    return { bytes: row.avatar_png, etag: row.avatar_etag };
  }
}
