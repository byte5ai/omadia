/**
 * #2088 (spec A §5.10) — the database of an archetype plugin.
 *
 * An archetype plugin owns its engine and process tables. One that does not
 * require the shared pool ({@link ownsItsDatabase}) is not handed the pool the
 * kernel writes its own data through. It gets:
 *
 *   - a schema of its own (`plg_<plugin id>`),
 *   - a RUNTIME login role that can read and write the tables of that schema
 *     and nothing else,
 *   - a MIGRATION login role that owns the schema and its tables; the
 *     plugin's migration files run as that role.
 *
 * WHY LOGIN ROLES AND NOT `SET ROLE`
 * ----------------------------------
 * The role is the boundary, and the plugin sends its own SQL. A role taken
 * with `SET ROLE` on a kernel connection is undone by `RESET ROLE` in the
 * next statement. A role the connection authenticated as cannot be left. It
 * also survives a transaction-mode pooler, which a session-level `SET` does
 * not.
 *
 * WHY `search_path` IS SET WHEN THE ROLE IS CREATED
 * -------------------------------------------------
 * `ALTER ROLE … SET search_path` applies to server sessions that start after
 * it. Behind a pooler a new client connection is usually served by a server
 * session that already exists, so a later change may not arrive for a long
 * time (measured on the hosted instance, 2026-11-19: four fresh connections
 * over 8 s all kept the old value). So the kernel sets it in the transaction
 * that creates the role, before the role has ever logged in, and every
 * transaction it opens for the plugin sets it again with `SET LOCAL`.
 *
 * WHAT THIS IS NOT
 * ----------------
 * Plugin code runs inside the kernel's process. This module decides what the
 * connection the kernel HANDS OUT can reach; it cannot stop code in the same
 * process from opening a connection of its own with credentials it finds
 * there. That is the process boundary, not the database's.
 */

import { createHmac } from 'node:crypto';

import type {
  SqlAccessor,
  SqlStatementResult,
  SqlTransaction,
} from '@omadia/plugin-api';
import { Pool, type PoolClient, type PoolConfig } from 'pg';

import {
  PLUGIN_LEDGER_NAMESPACE,
  POOL_SHAPED_CAPABILITIES,
  sanitizedPluginPrefix,
} from './pluginSqlGrants.js';

/**
 * Whether a plugin's database is its own schema instead of the shared pool:
 * a plugin of kind `archetype` whose manifest asks for no pool-shaped
 * capability (`graphPool`).
 *
 * The manifest line is the plugin's opt-in, and it has to be the plugin's:
 * its code either sends its statements through `ctx.sql` or through the pool,
 * and its tables are in its schema or in `public` accordingly. A plugin that
 * still requires the pool keeps it, with its tables where they are.
 */
export function ownsItsDatabase(plugin: {
  readonly kind: string;
  readonly requires?: readonly string[];
  readonly optional_requires?: readonly string[];
}): boolean {
  if (plugin.kind !== 'archetype') return false;
  const asked = [...(plugin.requires ?? []), ...(plugin.optional_requires ?? [])];
  return !asked.some((ref) => POOL_SHAPED_CAPABILITIES.has(ref.split('@')[0]?.trim() ?? ''));
}

/**
 * Boot order: a plugin that owns its database must activate after the plugin
 * that publishes the kernel's pool, because its schema and roles are set up
 * through that pool. A plugin on the shared pool gets this edge from its
 * `requires: graphPool` line; one that owns its database has dropped that
 * line, and would otherwise start first and find no database.
 */
export function ownDatabaseEdges(
  ids: readonly string[],
  pluginOf: (id: string) =>
    | {
        readonly kind: string;
        readonly requires?: readonly string[];
        readonly optional_requires?: readonly string[];
        readonly provides?: readonly string[];
        readonly permissions_summary?: { readonly sql?: unknown };
      }
    | undefined,
): { from: string; to: string }[] {
  const nameOf = (ref: string): string => ref.split('@')[0]?.trim() ?? '';
  const providers = ids.filter((id) =>
    (pluginOf(id)?.provides ?? []).some((ref) => POOL_SHAPED_CAPABILITIES.has(nameOf(ref))),
  );
  const edges: { from: string; to: string }[] = [];
  for (const id of ids) {
    const plugin = pluginOf(id);
    if (!plugin || !ownsItsDatabase(plugin) || plugin.permissions_summary?.sql === undefined) continue;
    for (const provider of providers) {
      if (provider !== id) edges.push({ from: provider, to: id });
    }
  }
  return edges;
}

/** Advisory-lock namespace of the setup transaction (core migrators: 4410,
 *  plugin migrations: 4420). */
export const ARCHETYPE_DATABASE_LOCK_NS = 4_421;
const SETUP_LOCK_WAIT_MS = 5_000;
/** `CREATE ROLE` semantics this module relies on (the creator may grant the
 *  role to itself with `SET`) exist from Postgres 16 on. */
const MIN_SERVER_VERSION_NUM = 160_000;
const DEFAULT_RUNTIME_POOL_MAX = 4;
const MAX_IDENTIFIER_LENGTH = 63;
const INVALID_PASSWORD_SQLSTATE = '28P01';
const INSUFFICIENT_PRIVILEGE_SQLSTATE = '42501';

export type ArchetypeDatabaseErrorCode =
  | 'no_database'
  | 'postgres_too_old'
  | 'cannot_create_roles'
  | 'not_isolated'
  | 'login_failed';

/** Thrown when the plugin's database cannot be set up or is not limited to
 *  its schema. The activation fails; the plugin never runs with more. */
export class ArchetypeDatabaseError extends Error {
  public readonly code: ArchetypeDatabaseErrorCode;
  public readonly pluginId: string;
  constructor(
    pluginId: string,
    code: ArchetypeDatabaseErrorCode,
    why: string,
    options?: { cause?: unknown },
  ) {
    super(`archetype plugin '${pluginId}': database not available (${code}): ${why}`, options);
    this.name = 'ArchetypeDatabaseError';
    this.code = code;
    this.pluginId = pluginId;
  }
}

export interface ArchetypeDatabaseNames {
  readonly schema: string;
  readonly runtimeRole: string;
  readonly migrationRole: string;
  /** Tables of the plugin carry this prefix, in `public` before the move and
   *  in the schema after it. */
  readonly tablePrefix: string;
}

/** Every name is derived from the kernel-known plugin id, never from the
 *  manifest. All of them are lowercase `[a-z0-9_]`. */
export function archetypeDatabaseNames(pluginId: string): ArchetypeDatabaseNames {
  const folded = sanitizedPluginPrefix(pluginId);
  return {
    schema: fitIdentifier(`${PLUGIN_LEDGER_NAMESPACE}${folded}`, ''),
    runtimeRole: fitIdentifier(`omadia_plg_${folded}`, '_rt'),
    migrationRole: fitIdentifier(`omadia_plg_${folded}`, '_mig'),
    tablePrefix: `${PLUGIN_LEDGER_NAMESPACE}${folded}_`,
  };
}

/** `stem + suffix` when it fits Postgres' identifier limit; otherwise the stem
 *  is cut and a digest of the whole stem keeps two long ids apart. */
function fitIdentifier(stem: string, suffix: string): string {
  if (stem.length + suffix.length <= MAX_IDENTIFIER_LENGTH) return `${stem}${suffix}`;
  const digest = createHmac('sha256', 'omadia-identifier').update(stem).digest('hex').slice(0, 8);
  const room = MAX_IDENTIFIER_LENGTH - suffix.length - digest.length - 1;
  return `${stem.slice(0, room)}_${digest}${suffix}`;
}

/** Plugin-facing half: what `ctx.sql` adds for an archetype plugin. */
export type ArchetypeSql = Required<Pick<SqlAccessor, 'schema' | 'query' | 'transaction'>>;

export interface ArchetypeDatabaseHandle extends ArchetypeDatabaseNames {
  readonly sql: ArchetypeSql;
  /** What THIS call moved out of `public` (empty on every later one): table
   *  names as they are, other objects with their kind (`function f()`). */
  readonly moved: readonly string[];
  /** Run `work` with a pool that is logged in as the migration role. The pool
   *  is closed afterwards; migrations are the only thing it is for. */
  withMigrationPool<T>(work: (pool: Pool) => Promise<T>): Promise<T>;
}

export interface ArchetypeDatabaseDeps {
  /** The kernel's own pool, resolved per call (it is published late in boot). */
  readonly adminPool: () => Pool | undefined;
  /** The kernel's connection string. The plugin roles connect to the same
   *  address with their own user and password. */
  readonly connectionString: string | undefined;
  /** Kernel secret the role passwords are derived from. Never stored, never
   *  logged; the same on every replica, so two replicas agree on a password. */
  readonly secret: Buffer;
  readonly poolOptions?: Pick<PoolConfig, 'Client' | 'connectionTimeoutMillis'>;
  readonly runtimePoolMax?: number;
  readonly log?: (msg: string) => void;
}

export interface ArchetypeDatabase {
  /** Create what is missing, move the plugin's tables out of `public` once,
   *  verify the roles reach nothing else, and open the runtime pool. */
  ensure(pluginId: string): Promise<ArchetypeDatabaseHandle>;
  /** Close the plugin's runtime pool. Schema, tables and roles stay. */
  release(pluginId: string): Promise<void>;
  closeAll(): Promise<void>;
}

const q = (identifier: string): string => `"${identifier.replace(/"/g, '""')}"`;

export function createArchetypeDatabase(deps: ArchetypeDatabaseDeps): ArchetypeDatabase {
  const log = deps.log ?? (() => undefined);
  const runtimePools = new Map<string, Pool>();

  const passwordOf = (role: string): string =>
    `A1-${createHmac('sha256', deps.secret).update(`omadia:archetype-db:v1:${role}`).digest('base64url')}`;

  const connectionStringOf = (pluginId: string, role: string): string => {
    let url: URL;
    try {
      url = new URL(deps.connectionString ?? '');
    } catch (err) {
      throw new ArchetypeDatabaseError(
        pluginId,
        'no_database',
        'the kernel has no database address in URL form (DATABASE_URL)',
        { cause: err },
      );
    }
    url.username = role;
    url.password = passwordOf(role);
    return url.toString();
  };

  const openPool = (pluginId: string, role: string, max: number): Pool => {
    const pool = new Pool({
      connectionString: connectionStringOf(pluginId, role),
      max,
      ...deps.poolOptions,
    });
    // An idle client that errors must not take the process down.
    pool.on('error', (err) => {
      log(`[archetype-db] ${pluginId}: idle connection of ${role} failed: ${err.message}`);
    });
    return pool;
  };

  /** Prove the role can log in. A refused password means the kernel secret
   *  changed since the role was created: set the derived one and try again. */
  const verifyLogin = async (pluginId: string, admin: Pool, pool: Pool, role: string): Promise<void> => {
    const probe = async (): Promise<string> => {
      const res = await pool.query<{ cu: string }>('SELECT current_user AS cu');
      return res.rows[0]?.cu ?? '';
    };
    let user: string;
    try {
      user = await probe();
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code !== INVALID_PASSWORD_SQLSTATE) {
        throw new ArchetypeDatabaseError(pluginId, 'login_failed', `role ${role} cannot connect: ${messageOf(err)}`, { cause: err });
      }
      log(`[archetype-db] ${pluginId}: password of ${role} refused, setting the derived one again`);
      await admin.query(`ALTER ROLE ${q(role)} PASSWORD '${passwordOf(role)}'`);
      try {
        user = await probe();
      } catch (again) {
        throw new ArchetypeDatabaseError(pluginId, 'login_failed', `role ${role} cannot connect after its password was reset: ${messageOf(again)}`, { cause: again });
      }
    }
    if (user !== role) {
      throw new ArchetypeDatabaseError(pluginId, 'login_failed', `connected as '${user}', expected '${role}'`);
    }
  };

  return {
    async ensure(pluginId) {
      const admin = deps.adminPool();
      if (!admin) {
        throw new ArchetypeDatabaseError(pluginId, 'no_database', 'the kernel runs without a database');
      }
      const names = archetypeDatabaseNames(pluginId);
      const moved = await setUp(admin, pluginId, names, passwordOf, log);

      await runtimePools.get(pluginId)?.end().catch(() => undefined);
      runtimePools.delete(pluginId);
      const runtime = openPool(pluginId, names.runtimeRole, deps.runtimePoolMax ?? DEFAULT_RUNTIME_POOL_MAX);
      try {
        await verifyLogin(pluginId, admin, runtime, names.runtimeRole);
      } catch (err) {
        await runtime.end().catch(() => undefined);
        throw err;
      }
      runtimePools.set(pluginId, runtime);

      return {
        ...names,
        moved,
        sql: scopedSql(runtime, names.schema),
        async withMigrationPool(work) {
          const pool = openPool(pluginId, names.migrationRole, 1);
          try {
            await verifyLogin(pluginId, admin, pool, names.migrationRole);
            return await work(pool);
          } finally {
            await pool.end().catch(() => undefined);
          }
        },
      };
    },

    async release(pluginId) {
      const pool = runtimePools.get(pluginId);
      runtimePools.delete(pluginId);
      await pool?.end().catch(() => undefined);
    },

    async closeAll() {
      const pools = [...runtimePools.values()];
      runtimePools.clear();
      await Promise.all(pools.map((p) => p.end().catch(() => undefined)));
    },
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The two methods a plugin reaches its schema through. Neither hands out a
 * client: a held client is a held server session only without a pooler, and
 * code written against that assumption breaks behind one.
 */
export function scopedSql(pool: Pool, schema: string): ArchetypeSql {
  const result = <R extends Record<string, unknown>>(res: {
    rows: R[];
    rowCount: number | null;
  }): SqlStatementResult<R> => ({ rows: res.rows, rowCount: res.rowCount ?? 0 });

  return {
    schema,
    async query<R extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      params?: readonly unknown[],
    ): Promise<SqlStatementResult<R>> {
      return result(await pool.query<R>(text, params ? [...params] : undefined));
    },
    async transaction<T>(work: (tx: SqlTransaction) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      let open = true;
      const tx: SqlTransaction = {
        async query<R extends Record<string, unknown> = Record<string, unknown>>(
          text: string,
          params?: readonly unknown[],
        ): Promise<SqlStatementResult<R>> {
          if (!open) {
            throw new Error('this transaction has ended; a statement sent after its callback settled is refused');
          }
          return result(await client.query<R>(text, params ? [...params] : undefined));
        },
      };
      try {
        await client.query('BEGIN');
        // Defence in depth for a server session that predates the role's
        // `search_path` (see the file header). Reverts at COMMIT / ROLLBACK.
        await client.query(`SET LOCAL search_path = ${q(schema)}`);
        const value = await work(tx);
        open = false;
        await client.query('COMMIT');
        return value;
      } catch (err) {
        open = false;
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        open = false;
        client.release();
      }
    },
  };
}

/** One transaction on the kernel's pool, under an advisory lock, so two
 *  replicas that activate the plugin together do not both create the roles. */
async function setUp(
  admin: Pool,
  pluginId: string,
  names: ArchetypeDatabaseNames,
  passwordOf: (role: string) => string,
  log: (msg: string) => void,
): Promise<string[]> {
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    try {
      await client.query(`SET LOCAL lock_timeout = '${String(SETUP_LOCK_WAIT_MS)}ms'`);
      await client.query('SELECT pg_advisory_xact_lock($1::int, hashtext($2)::int)', [
        ARCHETYPE_DATABASE_LOCK_NS,
        names.schema,
      ]);
      await assertServerVersion(client, pluginId);
      for (const role of [names.migrationRole, names.runtimeRole]) {
        await ensureRole(client, pluginId, role, names.schema, passwordOf(role), log);
      }
      // The kernel must be able to act as the migration role to hand it the
      // schema and the moved tables. The reverse membership never exists.
      await client.query(`GRANT ${q(names.migrationRole)} TO CURRENT_USER WITH SET TRUE, INHERIT FALSE`);
      await ensureSchema(client, names);
      const moved = await moveOwnObjects(client, pluginId, names);
      await grantRuntime(client, names, moved.tables);
      await assertIsolated(client, pluginId, names);
      await client.query('COMMIT');
      if (moved.all.length > 0) {
        log(`[archetype-db] ${pluginId}: moved ${String(moved.all.length)} object(s) from public to ${names.schema}: ${moved.all.join(', ')}`);
      }
      return moved.all;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (err instanceof ArchetypeDatabaseError) throw err;
      if ((err as { code?: unknown } | null)?.code === INSUFFICIENT_PRIVILEGE_SQLSTATE) {
        throw new ArchetypeDatabaseError(
          pluginId,
          'cannot_create_roles',
          `the kernel's database user may not create roles or schemas (${messageOf(err)}). ` +
            'A database administrator runs once: ALTER ROLE <the kernel\'s user> CREATEROLE; ' +
            'GRANT CREATE ON DATABASE <the database> TO <the kernel\'s user>;',
          { cause: err },
        );
      }
      throw err;
    }
  } finally {
    client.release();
  }
}

async function assertServerVersion(client: PoolClient, pluginId: string): Promise<void> {
  const res = await client.query<{ v: number }>(
    "SELECT current_setting('server_version_num')::int AS v",
  );
  const version = res.rows[0]?.v ?? 0;
  if (version < MIN_SERVER_VERSION_NUM) {
    throw new ArchetypeDatabaseError(
      pluginId,
      'postgres_too_old',
      `archetype plugins need Postgres 16 or newer, this server reports ${String(version)}`,
    );
  }
}

async function ensureRole(
  client: PoolClient,
  pluginId: string,
  role: string,
  schema: string,
  password: string,
  log: (msg: string) => void,
): Promise<void> {
  const existing = await client.query<{ rolconfig: string[] | null }>(
    'SELECT rolconfig FROM pg_roles WHERE rolname = $1',
    [role],
  );
  const wanted = `search_path=${schema}`;
  if (existing.rowCount === 0) {
    // The password is derived from 256 bits and base64url, so it holds no
    // quote; DDL takes no bind parameters.
    await client.query(
      `CREATE ROLE ${q(role)} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
    );
    // Same transaction as the CREATE: no session of this role exists yet.
    await client.query(`ALTER ROLE ${q(role)} SET search_path = ${q(schema)}`);
    log(`[archetype-db] ${pluginId}: created role ${role}`);
    return;
  }
  const config = existing.rows[0]?.rolconfig ?? [];
  if (!config.some((entry) => entry === wanted || entry === `search_path="${schema}"`)) {
    await client.query(`ALTER ROLE ${q(role)} SET search_path = ${q(schema)}`);
    log(
      `[archetype-db] ${pluginId}: role ${role} existed without its search_path; set now. Server sessions a pooler already holds keep the old value until they are recycled; kernel-opened transactions set it themselves.`,
    );
  }
}

async function ensureSchema(client: PoolClient, names: ArchetypeDatabaseNames): Promise<void> {
  const owner = await client.query<{ owner: string }>(
    'SELECT r.rolname AS owner FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner WHERE n.nspname = $1',
    [names.schema],
  );
  if (owner.rowCount === 0) {
    await client.query(`CREATE SCHEMA ${q(names.schema)} AUTHORIZATION ${q(names.migrationRole)}`);
  } else if (owner.rows[0]?.owner !== names.migrationRole) {
    await client.query(`ALTER SCHEMA ${q(names.schema)} OWNER TO ${q(names.migrationRole)}`);
  }
  // The kernel's membership in the migration role is without INHERIT, so it
  // holds none of that role's rights by itself. To move a table in, the
  // kernel's own user needs CREATE on the schema; the owner grants it.
  const self = await client.query<{ cu: string }>('SELECT current_user AS cu');
  const kernelUser = self.rows[0]?.cu ?? '';
  await client.query(`SET LOCAL ROLE ${q(names.migrationRole)}`);
  await client.query(`GRANT USAGE, CREATE ON SCHEMA ${q(names.schema)} TO ${q(kernelUser)}`);
  await client.query(`GRANT USAGE ON SCHEMA ${q(names.schema)} TO ${q(names.runtimeRole)}`);
  await client.query('RESET ROLE');
}

/**
 * The one-time move. What the plugin created in `public` while it still ran
 * on the shared pool carries its reserved prefix (`plg_<plugin id>_`, a
 * namespace no kernel object can be in). All of it moves into the schema and
 * to the migration role, before the plugin's migrations run: types, free
 * sequences, tables (their indexes, constraints, triggers and owned sequences
 * travel with them), views, and functions. A trigger function left behind in
 * `public` would stay owned by the kernel's user, out of reach of the
 * plugin's own migrations. Rows are not touched.
 */
async function moveOwnObjects(
  client: PoolClient,
  pluginId: string,
  names: ArchetypeDatabaseNames,
): Promise<{ tables: string[]; all: string[] }> {
  const prefix = [names.tablePrefix, names.tablePrefix.length];
  const foreign = await longerPrefixesOfOtherPlugins(client, pluginId, names.tablePrefix);
  // `plg_acme_arch_` is also how the objects of `@acme/arch-x` begin. One
  // under another plugin's longer prefix is that plugin's.
  const own = <T extends { name: string }>(rows: T[]): T[] =>
    rows.filter((row) => !foreign.some((other) => row.name.startsWith(other)));
  const schema = q(names.schema);
  const owner = q(names.migrationRole);
  const all: string[] = [];
  const move = async (keyword: string, from: string, to: string, label: string): Promise<void> => {
    await client.query(`ALTER ${keyword} ${from} SET SCHEMA ${schema}`);
    await client.query(`ALTER ${keyword} ${to} OWNER TO ${owner}`);
    all.push(label);
  };

  // Stand-alone types: enums, domains, ranges and declared composites. The
  // row type of a table and array types follow their base object.
  const types = await client.query<{ name: string; typtype: string }>(
    `SELECT t.typname AS name, t.typtype FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public' AND left(t.typname, $2) = $1
        AND (t.typtype IN ('e', 'd', 'r')
             OR (t.typtype = 'c' AND (SELECT c.relkind FROM pg_class c WHERE c.oid = t.typrelid) = 'c'))
      ORDER BY 1`,
    prefix,
  );
  for (const { name, typtype } of own(types.rows)) {
    const keyword = typtype === 'd' ? 'DOMAIN' : 'TYPE';
    await move(keyword, `public.${q(name)}`, `${schema}.${q(name)}`, `type ${name}`);
  }

  const relations = await client.query<{ name: string; relkind: string }>(
    `SELECT c.relname AS name, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND left(c.relname, $2) = $1 AND NOT c.relispartition
        AND (c.relkind IN ('r', 'p', 'v', 'm')
             OR (c.relkind = 'S' AND NOT EXISTS (
                   SELECT 1 FROM pg_depend d
                    WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype IN ('a', 'i'))))
      ORDER BY CASE c.relkind WHEN 'S' THEN 0 WHEN 'r' THEN 1 WHEN 'p' THEN 1 ELSE 2 END, c.relname`,
    prefix,
  );
  const tables: string[] = [];
  const KEYWORD: Record<string, string> = { r: 'TABLE', p: 'TABLE', v: 'VIEW', m: 'MATERIALIZED VIEW', S: 'SEQUENCE' };
  for (const { name, relkind } of own(relations.rows)) {
    const keyword = KEYWORD[relkind] ?? 'TABLE';
    await move(keyword, `public.${q(name)}`, `${schema}.${q(name)}`, relkind === 'r' || relkind === 'p' ? name : `${keyword.toLowerCase()} ${name}`);
    if (relkind !== 'S') tables.push(name);
  }

  const routines = await client.query<{ name: string; args: string; prokind: string }>(
    `SELECT p.proname AS name, pg_get_function_identity_arguments(p.oid) AS args, p.prokind
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND left(p.proname, $2) = $1
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
      ORDER BY 1, 2`,
    prefix,
  );
  for (const { name, args, prokind } of own(routines.rows)) {
    const keyword = prokind === 'a' ? 'AGGREGATE' : 'ROUTINE';
    await move(keyword, `public.${q(name)}(${args})`, `${schema}.${q(name)}(${args})`, `function ${name}(${args})`);
  }
  return { tables, all };
}

/** Table prefixes of other plugins with a database grant that start with this
 *  plugin's prefix. No grant table (a database the kernel never migrated): none. */
async function longerPrefixesOfOtherPlugins(
  client: PoolClient,
  pluginId: string,
  ownPrefix: string,
): Promise<string[]> {
  const table = await client.query<{ present: boolean }>(
    "SELECT to_regclass('public.plugin_sql_grants') IS NOT NULL AS present",
  );
  if (table.rows[0]?.present !== true) return [];
  const others = await client.query<{ plugin_id: string }>(
    'SELECT plugin_id FROM public.plugin_sql_grants WHERE plugin_id <> $1',
    [pluginId],
  );
  return others.rows
    .map((row) => archetypeDatabaseNames(row.plugin_id).tablePrefix)
    .filter((prefix) => prefix !== ownPrefix && prefix.startsWith(ownPrefix));
}

/** Runtime rights, given AS the migration role (the owner): on everything it
 *  creates from now on, and on the tables that were just moved in. */
async function grantRuntime(
  client: PoolClient,
  names: ArchetypeDatabaseNames,
  moved: readonly string[],
): Promise<void> {
  const schema = q(names.schema);
  const runtime = q(names.runtimeRole);
  await client.query(`SET LOCAL ROLE ${q(names.migrationRole)}`);
  await client.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${runtime}`,
  );
  await client.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT USAGE, SELECT ON SEQUENCES TO ${runtime}`,
  );
  for (const table of moved) {
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${schema}.${q(table)} TO ${runtime}`,
    );
  }
  await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${runtime}`);
  await client.query('RESET ROLE');
}

/** The statement that takes the create right in a schema away again, from
 *  every role or from the one that holds it by name. Named in the error so the operator can run it as it stands. */
export function revokeCreateStatement(schema: string, role?: string): string {
  // Every role has it through PUBLIC, or this role was granted it by name.
  return `REVOKE CREATE ON SCHEMA ${q(schema)} FROM ${role ? q(role) : 'PUBLIC'}`;
}

/**
 * Fail closed: both roles must be plain (no attribute, member of no role) and
 * must hold no right on any table or view outside the plugin's schema, nor the
 * right to create objects in another schema. USAGE on `public`, which every
 * role has by default, is tolerated: it cannot be revoked for one role, and
 * without a table right it reads nothing.
 * Relations an extension installed (a statistics view readable by everyone)
 * are not the instance's data and are left out.
 */
async function assertIsolated(
  client: PoolClient,
  pluginId: string,
  names: ArchetypeDatabaseNames,
): Promise<void> {
  for (const role of [names.runtimeRole, names.migrationRole]) {
    const attrs = await client.query<{ elevated: boolean; memberships: number }>(
      `SELECT (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolbypassrls OR r.rolreplication) AS elevated,
              (SELECT count(*)::int FROM pg_auth_members m WHERE m.member = r.oid) AS memberships
         FROM pg_roles r WHERE r.rolname = $1`,
      [role],
    );
    const row = attrs.rows[0];
    if (!row || row.elevated || row.memberships > 0) {
      throw new ArchetypeDatabaseError(
        pluginId,
        'not_isolated',
        `role ${role} ${!row ? 'is missing' : row.elevated ? 'carries an elevated attribute' : 'is a member of another role'}`,
      );
    }
    // A role may hold USAGE on `public` through the grant every role has by
    // default; that alone reads no data (no table right, checked below). What
    // it must not have is CREATE in a schema other than its own: an object
    // planted in `public` is one the kernel's own search path would resolve.
    // Databases created before PostgreSQL 15 still grant that to every role.
    const writable = await client.query<{ nspname: string; from_public: boolean }>(
      `SELECT n.nspname, has_schema_privilege('public', n.oid, 'CREATE') AS from_public
         FROM pg_namespace n
        WHERE n.nspname <> $2 AND n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
          AND has_schema_privilege($1, n.oid, 'CREATE')
        ORDER BY 1 LIMIT 5`,
      [role, names.schema],
    );
    const schemas = writable.rows.map((r) => r.nspname);
    if (schemas.length > 0) {
      throw new ArchetypeDatabaseError(
        pluginId,
        'not_isolated',
        `role ${role} may create objects outside ${names.schema}, in schema ${schemas.join(', ')}. Fix, as the database owner: ${writable.rows
          .map((r) => revokeCreateStatement(r.nspname, r.from_public ? undefined : role))
          .join('; ')}; then restart omadia`,
      );
    }
    const reach = await client.query<{ rel: string }>(
      `SELECT n.nspname || '.' || c.relname AS rel
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND n.nspname <> $2 AND n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
          AND has_table_privilege($1, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
        ORDER BY 1 LIMIT 5`,
      [role, names.schema],
    );
    if ((reach.rowCount ?? 0) > 0) {
      throw new ArchetypeDatabaseError(
        pluginId,
        'not_isolated',
        `role ${role} holds rights outside ${names.schema}: ${reach.rows.map((r) => r.rel).join(', ')}`,
      );
    }
  }
}
