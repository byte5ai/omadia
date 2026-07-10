import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { parse } from 'yaml';

/**
 * Epic #470 W1 — the dev-platform compose overlay's SECURITY properties, asserted
 * against the file rather than trusted to a reviewer's eye.
 *
 * Every claim below is one a comment could make and be wrong about. A stray
 * `- /var/run/docker.sock:/var/run/docker.sock` on the middleware, or a
 * `ports:` on the privileged dind, undoes the whole design silently — the stack
 * comes up, every test passes, and the isolation is gone. These assertions are the
 * only thing standing between "the middleware never holds a docker socket" being
 * an architectural invariant and being a sentence in a README.
 *
 * Parsed, not grepped: `docker compose config` would need docker, and a grep for
 * `privileged` cannot tell you WHICH service carries it.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');

interface ComposeService {
  privileged?: boolean;
  ports?: unknown[];
  volumes?: string[];
  environment?: Record<string, string>;
  networks?: string[] | Record<string, unknown>;
  command?: string[];
  image?: string;
  build?: { context?: string };
}

interface ComposeFile {
  services: Record<string, ComposeService>;
  networks?: Record<string, { internal?: boolean; ipam?: unknown }>;
}

function load(name: string): ComposeFile {
  return parse(readFileSync(resolve(REPO_ROOT, name), 'utf8')) as ComposeFile;
}

const base = load('docker-compose.yaml');
const overlay = load('docker-compose.dev-platform.yaml');

/** Compose merges by service name; the overlay's `networks` REPLACES the base's. */
function networkNames(svc: ComposeService | undefined): string[] {
  if (!svc?.networks) return [];
  return Array.isArray(svc.networks) ? svc.networks : Object.keys(svc.networks);
}

const DEV_SERVICES = ['dev-runner-daemon', 'dev-dind', 'dev-egress-proxy'] as const;

describe('dev-platform compose overlay — the middleware never holds a docker socket', () => {
  it('mounts no docker socket into the middleware, in either file', () => {
    for (const [file, compose] of [
      ['docker-compose.yaml', base],
      ['docker-compose.dev-platform.yaml', overlay],
    ] as const) {
      const volumes = compose.services['middleware']?.volumes ?? [];
      for (const v of volumes) {
        assert.ok(
          !v.includes('docker.sock'),
          `${file}: the middleware must never receive a docker socket (found '${v}')`,
        );
      }
    }
  });

  it('gives the middleware no DOCKER_HOST and no engine credentials', () => {
    const env = overlay.services['middleware']?.environment ?? {};
    for (const key of ['DOCKER_HOST', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) {
      assert.equal(env[key], undefined, `the middleware must not carry ${key}`);
    }
  });

  it('keeps the middleware off the engine network entirely', () => {
    const nets = networkNames(overlay.services['middleware']);
    assert.ok(nets.includes('dev-control'), 'it must reach the daemon');
    assert.ok(!nets.includes('dev-engine'), 'it must never reach dind');
    assert.ok(!nets.includes('dev-egress'), 'it must never sit on the job-egress network');
  });

  it('gives the daemon — and only the daemon — the engine credentials', () => {
    const daemon = overlay.services['dev-runner-daemon']!;
    assert.equal(daemon.environment?.['DOCKER_HOST'], 'tcp://dev-dind:2376');
    assert.equal(daemon.environment?.['DOCKER_TLS_VERIFY'], '1', 'the daemon refuses a plaintext engine');
    for (const [name, svc] of Object.entries(overlay.services)) {
      if (name === 'dev-runner-daemon') continue;
      assert.equal(svc.environment?.['DOCKER_HOST'], undefined, `${name} must not address the engine`);
    }
  });
});

describe('dev-platform compose overlay — exactly one privileged service, and it is caged', () => {
  it('marks only dev-dind privileged, across both files', () => {
    const privileged: string[] = [];
    for (const compose of [base, overlay]) {
      for (const [name, svc] of Object.entries(compose.services)) {
        if (svc.privileged === true) privileged.push(name);
      }
    }
    assert.deepEqual([...new Set(privileged)], ['dev-dind']);
  });

  it('publishes no host port from any dev-platform service', () => {
    // A single `ports:` here would expose a privileged docker API, or the daemon's
    // control plane, to the host — and to anything that can reach the host.
    for (const name of DEV_SERVICES) {
      const svc = overlay.services[name]!;
      assert.equal(svc.ports, undefined, `${name} must publish no host port`);
    }
  });

  it('puts dind on internal-only networks and nowhere else', () => {
    const nets = networkNames(overlay.services['dev-dind']);
    assert.deepEqual(nets.sort(), ['dev-egress', 'dev-engine']);
    assert.ok(!nets.includes('omadia'), 'a privileged container must not sit on the app bridge');
    for (const n of nets) {
      assert.equal(overlay.networks?.[n]?.internal, true, `network '${n}' must be internal`);
    }
  });

  it('declares every dev-platform network internal', () => {
    for (const name of ['dev-control', 'dev-engine', 'dev-egress']) {
      assert.equal(overlay.networks?.[name]?.internal, true, `network '${name}' must be internal: true`);
    }
  });
});

describe('dev-platform compose overlay — the daemon is unreachable from the app bridge', () => {
  it('keeps the daemon off the omadia network', () => {
    const nets = networkNames(overlay.services['dev-runner-daemon']);
    assert.ok(!nets.includes('omadia'), 'nothing on the app bridge may reach the daemon control API');
    assert.deepEqual(nets.sort(), ['dev-control', 'dev-engine']);
  });

  it('binds the daemon to its dev-control address, never a wildcard', () => {
    // `assertControlPlaneBind` refuses 0.0.0.0 precisely because the daemon also
    // sits on dev-engine, where every container dind runs can reach it.
    const bind = overlay.services['dev-runner-daemon']?.environment?.['DEV_DAEMON_BIND'];
    assert.equal(bind, '172.28.4.2');
    assert.notEqual(bind, '0.0.0.0');
    const pinned = (overlay.services['dev-runner-daemon']?.networks as Record<string, { ipv4_address?: string }>)?.[
      'dev-control'
    ];
    assert.equal(pinned?.ipv4_address, bind, 'the bind address must be the pinned dev-control address');
  });
});

describe('dev-platform compose overlay — egress is configured as a pair, and pinned', () => {
  it('sets both egress proxy URLs on the daemon (a half-configuration is a boot refusal)', () => {
    const env = overlay.services['dev-runner-daemon']!.environment!;
    assert.ok(env['DEV_RUNNER_EGRESS_PROXY_URL'], 'jobs must be routed through the proxy');
    assert.ok(env['DEV_RUNNER_EGRESS_PROXY_CONTROL_URL'], 'and the daemon must be able to register them');
  });

  it('points jobs at the proxy by ADDRESS, because dind containers have no compose DNS', () => {
    const env = overlay.services['dev-runner-daemon']!.environment!;
    const dataUrl = new URL(env['DEV_RUNNER_EGRESS_PROXY_URL']!);
    assert.match(dataUrl.hostname, /^\d+\.\d+\.\d+\.\d+$/, 'a job container cannot resolve `dev-egress-proxy`');
    const proxyNets = overlay.services['dev-egress-proxy']!.networks as Record<string, { ipv4_address?: string }>;
    assert.equal(proxyNets['dev-egress']?.ipv4_address, dataUrl.hostname, 'and that address must be the pinned one');
    assert.equal(dataUrl.port, '3128');
  });

  it('reaches the control plane on dev-control, not on the network the jobs are on', () => {
    const env = overlay.services['dev-runner-daemon']!.environment!;
    const controlUrl = new URL(env['DEV_RUNNER_EGRESS_PROXY_CONTROL_URL']!);
    const proxyNets = overlay.services['dev-egress-proxy']!.networks as Record<string, { ipv4_address?: string }>;
    assert.equal(controlUrl.hostname, proxyNets['dev-control']?.ipv4_address);
    assert.equal(controlUrl.port, '3129');
    // The daemon must not be able to speak to the jobs' network at all.
    assert.ok(!networkNames(overlay.services['dev-runner-daemon']).includes('dev-egress'));
  });

  it('pins the dev-egress subnet so the proxy address is stable', () => {
    const ipam = overlay.networks?.['dev-egress']?.ipam as { config?: { subnet?: string }[] } | undefined;
    assert.equal(ipam?.config?.[0]?.subnet, '172.28.5.0/24');
  });

  it('routes even the nested engine’s registry pulls through the proxy', () => {
    const env = overlay.services['dev-dind']!.environment!;
    assert.equal(env['HTTP_PROXY'], 'http://172.28.5.3:3128');
    assert.equal(env['HTTPS_PROXY'], 'http://172.28.5.3:3128');
  });
});

describe('dev-platform compose overlay — one image, two services, two commands', () => {
  it('runs the daemon and the proxy from the same build with different entrypoints', () => {
    const daemon = overlay.services['dev-runner-daemon']!;
    const proxy = overlay.services['dev-egress-proxy']!;
    assert.equal(daemon.image, proxy.image, 'one build');
    assert.deepEqual(daemon.command, ['node', 'src/daemon.mjs']);
    assert.deepEqual(proxy.command, ['node', 'src/proxy.mjs']);
  });

  it('never hands the proxy the daemon’s engine credentials', () => {
    // Same image, so only the environment separates them. The proxy terminates
    // traffic from hostile job containers; it must hold nothing worth stealing.
    const proxy = overlay.services['dev-egress-proxy']!;
    assert.equal(proxy.environment?.['DOCKER_HOST'], undefined);
    assert.equal(proxy.privileged, undefined);
    assert.ok((proxy.volumes ?? []).every((v) => !v.includes('certs')), 'no engine client certs');
  });

  it('refuses to boot the daemon without an image allowlist', () => {
    // The one boundary a compromised middleware cannot cross: it may name a job,
    // never an image. `parseAllowedImages` throws when this is absent.
    assert.ok(overlay.services['dev-runner-daemon']!.environment!['DEV_RUNNER_ALLOWED_IMAGES']);
  });
});
