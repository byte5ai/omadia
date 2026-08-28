import type { Server } from 'node:http';

/**
 * Start a test server on a free port of the IPv4 loopback and resolve once it
 * is actually listening.
 *
 * WHY NOT A BARE `listen(0)`
 * --------------------------
 * `listen(0)` with no host binds the wildcard `[::]`. That socket is
 * dual-stack, so `http://127.0.0.1:<port>` normally reaches it — which is why
 * the bug this replaces looked intermittent rather than simply broken.
 *
 * The port, though, is only chosen against other *wildcard* binds. A process
 * that binds `127.0.0.1:<port>` specifically may already hold that exact port,
 * and on BSD/macOS the more specific bind coexists with the wildcard and
 * **wins** for connections addressed to 127.0.0.1. Local dev servers bind
 * 127.0.0.1 by default, so this is common: a request meant for the harness is
 * answered by whatever else is listening. Observed in practice — an MCP server
 * replying `401 … provide valid authorization token`, a Flask app replying
 * `404 <!doctype html>`, and a non-HTTP peer that surfaced as
 * `HTTPParserError: Response does not match the HTTP/1.1 protocol`.
 *
 * Binding 127.0.0.1 explicitly makes the reserved port and the dialled port
 * the same port, so a collision is an honest `EADDRINUSE` instead of a test
 * silently talking to a stranger.
 *
 * WHY THIS IS ASYNC
 * -----------------
 * Passing a host sends the call through the `dns.lookup` path even for an IP
 * literal, so the bind no longer completes synchronously and
 * `server.address()` is `null` on the next line. Awaiting `listening` is the
 * whole reason this helper exists rather than one extra argument at each site.
 */
export function listenLoopback(target: {
  listen(port: number, host: string, cb: () => void): Server;
}): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = target.listen(0, '127.0.0.1', () => { resolve(server); });
    server.once('error', reject);
  });
}
