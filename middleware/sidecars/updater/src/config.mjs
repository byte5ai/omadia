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

/** `web-ui` → `WEB_UI`, so each app's config reads as its own env var and can
 *  be set with a plain `fly secrets set`. */
export function envSuffix(service) {
  return service.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

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

  const engine = (env.UPDATER_ENGINE ?? 'docker').trim();
  if (engine !== 'docker' && engine !== 'fly') {
    throw new Error(`UPDATER_ENGINE must be "docker" or "fly", got "${engine}"`);
  }

  // Fly needs a service→app mapping and a token per app. Both are validated
  // here rather than at update time: an operator finding out mid-update that
  // one of two apps has no token is the worst moment to find out.
  const flyApps = {};
  const flyTokens = {};
  if (engine === 'fly') {
    for (const service of services) {
      const app = (env[`UPDATER_FLY_APP_${envSuffix(service)}`] ?? '').trim();
      if (app.length === 0) {
        throw new Error(
          `UPDATER_FLY_APP_${envSuffix(service)} is required for service "${service}" when UPDATER_ENGINE=fly`,
        );
      }
      const appToken = (env[`UPDATER_FLY_TOKEN_${envSuffix(service)}`] ?? '').trim();
      if (appToken.length === 0) {
        throw new Error(
          `UPDATER_FLY_TOKEN_${envSuffix(service)} is required for service "${service}" — use an APP-SCOPED deploy token (fly tokens create deploy), never an org-wide one`,
        );
      }
      flyApps[service] = app;
      flyTokens[app] = appToken;
    }
  }

  return {
    token,
    engine,
    flyApps,
    flyTokens,
    flyApiUrl: env.UPDATER_FLY_API ?? 'https://api.machines.dev',
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
