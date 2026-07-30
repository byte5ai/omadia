/**
 * Fixtures for the plugin-package ingest pipeline: a minimal schema-v1
 * package zip plus the two collaborators `PackageUploadService` needs.
 *
 * Shared by `pluginInstallPathTraversal.test.ts` (identity/containment gates)
 * and `pluginPackageSqlAllowlist.test.ts` (the `.sql` extension entry, which
 * is only admissible while those gates hold).
 */

import yazl from 'yazl';

import type { PluginCatalog } from '../../src/plugins/manifestLoader.js';
import type {
  UploadedPackage,
  UploadedPackageStore,
} from '../../src/plugins/uploadedPackageStore.js';

/** Builds an in-memory zip from a `path → utf-8 content` map. */
export function buildZip(files: Record<string, string>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (c: Buffer) => chunks.push(c));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
    for (const [name, content] of Object.entries(files)) {
      zip.addBuffer(Buffer.from(content, 'utf-8'), name, { mtime: new Date(0) });
    }
    zip.end();
  });
}

/** The smallest manifest `adaptManifestV1` accepts, with a caller-set identity. */
export function manifestYaml(id: string, version: string): string {
  return `schema_version: "1"

identity:
  id: ${JSON.stringify(id)}
  name: "Install Fixture"
  version: ${JSON.stringify(version)}
  kind: "tool"
  description: "Fixture plugin for install-pipeline tests."

compat:
  core: ">=1.0 <2.0"

lifecycle:
  entry: "dist/plugin.js"
`;
}

/**
 * A well-formed package zip. `extraFiles` are merged on top, which is how the
 * `.sql` suite adds `migrations/*.sql` without a second builder.
 */
export function packageZip(
  id: string,
  version: string,
  extraFiles: Record<string, string> = {},
): Promise<Buffer> {
  return buildZip({
    'manifest.yaml': manifestYaml(id, version),
    'dist/plugin.js': 'module.exports = { activate() {} };\n',
    ...extraFiles,
  });
}

export function fakeStore(): UploadedPackageStore {
  const packages = new Map<string, UploadedPackage>();
  return {
    get: (id: string) => packages.get(id),
    list: () => [...packages.values()],
    register: async (pkg: UploadedPackage) => {
      packages.set(pkg.id, pkg);
    },
  } as unknown as UploadedPackageStore;
}

export function fakeCatalog(): PluginCatalog {
  return {
    get: () => undefined,
    load: async () => undefined,
    list: () => [],
  } as unknown as PluginCatalog;
}
