/**
 * Epic #470 W1 — the daemon's client for the egress proxy's control plane (spec §6).
 *
 * The proxy is default-deny and knows nothing about a job until the daemon tells
 * it. That registration is the ONLY place a job's allowlist enters the proxy: the
 * proxy never takes an allowlist from the job container itself. So this client is
 * the missing half of the egress design — without it every runner's first request
 * is answered `407 bad_auth`, and the fail-closed proxy fails closed on everything.
 *
 * Two rules shape the code below:
 *
 *   - REGISTER BEFORE THE CONTAINER STARTS. A container that boots before its
 *     registration exists races its own first fetch against the control call.
 *   - A REGISTRATION OUTLIVES EVERY LEASE. Its TTL is the job's daemon-owned hard
 *     deadline, not its lease: a lease is renewed every ~TTL/3, and hanging egress
 *     off that cadence would mean one missed refresh silently blackholes a running
 *     job. The container cannot outlive the hard deadline (the reaper enforces it),
 *     so a registration keyed to that deadline can never expire under a live job,
 *     and can never outlive a dead one by more than the reaper's own margin.
 *
 * The proxy token is minted per job by the daemon, handed to the proxy here and to
 * the container as proxy credentials — it is a capability naming ONE job's
 * allowlist, so it never leaves those two places.
 */

import { withDeadline } from './deadline.mjs';

const DEFAULT_TIMEOUT_MS = 5_000;

/** A control-plane call that did not succeed. Fail-closed: the caller must abort the job. */
export class ProxyControlError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {number} [httpStatus]
   */
  constructor(code, message, httpStatus) {
    super(message);
    this.name = 'ProxyControlError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/**
 * @typedef {object} ProxyClient
 * @property {(jobId: string, entry: { allowlist: readonly string[], proxyToken: string, ttlSec: number }) => Promise<void>} register
 * @property {(jobId: string) => Promise<boolean>} unregister
 */

/**
 * @param {{ controlUrl: string, token: string, fetchImpl?: typeof fetch, timeoutMs?: number }} deps
 * @returns {ProxyClient}
 */
export function createProxyClient(deps) {
  if (typeof deps.controlUrl !== 'string' || deps.controlUrl.trim() === '') {
    throw new ProxyControlError('proxy.control_url_required', 'createProxyClient requires a control URL');
  }
  if (typeof deps.token !== 'string' || deps.token.trim() === '') {
    throw new ProxyControlError('proxy.control_token_required', 'createProxyClient requires a bearer token');
  }
  let base;
  try {
    base = new URL(deps.controlUrl);
  } catch {
    throw new ProxyControlError('proxy.control_url_invalid', `not a URL: '${deps.controlUrl}'`);
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new ProxyControlError('proxy.control_url_invalid', `unsupported scheme '${base.protocol}'`);
  }
  const origin = base.origin;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  /**
   * @param {string} method
   * @param {string} jobId
   * @param {unknown} [body]
   * @returns {Promise<{ status: number, json: unknown }>}
   */
  async function call(method, jobId, body) {
    const url = `${origin}/jobs/${encodeURIComponent(jobId)}`;
    const controller = new AbortController();
    const run = (async () => {
      const res = await fetchImpl(url, {
        method,
        // A redirect off this origin would send the bearer token — and the job's
        // allowlist — somewhere the operator never named.
        redirect: 'error',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${deps.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      let json = null;
      try {
        json = await res.json();
      } catch {
        json = null;
      }
      return { status: res.status, json };
    })();
    try {
      return await withDeadline(run, timeoutMs, () => controller.abort());
    } catch (err) {
      throw new ProxyControlError(
        'proxy.control_unreachable',
        `${method} ${url} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    async register(jobId, entry) {
      const { status, json } = await call('PUT', jobId, {
        allowlist: entry.allowlist,
        proxyToken: entry.proxyToken,
        ttlSec: entry.ttlSec,
      });
      if (status !== 200) {
        const code = typeof (/** @type {any} */ (json)?.code) === 'string' ? json.code : 'proxy.control_rejected';
        throw new ProxyControlError(code, `proxy refused the registration for job ${jobId} (HTTP ${status})`, status);
      }
    },

    async unregister(jobId) {
      // Best-effort by contract, but never silent: the caller logs. A registration
      // the daemon fails to remove expires on its own at the job's hard deadline.
      const { status, json } = await call('DELETE', jobId);
      if (status !== 200) {
        throw new ProxyControlError('proxy.control_rejected', `proxy refused to unregister job ${jobId} (HTTP ${status})`, status);
      }
      return Boolean(/** @type {any} */ (json)?.deleted);
    },
  };
}
