/**
 * #2088 — agent archetypes as the operator UI knows them.
 *
 * An archetype is the job profile of an agent, fixed at creation. `standard`
 * is built in; further ones are delivered by archetype plugins, whose
 * descriptor says what agents of the archetype never get (`omits`), what the
 * archetype adds (`adds`) and what such an agent needs (`requires`). The
 * kernel enforces the descriptor; this module only shows it.
 */

/** A text of a descriptor: as written, or per language. */
export type ArchetypeText = string | { en?: string; de?: string };

/** The descriptor as a plugin's manifest states it (`Plugin.archetype`). */
export interface PluginArchetype {
  id: string;
  omits: string[];
  adds: string[];
  requires: string[];
  noun?: string;
  label?: ArchetypeText;
  labelPlural?: ArchetypeText;
  description?: ArchetypeText;
}

/** One row of `GET /v1/operator/archetypes`. */
export interface OperatorArchetypeDto {
  id: string;
  source: string;
  built_in: boolean;
  label: ArchetypeText | null;
  label_plural: ArchetypeText | null;
  description: ArchetypeText | null;
  omits: string[];
  adds: string[];
  requires: string[];
  plugin: { id: string; status: string } | null;
  agent_count: number | null;
}

/** The codes this build has a sentence for; anything else is shown as its code. */
export const KNOWN_ARCHETYPE_OMISSIONS = [
  'plugin_grant',
  'tool_grant',
  'memory',
  'default_agent',
  'channel_binding',
  'persona_skill',
  'fast_path',
  'agent_to_agent',
  'consultation',
  'sub_agent',
  'assistance',
] as const;
export const KNOWN_ARCHETYPE_ADDITIONS = [
  'conversation_messages',
  'agent_turn',
  'own_identity_send',
  'session_capabilities',
] as const;
export const KNOWN_ARCHETYPE_REQUIREMENTS = ['own_channel_identity'] as const;

export function isKnownCode(known: readonly string[], code: string): boolean {
  return known.includes(code);
}

/** The text in the operator's language, else the other one, else `undefined`. */
export function archetypeText(text: ArchetypeText | null | undefined, locale: string): string | undefined {
  if (text === null || text === undefined) return undefined;
  if (typeof text === 'string') return text.trim() || undefined;
  const primary = locale.toLowerCase().startsWith('de') ? text.de : text.en;
  return (primary ?? text.en ?? text.de)?.trim() || undefined;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function parseText(value: unknown): ArchetypeText | null {
  if (typeof value === 'string') return value;
  if (value === null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const out: { en?: string; de?: string } = {};
  if (typeof record['en'] === 'string') out.en = record['en'];
  if (typeof record['de'] === 'string') out.de = record['de'];
  return out.en !== undefined || out.de !== undefined ? out : null;
}

/** A descriptor out of an untyped payload (an install refusal's `details`). */
export function parsePluginArchetype(value: unknown): PluginArchetype | null {
  if (value === null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record['id'] !== 'string') return null;
  const label = parseText(record['label']);
  const labelPlural = parseText(record['labelPlural']);
  const description = parseText(record['description']);
  return {
    id: record['id'],
    omits: isStringArray(record['omits']) ? record['omits'] : [],
    adds: isStringArray(record['adds']) ? record['adds'] : [],
    requires: isStringArray(record['requires']) ? record['requires'] : [],
    ...(typeof record['noun'] === 'string' ? { noun: record['noun'] } : {}),
    ...(label !== null ? { label } : {}),
    ...(labelPlural !== null ? { labelPlural } : {}),
    ...(description !== null ? { description } : {}),
  };
}

export function parseOperatorArchetypes(value: unknown): OperatorArchetypeDto[] {
  const list = (value as { archetypes?: unknown } | null)?.archetypes;
  if (!Array.isArray(list)) return [];
  const out: OperatorArchetypeDto[] = [];
  for (const raw of list as unknown[]) {
    if (raw === null || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (typeof r['id'] !== 'string') continue;
    const plugin = r['plugin'] as { id?: unknown; status?: unknown } | null | undefined;
    out.push({
      id: r['id'],
      source: typeof r['source'] === 'string' ? r['source'] : 'kernel',
      built_in: r['built_in'] === true,
      label: parseText(r['label']),
      label_plural: parseText(r['label_plural']),
      description: parseText(r['description']),
      omits: isStringArray(r['omits']) ? r['omits'] : [],
      adds: isStringArray(r['adds']) ? r['adds'] : [],
      requires: isStringArray(r['requires']) ? r['requires'] : [],
      plugin:
        plugin && typeof plugin.id === 'string'
          ? { id: plugin.id, status: typeof plugin.status === 'string' ? plugin.status : 'unknown' }
          : null,
      agent_count: typeof r['agent_count'] === 'number' ? r['agent_count'] : null,
    });
  }
  return out;
}
