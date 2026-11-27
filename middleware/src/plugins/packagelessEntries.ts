/**
 * Registry entries without a package.
 *
 * Every runtime activates by walking the PACKAGES it finds (uploaded and
 * built-in) and asking the registry about each. An entry of the installed
 * registry whose package is gone is therefore visited by nobody: it is never
 * activated, never fails, and keeps the status it had, usually `active`, for
 * good. This module makes that state visible. It is DERIVED on every read:
 * nothing is written to the registry and nothing is removed, so an entry
 * whose package comes back (a volume mounted late, a re-upload) is simply
 * ordinary again.
 */

import type { InstalledAgent } from './installedRegistry.js';

/** A place packages live in: the uploaded and the built-in store. */
export interface PackageSource {
  has(id: string): boolean;
}

export interface PackagelessEntry {
  readonly id: string;
  readonly installed_version: string;
  readonly installed_at: string;
  /** What the registry still says, which no longer describes anything. */
  readonly registry_status: InstalledAgent['status'];
}

export function hasPackage(id: string, sources: readonly (PackageSource | undefined)[]): boolean {
  return sources.some((source) => source?.has(id) === true);
}

/** Entries of the registry no package store knows, sorted by id. */
export function listPackagelessEntries(
  registry: { list(): readonly InstalledAgent[] },
  sources: readonly (PackageSource | undefined)[],
): PackagelessEntry[] {
  return registry
    .list()
    .filter((entry) => !hasPackage(entry.id, sources))
    .map((entry) => ({
      id: entry.id,
      installed_version: entry.installed_version,
      installed_at: entry.installed_at,
      registry_status: entry.status,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Packages that left the core image and where they live now (#1942). An
 * instance that used the canvas before v0.201.0 still has these ids in its
 * registry; the warning says where to install them from.
 */
export const RELOCATED_PACKAGES: Readonly<Record<string, string>> = {
  '@omadia/ui-orchestrator': 'byte5ai/omadia-ui-support',
  '@omadia/ui-channel': 'byte5ai/omadia-ui-support',
  '@omadia/canvas-core': 'byte5ai/omadia-ui-support',
};

function relocationHint(entries: readonly PackagelessEntry[]): string {
  const bySource = new Map<string, string[]>();
  for (const entry of entries) {
    const source = RELOCATED_PACKAGES[entry.id];
    if (source) bySource.set(source, [...(bySource.get(source) ?? []), entry.id]);
  }
  return [...bySource]
    .map(([source, ids]) => ` ${ids.join(', ')} ${ids.length === 1 ? 'ships' : 'ship'} outside the core image now: install from ${source}.`)
    .join('');
}

/**
 * One line per boot, naming every entry. Returns what it reported, so the
 * caller can keep it.
 */
export function warnPackagelessEntries(
  registry: { list(): readonly InstalledAgent[] },
  sources: readonly (PackageSource | undefined)[],
  warn: (message: string) => void,
): PackagelessEntry[] {
  const entries = listPackagelessEntries(registry, sources);
  if (entries.length === 0) return entries;
  const named = entries.map((e) => `${e.id}@${e.installed_version} (${e.registry_status})`).join(', ');
  warn(
    `[plugins] ${String(entries.length)} installed ${entries.length === 1 ? 'entry has' : 'entries have'} no package and ${entries.length === 1 ? 'is' : 'are'} not running, whatever the registry says: ${named}. Install the package again, or uninstall the entry. Nothing is removed automatically.${relocationHint(entries)}`,
  );
  return entries;
}
