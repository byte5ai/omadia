/**
 * #1846 — the largest request body the web UI passes to the middleware.
 *
 * Next 16 buffers every request body that runs through `proxy.ts` (the login
 * gate, which also covers `/bot-api/*`) up to `proxyClientMaxBodySize` —
 * 10 MB by default — and truncates the rest. The `/bot-api` handler then
 * streamed the truncated body with the original `Content-Length`, `fetch`
 * failed on the mismatch, and a 15 MB dataset upload the page allows (25 MB)
 * ended in "HTTP 500". The gate must keep covering `/bot-api` (ADR 0161), so
 * the limit is raised instead: the largest middleware upload (datasets,
 * 25 MiB) plus room for the multipart envelope.
 *
 * Leaf module with no imports: `next.config.ts` loads it at build time,
 * outside the app's module graph.
 */
export const PROXY_MAX_BODY_BYTES = 26 * 1024 * 1024;
