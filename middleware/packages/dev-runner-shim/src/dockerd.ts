/**
 * Epic #470 W5 — opt-in Docker-in-Docker start hook (spec §8).
 *
 * The `dockerInJob` capability reaches the shim in TWO shapes, and the shim's job
 * differs between them:
 *
 *  - DOCKER BACKEND: the runner daemon already started a rootless dind SIDECAR on
 *    the job's isolated network BEFORE the job container and wired the job's
 *    `DOCKER_HOST=tcp://dind:2376` (+ per-job TLS certs). The shim must do NOTHING
 *    — its docker client already points at the sidecar. Detected by `DOCKER_HOST`
 *    being present.
 *
 *  - FLY BACKEND: there is no sidecar. The same flag makes the shim start `dockerd`
 *    INSIDE the microVM (rootful-in-VM is acceptable — the Firecracker VM is the
 *    boundary), subject to the same nftables egress rules the Fly shim entrypoint
 *    installs. Detected by `DOCKER_HOST` being ABSENT while the capability is set.
 *
 * Node builtins only — no dependency may enter the shim bundle.
 */

import { spawn } from 'node:child_process';

/** The narrow slice of the spec this hook reads. */
export interface DockerInJobCapableSpec {
  capabilities?: { dockerInJob?: boolean };
}

export interface StartDockerdDeps {
  /** Test seam: the actual dockerd launcher. Defaults to the in-VM spawn below. */
  startDockerd?: () => Promise<void>;
  /** Env lookup seam (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

export type DockerdStartReason = 'not_requested' | 'sidecar' | 'in_vm';

export interface DockerdStartResult {
  started: boolean;
  reason: DockerdStartReason;
}

/**
 * Decide whether — and how — to make Docker available to the job, and act.
 *
 * Returns without starting anything when the repo did not opt in, or when a
 * daemon-provisioned sidecar already owns `DOCKER_HOST`. Only the Fly path (flag
 * set, no `DOCKER_HOST`) actually starts a daemon.
 */
export async function maybeStartDockerd(
  spec: DockerInJobCapableSpec,
  deps: StartDockerdDeps = {},
): Promise<DockerdStartResult> {
  const log = deps.log ?? (() => {});
  const env = deps.env ?? process.env;

  if (spec.capabilities?.dockerInJob !== true) return { started: false, reason: 'not_requested' };

  // Docker backend: the daemon's sidecar already owns DOCKER_HOST. Do nothing —
  // starting a second dockerd here would fight the wired TLS client.
  const dockerHost = env['DOCKER_HOST'];
  if (typeof dockerHost === 'string' && dockerHost.trim() !== '') {
    log('dockerInJob: DOCKER_HOST set — using the daemon-provisioned dind sidecar; not starting dockerd');
    return { started: false, reason: 'sidecar' };
  }

  // Fly backend: no sidecar — start dockerd inside the VM.
  log('dockerInJob: no DOCKER_HOST — starting in-VM dockerd (Fly path)');
  const start = deps.startDockerd ?? defaultStartDockerd(log);
  await start();
  return { started: true, reason: 'in_vm' };
}

/**
 * Best-effort in-VM dockerd launcher — the HOOK, not a finished Fly integration.
 *
 * TODO(W5/Fly, spec §8): a production-grade rootful dockerd inside the Firecracker
 * VM needs (1) the Fly shim entrypoint's nftables default-drop + proxy-uid allow
 * rules installed BEFORE dockerd binds; (2) a readiness wait on the docker socket;
 * (3) teardown on shim exit. Those belong to the FlyMachinesBackend's entrypoint
 * (spec §2 in-VM enforcement), not this bundle. The Docker-backend path is fully
 * implemented via the daemon sidecar; this stub only spawns dockerd detached so the
 * capability is wired end-to-end and the launcher is swappable.
 */
function defaultStartDockerd(log: (line: string) => void): () => Promise<void> {
  return async () => {
    const child = spawn('dockerd', [], { stdio: 'ignore', detached: true });
    child.on('error', (err: unknown) =>
      log(`dockerd start failed (expected outside a Fly VM): ${err instanceof Error ? err.message : String(err)}`),
    );
    child.unref();
  };
}
