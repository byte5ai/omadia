// #2088 — when replacing an INSTALLED plugin's version needs the operator's
// explicit confirmation.
//
// Installing an archetype plugin is confirmed at the install job. An update
// swaps the running instance without one, so the same decisions could arrive
// unseen with a new version:
//
//   becomes_archetype    the plugin was an ordinary plugin and now delivers
//                        an agent archetype;
//   descriptor_changed   what agents of its archetype may do and never get
//                        differs from the installed version;
//   moves_database       the new version keeps its tables in its own schema
//                        (it no longer asks for the shared pool): the tables
//                        are moved once and the installed version cannot
//                        read them afterwards;
//   becomes_system_module  (spec 2042 §5.10) the plugin was a capability,
//                        channel or model and now is infrastructure of omadia
//                        itself, which a fresh install confirms too. The
//                        retired `extension` already is a system module, so
//                        its move to `system-module` needs none.
//
// A plain version bump of an archetype plugin needs no confirmation.

import { effectiveKind, type Plugin, type PluginArchetype } from '../api/admin-v1.js';
import { ownsItsDatabase } from '../platform/archetypeDatabase.js';

export type ArchetypeUpdateReason =
  | 'becomes_archetype'
  | 'descriptor_changed'
  | 'moves_database'
  | 'becomes_system_module';

type Described = Pick<Plugin, 'kind' | 'archetype'> & {
  readonly requires?: readonly string[];
  readonly optional_requires?: readonly string[];
};

const sorted = (values: readonly string[] | undefined): string[] => [...(values ?? [])].sort();

/** What the kernel enforces of a descriptor: its id and the three lists.
 *  Labels and texts may change without a confirmation. */
function enforcedPart(archetype: PluginArchetype | undefined): string {
  return JSON.stringify({
    id: archetype?.id ?? null,
    omits: sorted(archetype?.omits),
    adds: sorted(archetype?.adds),
    requires: sorted(archetype?.requires),
  });
}

export function archetypeUpdateReasons(installed: Described, next: Described): ArchetypeUpdateReason[] {
  if (effectiveKind(next.kind) === 'system-module') {
    return effectiveKind(installed.kind) === 'system-module' ? [] : ['becomes_system_module'];
  }
  if (next.kind !== 'archetype') return [];
  const reasons: ArchetypeUpdateReason[] = [];
  if (installed.kind !== 'archetype') reasons.push('becomes_archetype');
  else if (enforcedPart(installed.archetype) !== enforcedPart(next.archetype)) reasons.push('descriptor_changed');
  if (ownsItsDatabase(next) && !ownsItsDatabase(installed)) reasons.push('moves_database');
  return reasons;
}
