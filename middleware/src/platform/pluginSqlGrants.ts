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
 * The C7 ramp for BUNDLED plugins — issue #794. Dated, closed, and keyed on a
 * question C2b's list does not answer.
 *
 * WHY THIS LIST HAD TO EXIST SEPARATELY
 * ------------------------------------
 * C7 originally borrowed `LEGACY_UNDECLARED_SERVICE_GRANTS_2026_08_20` as its
 * ramp. That list means "this plugin did not declare the SERVICE"; C7's gate
 * asks "this plugin did not declare `permissions.sql`". For a plugin that has
 * done C2b's work the two sets are DISJOINT, so borrowing the list produced a
 * rule with a perverse shape: doing the C2b migration correctly is what
 * removed a plugin from C7's ramp. `@omadia/memory-postgres` had done exactly
 * that, and the middleware stopped booting.
 *
 * The fix is not a wider gate — it is a ramp keyed on the right question. This
 * list covers EVERY bundled `graphPool` consumer — all four of them —
 * including the three that are ALSO covered by C2b's list today. That
 * redundancy is the point: when one of those three finishes its C2b migration
 * and drops off C2b's list, it must not fall through into a boot failure the
 * way memory-postgres did. The trap is disarmed for the whole class, not just
 * for the plugin that sprang it.
 *
 * TWO PROPERTIES, BOTH LOAD-BEARING
 * ---------------------------------
 *  1. Consulted ONLY for `origin === 'bundled'` (see {@link
 *     bundledSqlRampCapabilities}). An uploaded package that names itself
 *     `@omadia/memory-postgres` inherits nothing — origin is derived by the
 *     loader from where the package was found, never from the manifest.
 *  2. CLOSED SET. Adding a row means a bundled plugin regressed and needs a
 *     manifest fix plus an operator grant, not a wider gate. It retires when
 *     the operator grant surface ships and these plugins have been granted —
 *     `plugin_sql_grants` still has no caller of `grant()` in `src/`, which is
 *     why `granted` cannot yet be true for anyone, which is why a ramp is
 *     needed at all.
 *
 * `@omadia/channel-teams` is deliberately ABSENT: it left this repository for
 * `byte5ai/omadia-channel-teams` and is no longer bundled, so it arrives as an
 * installed package and stays on C2b's list. Adding it here would be a grant
 * this repo cannot honour and a claim it cannot audit.
 */
export const LEGACY_SQL_GRANTS_2026_08_20: Readonly<
  Record<string, readonly string[]>
> = Object.freeze({
  // Declares `permissions.sql` and `requires: graphPool@^1`, runs its own
  // migrator (`_memory_migrations`). The one whose absence was a hard startup
  // error — see issue #794.
  '@omadia/memory-postgres': Object.freeze(['graphPool']),
  // The remaining three bundled pool consumers. All three are on C2b's list
  // TODAY, so they are not currently reachable through this branch; they are
  // listed so that finishing their C2b migration cannot break boot.
  // (@omadia/memory-postgres above is NOT on C2b's list — that is issue #794.)
  '@omadia/orchestrator': Object.freeze(['graphPool']),
  '@omadia/orchestrator-extras': Object.freeze(['graphPool']),
  '@omadia/verifier': Object.freeze(['graphPool']),
});

/**
 * The ramp capabilities in force for one plugin — empty unless the catalog
 * says the package is bundled.
 *
 * Reads `origin` from the CATALOG rather than taking a boolean parameter on
 * purpose: a parameter is one more thing a call site can get wrong, and the
 * catalog is where the loader already recorded the answer. A plugin the
 * catalog cannot resolve gets no ramp — the same fail-closed reading
 * `sqlPermissionOf` uses.
 */
export function bundledSqlRampCapabilities(
  agentId: string,
  catalog: PluginCatalog,
): readonly string[] {
  if (catalog.get(agentId)?.origin !== 'bundled') return [];
  return LEGACY_SQL_GRANTS_2026_08_20[agentId] ?? [];
}

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
export const PLUGIN_LEDGER_NAMESPACE = 'plg_';

/**
 * The folded plugin-id segment that sits INSIDE the kernel-owned
 * `plg_<sanitized-plugin-id>_<suffix>` namespace.
 *
 * `@omadia/verifier` → `omadia_verifier`. The full id is folded, not just the
 * last segment: `@omadia/verifier` and `@acme/verifier` must not derive the
 * same middle segment, or the syntactic half of the ownership check would be
 * blind to exactly the collision it exists to catch.
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

function ownedLedgerPrefix(pluginId: string): string {
  return `${PLUGIN_LEDGER_NAMESPACE}${sanitizedPluginPrefix(pluginId)}_`;
}

/**
 * Validate a ledger name for one plugin. Returns the name on success so call
 * sites can write `const ledger = assertLedgerName(id, raw)` and never hold an
 * unvalidated copy alongside a validated one.
 *
 * Tightening the rule to the reserved `plg_..._` namespace is free TODAY:
 * `plugin_sql_grants` still has no shipped grant surface — nothing in `src/`
 * calls `grant()` — so no deployment can already contain persisted rows under
 * the looser rule. This is the last point where the kernel can make the
 * namespace mandatory without carrying a data migration forever.
 *
 * NOTE the prefix rule is necessary but NOT sufficient for ownership — for
 * plugins `acme_tool` and `acme_tool_extra` the name
 * `plg_acme_tool_extra_mig` carries both per-plugin prefixes. Exclusive
 * ownership is enforced by `UNIQUE (ledger)` in `plugin_sql_grants`
 * (migration 0047); this check is the cheap, offline half that rejects the
 * obvious cases before a grant is ever requested.
 */
export function assertLedgerName(pluginId: string, ledger: string): string {
  const prefix = ownedLedgerPrefix(pluginId);
  const maxSuffixLength = 63 - prefix.length;
  if (maxSuffixLength < 1) {
    throw new LedgerNameError(
      pluginId,
      ledger,
      `plugin id '${pluginId}' is too long for a plugin SQL ledger: mandatory prefix '${prefix}' uses ${String(prefix.length)} of Postgres' 63-char identifier limit and leaves no room for the required suffix`,
    );
  }
  if (!ledger.startsWith(prefix)) {
    throw new LedgerNameError(
      pluginId,
      ledger,
      `must start with this plugin's reserved prefix '${prefix}' — the kernel owns the 'plg_' namespace so no core table can ever live there, and a ledger outside it may belong to another plugin or core`,
    );
  }
  const suffix = ledger.slice(prefix.length);
  if (suffix.length === 0) {
    throw new LedgerNameError(
      pluginId,
      ledger,
      `must start with '${prefix}' and end with a non-empty suffix — bare per-plugin namespaces are not valid ledger table names`,
    );
  }
  if (ledger.length > 63) {
    throw new LedgerNameError(
      pluginId,
      ledger,
      `is too long for this plugin's reserved namespace: prefix '${prefix}' leaves room for at most ${String(maxSuffixLength)} suffix character${maxSuffixLength === 1 ? '' : 's'}, got ${String(suffix.length)}`,
    );
  }
  if (!LEDGER_NAME_RE.test(ledger)) {
    throw new LedgerNameError(
      pluginId,
      ledger,
      `must match ${String(LEDGER_NAME_RE)} — lowercase letters, digits and underscores, 3-63 chars, starting with a letter`,
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
  try {
    assertLedgerName(pluginId, ledger);
  } catch (err) {
    const detail =
      err instanceof LedgerNameError
        ? err.message
        : `must match ${String(LEDGER_NAME_RE)} and stay inside '${ownedLedgerPrefix(pluginId)}<suffix>'`;
    warn(
      `[catalog] plugin '${pluginId}': permissions.sql.ledger '${ledger}' is not a name this plugin may own ` +
        `(${detail}) — permissions.sql ignored`,
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
  // Epic #470 C15 — the ledger-handoff plan the kernel runs BEFORE the
  // migrations directory. Only the shape of the STRING is decided here; the
  // file it names is read and validated at activation
  // (`platform/pluginHandoffPlan.ts`), where the package root is known and a
  // refusal can still fail the activation.
  //
  // Dropped-with-a-warning rather than rejected, matching `migrations` and
  // this loader's rule everywhere else. The degradation is not silent
  // downstream: `handoff` absent means the kernel runs no handoff, so the
  // migrations simply apply — the pre-C15 behaviour, which is safe.
  const handoffRaw = rec['handoff'];
  let handoff: string | undefined;
  if (typeof handoffRaw === 'string' && handoffRaw.length > 0) {
    handoff = handoffRaw;
  } else if (handoffRaw !== undefined) {
    warn(
      `[catalog] plugin '${pluginId}': permissions.sql.handoff must be a non-empty path inside the package — ignored, so the migration runner will apply every file`,
    );
  }
  return {
    ledger,
    ...(migrations === undefined ? {} : { migrations }),
    ...(handoff === undefined ? {} : { handoff }),
  };
}

/** Directory a plugin's migrations live in when the manifest does not say. */
export const DEFAULT_MIGRATIONS_DIR = 'migrations';

/** Why a pool-shaped `services.get` was allowed — or wasn't. */
export type SqlAccessOutcome =
  | 'not-pool-shaped'
  | 'allowed'
  | 'legacy-allowlist'
  | 'bundled-legacy'
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
  /** #794 — true when C7's OWN dated ramp covers this pair AND the catalog
   *  says the package is bundled. Required, not optional: an optional flag
   *  here would let a new call site inherit a default it never considered,
   *  and every call site in this subsystem is a place where "may this plugin
   *  touch the operator's database?" is being answered. Compute it with
   *  {@link bundledSqlRampCapabilities}, which is the only thing that reads
   *  the origin. */
  readonly bundledLegacy: boolean;
}

/**
 * Classify one pool-shaped access. Pure — no throwing, no logging — so a test
 * can assert the decision directly instead of catching an exception and
 * inferring which branch produced it.
 */
export function classifySqlAccess(input: SqlAccessInput): SqlAccessOutcome {
  if (!POOL_SHAPED_CAPABILITIES.has(input.capability)) return 'not-pool-shaped';
  if (input.declared && input.granted) return 'allowed';
  // Both ramps are checked only AFTER the clean path fails, so a plugin that
  // has done the work is never reported as legacy — otherwise a ramp could
  // never be observed to be empty.
  //
  // #794: the BUNDLED ramp is checked first, because when both apply it is
  // the more specific and more accurate reason — the plugin ships in this
  // image, which is a stronger statement than "C2b found it undeclared", and
  // it is the one whose warning names the right remedy.
  if (input.bundledLegacy) return 'bundled-legacy';
  // C2b's ramp. Checked before the denials because C2b's audit found these
  // pairs consuming the pool today: turning them off would break shipped Hub
  // plugins this repo cannot edit. It expires with C2b's allowlist.
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
  // #794 — resolved from the catalog, once, at context-build time. Read here
  // rather than threaded in as an option so there is exactly one place that
  // decides what "bundled" means, and no call site that can assert it.
  const bundledRamp = bundledSqlRampCapabilities(agentId, catalog);
  const warned = new Set<string>();

  return function assertSqlAccess(capability: string): void {
    const outcome = classifySqlAccess({
      capability,
      declared,
      granted,
      legacy: legacyCapabilities.includes(capability),
      bundledLegacy: bundledRamp.includes(capability),
    });
    if (outcome === 'undeclared' || outcome === 'ungranted') {
      throw new SqlPermissionError(agentId, capability, outcome);
    }
    if (outcome === 'bundled-legacy' && !warned.has(capability)) {
      warned.add(capability);
      log(
        `[sql] bundled plugin '${agentId}' resolved the database capability '${capability}' without an operator grant — ` +
          'allowed by the dated built-in ramp (LEGACY_SQL_GRANTS_2026_08_20). It ships inside this middleware image, so ' +
          'installing the middleware is the consent; the ramp retires once the operator grant surface ships and these ' +
          'plugins have been granted. A ramp is not a permission.',
      );
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
