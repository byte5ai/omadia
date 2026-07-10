/**
 * Epic #470 W1 — egress-proxy policy engine (spec §6).
 *
 * THE PROXY IS THE ONLY PATH FROM A JOB CONTAINER TO THE WORLD. Everything this
 * engine lets through is what a hostile agent inside the container can reach, so
 * every decision here is default-deny and every allowlist is built, never
 * scrubbed (hard-won lesson (b)).
 *
 * This module is the PURE, socket-free core: the per-job allowlist registry, the
 * connect-time decision function, the post-resolution rebinding classifier, and
 * the batched event client. `proxy.mjs` owns the sockets and calls into here so
 * the whole policy surface is testable as plain functions (and the socket layer
 * is still driven over REAL sockets in its own test — lesson (g)).
 *
 * Two lessons are load-bearing in the shapes below:
 *   (a) Canonicalise, THEN classify. `parseAuthority` runs the target through the
 *       WHATWG URL parser so a numeric/hex/octal IPv4 spelling, a trailing-dot
 *       FQDN, an IPv4-mapped or bracketed IPv6 literal are all reduced to their
 *       canonical host BEFORE the allowlist is consulted — a validator that
 *       matched spellings would check text while the socket resolved an address.
 *   (c) A guard that inspects one representation while forwarding another is not a
 *       guard. `decideRequest` judges a single canonical host; `proxy.mjs`
 *       resolves THAT host once and pins the socket to the vetted IP
 *       `classifyResolvedAddresses` returns — no re-resolution between check and
 *       connect (TOCTOU / DNS-rebinding).
 *   (d) Never trust caller-supplied policy. The allowlist enters this module ONLY
 *       through `JobRegistry.register`, which the daemon calls over the
 *       bearer-authed control plane from the policy IT fetched from the
 *       middleware — never from the job on the data plane.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

import { classifyEgressEntry, isInternalIp } from './netClassify.mjs';

/** Ports the proxy will dial by default (spec §6 rule 3: "443 or an explicitly
 *  listed port"). 443 for CONNECT/TLS, 80 for absolute-form plain HTTP. The
 *  middleware host is reached on its own port via the internal-destination rule,
 *  which bypasses this gate. */
export const DEFAULT_ALLOWED_PORTS = Object.freeze([80, 443]);

/** Hard cap on allowlist entries accepted for one job — a legitimate allowlist is
 *  a handful of hosts; a flood is a confused or hostile control-plane push. */
export const MAX_ALLOWLIST_ENTRIES = 512;

/**
 * Canonicalise a host the WHATWG URL parser hands back: strip IPv6 brackets, a
 * single trailing FQDN dot, and lowercase. The parser has already rewritten
 * numeric/hex/octal IPv4 and IPv4-mapped IPv6 to canonical form, so this only
 * tidies the residue.
 *
 * @param {string} hostname
 * @returns {string}
 */
function normalizeParsedHost(hostname) {
  const stripped = hostname.replace(/^\[|\]$/g, '');
  const noDot = stripped.endsWith('.') ? stripped.slice(0, -1) : stripped;
  return noDot.toLowerCase();
}

/**
 * Parse a CONNECT authority (`host:port`, `[ipv6]:port`, or bare `host`) into a
 * canonical `{ host, port }`. Runs the whole thing through `new URL` so every
 * IPv4/IPv6 spelling collapses to one canonical form BEFORE any policy check
 * (lesson (a)). Rejects an authority that smuggles userinfo, a path, a query or a
 * fragment — none belong in a CONNECT target and each is a parser-confusion lever.
 *
 * @param {unknown} authority
 * @param {number} defaultPort Port to assume when the authority omits one.
 * @returns {{ host: string, port: number } | null} null when unparseable/invalid.
 */
export function parseAuthority(authority, defaultPort) {
  if (typeof authority !== 'string' || authority.length === 0) return null;
  let u;
  try {
    u = new URL(`http://${authority}`);
  } catch {
    return null;
  }
  // userinfo, a path, a query, or a fragment in a CONNECT authority is malformed.
  if (u.username || u.password || u.search || u.hash) return null;
  if (u.pathname !== '/' && u.pathname !== '') return null;
  const host = normalizeParsedHost(u.hostname);
  if (!host) return null;
  const port = u.port ? Number(u.port) : defaultPort;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host, port };
}

/**
 * Canonicalise a hostname already extracted from a WHATWG URL (the absolute-form
 * plain-HTTP path). Same normalisation as `parseAuthority` so both data-plane
 * shapes classify identically.
 *
 * @param {string} hostname
 * @returns {string}
 */
export function canonicalizeHost(hostname) {
  return normalizeParsedHost(hostname);
}

/**
 * Compile an allowlist (bare hosts + `*.suffix` wildcards) into an exact-match set
 * and a suffix list — CANONICALISED, so the proxy matches exactly the host it will
 * resolve. A bare entry is validated by `classifyEgressEntry` (the same classifier
 * the daemon keeps in lockstep with the middleware); a `*.suffix` entry validates
 * its suffix the same way. Any invalid entry throws — the control-plane push has
 * already been validated middleware-side, so a bad entry reaching the proxy is a
 * confused or hostile pusher and fails loudly (lesson (b): build allowlists, never
 * silently drop from them).
 *
 * @param {readonly unknown[]} entries
 * @returns {{ exact: Set<string>, suffixes: string[] }}
 */
export function compileAllowlist(entries) {
  if (!Array.isArray(entries)) throw new Error('allowlist must be an array');
  if (entries.length > MAX_ALLOWLIST_ENTRIES) {
    throw new Error(`allowlist exceeds the ${MAX_ALLOWLIST_ENTRIES}-entry cap`);
  }
  /** @type {Set<string>} */
  const exact = new Set();
  /** @type {string[]} */
  const suffixes = [];
  for (const raw of entries) {
    if (typeof raw !== 'string') throw new Error('allowlist entry is not a string');
    const trimmed = raw.trim();
    if (trimmed.startsWith('*.')) {
      const rest = trimmed.slice(2);
      const classified = classifyEgressEntry(rest);
      if ('reject' in classified) {
        throw new Error(`invalid wildcard allowlist entry (${classified.reject})`);
      }
      suffixes.push(classified.host);
    } else {
      const classified = classifyEgressEntry(trimmed);
      if ('reject' in classified) {
        throw new Error(`invalid allowlist entry (${classified.reject})`);
      }
      exact.add(classified.host);
    }
  }
  return { exact, suffixes };
}

/**
 * Does a canonical host match a compiled allowlist? Exact set membership, or a
 * `*.suffix` wildcard that requires at least one leading label (`*.example.com`
 * matches `a.example.com`, never bare `example.com`) — no regex, no substring.
 *
 * @param {string} host Canonical (lowercased, de-bracketed, de-dotted) host.
 * @param {{ exact: Set<string>, suffixes: readonly string[] }} compiled
 * @returns {boolean}
 */
export function hostMatchesAllowlist(host, compiled) {
  if (compiled.exact.has(host)) return true;
  for (const suffix of compiled.suffixes) {
    if (host.endsWith(`.${suffix}`)) return true;
  }
  return false;
}

/** Constant-time string equality (hash both sides to a fixed width so neither the
 *  proxy token's length nor its bytes leak through timing — same construction the
 *  daemon's bearer auth uses).
 *  @param {string} a @param {string} b @returns {boolean} */
function timingSafeStrEqual(a, b) {
  const ah = createHash('sha256').update(a, 'utf8').digest();
  const bh = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ah, bh);
}

/**
 * The per-job allowlist registry. The daemon PUTs a job's effective allowlist +
 * one-time proxy token here over the bearer-authed control plane before the
 * container starts; the data plane reads it on every CONNECT. Registrations
 * SELF-EXPIRE at their lease TTL so a dead daemon cannot leave a job authorised
 * forever (spec §6 control plane). The clock is injectable for tests.
 */
export class JobRegistry {
  /** @param {{ now?: () => number }} [opts] */
  constructor(opts = {}) {
    /** @type {() => number} */
    this._now = opts.now ?? (() => Date.now());
    /** @type {Map<string, { allowlist: { exact: Set<string>, suffixes: string[] }, proxyToken: string, expiresAt: number }>} */
    this._jobs = new Map();
  }

  /**
   * Register (or replace) a job's egress authorisation. Compiles + canonicalises
   * the allowlist up front so a malformed entry is rejected here, not discovered
   * mid-connect.
   *
   * @param {string} jobId
   * @param {{ allowlist: readonly unknown[], proxyToken: string, ttlSec: number }} entry
   * @returns {{ expiresAt: number }}
   */
  register(jobId, entry) {
    if (typeof jobId !== 'string' || jobId.length === 0) throw new Error('jobId is required');
    if (typeof entry.proxyToken !== 'string' || entry.proxyToken.length === 0) {
      throw new Error('proxyToken is required');
    }
    if (!Number.isFinite(entry.ttlSec) || entry.ttlSec <= 0) throw new Error('ttlSec must be positive');
    const allowlist = compileAllowlist(entry.allowlist);
    const expiresAt = this._now() + entry.ttlSec * 1000;
    this._jobs.set(jobId, { allowlist, proxyToken: entry.proxyToken, expiresAt });
    return { expiresAt };
  }

  /**
   * Look up a live registration. An expired one is pruned and reported absent, so
   * the data plane never authorises against a stale lease.
   *
   * @param {string} jobId
   * @returns {{ allowlist: { exact: Set<string>, suffixes: string[] }, proxyToken: string, expiresAt: number } | null}
   */
  get(jobId) {
    const record = this._jobs.get(jobId);
    if (!record) return null;
    if (record.expiresAt <= this._now()) {
      this._jobs.delete(jobId);
      return null;
    }
    return record;
  }

  /** @param {string} jobId @returns {boolean} true if a registration was removed. */
  delete(jobId) {
    return this._jobs.delete(jobId);
  }

  /** Drop every expired registration (called on a timer by the proxy). */
  prune() {
    const now = this._now();
    for (const [jobId, record] of this._jobs) {
      if (record.expiresAt <= now) this._jobs.delete(jobId);
    }
  }

  /** @returns {number} live (non-pruned) registration count. */
  size() {
    return this._jobs.size;
  }
}

/**
 * Parse a `Proxy-Authorization: Basic base64(jobId:proxyToken)` header into its
 * two parts. Returns null on any malformation — the caller maps that to a 407.
 *
 * @param {unknown} header
 * @returns {{ jobId: string, proxyToken: string } | null}
 */
export function parseProxyAuthorization(header) {
  if (typeof header !== 'string') return null;
  const m = /^Basic[ ]+(\S+)$/i.exec(header.trim());
  if (!m || !m[1]) return null;
  let decoded;
  try {
    decoded = Buffer.from(m[1], 'base64').toString('utf8');
  } catch {
    return null;
  }
  const idx = decoded.indexOf(':');
  if (idx < 0) return null;
  const jobId = decoded.slice(0, idx);
  const proxyToken = decoded.slice(idx + 1);
  if (!jobId || !proxyToken) return null;
  return { jobId, proxyToken };
}

/**
 * @typedef {object} Decision
 * @property {'allow' | 'deny'} decision
 * @property {number} status HTTP status the data plane should answer with.
 * @property {string | null} reason Stable non-sensitive slug (`bad_auth`,
 *   `port_not_allowed`, `not_allowlisted`, …); null on allow.
 * @property {boolean} allowInternal When true, the resolved-IP internal check is
 *   skipped — the single deliberate internal destination (the middleware) whose
 *   address is legitimately RFC1918.
 * @property {'internal' | 'allowlist' | null} matched Which rule allowed it.
 */

/**
 * The connect-time policy decision (spec §6 decision order). PURE: no DNS, no
 * sockets — it judges the CANONICAL host/port against the job's registration and
 * says allow or deny. DNS resolution + rebinding classification happen AFTER an
 * allow, in `proxy.mjs`, against exactly the host judged here (lesson (c)).
 *
 *   1. No / bad proxy auth, or unknown/expired job, or wrong token → 407 bad_auth.
 *   2. Target is the single internal destination (middleware host:port) → allow,
 *      allowInternal (its RFC1918 address is expected, not a rebind).
 *   3. Port not in the allowed set → 403 port_not_allowed.
 *   4. Host on the job's effective allowlist → allow.
 *   5. Everything else → 403 not_allowlisted.
 *
 * @param {{ jobId?: string | undefined, proxyToken?: string | undefined, host: string, port: number }} req
 * @param {{ registry: JobRegistry, internalHost?: string | undefined, internalPort?: number | undefined, allowedPorts: ReadonlySet<number> }} ctx
 * @returns {Decision}
 */
export function decideRequest(req, ctx) {
  // 1. Auth. Constant-time token compare; an absent job and a wrong token are the
  //    SAME 407 so the data plane cannot be used to enumerate live jobIds.
  if (!req.jobId || !req.proxyToken) {
    return { decision: 'deny', status: 407, reason: 'bad_auth', allowInternal: false, matched: null };
  }
  const record = ctx.registry.get(req.jobId);
  if (!record || !timingSafeStrEqual(req.proxyToken, record.proxyToken)) {
    return { decision: 'deny', status: 407, reason: 'bad_auth', allowInternal: false, matched: null };
  }

  // 2. The single deliberate internal destination (exact host:port match). Its
  //    address is legitimately internal, so allowInternal skips the rebind check.
  if (
    ctx.internalHost !== undefined &&
    ctx.internalPort !== undefined &&
    req.host === ctx.internalHost &&
    req.port === ctx.internalPort
  ) {
    return { decision: 'allow', status: 200, reason: null, allowInternal: true, matched: 'internal' };
  }

  // 3. Port gate for everything else.
  if (!ctx.allowedPorts.has(req.port)) {
    return { decision: 'deny', status: 403, reason: 'port_not_allowed', allowInternal: false, matched: null };
  }

  // 4. Allowlist match.
  if (hostMatchesAllowlist(req.host, record.allowlist)) {
    return { decision: 'allow', status: 200, reason: null, allowInternal: false, matched: 'allowlist' };
  }

  // 5. Default deny.
  return { decision: 'deny', status: 403, reason: 'not_allowlisted', allowInternal: false, matched: null };
}

/**
 * @typedef {{ address: string, family?: number }} ResolvedAddress
 */

/**
 * Rebinding defence (spec §6 rule 4). After the proxy resolves the vetted host it
 * classifies EVERY returned address: if any is internal/metadata per
 * `isInternalIp`, the whole connection is refused — an allowlisted name that
 * resolves to `169.254.169.254` or an RFC1918 address is a rebind, not a
 * destination. On success it pins to a single vetted IP so the socket connects to
 * exactly the address that was checked, never a re-resolution (lesson (c)). The
 * one internal destination (the middleware) passes `allowInternal` and skips the
 * internal check.
 *
 * @param {readonly ResolvedAddress[]} addresses
 * @param {{ allowInternal?: boolean }} [opts]
 * @returns {{ ok: true, pinnedIp: string, family: number | undefined } | { ok: false, reason: 'internal_ip' | 'no_address' }}
 */
export function classifyResolvedAddresses(addresses, opts = {}) {
  if (!Array.isArray(addresses) || addresses.length === 0) return { ok: false, reason: 'no_address' };
  if (!opts.allowInternal) {
    for (const a of addresses) {
      if (typeof a?.address !== 'string' || isInternalIp(a.address)) {
        return { ok: false, reason: 'internal_ip' };
      }
    }
  }
  const first = addresses[0];
  if (typeof first?.address !== 'string') return { ok: false, reason: 'no_address' };
  return { ok: true, pinnedIp: first.address, family: first.family };
}

/**
 * @typedef {object} EgressEvent
 * @property {string} jobId
 * @property {string} ts ISO timestamp.
 * @property {string} verb `CONNECT` or the HTTP method.
 * @property {string} host Canonical target host — NEVER a URL path.
 * @property {number} port
 * @property {'allow' | 'deny' | 'close'} decision
 * @property {string | null} reason
 * @property {string | null} resolvedIp
 * @property {number} bytesIn
 * @property {number} bytesOut
 * @property {number} durationMs
 */

/**
 * Batched event client → the middleware's phone-home surface (spec §6). Flushes
 * every `flushIntervalMs` or at `maxBatch`, and IMMEDIATELY on any `deny` so a
 * refusal is never delayed behind a batch window. The POST is bounded + pinned
 * exactly like `policyClient` (redirect:'error', one abort signal spanning the
 * whole request); a flush failure is logged and dropped — audit is best-effort and
 * must never wedge the data plane.
 *
 * NOTE (spec §6 / this unit's acceptance): the middleware route this posts to
 * (`POST /api/v1/dev/internal/egress-events`) is NOT built in this unit. The
 * client is defined and wired here per instruction; the middleware surface is a
 * separate deliverable. Events carry ONLY hostnames/ports/decisions — never a URL
 * path, header, body, or credential — so a token can never leak into the log.
 *
 * @param {{ url?: string | undefined, token?: string | undefined, fetchImpl?: typeof fetch, now?: () => number, flushIntervalMs?: number, maxBatch?: number, timeoutMs?: number, logger?: { warn?: (m: string) => void } }} deps
 */
export function createEventClient(deps) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const flushIntervalMs = deps.flushIntervalMs ?? 2000;
  const maxBatch = deps.maxBatch ?? 100;
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const logger = deps.logger ?? console;
  const url = deps.url;
  const token = deps.token;
  /** @type {EgressEvent[]} */
  const queue = [];
  /** @type {NodeJS.Timeout | undefined} */
  let timer;

  function cancelTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  function schedule() {
    if (timer) return;
    // Batch timer is unref'd: it must never keep the process alive on its own (the
    // listening servers do that), and it is NOT a connection deadline — those
    // (idle/absolute) live in proxy.mjs and are deliberately kept referenced.
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, flushIntervalMs);
    timer.unref?.();
  }

  /** @param {readonly EgressEvent[]} batch */
  async function postBatch(batch) {
    if (!url || !token) return; // not configured — audit disabled, data plane unaffected.
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      await fetchImpl(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ events: batch }),
        signal: controller.signal,
        redirect: 'error',
      });
    } catch (err) {
      logger.warn?.(`[dev-egress-proxy] event flush failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(t);
    }
  }

  async function flush() {
    cancelTimer();
    if (queue.length === 0) return;
    const batch = queue.splice(0, queue.length);
    await postBatch(batch);
  }

  /** @param {EgressEvent} event */
  function record(event) {
    queue.push(event);
    if (event.decision === 'deny' || queue.length >= maxBatch) {
      void flush();
    } else {
      schedule();
    }
  }

  return {
    record,
    flush,
    /** Stop the batch timer (test/shutdown teardown). */
    stop() {
      cancelTimer();
    },
    get queueLength() {
      return queue.length;
    },
  };
}
