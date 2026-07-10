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

import { checkTemplateManifest, templateManifestVersion, type TemplateManifest } from '@omadia/conductor-core';

import type { ConductorTemplateStore, TemplateRecord, TemplateStatus } from './templateStore.js';

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

// ---------------------------------------------------------------------------
// Composite catalog (issue #478, templates v2): bundled files + DB-backed user
// templates + plugin-contributed entries behind ONE viewer-scoped interface.
// ---------------------------------------------------------------------------

/** Wire shape of a catalog entry — the v1 TemplateManifest plus ADDITIVE
 *  metadata (#330 contract: `GET /templates` stays one shape, extended only). */
export type TemplateSummary = TemplateManifest & {
  source: 'bundled' | 'user' | 'plugin';
  /** user templates only. */
  status?: TemplateStatus;
  /** user templates only. */
  createdBy?: string;
  /** served manifest version (1 for bundled/plugin unless the manifest says otherwise). */
  version: number;
  latestVersion: number;
  instantiationCount: number;
  /** user templates only. */
  updatedAt?: string;
};

export interface CompositeTemplateCatalog {
  list(viewer: string): Promise<TemplateSummary[]>;
  get(id: string, viewer: string): Promise<TemplateSummary | undefined>;
  /** Which read-only static source ('bundled' | 'plugin') claims this id, if
   *  any — POST /templates' collision gate (409 before touching the DB). */
  staticSource(id: string): 'bundled' | 'plugin' | undefined;
  /** Registration seam for plugin-borne templates (consumed by the install
   *  service, #478 B3). Replaces the plugin's previous set; the caller has
   *  already run the strict import gate. */
  registerPluginTemplates(pluginId: string, manifests: TemplateManifest[]): void;
  unregisterPluginTemplates(pluginId: string): void;
}

/**
 * Visibility rule (#478 — the reviewer-reachable review gate). A user template
 * is visible to `viewer` iff it is 'shared', OR owned by the viewer, OR
 * 'pending': the operator API surface is single-tier, so EVERY authenticated
 * operator is a potential reviewer — without the pending clause the only person
 * able to see (and approve) a submission would be its author. Only 'private'
 * templates of OTHER authors are hidden. Write authorization is separate
 * (routes: PUT/DELETE/submit author-only; approve/reject any operator).
 */
export function userTemplateVisible(record: Pick<TemplateRecord, 'status' | 'createdBy'>, viewer: string): boolean {
  return record.status === 'shared' || record.status === 'pending' || record.createdBy === viewer;
}

/**
 * Compose bundled + user + plugin templates. `list`/`get` apply EXACTLY the same
 * visibility rule (no 404-vs-list divergence). Id collisions across sources are
 * resolved bundled > plugin > user — POST /templates prevents new user-side
 * collisions, this is the defense for pre-existing rows; collisions are logged.
 */
export function createCompositeTemplateCatalog(opts: {
  bundled: TemplateCatalog;
  store: ConductorTemplateStore;
  log?: (msg: string) => void;
}): CompositeTemplateCatalog {
  const log = opts.log ?? ((msg: string) => console.warn(msg));
  const pluginTemplates = new Map<string, TemplateManifest[]>();

  function pluginEntries(): Map<string, TemplateManifest> {
    const byId = new Map<string, TemplateManifest>();
    for (const [pluginId, manifests] of pluginTemplates) {
      for (const manifest of manifests) {
        if (opts.bundled.get(manifest.id) || byId.has(manifest.id)) {
          log(`[conductor] plugin '${pluginId}' template id '${manifest.id}' collides with an existing catalog entry — skipped`);
          continue;
        }
        byId.set(manifest.id, manifest);
      }
    }
    return byId;
  }

  function staticSummary(manifest: TemplateManifest, source: 'bundled' | 'plugin', counts: Record<string, number>): TemplateSummary {
    const version = templateManifestVersion(manifest);
    return {
      ...manifest,
      source,
      version,
      latestVersion: version,
      instantiationCount: counts[manifest.id] ?? 0,
    };
  }

  function userSummary(record: TemplateRecord, counts: Record<string, number>): TemplateSummary {
    return {
      ...record.manifest,
      source: 'user',
      status: record.status,
      createdBy: record.createdBy,
      version: record.latestVersion,
      latestVersion: record.latestVersion,
      instantiationCount: counts[record.id] ?? 0,
      updatedAt: record.updatedAt,
    };
  }

  return {
    async list(viewer) {
      const counts = await opts.store.instantiationCounts();
      const out: TemplateSummary[] = [];
      const taken = new Set<string>();
      for (const manifest of opts.bundled.list()) {
        out.push(staticSummary(manifest, 'bundled', counts));
        taken.add(manifest.id);
      }
      for (const manifest of pluginEntries().values()) {
        out.push(staticSummary(manifest, 'plugin', counts));
        taken.add(manifest.id);
      }
      for (const record of await opts.store.list()) {
        if (taken.has(record.id)) {
          log(`[conductor] user template id '${record.id}' shadows a ${this.staticSource(record.id) ?? 'static'} entry — skipped`);
          continue;
        }
        if (userTemplateVisible(record, viewer)) out.push(userSummary(record, counts));
      }
      return out.sort((a, b) => a.id.localeCompare(b.id));
    },

    async get(id, viewer) {
      const counts = await opts.store.instantiationCounts();
      const bundled = opts.bundled.get(id);
      if (bundled) return staticSummary(bundled, 'bundled', counts);
      const plugin = pluginEntries().get(id);
      if (plugin) return staticSummary(plugin, 'plugin', counts);
      const record = await opts.store.get(id);
      if (!record || !userTemplateVisible(record, viewer)) return undefined;
      return userSummary(record, counts);
    },

    staticSource(id) {
      if (opts.bundled.get(id)) return 'bundled';
      if (pluginEntries().has(id)) return 'plugin';
      return undefined;
    },

    registerPluginTemplates(pluginId, manifests) {
      pluginTemplates.set(pluginId, [...manifests]);
    },

    unregisterPluginTemplates(pluginId) {
      pluginTemplates.delete(pluginId);
    },
  };
}
