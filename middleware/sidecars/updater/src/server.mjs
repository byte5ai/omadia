/**
 * omadia updater sidecar — HTTP control plane (#432, slice 4).
 *
 * Security posture (this is the component the security review is about):
 *   - never published to a host port; reachable only on the compose network
 *   - every route except `/healthz` requires a shared bearer token, compared
 *     in constant time
 *   - refuses to start without that token (see config.mjs)
 *   - talks to a docker-socket-proxy with a narrow endpoint allowlist, never
 *     to `/var/run/docker.sock`
 *   - target versions must be release tags; floating tags are rejected
 *
 * Wire contract (mirrored by `middleware/src/update/updaterClient.ts`):
 *   GET  /healthz  → 200 {"ok":true}                        (unauthenticated)
 *   GET  /status   → 200 UpdaterStatus
 *   POST /update   → 202 {"accepted":true} | 409 | 400
 */

import http from 'node:http';
import os from 'node:os';
import { timingSafeEqual } from 'node:crypto';

import { isValidTargetVersion, loadConfig } from './config.mjs';
import { createDockerApi } from './dockerApi.mjs';
import { createEngine } from './engine/index.mjs';
import { assertEnvFileUsable } from './envFile.mjs';
import { createFlyApi } from './flyApi.mjs';
import { detectComposeProject, runUpdate } from './updateJob.mjs';

const MAX_STEPS = 200;

/** In-memory job state. Deliberately not persisted: the sidecar outlives the
 *  update, and the durable record is the middleware's `update_audit` table. */
function createState() {
  return {
    state: 'idle',
    targetVersion: null,
    previousVersion: null,
    startedAt: null,
    finishedAt: null,
    error: null,
    steps: [],
    /** Current step of the job (`UpdatePhase` in updateJob.mjs); null while
     *  idle. Lets the admin page render a stepper instead of parsing `steps`. */
    phase: null,
    /** Structured reason for a non-`succeeded` outcome (`UpdateFailure`);
     *  null while idle, updating, or after success. */
    failure: null,
  };
}

/** @param {string} a @param {string} b */
function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** @param {import('node:http').IncomingMessage} req @param {string} token */
function isAuthorized(req, token) {
  const header = req.headers['authorization'];
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  return safeEqual(header.slice('Bearer '.length).trim(), token);
}

function readJsonBody(req, limitBytes = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('payload_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.trim().length === 0) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid_json'));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * @param {{ config?: any, docker?: any, runUpdateImpl?: typeof runUpdate,
 *           detectProjectImpl?: typeof detectComposeProject, hostname?: string }} [deps]
 */
export function createServer(deps = {}) {
  const config = deps.config ?? loadConfig();
  const onFly = config.engine === 'fly';
  const docker =
    deps.docker ?? (onFly ? null : createDockerApi(config.dockerApiUrl));
  const flyApi =
    deps.flyApi ??
    (onFly
      ? createFlyApi({
          baseUrl: config.flyApiUrl,
          tokenFor: (app) => config.flyTokens[app] ?? '',
        })
      : null);
  const runUpdateImpl = deps.runUpdateImpl ?? runUpdate;
  const detectProjectImpl = deps.detectProjectImpl ?? detectComposeProject;
  const hostname = deps.hostname ?? os.hostname();

  let status = createState();

  const log = (message) => {
    const line = `${new Date().toISOString()} ${message}`;
    // eslint-disable-next-line no-console -- sidecar logs go to the container log
    console.log(`[updater] ${line}`);
    status.steps.push(line);
    if (status.steps.length > MAX_STEPS) status.steps.shift();
  };

  async function startUpdate(targetVersion) {
    status = {
      ...createState(),
      state: 'updating',
      targetVersion,
      previousVersion: status.targetVersion,
      startedAt: new Date().toISOString(),
    };
    try {
      // The compose project is a docker-engine concern; on Fly the app names
      // come from config and there is nothing to detect.
      let project = '';
      if (!onFly) {
        project = config.composeProject ?? (await detectProjectImpl(docker, hostname));
        log(`compose project: ${project}`);
      }
      const engine =
        deps.engine ?? createEngine({ config, docker, flyApi, project });
      log(`engine: ${engine.kind}`);
      const result = await runUpdateImpl({
        engine,
        config,
        targetVersion,
        log,
        setPhase: (phase) => { status.phase = phase; },
      });
      status.state = result.ok
        ? 'succeeded'
        : result.rolledBack
          ? 'rolled_back'
          : 'failed';
      status.error = result.error ?? null;
      status.failure = result.failure ?? null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`update aborted: ${message}`);
      status.state = 'failed';
      status.error = message;
    } finally {
      status.finishedAt = new Date().toISOString();
    }
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://updater.local');

    if (req.method === 'GET' && url.pathname === '/healthz') {
      send(res, 200, { ok: true });
      return;
    }

    if (!isAuthorized(req, config.token)) {
      send(res, 401, { error: 'unauthorized' });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/status') {
      // Capabilities travel with the status so the admin page can warn about
      // what this platform cannot do — on Fly the chosen version is not
      // persisted, and hiding that would be the dishonest option.
      send(res, 200, {
        ...status,
        engine: config.engine,
        pinPersisted: !onFly,
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/update') {
      if (status.state === 'updating') {
        send(res, 409, { error: 'update_in_progress' });
        return;
      }
      readJsonBody(req)
        .then((body) => {
          const target = typeof body?.targetVersion === 'string'
            ? body.targetVersion.trim()
            : '';
          if (!isValidTargetVersion(target)) {
            send(res, 400, { error: 'invalid_target_version' });
            return;
          }
          // Accept, then run detached: the update recreates the middleware
          // that is waiting on this response, so holding the connection open
          // would only guarantee it dies mid-flight.
          send(res, 202, { accepted: true, targetVersion: target });
          void startUpdate(target);
        })
        .catch((err) => {
          send(res, 400, { error: err instanceof Error ? err.message : 'bad_request' });
        });
      return;
    }

    send(res, 404, { error: 'not_found' });
  });

  return { server, config, getStatus: () => status };
}

// Entrypoint — skipped when imported by tests.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const { server, config } = createServer();
  // Fail fast on the pin target: an unusable .env mount would otherwise be
  // discovered mid-update, after images have been pulled and before anything
  // has been recreated. Only the docker engine has a pin file at all.
  if (config.engine !== 'fly') {
    await assertEnvFileUsable(config.envFilePath).catch((err) => {
      console.error(`[updater] ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
  }
  server.listen(config.port, () => {
    // eslint-disable-next-line no-console -- boot banner
    console.log(
      `[updater] listening on :${config.port} (services=${config.services.join(',')}, env=${config.envFilePath})`,
    );
  });
}
