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

/** W4 metered usage for a single upstream response, handed to the budget hook. */
export interface LlmProxyMeteredUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
}

/** The budget hook's per-call verdict. */
export interface LlmProxyBudgetDecision {
  /** THIS call's accumulation crossed the cap ⇒ the proxy answers 402 and the
   *  job has already been marked `budget_exceeded` + terminated by the hook. */
  readonly exceeded: boolean;
}

/**
 * W4 budget metering + enforcement hook (implemented by `llmProxyAccounting.ts`).
 * When wired, every billable (2xx) response is routed through `meter` for an
 * atomic accumulate-and-readback with post-hoc enforcement; a job already
 * `budget_exceeded` is pre-gated to 402 by the proxy's auth step. Absent ⇒ the
 * W1 `addJobUsage` + `recordUsage` metering path runs unchanged (no enforcement).
 */
export interface LlmProxyBudgetHook {
  /** Optional ceiling clamped into the forwarded body's `max_tokens`, bounding a
   *  single post-hoc overshoot to one response (spec §5). */
  readonly maxOutputTokens?: number;
  /** Meter one response's usage, enforce the budget, and report whether THIS call
   *  crossed the cap. Never throws into the proxy. */
  meter(input: {
    jobId: string;
    model: string;
    usage: LlmProxyMeteredUsage;
  }): Promise<LlmProxyBudgetDecision>;
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
  /** W4 budget metering + enforcement (see {@link LlmProxyBudgetHook}). Optional:
   *  absent ⇒ the W1 metering path (`addJobUsage` + `recordUsage`) runs unchanged
   *  with no budget enforcement. */
  budget?: LlmProxyBudgetHook;
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
/** Hard ceiling on the response the ENFORCED (buffered) path holds in memory before
 *  committing it — the OOM backstop that does not depend on the optional max_tokens
 *  clamp being wired (Forge W4 audit #2). A real LLM response is far under this. */
const MAX_ENFORCED_BUFFER_BYTES = 32 * 1024 * 1024;
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

/** Replace every occurrence of `secret` (a byte sequence) in `buf` with
 *  `[REDACTED]`, operating on raw bytes via a latin1 round-trip (1:1 with
 *  bytes, so arbitrary binary is preserved). Returns `buf` unchanged when the
 *  secret is empty or absent. */
function redactBytes(buf: Buffer, secretLatin: string): Buffer {
  if (secretLatin.length === 0) return buf;
  const latin = buf.toString('latin1');
  if (!latin.includes(secretLatin)) return buf;
  return Buffer.from(latin.split(secretLatin).join('[REDACTED]'), 'latin1');
}

/**
 * Rolling redactor for the STREAMED response path (review S-finding): an
 * upstream error event on a `text/event-stream` reaches the job container
 * verbatim, so an echoed provider key would leak — the exact thing the proxy
 * exists to prevent. This scans each chunk for the provider-key bytes before
 * they are written downstream, holding back the last `N-1` bytes (N = key
 * length) across chunk boundaries so the secret cannot be smuggled split over
 * two chunks. `flush()` emits the retained tail once the stream ends.
 */
class StreamRedactor {
  private carry = Buffer.alloc(0);
  private readonly secretLatin: string;
  private readonly keep: number;
  constructor(secret: string) {
    // Match on the secret's raw UTF-8 bytes, expressed as a latin1 string.
    this.secretLatin = Buffer.from(secret, 'utf8').toString('latin1');
    this.keep = Math.max(0, this.secretLatin.length - 1);
  }
  /** Feed one upstream chunk; return the bytes safe to write to the client now. */
  push(chunk: Buffer): Buffer {
    if (this.secretLatin.length === 0) return chunk;
    const combined = this.carry.length > 0 ? Buffer.concat([this.carry, chunk]) : chunk;
    const redacted = redactBytes(combined, this.secretLatin);
    if (redacted.length <= this.keep) {
      this.carry = Buffer.from(redacted);
      return Buffer.alloc(0);
    }
    const emit = Buffer.from(redacted.subarray(0, redacted.length - this.keep));
    this.carry = Buffer.from(redacted.subarray(redacted.length - this.keep));
    return emit;
  }
  /** Emit the held-back tail (< N bytes — can never contain a full secret). */
  flush(): Buffer {
    const out = this.carry;
    this.carry = Buffer.alloc(0);
    return out;
  }
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
    budget,
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
    // 2. A `budget_exceeded` job answers the runner a fatal 402 (spec §5, W4) so
    //    it converges by exiting; every OTHER terminal answers 410. The store's
    //    `resolveJobByToken` deliberately surfaces `budget_exceeded` (and only it)
    //    among terminals for exactly this signal — see its note.
    if (job.status === 'budget_exceeded') {
      fail(res, 402, 'dev.budget_exceeded', 'job LLM budget exhausted');
      return;
    }
    if (isTerminalDevJobStatus(job.status)) {
      fail(res, 410, 'devplatform.job_terminal', 'job has reached a terminal state');
      return;
    }

    // 3. Parse the request body and CANONICALISE it. `express.raw` yields a
    //    Buffer; we parse it, enforce the model allowlist on the PARSED object,
    //    and forward `JSON.stringify(parsed)` (step 6) — never the raw bytes.
    //    This kills the whole "validate one representation, forward another"
    //    class (duplicate keys, `\u`-escaped keys, whitespace/nesting tricks):
    //    after canonicalisation the forwarded body carries exactly one `model`
    //    field, holding the value that was checked here.
    const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const rawText = rawBody.length > 0 ? rawBody.toString('utf8') : '';
    let parsed: unknown;
    try {
      parsed = rawText.length > 0 ? JSON.parse(rawText) : {};
    } catch {
      fail(res, 400, 'devplatform.invalid_body', 'request body must be valid JSON');
      return;
    }
    // A non-object top-level body (array, string, number, null) can never be a
    // valid Messages request and must not be forwarded.
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      fail(res, 400, 'devplatform.invalid_body', 'request body must be a JSON object');
      return;
    }
    const parsedObj = parsed as Record<string, unknown>;
    const model = parsedObj['model'];
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

    // 4b. W4: clamp `max_tokens` to the budget hook's ceiling so a single
    //    post-hoc-metered response can overshoot the cap by at most one bounded
    //    request (spec §5). The proxy canonicalises the body (step 6), so this
    //    clamp is guaranteed to reach upstream.
    if (budget?.maxOutputTokens !== undefined) {
      const ceiling = budget.maxOutputTokens;
      const requested = parsedObj['max_tokens'];
      parsedObj['max_tokens'] =
        typeof requested === 'number' && requested > 0 ? Math.min(requested, ceiling) : ceiling;
    }

    // 5. Attach the provider key from Vault. Never surfaced to the caller.
    const providerKey = await resolveProviderKey(policy.provider);
    if (!providerKey) {
      fail(res, 500, 'devplatform.provider_key_unavailable', 'no provider key configured');
      return;
    }

    // 6. Forward the CANONICAL body (re-serialised from the parsed object, with
    //    content-length recomputed by fetch). `?beta=true` (and any other
    //    query) is preserved.
    const queryIdx = req.originalUrl.indexOf('?');
    const query = queryIdx === -1 ? '' : req.originalUrl.slice(queryIdx);
    const upstreamUrl = `${policy.upstreamBaseUrl.replace(/\/+$/, '')}/v1/messages${query}`;
    const headers = buildForwardHeaders(req, providerKey);
    const streamed = parsedObj['stream'] === true;
    const forwardBody = Buffer.from(JSON.stringify(parsedObj), 'utf8');

    await proxyUpstream({
      res,
      job,
      model,
      streamed,
      upstreamUrl,
      headers,
      body: forwardBody,
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

    // Status + headers pass through verbatim (Retry-After on 429 included). Under
    // W4 budget enforcement a billable (2xx) body is metered BEFORE it is
    // committed, so header/status writes are deferred to `copyStatusHeaders`,
    // called only once the budget decision is known.
    const copyStatusHeaders = (): void => {
      res.status(upstream!.status);
      upstream!.headers.forEach((value, key) => {
        if (!STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) res.setHeader(key, value);
      });
    };

    if (!upstream.body) {
      copyStatusHeaders();
      res.end();
      return;
    }

    const contentType = (upstream.headers.get('content-type') ?? '').toLowerCase();
    const isSse = contentType.includes('text/event-stream');

    // Non-stream ERROR bodies are buffered and defensively scrubbed of the
    // provider key before they reach the container: an upstream/intermediary
    // that reflects the request (incl. the injected key) into an error payload
    // must not hand it to the job. Not metered (no usage), so budget enforcement
    // never engages here. Success bodies stream/deliver verbatim (below).
    if (!isSse && upstream.status >= 400) {
      copyStatusHeaders();
      let errBody = Buffer.from(await upstream.arrayBuffer());
      if (providerKey.length > 0) {
        const scrubbed = errBody.toString('utf8').split(providerKey).join('[REDACTED]');
        errBody = Buffer.from(scrubbed, 'utf8');
      }
      res.removeHeader('content-length');
      res.end(errBody);
      return;
    }

    // W4: a billable (2xx) response under an active budget hook is metered and
    // enforced BEFORE delivery, so the call that crosses the cap can itself
    // answer 402 (spec §5). Without a budget hook the W1 stream-through path runs.
    if (budget !== undefined) {
      await proxyMeteredEnforced({
        res,
        job,
        model,
        body: upstream.body as AsyncIterable<Uint8Array>,
        providerKey,
        isSse,
        copyStatusHeaders,
      });
      return;
    }

    copyStatusHeaders();
    const acc = newUsage();
    const decoder = new TextDecoder();
    let sseBuffer = '';
    let jsonBuffer = '';
    let truncated = false;
    // Redact the provider key from every byte written downstream (incl. streamed
    // SSE error events an upstream might echo it into). A rolling window holds
    // back the last N-1 bytes so the secret cannot be split across two chunks.
    const redactor = new StreamRedactor(providerKey);

    try {
      for await (const chunk of upstream.body as AsyncIterable<Uint8Array>) {
        const buf = Buffer.from(chunk);
        // Meter on the RAW upstream bytes (the key never appears in usage JSON),
        // then write the REDACTED bytes to the client.
        const text = decoder.decode(buf, { stream: true });
        if (isSse) sseBuffer = drainSse(acc, sseBuffer + text);
        else jsonBuffer += text;
        const safe = redactor.push(buf);
        if (safe.length > 0) await writeChunk(res, safe);
      }
      const tail = redactor.flush();
      if (tail.length > 0) await writeChunk(res, tail);
    } catch (err) {
      // Mid-stream disconnect: keep whatever usage we accumulated; note the
      // truncation. Best-effort flush of the redactor's retained tail so the
      // client is not shorted the (already redacted) bytes we held back.
      truncated = true;
      log(`[dev-llm] stream truncated for job ${job.id}: ${errText(err)}`);
      try {
        const tail = redactor.flush();
        if (tail.length > 0) await writeChunk(res, tail);
      } catch {
        /* client already gone — nothing to flush to */
      }
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

  /**
   * W4 metered + enforced delivery of a billable (2xx) response. The upstream
   * body is fully consumed and redacted into a bounded buffer (the `max_tokens`
   * clamp caps its size), usage is accumulated, then the budget hook meters and
   * enforces BEFORE anything is written to the client:
   *
   *   - crossed  ⇒ the buffered body is discarded and the in-flight call is
   *     answered `402 dev.budget_exceeded`. The hook has already marked the job
   *     `budget_exceeded` (finalize) and terminated the backend. The provider was
   *     still billed for this one request — the accepted single-request overshoot.
   *   - under budget ⇒ the redacted body is delivered verbatim.
   *
   * A mid-stream upstream disconnect meters the partial usage and delivers the
   * partial bytes when not over budget (matching the W1 truncation contract).
   */
  async function proxyMeteredEnforced(args: {
    res: Response;
    job: LlmProxyJob;
    model: string;
    body: AsyncIterable<Uint8Array>;
    providerKey: string;
    isSse: boolean;
    copyStatusHeaders: () => void;
  }): Promise<void> {
    const { res, job, model, body, isSse, copyStatusHeaders } = args;
    const acc = newUsage();
    const decoder = new TextDecoder();
    let sseBuffer = '';
    let jsonBuffer = '';
    let truncated = false;
    const redactor = new StreamRedactor(args.providerKey);
    const chunks: Buffer[] = [];
    let bytesRead = 0;

    try {
      for await (const chunk of body) {
        const buf = Buffer.from(chunk);
        // Hard independent byte ceiling (Forge W4 audit #2): the enforced path
        // BUFFERS the whole response to meter it before committing, so a hostile job
        // that sets a huge `max_tokens` could OOM the middleware. The `max_tokens`
        // clamp normally bounds this, but it is an OPTIONAL wire dep — this ceiling
        // is the defense-in-depth backstop that does NOT depend on wire discipline.
        bytesRead += buf.length;
        if (bytesRead > MAX_ENFORCED_BUFFER_BYTES) {
          truncated = true;
          log(`[dev-llm] enforced response for job ${job.id} exceeded ${String(MAX_ENFORCED_BUFFER_BYTES)}B; truncating to bound memory`);
          break;
        }
        // Meter on the RAW upstream bytes; buffer the REDACTED bytes for delivery.
        const text = decoder.decode(buf, { stream: true });
        if (isSse) sseBuffer = drainSse(acc, sseBuffer + text);
        else jsonBuffer += text;
        const safe = redactor.push(buf);
        if (safe.length > 0) chunks.push(safe);
      }
      const tail = redactor.flush();
      if (tail.length > 0) chunks.push(tail);
    } catch (err) {
      truncated = true;
      log(`[dev-llm] stream truncated for job ${job.id}: ${errText(err)}`);
      try {
        const tail = redactor.flush();
        if (tail.length > 0) chunks.push(tail);
      } catch {
        /* nothing retained */
      }
    }

    if (!isSse && jsonBuffer.length > 0) {
      try {
        const parsed = JSON.parse(jsonBuffer) as Record<string, unknown>;
        applyUsage(acc, parsed['usage']);
      } catch {
        /* non-JSON / partial body — nothing to meter */
      }
    }

    // Meter + enforce (post-hoc, but BEFORE the response is committed). The hook
    // never throws into the proxy; a metering failure fails OPEN (delivers the
    // response) rather than 402-ing a legitimate call.
    let decision: LlmProxyBudgetDecision = { exceeded: false };
    if (acc.seen) {
      decision = await budget!.meter({
        jobId: job.id,
        model,
        usage: {
          inputTokens: acc.inputTokens,
          outputTokens: acc.outputTokens,
          cacheReadTokens: acc.cacheReadTokens,
          cacheCreationTokens: acc.cacheCreationTokens,
        },
      });
    }

    if (decision.exceeded) {
      fail(res, 402, 'dev.budget_exceeded', 'job LLM budget exhausted');
      return;
    }

    copyStatusHeaders();
    try {
      for (const c of chunks) await writeChunk(res, c);
    } catch (err) {
      // Client vanished mid-delivery — nothing more to do; usage is already metered.
      log(`[dev-llm] client write failed for job ${job.id}: ${errText(err)}`);
    }
    res.end();
    if (truncated) log(`[dev-llm] delivered partial (truncated) metered response for job ${job.id}`);
  }

  return router;
}

/** Build the upstream request headers from an ALLOWLIST (not a scrub-list), then
 *  attach the provider key as `x-api-key`. Any header not explicitly allowed —
 *  cookies, `x-forwarded-*`, `proxy-authorization`, the client's own auth, and
 *  all hop-by-hop headers — never reaches upstream. */
function buildForwardHeaders(req: Request, providerKey: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Headers named by the `Connection` header are hop-by-hop and MUST be stripped
  // by a proxy (RFC 7230 §6.1). A client that writes `Connection: anthropic-beta`
  // must not have `Anthropic-Beta` forwarded even though it is allowlisted.
  const connectionNamed = new Set<string>();
  const conn = req.headers['connection'];
  const connValues = Array.isArray(conn) ? conn : conn === undefined ? [] : [conn];
  for (const cv of connValues) {
    for (const token of cv.split(',')) {
      const name = token.trim().toLowerCase();
      if (name) connectionNamed.add(name);
    }
  }
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (connectionNamed.has(lower)) continue; // hop-by-hop per the Connection header
    if (!FORWARDED_REQUEST_HEADERS.has(lower)) continue;
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
