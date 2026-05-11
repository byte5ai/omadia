// -----------------------------------------------------------------------------
// B.11-4: Frontend wrapper for the GET /api/v1/builder/entity-vocabulary
// endpoint. Caches in-process; the description-fields in the
// ToolInputSchemaBuilder use the cached entries for substring autocomplete.
// -----------------------------------------------------------------------------

import { ApiError } from './api';

export interface VocabularyEntry {
  name: string;
  version: string;
  $id: string;
  summary?: string;
}

let cache: ReadonlyArray<VocabularyEntry> | null = null;
let inflight: Promise<ReadonlyArray<VocabularyEntry>> | null = null;

export async function fetchEntityVocabulary(): Promise<
  ReadonlyArray<VocabularyEntry>
> {
  if (cache !== null) return cache;
  if (inflight !== null) return inflight;
  inflight = (async () => {
    const res = await fetch('/bot-api/v1/builder/entity-vocabulary', {
      method: 'GET',
      headers: { accept: 'application/json' },
      credentials: 'include',
      cache: 'no-store',
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ApiError(
        res.status,
        `GET builder/entity-vocabulary failed: ${res.status}`,
        text,
      );
    }
    const body = (await res.json()) as { entities: VocabularyEntry[] };
    cache = body.entities;
    inflight = null;
    return cache;
  })();
  return inflight;
}

/** Substring (case-insensitive) match on name. Empty/short query returns []. */
export function matchVocabulary(
  query: string,
  vocab: ReadonlyArray<VocabularyEntry>,
  limit = 5,
): ReadonlyArray<VocabularyEntry> {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const out: VocabularyEntry[] = [];
  for (const e of vocab) {
    if (e.name.toLowerCase().includes(q)) {
      out.push(e);
      if (out.length >= limit) break;
    }
  }
  return out;
}
