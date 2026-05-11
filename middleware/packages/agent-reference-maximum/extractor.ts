/**
 * OB-29-2 — deterministische Entity-Extraction für den Reference-Plugin.
 * Bewusst KEIN LLM (Etappe 0 ist credential-los); Heuristik:
 *   - "Person:John" / "Person:Anna Müller" → Person-Entity
 *   - "Topic:ThemeF" / "#ThemeG" / "#topic-name" → Topic-Entity
 *
 * Pre-OB-29-3-Caveat: bei Ambiguität (z.B. nur "John" ohne Prefix)
 * macht der Extractor NICHTS. LLM-basierte Extraction kommt in Etappe 3,
 * dort kann der Reference-Tool ctx.llm nutzen, um echtes NER zu machen.
 *
 * Output: deterministisch, idempotent, side-effect-free. Tests sind
 * pure-function-Snapshots.
 */
export interface ExtractedEntity {
  readonly system: 'personal-notes';
  readonly model: 'Person' | 'Topic';
  readonly id: string;
  readonly displayName: string;
}

export interface ExtractedFact {
  /** Free-form fact summary, e.g. "Person:john mentioned in note". */
  readonly summary: string;
  /** External ids of entities this fact mentions. */
  readonly mentionedEntityIds: readonly string[];
}

export interface ExtractionResult {
  readonly entities: readonly ExtractedEntity[];
  readonly facts: readonly ExtractedFact[];
}

// Latin-extended-A/B + Latin-supplement so umlauts (ä/ö/ü/ß/à/é/…) match
// inside identifiers. Bewusst keine Unicode-Property-Escapes (`\p{L}`),
// da node:test/tsx fragmentary die TypeScript-Regex-Strict-Mode aktiviert
// und das in einigen ABI-Versionen wackelt.
const NAME_CHAR = '[A-Za-z\\u00C0-\\u017F\\w-]';
const NAME_START = '[A-Z\\u00C0-\\u017F]';
const PERSON_RE = new RegExp(
  `Person:(${NAME_START}${NAME_CHAR}+(?:\\s${NAME_START}${NAME_CHAR}+)?)`,
  'g',
);
const TOPIC_RE = new RegExp(`Topic:(${NAME_START}${NAME_CHAR}+)`, 'g');
const HASHTAG_RE = /#([A-Za-z][\w-]{1,40})/g;

const SYSTEM = 'personal-notes' as const;

export function extractFromNote(input: {
  body: string;
  noteId: string;
}): ExtractionResult {
  const entityMap = new Map<string, ExtractedEntity>();

  for (const match of input.body.matchAll(PERSON_RE)) {
    const display = match[1]!.trim();
    const id = slugify(display);
    const ext = ent(SYSTEM, 'Person', id, display);
    if (!entityMap.has(ext.extId)) entityMap.set(ext.extId, ext.entity);
  }
  for (const match of input.body.matchAll(TOPIC_RE)) {
    const display = match[1]!.trim();
    const id = slugify(display);
    const ext = ent(SYSTEM, 'Topic', id, display);
    if (!entityMap.has(ext.extId)) entityMap.set(ext.extId, ext.entity);
  }
  for (const match of input.body.matchAll(HASHTAG_RE)) {
    const display = match[1]!;
    const id = slugify(display);
    const ext = ent(SYSTEM, 'Topic', id, display);
    if (!entityMap.has(ext.extId)) entityMap.set(ext.extId, ext.entity);
  }

  const entities = [...entityMap.values()];
  const mentionedEntityIds = [...entityMap.keys()];
  const facts: ExtractedFact[] =
    mentionedEntityIds.length > 0
      ? [
          {
            summary: `note(${input.noteId}) mentions ${mentionedEntityIds.length} entit${mentionedEntityIds.length === 1 ? 'y' : 'ies'}`,
            mentionedEntityIds,
          },
        ]
      : [];

  return { entities, facts };
}

function ent(
  system: 'personal-notes',
  model: 'Person' | 'Topic',
  id: string,
  displayName: string,
): { extId: string; entity: ExtractedEntity } {
  return {
    extId: `${system}:${model}:${id}`,
    entity: { system, model, id, displayName },
  };
}

function slugify(s: string): string {
  // Lowercase + transliterate umlauts (ä→ae, ö→oe, ü→ue, ß→ss) before stripping
  // non-ascii. Ergibt stable, URL-friendly IDs.
  return s
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

// ---------------------------------------------------------------------------
// OB-29-3 — LLM-backed extraction (komplementär zur Regex-Extraction oben).
// ---------------------------------------------------------------------------

/**
 * Schema-friendly shape that the LLM is asked to emit. Loose, weil
 * Anthropic-JSON-Mode v1 keine Schema-Enforcement hat — Plugin-Code
 * validiert defensiv.
 */
interface LlmExtractionPayload {
  entities?: Array<{
    type?: 'Person' | 'Topic' | string;
    name?: string;
  }>;
}

/**
 * LLM-Prompt für Entity-Extraction. Bewusst minimal + JSON-only-Output —
 * wenn der Model trotzdem Prosa drumherum schreibt, parst der Plugin-Code
 * das robust raus (siehe parseLlmExtractionPayload).
 */
const LLM_EXTRACTION_SYSTEM = `Du bist ein NER-Extractor für persönliche Notizen. Liefere AUSSCHLIESSLICH gültiges JSON in diesem Format:

{"entities":[{"type":"Person|Topic","name":"<display name>"}]}

- Nimm nur Personen (Vornamen, voller Name) und Topics (Themen, Projekte).
- Wenn keine Entities erkennbar: {"entities":[]}.
- KEIN Markdown, KEIN Kommentar, NUR das JSON-Objekt.`;

export async function extractWithLlm(deps: {
  body: string;
  llm: {
    complete(req: {
      model: string;
      system?: string;
      messages: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>;
      maxTokens?: number;
    }): Promise<{ text: string }>;
  };
  model?: string;
}): Promise<readonly ExtractedEntity[]> {
  const model = deps.model ?? 'claude-haiku-4-5';
  const result = await deps.llm.complete({
    model,
    system: LLM_EXTRACTION_SYSTEM,
    messages: [{ role: 'user', content: deps.body }],
    maxTokens: 512,
  });
  const payload = parseLlmExtractionPayload(result.text);
  const out: ExtractedEntity[] = [];
  const seen = new Set<string>();
  for (const e of payload.entities ?? []) {
    const display = (e.name ?? '').trim();
    if (display.length === 0) continue;
    const model: 'Person' | 'Topic' =
      e.type === 'Person' ? 'Person' : 'Topic';
    const id = slugify(display);
    if (id.length === 0) continue;
    const extId = `${SYSTEM}:${model}:${id}`;
    if (seen.has(extId)) continue;
    seen.add(extId);
    out.push({ system: SYSTEM, model, id, displayName: display });
  }
  return out;
}

/**
 * Robustes JSON-Parsing für LLM-Outputs, die manchmal Markdown drumherum
 * werfen (```json … ```). Findet das erste { … } mit balanced braces und
 * versucht es zu parsen.
 */
function parseLlmExtractionPayload(raw: string): LlmExtractionPayload {
  const trimmed = raw.trim();
  const direct = tryParse(trimmed);
  if (direct) return direct;
  // Find the first { ... } block.
  const start = trimmed.indexOf('{');
  if (start === -1) return { entities: [] };
  let depth = 0;
  for (let i = start; i < trimmed.length; i++) {
    if (trimmed[i] === '{') depth++;
    else if (trimmed[i] === '}') {
      depth--;
      if (depth === 0) {
        const candidate = trimmed.slice(start, i + 1);
        const parsed = tryParse(candidate);
        if (parsed) return parsed;
        break;
      }
    }
  }
  return { entities: [] };
}

function tryParse(s: string): LlmExtractionPayload | null {
  try {
    const v = JSON.parse(s) as unknown;
    if (typeof v === 'object' && v !== null) {
      return v as LlmExtractionPayload;
    }
    return null;
  } catch {
    return null;
  }
}
