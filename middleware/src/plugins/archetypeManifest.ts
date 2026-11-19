// The `archetype:` block of a manifest of kind `archetype` (#2088, spec 2042
// §5.10): the descriptor of the archetype the plugin delivers.
//
// The kernel ENFORCES the descriptor, so it reads it strictly. An omission,
// addition or requirement it does not know is not skipped: it cannot enforce
// what it does not know, and a descriptor that is silently narrower than the
// plugin wrote would let agents of the archetype have what their archetype
// says they never get. Such a manifest is rejected.

import {
  ARCHETYPE_ADDITIONS,
  ARCHETYPE_OMISSIONS,
  ARCHETYPE_REQUIREMENTS,
  STANDARD_ARCHETYPE,
  isArchetypeId,
  type ArchetypeAddition,
  type ArchetypeDescriptor,
  type ArchetypeOmission,
  type ArchetypeRequirement,
  type ArchetypeText,
} from '@omadia/orchestrator';

/** The descriptor as a manifest states it; the kernel adds `source`. */
export type ArchetypeManifestDescriptor = Omit<ArchetypeDescriptor, 'source'>;

const MAX_LABEL = 120;
const MAX_NOUN = 80;
const MAX_TEXT = 2_000;
const MAX_ROLE_CONTRACT = 8_000;

const isObject = (raw: unknown): raw is Record<string, unknown> =>
  raw !== null && typeof raw === 'object' && !Array.isArray(raw);
const isText = (raw: unknown, max: number): raw is string =>
  typeof raw === 'string' && raw.trim().length > 0 && raw.length <= max;

function readText(raw: unknown, max: number): ArchetypeText | undefined | 'invalid' {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'string') return isText(raw, max) ? raw.trim() : 'invalid';
  if (!isObject(raw)) return 'invalid';
  const out: { en?: string; de?: string } = {};
  for (const locale of ['en', 'de'] as const) {
    const value = raw[locale];
    if (value === undefined) continue;
    if (!isText(value, max)) return 'invalid';
    out[locale] = value.trim();
  }
  return out.en !== undefined || out.de !== undefined ? out : 'invalid';
}

function readList<T extends string>(
  raw: unknown,
  vocabulary: readonly T[],
  field: string,
  required: boolean,
): { value: T[] } | { error: string } {
  if (raw === undefined || raw === null) {
    return required ? { error: `archetype.${field} is required (a list; it may be empty)` } : { value: [] };
  }
  if (!Array.isArray(raw)) return { error: `archetype.${field} must be a list` };
  const unknown = raw.filter((entry) => typeof entry !== 'string' || !vocabulary.includes(entry as T));
  if (unknown.length > 0) {
    return {
      error: `archetype.${field} names ${unknown.map((u) => JSON.stringify(u)).join(', ')}, which this kernel cannot enforce (it knows: ${vocabulary.join(', ')})`,
    };
  }
  return { value: [...new Set(raw as T[])] };
}

/**
 * Read the `archetype:` block. `error` says why the manifest is rejected.
 */
export function readArchetypeManifest(
  raw: unknown,
): { descriptor: ArchetypeManifestDescriptor } | { error: string } {
  if (!isObject(raw)) return { error: "a plugin of kind 'archetype' needs an `archetype:` block" };
  const id = raw['id'];
  if (!isArchetypeId(id)) {
    return { error: 'archetype.id must be 1..63 characters: a lowercase letter, then lowercase letters, digits, hyphens' };
  }
  if (id === STANDARD_ARCHETYPE) return { error: "archetype.id 'standard' is the built-in archetype and cannot be delivered by a plugin" };

  const omits = readList<ArchetypeOmission>(raw['omits'], ARCHETYPE_OMISSIONS, 'omits', true);
  if ('error' in omits) return omits;
  const adds = readList<ArchetypeAddition>(raw['adds'], ARCHETYPE_ADDITIONS, 'adds', false);
  if ('error' in adds) return adds;
  const requires = readList<ArchetypeRequirement>(raw['requires'], ARCHETYPE_REQUIREMENTS, 'requires', false);
  if ('error' in requires) return requires;

  const noun = raw['noun'];
  if (noun !== undefined && !isText(noun, MAX_NOUN)) return { error: `archetype.noun must be 1..${String(MAX_NOUN)} characters` };

  const texts: { label?: ArchetypeText; labelPlural?: ArchetypeText; description?: ArchetypeText } = {};
  for (const [field, key, max] of [
    ['label', 'label', MAX_LABEL],
    ['label_plural', 'labelPlural', MAX_LABEL],
    ['description', 'description', MAX_TEXT],
  ] as const) {
    const text = readText(raw[field], max);
    if (text === 'invalid') return { error: `archetype.${field} must be a text or an { en, de } map of texts up to ${String(max)} characters` };
    if (text !== undefined) texts[key] = text;
  }

  let omissionReasons: Partial<Record<ArchetypeOmission, string>> | undefined;
  const rawReasons = raw['omission_reasons'];
  if (rawReasons !== undefined && rawReasons !== null) {
    if (!isObject(rawReasons)) return { error: 'archetype.omission_reasons must be a map of omission to text' };
    omissionReasons = {};
    for (const [omission, reason] of Object.entries(rawReasons)) {
      if (!omits.value.includes(omission as ArchetypeOmission)) {
        return { error: `archetype.omission_reasons names '${omission}', which is not in archetype.omits` };
      }
      if (!isText(reason, MAX_TEXT)) return { error: `archetype.omission_reasons.${omission} must be a text` };
      omissionReasons[omission as ArchetypeOmission] = reason.trim();
    }
  }

  const roleContract = raw['role_contract'];
  if (roleContract !== undefined && roleContract !== null && !isText(roleContract, MAX_ROLE_CONTRACT)) {
    return { error: `archetype.role_contract must be a text of up to ${String(MAX_ROLE_CONTRACT)} characters` };
  }

  return {
    descriptor: {
      id,
      omits: omits.value,
      adds: adds.value,
      requires: requires.value,
      noun: typeof noun === 'string' ? noun.trim() : `an agent of the archetype '${id}'`,
      ...texts,
      ...(omissionReasons && Object.keys(omissionReasons).length > 0 ? { omissionReasons } : {}),
      ...(typeof roleContract === 'string' ? { roleContract: roleContract.trim() } : {}),
    },
  };
}
