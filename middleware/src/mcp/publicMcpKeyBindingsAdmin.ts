/**
 * W5-1 — the operator-facing WRITE half of `public_mcp_key_bindings`.
 *
 * The endpoint shipped in W2-3 (issue #542) is driven entirely by rows in that
 * table, and nothing in the repo could create one: the read store's interface is
 * `get(keyId)` and nothing else, `INSERT INTO public_mcp_key_bindings` had zero
 * hits repo-wide, and the endpoint's own README told the consumer "you cannot
 * change it yourself". The endpoint was therefore inert as shipped. This module
 * is the missing writer.
 *
 * DELIBERATELY A SEPARATE MODULE FROM THE READER, AND A SEPARATE OBJECT.
 * `publicMcpKeyBindings.ts` states the rule this file honours: the
 * internet-facing endpoint "has no business holding a writer for its own
 * authorization data". `wirePublicMcp.ts` takes `PublicMcpKeyBindingStore` —
 * the read-only interface — and that must stay true. Nothing here is reachable
 * from the public endpoint's dependency bag; the only consumer is the
 * operator-session-gated router in `../routes/publicMcpBindingsRouter.ts`. A
 * single store object exposing both halves would be one careless `deps.bindings`
 * away from giving a third-party API key a write path to the table that decides
 * what that key may do.
 *
 * VALIDATION IS THE READER'S, NOT A SECOND COPY. Every write is validated by
 * running the candidate row through `normalizeBindingRow` — the exact function
 * the enforcement path uses. Hand-rolling a second rule set here is how an
 * operator ends up with a row the admin UI accepted and the endpoint silently
 * ignores: a binding that appears configured and grants nothing. Two extra
 * checks sit on top, and only because the reader cannot express them:
 *   - the `0..600` CHECK on `write_rate_limit_per_minute` (the reader accepts
 *     any non-negative integer; the DB would reject 601 with a 23514 that
 *     surfaces as a 500 rather than a 400);
 *   - `enabled: false`, which the reader resolves to `undefined` because a
 *     parked binding grants nothing — that is a legitimate stored state, not a
 *     validation failure, so it is carried alongside the validation rather than
 *     through it.
 */

import type { Pool } from 'pg';

import { normalizeBindingRow } from './publicMcpKeyBindings.js';

/** The schema's `CHECK (write_rate_limit_per_minute BETWEEN 0 AND 600)`,
 *  mirrored so an out-of-range value is a 400 with a readable message rather
 *  than a constraint violation surfacing as a 500. */
export const MAX_WRITE_RATE_LIMIT_PER_MINUTE = 600;
/** Migration `0033` default. Applied when the operator omits the field so the
 *  admin path and a bare `INSERT` agree on the same starting budget. */
export const DEFAULT_WRITE_RATE_LIMIT_PER_MINUTE = 5;

/**
 * A stored row as an operator sees it — including the fact the runtime
 * `PublicMcpKeyBinding` deliberately hides.
 *
 * `enabled` is absent from the runtime type because the endpoint must not be
 * able to tell "parked" from "never configured" (both reach nothing). An
 * operator needs exactly that distinction, which is why the admin row carries
 * it and the runtime one does not.
 */
export interface PublicMcpKeyBindingAdminRow {
  readonly keyId: string;
  readonly agentId: string;
  readonly readTools: readonly string[];
  readonly writeTools: readonly string[];
  readonly writeRateLimitPerMinute: number;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * What an operator submits. Optional fields take the migration's defaults.
 *
 * `enabled` is the exception, and the asymmetry is the whole point: OMITTING it
 * means "do not touch the parked/active state", not "activate". A binding is the
 * entire authorization model for an internet-facing endpoint, and revoke is the
 * incident response — a field the operator never mentioned must not be able to
 * undo it. On a NEW row there is no prior state to preserve, so it starts
 * `true`; on an existing row the stored value survives. Re-arming a revoked key
 * therefore requires an explicit `enabled: true` (or the `/restore` route).
 */
export interface PublicMcpKeyBindingInput {
  readonly keyId: string;
  readonly agentId: string;
  readonly readTools: readonly string[];
  readonly writeTools: readonly string[];
  readonly writeRateLimitPerMinute?: number;
  /** Absent ⇒ preserve whatever the row says today (new rows start enabled). */
  readonly enabled?: boolean;
}

/**
 * The stored row plus whether this call CREATED it.
 *
 * The router needs the distinction to answer `201 Created` honestly. Returning
 * "Created" for a write that overwrote an existing binding is not merely a
 * cosmetic lie: it is the operator's only per-request signal that they landed on
 * a row somebody else had already configured — or parked.
 */
export interface PublicMcpKeyBindingUpsertResult {
  readonly binding: PublicMcpKeyBindingAdminRow;
  readonly created: boolean;
}

export interface BindingValidationFailure {
  readonly code: string;
  readonly message: string;
}

export type BindingValidationResult =
  | { readonly ok: true; readonly value: PublicMcpKeyBindingInput }
  | { readonly ok: false; readonly error: BindingValidationFailure };

/**
 * Writes bindings. Operator-only.
 *
 * Kept off `PublicMcpKeyBindingStore` on purpose — see the module doc comment.
 */
export interface PublicMcpKeyBindingAdminStore {
  /** Every row, parked ones included. An operator reviewing what a key may do
   *  needs to see the disabled rows; the endpoint never does. */
  list(): Promise<readonly PublicMcpKeyBindingAdminRow[]>;
  /** Creates or replaces the row for `input.keyId`. An absent `input.enabled`
   *  PRESERVES the stored flag rather than defaulting it — see the input type. */
  upsert(input: PublicMcpKeyBindingInput): Promise<PublicMcpKeyBindingUpsertResult>;
  /** Parks (or un-parks) a binding without losing what it was configured to
   *  grant. `undefined` when there is no such row. */
  setEnabled(keyId: string, enabled: boolean): Promise<PublicMcpKeyBindingAdminRow | undefined>;
  /** Deletes the row outright. `false` when there was nothing to delete. */
  remove(keyId: string): Promise<boolean>;
}

/**
 * Validates operator input by asking the READER whether it would accept the row
 * this write would produce, and returns the normalized lists to persist.
 *
 * The normalization is not merely a check — its output is what gets stored. A
 * tool named in both lists resolves to WRITE (`normalizeBindingRow` picks the
 * stricter reading), and persisting that resolution means the row an operator
 * reads back says exactly what the endpoint will enforce. Persisting the raw
 * submission instead would leave a row whose `read_tools` names a tool that is
 * in fact gated on `mcp:write:<tool>` — true but unreadable, and the kind of
 * discrepancy that gets "fixed" in the wrong direction later.
 *
 * `enabled` is validated against `true` regardless of what the operator asked
 * for: a parked row is a row the reader denies BY DESIGN, so running the check
 * with the operator's `false` would reject every attempt to save a parked
 * binding.
 *
 * It is also carried through UNTOUCHED — absent stays absent. The previous
 * `input.enabled ?? true` here is what made revoke undoable: it turned "the
 * submission said nothing about enabled" into "the submission asked for
 * enabled", and the upsert then wrote that manufactured `true` over a row an
 * operator had deliberately parked. Only the store knows the current state, so
 * only the store may decide what "unspecified" resolves to.
 */
export function validateBindingInput(input: PublicMcpKeyBindingInput): BindingValidationResult {
  const writeRateLimitPerMinute =
    input.writeRateLimitPerMinute ?? DEFAULT_WRITE_RATE_LIMIT_PER_MINUTE;
  if (
    !Number.isInteger(writeRateLimitPerMinute) ||
    writeRateLimitPerMinute < 0 ||
    writeRateLimitPerMinute > MAX_WRITE_RATE_LIMIT_PER_MINUTE
  ) {
    return {
      ok: false,
      error: {
        code: 'write_rate_limit_out_of_range',
        message: `writeRateLimitPerMinute must be an integer between 0 and ${String(
          MAX_WRITE_RATE_LIMIT_PER_MINUTE,
        )}`,
      },
    };
  }

  const normalized = normalizeBindingRow({
    key_id: input.keyId,
    agent_id: input.agentId,
    read_tools: input.readTools,
    write_tools: input.writeTools,
    write_rate_limit_per_minute: writeRateLimitPerMinute,
    enabled: true,
  });
  if (!normalized) {
    return {
      ok: false,
      error: {
        code: 'binding_rejected_by_reader',
        message:
          'the enforcement path would refuse this binding: keyId and agentId must be non-empty strings and both tool lists must hold only non-empty strings',
      },
    };
  }

  return {
    ok: true,
    value: {
      keyId: normalized.keyId,
      agentId: normalized.agentId,
      readTools: normalized.readTools,
      writeTools: normalized.writeTools,
      writeRateLimitPerMinute: normalized.writeRateLimitPerMinute,
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    },
  };
}

/** Raw row shape as pg hands it back. */
interface AdminRowShape {
  key_id: unknown;
  agent_id: unknown;
  read_tools: unknown;
  write_tools: unknown;
  write_rate_limit_per_minute: unknown;
  enabled: unknown;
  created_at: unknown;
  updated_at: unknown;
}

const SELECT_COLUMNS =
  'key_id, agent_id, read_tools, write_tools, write_rate_limit_per_minute, enabled, created_at, updated_at';

/**
 * Shapes a stored row for the operator surface.
 *
 * Lenient where the reader is strict, and that asymmetry is deliberate: an
 * unreadable row must still be VISIBLE to the operator, because a row nobody
 * can see is a row nobody can repair. Nothing is granted by rendering it — the
 * reader still denies the same row on the enforcement path.
 */
function toAdminRow(raw: AdminRowShape): PublicMcpKeyBindingAdminRow {
  return {
    keyId: String(raw.key_id),
    agentId: String(raw.agent_id),
    readTools: toStringList(raw.read_tools),
    writeTools: toStringList(raw.write_tools),
    writeRateLimitPerMinute: Number(raw.write_rate_limit_per_minute),
    enabled: raw.enabled === true,
    createdAt: toIsoString(raw.created_at),
    updatedAt: toIsoString(raw.updated_at),
  };
}

function toStringList(raw: unknown): readonly string[] {
  return Array.isArray(raw) ? raw.filter((e): e is string => typeof e === 'string') : [];
}

function toIsoString(raw: unknown): string {
  if (raw instanceof Date) return raw.toISOString();
  return typeof raw === 'string' ? raw : '';
}

/**
 * Postgres-backed writer.
 *
 * `updated_at` is set EXPLICITLY on every mutating statement. Migration `0033`
 * gives the column `DEFAULT now()` and NO trigger, so the default fires on
 * INSERT and never again — an `ON CONFLICT DO UPDATE` that omits it leaves the
 * column frozen at creation time, and the one question the column exists to
 * answer ("when was this integration's reach last changed?") then silently
 * answers wrong.
 */
export function createPublicMcpKeyBindingAdminStore(pool: Pool): PublicMcpKeyBindingAdminStore {
  return {
    async list() {
      const { rows } = await pool.query(
        `SELECT ${SELECT_COLUMNS}
           FROM public_mcp_key_bindings
          ORDER BY created_at DESC, key_id ASC`,
      );
      return (rows as AdminRowShape[]).map(toAdminRow);
    },

    async upsert(input) {
      // `enabled` binds NULL when the operator did not mention it, and the two
      // branches then resolve that NULL differently — `true` on insert (a new
      // binding has no prior state), the CURRENT COLUMN on conflict.
      //
      // Note it is `public_mcp_key_bindings.enabled` and NOT `EXCLUDED.enabled`
      // in the DO UPDATE branch: EXCLUDED holds the row this statement PROPOSED,
      // so coalescing against it would resolve back to the insert's `true` and
      // re-arm the very binding this is meant to leave parked.
      //
      // `(created_at = updated_at)` is the created/updated discriminator. Both
      // columns resolve to `now()` — the transaction timestamp — on the insert
      // branch, while the conflict branch moves only `updated_at` and leaves
      // `created_at` at an earlier transaction's clock. That uses documented
      // `now()` semantics rather than the usual `xmax = 0` idiom, which reads a
      // storage-layer detail that also moves when an unrelated transaction holds
      // a row lock.
      const { rows } = await pool.query(
        `INSERT INTO public_mcp_key_bindings
           (key_id, agent_id, read_tools, write_tools, write_rate_limit_per_minute, enabled, updated_at)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6::boolean, true), now())
         ON CONFLICT (key_id) DO UPDATE SET
           agent_id = EXCLUDED.agent_id,
           read_tools = EXCLUDED.read_tools,
           write_tools = EXCLUDED.write_tools,
           write_rate_limit_per_minute = EXCLUDED.write_rate_limit_per_minute,
           enabled = COALESCE($6::boolean, public_mcp_key_bindings.enabled),
           updated_at = now()
         RETURNING ${SELECT_COLUMNS}, (created_at = updated_at) AS inserted`,
        [
          input.keyId,
          input.agentId,
          input.readTools,
          input.writeTools,
          input.writeRateLimitPerMinute ?? DEFAULT_WRITE_RATE_LIMIT_PER_MINUTE,
          input.enabled ?? null,
        ],
      );
      const raw = rows[0] as AdminRowShape & { inserted?: unknown };
      return { binding: toAdminRow(raw), created: raw.inserted === true };
    },

    async setEnabled(keyId, enabled) {
      const { rows } = await pool.query(
        `UPDATE public_mcp_key_bindings
            SET enabled = $2, updated_at = now()
          WHERE key_id = $1
        RETURNING ${SELECT_COLUMNS}`,
        [keyId, enabled],
      );
      const row = rows[0] as AdminRowShape | undefined;
      return row ? toAdminRow(row) : undefined;
    },

    async remove(keyId) {
      const { rowCount } = await pool.query(
        'DELETE FROM public_mcp_key_bindings WHERE key_id = $1',
        [keyId],
      );
      return (rowCount ?? 0) > 0;
    },
  };
}

/**
 * In-memory writer, for tests and for a DATABASE_URL-less install.
 *
 * `now` is injectable because the invariant worth testing — that `updated_at`
 * MOVES on an update — is unobservable when two writes land inside the same
 * millisecond, which they routinely do in a unit test.
 */
export function createInMemoryPublicMcpKeyBindingAdminStore(
  seed: readonly PublicMcpKeyBindingAdminRow[] = [],
  now: () => Date = () => new Date(),
): PublicMcpKeyBindingAdminStore {
  const byKey = new Map<string, PublicMcpKeyBindingAdminRow>(seed.map((r) => [r.keyId, r]));
  return {
    async list() {
      return Array.from(byKey.values());
    },
    async upsert(input) {
      const stamp = now().toISOString();
      const existing = byKey.get(input.keyId);
      const row: PublicMcpKeyBindingAdminRow = {
        keyId: input.keyId,
        agentId: input.agentId,
        readTools: [...input.readTools],
        writeTools: [...input.writeTools],
        writeRateLimitPerMinute:
          input.writeRateLimitPerMinute ?? DEFAULT_WRITE_RATE_LIMIT_PER_MINUTE,
        // Mirrors the SQL's `COALESCE($6, public_mcp_key_bindings.enabled)`: an
        // unspecified flag preserves the stored state, and only a row that does
        // not exist yet falls through to `true`.
        enabled: input.enabled ?? existing?.enabled ?? true,
        createdAt: existing?.createdAt ?? stamp,
        updatedAt: stamp,
      };
      byKey.set(row.keyId, row);
      return { binding: row, created: existing === undefined };
    },
    async setEnabled(keyId, enabled) {
      const existing = byKey.get(keyId);
      if (!existing) return undefined;
      const row: PublicMcpKeyBindingAdminRow = {
        ...existing,
        enabled,
        updatedAt: now().toISOString(),
      };
      byKey.set(keyId, row);
      return row;
    },
    async remove(keyId) {
      return byKey.delete(keyId);
    },
  };
}
