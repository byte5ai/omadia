/**
 * Minimal Docker Engine API client (#432).
 *
 * Talks HTTP to a **docker-socket-proxy**, never to `/var/run/docker.sock`
 * directly — the whole point of the sidecar design is that the one component
 * with host-root-equivalent reach is a proxy whose allowlist is visible in the
 * compose overlay, not a mounted socket inside an application container.
 *
 * Node builtins only. Adding a Docker SDK here would give this container a
 * transitive dependency surface, and it is the last container in the stack
 * where that is acceptable.
 */

import http from 'node:http';

/** @typedef {{ statusCode: number, body: string }} RawResponse */

export class DockerApiError extends Error {
  /** @param {string} message @param {number} [status] */
  constructor(message, status) {
    super(message);
    this.name = 'DockerApiError';
    this.status = status;
  }
}

/**
 * @param {string} baseUrl e.g. `http://docker-socket-proxy:2375`
 * @param {{ timeoutMs?: number }} [opts]
 */
export function createDockerApi(baseUrl, opts = {}) {
  const base = new URL(baseUrl);
  const timeoutMs = opts.timeoutMs ?? 60_000;

  /**
   * @param {string} method
   * @param {string} path
   * @param {unknown} [body]
   * @param {{ timeoutMs?: number }} [callOpts]
   * @returns {Promise<RawResponse>}
   */
  function raw(method, path, body, callOpts = {}) {
    return new Promise((resolve, reject) => {
      const payload =
        body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = http.request(
        {
          protocol: base.protocol,
          hostname: base.hostname,
          port: base.port,
          method,
          path,
          headers: {
            accept: 'application/json',
            ...(payload
              ? {
                  'content-type': 'application/json',
                  'content-length': String(payload.byteLength),
                }
              : {}),
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
        req.destroy(new DockerApiError(`docker api timeout on ${method} ${path}`));
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  /**
   * @param {string} method
   * @param {string} path
   * @param {unknown} [body]
   * @param {{ timeoutMs?: number }} [callOpts]
   * @returns {Promise<any>}
   */
  async function json(method, path, body, callOpts) {
    const res = await raw(method, path, body, callOpts);
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new DockerApiError(
        `docker api ${method} ${path} → ${res.statusCode}: ${res.body.slice(0, 400)}`,
        res.statusCode,
      );
    }
    if (res.body.length === 0) return null;
    try {
      return JSON.parse(res.body);
    } catch {
      // `/images/create` answers with newline-delimited progress JSON, not a
      // single document. Callers that need the stream use `raw` directly; for
      // everyone else an unparseable body is simply "no payload".
      return null;
    }
  }

  return {
    raw,
    json,

    /** @returns {Promise<any>} */
    ping() {
      return json('GET', '/_ping');
    },

    /**
     * @param {Record<string, string[]>} filters
     * @returns {Promise<any[]>}
     */
    async listContainers(filters) {
      const query = new URLSearchParams({
        all: '1',
        filters: JSON.stringify(filters),
      });
      return (await json('GET', `/containers/json?${query.toString()}`)) ?? [];
    },

    /** @param {string} id @returns {Promise<any>} */
    inspectContainer(id) {
      return json('GET', `/containers/${encodeURIComponent(id)}/json`);
    },

    /** @param {string} nameOrRef @returns {Promise<any>} */
    inspectImage(nameOrRef) {
      return json('GET', `/images/${encodeURIComponent(nameOrRef)}/json`);
    },

    /**
     * Pull `repo:tag`. The endpoint streams newline-delimited progress and
     * only reports failure INSIDE that stream (the HTTP status is 200 even for
     * an unknown tag), so the body is scanned for an error object — a silent
     * pull failure would otherwise be discovered as a container that cannot
     * start, after the old one is already gone.
     *
     * @param {string} repo
     * @param {string} tag
     * @param {number} [pullTimeoutMs]
     */
    async pullImage(repo, tag, pullTimeoutMs = 15 * 60_000) {
      const query = new URLSearchParams({ fromImage: repo, tag });
      const res = await raw(
        'POST',
        `/images/create?${query.toString()}`,
        undefined,
        { timeoutMs: pullTimeoutMs },
      );
      if (res.statusCode < 200 || res.statusCode >= 300) {
        throw new DockerApiError(
          `pull ${repo}:${tag} → ${res.statusCode}: ${res.body.slice(0, 400)}`,
          res.statusCode,
        );
      }
      for (const line of res.body.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        let parsed;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          continue;
        }
        if (parsed && typeof parsed === 'object' && 'error' in parsed) {
          throw new DockerApiError(
            `pull ${repo}:${tag} failed: ${String(parsed.error).slice(0, 400)}`,
          );
        }
      }
    },

    /** @param {string} id @param {number} [seconds] */
    stopContainer(id, seconds = 20) {
      return raw(
        'POST',
        `/containers/${encodeURIComponent(id)}/stop?t=${seconds}`,
        undefined,
        { timeoutMs: (seconds + 20) * 1000 },
      ).then((res) => {
        // 304 = already stopped; that is success for our purposes.
        if (res.statusCode === 304) return;
        if (res.statusCode < 200 || res.statusCode >= 300) {
          throw new DockerApiError(
            `stop ${id} → ${res.statusCode}: ${res.body.slice(0, 200)}`,
            res.statusCode,
          );
        }
      });
    },

    /** @param {string} id */
    async removeContainer(id) {
      const res = await raw('DELETE', `/containers/${encodeURIComponent(id)}`);
      if (res.statusCode === 404) return;
      if (res.statusCode < 200 || res.statusCode >= 300) {
        throw new DockerApiError(
          `remove ${id} → ${res.statusCode}: ${res.body.slice(0, 200)}`,
          res.statusCode,
        );
      }
    },

    /** @param {string} name @param {unknown} config @returns {Promise<string>} */
    async createContainer(name, config) {
      const created = await json(
        'POST',
        `/containers/create?name=${encodeURIComponent(name)}`,
        config,
      );
      if (!created || typeof created.Id !== 'string') {
        throw new DockerApiError(`create ${name} returned no container id`);
      }
      return created.Id;
    },

    /** @param {string} id */
    async startContainer(id) {
      const res = await raw('POST', `/containers/${encodeURIComponent(id)}/start`);
      if (res.statusCode === 304) return;
      if (res.statusCode < 200 || res.statusCode >= 300) {
        throw new DockerApiError(
          `start ${id} → ${res.statusCode}: ${res.body.slice(0, 400)}`,
          res.statusCode,
        );
      }
    },

    /** @param {string} networkId @param {string} containerId @param {unknown} endpointConfig */
    async connectNetwork(networkId, containerId, endpointConfig) {
      await json('POST', `/networks/${encodeURIComponent(networkId)}/connect`, {
        Container: containerId,
        EndpointConfig: endpointConfig,
      });
    },
  };
}
