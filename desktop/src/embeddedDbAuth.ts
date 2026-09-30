import crypto from 'node:crypto';
import { transferOwnershipSql } from './embeddedDbOwnership';
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
 * pg_hba.conf belongs to the shell: it is rewritten to `renderHba('scram')`
 * whenever it differs, and the server is started with `hba_file` pinned to it.
 * Every rule asks for a SCRAM password, so the server's verdict does not
 * depend on which local process or OS user is asking.
 *
 * `ensureClusterAuth` is driven by the state of the cluster, never by a flag,
 * so a restored snapshot or a regenerated `secrets.enc` repairs itself:
 *   - steady state: the shell's pg_hba.conf and a kernel login that works.
 *     Only the verification runs.
 *   - trust era (clusters initialised with `-A trust` before this module
 *     existed): the bootstrap password is set while trust still admits the
 *     shell, THEN pg_hba.conf asks for passwords. Setting it after the switch
 *     would lock the shell out of its own cluster.
 *   - passwords the cluster no longer accepts (lost `secrets.enc`, a snapshot
 *     restored without its secrets): a trust window for the bootstrap role on
 *     IPv4 loopback, restart, set its password, close the window. The window
 *     holds exactly that one statement and is closed on every path; without it
 *     a lost secrets file would brick the local database.
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

/**
 * How long the verification waits for a pg_hba.conf reload to land. A reload
 * is asynchronous (SIGHUP): a backend forked before the postmaster re-read the
 * file still applies the old rules.
 */
const VERIFY_ATTEMPTS = 20;
const VERIFY_RETRY_MS = 100;

/** The extensions the kernel's migrations create. pgvector is untrusted: only a superuser may. */
const EXTENSIONS = ['vector', 'pg_trgm'] as const;

/** The kernel role's attributes; INHERIT so PG15+'s implicit pg_database_owner grants CREATE on `public`. */
const KERNEL_ROLE_ATTRIBUTES = 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS';

const HBA_HEADER = [
  '# Written by the omadia desktop shell (desktop/src/embeddedDbAuth.ts) on every',
  '# start; local edits are replaced. Every rule requires a SCRAM password.',
  '# TYPE  DATABASE  USER                  ADDRESS        METHOD',
];

const HBA_SCRAM = [
  ...HBA_HEADER,
  `local   all       ${DB_SUPERUSER},${DB_KERNEL_ROLE}                  scram-sha-256`,
  `host    all       ${DB_SUPERUSER},${DB_KERNEL_ROLE}  127.0.0.1/32   scram-sha-256`,
  `host    all       ${DB_SUPERUSER},${DB_KERNEL_ROLE}  ::1/128        scram-sha-256`,
  '',
].join('\n');

const HBA_RECOVERY = [
  '# Temporary: the omadia desktop shell is re-provisioning lost database',
  '# credentials. Replaced with password-only rules within seconds.',
  `host    all       ${DB_SUPERUSER}                 127.0.0.1/32   trust`,
  '',
].join('\n');

export type HbaRendering = 'scram' | 'recovery';

/** The shell's pg_hba.conf: password-only rules, or the recovery window's single trust rule. */
export function renderHba(rendering: HbaRendering): string {
  return rendering === 'scram' ? HBA_SCRAM : HBA_RECOVERY;
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

/** The DSN the kernel gets: the restricted role, loopback only. */
export function kernelDatabaseUrl(port: number, password: string): string {
  return `postgresql://${DB_KERNEL_ROLE}:${encodeURIComponent(password)}@127.0.0.1:${port}/${DB_NAME}`;
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
  escapeLiteral(value: string): string;
  end(): Promise<void>;
}

export interface ConnectOptions {
  readonly user: string;
  /** Omitted only inside the recovery window, where trust admits the bootstrap role. */
  readonly password?: string;
  readonly database: string;
}

export interface DbAuthIo {
  /** pg_hba.conf as it is on disk; null when it cannot be found. */
  readHba(): string | null;
  /** Replace pg_hba.conf atomically. */
  writeHba(text: string): Promise<void>;
  /** A loopback connection; rejects with pg's error (SQLSTATE in `code`). */
  connect(options: ConnectOptions): Promise<AuthClient>;
  /** Stop and start the server so it reads pg_hba.conf again; resolves once it accepts connections. */
  restartServer(): Promise<void>;
  sleep(ms: number): Promise<void>;
  info(message: string): void;
  warn(message: string): void;
}

/**
 * Bring the running cluster to the two-role, password-only state and verify
 * it. Rejects rather than let a DSN be handed out while the verification
 * fails: a wrong password must be refused, and the kernel role must not be
 * privileged.
 */
export async function ensureClusterAuth(io: DbAuthIo, creds: EmbeddedDbCredentials): Promise<void> {
  const hba = io.readHba();
  if (hba === renderHba('scram') && (await kernelRoleIsCurrent(io, creds))) {
    await verifyClusterAuth(io, creds);
    return;
  }
  await secureBootstrapRole(io, creds, hbaMode(hba));
  await provisionKernelRole(io, creds);
  await verifyClusterAuth(io, creds);
}

/** The kernel logs in with the stored password and is still a restricted role. */
async function kernelRoleIsCurrent(io: DbAuthIo, creds: EmbeddedDbCredentials): Promise<boolean> {
  let kernel: AuthClient;
  try {
    kernel = await io.connect({ user: DB_KERNEL_ROLE, password: creds.kernelPassword, database: DB_NAME });
  } catch (err) {
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
 * Postcondition: the bootstrap role's password is the stored one, pg_hba.conf
 * is the shell's, and the running server has been told to reload it.
 */
async function secureBootstrapRole(io: DbAuthIo, creds: EmbeddedDbCredentials, mode: HbaMode): Promise<void> {
  const admin = await connectAsBootstrap(io, creds);
  if (admin === null) {
    await reprovisionThroughTrustWindow(io, creds);
    return;
  }
  try {
    if (mode !== 'scram') {
      // Trust (or rules this shell did not write) may have admitted us without
      // looking at the password: set it while we are still let in, and only
      // then stop trusting. On failure the old rules stay, not a lockout.
      io.warn(
        mode === 'trust'
          ? '[db] migrating a trust-authenticated cluster to SCRAM passwords'
          : '[db] replacing a pg_hba.conf this shell did not write with SCRAM rules',
      );
      await setPassword(admin, DB_SUPERUSER, creds.superuserPassword);
    }
    if (io.readHba() !== renderHba('scram')) await adoptScramHba(io, admin);
  } finally {
    await admin.end();
  }
}

/** A superuser session with the stored password, or null when the server refuses it. */
async function connectAsBootstrap(io: DbAuthIo, creds: EmbeddedDbCredentials): Promise<AuthClient | null> {
  try {
    return await io.connect({ user: DB_SUPERUSER, password: creds.superuserPassword, database: ADMIN_DATABASE });
  } catch (err) {
    if (isAuthFailure(err)) return null;
    throw err;
  }
}

async function adoptScramHba(io: DbAuthIo, admin: AuthClient): Promise<void> {
  await io.writeHba(renderHba('scram'));
  await admin.query('SELECT pg_reload_conf()');
  io.info('[db] pg_hba.conf now requires a SCRAM password for every connection');
}

async function setPassword(client: AuthClient, role: string, password: string): Promise<void> {
  await client.query(`ALTER ROLE ${role} WITH PASSWORD ${client.escapeLiteral(scramVerifier(password))}`);
}

/**
 * The shell cannot authenticate: trust the bootstrap role on IPv4 loopback,
 * restart, set its password, and close the window again, on every path.
 */
async function reprovisionThroughTrustWindow(io: DbAuthIo, creds: EmbeddedDbCredentials): Promise<void> {
  io.warn(
    '[db] the stored database password was refused; re-provisioning it through a temporary ' +
      `loopback-only trust window for the "${DB_SUPERUSER}" role`,
  );
  await io.writeHba(renderHba('recovery'));
  let admin: AuthClient | null = null;
  let failure: unknown = null;
  try {
    await io.restartServer();
    admin = await io.connect({ user: DB_SUPERUSER, database: ADMIN_DATABASE });
    await setPassword(admin, DB_SUPERUSER, creds.superuserPassword);
  } catch (err) {
    failure = err;
  }
  try {
    await closeTrustWindow(io, admin);
  } catch (closeErr) {
    // The original failure is the one to report. A window that could not be
    // closed is not left open: the caller stops the server on any rejection.
    if (failure === null) throw closeErr;
    io.warn(`[db] could not close the trust window cleanly: ${errorText(closeErr)}`);
  }
  if (failure !== null) throw failure;
}

async function closeTrustWindow(io: DbAuthIo, admin: AuthClient | null): Promise<void> {
  await io.writeHba(renderHba('scram'));
  if (admin === null) {
    // No session to request a reload through: a restart reads the file again.
    await io.restartServer();
  } else {
    try {
      await admin.query('SELECT pg_reload_conf()');
    } finally {
      await admin.end();
    }
  }
  io.warn('[db] trust window closed; pg_hba.conf requires SCRAM passwords again');
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
    await setPassword(inKernelDb, DB_KERNEL_ROLE, creds.kernelPassword);
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
 * Fail closed: the running server must refuse a wrong password for both roles,
 * and the kernel role must log in with its password and hold no privilege.
 */
async function verifyClusterAuth(io: DbAuthIo, creds: EmbeddedDbCredentials): Promise<void> {
  io.info('[db] checking that wrong passwords are refused (the server logs these attempts as FATAL; expected)');
  await expectWrongPasswordRefused(io, DB_KERNEL_ROLE, DB_NAME);
  await expectWrongPasswordRefused(io, DB_SUPERUSER, ADMIN_DATABASE);
  const kernel = await io.connect({ user: DB_KERNEL_ROLE, password: creds.kernelPassword, database: DB_NAME });
  try {
    const problem = privilegeProblem(await roleAttributes(kernel));
    if (problem !== null) throw new Error(`[db] refusing to start the kernel: ${problem}`);
  } finally {
    await kernel.end();
  }
}

async function expectWrongPasswordRefused(io: DbAuthIo, user: string, database: string): Promise<void> {
  let outcome = '';
  for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt += 1) {
    const wrong = crypto.randomBytes(24).toString('hex');
    try {
      const client = await io.connect({ user, password: wrong, database });
      await client.end();
      outcome = 'a wrong password was accepted';
    } catch (err) {
      if (sqlState(err) === INVALID_PASSWORD) return;
      outcome = errorText(err);
    }
    if (attempt < VERIFY_ATTEMPTS) await io.sleep(VERIFY_RETRY_MS);
  }
  throw new Error(
    `[db] refusing to start the kernel: the embedded Postgres did not refuse a wrong password for "${user}" (${outcome})`,
  );
}
