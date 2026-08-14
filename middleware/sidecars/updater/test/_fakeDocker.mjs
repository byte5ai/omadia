/**
 * In-memory stand-in for the Docker Engine API, recording every call in order.
 *
 * The ordering log is the point: the safety properties of `runUpdate` are
 * almost entirely about SEQUENCE (pull everything before stopping anything,
 * restore in reverse), and a mock that only records "was it called" cannot
 * fail when that sequence regresses.
 */

export function createFakeDocker(options = {}) {
  const {
    services = { middleware: 'ghcr.io/byte5ai/omadia-middleware:v0.74.0' },
    project = 'omadia',
    failPullFor = null,
    failCreateFor = null,
  } = options;

  const calls = [];
  let nextId = 1;

  const containers = new Map();
  for (const [service, image] of Object.entries(services)) {
    const id = `c${nextId++}`;
    containers.set(id, {
      Id: id,
      Name: `/${project}-${service}-1`,
      Config: {
        Image: image,
        Env: ['NODE_ENV=production', 'OMADIA_VERSION=v0.74.0', 'FOO=bar'],
        Labels: {
          'com.docker.compose.project': project,
          'com.docker.compose.service': service,
        },
      },
      HostConfig: { RestartPolicy: { Name: 'unless-stopped' } },
      NetworkSettings: { Networks: { [`${project}_omadia`]: { Aliases: [service] } } },
    });
  }

  function findByLabels(labels) {
    const wanted = Object.fromEntries(
      labels.map((entry) => {
        const idx = entry.indexOf('=');
        return [entry.slice(0, idx), entry.slice(idx + 1)];
      }),
    );
    return [...containers.values()].filter((c) =>
      Object.entries(wanted).every(([k, v]) => c.Config.Labels[k] === v),
    );
  }

  return {
    calls,
    containers,

    async listContainers(filters) {
      calls.push({ op: 'list', filters });
      return findByLabels(filters.label ?? []);
    },

    async inspectContainer(idOrName) {
      calls.push({ op: 'inspect', id: idOrName });
      const direct = containers.get(idOrName);
      if (direct) return direct;
      for (const container of containers.values()) {
        if (container.Name === `/${idOrName}` || container.Id === idOrName) {
          return container;
        }
      }
      throw new Error(`no such container: ${idOrName}`);
    },

    async pullImage(repo, tag) {
      calls.push({ op: 'pull', repo, tag });
      if (failPullFor !== null && repo.includes(failPullFor)) {
        throw new Error(`pull ${repo}:${tag} failed: manifest unknown`);
      }
    },

    async stopContainer(id) {
      calls.push({ op: 'stop', id });
    },

    async removeContainer(id) {
      calls.push({ op: 'remove', id });
      containers.delete(id);
    },

    async createContainer(name, config) {
      calls.push({ op: 'create', name, image: config.Image, env: config.Env });
      if (failCreateFor !== null && String(config.Image).includes(failCreateFor)) {
        throw new Error(`create ${name} failed`);
      }
      const id = `c${nextId++}`;
      containers.set(id, {
        Id: id,
        Name: `/${name}`,
        Config: {
          Image: config.Image,
          Env: config.Env,
          Labels: config.Labels,
        },
        HostConfig: config.HostConfig,
        NetworkSettings: {
          Networks: config.NetworkingConfig?.EndpointsConfig ?? {},
        },
      });
      return id;
    },

    async startContainer(id) {
      calls.push({ op: 'start', id });
    },

    async connectNetwork(networkId, containerId) {
      calls.push({ op: 'connect', networkId, containerId });
    },
  };
}

/** Sequence of operation names, for order assertions. */
export function ops(docker) {
  return docker.calls.map((c) => c.op);
}
