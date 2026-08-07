/**
 * W2-3 (issue #542) — the per-key authorization record for the public MCP
 * endpoint: which agent a key is bound to, and exactly which of that agent's
 * tools it may read and write.
 *
 * This is the seam the issue assumed already existed. omadia's native tool
 * registry is a process-wide singleton with unique tool names; per-agent
 * scoping existed only for DomainTools (`scopeDomainToolsToPlugins`), and the
 * loopback MCP server's own security note says as much: "the subscription CLI
 * sees the FULL native tool registry via the loopback MCP server, with no
 * allowlist beyond MCP server scoping; a per-agent tool allowlist is a
 * follow-up." An internet-facing endpoint cannot ship on that footing, so the
 * allowlist is built here, per KEY rather than per server.
 *
 * Everything in this module fails CLOSED. Absent row, disabled row, malformed
 * row, unreadable column: all resolve to "this key reaches no tools". There is
 * deliberately no code path that turns a read problem into a grant — the
 * asymmetry mirrors `normalizeScopes` in `@omadia/api-key-auth`, which denies
 * everything on a malformed persisted `scopes` field for the same reason.
 */

import type { Pool } from 'pg';

/** The resolved authorization for one API key. */
export interface PublicMcpKeyBinding {
  /** `ApiKeyRecord.id` — the key this binding belongs to. */
  readonly keyId: string;
  /** The ONE agent (orchestrator slug) whose tools this key reaches. */
  readonly agentId: string;
  /** Exact names of read-only tools this key may call. No patterns. */
  readonly readTools: readonly string[];
  /** Exact names of write-capable tools this key may call. Calling one
   *  additionally requires the `mcp:write:<tool>` scope and spends the write
   *  rate-limit budget. */
  readonly writeTools: readonly string[];
  /** Tighter per-minute budget for writes, independent of the key's general
   *  `rateLimitPerMinute`. */
  readonly writeRateLimitPerMinute: number;
}

/**
 * Reads bindings. Read-only by design: bindings are operator-managed
 * configuration, and this endpoint — the internet-facing one — has no business
 * holding a writer for its own authorization data.
 */
export interface PublicMcpKeyBindingStore {
  /** The binding for `keyId`, or `undefined` when the key reaches nothing.
   *  `undefined` covers absent, disabled, and malformed alike: a caller that
   *  cannot distinguish them cannot accidentally treat one as permissive. */
  get(keyId: string): Promise<PublicMcpKeyBinding | undefined>;
}

/** A binding that grants nothing, for the "row exists but says no" case. */
export function denyAllBinding(keyId: string, agentId: string): PublicMcpKeyBinding {
  return { keyId, agentId, readTools: [], writeTools: [], writeRateLimitPerMinute: 0 };
}

/**
 * Shapes a raw row into a binding, or `undefined` when the row cannot be
 * trusted.
 *
 * Exported so both store implementations and the tests share ONE normalization
 * rule. The pg driver returns `TEXT[]` as a JS array, but a hand-edited row, a
 * future column-type change, or a NULL where the schema promises NOT NULL would
 * all arrive here as something else — and each of those must deny, not partly
 * grant.
 */
export function normalizeBindingRow(raw: {
  key_id?: unknown;
  agent_id?: unknown;
  read_tools?: unknown;
  write_tools?: unknown;
  write_rate_limit_per_minute?: unknown;
  enabled?: unknown;
}): PublicMcpKeyBinding | undefined {
  const keyId = nonEmptyString(raw.key_id);
  const agentId = nonEmptyString(raw.agent_id);
  if (!keyId || !agentId) {
    warnMalformed('key_id or agent_id missing/empty', keyId ?? '<unknown>');
    return undefined;
  }

  // `enabled` is NOT NULL DEFAULT true in the schema, so anything other than a
  // boolean is corruption. Treat it as disabled rather than guessing `true`:
  // guessing wrong in that direction reopens an endpoint an operator parked.
  if (typeof raw.enabled !== 'boolean') {
    warnMalformed('enabled is not a boolean', keyId);
    return undefined;
  }
  if (!raw.enabled) return undefined;

  const readTools = normalizeToolList(raw.read_tools, 'read_tools', keyId);
  const writeTools = normalizeToolList(raw.write_tools, 'write_tools', keyId);
  if (!readTools || !writeTools) return undefined;

  // A tool named in BOTH lists is ambiguous about whether it needs
  // `mcp:write:<tool>`. Resolve toward the STRICTER reading — it is a write —
  // rather than rejecting the whole row, because an operator adding a write
  // capability to a tool they had listed as a read is a plausible edit and
  // silently downgrading it to a read would be the dangerous resolution.
  const writeSet = new Set(writeTools);
  const readOnly = readTools.filter((t) => !writeSet.has(t));

  const writeLimit = normalizeRateLimit(raw.write_rate_limit_per_minute);
  if (writeLimit === undefined) {
    warnMalformed('write_rate_limit_per_minute is not a usable integer', keyId);
    return undefined;
  }

  return {
    keyId,
    agentId,
    readTools: readOnly,
    writeTools: Array.from(writeSet),
    writeRateLimitPerMinute: writeLimit,
  };
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** `undefined` signals "deny the whole row"; `[]` is a legitimate empty list. */
function normalizeToolList(
  raw: unknown,
  column: string,
  keyId: string,
): readonly string[] | undefined {
  if (raw === null || raw === undefined) {
    // Schema says NOT NULL DEFAULT '{}', so NULL here is a foreign writer.
    warnMalformed(`${column} is null`, keyId);
    return undefined;
  }
  if (!Array.isArray(raw)) {
    warnMalformed(`${column} is not an array`, keyId);
    return undefined;
  }
  const invalid = raw.filter((entry) => nonEmptyString(entry) === undefined);
  if (invalid.length > 0) {
    // Partially-valid arrays deny rather than narrowing to the valid subset —
    // same rule and same reasoning as `normalizeScopes`: a record we cannot
    // read faithfully is one we must not guess at.
    warnMalformed(`${column} holds ${String(invalid.length)} non-string entr(y|ies)`, keyId);
    return undefined;
  }
  return Array.from(new Set(raw as readonly string[]));
}

function normalizeRateLimit(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) return raw;
  // pg returns some integer types as strings depending on the type OID; accept
  // a clean integer string rather than denying a perfectly good row.
  if (typeof raw === 'string' && /^\d+$/.test(raw)) return Number(raw);
  return undefined;
}

/** A malformed binding silently stops a key from reaching anything; without
 *  this line an operator cannot tell that from a deliberate revoke. Only the
 *  key id and the reason are logged — never the row, which names the tools an
 *  integration is trusted with. */
function warnMalformed(reason: string, keyId: string): void {
  console.warn(
    `[public-mcp] unusable key binding (${reason}) for key ${keyId} — key reaches no tools until the row is repaired`,
  );
}

/**
 * Postgres-backed store.
 *
 * No cache. A binding is read once per MCP request against a primary-key
 * lookup, and an operator revoking a tool from an integration expects that to
 * take effect on the next call rather than after a TTL. If this ever becomes
 * hot, the fix is a short negative cache — never a positive one, because a
 * cached grant is a grant that outlives its revocation.
 */
export function createPublicMcpKeyBindingStore(pool: Pool): PublicMcpKeyBindingStore {
  return {
    async get(keyId) {
      if (nonEmptyString(keyId) === undefined) return undefined;
      const { rows } = await pool.query(
        `SELECT key_id, agent_id, read_tools, write_tools, write_rate_limit_per_minute, enabled
           FROM public_mcp_key_bindings
          WHERE key_id = $1`,
        [keyId],
      );
      const row = rows[0] as Parameters<typeof normalizeBindingRow>[0] | undefined;
      return row ? normalizeBindingRow(row) : undefined;
    },
  };
}

/**
 * In-memory store, for tests and for a DATABASE_URL-less install.
 *
 * Takes RAW row shapes rather than ready-made `PublicMcpKeyBinding` values on
 * purpose: a test that hands over a well-formed object bypasses
 * `normalizeBindingRow` entirely and therefore proves nothing about the
 * fail-closed rules the pg path relies on. Same normalization, same denials.
 */
export function createInMemoryPublicMcpKeyBindingStore(
  rows: readonly Parameters<typeof normalizeBindingRow>[0][],
): PublicMcpKeyBindingStore {
  const byKey = new Map<string, Parameters<typeof normalizeBindingRow>[0]>();
  for (const row of rows) {
    if (typeof row.key_id === 'string') byKey.set(row.key_id, row);
  }
  return {
    async get(keyId) {
      const row = byKey.get(keyId);
      return row ? normalizeBindingRow(row) : undefined;
    },
  };
}
