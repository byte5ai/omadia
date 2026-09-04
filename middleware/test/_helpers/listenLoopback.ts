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

/**
 * True when the environment is one where a loopback listener MUST work, so a
 * bind failure is a real defect rather than a sandbox restriction.
 *
 * Two signals, because the repo grew two independently:
 *   - `OMADIA_EXPECT_LOOPBACK=1` — set on the middleware test step in
 *     `.github/workflows/ci.yml` (#1017).
 *   - `CI` — the signal the two `test/auth/**` suites already used to turn an
 *     `EPERM` into a descriptive failure (#640, #752).
 *
 * Honouring both means one helper covers every site without weakening any of
 * them, and a runner that sets only one still gets the strict behaviour.
 */
export function loopbackRequired(): boolean {
  return process.env.OMADIA_EXPECT_LOOPBACK === '1' || Boolean(process.env.CI);
}

/**
 * True when the sandbox refused a loopback listener AND this environment
 * tolerates that, so the caller may self-skip.
 *
 * WHY THIS IS SHARED (#1024)
 * --------------------------
 * Seven places grew their own copy of this check — three named
 * `isSandboxListenDenied`, two named `isSandboxListenError`, two written inline
 * — and they did not agree. #1017 taught the `cliBridge` copy to respect
 * `OMADIA_EXPECT_LOOPBACK`; the `publicMcp`, `devEndpoints`, `mcpClient` and
 * `mcpWriteIdempotency` copies kept swallowing the failure, so on a runner
 * where `bind(127.0.0.1:0)` returns `EPERM` a privacy-masking assertion and an
 * auth e2e passed green while asserting nothing. That is the failure family
 * `ci.yml` cites #640 and #752 for: a suite that deletes itself and reports
 * success.
 *
 * Same-named functions with different behaviour were the second half of the
 * trap — anyone who found `OMADIA_EXPECT_LOOPBACK` documented in
 * `middleware/.env.example` would reasonably assume it covered all of them.
 *
 * Callers that can produce a better diagnostic than a bare `EPERM` should ask
 * `loopbackRequired()` and throw their own message; the rest can rely on this
 * returning `false` so their `throw error` path runs.
 */
export function isSandboxListenDenied(error: unknown): boolean {
  if (loopbackRequired()) {
    return false;
  }
  return isDeniedListenError(error);
}

/**
 * The error SHAPE only: "this is a refused-listener error", with no opinion on
 * whether the environment tolerates it.
 *
 * Split out because a caller that wants to raise a better diagnostic than a
 * bare `EPERM` needs both halves separately — `loopbackRequired()` to decide,
 * and this to confirm the failure is the one it means to explain. Without it
 * those callers had to re-derive `code === 'EPERM'` inline, which is how two of
 * the seven #1024 copies came to exist in the first place.
 */
export function isDeniedListenError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EPERM';
}
