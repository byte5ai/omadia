import type { Request, Response, Router } from 'express';

import type { SqlPermission } from '@omadia/plugin-api';

import type { PluginSqlGrantStore } from '../platform/pluginSqlGrantStore.js';
import { LedgerAlreadyOwnedError } from '../platform/pluginSqlGrantStore.js';
import type { PublicPathGrantRegistry } from '../platform/publicPathGrants.js';
import { validateDeclaredPublicPath } from '../platform/publicPathGrants.js';
import type { PublicPathGrantStore } from '../platform/publicPathGrantStore.js';
import { publicPaths } from '../auth/publicPaths.js';
import type { InstalledAgent, InstalledRegistry } from '../plugins/installedRegistry.js';
import type { PluginCatalog } from '../plugins/manifestLoader.js';

/**
 * Epic #470 C16 (issue #817) — ONE operator consent surface for the two grants
 * a plugin can ask for.
 *
 * WHAT WAS WRONG
 * --------------
 * C4 shipped a consent route for `permissions.public_paths`. C7 shipped the
 * gate for `permissions.sql` but no way to answer it: `pluginSqlGrants.ts` says
 * twice in its own source that nothing in `src/` calls `grant()`, and
 * `@omadia/dev-platform`'s operator guide documented the workaround —
 * `INSERT INTO plugin_sql_grants …` by hand, then restart the middleware.
 *
 * A permission whose only "yes" is a SQL statement is not a permission an
 * operator gave; it is one an operator was talked through. And a consent
 * mechanism that needs a restart to take effect teaches operators to grant
 * everything up front, because the cost of finding out later is an outage.
 *
 * WHY ONE ROUTE FOR BOTH
 * ----------------------
 * The two grants are asked for together, in one manifest, at one moment — the
 * install. Two routes would mean two dialogs, two half-consented states, and an
 * operator who has to know that "SQL" and "public paths" are different
 * subsystems in order to answer a question about one plugin. The consented set
 * is reviewed as a whole, which is the same reason C4's PUT takes the complete
 * path list rather than one path at a time.
 *
 * The old `/public-paths` route stays as a thin alias over the same core, so
 * the `curl` in every shipped operator guide keeps working.
 *
 * PARTIAL BODY, TOTAL FIELDS
 * --------------------------
 * `{ sql?: boolean, public_paths?: string[] }`. An ABSENT key means "leave this
 * grant alone" — the panel's per-grant toggle sends one key. A PRESENT
 * `public_paths` is the COMPLETE consented set, so omitting a prefix revokes
 * it, exactly as C4's route behaves. Those two rules do not conflict: one is
 * about which grants this request speaks to, the other about what it says when
 * it does.
 *
 * THE LEDGER NAME IS NEVER TAKEN FROM THE BODY
 * --------------------------------------------
 * `permissions.sql.ledger` is read from the MANIFEST. A caller-supplied ledger
 * would let this route write a grant for a table the operator never saw named
 * in a consent dialog, and `assertLedgerName`'s ownership rule protects the
 * manifest, not the request body. For the same reason `granted_by` comes from
 * the session, never from the body: a consent record that the consenting party
 * can dictate records nothing.
 */

/** The subset of `RuntimeDeps` this surface needs. Declared here rather than
 *  imported so the module has no cycle back into `runtime.ts`. */
export interface GrantRouteDeps {
  installedRegistry: InstalledRegistry;
  catalog?: PluginCatalog;
  publicPathGrantStore?: PublicPathGrantStore;
  publicPathGrants?: PublicPathGrantRegistry;
  sqlGrantStore?: PluginSqlGrantStore;
  /** Tear the running instance down and bring it back up so the grant takes
   *  effect with no restart. `InstallService.reactivate` records the truthful
   *  outcome in the registry (#799), which is where {@link buildGrantsView}
   *  reads the resulting state from — this route never infers success from the
   *  absence of a throw. */
  reactivate?: (agentId: string) => Promise<unknown>;
}

/** One thing the manifest asked for that the operator has not granted. */
export type MissingGrant =
  | { readonly kind: 'sql'; readonly ledger: string }
  | { readonly kind: 'public_path'; readonly path: string };

export interface GrantsView {
  readonly id: string;
  readonly declared: {
    readonly sql: SqlPermission | null;
    readonly public_paths: readonly string[];
    readonly optional_requires: readonly string[];
  };
  readonly granted: {
    /** EFFECTIVE consent: a row exists AND its ledger still matches the
     *  manifest. A grant for a ledger the plugin no longer declares is not
     *  consent to the one it declares now. */
    readonly sql: boolean;
    /** What is actually on record, so the panel can say "granted for a
     *  different table" instead of the indistinguishable "not granted". */
    readonly sql_ledger: string | null;
    readonly public_paths: readonly string[];
  };
  readonly state: InstalledAgent['status'];
  readonly missing: readonly MissingGrant[];
  /** Consent whose declaration disappeared (plugin downgraded, manifest
   *  edited). It grants nothing today; an operator should still see it. */
  readonly orphaned_public_paths: readonly string[];
  readonly last_activation_error: string | null;
  readonly last_activation_error_at: string | null;
}

/** `{ code, message }` — the shape every route in this tree answers errors with. */
interface GrantError {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

/** Consent requested by one PUT. An absent key speaks to nothing. */
export interface GrantRequest {
  readonly sql?: boolean;
  readonly publicPaths?: readonly string[];
}

export function declaredSqlOf(
  deps: GrantRouteDeps,
  id: string,
): SqlPermission | null {
  return deps.catalog?.get(id)?.plugin.permissions_summary?.sql ?? null;
}

export function declaredPublicPathsOf(
  deps: GrantRouteDeps,
  id: string,
): readonly string[] {
  return deps.catalog?.get(id)?.plugin.permissions_summary?.public_paths ?? [];
}

/**
 * Read everything the consent surface shows, from the manifest, the two grant
 * tables and the installed registry.
 *
 * Never throws: the stores already fail closed on read (a lookup that cannot be
 * satisfied answers "no grant"), and a view that 500s would hide the `errored`
 * state it exists to explain.
 */
export async function buildGrantsView(
  deps: GrantRouteDeps,
  id: string,
): Promise<GrantsView> {
  const entry = deps.installedRegistry.get(id);
  const declaredSql = declaredSqlOf(deps, id);
  const declaredPaths = declaredPublicPathsOf(deps, id);
  const optionalRequires =
    deps.catalog?.get(id)?.plugin.optional_requires ?? [];

  const sqlRow = deps.sqlGrantStore
    ? await deps.sqlGrantStore.get(id)
    : undefined;
  const grantedPaths = deps.publicPathGrantStore
    ? await deps.publicPathGrantStore.listForPlugin(id)
    : new Set<string>();

  const sqlEffective =
    declaredSql !== null && sqlRow?.ledger === declaredSql.ledger;

  const missing: MissingGrant[] = [];
  if (declaredSql && !sqlEffective) {
    missing.push({ kind: 'sql', ledger: declaredSql.ledger });
  }
  for (const path of declaredPaths) {
    if (!grantedPaths.has(path)) missing.push({ kind: 'public_path', path });
  }

  return {
    id,
    declared: {
      sql: declaredSql,
      public_paths: [...declaredPaths],
      optional_requires: [...optionalRequires],
    },
    granted: {
      sql: sqlEffective,
      sql_ledger: sqlRow?.ledger ?? null,
      public_paths: declaredPaths.filter((path) => grantedPaths.has(path)),
    },
    state: entry?.status ?? 'inactive',
    missing,
    orphaned_public_paths: [...grantedPaths].filter(
      (path) => !declaredPaths.includes(path),
    ),
    last_activation_error: entry?.last_activation_error ?? null,
    last_activation_error_at: entry?.last_activation_error_at ?? null,
  };
}

/**
 * Everything that must hold before a single row is written.
 *
 * Split out from {@link applyGrants} so the refusals are one readable list
 * rather than a trail of early returns among the writes, and so a test can
 * assert a refusal without a database.
 */
function checkGrantRequest(
  deps: GrantRouteDeps,
  id: string,
  request: GrantRequest,
): GrantError | null {
  if (!deps.installedRegistry.has(id)) {
    return {
      status: 404,
      code: 'runtime.not_installed',
      message: `agent '${id}' is not installed`,
    };
  }

  if (request.sql !== undefined) {
    const declaredSql = declaredSqlOf(deps, id);
    // CONSENT MAY NEVER EXCEED THE DECLARATION. Without this the consent route
    // would itself be a way to hand any installed plugin the operator's
    // database — a bigger hole than the one C7 closed.
    if (request.sql && declaredSql === null) {
      return {
        status: 400,
        code: 'runtime.sql_not_declared',
        message:
          `agent '${id}' does not declare permissions.sql — there is no ledger ` +
          'to grant, and consent cannot exceed the declaration',
      };
    }
    if (request.sql && !deps.sqlGrantStore) {
      return {
        status: 503,
        code: 'runtime.sql_grants_unavailable',
        message: 'SQL grants require a database — none is configured',
      };
    }
  }

  if (request.publicPaths !== undefined) {
    if (!deps.publicPathGrantStore) {
      return {
        status: 503,
        code: 'runtime.public_paths_unavailable',
        message: 'public-path grants require a database — none is configured',
      };
    }
    const declared = declaredPublicPathsOf(deps, id);
    const undeclared = request.publicPaths.filter(
      (path) => !declared.includes(path),
    );
    if (undeclared.length > 0) {
      return {
        status: 400,
        code: 'runtime.public_path_not_declared',
        message:
          `agent '${id}' does not declare ${undeclared.join(', ')} in ` +
          'permissions.public_paths — consent cannot exceed the declaration',
      };
    }
    // Re-run the syntactic gate at consent time too. The catalog entry could
    // have been produced by an older core, and this is the last point before a
    // prefix becomes unauthenticated.
    for (const path of request.publicPaths) {
      const check = validateDeclaredPublicPath(path, {
        corePublicPaths: publicPaths(),
        ownRoutePrefixes: declared,
      });
      if (!check.ok) {
        return {
          status: 400,
          code: 'runtime.invalid_public_path',
          message: `'${check.path}' ${check.reason}`,
        };
      }
    }
  }

  return null;
}

/**
 * Write the requested consent, then re-activate so it takes effect now.
 *
 * WRITE ORDER IS NOT ARBITRARY. Revocations go first, and within the public-path
 * revocation the in-memory registry is narrowed BEFORE the table row is deleted
 * — that registry, not the table, is what the terminating mount consults on
 * every request, so a revoke that reaches the table but not the registry is a
 * prefix still answering WITHOUT A SESSION. Closing the registry first means the
 * surface is already shut no matter which write below fails, and the worst case
 * is a row that outlives its routing effect: the restrictive direction.
 *
 * Grants go last for the mirror-image reason — a half-applied widening should
 * widen nothing.
 *
 * The two tables are not written in one transaction, and this does not pretend
 * otherwise: they live behind two stores, one of which may be the null store.
 * What IS guaranteed is that a failure anywhere leaves the routing registry
 * re-synced from the table (see the catch in the route) and the caller told, so
 * the operator never sees a green result over a half-written consent.
 */
export async function applyGrants(
  deps: GrantRouteDeps,
  id: string,
  request: GrantRequest,
  actor: string,
): Promise<void> {
  if (request.publicPaths !== undefined) {
    const next = new Set(request.publicPaths);
    const current =
      (await deps.publicPathGrantStore?.listForPlugin(id)) ??
      new Set<string>();
    const revoked = [...current].filter((path) => !next.has(path));
    if (revoked.length > 0) {
      deps.publicPathGrants?.setGranted(
        id,
        new Set([...current].filter((path) => next.has(path))),
      );
      for (const path of revoked) {
        await deps.publicPathGrantStore?.revoke(id, path);
      }
    }
    for (const path of next) {
      await deps.publicPathGrantStore?.grant(id, path, actor);
    }
    deps.publicPathGrants?.setGranted(id, next);
  }

  if (request.sql === false) {
    await deps.sqlGrantStore?.revoke(id);
  } else if (request.sql === true) {
    const declaredSql = declaredSqlOf(deps, id);
    // `checkGrantRequest` already refused a `true` with no declaration; this is
    // the type-level restatement, not a second gate.
    if (declaredSql) {
      await deps.sqlGrantStore?.grant(id, declaredSql.ledger, actor);
    }
  }
}

/** Put the routing registry back in step with the consent table after a failed
 *  write. The registry decides whether a URL skips authentication, so it must
 *  never be left describing consent the table no longer records. When the
 *  re-read itself fails there is no trustworthy answer, and the only safe
 *  assumption is that nothing is consented. */
export async function resyncPublicPathGrants(
  deps: Pick<GrantRouteDeps, 'publicPathGrantStore' | 'publicPathGrants'>,
  pluginId: string,
): Promise<void> {
  const registry = deps.publicPathGrants;
  if (!registry) return;
  try {
    const truth =
      (await deps.publicPathGrantStore?.listForPlugin(pluginId)) ??
      new Set<string>();
    registry.setGranted(pluginId, new Set(truth));
  } catch (err) {
    registry.setGranted(pluginId, new Set<string>());
    console.warn(
      `[public-paths] could not re-read consent for '${pluginId}' after a failed update — closing every granted prefix:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** Session identity of whoever is consenting. Never read from the body — see
 *  the module header. */
export function actorOf(req: Request): string {
  return req.session?.email ?? req.session?.sub ?? 'unknown';
}

/** `:id` or an error. Shared by every handler in this module. */
function idOf(req: Request): string | undefined {
  const raw = req.params['id'];
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/**
 * Parse `{ sql?, public_paths? }`.
 *
 * A body that speaks to NO grant is refused rather than treated as a no-op: it
 * is far more likely to be a client sending the wrong key name than an operator
 * asking for nothing, and answering 200 to a typo'd consent request is how a
 * grant silently never happens.
 */
export function parseGrantBody(raw: unknown): GrantRequest | GrantError {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      status: 400,
      code: 'runtime.invalid_grants',
      message: 'body must be an object with `sql` and/or `public_paths`',
    };
  }
  const body = raw as { sql?: unknown; public_paths?: unknown };
  const request: { sql?: boolean; publicPaths?: string[] } = {};

  if (body.sql !== undefined) {
    if (typeof body.sql !== 'boolean') {
      return {
        status: 400,
        code: 'runtime.invalid_grants',
        message: 'body.sql must be a boolean',
      };
    }
    request.sql = body.sql;
  }
  if (body.public_paths !== undefined) {
    if (
      !Array.isArray(body.public_paths) ||
      body.public_paths.some((p) => typeof p !== 'string')
    ) {
      return {
        status: 400,
        code: 'runtime.invalid_public_paths',
        message: 'body.public_paths must be an array of strings',
      };
    }
    request.publicPaths = [...new Set(body.public_paths as string[])];
  }
  if (request.sql === undefined && request.publicPaths === undefined) {
    return {
      status: 400,
      code: 'runtime.invalid_grants',
      message:
        'body must set at least one of `sql` or `public_paths` — a request ' +
        'that grants and revokes nothing is more likely a mistyped key than ' +
        'an intent',
    };
  }
  return request;
}

function isGrantError(value: GrantRequest | GrantError): value is GrantError {
  return 'code' in value;
}

/**
 * Run the write, the re-activation and the read-back that every consent path
 * shares. Returns the resulting view, or answers the response itself on error.
 */
export async function commitGrants(
  deps: GrantRouteDeps,
  id: string,
  request: GrantRequest,
  req: Request,
  res: Response,
): Promise<GrantsView | null> {
  const refusal = checkGrantRequest(deps, id, request);
  if (refusal) {
    res.status(refusal.status).json({
      code: refusal.code,
      message: refusal.message,
    });
    return null;
  }

  try {
    await applyGrants(deps, id, request, actorOf(req));
  } catch (err) {
    await resyncPublicPathGrants(deps, id);
    if (err instanceof LedgerAlreadyOwnedError) {
      res.status(409).json({
        code: 'runtime.ledger_already_owned',
        message: err.message,
      });
      return null;
    }
    res.status(500).json({
      code: 'runtime.update_failed',
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  // TAKE EFFECT NOW, NOT AT NEXT BOOT.
  //
  // `ctx.services.get` is synchronous, so the SQL grant is read ONCE, before
  // the plugin's context is built — a row written afterwards reaches a context
  // that has already decided. Re-activating is what closes that gap, and it is
  // the difference between a consent surface and a form that tells the operator
  // to restart the middleware. Public-path consent applies live via the
  // registry, but the plugin is re-activated for both so one action has one
  // outcome.
  //
  // A failed re-activation is NOT an error response: the grant was written and
  // asking again would not help. It is reported as the resulting `state`, which
  // `InstallService.reactivate` has by then recorded truthfully (#799).
  if (deps.reactivate) {
    try {
      await deps.reactivate(id);
    } catch (err) {
      console.error(
        `[grants] re-activation after a consent change failed for '${id}':`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return buildGrantsView(deps, id);
}

/**
 * Mount `GET|PUT /installed/:id/grants` on the runtime router.
 *
 * Same posture as every other endpoint in this tree: the router is mounted
 * behind `requireAuth`, so a caller here already holds an operator session, and
 * `actorOf` reads the consenting identity from it.
 */
export function registerGrantRoutes(router: Router, deps: GrantRouteDeps): void {
  router.get('/installed/:id/grants', async (req: Request, res: Response) => {
    const id = idOf(req);
    if (!id) {
      res
        .status(400)
        .json({ code: 'runtime.invalid_id', message: 'missing id' });
      return;
    }
    if (!deps.installedRegistry.has(id)) {
      res.status(404).json({
        code: 'runtime.not_installed',
        message: `agent '${id}' is not installed`,
      });
      return;
    }
    res.json(await buildGrantsView(deps, id));
  });

  router.put('/installed/:id/grants', async (req: Request, res: Response) => {
    const id = idOf(req);
    if (!id) {
      res
        .status(400)
        .json({ code: 'runtime.invalid_id', message: 'missing id' });
      return;
    }
    const parsed = parseGrantBody(req.body);
    if (isGrantError(parsed)) {
      res.status(parsed.status).json({
        code: parsed.code,
        message: parsed.message,
      });
      return;
    }
    const view = await commitGrants(deps, id, parsed, req, res);
    if (view) res.json(view);
  });
}
