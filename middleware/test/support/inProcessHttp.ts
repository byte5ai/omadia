import { createServer, request as httpRequest, type RequestListener, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { Duplex } from 'node:stream';

/**
 * A `fetch`-shaped response, carrying only the surface the middleware router
 * suites actually assert against: status, headers, and a buffered body.
 */
export interface InProcessResponse {
  readonly status: number;
  readonly headers: Headers;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

/** Init options mirroring the `fetch` calls the suites already use. */
export interface InProcessRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * Two cross-wired {@link Duplex} streams that behave like the endpoints of a
 * loopback socket: bytes written to one surface as reads on the other. No file
 * descriptor, no port, no kernel socket — so nothing here contends for the
 * ephemeral-port range or pays a TCP handshake under a loaded CI runner, which
 * is the exact cost issue #564 identifies.
 *
 * The extra no-op methods are the slice of the `net.Socket` surface that
 * Node's own HTTP server- and client-side state machines poke at
 * (`setTimeout`, `setNoDelay`, …); a bare Duplex is missing them and the
 * parsers throw.
 */
function socketPair(): [Duplex, Duplex] {
  // `a` and `b` reference each other, but only from `write`/`final`, which run
  // strictly after both bindings are initialized — so `const` forward refs are
  // safe here (no TDZ hazard at call time).
  const a: Duplex = new Duplex({
    read() {},
    write(chunk, _enc, cb) {
      b.push(chunk);
      cb();
    },
    final(cb) {
      b.push(null);
      cb();
    },
  });
  const b: Duplex = new Duplex({
    read() {},
    write(chunk, _enc, cb) {
      a.push(chunk);
      cb();
    },
    final(cb) {
      a.push(null);
      cb();
    },
  });
  const stub = {
    setTimeout() {
      return this;
    },
    setNoDelay() {
      return this;
    },
    setKeepAlive() {
      return this;
    },
    ref() {
      return this;
    },
    unref() {
      return this;
    },
    address() {
      return { address: '127.0.0.1', family: 'IPv4', port: 0 };
    },
    remoteAddress: '127.0.0.1',
    remoteFamily: 'IPv4',
    remotePort: 0,
    localAddress: '127.0.0.1',
    localPort: 0,
  };
  Object.assign(a, stub);
  Object.assign(b, stub);
  return [a, b];
}

function flattenHeaders(raw: NodeJS.Dict<string | string[]>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
  }
  return headers;
}

/** A `fetch`-shaped caller bound to an in-process Express app. */
export interface InProcessClient {
  fetch(path: string, init?: InProcessRequestInit): Promise<InProcessResponse>;
  /** The underlying (never-listened) server — exposed for assertions/teardown. */
  server: Server;
}

/**
 * Drives an Express app (or any {@link RequestListener}) entirely in-process:
 * a real `http.Server` that is never `listen()`ed, fed a synthetic connection
 * and driven by Node's own HTTP client so the response is parsed by Node, not
 * by hand. Returns a `fetch`-shaped caller.
 */
export function createInProcessClient(handler: RequestListener): InProcessClient {
  const server = createServer(handler);
  function inProcessFetch(path: string, init: InProcessRequestInit = {}): Promise<InProcessResponse> {
    const [clientSide, serverSide] = socketPair();
    server.emit('connection', serverSide);
    return new Promise<InProcessResponse>((resolve, reject) => {
      const req = httpRequest(
        {
          // The synthetic Duplex stands in for the real net.Socket the client
          // would otherwise open — a deliberate transport swap, hence the cast.
          createConnection: () => clientSide as unknown as Socket,
          method: init.method ?? 'GET',
          path,
          host: 'localhost',
          headers: init.headers,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const buf = Buffer.concat(chunks);
            resolve({
              status: res.statusCode ?? 0,
              headers: flattenHeaders(res.headers),
              text: async () => buf.toString('utf8'),
              json: async () => JSON.parse(buf.toString('utf8')) as unknown,
            });
          });
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      if (init.body !== undefined) req.write(init.body);
      req.end();
    });
  }
  return { fetch: inProcessFetch, server };
}
