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
  ARCHETYPE_AGENT_SETTING_TYPES,
  ARCHETYPE_OMISSIONS,
  ARCHETYPE_REQUIREMENTS,
  STANDARD_ARCHETYPE,
  isArchetypeId,
  type ArchetypeAddition,
  type ArchetypeAgentSetting,
  type ArchetypeAgentSettingOption,
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

const MAX_SETTINGS = 20;
const MAX_OPTIONS = 20;
const MAX_LIST_ITEMS = 20;
const SETTING_KEY_RE = /^[a-z][a-z0-9_]{0,62}$/;

/**
 * #2066 — `archetype.agent_settings`: fields the operator sets per agent of
 * the archetype. Read as strictly as the rest of the block: a type the kernel
 * cannot validate rejects the manifest.
 */
function readAgentSettings(raw: unknown): { value: ArchetypeAgentSetting[] } | { error: string } {
  if (raw === undefined || raw === null) return { value: [] };
  if (!Array.isArray(raw) || raw.length > MAX_SETTINGS) {
    return { error: `archetype.agent_settings must be a list of up to ${String(MAX_SETTINGS)} fields` };
  }
  const out: ArchetypeAgentSetting[] = [];
  const keys = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    const at = `archetype.agent_settings[${String(index)}]`;
    if (!isObject(entry)) return { error: `${at} must be a map` };
    const key = entry['key'];
    if (typeof key !== 'string' || !SETTING_KEY_RE.test(key)) {
      return { error: `${at}.key must be lowercase letters, digits and underscores` };
    }
    if (keys.has(key)) return { error: `${at}.key '${key}' is declared twice` };
    keys.add(key);
    const label = readText(entry['label'], MAX_LABEL);
    if (label === undefined || label === 'invalid') return { error: `${at}.label must be a text or an { en, de } map` };
    const help = readText(entry['help'], MAX_TEXT);
    if (help === 'invalid') return { error: `${at}.help must be a text or an { en, de } map` };
    const base = { key, label, ...(help !== undefined ? { help } : {}) };
    const type = entry['type'];
    if (type === 'enum') {
      const rawOptions = entry['options'];
      if (!Array.isArray(rawOptions) || rawOptions.length === 0 || rawOptions.length > MAX_OPTIONS) {
        return { error: `${at}.options must be a list of 1..${String(MAX_OPTIONS)} options` };
      }
      const options: ArchetypeAgentSettingOption[] = [];
      for (const option of rawOptions) {
        const value = isObject(option) ? option['value'] : undefined;
        const optionLabel = isObject(option) ? readText(option['label'], MAX_LABEL) : 'invalid';
        if (!isText(value, MAX_LABEL) || optionLabel === undefined || optionLabel === 'invalid') {
          return { error: `${at}.options: every option needs a value and a label` };
        }
        options.push({ value, label: optionLabel });
      }
      out.push({ ...base, type, options });
      continue;
    }
    if (type === 'number_list') {
      const maxItems = entry['max_items'] ?? 10;
      if (typeof maxItems !== 'number' || !Number.isInteger(maxItems) || maxItems < 1 || maxItems > MAX_LIST_ITEMS) {
        return { error: `${at}.max_items must be a whole number from 1 to ${String(MAX_LIST_ITEMS)}` };
      }
      out.push({ ...base, type, maxItems });
      continue;
    }
    return {
      error: `${at}.type ${JSON.stringify(type)} is not a setting type this kernel can validate (it knows: ${ARCHETYPE_AGENT_SETTING_TYPES.join(', ')})`,
    };
  }
  return { value: out };
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

  const agentSettings = readAgentSettings(raw['agent_settings']);
  if ('error' in agentSettings) return agentSettings;

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
      ...(agentSettings.value.length > 0 ? { agentSettings: agentSettings.value } : {}),
    },
  };
}
