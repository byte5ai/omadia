// Curated ephemeral-workflow patterns (#330 Workstream A). A pattern IS a
// TemplateManifest — same slot machinery, same validation — but it lives in a
// separate, deliberately smaller catalog: `conductor.createEphemeralRun` may
// only instantiate what ships in `patterns/` (mirrored into dist/ by
// scripts/copy-build-assets.mjs), never user- or plugin-contributed templates.
// That keeps agent-generated workflows generative AND validatable: the agent
// fills slots in an engine-checked graph, it cannot submit arbitrary graphs.
//
// Same resilience contract as templateCatalog.ts: an invalid bundled file is
// skipped with a loud log line and the CI test over the shipped patterns is
// the hard completeness gate.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkTemplateManifest, type TemplateManifest } from '@omadia/conductor-core';

const DEFAULT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'patterns');

export interface PatternCatalog {
  /** All valid patterns, sorted by id. Returns a fresh array on every call. */
  list(): TemplateManifest[];
  get(id: string): TemplateManifest | undefined;
}

/**
 * Read every `*.json` in the patterns dir (dirname-relative by default so it
 * works from src under tsx and from dist in production; overridable for tests),
 * keep the manifests that pass `checkTemplateManifest`, and serve them from an
 * in-memory map. Duplicate ids keep the first file (filename order) and log
 * the collision.
 */
export function loadPatternCatalog(opts?: {
  dir?: string;
  log?: (msg: string) => void;
}): PatternCatalog {
  const dir = opts?.dir ?? DEFAULT_DIR;
  const log = opts?.log ?? ((msg: string) => console.warn(msg));

  let files: string[] = [];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort();
  } catch (err) {
    log(`[conductor] pattern dir '${dir}' unreadable: ${err instanceof Error ? err.message : String(err)}`);
  }

  const byId = new Map<string, TemplateManifest>();
  for (const file of files) {
    let manifest: TemplateManifest;
    try {
      manifest = JSON.parse(readFileSync(join(dir, file), 'utf8')) as TemplateManifest;
      const result = checkTemplateManifest(manifest);
      if (!result.ok) {
        log(`[conductor] pattern ${file} invalid: ${result.errors.map((e) => e.message).join('; ')}`);
        continue;
      }
    } catch (err) {
      log(`[conductor] pattern ${file} invalid: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (byId.has(manifest.id)) {
      log(`[conductor] pattern ${file} duplicates id '${manifest.id}' — keeping the first occurrence`);
      continue;
    }
    byId.set(manifest.id, manifest);
  }

  const patterns = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  return {
    list: () => [...patterns],
    get: (id: string) => byId.get(id),
  };
}
