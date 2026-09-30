/**
 * The self-update overlay's Engine-control boundary (#432), checked on the
 * compose files themselves.
 *
 * `docker-socket-proxy` has no authentication, and the Engine calls the
 * updater needs (CONTAINERS + POST) are host-root-equivalent on their own. Its
 * section flags only trim what a compromised updater can do; the boundary is
 * that nothing but the updater can REACH the proxy, because the proxy sits on
 * the internal `omadia-control` network alone (docs/security-architecture.md
 * §10e). Nothing else inspects these files, so this suite is the regression
 * net for that layout.
 *
 * Every `docker-compose*.yaml` at the repo root is read, so a new overlay is
 * covered without touching this file. Compose MERGES a service's `networks`
 * across `-f` files (a union by name), so network membership is computed over
 * all files together: an overlay that adds `omadia` to the proxy is caught
 * even though the update overlay on its own still looks right.
 *
 * A parse cannot tell whether compose accepts the merged model. CI renders it
 * with `docker compose … config --quiet` for that.
 */

import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const BASE_FILE = 'docker-compose.yaml';
const UPDATE_OVERLAY = 'docker-compose.update.yaml';

const APP_NETWORK = 'omadia';
const CONTROL_NETWORK = 'omadia-control';
const PROXY = 'docker-socket-proxy';
const UPDATER = 'updater';

/**
 * Who may join each control network. A later control plane (the planned
 * dev-runner daemon stays off `omadia` the same way) adds its network here
 * instead of forking this suite.
 */
const CONTROL_NETWORK_MEMBERS: ReadonlyMap<string, readonly string[]> = new Map([
  [CONTROL_NETWORK, [PROXY, UPDATER]],
]);

/** The proxy image the flag list below was audited against. A bump has to
 *  re-audit the list, which is why the tag is asserted, not just the name. */
const PROXY_IMAGE = 'tecnativa/docker-socket-proxy:0.3.0';

/** Every section flag tecnativa/docker-socket-proxy 0.3.0 knows (its image
 *  `ENV` list). The image defaults EVENTS, PING and VERSION to 1, so a flag
 *  left out of the compose file is not necessarily off. */
const PROXY_FLAGS = [
  'ALLOW_RESTARTS',
  'ALLOW_START',
  'ALLOW_STOP',
  'AUTH',
  'BUILD',
  'COMMIT',
  'CONFIGS',
  'CONTAINERS',
  'DISTRIBUTION',
  'EVENTS',
  'EXEC',
  'GRPC',
  'IMAGES',
  'INFO',
  'NETWORKS',
  'NODES',
  'PING',
  'PLUGINS',
  'POST',
  'SECRETS',
  'SERVICES',
  'SESSION',
  'SWARM',
  'SYSTEM',
  'TASKS',
  'VERSION',
  'VOLUMES',
] as const;

/** The flags that are on; every other flag in PROXY_FLAGS must be 0. */
const PROXY_FLAGS_ON: ReadonlySet<string> = new Set([
  'CONTAINERS',
  'IMAGES',
  'NETWORKS',
  'PING',
  'POST',
]);

/** Settings the image also reads that are not section flags. Allowed, so a
 *  `LOG_LEVEL: debug` while debugging does not fail this suite. */
const PROXY_SETTINGS: ReadonlySet<string> = new Set([
  'DISABLE_IPV6',
  'LOG_LEVEL',
  'SOCKET_PATH',
]);

type YamlMap = Readonly<Record<string, unknown>>;

interface ComposeFile {
  readonly name: string;
  readonly services: ReadonlyMap<string, YamlMap>;
  readonly networks: ReadonlyMap<string, YamlMap>;
}

interface Declaration {
  readonly file: string;
  readonly def: YamlMap;
}

interface Mount {
  readonly source: string;
  readonly target: string;
  readonly readOnly: boolean;
}

function isMap(value: unknown): value is YamlMap {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A top-level mapping section (`services`, `networks`). An absent section is
 *  empty, and a `name:` entry without a body parses to null, which compose
 *  reads as "declared with defaults". */
function mapSection(
  file: string,
  key: string,
  value: unknown,
): Map<string, YamlMap> {
  if (value === undefined || value === null) return new Map();
  assert.ok(isMap(value), `${file}: \`${key}\` must be a mapping`);
  return new Map(
    Object.entries(value).map(([name, entry]): [string, YamlMap] => {
      if (entry === null) return [name, {}];
      assert.ok(isMap(entry), `${file}: \`${key}.${name}\` must be a mapping`);
      return [name, entry];
    }),
  );
}

function loadComposeFiles(): ComposeFile[] {
  return readdirSync(REPO_ROOT)
    .filter((name) => name.startsWith('docker-compose') && name.endsWith('.yaml'))
    .sort()
    .map((name) => {
      const doc: unknown = parse(readFileSync(path.join(REPO_ROOT, name), 'utf8'));
      assert.ok(isMap(doc), `${name}: the top level must be a mapping`);
      return {
        name,
        services: mapSection(name, 'services', doc['services']),
        networks: mapSection(name, 'networks', doc['networks']),
      };
    });
}

const FILES = loadComposeFiles();

/** Every service name declared anywhere in the file set, sorted. */
function allServices(): string[] {
  return [...new Set(FILES.flatMap((f) => [...f.services.keys()]))].sort();
}

/** Every declaration of `service` across the file set. */
function declarations(service: string): Declaration[] {
  return FILES.flatMap((f) => {
    const def = f.services.get(service);
    return def === undefined ? [] : [{ file: f.name, def }];
  });
}

function serviceIn(file: string, service: string): YamlMap {
  const def = FILES.find((f) => f.name === file)?.services.get(service);
  assert.ok(def !== undefined, `${file} must declare the ${service} service`);
  return def;
}

/** The networks one declaration attaches its service to, list or map form. */
function declaredNetworks(file: string, service: string, def: YamlMap): string[] {
  const networks = def['networks'];
  if (networks === undefined || networks === null) return [];
  if (Array.isArray(networks)) {
    return networks.map((entry: unknown) => {
      assert.equal(
        typeof entry,
        'string',
        `${file}: ${service}.networks list entries must be network names`,
      );
      return String(entry);
    });
  }
  assert.ok(isMap(networks), `${file}: ${service}.networks must be a list or a mapping`);
  return Object.keys(networks);
}

/** The networks compose attaches `service` to once every file is merged: the
 *  union of all declarations, or the implicit `default` when none names one. */
function mergedNetworks(service: string): string[] {
  const names = new Set<string>();
  for (const { file, def } of declarations(service)) {
    for (const network of declaredNetworks(file, service, def)) names.add(network);
  }
  return names.size === 0 ? ['default'] : [...names].sort();
}

/** A service's `environment` in either compose form, values as strings: YAML
 *  reads `PING: 1` as a number, compose hands the container "1". */
function environmentOf(file: string, service: string, def: YamlMap): Map<string, string> {
  const env = def['environment'];
  if (env === undefined || env === null) return new Map();
  if (Array.isArray(env)) {
    return new Map(
      env.map((entry: unknown): [string, string] => {
        const text = String(entry);
        const eq = text.indexOf('=');
        return eq === -1 ? [text, ''] : [text.slice(0, eq), text.slice(eq + 1)];
      }),
    );
  }
  assert.ok(isMap(env), `${file}: ${service}.environment must be a list or a mapping`);
  return new Map(
    Object.entries(env).map(([key, value]): [string, string] => [
      key,
      value === null ? '' : String(value),
    ]),
  );
}

/** A service's `volumes` in either compose syntax. */
function mountsOf(file: string, service: string, def: YamlMap): Mount[] {
  const volumes = def['volumes'];
  if (volumes === undefined || volumes === null) return [];
  assert.ok(Array.isArray(volumes), `${file}: ${service}.volumes must be a list`);
  return volumes.map((entry: unknown): Mount => {
    if (typeof entry === 'string') {
      // SOURCE:TARGET[:MODE], where MODE is a comma list such as `ro,z`.
      const [source = '', target = '', mode = ''] = entry.split(':');
      return { source, target, readOnly: mode.split(',').includes('ro') };
    }
    assert.ok(isMap(entry), `${file}: ${service}.volumes entries must be strings or mappings`);
    return {
      source: String(entry['source'] ?? ''),
      target: String(entry['target'] ?? ''),
      readOnly: entry['read_only'] === true,
    };
  });
}

function hostOf(url: string | undefined): string {
  assert.ok(url !== undefined && url.length > 0, 'expected a URL');
  return new URL(url).hostname;
}

describe('compose update overlay — Engine-control boundary (#432)', () => {
  it('reads the base compose file and the update overlay', () => {
    const names = FILES.map((f) => f.name);
    assert.ok(names.includes(BASE_FILE), `${BASE_FILE} not found in ${REPO_ROOT}`);
    assert.ok(names.includes(UPDATE_OVERLAY), `${UPDATE_OVERLAY} not found in ${REPO_ROOT}`);
  });

  it('the socket proxy is attached to the internal control network only', () => {
    assert.deepEqual(
      declarations(PROXY).map((d) => d.file),
      [UPDATE_OVERLAY],
      `${PROXY} is declared in ${UPDATE_OVERLAY} and nowhere else`,
    );
    assert.deepEqual(mergedNetworks(PROXY), [CONTROL_NETWORK]);
  });

  it('omadia-control, like every control network, is internal with no host-side address', () => {
    for (const network of CONTROL_NETWORK_MEMBERS.keys()) {
      const declared = FILES.flatMap((f) => {
        const def = f.networks.get(network);
        return def === undefined ? [] : [{ file: f.name, def }];
      });
      assert.ok(declared.length > 0, `no compose file declares the ${network} network`);
      for (const { file, def } of declared) {
        assert.equal(def['internal'], true, `${file}: ${network} must be \`internal: true\``);
        // Without a bridge address the host cannot forward traffic from
        // another network into this one, even on a runtime that skips
        // Docker's inter-network firewall rules. IPv6 would be a second path.
        const driverOpts = def['driver_opts'];
        assert.equal(
          isMap(driverOpts) ? String(driverOpts['com.docker.network.bridge.inhibit_ipv4']) : undefined,
          'true',
          `${file}: ${network} must set com.docker.network.bridge.inhibit_ipv4`,
        );
        assert.equal(def['enable_ipv6'], false, `${file}: ${network} must set \`enable_ipv6: false\``);
      }
    }
    assert.ok(
      FILES.find((f) => f.name === UPDATE_OVERLAY)?.networks.has(CONTROL_NETWORK),
      `${UPDATE_OVERLAY} declares ${CONTROL_NETWORK}`,
    );
  });

  it('across every docker-compose*.yaml only updater joins omadia-control besides the proxy', () => {
    for (const [network, allowed] of CONTROL_NETWORK_MEMBERS) {
      const members = allServices().filter((s) => mergedNetworks(s).includes(network));
      assert.deepEqual(members, [...allowed].sort(), `the services on ${network}`);
    }
    assert.deepEqual(mergedNetworks(UPDATER), [APP_NETWORK, CONTROL_NETWORK]);
    assert.deepEqual(mergedNetworks('middleware'), [APP_NETWORK]);
    assert.deepEqual(mergedNetworks('web-ui'), [APP_NETWORK]);
  });

  it('no other service takes the proxy name or shares its network namespace', () => {
    for (const service of allServices()) {
      for (const { file, def } of declarations(service)) {
        const networkMode = def['network_mode'];
        if (service === PROXY) {
          // `host` would put port 2375 on the host; any mode skips the networks.
          assert.equal(networkMode, undefined, `${file}: ${PROXY} must not set network_mode`);
          continue;
        }
        assert.ok(
          typeof networkMode !== 'string' || !networkMode.includes(PROXY),
          `${file}: ${service} must not share the network namespace of ${PROXY}`,
        );
        assert.notEqual(def['container_name'], PROXY, `${file}: ${service} is named ${PROXY}`);
        const networks = def['networks'];
        if (!isMap(networks)) continue;
        for (const [network, config] of Object.entries(networks)) {
          const aliases: unknown = isMap(config) ? config['aliases'] : undefined;
          assert.ok(
            !(Array.isArray(aliases) && aliases.map(String).includes(PROXY)),
            `${file}: ${service} carries the alias ${PROXY} on ${network}`,
          );
        }
      }
    }
  });

  it('every network a service joins is declared in some compose file', () => {
    const declared = new Set(FILES.flatMap((f) => [...f.networks.keys()]));
    for (const f of FILES) {
      for (const [service, def] of f.services) {
        for (const network of declaredNetworks(f.name, service, def)) {
          assert.ok(
            network === 'default' || declared.has(network),
            `${f.name}: ${service} joins ${network}, which no compose file declares`,
          );
        }
      }
    }
  });

  it('the Docker socket is mounted by the proxy only, read-only', () => {
    const socketMounts = FILES.flatMap((f) =>
      [...f.services].flatMap(([service, def]) =>
        mountsOf(f.name, service, def)
          .filter((m) => m.source.includes('docker.sock') || m.target.includes('docker.sock'))
          .map((m) => ({ file: f.name, service, readOnly: m.readOnly })),
      ),
    );
    assert.ok(socketMounts.length > 0, `expected ${PROXY} to mount the Docker socket`);
    for (const mount of socketMounts) {
      assert.equal(mount.service, PROXY, `${mount.file}: ${mount.service} mounts the Docker socket`);
      assert.ok(mount.readOnly, `${mount.file}: ${mount.service} must mount the Docker socket read-only`);
    }
  });

  it('the proxy publishes no host port', () => {
    for (const { file, def } of declarations(PROXY)) {
      assert.equal(def['ports'], undefined, `${file}: ${PROXY} must not publish a port`);
    }
  });

  it('the proxy image is pinned and every flag that version knows is set explicitly', () => {
    const proxy = serviceIn(UPDATE_OVERLAY, PROXY);
    assert.equal(proxy['image'], PROXY_IMAGE, 'a proxy image bump must re-audit PROXY_FLAGS');
    const flags = new Map(
      [...environmentOf(UPDATE_OVERLAY, PROXY, proxy)].filter(([key]) => !PROXY_SETTINGS.has(key)),
    );
    const expected = new Map(
      PROXY_FLAGS.map((flag): [string, string] => [flag, PROXY_FLAGS_ON.has(flag) ? '1' : '0']),
    );
    assert.deepEqual(flags, expected);
  });

  it('the updater reaches the proxy on the control network and the middleware on the app network', () => {
    const updater = serviceIn(UPDATE_OVERLAY, UPDATER);
    const env = environmentOf(UPDATE_OVERLAY, UPDATER, updater);
    // Why the updater, and only the updater, is on both networks.
    assert.equal(hostOf(env.get('UPDATER_DOCKER_API')), PROXY);
    assert.equal(hostOf(env.get('UPDATER_HEALTH_URL')), 'middleware');
    assert.equal(updater['ports'], undefined, `${UPDATER} must not publish a port`);

    const middleware = serviceIn(UPDATE_OVERLAY, 'middleware');
    assert.equal(
      environmentOf(UPDATE_OVERLAY, 'middleware', middleware).get('OMADIA_UPDATER_URL'),
      'http://updater:8090',
    );
  });
});
