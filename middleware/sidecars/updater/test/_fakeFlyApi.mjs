/**
 * In-memory stand-in for the Fly Machines API, recording every call in order.
 *
 * The point of recording — as with `_fakeDocker.mjs` — is that the safety
 * properties are about SEQUENCE and about what is *preserved*, and a mock that
 * only records "was it called" cannot fail when either regresses.
 */

export function createFakeFlyApi(options = {}) {
  const {
    apps = {
      'omadia-middleware-x': 'ghcr.io/byte5ai/omadia-middleware:v0.74.0',
      'omadia-web-ui-x': 'ghcr.io/byte5ai/omadia-web-ui:v0.74.0',
    },
    failUpdateFor = null,
    leaseThrows = false,
  } = options;

  const calls = [];
  const machines = new Map();
  let nextId = 1;

  for (const [app, image] of Object.entries(apps)) {
    const id = `m${nextId++}`;
    machines.set(app, {
      id,
      state: 'started',
      instance_id: `01HVERSION${id}`,
      config: {
        image,
        // The fields the update endpoint would silently drop if the caller
        // built its request body from scratch instead of reading first.
        env: { PLATFORM_DATA_DIR: '/data' },
        mounts: [{ volume: 'vol_123', path: '/data', name: 'omadia_data' }],
        checks: { health: { type: 'http', port: 8080, path: '/health' } },
        services: [{ internal_port: 8080, protocol: 'tcp', ports: [{ port: 443 }] }],
        restart: { policy: 'always' },
        guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 1024 },
      },
    });
  }

  return {
    calls,
    machines,

    async listMachines(app) {
      calls.push({ op: 'list', app });
      const m = machines.get(app);
      return m ? [m] : [];
    },

    async getMachine(app, id) {
      calls.push({ op: 'get', app, id });
      const m = machines.get(app);
      if (!m || m.id !== id) throw new Error(`no such machine ${app}/${id}`);
      // Return a copy: the engine must not be able to mutate our state except
      // through updateMachine.
      return JSON.parse(JSON.stringify(m));
    },

    async updateMachine(app, id, input) {
      calls.push({ op: 'update', app, id, config: input.config, currentVersion: input.currentVersion });
      if (failUpdateFor !== null && String(input.config.image).includes(failUpdateFor)) {
        throw new Error(`update ${app}/${id} failed: image not found`);
      }
      const m = machines.get(app);
      m.config = input.config;
      m.instance_id = `01HVERSION-${calls.length}`;
      return m;
    },

    async waitForState(app, id, state) {
      calls.push({ op: 'wait', app, id, state });
    },

    async acquireLease(app, id) {
      calls.push({ op: 'lease', app, id });
      if (leaseThrows) throw new Error('lease unavailable');
      return `nonce-${id}`;
    },
  };
}

/** Sequence of operation names, for order assertions. */
export function flyOps(api) {
  return api.calls.map((c) => c.op);
}
