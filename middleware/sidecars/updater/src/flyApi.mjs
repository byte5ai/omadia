/**
 * Minimal Fly.io Machines API client (#696).
 *
 * Node builtins only, same rule as `dockerApi.mjs`: this container is the one
 * that can replace every other container in the stack, so it carries no
 * dependency tree at all.
 *
 * Unlike the Docker path there is no socket and no proxy — this is an
 * authenticated call to `api.machines.dev` over the public internet, with an
 * **app-scoped** deploy token. That is a narrower capability than the compose
 * design has: a mounted Docker socket is host-root-equivalent and
 * all-or-nothing, whereas this token is limited to one app, carries an expiry
 * and can be revoked.
 */

import https from 'node:https';
import http from 'node:http';

export class FlyApiError extends Error {
  /** @param {string} message @param {number} [status] */
  constructor(message, status) {
    super(message);
    this.name = 'FlyApiError';
    this.status = status;
  }
}

/**
 * The header Fly gates writes to a leased Machine on. One definition, used by
 * both the write path and the release path, so the two can never drift.
 *
 * @param {string} nonce
 * @returns {Record<string, string>}
 */
const LEASE_HEADER = (nonce) => ({ 'fly-machine-lease-nonce': nonce });

/** Hard ceiling Fly enforces on `/wait?timeout=` — `[1s, 1m0s]`, 400 above it. */
const FLY_MAX_WAIT_SECONDS = 60;

/**
 * @param {{ baseUrl?: string, tokenFor: (app: string) => string, timeoutMs?: number }} opts
 */
export function createFlyApi(opts) {
  const base = new URL(opts.baseUrl ?? 'https://api.machines.dev');
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const transport = base.protocol === 'http:' ? http : https;

  /**
   * @param {string} app  used to pick the app-scoped token
   * @param {string} method
   * @param {string} path
   * @param {unknown} [body]
   * @param {{ timeoutMs?: number, headers?: Record<string, string> }} [callOpts]
   * @returns {Promise<{ statusCode: number, body: string }>}
   */
  function raw(app, method, path, body, callOpts = {}) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = transport.request(
        {
          protocol: base.protocol,
          hostname: base.hostname,
          ...(base.port ? { port: base.port } : {}),
          method,
          path,
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${opts.tokenFor(app)}`,
            ...(payload
              ? {
                  'content-type': 'application/json',
                  'content-length': String(payload.byteLength),
                }
              : {}),
            // Per-call headers last: a lease nonce must be able to ride along
            // on writes to a leased Machine. Without a way to send it here the
            // caller's nonce has nowhere to go and Fly rejects the write with
            // 409 "lease currently held by" — its own lease.
            ...(callOpts.headers ?? {}),
          },
          timeout: callOpts.timeoutMs ?? timeoutMs,
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            resolve({
              statusCode: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
            });
          });
        },
      );
      req.on('timeout', () => {
        req.destroy(new FlyApiError(`fly api timeout on ${method} ${path}`));
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  /**
   * @param {string} app @param {string} method @param {string} path
   * @param {unknown} [body]
   * @param {{ timeoutMs?: number, headers?: Record<string, string> }} [callOpts]
   * @returns {Promise<any>}
   */
  async function json(app, method, path, body, callOpts) {
    const res = await raw(app, method, path, body, callOpts);
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new FlyApiError(
        `fly api ${method} ${path} → ${res.statusCode}: ${res.body.slice(0, 400)}`,
        res.statusCode,
      );
    }
    if (res.body.length === 0) return null;
    try {
      return JSON.parse(res.body);
    } catch {
      return null;
    }
  }

  return {
    /** @param {string} app @returns {Promise<any[]>} */
    async listMachines(app) {
      return (await json(app, 'GET', `/v1/apps/${encodeURIComponent(app)}/machines`)) ?? [];
    },

    /** @param {string} app @param {string} id @returns {Promise<any>} */
    getMachine(app, id) {
      return json(
        app,
        'GET',
        `/v1/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(id)}`,
      );
    },

    /**
     * Update a Machine.
     *
     * `config` is REQUIRED and REPLACES the machine configuration — sending a
     * hand-built object silently drops `mounts`, `checks`, `services`, `env`
     * and `restart`. Callers must pass the config they just read back with the
     * single field they mean to change. `current_version` makes a concurrent
     * change fail loudly instead of being overwritten.
     *
     * `leaseNonce` is REQUIRED whenever the Machine is leased — which is the
     * normal case here, because `replace()` leases it first. It travels as the
     * `fly-machine-lease-nonce` header, not in the body.
     *
     * @param {string} app @param {string} id
     * @param {{ config: any, currentVersion?: string, leaseNonce?: string }} input
     */
    async updateMachine(app, id, input) {
      return json(
        app,
        'POST',
        `/v1/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(id)}`,
        {
          config: input.config,
          ...(input.currentVersion !== undefined ? { current_version: input.currentVersion } : {}),
        },
        {
          timeoutMs: 5 * 60_000,
          // Writing to a LEASED Machine requires the lease nonce. Omitting it
          // makes Fly answer 409 "lease currently held by …" — and since the
          // caller takes the lease itself moments earlier, the updater ends up
          // blocked by its own lease and every update rolls back.
          ...(input.leaseNonce ? { headers: LEASE_HEADER(input.leaseNonce) } : {}),
        },
      );
    },

    /**
     * Block until a Machine reaches a state. The caller still runs its own
     * health gate afterwards, because "started" only means the VM booted, not
     * that the new build is serving.
     *
     * Fly rejects a `timeout` above 60s outright:
     * `400 invalid WaitMachineRequest.Timeout: value must be inside range
     * [1s, 1m0s]`. Asking for more does not get you a longer wait, it gets you
     * no wait at all — which is how a 120s default turned every update into a
     * failed one. So the request is capped at the API's maximum and re-issued
     * until the caller's own budget runs out.
     *
     * A wait that returns without reaching the state is not an error, so the
     * machine is re-read and its state checked explicitly rather than trusting
     * the endpoint's timeout semantics.
     *
     * @param {string} app @param {string} id @param {string} state @param {number} [seconds]
     */
    async waitForState(app, id, state, seconds = 120) {
      const budgetMs = Math.max(1, seconds) * 1000;
      const startedAt = Date.now();
      let lastError = null;

      for (;;) {
        const remainingS = Math.ceil((budgetMs - (Date.now() - startedAt)) / 1000);
        if (remainingS <= 0) break;

        const slice = Math.min(FLY_MAX_WAIT_SECONDS, remainingS);
        const query = new URLSearchParams({ state, timeout: String(slice) });
        try {
          await json(
            app,
            'GET',
            `/v1/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(id)}/wait?${query.toString()}`,
            undefined,
            { timeoutMs: (slice + 30) * 1000 },
          );
        } catch (err) {
          lastError = err;
        }

        const machine = await json(
          app,
          'GET',
          `/v1/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(id)}`,
        );
        if (machine?.state === state) return;
      }

      throw new FlyApiError(
        `machine ${app}/${id} did not reach "${state}" within ${seconds}s` +
          (lastError instanceof Error ? `: ${lastError.message}` : ''),
      );
    },

    /** @param {string} app @param {string} id @param {number} ttlSeconds */
    async acquireLease(app, id, ttlSeconds) {
      const res = await json(
        app,
        'POST',
        `/v1/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(id)}/lease?ttl=${ttlSeconds}`,
      );
      const nonce = res?.data?.nonce ?? res?.nonce;
      return typeof nonce === 'string' ? nonce : null;
    },

    /**
     * Hand the lease back.
     *
     * Not cosmetic: an unreleased lease keeps blocking writes for the rest of
     * its TTL, so a failed run would lock the machine against its own retry
     * (and against a human running `fly deploy`) for minutes afterwards.
     * Releasing also needs the nonce — a lease can only be dropped by whoever
     * holds it.
     *
     * @param {string} app @param {string} id @param {string} nonce
     */
    async releaseLease(app, id, nonce) {
      await json(
        app,
        'DELETE',
        `/v1/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(id)}/lease`,
        undefined,
        { headers: LEASE_HEADER(nonce) },
      );
    },
  };
}
