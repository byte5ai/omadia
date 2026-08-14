/**
 * Container recreation for the self-update sidecar (#432).
 *
 * The pure parts (image-ref splitting, create-config derivation) live here and
 * are unit-tested without a Docker daemon; the IO sequence at the bottom is the
 * thin orchestration around them.
 *
 * Why recreate via the Engine API instead of shelling out to `docker compose`:
 * compose needs the project files, a compatible CLI, and a much wider socket
 * allowlist (networks, volumes, config hashing) — which would give back exactly
 * the blast radius the socket-proxy was added to remove. Reusing the running
 * container's own inspect output keeps every compose label, mount, port and
 * restart policy byte-identical, and changes exactly one field: the image.
 */

/** Env var carrying the build identity. Stripped on recreate — see below. */
const VERSION_ENV_PREFIX = 'OMADIA_VERSION=';

/**
 * Split an image reference into repository + tag.
 * Handles registries with a port (`reg:5000/img:tag`) and digest pins.
 *
 * @param {string} ref
 * @returns {{ repo: string, tag: string | null, digest: string | null }}
 */
export function splitImageRef(ref) {
  const atIndex = ref.indexOf('@');
  if (atIndex !== -1) {
    return {
      repo: ref.slice(0, atIndex),
      tag: null,
      digest: ref.slice(atIndex + 1),
    };
  }
  const colonIndex = ref.lastIndexOf(':');
  // A colon that is part of a registry host:port has a `/` after it.
  if (colonIndex === -1 || ref.includes('/', colonIndex)) {
    return { repo: ref, tag: null, digest: null };
  }
  return {
    repo: ref.slice(0, colonIndex),
    tag: ref.slice(colonIndex + 1),
    digest: null,
  };
}

/**
 * Build the `POST /containers/create` body from a running container's inspect
 * output, retargeted at `newImage`.
 *
 * Two subtleties that are load-bearing:
 *
 * 1. `Config.Env` from inspect is the MERGED environment — everything compose
 *    passed *plus* every `ENV` baked into the old image. Copying it verbatim
 *    would carry the OLD image's `OMADIA_VERSION` into the new container, so
 *    the new middleware would report the version it just replaced and the
 *    health gate would wait forever for a version that can never appear. The
 *    entry is therefore dropped, letting the new image's own baked value win.
 *    Compose does not set this variable on the service (deliberately — see
 *    docker-compose.yaml), so nothing legitimate is lost.
 * 2. `NetworkingConfig` accepts a single endpoint at create time; any further
 *    networks are attached afterwards via `/networks/{id}/connect`. The first
 *    entry is passed here and the rest returned for the caller to connect.
 *
 * @param {any} inspect  container inspect payload
 * @param {string} newImage
 * @returns {{ config: any, extraNetworks: Array<{ name: string, endpoint: any }> }}
 */
export function buildCreateConfig(inspect, newImage) {
  const config = inspect.Config ?? {};
  const env = Array.isArray(config.Env)
    ? config.Env.filter((entry) => !String(entry).startsWith(VERSION_ENV_PREFIX))
    : [];

  const networks = inspect.NetworkSettings?.Networks ?? {};
  const names = Object.keys(networks);
  const [first, ...rest] = names;

  return {
    config: {
      Hostname: config.Hostname,
      User: config.User,
      Env: env,
      Cmd: config.Cmd ?? null,
      Entrypoint: config.Entrypoint ?? null,
      Image: newImage,
      Labels: config.Labels ?? {},
      WorkingDir: config.WorkingDir,
      ExposedPorts: config.ExposedPorts ?? {},
      Healthcheck: config.Healthcheck ?? undefined,
      HostConfig: inspect.HostConfig ?? {},
      ...(first !== undefined
        ? {
            NetworkingConfig: {
              EndpointsConfig: {
                // Drop the runtime-assigned fields; keeping `Aliases` is what
                // preserves in-network DNS (`postgres`, `middleware`, …).
                [first]: {
                  Aliases: networks[first]?.Aliases ?? undefined,
                  IPAMConfig: networks[first]?.IPAMConfig ?? undefined,
                },
              },
            },
          }
        : {}),
    },
    extraNetworks: rest.map((name) => ({
      name,
      endpoint: {
        Aliases: networks[name]?.Aliases ?? undefined,
        IPAMConfig: networks[name]?.IPAMConfig ?? undefined,
      },
    })),
  };
}

/** Strip the leading `/` Docker puts on container names. */
export function containerName(inspect) {
  const raw = typeof inspect.Name === 'string' ? inspect.Name : '';
  return raw.startsWith('/') ? raw.slice(1) : raw;
}

/**
 * Replace one running container with the same container on a new image tag.
 * Returns the previous image ref so the caller can roll back.
 *
 * @param {ReturnType<import('./dockerApi.mjs').createDockerApi>} docker
 * @param {any} inspect
 * @param {string} newImage
 * @param {(msg: string) => void} log
 * @returns {Promise<{ previousImage: string, id: string }>}
 */
export async function recreateContainer(docker, inspect, newImage, log) {
  const name = containerName(inspect);
  const previousImage = inspect.Config?.Image ?? '';
  const { config, extraNetworks } = buildCreateConfig(inspect, newImage);

  log(`stopping ${name}`);
  await docker.stopContainer(inspect.Id);
  log(`removing ${name}`);
  try {
    await docker.removeContainer(inspect.Id);
  } catch (err) {
    // Most likely cause: the socket-proxy allowlist permits GET/POST but not
    // DELETE. Recover the container we just stopped instead of leaving the
    // service down, and name the probable fix in the error — a stack that is
    // half-down with an opaque 403 is the worst possible outcome here.
    log(`removing ${name} failed, restarting it`);
    await docker.startContainer(inspect.Id).catch(() => {});
    throw new Error(
      `could not remove container ${name}: ${err instanceof Error ? err.message : String(err)} — check that the docker-socket-proxy allows DELETE /containers (POST=1)`,
    );
  }

  log(`creating ${name} on ${newImage}`);
  const id = await docker.createContainer(name, config);
  for (const extra of extraNetworks) {
    await docker.connectNetwork(extra.name, id, extra.endpoint);
  }
  log(`starting ${name}`);
  await docker.startContainer(id);

  return { previousImage, id };
}
