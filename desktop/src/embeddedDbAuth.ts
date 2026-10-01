import crypto from 'node:crypto';
import { transferOwnershipSql } from './embeddedDbOwnership';
import type { DbEndpoint } from './embeddedDbEndpoint';
import { isScramRefusal } from './scramOnlyConnect';
import type { EmbeddedDbCredentials } from './secretsBlob';

/**
 * Who may log in to the embedded Postgres, and how the shell gets a cluster
 * there from whatever state it finds it in.
 *
 * Two roles, both with random SCRAM passwords kept in `secrets.enc`:
 *   - `omadia`, the bootstrap superuser. Only the shell uses it (provisioning,
 *     extensions); its password never leaves the shell process.
 *   - `omadia_kernel`, what the kernel connects as. It owns the `omadia`
 *     database and everything in it, so the kernel's own migrations work, but
 *     it is not a superuser: no `COPY ... TO PROGRAM`, no server file access,
 *     no roles, no databases.
 *
 * pg_hba.conf belongs to the shell and is only ever written while the server
 * is stopped, so the running server never holds rules the shell did not
 * write: every rule asks for a SCRAM password, whichever local process or OS
 * user is asking. The server starts with `hba_file` pinned to that file.
 *
 * The shell believes a server only after it has proven itself. Every shell
 * connection authenticates with SCRAM and nothing else (the IO's `connect`,
 * `scramOnlyConnect.ts`), which sends no password and has the server prove it
 * holds the verifier. The first connection after every start is the bootstrap
 * role's, and it must also report this cluster's data directory; only then
 * does a kernel password go anywhere. Before provisioning and before the
 * verification, the IO confirms that the server it started still runs and
 * still holds the endpoint (`confirmServing`).
 *
 * The shell's own sessions treat the kernel-owned database as hostile. Every
 * connection pins `search_path = pg_catalog, pg_temp` as a startup option
 * (`embeddedDb.ts`), which outranks any `ALTER DATABASE`/`ALTER ROLE ... SET`
 * the database owner left behind, and the ownership transfer schema-qualifies
 * its calls (`embeddedDbOwnership.ts`), so a superuser statement the shell runs
 * there cannot be redirected to a function the kernel planted. Verification is
 * the backstop: the kernel role must not only lack the privileged attributes
 * but hold no role memberships either, since a membership (in a predefined role
 * such as pg_execute_server_program) restores a capability without setting one.
 *
 * `ensureClusterAuth` is driven by the state of the cluster, never by a flag,
 * so a restored snapshot or a regenerated `secrets.enc` repairs itself:
 *   - steady state: the shell's pg_hba.conf, a shell login that finds this
 *     cluster and a kernel login that works. Only the verification runs.
 *   - trust era (clusters initialised with `-A trust` before this module
 *     existed): before the server starts, the bootstrap password is set in
 *     single-user mode, THEN pg_hba.conf asks for passwords. The other order
 *     would lock the shell out of its own cluster.
 *   - passwords the cluster no longer accepts (lost `secrets.enc`, a snapshot
 *     restored without its secrets): the server is stopped, the password is
 *     set in single-user mode, and the server starts again. Single-user mode
 *     (`postgres --single`) has no listener and no pg_hba.conf, so the repair
 *     never lets anyone in without a password, not even for a moment.
 *
 * Provisioning sets the kernel's password last, so a run that fails half way
 * leaves a kernel that cannot log in, and the next start provisions again
 * instead of mistaking the half-finished cluster for a finished one.
 *
 * Electron-free behind the `DbAuthIo` port (the `dbSnapshot.ts` pattern): the
 * orderings above are the whole point, and an ordering that lives only in a
 * comment is not held.
 */

export const DB_SUPERUSER = 'omadia';
export const DB_KERNEL_ROLE = 'omadia_kernel';
export const DB_NAME = 'omadia';
/** The maintenance database the superuser connects to. */
const ADMIN_DATABASE = 'postgres';

/** SQLSTATEs the state machine tells apart. */
const INVALID_PASSWORD = '28P01';
const INVALID_AUTHORIZATION = '28000';

/** The extensions the kernel's migrations create. pgvector is untrusted: only a superuser may. */
const EXTENSIONS = ['vector', 'pg_trgm'] as const;

/** The kernel role's attributes; INHERIT so PG15+'s implicit pg_database_owner grants CREATE on `public`. */
const KERNEL_ROLE_ATTRIBUTES = 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS';

/** What a SCRAM verifier consists of: safe inside a SQL literal and on a single line. */
const VERIFIER_CHARACTERS = /^[A-Za-z0-9+/=$:-]+$/;

const HBA_RULES = [
  '# Written by the omadia desktop shell (desktop/src/embeddedDbAuth.ts) while the',
  '# server is stopped; local edits are replaced. Every rule requires a SCRAM password.',
  '# TYPE  DATABASE  USER                  ADDRESS        METHOD',
  `local   all       ${DB_SUPERUSER},${DB_KERNEL_ROLE}                  scram-sha-256`,
  `host    all       ${DB_SUPERUSER},${DB_KERNEL_ROLE}  127.0.0.1/32   scram-sha-256`,
  `host    all       ${DB_SUPERUSER},${DB_KERNEL_ROLE}  ::1/128        scram-sha-256`,
  '',
].join('\n');

/** The shell's pg_hba.conf: password-only rules for its two roles, nothing else. */
export function renderHba(): string {
  return HBA_RULES;
}

export type HbaMode = 'scram' | 'trust' | 'unknown';

/**
 * What a pg_hba.conf lets through, judged by its rules alone: initdb's own
 * file carries a comment block that mentions "trust" and "scram-sha-256" in
 * prose, which a substring test would misread.
 */
export function hbaMode(content: string | null): HbaMode {
  const rules = (content ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => line.split(/\s+/));
  if (rules.length === 0) return 'unknown';
  if (rules.some((tokens) => tokens.includes('trust'))) return 'trust';
  return rules.every((tokens) => tokens.includes('scram-sha-256')) ? 'scram' : 'unknown';
}

/**
 * The DSN the kernel gets: the restricted role, at the server's endpoint. A
 * socket directory goes in percent-encoded as the host, the form libpq and
 * pg-connection-string both read as a Unix socket.
 */
export function kernelDatabaseUrl(endpoint: Pick<DbEndpoint, 'host' | 'port'>, password: string): string {
  return (
    `postgresql://${DB_KERNEL_ROLE}:${encodeURIComponent(password)}` +
    `@${encodeURIComponent(endpoint.host)}:${endpoint.port}/${DB_NAME}`
  );
}

/**
 * A SCRAM-SHA-256 verifier in Postgres' stored format (what libpq's
 * PQencryptPasswordConn produces), so `ALTER ROLE ... PASSWORD` never carries
 * the password itself: a failing statement lands in the server log, and the
 * server log lands in the desktop log. Postgres SASLprep-normalises passwords
 * first, which is the identity for the ASCII passwords `secrets.ts` generates.
 */
export function scramVerifier(password: string, salt = crypto.randomBytes(16), iterations = 4096): string {
  const salted = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = crypto.createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = crypto.createHash('sha256').update(clientKey).digest();
  const serverKey = crypto.createHmac('sha256', salted).update('Server Key').digest();
  return (
    `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}` +
    `$${storedKey.toString('base64')}:${serverKey.toString('base64')}`
  );
}

/**
 * `ALTER ROLE <role> WITH PASSWORD '<verifier>'` on one line, built without a
 * connection because single-user mode has none; the verifier's alphabet is
 * checked so nothing can break out of the literal or the line.
 */
export function passwordStatement(role: string, password: string): string {
  const verifier = scramVerifier(password);
  if (!VERIFIER_CHARACTERS.test(verifier)) throw new Error('[db] unexpected characters in a SCRAM verifier');
  return `ALTER ROLE ${role} WITH PASSWORD '${verifier}'`;
}

/** The SQLSTATE pg attaches to a server error, if any. */
export function sqlState(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** The server answered with an authentication verdict (wrong password, or no matching rule). */
export function isAuthFailure(err: unknown): boolean {
  const code = sqlState(err);
  return code === INVALID_PASSWORD || code === INVALID_AUTHORIZATION;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message || err.name : String(err);
}

export interface QueryResult {
  readonly rows: ReadonlyArray<Record<string, unknown>>;
}

export interface AuthClient {
  query(sql: string, params?: readonly unknown[]): Promise<QueryResult>;
  end(): Promise<void>;
}

export interface ConnectOptions {
  readonly user: string;
  readonly password: string;
  readonly database: string;
}

export interface DbAuthIo {
  /** pg_hba.conf as it is on disk; null when it cannot be found. */
  readHba(): string | null;
  /** Replace pg_hba.conf atomically. Only called while the server is stopped. */
  writeHba(text: string): Promise<void>;
  /**
   * Run one statement in single-user mode (`postgres --single`): no listener,
   * no pg_hba.conf, the bootstrap superuser. The server must be stopped.
   */
  runSingleUser(statement: string): Promise<void>;
  /**
   * Start the server; resolves once the server's own postmaster.pid shows the
   * process just started serving the expected endpoint. Sends no credentials.
   */
  startServer(): Promise<void>;
  /** Stop the server; resolves once it has exited. */
  stopServer(): Promise<void>;
  /** Rejects unless the server this IO started still runs and still holds its endpoint. */
  confirmServing(): Promise<void>;
  /** Whether a `data_directory` the server reports is this cluster's. */
  isClusterDirectory(reported: string): boolean;
  /**
   * A connection that authenticates with SCRAM-SHA-256 only; rejects with
   * pg's error (SQLSTATE in `code`) or, when the server asks for anything
   * else, before any password is sent, with `scramOnlyConnect`'s refusal.
   */
  connect(options: ConnectOptions): Promise<AuthClient>;
  info(message: string): void;
  warn(message: string): void;
}

/**
 * Start the cluster in the two-role, password-only state and verify it.
 * Called with the server stopped: pg_hba.conf and the bootstrap password are
 * put in order first, and only then does `io.startServer()` let the server
 * listen. Rejects rather than let a DSN be handed out while the verification
 * fails: the server must prove it is this cluster, a wrong password must be
 * refused, and the kernel role must not be privileged.
 */
export async function ensureClusterAuth(io: DbAuthIo, creds: EmbeddedDbCredentials): Promise<void> {
  await adoptShellHba(io, creds);
  await io.startServer();
  await ensureShellLogin(io, creds);
  if (!(await kernelRoleIsCurrent(io, creds))) {
    await io.confirmServing();
    await provisionKernelRole(io, creds);
  }
  await verifyClusterAuth(io, creds);
}

/**
 * With the server stopped, make pg_hba.conf the shell's. Rules that did not ask
 * for a password (trust era, or rules this shell did not write) may have let
 * the shell in without checking one, so the bootstrap password is set first,
 * in single-user mode, and only then are the password-only rules written. If
 * setting it fails, the old rules stay and the start fails; nothing is locked
 * out.
 */
async function adoptShellHba(io: DbAuthIo, creds: EmbeddedDbCredentials): Promise<void> {
  const hba = io.readHba();
  if (hba === renderHba()) return;
  const mode = hbaMode(hba);
  if (mode !== 'scram') {
    io.warn(
      mode === 'trust'
        ? '[db] migrating a trust-authenticated cluster to SCRAM passwords before it starts'
        : '[db] replacing a pg_hba.conf this shell did not write before the server starts',
    );
    await io.runSingleUser(passwordStatement(DB_SUPERUSER, creds.superuserPassword));
  }
  await io.writeHba(renderHba());
  io.info('[db] pg_hba.conf requires a SCRAM password for every connection');
}

/**
 * The kernel logs in with the stored password and is still a restricted role.
 * Asked only after the shell's own login proved the server is this cluster.
 */
async function kernelRoleIsCurrent(io: DbAuthIo, creds: EmbeddedDbCredentials): Promise<boolean> {
  let kernel: AuthClient;
  try {
    kernel = await io.connect({ user: DB_KERNEL_ROLE, password: creds.kernelPassword, database: DB_NAME });
  } catch (err) {
    if (isScramRefusal(err)) throw err;
    io.info(`[db] the kernel role cannot log in yet (${errorText(err)}); provisioning`);
    return false;
  }
  try {
    const problem = privilegeProblem(await roleAttributes(kernel));
    if (problem !== null) io.warn(`[db] ${problem}; provisioning it again`);
    return problem === null;
  } finally {
    await kernel.end();
  }
}

/**
 * The readiness that counts: an authenticated round-trip as the bootstrap role
 * (SCRAM, so the server proved it holds the verifier) to a server that reports
 * this cluster's data directory. When the server refuses the stored password,
 * it is stopped and the password set in single-user mode, which accepts no
 * connection at all meanwhile; after the restart the login must succeed. An
 * authentication error is never taken as "ready".
 */
async function ensureShellLogin(io: DbAuthIo, creds: EmbeddedDbCredentials): Promise<void> {
  if (await shellLoginWorks(io, creds)) return;
  io.warn(
    '[db] the stored database password was refused; setting it again with the server stopped ' +
      '(single-user mode, no connections accepted meanwhile)',
  );
  await io.stopServer();
  await io.runSingleUser(passwordStatement(DB_SUPERUSER, creds.superuserPassword));
  await io.startServer();
  if (!(await shellLoginWorks(io, creds))) {
    throw new Error('[db] the embedded Postgres still refuses the stored password after resetting it');
  }
  io.warn('[db] database password re-provisioned');
}

/**
 * Whether the server accepts the stored bootstrap password. A server that
 * accepts it but reports another data directory is not this cluster, and any
 * failure other than a refused password throws.
 */
async function shellLoginWorks(io: DbAuthIo, creds: EmbeddedDbCredentials): Promise<boolean> {
  let admin: AuthClient;
  try {
    admin = await io.connect({ user: DB_SUPERUSER, password: creds.superuserPassword, database: ADMIN_DATABASE });
  } catch (err) {
    if (isAuthFailure(err)) return false;
    throw err;
  }
  try {
    const result = await admin.query('SHOW data_directory');
    const reported = String(result.rows[0]?.['data_directory'] ?? '');
    if (!io.isClusterDirectory(reported)) {
      throw new Error(
        `[db] refusing to use the embedded Postgres: the server reports the data directory ${JSON.stringify(reported)}, ` +
          'not this cluster',
      );
    }
  } finally {
    await admin.end();
  }
  return true;
}

/**
 * The restricted role, its database, the extensions it cannot create itself,
 * ownership of what a trust-era kernel created as superuser
 * (`embeddedDbOwnership.ts`), and last its password. Idempotent; runs as the
 * bootstrap role with its password.
 */
async function provisionKernelRole(io: DbAuthIo, creds: EmbeddedDbCredentials): Promise<void> {
  const admin = await io.connect({ user: DB_SUPERUSER, password: creds.superuserPassword, database: ADMIN_DATABASE });
  try {
    const role = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [DB_KERNEL_ROLE]);
    await admin.query(
      role.rows.length === 0
        ? `CREATE ROLE ${DB_KERNEL_ROLE} WITH ${KERNEL_ROLE_ATTRIBUTES}`
        : `ALTER ROLE ${DB_KERNEL_ROLE} WITH ${KERNEL_ROLE_ATTRIBUTES}`,
    );
    const database = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [DB_NAME]);
    if (database.rows.length === 0) {
      await admin.query(`CREATE DATABASE ${DB_NAME} OWNER ${DB_KERNEL_ROLE}`);
      io.info(`[db] created database "${DB_NAME}" owned by ${DB_KERNEL_ROLE}`);
    } else {
      await admin.query(`ALTER DATABASE ${DB_NAME} OWNER TO ${DB_KERNEL_ROLE}`);
    }
  } finally {
    await admin.end();
  }

  const inKernelDb = await io.connect({ user: DB_SUPERUSER, password: creds.superuserPassword, database: DB_NAME });
  try {
    for (const extension of EXTENSIONS) {
      await createExtension(io, inKernelDb, extension);
    }
    await inKernelDb.query(transferOwnershipSql(DB_SUPERUSER, DB_KERNEL_ROLE));
    await inKernelDb.query(passwordStatement(DB_KERNEL_ROLE, creds.kernelPassword));
  } finally {
    await inKernelDb.end();
  }
}

/**
 * `CREATE EXTENSION IF NOT EXISTS` as superuser, so the kernel's own
 * statement finds the extension and skips before its privilege check. Pinned
 * to `public`, where the kernel role's search_path finds it, rather than left
 * to the superuser's `"$user"` schema. An engine without the extension's files
 * (a dev tree without pgvector staged) is logged and tolerated: the kernel
 * migration that needs it fails exactly as it would have anyway.
 */
async function createExtension(io: DbAuthIo, client: AuthClient, extension: string): Promise<void> {
  try {
    await client.query(`CREATE EXTENSION IF NOT EXISTS ${extension} SCHEMA public`);
  } catch (err) {
    const detail = `${errorText(err)} ${String((err as { detail?: unknown } | null)?.detail ?? '')}`;
    const unavailable = (sqlState(err) === '0A000' || sqlState(err) === '58P01') && /control file/i.test(detail);
    if (!unavailable) throw err;
    io.warn(`[db] extension "${extension}" is not installed in this Postgres engine (${errorText(err)})`);
  }
}

interface RoleAttributes {
  readonly rolsuper?: unknown;
  readonly rolcreaterole?: unknown;
  readonly rolcreatedb?: unknown;
  readonly rolreplication?: unknown;
  readonly rolbypassrls?: unknown;
}

async function roleAttributes(client: AuthClient): Promise<RoleAttributes | null> {
  const result = await client.query(
    'SELECT rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = current_user',
  );
  return result.rows[0] ?? null;
}

/** What makes the kernel role more than a restricted role, or null. */
function privilegeProblem(attributes: RoleAttributes | null): string | null {
  if (attributes === null) return `the ${DB_KERNEL_ROLE} role is missing from pg_roles`;
  const privileged = Object.entries(attributes)
    .filter(([, value]) => value !== false)
    .map(([name]) => name);
  if (privileged.length === 0) return null;
  const label = privileged.includes('rolsuper') ? 'superuser' : privileged.join(', ');
  return `the ${DB_KERNEL_ROLE} role is privileged (${label})`;
}

/**
 * Roles the kernel role is a member of. It must be a member of none: a
 * membership (for example in a predefined role such as
 * `pg_execute_server_program` or `pg_read_server_files`) restores a capability
 * the restricted role is meant to lack, and it does not show up in the role's
 * own attributes. The catalogs are schema-qualified so the check does not
 * depend on the session's search_path.
 */
async function roleMemberships(client: AuthClient): Promise<string[]> {
  const result = await client.query(
    'SELECT r.rolname AS role FROM pg_catalog.pg_auth_members m ' +
      'JOIN pg_catalog.pg_roles r ON r.oid = m.roleid ' +
      'WHERE m.member = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user) ' +
      'ORDER BY r.rolname',
  );
  return result.rows.map((row) => String(row['role']));
}

/**
 * Fail closed: the running server must refuse a wrong password for both roles,
 * and the kernel role must log in with its password, hold no privileged
 * attribute, and be a member of no role.
 */
async function verifyClusterAuth(io: DbAuthIo, creds: EmbeddedDbCredentials): Promise<void> {
  await io.confirmServing();
  io.info('[db] checking that wrong passwords are refused (the server logs these attempts as FATAL; expected)');
  await expectWrongPasswordRefused(io, DB_KERNEL_ROLE, DB_NAME);
  await expectWrongPasswordRefused(io, DB_SUPERUSER, ADMIN_DATABASE);
  const kernel = await io.connect({ user: DB_KERNEL_ROLE, password: creds.kernelPassword, database: DB_NAME });
  try {
    const problem = privilegeProblem(await roleAttributes(kernel));
    if (problem !== null) throw new Error(`[db] refusing to start the kernel: ${problem}`);
    const memberships = await roleMemberships(kernel);
    if (memberships.length > 0) {
      throw new Error(
        `[db] refusing to start the kernel: the ${DB_KERNEL_ROLE} role is a member of ${memberships.join(', ')} ` +
          '(a role membership can restore a capability the restricted role must not have)',
      );
    }
  } finally {
    await kernel.end();
  }
}

async function expectWrongPasswordRefused(io: DbAuthIo, user: string, database: string): Promise<void> {
  const wrong = crypto.randomBytes(24).toString('hex');
  let outcome: string;
  try {
    const client = await io.connect({ user, password: wrong, database });
    await client.end();
    outcome = 'a wrong password was accepted';
  } catch (err) {
    if (sqlState(err) === INVALID_PASSWORD) return;
    outcome = errorText(err);
  }
  throw new Error(
    `[db] refusing to start the kernel: the embedded Postgres did not refuse a wrong password for "${user}" (${outcome})`,
  );
}
