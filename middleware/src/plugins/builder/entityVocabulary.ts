import { promises as fs } from 'node:fs';

import yaml from 'yaml';

import { ASSETS } from '../../platform/assets.js';

/**
 * B.11-4: Loads the on-disk entity registry and surfaces a small
 * JSON-friendly catalog the Workspace consumes for description-field
 * autocomplete (capability vocabulary).
 *
 * The full registry is too rich for casual UI consumption (every
 * entity carries inline JSON-Schema, change-history, evolution rules,
 * …). We project to {name, version, $id, summary} which is what the
 * autocomplete needs.
 */

export interface VocabularyEntry {
  name: string;
  version: string;
  $id: string;
  summary?: string;
}

let cached: ReadonlyArray<VocabularyEntry> | null = null;

interface RawEntity {
  $id?: unknown;
  version?: unknown;
  description?: unknown;
  summary?: unknown;
}

export async function loadEntityVocabulary(): Promise<
  ReadonlyArray<VocabularyEntry>
> {
  if (cached !== null) return cached;
  const yamlText = await fs.readFile(ASSETS.entityRegistry.root, 'utf8');
  const parsed = yaml.parse(yamlText) as
    | { entities?: Record<string, RawEntity> }
    | undefined;
  const entities = parsed?.entities ?? {};
  const entries: VocabularyEntry[] = [];
  for (const [name, raw] of Object.entries(entities)) {
    if (!raw || typeof raw !== 'object') continue;
    const id = typeof raw.$id === 'string' ? raw.$id : undefined;
    if (!id) continue;
    const version = typeof raw.version === 'string' ? raw.version : '0.0.0';
    const summary =
      typeof raw.description === 'string'
        ? raw.description
        : typeof raw.summary === 'string'
          ? raw.summary
          : undefined;
    entries.push({ name, version, $id: id, summary });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  cached = entries;
  return entries;
}

/** For tests — clears the in-memory cache so the next load re-reads. */
export function _resetEntityVocabularyCache(): void {
  cached = null;
}
