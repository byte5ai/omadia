import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import type { Express } from 'express';

/**
 * Drive an Express app through its real routing pipeline WITHOUT binding a
 * TCP port.
 *
 * `app.listen(0)` + `fetch` is the obvious way to test a router, but every
 * such test holds a listening socket for its lifetime, and the suite runs
 * files concurrently. Enough of them and unrelated socket-using tests start
 * failing under contention — a fragility this repo already has. Tests that
 * only need "does this router answer correctly" should not be paying that
 * cost.
 *
 * This constructs genuine `IncomingMessage` / `ServerResponse` objects over
 * an unconnected socket and calls `app.handle`, so middleware ordering,
 * route matching, `res.json`, and header handling all run for real — only
 * the network layer is skipped.
 */

export interface InvokeResult {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | number | undefined>>;
  readonly text: string;
}

type EndArgs = readonly unknown[];

export interface InvokeOptions {
  /**
   * Request headers, lower-cased on the way in. Needed by any test that
   * asserts conditional-request behaviour (`If-None-Match` → 304): without
   * them the handler only ever sees an unconditional GET, and a test that
   * expects a 304 would pass or fail for the wrong reason.
   */
  readonly headers?: Readonly<Record<string, string>>;
}

export function invoke(
  app: Express,
  method: string,
  url: string,
  options: InvokeOptions = {},
): Promise<InvokeResult> {
  const socket = new Socket();
  const req = new IncomingMessage(socket);
  req.method = method;
  req.url = url;
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    // `IncomingMessage.headers` is the object Express reads; populate both it
    // and `rawHeaders` so anything reaching for either sees the same request.
    req.headers[name.toLowerCase()] = value;
    req.rawHeaders.push(name, value);
  }

  const res = new ServerResponse(req);
  const chunks: Buffer[] = [];

  const capture = (chunk: unknown): void => {
    if (chunk === undefined || chunk === null) return;
    if (typeof chunk === 'string') {
      chunks.push(Buffer.from(chunk, 'utf8'));
      return;
    }
    if (Buffer.isBuffer(chunk)) chunks.push(chunk);
  };

  return new Promise<InvokeResult>((resolve) => {
    // The response is never flushed to a real socket, so intercept the
    // write path and resolve once the handler finishes.
    res.write = ((chunk: unknown, ...rest: EndArgs): boolean => {
      capture(chunk);
      const cb = rest.at(-1);
      if (typeof cb === 'function') (cb as () => void)();
      return true;
    }) as typeof res.write;

    res.end = ((chunk?: unknown, ...rest: EndArgs): ServerResponse => {
      capture(chunk);
      const cb = rest.at(-1);
      if (typeof cb === 'function') (cb as () => void)();
      resolve({
        status: res.statusCode,
        headers: res.getHeaders(),
        text: Buffer.concat(chunks).toString('utf8'),
      });
      return res;
    }) as typeof res.end;

    app.handle(req, res);
  });
}

/** `invoke` + JSON parse, for endpoints that answer `application/json`. */
export async function getJson<T>(app: Express, url: string): Promise<{
  status: number;
  headers: InvokeResult['headers'];
  body: T;
}> {
  const res = await invoke(app, 'GET', url);
  return {
    status: res.status,
    headers: res.headers,
    body: JSON.parse(res.text) as T,
  };
}
