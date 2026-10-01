import { Client, type ClientConfig, type Connection } from 'pg';

/**
 * Connections to the embedded Postgres that authenticate with SCRAM-SHA-256
 * or not at all.
 *
 * pg answers whatever authentication request a server sends: a cleartext
 * request gets the plain password, an MD5 request a hash of it, and an
 * AuthenticationOk without any exchange an unauthenticated session. So
 * whatever answers the endpoint first (on Windows, another local user's
 * process holding the loopback port while the shell's server is stopped)
 * could collect a password or pose as the cluster. SCRAM never sends the
 * password, and its last step has the server prove that it holds the role's
 * verifier (pg checks the server signature and fails the connection when it
 * does not match). A connection that completed SCRAM has therefore reached a
 * server that knows the password, which is what the shell relies on before it
 * believes anything a server says.
 *
 * pg has no switch for this, so the guard watches the authentication messages
 * on the connection, ahead of pg's own handlers: it refuses a cleartext or MD5
 * request, a SASL request without SCRAM-SHA-256, and an AuthenticationOk that
 * did not follow a completed SCRAM exchange. A refusal destroys the socket
 * before pg's handler runs, so nothing more is written to it, and pg is handed
 * the password only after the server has offered SCRAM.
 */

export const SCRAM_REQUIRED = 'OMADIA_SCRAM_REQUIRED';
const SCRAM_MECHANISM = 'SCRAM-SHA-256';

export class ScramRequiredError extends Error {
  readonly code = SCRAM_REQUIRED;

  constructor(reason: string) {
    super(`[db] refused to authenticate to the embedded Postgres: ${reason} (only SCRAM-SHA-256 is accepted)`);
    this.name = 'ScramRequiredError';
  }
}

/** Whether a connection failed because the server did not authenticate with SCRAM. */
export function isScramRefusal(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === SCRAM_REQUIRED;
}

/** What the shell connects with: always a password, and nothing that would bypass the guard. */
export type ScramOnlyConfig = Omit<ClientConfig, 'password' | 'connectionString' | 'stream' | 'ssl'> & {
  readonly password: string;
};

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
  release(password: string): string {
    if (this.refusal === null && !this.scramOffered) {
      this.refuse('the server asked for a password without offering SCRAM-SHA-256');
    }
    if (this.refusal !== null) throw this.refusal;
    return password;
  }

  private refuse(reason: string): void {
    this.refusal ??= new ScramRequiredError(reason);
    // Synchronous, so pg's handler for the same message finds the socket gone
    // and writes nothing more to it.
    this.connection?.stream.destroy();
  }
}

/**
 * A connected pg client that authenticated with SCRAM-SHA-256. Rejects with a
 * ScramRequiredError when the server asked for anything else, or with pg's own
 * error (SQLSTATE in `code`, e.g. 28P01 for a refused password). `onError`
 * is attached before connecting, so a connection the server drops later never
 * surfaces as an unhandled 'error' event.
 */
export async function connectScramOnly(config: ScramOnlyConfig, onError?: (err: Error) => void): Promise<Client> {
  const { password, ...rest } = config;
  const guard = new ScramGuard();
  // pg asks for the password when the server requests one; the guard decides.
  const client = new Client({ ...rest, password: () => guard.release(password) });
  if (onError !== undefined) client.on('error', onError);
  guard.attach(client.connection);
  try {
    await client.connect();
  } catch (err) {
    await client.end().catch(() => {});
    throw guard.refusal ?? err;
  }
  // A refusal can land after pg has already parsed the ReadyForQuery that came
  // in the same packet as the AuthenticationOk.
  if (guard.refusal !== null) {
    await client.end().catch(() => {});
    throw guard.refusal;
  }
  return client;
}
