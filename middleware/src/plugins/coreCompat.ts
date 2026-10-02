/**
 * `compat.core` — the host range a plugin states in its manifest.
 *
 * A plugin imports `@omadia/plugin-api` from the HOST at runtime (an uploaded
 * package reaches the host's node_modules through the link
 * `ensureHostNodeModulesLink` lays down), so the version that matters is the
 * host's `@omadia/plugin-api`: a plugin built against a newer one can name an
 * export this host lacks, and an ESM named import of a missing export fails
 * the whole module at link time. Until now `compat.core` was only read
 * (manifestLoader's `compat_core`, default ">=1.0 <2.0"), never enforced.
 *
 * Enforced where a package comes in:
 *  - `PackageUploadService.ingest` — every ZIP (operator upload, hub install,
 *    depends_on chain, builder install, vendored profile bundle) is refused as
 *    `package.incompatible_core` before it is stored;
 *  - `InstallService.create` — installing a catalog entry, which also covers a
 *    package uploaded before the ingest check existed (`install.incompatible_core`).
 * Not gated: profile apply and the boot of already-installed plugins. Bundled
 * packages ship with this plugin-api and their manifests admit it (pinned by
 * test/coreCompat.test.ts).
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import semver from 'semver';

export const PLUGIN_API_PACKAGE = '@omadia/plugin-api';

/** The range of a manifest without `compat.core`, as manifestLoader and
 *  registryClient default it. */
export const DEFAULT_COMPAT_CORE = '>=1.0 <2.0';

/** What {@link checkCoreCompat} reads from a catalog entry's `plugin`. */
export interface CoreCompatSubject {
  readonly id: string;
  readonly version: string;
  /** The manifest's `compat.core`; absent means {@link DEFAULT_COMPAT_CORE}. */
  readonly compat_core?: string;
}

export interface CoreCompatRefusal {
  /** `unsatisfied`: the range excludes this host. `invalid_range`: not a semver range. */
  readonly reason: 'unsatisfied' | 'invalid_range';
  /** Operator- and model-readable: names the plugin, the range, this host's
   *  plugin-api version and the way out. */
  readonly message: string;
  readonly compat_core: string;
  readonly host_plugin_api: string;
}

/**
 * The `@omadia/plugin-api` version a plugin on this host links against: the
 * package.json above the module `@omadia/plugin-api` resolves to from here.
 * (The package's `exports` map does not expose `./package.json`, so the entry
 * is resolved and its package root found by walking up.)
 */
export function readHostPluginApiVersion(): string {
  const entry = createRequire(import.meta.url).resolve(PLUGIN_API_PACKAGE);
  for (let dir = path.dirname(entry); ; dir = path.dirname(dir)) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
        name?: unknown;
        version?: unknown;
      };
      if (pkg.name === PLUGIN_API_PACKAGE && typeof pkg.version === 'string') {
        return pkg.version;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (path.dirname(dir) === dir) {
      throw new Error(`cannot find the package.json of ${PLUGIN_API_PACKAGE} above ${entry}`);
    }
  }
}

let hostVersion: string | undefined;

/** {@link readHostPluginApiVersion}, read once per process. */
export function hostPluginApiVersion(): string {
  hostVersion ??= readHostPluginApiVersion();
  return hostVersion;
}

/**
 * `null` when the plugin's `compat.core` admits `host`, otherwise why not.
 * Prereleases count (`includePrerelease`), so a host on `1.22.0-rc.1` still
 * satisfies ">=1.0 <2.0".
 */
export function checkCoreCompat(
  plugin: CoreCompatSubject,
  host: string = hostPluginApiVersion(),
): CoreCompatRefusal | null {
  const range = plugin.compat_core ?? DEFAULT_COMPAT_CORE;
  const subject = `Plugin '${plugin.id}' ${plugin.version}`;
  if (semver.validRange(range) === null) {
    return {
      reason: 'invalid_range',
      message:
        `${subject} declares compat.core ${JSON.stringify(range)}, which is not a semver ` +
        `range, so it cannot be checked against this host (${PLUGIN_API_PACKAGE} ${host}). ` +
        `The plugin's manifest.yaml must state compat.core as a range such as ">=1.20 <2.0".`,
      compat_core: range,
      host_plugin_api: host,
    };
  }
  if (semver.satisfies(host, range, { includePrerelease: true })) return null;
  return {
    reason: 'unsatisfied',
    message:
      `${subject} cannot run on this host: its manifest requires ${PLUGIN_API_PACKAGE} ` +
      `${range} (compat.core), and this host provides ${PLUGIN_API_PACKAGE} ${host}. ` +
      `Install a version of the plugin whose compat.core includes ${host}, or update omadia.`,
    compat_core: range,
    host_plugin_api: host,
  };
}
