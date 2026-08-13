// Plugin-borne conductor workflow templates (issue #478) — the designed trust
// boundary for template distribution. Design (recorded in
// docs/security-architecture.md §4):
//
//   Templates are DATA, never code. A plugin may CONTRIBUTE TemplateManifest
//   JSON files (declared under `permissions.templates` as package-relative
//   paths), and that is the entire capability: no runtime template API exists
//   (no `ctx.templates`, pluginContext.ts is untouched), nothing from these
//   files is ever executed, and every manifest passes the same
//   checkTemplateManifest pipeline as bundled/user templates — in STRICT mode,
//   where any undeclared concrete ref (agent/action/role/event/channel) is
//   rejected as a confusion/exfiltration vector pointing at install-local
//   entities. Accepted manifests register into the conductor's composite
//   catalog as read-only `source: 'plugin'` entries (no PUT/DELETE/submit) and
//   are unregistered on uninstall. Instantiation runs through the SAME
//   resolve/instantiate path with live KnownRefs validation, so a plugin
//   template referencing entities this install lacks fails visibly at mapping
//   time, never silently.
//
// The install-time gate here is fail-closed (any problem refuses the install);
// the boot-time re-registration sweep is fail-open per template (an already-
// installed plugin must never brick boot) — the hard gate already ran.

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { checkTemplateManifest } from '@omadia/conductor-core';
import type { TemplateManifest } from '@omadia/conductor-core';

import { isValidCron } from '../scheduler/cron.js';
import { extractTemplateDeclarations } from './manifestLoader.js';
import type { PluginCatalog } from './manifestLoader.js';
import type { InstalledRegistry } from './installedRegistry.js';

/** The composite template catalog's plugin seam (structurally matched by
 *  `CompositeTemplateCatalog` in src/conductor/templateCatalog.ts). */
export interface PluginTemplateRegistrar {
  registerPluginTemplates(pluginId: string, manifests: TemplateManifest[]): void;
  unregisterPluginTemplates(pluginId: string): void;
}

export interface PluginTemplateLoadResult {
  manifests: TemplateManifest[];
  /** Human-readable gate failures, one per rejected declaration. Non-empty
   *  errors mean the plugin's template set is NOT trustworthy as declared —
   *  the install path treats that as a hard failure. */
  errors: string[];
}

/**
 * Load + gate every declared template manifest of a plugin package:
 *
 *  1. `.json` files only;
 *  2. the path must resolve INSIDE the package root after symlink unwrapping
 *     (realpath on both sides — a symlink pointing outside the package is
 *     rejected even though the declared path looks confined);
 *  3. parse as JSON → TemplateManifest;
 *  4. the id must be namespaced `plugin:<pluginId>:<name>` so a plugin can
 *     never shadow a bundled or user template id;
 *  5. `checkTemplateManifest(manifest, { strict: true })` — full metadata +
 *     graph (conductorGraphSchema shape gate included) + slot-coverage check,
 *     with undeclared concrete refs REJECTED (strict distributed-manifest gate);
 *  6. every cron trigger value must pass isValidCron.
 *
 * Pure data validation — nothing is executed, no code paths, no eval.
 */
export async function loadPluginTemplates(
  pluginId: string,
  packageRoot: string,
  declaredPaths: string[],
): Promise<PluginTemplateLoadResult> {
  const manifests: TemplateManifest[] = [];
  const errors: string[] = [];

  let realRoot: string;
  try {
    realRoot = await fs.realpath(packageRoot);
  } catch (err) {
    return {
      manifests: [],
      errors: [`package root '${packageRoot}' unreadable: ${msg(err)}`],
    };
  }

  const seenIds = new Set<string>();
  for (const declared of declaredPaths) {
    if (!declared.endsWith('.json')) {
      errors.push(`template '${declared}': only .json manifests may be declared`);
      continue;
    }
    let real: string;
    try {
      real = await fs.realpath(path.resolve(realRoot, declared));
    } catch (err) {
      errors.push(`template '${declared}': unreadable (${msg(err)})`);
      continue;
    }
    if (!real.startsWith(realRoot + path.sep)) {
      errors.push(`template '${declared}': resolves outside the package root — rejected`);
      continue;
    }
    let manifest: TemplateManifest;
    try {
      manifest = JSON.parse(await fs.readFile(real, 'utf8')) as TemplateManifest;
    } catch (err) {
      errors.push(`template '${declared}': invalid JSON (${msg(err)})`);
      continue;
    }
    const idPrefix = `plugin:${pluginId}:`;
    if (typeof manifest.id !== 'string' || !manifest.id.startsWith(idPrefix) || manifest.id.length <= idPrefix.length) {
      errors.push(
        `template '${declared}': id must be namespaced '${idPrefix}<name>' (got ${JSON.stringify(
          (manifest as { id?: unknown }).id,
        )})`,
      );
      continue;
    }
    if (seenIds.has(manifest.id)) {
      errors.push(`template '${declared}': duplicate template id '${manifest.id}'`);
      continue;
    }
    try {
      const check = checkTemplateManifest(manifest, { strict: true });
      if (!check.ok) {
        errors.push(
          `template '${declared}': ${check.errors.map((e) => `${e.code}: ${e.message}`).join('; ')}`,
        );
        continue;
      }
    } catch (err) {
      // A wholly alien JSON shape can make the checker throw — same verdict
      // as a failed check (the catalog loader documents the same behavior).
      errors.push(`template '${declared}': manifest check failed (${msg(err)})`);
      continue;
    }
    let cronOk = true;
    for (const trigger of manifest.graph.triggers ?? []) {
      if (trigger.kind === 'cron' && (typeof trigger.cron !== 'string' || !isValidCron(trigger.cron))) {
        errors.push(
          `template '${declared}': trigger '${trigger.id}' carries an invalid cron expression ${JSON.stringify(trigger.cron)}`,
        );
        cronOk = false;
      }
    }
    if (!cronOk) continue;
    seenIds.add(manifest.id);
    manifests.push(manifest);
  }
  return { manifests, errors };
}

/**
 * Boot-time sweep: re-register the template manifests of every ALREADY
 * INSTALLED plugin into the conductor catalog (registrations are in-memory
 * and do not survive a restart). Deliberately fail-open per template with a
 * loud log line — the fail-closed gate ran at install time, and a template
 * problem must never brick boot (mirrors the bundled-catalog loader policy).
 */
export async function registerInstalledPluginTemplates(opts: {
  catalog: Pick<PluginCatalog, 'get'>;
  registry: Pick<InstalledRegistry, 'list'>;
  registrar: PluginTemplateRegistrar;
  log?: (msg: string) => void;
}): Promise<void> {
  const log = opts.log ?? ((m: string) => console.warn(m));
  for (const installed of opts.registry.list()) {
    const entry = opts.catalog.get(installed.id);
    if (!entry) continue;
    const declared = extractTemplateDeclarations(entry.manifest);
    for (const e of declared.errors) log(`[templates] plugin '${installed.id}': ${e}`);
    if (declared.paths.length === 0) continue;
    const { manifests, errors } = await loadPluginTemplates(
      installed.id,
      path.dirname(entry.source_path),
      declared.paths,
    );
    for (const e of errors) log(`[templates] plugin '${installed.id}': ${e} — template skipped`);
    if (manifests.length > 0) {
      opts.registrar.registerPluginTemplates(installed.id, manifests);
      log(`[templates] plugin '${installed.id}' contributed ${String(manifests.length)} workflow template(s)`);
    }
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
