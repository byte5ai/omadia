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
    // Fail the wait-for-started step, i.e. AFTER the machine already carries
    // the new image. This is the shape the real 400 on `/wait?timeout=120`
    // had, and the one that made rollback a no-op.
    waitThrows = false,
  } = options;

  const calls = [];
  const machines = new Map();
  /** app -> nonce currently holding the lease. Mirrors Fly's real gate. */
  const leases = new Map();
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
      calls.push({
        op: 'update',
        app,
        id,
        config: input.config,
        currentVersion: input.currentVersion,
        leaseNonce: input.leaseNonce,
      });
      // Fly gates every write on a LEASED machine behind the lease nonce. A
      // fake that skips this check cannot fail when the caller forgets to send
      // it — which is exactly how the missing nonce shipped green.
      const held = leases.get(app);
      if (held !== undefined && input.leaseNonce !== held) {
        throw new Error(
          `fly api POST /v1/apps/${app}/machines/${id} → 409: ` +
            `{"error":"aborted: machine ID ${id} lease currently held by tokens.fly.io"}`,
        );
      }
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
      if (waitThrows) {
        throw new Error(
          `fly api GET /v1/apps/${app}/machines/${id}/wait?state=${state}&timeout=120 → 400: ` +
            `{"error":"invalid_argument: invalid WaitMachineRequest.Timeout"}`,
        );
      }
    },

    async acquireLease(app, id) {
      calls.push({ op: 'lease', app, id });
      if (leaseThrows) throw new Error('lease unavailable');
      if (leases.has(app)) {
        throw new Error(`lease on ${app}/${id} is already held`);
      }
      const nonce = `nonce-${id}`;
      leases.set(app, nonce);
      return nonce;
    },

    async releaseLease(app, id, nonce) {
      calls.push({ op: 'release', app, id, nonce });
      const held = leases.get(app);
      if (held === undefined) throw new Error(`no lease held on ${app}/${id}`);
      if (held !== nonce) throw new Error(`wrong nonce for the lease on ${app}/${id}`);
      leases.delete(app);
    },

    /** Test helper: is a lease still outstanding? */
    leaseHeld(app) {
      return leases.get(app) ?? null;
    },
  };
}

/** Sequence of operation names, for order assertions. */
export function flyOps(api) {
  return api.calls.map((c) => c.op);
}
