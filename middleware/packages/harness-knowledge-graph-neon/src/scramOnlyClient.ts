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
 * AuthenticationOk or ReadyForQuery that did not follow a SCRAM exchange pg
 * has verified. A refusal destroys the socket before pg's handler runs, so
 * nothing more is written to it, and pg is handed the password only after the
 * server has offered SCRAM. A connect pg reports as successful is handed out
 * only when the server's final SCRAM signature was checked and matched.
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

/** The SCRAM exchange pg keeps on a client while it runs, and drops once the server's signature matched. */
const saslSession = (client: Client): unknown => (client as unknown as { saslSession?: unknown }).saslSession;

class ScramGuard {
  refusal: ScramRequiredError | null = null;
  private connection: Connection | null = null;
  private scramOffered = false;
  private scramVerified = false;

  attach(client: Client): void {
    const connection = client.connection;
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
      if (!mechanisms.includes(SCRAM_MECHANISM)) {
        this.refuse('the server did not offer SCRAM-SHA-256');
        return;
      }
      if (this.scramOffered) return;
      this.scramOffered = true;
      // pg checks the server's final signature in its own handler and drops
      // the exchange only when the signature matches. The second listener is
      // added now, after pg's handlers, so it runs once that check is done.
      let exchange: unknown = null;
      connection.prependListener('authenticationSASLFinal', () => {
        exchange = saslSession(client) ?? null;
      });
      connection.on('authenticationSASLFinal', () => {
        this.scramVerified = exchange !== null && saslSession(client) === null;
      });
    });
    connection.prependListener('authenticationOk', () => {
      if (!this.scramVerified) this.refuse('the server let the connection in without a SCRAM exchange');
    });
    // pg takes the first ReadyForQuery as connected, with or without an
    // AuthenticationOk before it, and then sends any query already queued.
    connection.prependListener('readyForQuery', () => {
      if (!this.scramVerified) this.refuse('the server reported ready without a SCRAM exchange');
    });
  }

  /** pg's password callback: the password only goes into a SCRAM exchange. */
  async release(source: PasswordSource, args: unknown[]): Promise<string | undefined> {
    if (this.refusal === null && !this.scramOffered) {
      this.refuse('the server asked for a password without offering SCRAM-SHA-256');
    }
    // The socket is gone by now, so pg's connect fails through it. A thrown
    // refusal would reach pg's 'error' event after the connect has settled,
    // and an idle pool turns that into an unhandled rejection.
    if (this.refusal !== null) return new Promise<never>(() => {});
    if (typeof source === 'function') return source(...args);
    return source ?? undefined;
  }

  /**
   * Why a connect that pg has finished must not be used: the guard's refusal,
   * pg's own error, or a connection that never completed SCRAM. Null when the
   * server proved that it holds the role's verifier.
   */
  outcome<E>(err: E | null | undefined): ScramRequiredError | E | null {
    if ((err === null || err === undefined) && this.refusal === null && !this.scramVerified) {
      this.refuse('the connection opened without a completed SCRAM exchange');
    }
    return this.refusal ?? err ?? null;
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
    guard.attach(this);
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
      const failure = this.#guard.outcome(err);
      if (failure !== null) {
        // pg leaves the socket open after a failed connect, and a refusal can
        // land after pg has already parsed a ReadyForQuery in the same packet.
        this.end().catch(() => {});
        done(failure);
        return;
      }
      done(null, this);
    });
    return undefined;
  }
}

/**
 * The `Client` option for every pool the kernel opens: the SCRAM-only client
 * when the process is told to require it, pg's own client otherwise.
 */
export function scramOnlyPoolOptions(
  env: NodeJS.ProcessEnv = process.env,
): Pick<PoolConfig, 'Client' | 'connectionTimeoutMillis'> {
  return isScramRequired(env) ? { Client: ScramOnlyClient, connectionTimeoutMillis: SCRAM_CONNECT_TIMEOUT_MS } : {};
}

/**
 * How long a kernel pool that requires SCRAM waits for a connection. pg's
 * parser throws on authentication requests it does not know (GSS, SSPI) and
 * the connect then never settles; past this ceiling the pool destroys the
 * socket, so such a server holds no pool slot.
 */
export const SCRAM_CONNECT_TIMEOUT_MS = 10_000;
