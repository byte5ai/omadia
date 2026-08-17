/**
 * Fly.io engine for the updater (#696).
 *
 * Fly Machines are Firecracker microVMs — there is no Docker daemon to talk
 * to, so the compose executor cannot run there. What Fly offers instead is the
 * Machines API, and the shape of an update maps cleanly onto the same steps:
 * resolve, preflight, replace, gate, roll back.
 *
 * Three things are genuinely different and are handled here:
 *
 * 1. **`config` on the update endpoint REPLACES the machine configuration.**
 *    It is a required field, so a hand-built object silently drops `mounts`,
 *    `checks`, `services`, `env` and `restart`. This engine reads the machine
 *    and changes exactly one field. Same bug class as Docker's `Config.Env`
 *    (see #692), where the merged environment carried the *old* build stamp
 *    into the new container and would have rolled back every good update.
 * 2. **There is no pull step we control** — Fly fetches the image while
 *    updating the Machine. The "discover a bad tag before touching anything"
 *    property is preserved by checking the registry manifest up front instead.
 * 3. **The version pin cannot be persisted.** On compose the updater writes
 *    `OMADIA_VERSION` into the project `.env` so a later `docker compose up -d`
 *    keeps the operator's choice. `fly deploy` reads the operator's *local*
 *    `fly.toml` and nothing server-side overrides it, so this engine reports
 *    `canPersistPin: false` rather than pretending.
 */

import { manifestExists } from '../registry.mjs';
import { splitImageRef } from '../recreate.mjs';

/** How long a lease is held while a machine is being replaced. */
const LEASE_TTL_SECONDS = 300;

/**
 * @param {{ api: any, config: any, manifestCheck?: typeof manifestExists }} deps
 * @returns {import('./index.mjs').UpdateEngine}
 */
export function createFlyEngine({ config, api, manifestCheck = manifestExists }) {
  /** @param {string} service */
  function appFor(service) {
    const app = config.flyApps?.[service];
    if (typeof app !== 'string' || app.length === 0) {
      throw new Error(`no Fly app configured for service "${service}" — set UPDATER_FLY_APPS`);
    }
    return app;
  }

  return {
    kind: 'fly',

    // See the header: `fly deploy` reads the operator's local fly.toml.
    canPersistPin: false,

    async resolveTarget(service) {
      const app = appFor(service);
      const machines = await api.listMachines(app);
      const live = machines.filter((m) => m?.state !== 'destroyed' && m?.config?.image);
      if (live.length === 0) {
        throw new Error(`no machine found for Fly app "${app}"`);
      }
      if (live.length > 1) {
        // Same stance as a scaled compose service: replacing one of N with a
        // different image is a rolling deploy, which is `fly deploy`'s job.
        throw new Error(
          `Fly app "${app}" has ${live.length} machines — scaled apps are not supported`,
        );
      }
      const machine = live[0];
      const currentImage = machine.config.image;
      const { repo } = splitImageRef(currentImage);
      if (repo.length === 0) {
        throw new Error(`machine ${machine.id} has no resolvable image reference`);
      }
      return {
        service,
        currentImage,
        repo,
        handle: { app, machineId: machine.id },
      };
    },

    async preflight(targets, targetVersion, log) {
      for (const target of targets) {
        const result = await manifestCheck(target.repo, targetVersion);
        if (!result.exists) {
          throw new Error(
            `${target.newImage} is not available (${result.reason}) — refusing to update, Fly would only discover this after the first machine is already moving`,
          );
        }
        log(`registry has ${target.newImage}`);
      }
      log('all target images verified in the registry');
    },

    async pin() {
      // Nothing to write, and nothing to restore on rollback either.
      return null;
    },

    async restorePin() {
      /* no-op — see canPersistPin */
    },

    pinDescription() {
      return null;
    },

    async replace(target, image, log) {
      const { app, machineId } = target.handle;

      // A lease stops any other process (a concurrent `fly deploy`, a second
      // updater) from moving this machine while we are waiting on it.
      let lease = null;
      try {
        lease = await api.acquireLease(app, machineId, LEASE_TTL_SECONDS);
      } catch (err) {
        log(
          `could not acquire a lease on ${app}/${machineId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (lease !== null) log(`leased ${app}/${machineId}`);

      try {
        // Read-then-change-one-field. Never build this object from scratch.
        const machine = await api.getMachine(app, machineId);
        const current = machine?.config;
        if (current === undefined || current === null) {
          throw new Error(`machine ${app}/${machineId} returned no config to update`);
        }

        log(`updating ${app}/${machineId} → ${image}`);
        await api.updateMachine(app, machineId, {
          config: { ...current, image },
          ...(typeof machine.instance_id === 'string'
            ? { currentVersion: machine.instance_id }
            : {}),
          // The lease we just took gates this write. Passing it is what makes
          // the update possible at all; without it Fly answers 409 and we are
          // blocked by our own lease.
          ...(lease !== null ? { leaseNonce: lease } : {}),
        });

        log(`waiting for ${app}/${machineId} to start`);
        await api.waitForState(app, machineId, 'started');
      } finally {
        // Always hand the lease back — including on the failure path. An
        // abandoned lease keeps blocking writes for the rest of its TTL, so
        // the rollback that follows a failed update would hit 409 as well and
        // the machine would stay locked against `fly deploy` for minutes.
        if (lease !== null) {
          try {
            await api.releaseLease(app, machineId, lease);
            log(`released lease on ${app}/${machineId}`);
          } catch (err) {
            log(
              `could not release the lease on ${app}/${machineId}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
    },
  };
}
