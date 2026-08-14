/**
 * Updater sidecar configuration (#432).
 *
 * Fail-fast by design, like the other standalone sidecars in this tree: a
 * component that can replace every container in the stack must refuse to start
 * misconfigured rather than boot into a half-armed state. Specifically it will
 * not run without a shared token — an unauthenticated endpoint on the compose
 * network that recreates containers is a privilege-escalation primitive for
 * anything else that lands on that network.
 */

/** Services that must never be recreated by an update, whatever the config says.
 *  `postgres` owns the data volume: a recreate is a restart at best and, with a
 *  changed image, an in-place major-version upgrade of a database that has no
 *  backup here. Not this feature's job. */
export const PROTECTED_SERVICES = Object.freeze(['postgres', 'updater', 'docker-socket-proxy']);

const MIN_TOKEN_LENGTH = 16;

/**
 * @param {Record<string, string | undefined>} env
 * @returns {{
 *   token: string,
 *   dockerApiUrl: string,
 *   services: string[],
 *   composeProject: string | null,
 *   envFilePath: string,
 *   healthUrl: string,
 *   port: number,
 *   healthTimeoutMs: number,
 *   selfService: string,
 * }}
 */
export function loadConfig(env = process.env) {
  const token = (env.UPDATER_TOKEN ?? '').trim();
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(
      `UPDATER_TOKEN is required and must be at least ${MIN_TOKEN_LENGTH} characters — refusing to start an unauthenticated container-control endpoint`,
    );
  }

  const services = (env.UPDATER_SERVICES ?? 'middleware,web-ui')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (services.length === 0) {
    throw new Error('UPDATER_SERVICES resolved to an empty list');
  }

  const selfService = (env.UPDATER_SELF_SERVICE ?? 'updater').trim();
  const protectedHit = services.find(
    (s) => PROTECTED_SERVICES.includes(s) || s === selfService,
  );
  if (protectedHit !== undefined) {
    throw new Error(
      `UPDATER_SERVICES contains the protected service "${protectedHit}" — refusing to start`,
    );
  }

  return {
    token,
    dockerApiUrl: env.UPDATER_DOCKER_API ?? 'http://docker-socket-proxy:2375',
    services,
    composeProject: (env.UPDATER_COMPOSE_PROJECT ?? '').trim() || null,
    envFilePath: env.UPDATER_ENV_FILE ?? '/workspace/.env',
    healthUrl: env.UPDATER_HEALTH_URL ?? 'http://middleware:8080/health',
    port: Number.parseInt(env.UPDATER_PORT ?? '8090', 10),
    healthTimeoutMs: Number.parseInt(
      env.UPDATER_HEALTH_TIMEOUT_MS ?? String(5 * 60_000),
      10,
    ),
    selfService,
  };
}

/** Release tags only. The value becomes a Docker image tag and the rollback
 *  anchor, so floating tags (`latest`, `edge`, `sha-…`) are rejected here as
 *  well as in the middleware router — the sidecar must not depend on its
 *  caller having validated anything. */
const TAG_RE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** @param {unknown} value */
export function isValidTargetVersion(value) {
  return typeof value === 'string' && TAG_RE.test(value.trim());
}
