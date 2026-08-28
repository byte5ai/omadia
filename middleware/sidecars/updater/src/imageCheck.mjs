/**
 * "Would this version even be pullable?" — a read-only dry run of step 2.
 *
 * The update job already refuses to replace anything when a target image is
 * missing, but it only learns that after the operator has committed to the
 * run. That is one round of stopped containers (compose) or a moving machine
 * (Fly) too late to be useful as *information*: the operator wants to see the
 * answer while they are still choosing a version.
 *
 * This module answers exactly that question and mutates nothing. It reuses the
 * engine's `resolveTarget` — so the repository comes from what is actually
 * running, not from a hardcoded list — and asks the registry for the manifest.
 * Deliberately NOT `engine.preflight`: the docker engine implements that as a
 * real pull, which writes to the image store and can take minutes.
 */

import { PROTECTED_SERVICES } from './config.mjs';
import { manifestExists } from './registry.mjs';

/**
 * @typedef {{
 *   service: string,
 *   currentImage: string,
 *   image: string,
 *   available: boolean,
 *   reason: string | null,
 * }} ImageCheck
 */

/**
 * @param {{
 *   engine: import('./engine/index.mjs').UpdateEngine,
 *   config: any,
 *   targetVersion: string,
 *   manifestCheck?: typeof manifestExists,
 * }} opts
 * @returns {Promise<{ targetVersion: string, ok: boolean, images: ImageCheck[] }>}
 */
export async function checkImages(opts) {
  const { engine, config, targetVersion, manifestCheck = manifestExists } = opts;

  /** @type {ImageCheck[]} */
  const images = [];
  for (const service of config.services) {
    if (PROTECTED_SERVICES.includes(service) || service === config.selfService) {
      continue;
    }
    // A service that cannot even be resolved is reported as unavailable rather
    // than thrown: the operator asked "can I go to X?", and "the middleware
    // container is not where I expect it" is an answer to that question, not a
    // reason to give none.
    try {
      const target = await engine.resolveTarget(service);
      const image = `${target.repo}:${targetVersion}`;
      const result = await manifestCheck(target.repo, targetVersion);
      images.push({
        service,
        currentImage: target.currentImage,
        image,
        available: result.exists,
        reason: result.exists ? null : (result.reason ?? 'unknown'),
      });
    } catch (err) {
      images.push({
        service,
        currentImage: '',
        image: '',
        available: false,
        reason: `resolve_failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return {
    targetVersion,
    ok: images.length > 0 && images.every((entry) => entry.available),
    images,
  };
}
