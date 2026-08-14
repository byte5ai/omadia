/**
 * The engine seam (#696).
 *
 * `updateJob.mjs` owns everything that is the same everywhere — the ordering
 * that makes a failure safe, the health gate on the *reported version*, the
 * rollback, the protected list. An engine owns only the four things that are
 * genuinely per-platform.
 *
 * @typedef {object} UpdateTarget
 * @property {string} service       compose service / logical name
 * @property {string} currentImage  full image ref running right now
 * @property {string} repo          image ref without the tag
 * @property {string} [newImage]    filled in by the job once the tag is known
 * @property {any} handle           engine-private (docker inspect / fly machine)
 *
 * @typedef {object} UpdateEngine
 * @property {'docker'|'fly'} kind
 * @property {boolean} canPersistPin
 *   Whether the chosen version survives the operator's next routine deploy.
 *   False on Fly, where `fly deploy` reads a local file the updater cannot
 *   reach — reported to the UI rather than papered over.
 * @property {(service: string) => Promise<UpdateTarget>} resolveTarget
 * @property {(targets: UpdateTarget[], targetVersion: string, log: (m: string) => void) => Promise<void>} preflight
 *   Must fail for an unavailable image BEFORE anything is replaced.
 * @property {(targetVersion: string) => Promise<string|null>} pin  returns the previous pin
 * @property {(previous: string|null) => Promise<void>} restorePin
 * @property {() => string|null} pinDescription  where the pin lives, for the log
 * @property {(target: UpdateTarget, image: string, log: (m: string) => void) => Promise<void>} replace
 */

import { createDockerEngine } from './docker.mjs';
import { createFlyEngine } from './fly.mjs';

/**
 * @param {{ config: any, docker?: any, flyApi?: any, project?: string }} deps
 * @returns {UpdateEngine}
 */
export function createEngine(deps) {
  const { config } = deps;
  if (config.engine === 'fly') {
    return createFlyEngine({ config, api: deps.flyApi });
  }
  return createDockerEngine({
    docker: deps.docker,
    config,
    project: deps.project ?? '',
  });
}

export { createDockerEngine, createFlyEngine };
