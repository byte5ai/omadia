/**
 * The update itself (#432, slice 4).
 *
 * Sequencing is the safety property here, so it is spelled out rather than
 * inferred:
 *
 *   1. resolve every target container FIRST — an unknown service aborts before
 *      anything is touched
 *   2. pull EVERY new image before stopping ANY container — a typo'd tag or a
 *      GHCR outage must not be discovered halfway through, with the middleware
 *      already deleted
 *   3. pin the version in the project `.env`, so the operator's next manual
 *      `docker compose up -d` does not silently revert the stack
 *   4. recreate in the configured order (middleware before web-ui: web-ui's
 *      `depends_on` health condition applies at `up`, and this ordering keeps
 *      the UI's backend present when it comes back)
 *   5. gate on the middleware's `/health` REPORTING THE NEW VERSION
 *   6. on failure, roll every recreated container back to its previous image
 *      and restore the previous `.env` pin
 *
 * What rollback does NOT undo: schema migrations. The kernel migrations under
 * `middleware/migrations/` are forward-only and are applied automatically at
 * boot by the harness-orchestrator plugin, so a rolled-back image can meet a
 * migrated database. That is documented in docs/upgrading.md as the reason to
 * snapshot the volume before a major bump; it is not something this sidecar
 * can honestly promise away.
 */

import { PROTECTED_SERVICES } from './config.mjs';
import { pinVersion, restoreVersion } from './envFile.mjs';
import { waitForHealthyVersion } from './health.mjs';
import { recreateContainer, splitImageRef } from './recreate.mjs';

/**
 * Find the one container for a compose service.
 *
 * @param {any} docker
 * @param {string} project
 * @param {string} service
 */
async function findServiceContainer(docker, project, service) {
  const list = await docker.listContainers({
    label: [
      `com.docker.compose.project=${project}`,
      `com.docker.compose.service=${service}`,
    ],
  });
  if (list.length === 0) {
    throw new Error(`no container found for compose service "${service}"`);
  }
  if (list.length > 1) {
    // Scaled services are out of scope: recreating one replica of N with a
    // different image is a rolling deploy, not what a single-instance
    // self-hosted stack means by "update".
    throw new Error(
      `compose service "${service}" has ${list.length} containers — scaled services are not supported`,
    );
  }
  return docker.inspectContainer(list[0].Id);
}

/**
 * Resolve the compose project name from the updater's own container labels,
 * so the operator does not have to repeat what compose already knows.
 *
 * @param {any} docker
 * @param {string} hostname
 */
export async function detectComposeProject(docker, hostname) {
  const self = await docker.inspectContainer(hostname);
  const project = self?.Config?.Labels?.['com.docker.compose.project'];
  if (typeof project !== 'string' || project.length === 0) {
    throw new Error(
      'could not detect the compose project from this container — set UPDATER_COMPOSE_PROJECT',
    );
  }
  return project;
}

/**
 * @param {{
 *   docker: any,
 *   config: any,
 *   targetVersion: string,
 *   project: string,
 *   log: (msg: string) => void,
 *   healthWaiter?: typeof waitForHealthyVersion,
 * }} opts
 * @returns {Promise<{ ok: boolean, rolledBack: boolean, error?: string }>}
 */
export async function runUpdate(opts) {
  const {
    docker,
    config,
    targetVersion,
    project,
    log,
    healthWaiter = waitForHealthyVersion,
  } = opts;

  // 1 — resolve targets before touching anything.
  const targets = [];
  for (const service of config.services) {
    if (PROTECTED_SERVICES.includes(service) || service === config.selfService) {
      throw new Error(`refusing to update protected service "${service}"`);
    }
    const inspect = await findServiceContainer(docker, project, service);
    const currentRef = inspect?.Config?.Image ?? '';
    const { repo } = splitImageRef(currentRef);
    if (repo.length === 0) {
      throw new Error(`service "${service}" has no resolvable image reference`);
    }
    targets.push({ service, inspect, repo, newImage: `${repo}:${targetVersion}` });
    log(`resolved ${service}: ${currentRef} → ${repo}:${targetVersion}`);
  }

  // 2 — pull everything up front.
  for (const target of targets) {
    log(`pulling ${target.newImage}`);
    await docker.pullImage(target.repo, targetVersion);
  }
  log('all images pulled');

  // 3 — persist the pin so a later `docker compose up -d` agrees with reality.
  let previousPin = null;
  try {
    ({ previous: previousPin } = await pinVersion(config.envFilePath, targetVersion));
    log(`pinned OMADIA_VERSION=${targetVersion} in ${config.envFilePath}`);
  } catch (err) {
    throw new Error(
      `could not write ${config.envFilePath}: ${err instanceof Error ? err.message : String(err)} — refusing to update, the change would be reverted by the next 'docker compose up -d'`,
    );
  }

  // 4 — recreate.
  const recreated = [];
  try {
    for (const target of targets) {
      const { previousImage } = await recreateContainer(
        docker,
        target.inspect,
        target.newImage,
        log,
      );
      recreated.push({ service: target.service, previousImage });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`recreate failed: ${message}`);
    await rollback({ docker, config, project, recreated, previousPin, log });
    return { ok: false, rolledBack: true, error: message };
  }

  // 5 — health gate on the NEW version.
  log(`waiting for ${config.healthUrl} to report ${targetVersion}`);
  const health = await healthWaiter({
    url: config.healthUrl,
    expectVersion: targetVersion,
    timeoutMs: config.healthTimeoutMs,
    log,
  });
  if (health.ok) {
    log(`health gate passed (${health.reason})`);
    return { ok: true, rolledBack: false };
  }

  // 6 — revert.
  const reason = `health gate failed: ${health.reason} (observed version: ${health.observedVersion ?? 'none'})`;
  log(reason);
  await rollback({ docker, config, project, recreated, previousPin, log });
  return { ok: false, rolledBack: true, error: reason };
}

/**
 * Best-effort restore of every container this run replaced, in reverse order.
 * Rollback failures are logged and swallowed: one service that refuses to come
 * back must not stop the others from being restored.
 */
async function rollback({ docker, config, project, recreated, previousPin, log }) {
  log('rolling back');
  try {
    await restoreVersion(config.envFilePath, previousPin);
    log(`restored OMADIA_VERSION pin to ${previousPin ?? '(unset)'}`);
  } catch (err) {
    log(`could not restore ${config.envFilePath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  for (const entry of [...recreated].reverse()) {
    try {
      const inspect = await findServiceContainer(docker, project, entry.service);
      await recreateContainer(docker, inspect, entry.previousImage, log);
      log(`rolled ${entry.service} back to ${entry.previousImage}`);
    } catch (err) {
      log(
        `rollback of ${entry.service} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
