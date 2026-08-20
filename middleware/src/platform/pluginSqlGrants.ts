/**
 * `permissions.sql` — declaration, ledger ownership, and the pool gate.
 * Epic #470, item C7 / G4.
 *
 * WHAT THIS CLOSES
 * ----------------
 * C2b made `ctx.services.get(name)` resolve only capabilities the manifest
 * declares in `requires:` (bug B1). That is the right rule for ordinary
 * capabilities, but it is not sufficient for `graphPool`: the pool is not a
 * service *another plugin* provides, it is the operator's own database
 * connection — the same one core writes user data through. A `requires:` line
 * is a statement by the plugin author. Handing over the operator's database on
 * the strength of the author's own say-so is the wrong bar.
 *
 * So pool-shaped capabilities need BOTH halves:
 *
 *   1. `requires: graphPool@^1`   — the author declares the dependency (C2b).
 *   2. `permissions.sql: {...}`   — the author declares the INTENT to own
 *                                   schema, which is what the install dialog
 *                                   can show a human.
 *   3. an operator grant row      — the human agreed. (`plugin_sql_grants`)
 *
 * Any one missing → `SqlPermissionError`. The two error reasons are kept
 * distinct because they have different fixers: `undeclared` is the plugin
 * author's to fix, `ungranted` is the operator's, and collapsing them would
 * send every author chasing a manifest bug that isn't theirs.
 *
 * WHY THE LEDGER NAME IS VALIDATED HERE AND NOT AT THE CALL SITE
 * -------------------------------------------------------------
 * The ledger is the one plugin-supplied string in this subsystem that reaches
 * SQL as an IDENTIFIER rather than a bind parameter — `CREATE TABLE "x"` has
 * no `$1` form. Identifier interpolation is only ever safe when the value was
 * already proven to be in a charset that cannot express an escape, so the
 * allowlist runs BEFORE quoting and the quoting is belt-and-braces, not the
 * defence. Keeping both in one module means there is exactly one place to read
 * to know whether that holds — a second validator elsewhere would eventually
 * disagree with this one.
 */

import {
  LedgerNameError,
  SqlPermissionError,
  type SqlPermission,
} from '@omadia/plugin-api';

import type { PluginCatalog } from '../plugins/manifestLoader.js';

/**
 * Capabilities that hand over a raw Postgres pool.
 *
 * A CLOSED set, deliberately. The alternative — a heuristic on the name, or on
 * the resolved object's shape — would silently stop gating the day someone
 * registers a pool under a name the heuristic does not recognise, and nothing
 * would fail; the gate would just quietly become a no-op. A closed set fails
 * the other way: a new pool capability is ungated until someone adds it here,
 * which is a reviewable omission rather than an invisible one.
 *
 * `graphPool` is the existing capability name (see `plugins/bootstrap.ts` and
 * `index.ts`); this file deliberately does NOT invent a second name for the
 * same pool.
 */
export const POOL_SHAPED_CAPABILITIES: ReadonlySet<string> = new Set([
  'graphPool',
]);

/**
 * Charset a ledger table name must be in.
 *
 * Lowercase-first so the name survives Postgres' unquoted-identifier folding
 * identically whether or not a future call site forgets the quotes; 3–63 chars
 * total to stay inside Postgres' 63-byte `NAMEDATALEN` limit with the leading
 * character counted. No quotes, no whitespace, no semicolons, no hyphens —
 * nothing that can terminate an identifier or start a statement.
 */
export const LEDGER_NAME_RE = /^[a-z][a-z0-9_]{2,62}$/;

/**
 * The prefix a plugin's ledger must start with, derived from the kernel-known
 * plugin id — never from anything the plugin sends at runtime.
 *
 * `@omadia/verifier` → `omadia_verifier`. The full id is folded, not just its
 * last segment: `@omadia/verifier` and `@acme/verifier` must not derive the
 * same prefix, or the syntactic half of the ownership check would be blind to
 * exactly the collision it exists to catch.
 */
export function sanitizedPluginPrefix(pluginId: string): string {
  const folded = pluginId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  // An id made entirely of punctuation folds to the empty string, and an id
  // starting with a digit is not a legal identifier start. Both get a stable
  // literal prefix rather than a throw: the loader has already accepted the id
  // by this point, and refusing to derive a prefix would take a working plugin
  // offline over a cosmetic property of its name.
  return /^[a-z]/.test(folded) ? folded : `p_${folded}`;
}

/**
 * Validate a ledger name for one plugin. Returns the name on success so call
 * sites can write `const ledger = assertLedgerName(id, raw)` and never hold an
 * unvalidated copy alongside a validated one.
 *
 * NOTE the prefix rule is necessary but NOT sufficient for ownership — for
 * plugins `acme_tool` and `acme_tool_extra` the name `acme_tool_extra_mig`
 * carries both prefixes. Exclusive ownership is enforced by `UNIQUE (ledger)`
 * in `plugin_sql_grants` (migration 0045); this check is the cheap, offline
 * half that rejects the obvious cases before a grant is ever requested.
 */
export function assertLedgerName(pluginId: string, ledger: string): string {
  if (!LEDGER_NAME_RE.test(ledger)) {
    throw new LedgerNameError(
      pluginId,
      ledger,
      `must match ${String(LEDGER_NAME_RE)} — lowercase letters, digits and underscores, 3-63 chars, starting with a letter`,
    );
  }
  const prefix = sanitizedPluginPrefix(pluginId);
  if (!ledger.startsWith(prefix)) {
    throw new LedgerNameError(
      pluginId,
      ledger,
      `must start with this plugin's own prefix '${prefix}' — a ledger outside it may belong to another plugin, and forging another plugin's migration history would suppress its schema changes at the next boot`,
    );
  }
  return ledger;
}

/** Same rule, as a predicate, for callers that want to drop rather than throw
 *  (the manifest loader warns and degrades instead of rejecting a package). */
export function isValidLedgerName(pluginId: string, ledger: string): boolean {
  try {
    assertLedgerName(pluginId, ledger);
    return true;
  } catch {
    return false;
  }
}

/** Parse a raw `permissions.sql` block. Returns undefined when absent or
 *  malformed — absence and garbage both mean "this plugin declared nothing",
 *  which is the fail-closed reading. */
export function parseSqlPermission(
  raw: unknown,
  pluginId: string,
  warn: (msg: string) => void = (m) => {
    console.warn(m);
  },
): SqlPermission | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    warn(
      `[catalog] plugin '${pluginId}': permissions.sql must be a mapping — ignored`,
    );
    return undefined;
  }
  const rec = raw as Record<string, unknown>;
  const ledger = rec['ledger'];
  if (typeof ledger !== 'string' || ledger.length === 0) {
    warn(
      `[catalog] plugin '${pluginId}': permissions.sql requires a 'ledger' table name — ignored`,
    );
    return undefined;
  }
  if (!isValidLedgerName(pluginId, ledger)) {
    warn(
      `[catalog] plugin '${pluginId}': permissions.sql.ledger '${ledger}' is not a name this plugin may own ` +
        `(must match ${String(LEDGER_NAME_RE)} and start with '${sanitizedPluginPrefix(pluginId)}') — permissions.sql ignored`,
    );
    return undefined;
  }
  const migrationsRaw = rec['migrations'];
  let migrations: string | undefined;
  if (typeof migrationsRaw === 'string' && migrationsRaw.length > 0) {
    migrations = migrationsRaw;
  } else if (migrationsRaw !== undefined) {
    warn(
      `[catalog] plugin '${pluginId}': permissions.sql.migrations must be a non-empty string — falling back to the default '${DEFAULT_MIGRATIONS_DIR}'`,
    );
  }
  return migrations === undefined ? { ledger } : { ledger, migrations };
}

/** Directory a plugin's migrations live in when the manifest does not say. */
export const DEFAULT_MIGRATIONS_DIR = 'migrations';

/** Why a pool-shaped `services.get` was allowed — or wasn't. */
export type SqlAccessOutcome =
  | 'not-pool-shaped'
  | 'allowed'
  | 'legacy-allowlist'
  | 'undeclared'
  | 'ungranted';

export interface SqlAccessInput {
  /** Capability being resolved. */
  readonly capability: string;
  /** `permissions.sql` from the manifest, or undefined when absent. */
  readonly declared: SqlPermission | undefined;
  /** True when a `plugin_sql_grants` row exists for this plugin. */
  readonly granted: boolean;
  /** True when C2b's dated legacy allowlist already covers this exact
   *  (plugin, capability) pair. */
  readonly legacy: boolean;
}

/**
 * Classify one pool-shaped access. Pure — no throwing, no logging — so a test
 * can assert the decision directly instead of catching an exception and
 * inferring which branch produced it.
 */
export function classifySqlAccess(input: SqlAccessInput): SqlAccessOutcome {
  if (!POOL_SHAPED_CAPABILITIES.has(input.capability)) return 'not-pool-shaped';
  if (input.declared && input.granted) return 'allowed';
  // The legacy ramp is checked only AFTER the clean path fails, so a plugin
  // that has done the work is never reported as legacy. It is checked before
  // the denials because C2b's audit found these pairs consuming the pool
  // today: turning them off in this PR would break shipped Hub plugins that
  // this PR cannot edit. It expires with C2b's allowlist, not separately —
  // one retirement date for one migration ramp.
  if (input.legacy) return 'legacy-allowlist';
  return input.declared ? 'ungranted' : 'undeclared';
}

export interface SqlGateOptions {
  readonly agentId: string;
  readonly catalog: PluginCatalog;
  /** Resolved once at activate — `services.get` is synchronous and cannot
   *  await a grant lookup, so the async read happens before the context is
   *  built and the decision here is a pure function of it. */
  readonly granted: boolean;
  /** C2b's legacy pairs, so one ramp governs both gates. */
  readonly legacyCapabilities: readonly string[];
  readonly log: (...args: unknown[]) => void;
}

/**
 * Build the per-plugin pool gate. The returned function runs for every
 * `ctx.services.get(name)` AFTER C2b's declaration gate has passed, and either
 * returns (not pool-shaped, or cleared) or throws `SqlPermissionError`.
 *
 * Composed rather than merged into `createServiceGrantGate` on purpose: that
 * gate answers "did the author declare this?", this one answers "may this
 * plugin touch the operator's database?". They deny for different reasons and
 * are retired on different schedules.
 */
export function createSqlGate(
  opts: SqlGateOptions,
): (capability: string) => void {
  const { agentId, catalog, granted, legacyCapabilities, log } = opts;
  const declared = sqlPermissionOf(agentId, catalog);
  const warned = new Set<string>();

  return function assertSqlAccess(capability: string): void {
    const outcome = classifySqlAccess({
      capability,
      declared,
      granted,
      legacy: legacyCapabilities.includes(capability),
    });
    if (outcome === 'undeclared' || outcome === 'ungranted') {
      throw new SqlPermissionError(agentId, capability, outcome);
    }
    if (outcome === 'legacy-allowlist' && !warned.has(capability)) {
      warned.add(capability);
      log(
        `[sql] '${agentId}' resolved the database capability '${capability}' without a \`permissions.sql\` grant — ` +
          'allowed by the dated legacy allowlist (2026-08-20). Declare `permissions.sql` in the manifest and have the ' +
          'operator grant it; the allowlist is a migration ramp, not a permission.',
      );
    }
  };
}

/** `permissions.sql` for one plugin, or undefined when it declared none.
 *  A plugin with no catalog entry declares nothing — the same fail-closed
 *  reading `declaredServiceNames` uses for an id the kernel cannot resolve. */
export function sqlPermissionOf(
  agentId: string,
  catalog: PluginCatalog,
): SqlPermission | undefined {
  return catalog.get(agentId)?.plugin.permissions_summary.sql;
}
