/**
 * Docker engine for the updater (#432) — the compose executor, unchanged in
 * behaviour, moved behind the engine interface so a second platform can exist
 * (#696).
 *
 * Everything platform-independent — ordering, the health gate, rollback, the
 * protected list — stays in `updateJob.mjs`. What lives here is only the four
 * things that are genuinely different per platform: how a service is found,
 * how its image is fetched ahead of time, how the version pin is persisted,
 * and how one instance is replaced.
 */

import { pinVersion, restoreVersion } from '../envFile.mjs';
import { recreateContainer, splitImageRef } from '../recreate.mjs';

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
 * @param {{ docker: any, config: any, project: string }} deps
 * @returns {import('./index.mjs').UpdateEngine}
 */
export function createDockerEngine({ docker, config, project }) {
  return {
    kind: 'docker',

    // The compose stack owns its own `.env`, and the updater writes it — which
    // is what stops the operator's next `docker compose up -d` from silently
    // reverting the version they just chose.
    canPersistPin: true,

    async resolveTarget(service) {
      const inspect = await findServiceContainer(docker, project, service);
      const currentImage = inspect?.Config?.Image ?? '';
      const { repo } = splitImageRef(currentImage);
      if (repo.length === 0) {
        throw new Error(`service "${service}" has no resolvable image reference`);
      }
      return { service, currentImage, repo, handle: inspect };
    },

    async preflight(targets, targetVersion, log) {
      // Pull everything up front: a typo'd tag or a registry outage has to be
      // discovered while every old container is still running.
      for (const target of targets) {
        log(`pulling ${target.newImage}`);
        await docker.pullImage(target.repo, targetVersion);
      }
      log('all images pulled');
    },

    async pin(targetVersion) {
      const { previous } = await pinVersion(config.envFilePath, targetVersion);
      return previous;
    },

    async restorePin(previous) {
      await restoreVersion(config.envFilePath, previous);
    },

    pinDescription() {
      return config.envFilePath;
    },

    async replace(target, image, log) {
      await recreateContainer(docker, target.handle, image, log);
    },
  };
}
