import { Client, type ClientConfig, type Connection, type PoolConfig } from 'pg';

/**
 * Kernel connections to Postgres that authenticate with SCRAM-SHA-256 or not
 * at all, when the process is told to (`OMADIA_DB_REQUIRE_SCRAM=1`). The
 * desktop shell sets it for the kernel it spawns; server deployments leave it
 * unset and keep pg's own client.
 *
 * pg answers whatever authentication request a server sends: a cleartext
 * request gets the plain password, an MD5 request a hash of it, and an
 * AuthenticationOk without any exchange an unauthenticated session. The
 * desktop's embedded Postgres listens on loopback TCP on Windows, so if it
 * stops while the kernel runs, another local user's process could take the
 * port and ask the kernel's next connection for its password. SCRAM never
 * sends the password, and pg checks the server's final signature and fails
 * the connection when it does not match, so a connection that completed SCRAM
 * reached a server that holds the role's verifier.
 *
 * The guard is the desktop shell's own (`desktop/src/scramOnlyConnect.ts`),
 * shaped as a pg Client class that a Pool constructs for every connection. It
 * watches the authentication messages ahead of pg's handlers and refuses a
 * cleartext or MD5 request, a SASL offer without SCRAM-SHA-256, and an
 * AuthenticationOk that did not follow a completed SCRAM exchange. A refusal
 * destroys the socket before pg's handler runs, so nothing more is written to
 * it, and pg is handed the password only after the server has offered SCRAM.
 */

export const DB_REQUIRE_SCRAM_ENV = 'OMADIA_DB_REQUIRE_SCRAM';
export const SCRAM_REQUIRED = 'OMADIA_SCRAM_REQUIRED';
const SCRAM_MECHANISM = 'SCRAM-SHA-256';

export class ScramRequiredError extends Error {
  readonly code = SCRAM_REQUIRED;

  constructor(reason: string) {
    super(`[db] refused to authenticate to Postgres: ${reason} (only SCRAM-SHA-256 is accepted)`);
    this.name = 'ScramRequiredError';
  }
}

/** Whether a connection failed because the server did not authenticate with SCRAM. */
export function isScramRefusal(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === SCRAM_REQUIRED;
}

/** Whether this process connects to Postgres SCRAM-only (`1` or `true`). */
export function isScramRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[DB_REQUIRE_SCRAM_ENV]?.trim().toLowerCase();
  return value === '1' || value === 'true';
}

/** What pg keeps as a client's password: the value, a function, or nothing (pgpass). */
type PasswordSource =
  | string
  | null
  | undefined
  | ((...args: unknown[]) => string | undefined | Promise<string | undefined>);

type ConnectCallback = (err: Error | null, client?: Client) => void;

class ScramGuard {
  refusal: ScramRequiredError | null = null;
  private connection: Connection | null = null;
  private scramOffered = false;
  private scramCompleted = false;

  attach(connection: Connection): void {
    this.connection = connection;
    // prependListener: each of these runs before pg's handler for the same message.
    connection.prependListener('authenticationCleartextPassword', () =>
      this.refuse('the server asked for the password in cleartext'),
    );
    connection.prependListener('authenticationMD5Password', () =>
      this.refuse('the server asked for an MD5 password hash'),
    );
    connection.prependListener('authenticationSASL', (message: { mechanisms?: unknown }) => {
      const mechanisms: unknown[] = Array.isArray(message.mechanisms) ? message.mechanisms : [];
      if (mechanisms.includes(SCRAM_MECHANISM)) this.scramOffered = true;
      else this.refuse('the server did not offer SCRAM-SHA-256');
    });
    // pg checks the server signature in its own handler, right after this one,
    // and fails the connection when it does not match.
    connection.prependListener('authenticationSASLFinal', () => {
      this.scramCompleted = this.scramOffered;
    });
    connection.prependListener('authenticationOk', () => {
      if (!this.scramCompleted) this.refuse('the server let the connection in without a SCRAM exchange');
    });
  }

  /** pg's password callback: the password only goes into a SCRAM exchange. */
  async release(source: PasswordSource, args: unknown[]): Promise<string | undefined> {
    if (this.refusal === null && !this.scramOffered) {
      this.refuse('the server asked for a password without offering SCRAM-SHA-256');
    }
    if (this.refusal !== null) throw this.refusal;
    if (typeof source === 'function') return source(...args);
    return source ?? undefined;
  }

  private refuse(reason: string): void {
    this.refusal ??= new ScramRequiredError(reason);
    // Synchronous, so pg's handler for the same message finds the socket gone
    // and writes nothing more to it.
    this.connection?.stream.destroy();
  }
}

/**
 * A pg Client that authenticates with SCRAM-SHA-256 or fails to connect with
 * a ScramRequiredError. Pools get it through {@link scramOnlyPoolOptions}.
 */
export class ScramOnlyClient extends Client {
  readonly #guard = new ScramGuard();

  constructor(config?: string | ClientConfig) {
    super(config);
    const guard = this.#guard;
    // pg asks for the password when the server requests one; from here on the
    // guard decides. Defined the way pg defines it: hidden from logs.
    const source = (this as unknown as { password: PasswordSource }).password;
    Object.defineProperty(this, 'password', {
      configurable: true,
      enumerable: false,
      writable: true,
      value: (...args: unknown[]) => guard.release(source, args),
    });
    guard.attach(this.connection);
  }

  override connect(): Promise<Client>;
  override connect(callback: ((err: Error) => void) | ((err: null, c: Client) => void)): void;
  override connect(
    callback?: ((err: Error) => void) | ((err: null, c: Client) => void),
  ): Promise<Client> | undefined {
    if (callback === undefined) {
      return new Promise<Client>((resolve, reject) => {
        this.connect((err: Error | null) => {
          if (err) reject(err);
          else resolve(this);
        });
      });
    }
    const done = callback as ConnectCallback;
    // pg can report one failed connect twice (the socket's end and the error
    // behind it); a pool must hear about it once.
    let settled = false;
    super.connect((err: Error | null) => {
      if (settled) return;
      settled = true;
      const refusal = this.#guard.refusal;
      if (refusal !== null) {
        // A refusal can land after pg has already parsed the ReadyForQuery
        // that came in the same packet as the AuthenticationOk.
        this.end().catch(() => {});
        done(refusal);
        return;
      }
      if (err) done(err);
      else done(null, this);
    });
    return undefined;
  }
}

/**
 * The `Client` option for every pool the kernel opens: the SCRAM-only client
 * when the process is told to require it, pg's own client otherwise.
 */
export function scramOnlyPoolOptions(env: NodeJS.ProcessEnv = process.env): Pick<PoolConfig, 'Client'> {
  return isScramRequired(env) ? { Client: ScramOnlyClient } : {};
}
