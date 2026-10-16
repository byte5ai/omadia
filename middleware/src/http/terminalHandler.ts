/**
 * What answers a request after every router on the app has passed on it — the
 * replacement for Express's built-in `finalhandler`.
 *
 * `finalhandler` answers with an HTML page and, unless `NODE_ENV` is
 * `production`, writes the error's stack trace into it. The Compose stack runs
 * with `NODE_ENV=development` (for the vault dev key), so a truncated JSON body
 * sent anonymously to the public API came back as an HTML page listing
 * container paths (#1326), a non-UUID admin id did the same (#1318), and an
 * unknown path got `<pre>Cannot GET …</pre>` (#1349). This handler answers
 * every one of those with the JSON error shape the rest of the API uses
 * (`{ code, message }`), never sends a stack, whatever `NODE_ENV` is, and logs
 * client mistakes as one line instead of a stack per request.
 *
 * WHY A TERMINAL CALLBACK, NOT `app.use(handler)` AT THE END
 * ----------------------------------------------------------
 * Plugins register routes after boot (`PluginRouteRegistry` live-mounts them
 * with `app.use` when a plugin is installed or re-activated). A catch-all
 * registered at boot would sit in front of every one of those, and the route
 * would 404 until the next restart. The callback passed to `app(req, res,
 * done)` runs only once the whole router stack — including anything mounted
 * later — has declined the request, so it is last by construction.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

/** body-parser / raw-body error `type`s and the code each one answers with. */
const BODY_ERROR_CODES: Readonly<Record<string, string>> = {
  'entity.parse.failed': 'request.invalid_json',
  'entity.too.large': 'request.payload_too_large',
  'entity.verify.failed': 'request.invalid_body',
  'encoding.unsupported': 'request.unsupported_encoding',
  'charset.unsupported': 'request.unsupported_charset',
  'parameters.too.many': 'request.too_many_parameters',
  'request.aborted': 'request.aborted',
  'request.size.invalid': 'request.size_mismatch',
};

/** Fallback code by status for a 4xx error that is not a body-parser one. */
const STATUS_CODES: Readonly<Record<number, string>> = {
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  413: 'request.payload_too_large',
  415: 'request.unsupported_media_type',
};

const CLIENT_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  'request.invalid_json': 'request body is not valid JSON',
  'request.payload_too_large': 'request body is too large',
};

export interface TerminalHandlerOptions {
  /**
   * #1349 — the declared-but-ungranted public prefix `path` falls under, or
   * `null`. Lets the 404 for such a path say why it is closed instead of
   * looking like a typo in the URL.
   */
  readonly ungrantedPublicPrefix?: (path: string) => string | null;
  /** Injected for tests; defaults to `console.warn` / `console.error`. */
  readonly warn?: (message: string) => void;
  readonly error?: (message: string, err: unknown) => void;
}

export type TerminalHandler = (
  err: unknown,
  req: IncomingMessage,
  res: ServerResponse,
) => void;

interface ErrorFields {
  readonly type?: unknown;
  readonly status?: unknown;
  readonly statusCode?: unknown;
}

export function createTerminalHandler(
  opts: TerminalHandlerOptions = {},
): TerminalHandler {
  const warn = opts.warn ?? ((message: string) => console.warn(message));
  const error =
    opts.error ?? ((message: string, err: unknown) => console.error(message, err));

  return function terminalHandler(err, req, res): void {
    const method = req.method ?? 'GET';
    const path = pathOf(req);

    if (res.headersSent) {
      // Too late for a status line. Same as finalhandler: drop the socket so
      // the client sees a broken response rather than a silently short one.
      if (err) error(`[http] ${method} ${path} failed after headers were sent:`, err);
      req.socket.destroy();
      return;
    }

    if (!err) {
      const prefix = opts.ungrantedPublicPrefix?.(path) ?? null;
      if (prefix !== null) {
        send(res, 404, {
          code: 'public_path.not_granted',
          message: `'${prefix}' is a public path of an installed plugin, but it has not been granted`,
        });
        return;
      }
      send(res, 404, { code: 'not_found', message: `Cannot ${method} ${path}` });
      return;
    }

    const status = clientErrorStatus(err);
    if (status !== null) {
      const type = (err as ErrorFields).type;
      const code =
        (typeof type === 'string' ? BODY_ERROR_CODES[type] : undefined) ??
        STATUS_CODES[status] ??
        'request.invalid';
      warn(`[http] ${method} ${path} → ${String(status)} ${code}`);
      send(res, status, {
        code,
        message: CLIENT_ERROR_MESSAGES[code] ?? 'the request could not be processed',
      });
      return;
    }

    error(`[http] ${method} ${path} unhandled error:`, err);
    send(res, 500, { code: 'internal', message: 'internal error' });
  };
}

/**
 * Express's app function forwards a third `done` argument to `app.handle` at
 * runtime (`lib/express.js`), which is what makes the terminal callback
 * possible. Its published types declare only `(req, res)`.
 */
type AppWithDone = (
  req: IncomingMessage,
  res: ServerResponse,
  done: (err?: unknown) => void,
) => void;

/**
 * An `http.Server` that runs `app` and hands everything it declines to
 * `terminal`. Use in place of `app.listen`, which would install
 * `finalhandler`.
 */
export function createAppServer(
  app: (req: IncomingMessage, res: ServerResponse) => unknown,
  terminal: TerminalHandler,
): Server {
  const handle = app as unknown as AppWithDone;
  return createServer((req, res) => {
    handle(req, res, (err) => {
      terminal(err, req, res);
    });
  });
}

/**
 * The 4xx status an error carries (body-parser and `http-errors` set
 * `status`/`statusCode`), or `null` for anything that is the server's fault.
 */
function clientErrorStatus(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null;
  const { status, statusCode } = err as ErrorFields;
  const value = typeof status === 'number' ? status : statusCode;
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  return value >= 400 && value < 500 ? value : null;
}

function pathOf(req: IncomingMessage): string {
  const url = (req as IncomingMessage & { originalUrl?: string }).originalUrl ?? req.url ?? '/';
  const query = url.indexOf('?');
  return query === -1 ? url : url.slice(0, query);
}

function send(
  res: ServerResponse,
  status: number,
  body: { readonly code: string; readonly message: string },
): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(payload));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(payload);
}
