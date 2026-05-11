// -----------------------------------------------------------------------------
// B.11-7: Tool-template catalog (curated + personal).
//
// Curated templates are 6 hand-pinned shapes that cover the common
// patterns the Operator hits when authoring REST/GraphQL/KG/memory
// agents. Personal templates live in browser localStorage under
// `byte5.builder.toolTemplates[]` — saving the current tool stamps
// it into that bucket and re-uses it across drafts on the same
// browser. Cross-device sync is B.11+ tech-debt (would require a
// DraftStore-sibling table).
// -----------------------------------------------------------------------------

import type { ToolSpec } from './builderTypes';

export interface ToolTemplate {
  id: string;
  /** Display name in the catalog. */
  label: string;
  /** Catalog-row blurb. */
  blurb: string;
  /** Source: `curated` is read-only; `personal` is user-editable
   *  (saved/deletable from the modal). */
  source: 'curated' | 'personal';
  /** Body of the resulting ToolSpec. The id is treated as a hint;
   *  the modal renames on collision via the same nextToolId logic
   *  ToolList uses for empty-state add. */
  tool: ToolSpec;
}

const CURATED: ReadonlyArray<ToolTemplate> = [
  {
    id: 'curated.rest-get-list',
    label: 'REST GET (list)',
    blurb: 'GET /resource → liste mit limit + cursor.',
    source: 'curated',
    tool: {
      id: 'list_resources',
      description: 'Listet REST-Resources, optional gefiltert.',
      input: {
        type: 'object',
        properties: {
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 100,
            description: 'Max. zurückgegebene Einträge.',
          },
          cursor: {
            type: 'string',
            description: 'Pagination-Cursor aus voriger Antwort.',
          },
          filter: {
            type: 'string',
            description: 'Frei formulierter Such-String.',
          },
        },
        required: [],
      },
    },
  },
  {
    id: 'curated.rest-post-create',
    label: 'REST POST (create)',
    blurb: 'POST /resource mit JSON-Body, idempotency-key.',
    source: 'curated',
    tool: {
      id: 'create_resource',
      description: 'Erstellt eine REST-Resource. Idempotency via key.',
      input: {
        type: 'object',
        properties: {
          payload: {
            type: 'object',
            description: 'JSON-Body — Resource-spezifisch.',
            properties: {},
            required: [],
          },
          idempotency_key: {
            type: 'string',
            description: 'Deduplications-Schlüssel — UUID empfohlen.',
          },
        },
        required: ['payload'],
      },
    },
  },
  {
    id: 'curated.graphql-query',
    label: 'GraphQL Query',
    blurb: 'GraphQL POST {query, variables}.',
    source: 'curated',
    tool: {
      id: 'graphql_query',
      description: 'Führt eine GraphQL-Query aus.',
      input: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'GraphQL-Query-String mit $-Variablen.',
            minLength: 1,
          },
          variables: {
            type: 'object',
            description: 'Variablen-Map (key → JSON-Wert).',
            properties: {},
            required: [],
          },
        },
        required: ['query'],
      },
    },
  },
  {
    id: 'curated.kg-lookup',
    label: 'KG-Lookup (query_knowledge_graph)',
    blurb: 'Wraps query_knowledge_graph mit subject + predicate.',
    source: 'curated',
    tool: {
      id: 'lookup_kg',
      description:
        'Fragt den globalen Knowledge-Graph nach Beziehungen ab.',
      input: {
        type: 'object',
        properties: {
          subject: {
            type: 'string',
            description: 'Entity-Name oder canonical entity://-URI.',
          },
          predicate: {
            type: 'string',
            description: 'Relation-Typ; leer = alle.',
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 50,
          },
        },
        required: ['subject'],
      },
    },
  },
  {
    id: 'curated.memory-read',
    label: 'Memory-Read',
    blurb: 'Liest aus dem Agenten-Memory by key.',
    source: 'curated',
    tool: {
      id: 'memory_read',
      description: 'Liest einen Memory-Eintrag des Agents.',
      input: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: 'Memory-Key (case-sensitive).',
            minLength: 1,
          },
        },
        required: ['key'],
      },
    },
  },
  {
    id: 'curated.memory-write',
    label: 'Memory-Write',
    blurb: 'Schreibt einen Memory-Eintrag (overwrite-safe).',
    source: 'curated',
    tool: {
      id: 'memory_write',
      description: 'Schreibt/überschreibt einen Memory-Eintrag.',
      input: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: 'Memory-Key (case-sensitive).',
            minLength: 1,
          },
          value: {
            type: 'string',
            description: 'Wert als String — JSON-encode bei komplexen Daten.',
          },
          ttl_seconds: {
            type: 'integer',
            minimum: 0,
            description: '0 = permanent.',
          },
        },
        required: ['key', 'value'],
      },
    },
  },
];

const PERSONAL_STORAGE_KEY = 'byte5.builder.toolTemplates';

export function listCuratedTemplates(): ReadonlyArray<ToolTemplate> {
  return CURATED;
}

export function listPersonalTemplates(): ReadonlyArray<ToolTemplate> {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(PERSONAL_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ToolTemplate[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (t) => t.source === 'personal' && typeof t.id === 'string',
    );
  } catch {
    return [];
  }
}

export function savePersonalTemplate(input: {
  label: string;
  tool: ToolSpec;
}): ToolTemplate {
  if (typeof window === 'undefined') {
    throw new Error('savePersonalTemplate: not in a browser');
  }
  const id = `personal.${slugify(input.label)}.${String(Date.now())}`;
  const next: ToolTemplate = {
    id,
    label: input.label,
    blurb: input.tool.description || 'Eigenes Template.',
    source: 'personal',
    tool: input.tool,
  };
  const current = listPersonalTemplates();
  window.localStorage.setItem(
    PERSONAL_STORAGE_KEY,
    JSON.stringify([...current, next]),
  );
  return next;
}

export function deletePersonalTemplate(id: string): void {
  if (typeof window === 'undefined') return;
  const next = listPersonalTemplates().filter((t) => t.id !== id);
  window.localStorage.setItem(PERSONAL_STORAGE_KEY, JSON.stringify(next));
}

function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24)
    || 'template';
}
