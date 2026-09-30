/**
 * A scripted stand-in for the embedded Postgres behind `DbAuthIo`, so the
 * credential state machine in `embeddedDbAuth.ts` can be driven through the
 * cluster states it has to handle (fresh, trust-era, lost credentials) and its
 * ordering asserted, the way `dbSnapshot.test.mts` records its IO port.
 *
 * It models only what the state machine can observe: which pg_hba.conf the
 * server has loaded (a reload lands only after `staleConnects` further
 * connections, the race a real SIGHUP has), which roles exist with which SCRAM
 * verifier, which databases exist and which extensions can be created.
 */
import {
  renderHba,
  scramVerifier,
  type AuthClient,
  type ConnectOptions,
  type DbAuthIo,
  type QueryResult,
} from '../../src/embeddedDbAuth.ts';

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
  /** pg_hba.conf on disk; the server has loaded it at start. */
  readonly hba: string | null;
  /** The bootstrap role's password; null means none is set (a trust-era cluster). */
  readonly superuserPassword: string | null;
  /** The kernel role, when it exists already; a null password means none is set. */
  readonly kernelRole?: { readonly password: string | null };
  readonly databases?: readonly string[];
  /** Extensions whose control file is installed; default: vector and pg_trgm. */
  readonly extensions?: readonly string[];
  /** Connections that still see the previous rules after a reload. */
  readonly staleConnects?: number;
  /** A statement matching this throws (also settable later, see `failOn`). */
  readonly failOn?: RegExp;
  /** restartServer() throws. */
  readonly restartFails?: boolean;
  /** Attributes the kernel role reports, whatever was ALTERed. */
  readonly kernelReports?: Partial<RoleAttributes>;
  /** Attributes the kernel role reports until its attributes are ALTERed (drift). */
  readonly kernelReportsUntilAltered?: Partial<RoleAttributes>;
}

/** The pg errors the state machine tells apart carry their SQLSTATE in `code`. */
export function sqlError(code: string, message: string, detail?: string): Error {
  return Object.assign(new Error(message), { code, detail });
}

/** Which of the shell's renderings a pg_hba.conf text is, for the call log. */
export function hbaLabel(text: string | null): string {
  if (text === renderHba('scram')) return 'scram';
  if (text === renderHba('recovery')) return 'recovery';
  return 'other';
}

function verifierMatches(verifier: string, password: string): boolean {
  const match = /^SCRAM-SHA-256\$(\d+):([^$]+)\$/.exec(verifier);
  if (match === null) return false;
  const iterations = Number(match[1]);
  const salt = Buffer.from(match[2] ?? '', 'base64');
  return scramVerifier(password, salt, iterations) === verifier;
}

/** The auth method the first matching host line gives `user`, or null. */
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
    [/^SELECT pg_reload_conf\(\)/, () => 'reload'],
    [/^SELECT rolsuper/, () => 'attributes?'],
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
  private drift: Partial<RoleAttributes>;
  private loaded: string | null;
  private pending: { hba: string | null; stale: number } | null = null;
  private readonly roles = new Map<string, FakeRole>();
  private readonly databases: Set<string>;
  private readonly extensions: Set<string>;
  private readonly options: FakeClusterOptions;

  constructor(options: FakeClusterOptions) {
    this.options = options;
    this.hbaOnDisk = options.hba;
    this.failOn = options.failOn;
    this.drift = options.kernelReportsUntilAltered ?? {};
    this.loaded = options.hba;
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

  hasRole(user: string): boolean {
    return this.roles.has(user);
  }

  hasDatabase(name: string): boolean {
    return this.databases.has(name);
  }

  /** Just the SQL statements, labelled, in order. */
  statements(): string[] {
    return this.calls.filter((call) => call.startsWith('sql ')).map((call) => call.slice(4));
  }

  readHba(): string | null {
    this.calls.push('readHba');
    return this.hbaOnDisk;
  }

  async writeHba(text: string): Promise<void> {
    this.calls.push(`writeHba(${hbaLabel(text)})`);
    this.hbaOnDisk = text;
  }

  async restartServer(): Promise<void> {
    this.calls.push('restartServer');
    if (this.options.restartFails) throw new Error('synthetic: postgres did not come back');
    this.loaded = this.hbaOnDisk;
    this.pending = null;
  }

  async sleep(): Promise<void> {
    this.calls.push('sleep');
  }

  info(message: string): void {
    this.logs.push(`info: ${message}`);
  }

  warn(message: string): void {
    this.logs.push(`warn: ${message}`);
  }

  async connect(options: ConnectOptions): Promise<AuthClient> {
    const how = options.password === undefined ? ', no password' : '';
    this.calls.push(`connect(${options.user}@${options.database}${how})`);
    const method = methodFor(this.rulesForNextConnection(), options.user);
    if (method === null) {
      throw sqlError('28000', `no pg_hba.conf entry for host "127.0.0.1", user "${options.user}"`);
    }
    const role = this.roles.get(options.user);
    if (method === 'trust') {
      if (role === undefined) throw sqlError('28000', `role "${options.user}" does not exist`);
    } else if (options.password === undefined) {
      // What pg does when the server asks for SCRAM and it has no password.
      throw new Error('SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string');
    } else if (!this.accepts(options.user, options.password)) {
      throw sqlError('28P01', `password authentication failed for user "${options.user}"`);
    }
    if (!this.databases.has(options.database)) {
      throw sqlError('3D000', `database "${options.database}" does not exist`);
    }
    return this.client(options.user, options.database);
  }

  private rulesForNextConnection(): string | null {
    if (this.pending !== null) {
      if (this.pending.stale > 0) {
        this.pending.stale -= 1;
        return this.loaded;
      }
      this.loaded = this.pending.hba;
      this.pending = null;
    }
    return this.loaded;
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
      escapeLiteral: (value: string): string => `'${value.replace(/'/g, "''")}'`,
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
    if (/^SELECT pg_reload_conf\(\)/.test(sql)) {
      this.pending = { hba: this.hbaOnDisk, stale: this.options.staleConnects ?? 0 };
      return { rows: [{ pg_reload_conf: true }] };
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
    return { rows: [] };
  }
}
