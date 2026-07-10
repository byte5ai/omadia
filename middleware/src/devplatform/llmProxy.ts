/**
 * Epic #470 W1 — the middleware LLM proxy (spec §6b), the security keystone.
 *
 * An Anthropic-Messages-compatible reverse proxy mounted on the phone-home
 * router at `/llm` (so the full prefix is `/api/v1/dev-runner/llm/*`). It is the
 * ONE thing that keeps provider API keys out of job containers: the Claude CLI
 * inside a job is handed `ANTHROPIC_BASE_URL` → here and a per-job bearer as its
 * `ANTHROPIC_AUTH_TOKEN`; this proxy validates that bearer as a job token,
 * swaps in the real provider key from Vault, and forwards. No provider key ever
 * exists in a job container's env or filesystem.
 *
 * Contract confirmed by the option-D spike (issue #470 comment 4929394900): the
 * CLI probes `GET <base>/` once (must be 2xx), then `POST <base>/v1/messages?beta=true`
 * with `Authorization: Bearer <token>`. Both are served here.
 *
 * Wiring (out of this unit's scope — see the DockerBackend/wire units) builds a
 * router via `createLlmProxyRouter` with real store/Vault/usage seams and passes
 * it to `createDevRunnerRouter({ llmProxyRouter })`, which mounts it at `/llm`.
 *
 * Failure semantics (spec §6b step 5):
 *   - upstream 429 → passed through verbatim, incl. `Retry-After`.
 *   - upstream 5xx → retried ONCE — but only before any bytes reach the client.
 *     A streamed request that already emitted tokens is NEVER retried (a retry
 *     would re-bill the client for the tokens already streamed).
 *   - mid-stream disconnect → the partial usage seen so far is still metered and
 *     a `log` note records the truncation.
 */

import { Router, raw as expressRaw } from 'express';
import type { Request, Response } from 'express';

import { recordUsage as defaultRecordUsage } from '@omadia/usage-telemetry';
import { isTerminalDevJobStatus, type DevJobStatus } from './types.js';

// ---------------------------------------------------------------------------
// Injected seams. Each is the narrow slice this proxy needs; the wire unit
// binds the real store/Vault/ctx.llm-gate/usage-ledger implementations.
// ---------------------------------------------------------------------------

/** The minimal job view the proxy needs, resolved from the bearer token alone
 *  (the CLI never sends a jobId — only `Authorization: Bearer <djr_…>`). */
export interface LlmProxyJob {
  readonly id: string;
  readonly status: DevJobStatus;
  /** `dev_jobs.agent_kind` — drives the provider + model-allowlist lookup. */
  readonly agentKind: string;
}

/** Effective LLM policy for a job's agent kind (the `ctx.llm` gate's allowlist
 *  semantics, not a second one). */
export interface LlmModelPolicy {
  /** Vault key segment: namespace `core:dev-platform`, key `llm/<provider>/api_key`. */
  readonly provider: string;
  /** Upstream origin, e.g. `https://api.anthropic.com` (no trailing slash needed). */
  readonly upstreamBaseUrl: string;
  /** Exact model ids this agent kind may call. A model outside the list → 403. */
  readonly allowedModels: readonly string[];
}

/** One usage row for the shared `token_usage` ledger writer. */
export interface LlmProxyUsageRecord {
  readonly source: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly sessionId?: string;
}

export interface LlmProxyDeps {
  /** Resolve a job from its phone-home bearer token (sha256-hash match) or null. */
  resolveJobByToken(token: string): Promise<LlmProxyJob | null>;
  /** Resolve the provider + upstream + model allowlist for an agent kind. */
  resolvePolicy(agentKind: string): Promise<LlmModelPolicy | null>;
  /** Fetch the provider API key from Vault (`core:dev-platform` / `llm/<p>/api_key`). */
  resolveProviderKey(provider: string): Promise<string | undefined>;
  /** Atomic per-job increment: `UPDATE dev_jobs SET tokens_in = tokens_in + $1,
   *  tokens_out = tokens_out + $2 …`. W1 records; W4 enforces budget on the same statement. */
  addJobUsage(jobId: string, tokensIn: number, tokensOut: number): Promise<void>;
  /** Ledger writer. Defaults to the shared `@omadia/usage-telemetry` recorder. */
  recordUsage?: (record: LlmProxyUsageRecord) => void;
  /** Called when the authoritative `addJobUsage` write fails — the accounting
   *  loss is surfaced (and counted) rather than swallowed. Default: no-op (the
   *  error is still logged at error level). */
  onAccountingError?: (err: unknown, ctx: { jobId: string; tokensIn: number; tokensOut: number }) => void;
  /** Upstream fetch (test seam). Default: global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Structured log sink (e.g. mid-stream truncation notes). */
  log?: (msg: string) => void;
  /** Hard cap on a forwarded request body, in bytes. Default 25 MiB. */
  maxBodyBytes?: number;
}

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

const DEFAULT_MAX_BODY_BYTES = 25 * 1024 * 1024;
const USAGE_SOURCE = 'dev-job';

/**
 * The ONLY client request headers forwarded upstream (allowlist, not denylist —
 * the same lesson the W0 shim env learned). Everything else a hostile job
 * container sends — `cookie`, `x-forwarded-*`, `proxy-authorization`, the client
 * `authorization`/`x-api-key`, and every hop-by-hop header — is dropped. The
 * provider key + `content-type` + `anthropic-version` are attached server-side.
 */
const FORWARDED_REQUEST_HEADERS = new Set([
  'accept',
  'anthropic-version',
  'anthropic-beta',
  'content-type',
]);

/** Response headers not copied back: hop-by-hop + encoding/length that Node's
 *  fetch has already decoded away and express will recompute, PLUS auth-like
 *  headers an upstream/intermediary might echo — the provider key must never be
 *  handed back to the container the proxy exists to keep it away from. */
const STRIPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'transfer-encoding',
  'content-length',
  'content-encoding',
  'keep-alive',
  // auth-like echoes (review S-finding).
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'set-cookie',
  'www-authenticate',
  'proxy-authenticate',
]);

function fail(res: Response, status: number, code: string, message: string): void {
  if (res.headersSent) return;
  res.status(status).json({ code, message });
}

/** `Bearer <token>`, case-insensitive; else null. */
function bearerToken(req: Request): string | null {
  const header = req.header('authorization');
  if (!header) return null;
  const m = /^Bearer[ ]+(.+)$/i.exec(header.trim());
  return m ? m[1]!.trim() || null : null;
}

/**
 * Scan raw JSON for a duplicate key within ANY single object and return the
 * first one found (else null). `JSON.parse` silently keeps the last value for a
 * repeated key, so a body with two `model` keys would pass the allowlist check
 * on the parser's interpretation while the upstream honored the other — a
 * model-allowlist bypass (review S-finding). We refuse such a body outright.
 * A minimal state machine: a stack of key-sets, one per open object; strings
 * with escapes handled; a key is a string token immediately followed by `:`.
 */
function firstDuplicateJsonKey(raw: string): string | null {
  const stack: Array<Set<string>> = [];
  let i = 0;
  const n = raw.length;
  // `pendingKey` holds the most recently closed string while we look for the
  // `:` that would make it an object key (vs. a string value or array element).
  let pendingKey: string | null = null;
  while (i < n) {
    const c = raw[i]!;
    if (c === '"') {
      // Read a full JSON string (with escapes).
      let s = '';
      i++;
      while (i < n) {
        const ch = raw[i]!;
        if (ch === '\\') {
          s += ch + (raw[i + 1] ?? '');
          i += 2;
          continue;
        }
        if (ch === '"') {
          i++;
          break;
        }
        s += ch;
        i++;
      }
      pendingKey = s;
      continue;
    }
    if (c === '{') {
      stack.push(new Set());
      pendingKey = null;
      i++;
      continue;
    }
    if (c === '}') {
      stack.pop();
      pendingKey = null;
      i++;
      continue;
    }
    if (c === '[') {
      pendingKey = null;
      i++;
      continue;
    }
    if (c === ']') {
      pendingKey = null;
      i++;
      continue;
    }
    if (c === ':') {
      // The pending string was an object key. Register it against the current
      // object; a second sighting is the duplicate we refuse.
      const top = stack[stack.length - 1];
      if (top && pendingKey !== null) {
        if (top.has(pendingKey)) return pendingKey;
        top.add(pendingKey);
      }
      pendingKey = null;
      i++;
      continue;
    }
    if (c === ',') {
      pendingKey = null;
      i++;
      continue;
    }
    i++;
  }
  return null;
}

interface UsageAccumulator {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  seen: boolean;
}

function newUsage(): UsageAccumulator {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, seen: false };
}

/** Pull Anthropic `usage` numbers out of a parsed event/body object. `message_start`
 *  carries input + cache + initial output; `message_delta` carries cumulative output;
 *  a non-streamed JSON body carries the final totals top-level. */
function applyUsage(acc: UsageAccumulator, u: unknown): void {
  if (!u || typeof u !== 'object') return;
  const r = u as Record<string, unknown>;
  if (typeof r['input_tokens'] === 'number') {
    acc.inputTokens = r['input_tokens'];
    acc.seen = true;
  }
  if (typeof r['output_tokens'] === 'number') {
    acc.outputTokens = r['output_tokens'];
    acc.seen = true;
  }
  if (typeof r['cache_read_input_tokens'] === 'number') {
    acc.cacheReadTokens = r['cache_read_input_tokens'];
    acc.seen = true;
  }
  if (typeof r['cache_creation_input_tokens'] === 'number') {
    acc.cacheCreationTokens = r['cache_creation_input_tokens'];
    acc.seen = true;
  }
}

/** Feed one parsed SSE `data:` JSON object into the accumulator. */
function ingestSseData(acc: UsageAccumulator, data: unknown): void {
  if (!data || typeof data !== 'object') return;
  const d = data as Record<string, unknown>;
  const type = d['type'];
  if (type === 'message_start') {
    const msg = d['message'];
    if (msg && typeof msg === 'object') applyUsage(acc, (msg as Record<string, unknown>)['usage']);
  } else if (type === 'message_delta') {
    applyUsage(acc, d['usage']);
  }
}

/** Stateful SSE splitter: events are separated by a blank line; each `data:` line
 *  holds JSON. Returns the unconsumed tail to prepend to the next chunk. */
function drainSse(acc: UsageAccumulator, buffer: string): string {
  let idx: number;
  while ((idx = buffer.indexOf('\n\n')) !== -1) {
    const block = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 2);
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) continue;
    try {
      ingestSseData(acc, JSON.parse(dataLines.join('\n')));
    } catch {
      /* partial/non-JSON event — ignore for metering, still passed through verbatim */
    }
  }
  return buffer;
}

/** Write a chunk to the client, honoring backpressure so a slow client cannot
 *  make us buffer the whole upstream stream in memory. */
function writeChunk(res: Response, chunk: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const ok = res.write(Buffer.from(chunk), (err) => {
      if (err) reject(err);
    });
    if (ok) resolve();
    else res.once('drain', resolve);
  });
}

// ---------------------------------------------------------------------------
// Router.
// ---------------------------------------------------------------------------

export function createLlmProxyRouter(deps: LlmProxyDeps): Router {
  const router = Router();
  const {
    resolveJobByToken,
    resolvePolicy,
    resolveProviderKey,
    addJobUsage,
    recordUsage = defaultRecordUsage,
    onAccountingError = () => {},
    fetchImpl = fetch,
    log = () => {},
    maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  } = deps;

  // --- GET / --------------------------------------------------------------
  // The CLI probes the origin root before its first POST (option-D spike
  // finding 3). Any 2xx satisfies it; this is an unauthenticated liveness ping
  // that leaks nothing (no job, no policy, no key touched).
  router.get('/', (_req, res) => {
    res.status(200).json({ ok: true, service: 'omadia-dev-llm-proxy' });
  });

  // --- POST /v1/messages (and ?beta=true) ---------------------------------
  router.post(
    '/v1/messages',
    expressRaw({ type: () => true, limit: maxBodyBytes }),
    (req, res, next) => {
      void handleMessages(req, res).catch(next);
    },
  );

  async function handleMessages(req: Request, res: Response): Promise<void> {
    // 1. Authenticate the job token; unknown/wrong → 401 (no oracle).
    const token = bearerToken(req);
    if (!token) {
      fail(res, 401, 'devplatform.unauthorized', 'missing or malformed bearer token');
      return;
    }
    const job = await resolveJobByToken(token);
    if (!job) {
      fail(res, 401, 'devplatform.unauthorized', 'invalid job token');
      return;
    }
    // 2. Terminal jobs may not call the model.
    if (isTerminalDevJobStatus(job.status)) {
      fail(res, 410, 'devplatform.job_terminal', 'job has reached a terminal state');
      return;
    }

    // 3. Read the request body (raw bytes — forwarded verbatim, and parsed for
    //    the model gate). `express.raw` yields a Buffer.
    const body: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const rawText = body.length > 0 ? body.toString('utf8') : '';
    let parsed: Record<string, unknown>;
    try {
      parsed = rawText.length > 0 ? (JSON.parse(rawText) as Record<string, unknown>) : {};
    } catch {
      fail(res, 400, 'devplatform.invalid_body', 'request body must be valid JSON');
      return;
    }
    // Refuse duplicate JSON keys: the allowlist check reads one parser's view of
    // `model` while the raw body we forward could carry a second `model` the
    // upstream honors instead — a model-allowlist bypass.
    const dup = firstDuplicateJsonKey(rawText);
    if (dup !== null) {
      fail(res, 400, 'devplatform.invalid_body', 'request body has a duplicate JSON key');
      return;
    }
    const model = parsed['model'];
    if (typeof model !== 'string' || model.length === 0) {
      fail(res, 400, 'devplatform.invalid_body', 'request body must name a model');
      return;
    }

    // 4. Resolve provider + model allowlist (the ctx.llm gate semantics).
    const policy = await resolvePolicy(job.agentKind);
    if (!policy) {
      fail(res, 500, 'devplatform.no_provider', 'no LLM policy configured for this agent kind');
      return;
    }
    if (!policy.allowedModels.includes(model)) {
      fail(res, 403, 'dev.model_not_allowed', 'requested model is not permitted for this repository');
      return;
    }

    // 5. Attach the provider key from Vault. Never surfaced to the caller.
    const providerKey = await resolveProviderKey(policy.provider);
    if (!providerKey) {
      fail(res, 500, 'devplatform.provider_key_unavailable', 'no provider key configured');
      return;
    }

    // 6. Forward. `?beta=true` (and any other query) is preserved.
    const queryIdx = req.originalUrl.indexOf('?');
    const query = queryIdx === -1 ? '' : req.originalUrl.slice(queryIdx);
    const upstreamUrl = `${policy.upstreamBaseUrl.replace(/\/+$/, '')}/v1/messages${query}`;
    const headers = buildForwardHeaders(req, providerKey);
    const streamed = parsed['stream'] === true;

    await proxyUpstream({
      res,
      job,
      model,
      streamed,
      upstreamUrl,
      headers,
      body,
      providerKey,
    });
  }

  async function proxyUpstream(args: {
    res: Response;
    job: LlmProxyJob;
    model: string;
    streamed: boolean;
    upstreamUrl: string;
    headers: Record<string, string>;
    body: Buffer;
    providerKey: string;
  }): Promise<void> {
    const { res, job, model, upstreamUrl, headers, body, providerKey } = args;

    // Retry loop: a 5xx or a connect error may be retried ONCE — but only here,
    // BEFORE any byte reaches the client. Once streaming starts, this loop is
    // gone, so a streamed request that emitted tokens can never be retried.
    let upstream: Awaited<ReturnType<typeof fetchImpl>> | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        upstream = await fetchImpl(upstreamUrl, { method: 'POST', headers, body });
      } catch (err) {
        if (attempt === 0) continue; // one retry on a connect-level failure
        fail(res, 502, 'devplatform.upstream_unreachable', 'LLM provider is unreachable');
        log(`[dev-llm] upstream unreachable for job ${job.id}: ${errText(err)}`);
        return;
      }
      if (upstream.status >= 500 && attempt === 0) continue; // one retry on 5xx
      break;
    }
    if (!upstream) {
      fail(res, 502, 'devplatform.upstream_unreachable', 'LLM provider is unreachable');
      return;
    }

    // Status + headers pass through verbatim (Retry-After on 429 included).
    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      if (!STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) res.setHeader(key, value);
    });

    if (!upstream.body) {
      res.end();
      return;
    }

    const contentType = (upstream.headers.get('content-type') ?? '').toLowerCase();
    const isSse = contentType.includes('text/event-stream');

    // Non-stream ERROR bodies are buffered and defensively scrubbed of the
    // provider key before they reach the container: an upstream/intermediary
    // that reflects the request (incl. the injected key) into an error payload
    // must not hand it to the job. Success bodies stream verbatim (below).
    if (!isSse && upstream.status >= 400) {
      let errBody = Buffer.from(await upstream.arrayBuffer());
      if (providerKey.length > 0) {
        const scrubbed = errBody.toString('utf8').split(providerKey).join('[REDACTED]');
        errBody = Buffer.from(scrubbed, 'utf8');
      }
      res.removeHeader('content-length');
      res.end(errBody);
      return;
    }

    const acc = newUsage();
    const decoder = new TextDecoder();
    let sseBuffer = '';
    let jsonBuffer = '';
    let truncated = false;

    try {
      for await (const chunk of upstream.body as AsyncIterable<Uint8Array>) {
        // Verbatim passthrough FIRST — no re-chunking, no buffering of the body.
        await writeChunk(res, chunk);
        // Then tap the same bytes for usage metering.
        const text = decoder.decode(chunk, { stream: true });
        if (isSse) sseBuffer = drainSse(acc, sseBuffer + text);
        else jsonBuffer += text;
      }
    } catch (err) {
      // Mid-stream disconnect: keep whatever usage we accumulated; note the truncation.
      truncated = true;
      log(`[dev-llm] stream truncated for job ${job.id}: ${errText(err)}`);
    }

    if (!isSse && jsonBuffer.length > 0) {
      try {
        const parsed = JSON.parse(jsonBuffer) as Record<string, unknown>;
        applyUsage(acc, parsed['usage']);
      } catch {
        /* non-JSON / partial body — nothing to meter */
      }
    }

    res.end();
    await meterUsage(job, model, acc, truncated);
  }

  async function meterUsage(
    job: LlmProxyJob,
    model: string,
    acc: UsageAccumulator,
    truncated: boolean,
  ): Promise<void> {
    if (!acc.seen) return;
    const tokensIn = acc.inputTokens + acc.cacheReadTokens + acc.cacheCreationTokens;
    const tokensOut = acc.outputTokens;

    // dev_jobs is the AUTHORITATIVE per-job counter (W4 enforces budget on it),
    // so it is written FIRST. Its failure is NOT swallowed: it is logged at error
    // level, counted via `onAccountingError`, and — crucially — the ledger row is
    // then SKIPPED, so the two stores can never diverge into "billed the ledger
    // but not dev_jobs". (The shared usage-telemetry recorder is a non-blocking,
    // buffered sink that drops in in-memory-KG mode and cannot join a pg
    // transaction, so authoritative-first ordering is the strongest guarantee
    // available here — see the unit's review note.)
    try {
      await addJobUsage(job.id, tokensIn, tokensOut);
    } catch (err) {
      log(`[dev-llm] ERROR addJobUsage failed for job ${job.id} (${String(tokensIn)}/${String(tokensOut)} tok): ${errText(err)}`);
      onAccountingError(err, { jobId: job.id, tokensIn, tokensOut });
      return;
    }

    // Ledger row — source + session id are the dev-platform provenance. Reached
    // only after the authoritative increment committed.
    recordUsage({
      source: USAGE_SOURCE,
      model,
      inputTokens: acc.inputTokens,
      outputTokens: acc.outputTokens,
      cacheReadTokens: acc.cacheReadTokens,
      cacheCreationTokens: acc.cacheCreationTokens,
      sessionId: `devjob:${job.id}`,
    });
    if (truncated) log(`[dev-llm] recorded partial usage for truncated job ${job.id}`);
  }

  return router;
}

/** Build the upstream request headers from an ALLOWLIST (not a scrub-list), then
 *  attach the provider key as `x-api-key`. Any header not explicitly allowed —
 *  cookies, `x-forwarded-*`, `proxy-authorization`, the client's own auth, and
 *  all hop-by-hop headers — never reaches upstream. */
function buildForwardHeaders(req: Request, providerKey: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (!FORWARDED_REQUEST_HEADERS.has(key.toLowerCase())) continue;
    out[key] = Array.isArray(value) ? value.join(', ') : value;
  }
  // Server-injected, overriding any allowlisted client copy.
  out['x-api-key'] = providerKey;
  if (!Object.keys(out).some((k) => k.toLowerCase() === 'anthropic-version')) {
    out['anthropic-version'] = '2023-06-01';
  }
  out['content-type'] = 'application/json';
  return out;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
