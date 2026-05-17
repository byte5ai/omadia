import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import path from 'node:path';

import yaml from 'yaml';
import { z } from 'zod';

import { ASSETS } from '../../platform/assets.js';
import { registerAgentTemplate } from './agentSpec.js';

/**
 * BoilerplateSource — resolves builder templates from the on-disk
 * `docs/harness-platform/boilerplate/<templateId>/` tree.
 *
 * Each template directory ships a `template.yaml` manifest declaring its
 * slot keys, placeholder mapping, and skip-list. The CodegenEngine (B.1-3)
 * reflects against that manifest rather than against hardcoded constants —
 * adding a new agent archetype is a directory drop plus
 * `registerAgentTemplate(id)`, not a codegen patch.
 *
 * Templates are memoized per id; load cost is paid once per process.
 * `bootstrapTemplates()` discovers all templates on disk and registers
 * them with the AgentSpec template registry — call once during builder
 * plugin activation.
 */

// --- Template manifest schema -------------------------------------------

const SlotDefSchema = z
  .object({
    key: z.string().min(1),
    target_file: z.string().min(1),
    required: z.boolean().default(false),
    description: z.string().optional(),
    // Additional partial slots permitted under `<key>-1`, …, `<key>-N`.
    // Codegen synthesises one output file per non-empty partial (target_file
    // with the index inserted before the last extension) and lists all
    // partials in manifest.skills[]. Lets large markdowns be split across
    // multiple fill_slot calls (each call stays under the Anthropic tool-
    // call argument-size limit). Default 0 = classic single-slot behaviour.
    max_partials: z.number().int().min(0).max(20).default(0),
  })
  .strict();

export type SlotDef = z.infer<typeof SlotDefSchema>;

const TemplateManifestSchema = z
  .object({
    id: z.string().min(1),
    description: z.string().min(1),
    slots: z.array(SlotDefSchema).default([]),
    placeholders: z.record(z.string(), z.string()).default({}),
    skip_files: z.array(z.string()).default([]),
  })
  .strict();

export type TemplateManifest = z.infer<typeof TemplateManifestSchema>;

// --- Boilerplate bundle --------------------------------------------------

export interface BoilerplateBundle {
  manifest: TemplateManifest;
  files: ReadonlyMap<string, Buffer>;
}

const cache = new Map<string, BoilerplateBundle>();

const DEFAULT_SKIP_NAMES = new Set<string>([
  'CLAUDE.md',
  'template.yaml',
  'node_modules',
  'dist',
  'out',
  '.git',
  // Git-state markers ship with the boilerplate to preserve empty
  // directories like `assets/`. They must NOT land in the built zip
  // because zipExtractor's allowlist rejects extension-less names
  // (`path.extname('.gitkeep') === ''`). The empty dir is recreated
  // on-the-fly when the activated plugin actually writes to assets/.
  '.gitkeep',
  '.gitignore',
]);

const SKIP_SUFFIXES = ['.tsbuildinfo', '.DS_Store'];

function shouldSkip(relPath: string, manifestSkipSet: ReadonlySet<string>): boolean {
  const segments = relPath.split(path.sep);
  for (const seg of segments) {
    if (DEFAULT_SKIP_NAMES.has(seg) || manifestSkipSet.has(seg)) return true;
  }
  for (const suffix of SKIP_SUFFIXES) {
    if (relPath.endsWith(suffix)) return true;
  }
  return false;
}

async function* walk(root: string, base: string): AsyncGenerator<string> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walk(abs, base);
    } else if (entry.isFile()) {
      yield path.relative(base, abs);
    }
  }
}

export async function loadBoilerplate(templateId: string): Promise<BoilerplateBundle> {
  const cached = cache.get(templateId);
  if (cached) return cached;

  const dir = path.join(ASSETS.boilerplate.root, templateId);

  try {
    const stat = await fs.stat(dir);
    if (!stat.isDirectory()) {
      throw new Error(`not a directory: ${dir}`);
    }
  } catch (err) {
    throw new Error(
      `BoilerplateSource: template '${templateId}' not found at ${dir} (${(err as Error).message})`,
    );
  }

  const manifestPath = path.join(dir, 'template.yaml');
  let manifest: TemplateManifest;
  try {
    const raw = await fs.readFile(manifestPath, 'utf-8');
    const parsed = yaml.parse(raw) as unknown;
    manifest = TemplateManifestSchema.parse(parsed);
  } catch (err) {
    throw new Error(
      `BoilerplateSource: failed to parse template.yaml for '${templateId}': ${(err as Error).message}`,
    );
  }

  if (manifest.id !== templateId) {
    throw new Error(
      `BoilerplateSource: template.yaml.id '${manifest.id}' does not match directory name '${templateId}'`,
    );
  }

  const manifestSkipSet = new Set(manifest.skip_files);
  const files = new Map<string, Buffer>();
  for await (const rel of walk(dir, dir)) {
    if (shouldSkip(rel, manifestSkipSet)) continue;
    const abs = path.join(dir, rel);
    files.set(rel, await fs.readFile(abs));
  }

  const bundle: BoilerplateBundle = { manifest, files };
  cache.set(templateId, bundle);
  return bundle;
}

/**
 * Scan the boilerplate root for template directories that contain a
 * `template.yaml`. Returns sorted ids.
 */
export async function discoverTemplates(): Promise<readonly string[]> {
  const root = ASSETS.boilerplate.root;
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const templates: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(root, entry.name, 'template.yaml');
    try {
      await fs.access(manifestPath);
      templates.push(entry.name);
    } catch {
      // Sibling directory without a template.yaml — skip silently.
    }
  }
  return templates.sort();
}

/**
 * Discover all on-disk templates and register them with the AgentSpec
 * template registry. Called once during builder plugin activation
 * (B.5) — eager load lets the spec parser accept any template id the
 * UI exposes.
 */
export async function bootstrapTemplates(): Promise<void> {
  const ids = await discoverTemplates();
  for (const id of ids) {
    registerAgentTemplate(id);
  }
}

/** Test helper — clears the per-template cache. */
export function _resetCacheForTests(): void {
  cache.clear();
}
