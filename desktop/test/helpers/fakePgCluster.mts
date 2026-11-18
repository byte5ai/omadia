/**
 * A scripted stand-in for the embedded Postgres behind `DbAuthIo`, so the
 * credential state machine in `embeddedDbAuth.ts` can be driven through the
 * cluster states it has to handle (fresh, trust era, lost credentials) and its
 * ordering asserted, the way `dbSnapshot.test.mts` records its IO port.
 *
 * It models only what the state machine can observe: whether the server runs,
 * which pg_hba.conf it loaded when it started (the call log labels every
 * start with it), which roles exist with which SCRAM verifier, which databases
 * exist and which extensions can be created, which data directory the server
 * reports and whether it still serves its endpoint. Single-user mode, like the
 * real one, refuses to run while the server does.
 */
import {
  renderHba,
  scramVerifier,
  type AuthClient,
  type ConnectOptions,
  type DbAuthIo,
  type QueryResult,
} from '../../src/embeddedDbAuth.ts';
import { ScramRequiredError } from '../../src/scramOnlyConnect.ts';

/** The data directory of the cluster the shell started, in this simulation. */
export const FAKE_DATA_DIR = '/synthetic/omadia/pgdata';

export interface RoleAttributes {
  rolsuper: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  rolreplication: boolean;
  rolbypassrls: boolean;
}

const RESTRICTED: RoleAttributes = {
  rolsuper: false,
  rolcreaterole: false,
  rolcreatedb: false,
  rolreplication: false,
  rolbypassrls: false,
};

const BOOTSTRAP: RoleAttributes = {
  rolsuper: true,
  rolcreaterole: true,
  rolcreatedb: true,
  rolreplication: true,
  rolbypassrls: true,
};

interface FakeRole {
  verifier: string | null;
  attributes: RoleAttributes;
}

export interface FakeClusterOptions {
  /** pg_hba.conf on disk; the server loads it when it starts. */
  readonly hba: string | null;
  /** The bootstrap role's password; null means none is set (a trust-era cluster). */
  readonly superuserPassword: string | null;
  /** The kernel role, when it exists already; a null password means none is set. */
  readonly kernelRole?: { readonly password: string | null };
  readonly databases?: readonly string[];
  /** Extensions whose control file is installed; default: vector and pg_trgm. */
  readonly extensions?: readonly string[];
  /** A statement matching this throws, online or in single-user mode (see `failOn`). */
  readonly failOn?: RegExp;
  /** The start with this number (1-based) fails, as a server that does not come up. */
  readonly failStart?: number;
  /** The running server lets everyone in without a password, whatever pg_hba.conf says. */
  readonly ignoresHba?: boolean;
  /** Attributes the kernel role reports, whatever was ALTERed. */
  readonly kernelReports?: Partial<RoleAttributes>;
  /** Attributes the kernel role reports until its attributes are ALTERed (drift). */
  readonly kernelReportsUntilAltered?: Partial<RoleAttributes>;
  /** Roles the kernel role reports being a member of (a membership should never be present). */
  readonly kernelMemberships?: readonly string[];
  /** What `SHOW data_directory` answers; default FAKE_DATA_DIR, i.e. this cluster. */
  readonly reportsDataDirectory?: string;
  /** Connections as these roles fail the way a non-SCRAM server makes the guard fail them. */
  readonly refusesScramFor?: readonly string[];
  /** The server the shell started no longer holds its endpoint: every `confirmServing` rejects. */
  readonly notServing?: boolean;
}

/** The pg errors the state machine tells apart carry their SQLSTATE in `code`. */
export function sqlError(code: string, message: string, detail?: string): Error {
  return Object.assign(new Error(message), { code, detail });
}

/** Whether a pg_hba.conf text is the shell's rendering, for the call log. */
export function hbaLabel(text: string | null): string {
  return text === renderHba() ? 'scram' : 'other';
}

function verifierMatches(verifier: string, password: string): boolean {
  const match = /^SCRAM-SHA-256\$(\d+):([^$]+)\$/.exec(verifier);
  if (match === null) return false;
  const iterations = Number(match[1]);
  const salt = Buffer.from(match[2] ?? '', 'base64');
  return scramVerifier(password, salt, iterations) === verifier;
}

/** The auth method the first matching IPv4 host line gives `user`, or null. */
function methodFor(hba: string | null, user: string): string | null {
  for (const raw of (hba ?? '').split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const tokens = line.split(/\s+/);
    if (tokens[0] !== 'host' || tokens[3] !== '127.0.0.1/32') continue;
    const users = tokens[2] ?? '';
    if (users !== 'all' && !users.split(',').includes(user)) continue;
    return tokens[4] ?? null;
  }
  return null;
}

/** A short, stable label per statement, so a test can assert on order. */
function statementLabel(sql: string): string {
  const text = sql.trim();
  const rules: ReadonlyArray<readonly [RegExp, (m: RegExpExecArray) => string]> = [
    [/^ALTER ROLE (\w+) WITH PASSWORD /, (m) => `password(${m[1]})`],
    [/^CREATE ROLE (\w+) WITH (.*)$/, (m) => `create role ${m[1]} ${m[2]}`],
    [/^ALTER ROLE (\w+) WITH (.*)$/, (m) => `alter role ${m[1]} ${m[2]}`],
    [/^SELECT 1 FROM pg_roles/, () => 'role exists?'],
    [/^SELECT 1 FROM pg_database/, () => 'database exists?'],
    [/^CREATE DATABASE (\w+) OWNER (\w+)/, (m) => `create database ${m[1]} owner ${m[2]}`],
    [/^ALTER DATABASE (\w+) OWNER TO (\w+)/, (m) => `alter database ${m[1]} owner ${m[2]}`],
    [/^CREATE EXTENSION IF NOT EXISTS (\w+)/, (m) => `extension ${m[1]}`],
    [/^DO \$transfer\$/, () => 'transfer ownership'],
    [/^SELECT rolsuper/, () => 'attributes?'],
    [/pg_auth_members/, () => 'memberships?'],
    [/^SHOW data_directory$/, () => 'data directory?'],
  ];
  for (const [pattern, name] of rules) {
    const m = pattern.exec(text);
    if (m !== null) return name(m);
  }
  return text.slice(0, 40);
}

export class FakeCluster implements DbAuthIo {
  readonly calls: string[] = [];
  readonly logs: string[] = [];
  hbaOnDisk: string | null;
  /** A statement matching this throws; a test may clear it to let a retry through. */
  failOn: RegExp | undefined;
  running = false;
  private loaded: string | null = null;
  private starts = 0;
  private drift: Partial<RoleAttributes>;
  private readonly roles = new Map<string, FakeRole>();
  private readonly databases: Set<string>;
  private readonly extensions: Set<string>;
  private readonly options: FakeClusterOptions;

  constructor(options: FakeClusterOptions) {
    this.options = options;
    this.hbaOnDisk = options.hba;
    this.failOn = options.failOn;
    this.drift = options.kernelReportsUntilAltered ?? {};
    this.databases = new Set(['postgres', 'template1', ...(options.databases ?? [])]);
    this.extensions = new Set(options.extensions ?? ['vector', 'pg_trgm']);
    this.roles.set('omadia', {
      verifier: options.superuserPassword === null ? null : scramVerifier(options.superuserPassword),
      attributes: BOOTSTRAP,
    });
    if (options.kernelRole !== undefined) {
      const { password } = options.kernelRole;
      this.roles.set('omadia_kernel', {
        verifier: password === null ? null : scramVerifier(password),
        attributes: RESTRICTED,
      });
    }
  }

  /** Whether `user` could log in with `password` under SCRAM right now. */
  accepts(user: string, password: string): boolean {
    const role = this.roles.get(user);
    return role !== undefined && role.verifier !== null && verifierMatches(role.verifier, password);
  }

  /** Just the SQL statements, labelled `user@database: statement`, in order. */
  statements(): string[] {
    return this.calls.filter((call) => call.startsWith('sql ')).map((call) => call.slice(4));
  }

  readHba(): string | null {
    this.calls.push('readHba');
    return this.hbaOnDisk;
  }

  async writeHba(text: string): Promise<void> {
    this.calls.push(`writeHba(${hbaLabel(text)})`);
    if (this.running) throw new Error('synthetic: pg_hba.conf written while the server runs');
    this.hbaOnDisk = text;
  }

  async runSingleUser(statement: string): Promise<void> {
    this.calls.push(`singleUser: ${statementLabel(statement)}`);
    if (this.running) throw new Error('synthetic: lock file "postmaster.pid" already exists');
    if (this.failOn?.test(statement.trim())) throw new Error(`synthetic failure: ${statementLabel(statement)}`);
    this.execute('omadia', statement.trim(), []);
  }

  async startServer(): Promise<void> {
    this.starts += 1;
    this.calls.push(`startServer(${hbaLabel(this.hbaOnDisk)})`);
    if (this.running) throw new Error('synthetic: already running');
    if (this.starts === this.options.failStart) throw new Error('synthetic: postgres did not come back');
    this.loaded = this.hbaOnDisk;
    this.running = true;
  }

  async stopServer(): Promise<void> {
    this.calls.push('stopServer');
    this.running = false;
  }

  async confirmServing(): Promise<void> {
    this.calls.push('confirmServing');
    if (!this.running) throw new Error('synthetic: the server is not running');
    if (this.options.notServing) throw new Error('synthetic: postmaster.pid names another process');
  }

  isClusterDirectory(reported: string): boolean {
    return reported === FAKE_DATA_DIR;
  }

  info(message: string): void {
    this.logs.push(`info: ${message}`);
  }

  warn(message: string): void {
    this.logs.push(`warn: ${message}`);
  }

  async connect(options: ConnectOptions): Promise<AuthClient> {
    this.calls.push(`connect(${options.user}@${options.database})`);
    if (!this.running) throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1'), { code: 'ECONNREFUSED' });
    if (this.options.refusesScramFor?.includes(options.user)) {
      throw new ScramRequiredError('synthetic: the server asked for the password in cleartext');
    }
    const method = this.options.ignoresHba ? 'trust' : methodFor(this.loaded, options.user);
    if (method === null) {
      throw sqlError('28000', `no pg_hba.conf entry for host "127.0.0.1", user "${options.user}"`);
    }
    const role = this.roles.get(options.user);
    if (method === 'trust') {
      if (role === undefined) throw sqlError('28000', `role "${options.user}" does not exist`);
    } else if (!this.accepts(options.user, options.password)) {
      throw sqlError('28P01', `password authentication failed for user "${options.user}"`);
    }
    if (!this.databases.has(options.database)) {
      throw sqlError('3D000', `database "${options.database}" does not exist`);
    }
    return this.client(options.user, options.database);
  }

  private client(user: string, database: string): AuthClient {
    let open = true;
    return {
      query: async (sql: string, params?: readonly unknown[]): Promise<QueryResult> => {
        if (!open) throw new Error('synthetic: query on a closed client');
        this.calls.push(`sql ${user}@${database}: ${statementLabel(sql)}`);
        if (this.failOn?.test(sql.trim())) throw new Error(`synthetic failure: ${statementLabel(sql)}`);
        return this.execute(user, sql.trim(), params ?? []);
      },
      end: async (): Promise<void> => {
        open = false;
      },
    };
  }

  private execute(user: string, sql: string, params: readonly unknown[]): QueryResult {
    const password = /^ALTER ROLE (\w+) WITH PASSWORD '([^']*)'$/.exec(sql);
    if (password !== null) {
      const role = this.roles.get(password[1] ?? '');
      if (role === undefined) throw sqlError('42704', `role "${password[1]}" does not exist`);
      role.verifier = password[2] ?? null;
      return { rows: [] };
    }
    if (/^CREATE ROLE omadia_kernel WITH /.test(sql)) {
      if (this.roles.has('omadia_kernel')) throw sqlError('42710', 'role "omadia_kernel" already exists');
      this.roles.set('omadia_kernel', { verifier: null, attributes: { ...RESTRICTED } });
      return { rows: [] };
    }
    if (/^ALTER ROLE omadia_kernel WITH LOGIN/.test(sql)) {
      const role = this.roles.get('omadia_kernel');
      if (role === undefined) throw sqlError('42704', 'role "omadia_kernel" does not exist');
      role.attributes = { ...RESTRICTED };
      this.drift = {};
      return { rows: [] };
    }
    if (/^SELECT 1 FROM pg_roles WHERE rolname = \$1/.test(sql)) {
      return { rows: this.roles.has(String(params[0])) ? [{ '?column?': 1 }] : [] };
    }
    if (/^SELECT 1 FROM pg_database WHERE datname = \$1/.test(sql)) {
      return { rows: this.databases.has(String(params[0])) ? [{ '?column?': 1 }] : [] };
    }
    const createDb = /^CREATE DATABASE (\w+)/.exec(sql);
    if (createDb !== null) {
      this.databases.add(createDb[1] ?? '');
      return { rows: [] };
    }
    const extension = /^CREATE EXTENSION IF NOT EXISTS (\w+)/.exec(sql);
    if (extension !== null && !this.extensions.has(extension[1] ?? '')) {
      throw sqlError(
        '0A000',
        `extension "${extension[1]}" is not available`,
        `Could not open extension control file "/synthetic/${extension[1]}.control": No such file or directory.`,
      );
    }
    if (/^SELECT rolsuper/.test(sql)) {
      const role = this.roles.get(user);
      if (role === undefined) return { rows: [] };
      const reported =
        user === 'omadia_kernel'
          ? { ...role.attributes, ...this.drift, ...this.options.kernelReports }
          : role.attributes;
      return { rows: [{ ...reported }] };
    }
    if (/pg_auth_members/.test(sql)) {
      const memberships = user === 'omadia_kernel' ? (this.options.kernelMemberships ?? []) : [];
      return { rows: memberships.map((role) => ({ role })) };
    }
    if (/^SHOW data_directory$/.test(sql)) {
      if (!this.roles.get(user)?.attributes.rolsuper) {
        throw sqlError('42501', 'permission denied to examine "data_directory"');
      }
      return { rows: [{ data_directory: this.options.reportsDataDirectory ?? FAKE_DATA_DIR }] };
    }
    return { rows: [] };
  }
}
