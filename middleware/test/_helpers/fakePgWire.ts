/**
 * A listener that speaks just enough of the Postgres wire protocol to stand
 * where a Postgres server should be and ask a connecting client for
 * credentials the way an impostor would: in cleartext, as an MD5 hash, not at
 * all (an AuthenticationOk straight away, which is what `trust` does), or
 * through a SCRAM exchange whose last step it may forge. It records every
 * byte the client sends after its startup message, so a test can assert that
 * a password or a query never left the client.
 *
 * Same wire script as the desktop shell's `desktop/test/helpers/fakePgWire.mts`.
 * Synthetic passwords only; it binds 127.0.0.1 TCP on a port the OS picks,
 * the transport the desktop uses on Windows, on every OS.
 */
import net from 'node:net';
import crypto from 'node:crypto';
import { once } from 'node:events';

export type FakeAuthScript =
  /** AuthenticationCleartextPassword. */
  | { readonly kind: 'cleartext' }
  /** AuthenticationMD5Password. */
  | { readonly kind: 'md5' }
  /** AuthenticationOk and ReadyForQuery without asking for anything. */
  | { readonly kind: 'no-auth' }
  /**
   * No Authentication message at all: ReadyForQuery straight after the
   * startup message, alone or behind BackendKeyData.
   */
  | { readonly kind: 'ready-only'; readonly backendKeyData: boolean }
  /**
   * A password request and ReadyForQuery in one packet, so the client parses
   * both before it can answer.
   */
  | { readonly kind: 'password-and-ready'; readonly request: 'cleartext' | 'md5' | 'scram' }
  /** AuthenticationSASL offering only these mechanisms. */
  | { readonly kind: 'sasl'; readonly mechanisms: readonly string[] }
  /**
   * A SCRAM-SHA-256 exchange for `password`. `final` decides the last step: a
   * correct server signature, a forged one, or a cleartext request in its
   * place (after the client has already committed to SCRAM).
   */
  | {
      readonly kind: 'scram';
      readonly password: string;
      readonly final: 'valid-signature' | 'forged-signature' | 'cleartext-instead';
    };

export interface FakePgWire {
  readonly port: number;
  /** Everything clients sent after their startup message, concatenated. */
  received(): Buffer;
  /** The type byte of every message clients sent after startup, in order. */
  messageTypes(): string[];
  close(): Promise<void>;
}

function message(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(5);
  head.write(type, 0, 'ascii');
  head.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([head, body]);
}

function int32(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeInt32BE(value, 0);
  return buf;
}

const auth = (code: number, rest: Buffer = Buffer.alloc(0)): Buffer =>
  message('R', Buffer.concat([int32(code), rest]));
const BACKEND_KEY = message('K', Buffer.concat([int32(4242), int32(4343)]));
const READY_FOR_QUERY = message('Z', Buffer.from('I'));
const READY = Buffer.concat([auth(0), BACKEND_KEY, READY_FOR_QUERY]);
/** The answer to any simple query, so a client that got through resolves instead of waiting. */
const QUERY_DONE = Buffer.concat([message('C', Buffer.from('SELECT 0\0')), READY_FOR_QUERY]);

function errorResponse(code: string, text: string): Buffer {
  return message('E', Buffer.from(`SFATAL\0C${code}\0M${text}\0\0`));
}

const hmac = (key: Buffer, data: string): Buffer => crypto.createHmac('sha256', key).update(data).digest();

/** The server's side of SCRAM-SHA-256 for one connection. */
class ScramServer {
  private clientFirstBare = '';
  private serverFirst = '';
  private readonly salt = crypto.randomBytes(16);
  private readonly iterations = 4096;
  private readonly password: string;

  constructor(password: string) {
    this.password = password;
  }

  /** SASLInitialResponse body → server-first-message. */
  first(body: Buffer): string {
    const mechanismEnd = body.indexOf(0);
    const length = body.readInt32BE(mechanismEnd + 1);
    const clientFirst = body.subarray(mechanismEnd + 5, mechanismEnd + 5 + length).toString('utf8');
    this.clientFirstBare = clientFirst.slice(clientFirst.indexOf(',', clientFirst.indexOf(',') + 1) + 1);
    const clientNonce = /r=([^,]+)/.exec(this.clientFirstBare)?.[1] ?? '';
    const nonce = clientNonce + crypto.randomBytes(18).toString('base64');
    this.serverFirst = `r=${nonce},s=${this.salt.toString('base64')},i=${String(this.iterations)}`;
    return this.serverFirst;
  }

  /** SASLResponse body (client-final-message) → the server signature the client expects. */
  signature(body: Buffer): string {
    const clientFinal = body.toString('utf8');
    const withoutProof = clientFinal.slice(0, clientFinal.lastIndexOf(',p='));
    const authMessage = `${this.clientFirstBare},${this.serverFirst},${withoutProof}`;
    const salted = crypto.pbkdf2Sync(this.password, this.salt, this.iterations, 32, 'sha256');
    return hmac(hmac(salted, 'Server Key'), authMessage).toString('base64');
  }
}

function serve(socket: net.Socket, script: FakeAuthScript, record: (type: string, frame: Buffer) => void): void {
  let buffer = Buffer.alloc(0);
  let started = false;
  const scram = script.kind === 'scram' ? new ScramServer(script.password) : null;
  let scramStep = 0;

  const onStartup = (): void => {
    switch (script.kind) {
      case 'cleartext':
        socket.write(auth(3));
        return;
      case 'md5':
        socket.write(auth(5, crypto.randomBytes(4)));
        return;
      case 'no-auth':
        socket.write(READY);
        return;
      case 'ready-only':
        socket.write(script.backendKeyData ? Buffer.concat([BACKEND_KEY, READY_FOR_QUERY]) : READY_FOR_QUERY);
        return;
      case 'password-and-ready': {
        const request =
          script.request === 'cleartext'
            ? auth(3)
            : script.request === 'md5'
              ? auth(5, crypto.randomBytes(4))
              : auth(10, Buffer.from('SCRAM-SHA-256\0\0'));
        socket.write(Buffer.concat([request, READY_FOR_QUERY]));
        return;
      }
      case 'sasl':
        socket.write(auth(10, Buffer.from(`${script.mechanisms.join('\0')}\0\0`)));
        return;
      case 'scram':
        socket.write(auth(10, Buffer.from('SCRAM-SHA-256\0\0')));
        return;
    }
  };

  const onPasswordMessage = (body: Buffer): void => {
    if (scram === null || script.kind !== 'scram') {
      // Whatever the client sent is what an impostor wanted; turn it away.
      socket.end(errorResponse('28P01', 'password authentication failed'));
      return;
    }
    scramStep += 1;
    if (scramStep === 1) {
      socket.write(auth(11, Buffer.from(scram.first(body))));
      return;
    }
    if (script.final === 'cleartext-instead') {
      socket.write(auth(3));
      return;
    }
    const signature =
      script.final === 'valid-signature' ? scram.signature(body) : crypto.randomBytes(32).toString('base64');
    socket.write(Buffer.concat([auth(12, Buffer.from(`v=${signature}`)), READY]));
  };

  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!started) {
      if (buffer.length < 4 || buffer.length < buffer.readInt32BE(0)) return;
      buffer = buffer.subarray(buffer.readInt32BE(0));
      started = true;
      onStartup();
    }
    while (buffer.length >= 5 && buffer.length >= 1 + buffer.readInt32BE(1)) {
      const frameLength = 1 + buffer.readInt32BE(1);
      const frame = buffer.subarray(0, frameLength);
      buffer = buffer.subarray(frameLength);
      const type = String.fromCharCode(frame[0] ?? 0);
      record(type, frame);
      if (type === 'p') onPasswordMessage(frame.subarray(5));
      if (type === 'Q') socket.write(QUERY_DONE);
      if (type === 'X') socket.end();
    }
  });
  socket.on('error', () => {});
}

export async function startFakePgWire(script: FakeAuthScript): Promise<FakePgWire> {
  const frames: Buffer[] = [];
  const types: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    serve(socket, script, (type, frame) => {
      types.push(type);
      frames.push(frame);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fake listener has no port');
  return {
    port: address.port,
    received: () => Buffer.concat(frames),
    messageTypes: () => [...types],
    close: async () => {
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, 'close');
    },
  };
}
