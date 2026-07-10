// File-based conductor workflow-template catalog (issue #429). Bundled
// TemplateManifest JSONs live next to this module in `templates/` (mirrored
// into dist/ by scripts/copy-build-assets.mjs, which `npm run build` runs —
// the Docker image picks them up through its existing dist COPY). Loaded
// once at wire time.
//
// An invalid or unparsable asset is skipped with a loud log line — a broken
// bundled file must never brick boot; the CI gate
// (test/conductorTemplateCatalog.test.ts) is the hard check that the shipped
// catalog is complete and valid.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkTemplateManifest, type TemplateManifest } from '@omadia/conductor-core';

const DEFAULT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'templates');

export interface TemplateCatalog {
  /** All valid manifests, sorted by id. Returns a fresh array on every call. */
  list(): TemplateManifest[];
  get(id: string): TemplateManifest | undefined;
}

/**
 * Read every `*.json` in the templates dir (dirname-relative by default, so it
 * works from src under tsx and from dist in production; overridable for tests),
 * keep the manifests that pass `checkTemplateManifest`, and serve them from an
 * in-memory map. Duplicate ids keep the first file (files are processed in
 * filename order) and log the collision.
 */
export function loadTemplateCatalog(opts?: {
  dir?: string;
  log?: (msg: string) => void;
}): TemplateCatalog {
  const dir = opts?.dir ?? DEFAULT_DIR;
  const log = opts?.log ?? ((msg: string) => console.warn(msg));

  let files: string[] = [];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort();
  } catch (err) {
    log(`[conductor] template dir '${dir}' unreadable: ${err instanceof Error ? err.message : String(err)}`);
  }

  const byId = new Map<string, TemplateManifest>();
  for (const file of files) {
    let manifest: TemplateManifest;
    try {
      manifest = JSON.parse(readFileSync(join(dir, file), 'utf8')) as TemplateManifest;
      // checkTemplateManifest assumes the overall manifest object shape
      // (e.g. a `slots` object); a JSON file with a completely different
      // shape may make it throw — same treatment as a failed check.
      const result = checkTemplateManifest(manifest);
      if (!result.ok) {
        log(`[conductor] template ${file} invalid: ${result.errors.map((e) => e.message).join('; ')}`);
        continue;
      }
    } catch (err) {
      log(`[conductor] template ${file} invalid: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (byId.has(manifest.id)) {
      log(`[conductor] template ${file} duplicates id '${manifest.id}' — keeping the first occurrence`);
      continue;
    }
    byId.set(manifest.id, manifest);
  }

  const templates = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  return {
    list: () => [...templates],
    get: (id: string) => byId.get(id),
  };
}
