import { createHash } from 'node:crypto';

import { execDockerViaSpawn, type DockerExec } from '@omadia/sandbox';

import type { PublishRuntime } from './publish.js';

/**
 * v1 `PublishRuntime` (issue #581 P1): local Docker, same injectable-exec
 * seam as `@omadia/sandbox`'s `DockerSandboxBackend` (`dockerExec.ts`) —
 * deliberately reused rather than re-implemented, so publish's Docker tests
 * follow the exact stub/real-Docker split `dockerSandbox.test.ts` already
 * established.
 *
 * ## One container per VERSION, one data volume per APP
 *
 * Each version gets its OWN container, named deterministically from
 * `(appId, version)` — `deploy()` for a version that already has a
 * container is a no-op, which is what makes a version immutable at the
 * runtime layer too (not just in the store): nothing in this class ever
 * re-materializes an existing version's files.
 *
 * The `$DATA_DIR` volume, by contrast, is named from `appId` ALONE and
 * mounted into every version's container at the same in-container path
 * (`/data`). That is the entire mechanism behind the durability contract:
 * a fresh version's container starts with a brand-new filesystem for
 * everything else, but `/data` is the SAME Docker volume every prior
 * version for this app also mounted — so a file written outside `/data` is
 * gone the moment a new version replaces the running container, and a file
 * written inside `/data` survives every redeploy.
 *
 * ## Reachability: `docker port`, not a fixed mapping
 *
 * Containers publish their app port to an OS-assigned host port
 * (`-p 127.0.0.1::<containerPort>`) rather than a fixed one, so many
 * versions/apps can run concurrently without a port-allocation table this
 * class would have to own. `portFor()` asks Docker itself via
 * `docker port <container> <containerPort>/tcp` — the same "Docker is the
 * durable store" posture `DockerSandboxBackend` takes for container
 * naming.
 */
export interface DockerPublishRuntimeOptions {
  /** Must have Node on PATH — v1 supports only a Node entrypoint (a static
   *  site publishes as a small Node script serving its own files; see the
   *  package README). */
  readonly image?: string;
  readonly execDocker?: DockerExec;
  /** In-container port the entrypoint is told (via `PORT`) to listen on. */
  readonly appPort?: number;
  /** In-container path for the durable data volume (`DATA_DIR`). */
  readonly dataDir?: string;
}

const DEFAULT_IMAGE = 'node:20-alpine';
const DEFAULT_APP_PORT = 8080;
const DEFAULT_DATA_DIR = '/data';
const APP_ROOT = '/app';
const CONTAINER_PREFIX = 'omadia-pub-';
const VOLUME_PREFIX = 'omadia-pub-data-';

function containerNameFor(appId: string, version: number): string {
  const digest = createHash('sha256').update(`${appId}:${String(version)}`, 'utf8').digest('hex').slice(0, 24);
  return `${CONTAINER_PREFIX}${digest}`;
}

function dataVolumeFor(appId: string): string {
  const digest = createHash('sha256').update(appId, 'utf8').digest('hex').slice(0, 24);
  return `${VOLUME_PREFIX}${digest}`;
}

export class DockerPublishRuntime implements PublishRuntime {
  private readonly image: string;
  private readonly execDocker: DockerExec;
  private readonly appPort: number;
  private readonly dataDir: string;

  constructor(options: DockerPublishRuntimeOptions = {}) {
    this.image = options.image ?? DEFAULT_IMAGE;
    this.execDocker = options.execDocker ?? execDockerViaSpawn;
    this.appPort = options.appPort ?? DEFAULT_APP_PORT;
    this.dataDir = options.dataDir ?? DEFAULT_DATA_DIR;
  }

  async deploy(args: {
    readonly appId: string;
    readonly version: number;
    readonly entrypoint: string;
    readonly files: ReadonlyMap<string, string>;
  }): Promise<void> {
    const name = containerNameFor(args.appId, args.version);
    if (await this.containerExists(name)) return; // immutable: never re-materialize a version

    const volume = dataVolumeFor(args.appId);
    await this.exec(['volume', 'create', volume], 30_000);

    const runArgs = [
      'run',
      '-d',
      '--name',
      name,
      '--label',
      `omadia.publish.app=${args.appId}`,
      '--label',
      `omadia.publish.version=${String(args.version)}`,
      '-p',
      `127.0.0.1::${String(this.appPort)}`,
      '-v',
      `${volume}:${this.dataDir}`,
      '--workdir',
      APP_ROOT,
      this.image,
      'sh',
      '-c',
      `mkdir -p '${APP_ROOT}' && exec sleep infinity`,
    ];
    const run = await this.exec(runArgs, 60_000);
    if (run.exitCode !== 0) {
      throw new Error(`DockerPublishRuntime: failed to start container for '${args.appId}' v${String(args.version)}: ${run.stderr || run.stdout}`);
    }

    for (const [relativePath, content] of args.files) {
      const target = `${APP_ROOT}/${relativePath}`;
      const parentDir = target.slice(0, target.lastIndexOf('/')) || APP_ROOT;
      const write = await this.exec(
        ['exec', '-i', name, 'sh', '-c', `mkdir -p '${parentDir}' && cat > '${target}'`],
        30_000,
        content,
      );
      if (write.exitCode !== 0) {
        throw new Error(`DockerPublishRuntime: failed to write '${relativePath}' for '${args.appId}' v${String(args.version)}: ${write.stderr}`);
      }
    }

    const start = await this.exec(
      [
        'exec',
        '-d',
        '-e',
        `PORT=${String(this.appPort)}`,
        '-e',
        `DATA_DIR=${this.dataDir}`,
        name,
        'sh',
        '-c',
        `cd '${APP_ROOT}' && node '${args.entrypoint}' > /tmp/omadia-publish-app.log 2>&1`,
      ],
      15_000,
    );
    if (start.exitCode !== 0) {
      throw new Error(`DockerPublishRuntime: failed to start entrypoint for '${args.appId}' v${String(args.version)}: ${start.stderr}`);
    }
  }

  /** The host port currently serving `appId`'s `version`, or `undefined`
   *  when that version was never deployed (or its container is gone). Never
   *  consults `PublishStore` — the caller decides which version's port it
   *  wants (typically the store's current pointer). */
  async portFor(appId: string, version: number): Promise<number | undefined> {
    const name = containerNameFor(appId, version);
    const result = await this.exec(['port', name, `${String(this.appPort)}/tcp`], 15_000);
    if (result.exitCode !== 0) return undefined;
    const line = result.stdout.trim().split('\n')[0] ?? '';
    const port = Number(line.slice(line.lastIndexOf(':') + 1));
    return Number.isFinite(port) && port > 0 ? port : undefined;
  }

  private async containerExists(name: string): Promise<boolean> {
    const result = await this.exec(['ps', '-a', '--filter', `name=^${name}$`, '--format', '{{.Names}}'], 15_000);
    return result.stdout.trim().split('\n').includes(name);
  }

  private exec(args: readonly string[], timeoutMs: number, input?: string): ReturnType<DockerExec> {
    return this.execDocker({
      args,
      timeoutMs,
      maxOutputBytes: 4 * 1024 * 1024,
      ...(input !== undefined ? { input } : {}),
    });
  }
}

export const _internal = { containerNameFor, dataVolumeFor };
