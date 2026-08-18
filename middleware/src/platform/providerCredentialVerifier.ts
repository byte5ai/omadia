/**
 * Provider credential VERIFICATION — "does this API key actually work?".
 *
 * Before this module, "connected" meant nothing more than "the vault holds a
 * non-empty string for this provider". A stale shell key seeded from
 * `ANTHROPIC_API_KEY` at first boot therefore rendered as a green "connected"
 * badge while every chat turn failed with `invalid x-api-key` — the operator had
 * no way to tell the difference. This module supplies the missing signal: a
 * cheap, free, wire-format-keyed probe against the provider's `models`
 * endpoint, plus a cache so the admin dashboard can render the verdict without
 * ever touching the network itself.
 *
 * Design constraints (all load-bearing):
 *  - **Only 401 means "bad key".** A 5xx, a rate-limit, a DNS failure or an
 *    air-gapped install must read as `unverified`, NEVER as `invalid` — an
 *    outage must not accuse the operator of holding a broken credential. 403 is
 *    NOT a credential verdict either: OpenAI answers 403 for "Country, region,
 *    or territory not supported" and Anthropic for org-permission and region
 *    blocks, none of which mean the key is wrong. The one exception is a 403
 *    whose body explicitly self-identifies as an authentication error.
 *  - **A 2xx alone does not mean "verified".** An operator behind a corporate
 *    proxy gets `200 text/html` block pages for non-allowlisted hosts, which
 *    would render a bogus key as a green badge. A success verdict therefore
 *    requires a JSON content type AND a body that actually parses as a model
 *    list. The body read is byte-bounded and shares the probe's abort signal so
 *    a huge or slow body can neither hang nor outlive the probe.
 *  - **The probe never follows a redirect.** `redirect: 'error'` — the Fetch
 *    spec strips `Authorization` on a cross-origin redirect but NOT custom
 *    headers, so a followed redirect would hand the raw `x-api-key` to whatever
 *    host the redirect names.
 *  - **Read paths never probe.** `GET /api/v1/admin/providers` serves the cached
 *    verdict only (same contract `detectCliBackends()` already honours there).
 *    Probing on read would make the dashboard slow, rate-limitable and
 *    network-dependent.
 *  - **Cache shape mirrors `cliBackendDetector.ts`** — module-level map, TTL,
 *    `force` bypass, and a `__clearVerificationCache()` test seam.
 *  - The cached verdict is bound to a fingerprint of the key it was produced
 *    for, so a replaced key can never be served a stale `verified`. The
 *    fingerprint is part of the cache KEY, not a field checked after lookup:
 *    two vault scopes holding different keys for one provider id must coexist,
 *    not evict each other on every read.
 *
 * The desktop wizard carries a pre-boot twin of this probe in
 * `desktop/src/ipc.ts` (`testLlmKey`). It cannot import this module — the
 * Electron shell and the middleware are separate builds — so the two are kept
 * intentionally identical in behaviour instead of shared. Change one, change
 * the other.
 */
import { createHash } from 'node:crypto';

/** Verification verdict for one provider's stored credential. */
export type ProviderCredentialStatus =
  | 'no_key'
  | 'unverified'
  | 'verified'
  | 'invalid';

/**
 * Machine-readable reason an inconclusive probe stayed `unverified`. Deliberately
 * a CODE and not a sentence: the web-ui owns all user-facing copy in
 * `web-ui/messages/{en,de}.json`, so the server must never ship an untranslated
 * English string into the UI. Today nothing renders this — it exists so the
 * verdict is diagnosable in logs and so a future UI can map it to a localized
 * string without a second server change.
 */
export type ProviderVerificationReason =
  /** HTTP 403 — permission or region restriction, NOT a wrong key. */
  | 'forbidden'
  /** 2xx whose content type was not JSON (captive portal / proxy block page). */
  | 'non_json_response'
  /** 2xx JSON that did not look like a model list, or an unreadable body. */
  | 'unexpected_body'
  /** Any other non-2xx: 5xx, rate limit, gateway hiccup. */
  | 'http_error'
  /** Transport-level failure: timeout, DNS, offline, or a refused redirect. */
  | 'network_error'
  /** No cheap probe exists for this wire format (e.g. `claude-cli`). */
  | 'no_probe';

export interface ProviderVerification {
  readonly status: ProviderCredentialStatus;
  /** ISO timestamp of the last SUCCESSFUL probe. Only set on `verified`. */
  readonly verifiedAt?: string;
  /** ISO timestamp of the last probe ATTEMPT, whatever its outcome. */
  readonly checkedAt?: string;
  /** User-facing explanation. Only set on `invalid` — `web-ui`'s ProvidersPanel
   *  renders it verbatim and only for that status, so an `unverified` verdict
   *  must carry its reason in {@link reason}, never here. */
  readonly error?: string;
  /** Why an `unverified` verdict came out inconclusive. Never rendered as-is. */
  readonly reason?: ProviderVerificationReason;
  /**
   * OM-09 — machine-readable counterpart to {@link error}. A CODE, never a
   * sentence, for the same reason {@link ProviderVerificationReason} is one:
   * web-ui owns all user-facing copy, and this process has no request locale,
   * so anything written here would be English in a German UI. Only the
   * `invalid` verdict sets it; `error` stays untouched as the fallback for a
   * client that predates the catalogue.
   */
  readonly code?: string;
}

/** Structural view of the provider catalog — avoids a hard dependency on the
 *  concrete `LlmProviderCatalog` class (and keeps tests trivial to stub). */
export interface ProviderCatalogView {
  get(id: string):
    | {
        readonly wireFormat?: string;
        readonly baseURL?: string;
        readonly policy?: { readonly requiresApiKey?: boolean };
      }
    | undefined;
}

export interface VerifyProviderCredentialOptions {
  readonly providerId: string;
  readonly apiKey: string;
  /** Wire format to probe. Falls back to the catalog descriptor's. */
  readonly wireFormat?: string;
  /** API base URL. Falls back to the catalog descriptor's, then a known default. */
  readonly baseURL?: string;
  /** `false` ⇒ local/self-hosted provider, verified without any network call.
   *  Falls back to the catalog descriptor's `policy.requiresApiKey`. */
  readonly requiresApiKey?: boolean;
  /** Optional catalog used to fill in the three fields above. */
  readonly catalog?: ProviderCatalogView;
  /** Bypass the cache (the UI's explicit "test key" action). */
  readonly force?: boolean;
  /** Injected for tests. Defaults to `globalThis.fetch`. */
  readonly fetchImpl?: typeof fetch;
}

/** Default base URLs per wire format, used when neither the caller nor the
 *  catalog supplies one. Mirrors the vendor SDK defaults. */
const DEFAULT_BASE_URL: Readonly<Record<string, string>> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  'openai-compatible': 'https://api.openai.com/v1',
};

const PROBE_TIMEOUT_MS = 10_000;

/** How long a verdict stays fresh in memory. Long enough that the dashboard
 *  never probes, short enough that a revoked key surfaces within minutes. */
export const CACHE_TTL_MS = 300_000;

/** Hard ceiling on cached verdicts. The map is keyed by key fingerprint, so a
 *  process that rotates credentials (or serves many vault scopes) would grow it
 *  without bound. Eviction is insertion-ordered (FIFO, refreshed on write), which
 *  is all a 300 s TTL needs. */
const MAX_CACHE_ENTRIES = 64;

interface CacheEntry {
  readonly verification: ProviderVerification;
  readonly expiresAt: number;
}

/** NUL — cannot occur in a provider id, so the prefix scan in
 *  {@link invalidate} can never match the wrong provider. */
const CACHE_KEY_SEP = String.fromCharCode(0);

/** `providerId <NUL> fingerprint`. The fingerprint belongs in the KEY, not in a
 *  field compared after lookup: keying on the provider id alone made two scopes
 *  holding different keys for one provider mutually evict each other on every
 *  read, so the TTL never took effect. */
function cacheKey(providerId: string, fingerprint: string): string {
  return `${providerId}${CACHE_KEY_SEP}${fingerprint}`;
}

const cache = new Map<string, CacheEntry>();

/** Non-reversible short fingerprint of a key — lets the cache detect that the
 *  operator replaced the credential without ever storing the credential. */
export function keyFingerprint(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
}

/** Vault sibling key holding the durable "last verified" record for a provider,
 *  so a successful probe survives a restart (the in-memory cache does not). */
export function providerVerifiedAtVaultKey(providerId: string): string {
  return `provider:${providerId}/verified_at`;
}

/** Inverse of `providerApiKeyVaultKey` — recovers the provider id from a
 *  canonical API-key vault key, or `undefined` for any other key. Lets the
 *  settings-write path invalidate the right provider without a new schema. */
export function providerIdFromApiKeyVaultKey(
  vaultKey: string,
): string | undefined {
  const m = /^provider:(.+)\/api_key$/.exec(vaultKey);
  return m?.[1];
}

/**
 * Encode a successful probe for durable storage. The fingerprint travels with
 * the timestamp so a restart can tell "this record belongs to the key currently
 * in the vault" from "this record predates a key change".
 */
export function encodeVerifiedRecord(
  verifiedAt: string,
  fingerprint: string,
): string {
  return JSON.stringify({ at: verifiedAt, fp: fingerprint });
}

/**
 * Decode a durable record written by {@link encodeVerifiedRecord}. Returns
 * `undefined` when the record is absent, unparseable, or was produced for a
 * DIFFERENT key than the one currently stored — all of which must degrade to
 * `unverified` rather than to a false `verified`.
 */
export function decodeVerifiedRecord(
  raw: string | undefined,
  apiKey: string,
): string | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const rec = parsed as { at?: unknown; fp?: unknown };
    if (typeof rec.at !== 'string' || typeof rec.fp !== 'string') {
      return undefined;
    }
    if (rec.fp !== keyFingerprint(apiKey)) return undefined;
    return rec.at;
  } catch {
    // Not JSON — a record from an older shape. Without a fingerprint we cannot
    // prove it belongs to the current key, so refuse to claim `verified`.
    return undefined;
  }
}

/**
 * The cached verdict for a provider, or `undefined` when nothing usable is
 * cached (never probed, expired, or cached against a different key). Pure read:
 * makes no network call, which is what lets the providers GET stay offline.
 */
export function getCachedVerification(
  providerId: string,
  apiKey: string,
): ProviderVerification | undefined {
  const key = cacheKey(providerId, keyFingerprint(apiKey));
  const entry = cache.get(key);
  if (entry === undefined) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return entry.verification;
}

/** Seed the cache from a durable record so a restart doesn't re-probe. */
export function primeVerification(
  providerId: string,
  apiKey: string,
  verification: ProviderVerification,
): void {
  const key = cacheKey(providerId, keyFingerprint(apiKey));
  // Delete-then-set so a refreshed entry moves to the back of the insertion
  // order and the FIFO eviction below never drops the hottest verdict.
  cache.delete(key);
  cache.set(key, { verification, expiresAt: Date.now() + CACHE_TTL_MS });
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done === true) break;
    cache.delete(oldest.value);
  }
}

/** Drop EVERY cached verdict for a provider, whichever key produced it. MUST be
 *  called wherever a provider key is written, so a replaced key can never serve
 *  a stale `verified` — and since the cache is keyed per fingerprint, dropping
 *  only the current key's entry would leave the previous key's verdict behind
 *  for a "revert to the old key" to inherit. */
export function invalidate(providerId: string): void {
  const prefix = `${providerId}${CACHE_KEY_SEP}`;
  for (const key of [...cache.keys()]) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

/** Test seam: clear the module-level cache. */
export function __clearVerificationCache(): void {
  cache.clear();
}

/** The vault operations the verdict lifecycle needs — structural, so this
 *  platform module never hard-depends on the secrets layer's `SecretVault`
 *  class (which satisfies this shape as-is). */
export interface VerificationVaultView {
  get(scope: string, key: string): Promise<string | undefined>;
  setMany(scope: string, entries: Record<string, string>): Promise<void>;
  deleteKey(scope: string, key: string): Promise<void>;
}

/**
 * The stored credential's verdict WITHOUT touching the network — the shared
 * read path behind every provider-admin GET (LLM, transcription, …):
 *   - a fresh cached probe for THIS key            → that verdict
 *   - a durable `verified_at` record for THIS key  → `verified` (and primed)
 *   - otherwise                                    → `unverified`
 *
 * `unverified` is the honest default: a key exists, but nothing has ever
 * proved it works. Callers own everything upstream of a stored key — the
 * keyless-provider policy short-circuit, the key lookup, and the `no_key`
 * verdict — because those genuinely differ per capability surface.
 */
export async function resolveStoredVerification(opts: {
  readonly vault: VerificationVaultView | undefined;
  /** Vault scope that owns the key AND its durable verdict record. */
  readonly scope: string;
  /** Cache + durable-record id (e.g. `openai`, `transcription:openai`). */
  readonly verificationId: string;
  readonly apiKey: string;
}): Promise<ProviderVerification> {
  const cached = getCachedVerification(opts.verificationId, opts.apiKey);
  if (cached !== undefined) return cached;

  // Cold cache (fresh process). A durable record proves an earlier probe
  // succeeded — but only if it was written for the key that is stored NOW.
  const raw = await opts.vault?.get(
    opts.scope,
    providerVerifiedAtVaultKey(opts.verificationId),
  );
  const verifiedAt = decodeVerifiedRecord(raw, opts.apiKey);
  if (verifiedAt !== undefined) {
    const verification: ProviderVerification = {
      status: 'verified',
      verifiedAt,
      checkedAt: verifiedAt,
    };
    primeVerification(opts.verificationId, opts.apiKey, verification);
    return verification;
  }
  return { status: 'unverified' };
}

/**
 * Force-probe a stored credential and persist the verdict — the shared write
 * path behind every provider-admin verify endpoint. On `verified` the record
 * goes to a vault sibling key so it survives a restart; on `invalid` that
 * record is deleted, so a revoked key cannot come back as `verified` after a
 * reboot. Written ONLY here and dropped on a key write — never on a read: the
 * vault is a single encrypted blob rewritten in full on every write.
 *
 * A vault write failure is logged, not thrown — the verdict itself is still
 * valid and cached in memory, and a persistence hiccup must not turn a
 * successful probe into an error response.
 */
export async function probeAndPersistVerification(opts: {
  readonly vault: VerificationVaultView | undefined;
  readonly scope: string;
  readonly verificationId: string;
  readonly apiKey: string;
  /** Probe parameters (wire format, base URL, key policy, test fetch). */
  readonly probe?: Omit<
    VerifyProviderCredentialOptions,
    'providerId' | 'apiKey' | 'force'
  >;
}): Promise<ProviderVerification> {
  const verification = await verifyProviderCredential({
    ...opts.probe,
    providerId: opts.verificationId,
    apiKey: opts.apiKey,
    force: true,
  });

  if (opts.vault) {
    const vaultKey = providerVerifiedAtVaultKey(opts.verificationId);
    try {
      if (verification.status === 'verified') {
        await opts.vault.setMany(opts.scope, {
          [vaultKey]: encodeVerifiedRecord(
            verification.verifiedAt ?? new Date().toISOString(),
            keyFingerprint(opts.apiKey),
          ),
        });
      } else if (verification.status === 'invalid') {
        await opts.vault.deleteKey(opts.scope, vaultKey);
      }
    } catch (err) {
      console.warn(
        `[providerCredentialVerifier] could not persist verification for ${opts.verificationId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return verification;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/** A model list is a few KB at most. Anything past this is not a model list —
 *  it is a proxy page, a stream, or an attempt to make the probe hang. */
const MAX_PROBE_BODY_BYTES = 64 * 1024;

/**
 * Read at most {@link MAX_PROBE_BODY_BYTES} of a response body, or `undefined`
 * when the body is absent, unreadable, or larger than the cap.
 *
 * Streams rather than `res.text()` so an endless body is cut off at the cap
 * instead of buffered whole. The read runs on the SAME `AbortSignal` as the
 * fetch: the signal already governs the body stream in undici, and the explicit
 * cancel below makes the intent survive a runtime that does not, so the probe
 * cannot outlive its timeout window by starting a fresh unbounded read.
 */
async function readBoundedBody(
  res: Response,
  signal: AbortSignal,
): Promise<string | undefined> {
  const body: ReadableStream<Uint8Array> | null = res.body;
  if (body === null) return undefined;
  const reader = body.getReader();
  const onAbort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal.aborted) return undefined;
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > MAX_PROBE_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  } catch {
    // Aborted mid-read, socket reset, malformed chunked encoding — all of which
    // mean "we learned nothing", never "the key is bad".
    return undefined;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** `true` only for a JSON media type. A corporate proxy's block page is
 *  `text/html`, and no provider's `models` endpoint answers with anything but
 *  JSON — so this alone kills the "200 HTML ⇒ verified" class of false green. */
function isJsonContentType(contentType: string | null): boolean {
  if (contentType === null) return false;
  const mime = (contentType.split(';')[0] ?? '').trim().toLowerCase();
  return mime === 'application/json' || mime === 'text/json' || mime.endsWith('+json');
}

/**
 * `true` when the parsed body actually looks like a model list: OpenAI and
 * Anthropic both answer `{ data: [...] }`, Ollama-style gateways `{ models: [...] }`,
 * and a few thin proxies a bare array. Anything else — including a JSON error
 * envelope served with a 200 — is not proof that the credential works.
 */
function looksLikeModelList(text: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (Array.isArray(parsed)) return true;
  if (typeof parsed !== 'object' || parsed === null) return false;
  const rec = parsed as Record<string, unknown>;
  return Array.isArray(rec['data']) || Array.isArray(rec['models']);
}

/** Anthropic answers a genuinely bad key on some routes with 403 + an explicit
 *  `authentication_error` marker. That — and only that — keeps the `invalid`
 *  verdict for a 403; every other 403 is a permission or region block. */
function isAuthenticationErrorBody(text: string | undefined): boolean {
  if (text === undefined) return false;
  return /"type"\s*:\s*"(authentication_error|invalid_api_key)"/.test(text);
}

/** Probe request for a wire format, or `undefined` when the format cannot be
 *  probed cheaply (e.g. `claude-cli`, which is not HTTP at all). */
function buildProbe(
  wireFormat: string | undefined,
  baseURL: string | undefined,
  apiKey: string,
): { url: string; headers: Record<string, string> } | undefined {
  const base =
    baseURL !== undefined && baseURL.trim().length > 0
      ? baseURL.trim()
      : DEFAULT_BASE_URL[wireFormat ?? ''];
  if (base === undefined) return undefined;

  if (wireFormat === 'anthropic') {
    // The Anthropic descriptor's baseURL is the bare host (no `/v1`), but a
    // gateway may already include it — normalise either shape.
    const root = /\/v1\/?$/.test(base) ? base : joinUrl(base, 'v1');
    return {
      url: `${joinUrl(root, 'models')}?limit=1`,
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    };
  }
  if (wireFormat === 'openai' || wireFormat === 'openai-compatible') {
    return {
      url: joinUrl(base, 'models'),
      headers: { Authorization: `Bearer ${apiKey}` },
    };
  }
  return undefined;
}

/** The one verdict that accuses the operator's key. `error` is the English
 *  fallback for a pre-OM-09 client; `code` is what a current web-ui resolves
 *  against its own localized catalogue. Nothing but a real rejection may set
 *  either. */
function rejected(status: number, checkedAt: string): ProviderVerification {
  return {
    status: 'invalid',
    checkedAt,
    code: 'providers.key_rejected',
    error: `The provider rejected this API key (HTTP ${String(status)}). Check the value in the provider's console and paste it again.`,
  };
}

/**
 * Turn a 2xx into a verdict. A 2xx on its own proves nothing: an operator behind
 * a corporate proxy gets `200 text/html` block pages for non-allowlisted hosts,
 * which is exactly how a bogus key used to earn a green badge while every chat
 * turn failed with `invalid x-api-key`. So `verified` requires a JSON content
 * type AND a body that parses as a model list; everything else is `unverified`,
 * never `invalid` — a proxy in the way is not a bad credential.
 */
async function interpretSuccess(
  res: Response,
  signal: AbortSignal,
  checkedAt: string,
): Promise<ProviderVerification> {
  if (!isJsonContentType(res.headers.get('content-type'))) {
    return { status: 'unverified', checkedAt, reason: 'non_json_response' };
  }
  const body = await readBoundedBody(res, signal);
  if (body === undefined || !looksLikeModelList(body)) {
    return { status: 'unverified', checkedAt, reason: 'unexpected_body' };
  }
  return { status: 'verified', verifiedAt: checkedAt, checkedAt };
}

/**
 * Probe a provider credential and cache the verdict.
 *
 * Mapping (non-negotiable — see the module header):
 *   2xx + JSON content type + a body that parses as a model list → `verified`
 *   2xx anything else (proxy block page, JSON error envelope)    → `unverified`
 *   401                                                          → `invalid`
 *   403 whose body self-identifies as an authentication error     → `invalid`
 *   403 otherwise (permission / region block)                     → `unverified`
 *   anything else, incl. network errors, timeouts and redirects   → `unverified`
 */
export async function verifyProviderCredential(
  opts: VerifyProviderCredentialOptions,
): Promise<ProviderVerification> {
  const { providerId, apiKey } = opts;
  const descriptor = opts.catalog?.get(providerId);

  if (apiKey.trim().length === 0) {
    return { status: 'no_key' };
  }

  const requiresApiKey =
    opts.requiresApiKey ?? descriptor?.policy?.requiresApiKey ?? true;
  const checkedAt = new Date().toISOString();

  // Local / self-hosted providers (Ollama, vLLM …) authenticate by being
  // reachable at all — there is no credential to reject, so never spend a
  // request on one.
  if (requiresApiKey === false) {
    const verification: ProviderVerification = {
      status: 'verified',
      verifiedAt: checkedAt,
      checkedAt,
    };
    primeVerification(providerId, apiKey, verification);
    return verification;
  }

  if (opts.force !== true) {
    const cached = getCachedVerification(providerId, apiKey);
    if (cached !== undefined) return cached;
  }

  const wireFormat = opts.wireFormat ?? descriptor?.wireFormat;
  const baseURL = opts.baseURL ?? descriptor?.baseURL;
  const probe = buildProbe(wireFormat, baseURL, apiKey);
  if (probe === undefined) {
    // No cheap probe exists for this wire format. Say so honestly rather than
    // guessing — and do NOT cache, so adding a probe later takes effect at once.
    return { status: 'unverified', checkedAt, reason: 'no_probe' };
  }

  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  let verification: ProviderVerification;
  try {
    // ONE signal for the request AND the body read: a bounded read on the same
    // deadline, not a fresh unbounded read after the timeout has been spent.
    const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
    const res = await doFetch(probe.url, {
      method: 'GET',
      headers: probe.headers,
      // A credential probe must never follow a redirect: the Fetch spec strips
      // `Authorization` cross-origin but NOT `x-api-key`, so `follow` would hand
      // the raw Anthropic key to whatever host the redirect names. `error` turns
      // any 3xx into a thrown TypeError, caught below as `unverified`.
      redirect: 'error',
      signal,
    });
    if (res.ok) {
      verification = await interpretSuccess(res, signal, checkedAt);
    } else if (res.status === 401) {
      verification = rejected(res.status, checkedAt);
    } else if (res.status === 403) {
      // NOT a credential verdict by default: OpenAI answers 403 for
      // "Country, region, or territory not supported" and Anthropic for
      // org-permission and region blocks. Only an explicit authentication
      // marker in the body earns `invalid`.
      const body = await readBoundedBody(res, signal);
      verification = isAuthenticationErrorBody(body)
        ? rejected(res.status, checkedAt)
        : { status: 'unverified', checkedAt, reason: 'forbidden' };
    } else {
      // 5xx, rate-limit, gateway hiccup — not the operator's fault.
      verification = { status: 'unverified', checkedAt, reason: 'http_error' };
    }
  } catch {
    // Timeout / DNS / offline install / refused redirect. Never accuse the key.
    verification = { status: 'unverified', checkedAt, reason: 'network_error' };
  }

  primeVerification(providerId, apiKey, verification);
  return verification;
}
