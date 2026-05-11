/**
 * NER prompt for the Ollama detector (Slice 3.2).
 *
 * Strategy: keep the prompt deterministic and JSON-only. Few-shot covers
 * three shapes the model must handle without drifting:
 *   1. Plain question with a German full name (John-Doe smoke).
 *   2. A markdown-table-style payload (the long-text shape that triggered
 *      the 2.1.1 phone-regex false-positive storm).
 *   3. A PII-free message — must yield `{"hits": []}`, not silent text.
 *
 * Type vocabulary is small on purpose: Slice 3.2 ships the six labels the
 * receipt UI's `humanLabelForType` knows about. Adding more types means
 * adding the label, the prompt entry, and a fixture; we'd rather grow
 * deliberately than have the model invent labels.
 *
 * The prompt is in German since byte5's primary tenants are DE-speakers
 * and the few-shot examples are German. Mixing languages in the prompt
 * tends to confuse small models (3-8b range) more than picking one.
 */

import { z } from 'zod';

/** Accepted detection types. Free-form `string` on the wire (the
 *  `PrivacyDetector` contract is type-agnostic), but enforced here so
 *  Slice-3.2 hits stay aligned with the receipt UI's known label list. */
export const NER_TYPE_VOCABULARY = [
  'pii.name',
  'pii.address',
  'pii.phone_de',
  'pii.id_number',
  'business.contract_clause',
  'business.financial_data',
] as const;

export type NerType = (typeof NER_TYPE_VOCABULARY)[number];

/**
 * Zod schema for the model's JSON response. Strict: extra fields on a hit
 * are dropped; an unknown `type` value triggers a parse error which we
 * downgrade to "zero hits" at the detector boundary (Slice 3.1's fail-
 * open contract — never propagate the error up).
 */
export const NerHitSchema = z.object({
  type: z.enum(NER_TYPE_VOCABULARY),
  value: z.string().min(1),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  confidence: z.number().min(0).max(1),
});

export const NerResponseSchema = z.object({
  hits: z.array(NerHitSchema),
});

export type NerHit = z.infer<typeof NerHitSchema>;
export type NerResponse = z.infer<typeof NerResponseSchema>;

export const NER_SYSTEM_PROMPT = `Du bist ein NER-Klassifikator (Named-Entity-Recognition) für einen Datenschutz-Proxy.

Deine Aufgabe: identifiziere im Eingabetext sensible Inhalte aus genau diesem Vokabular und gib NUR JSON zurück.

Type-Vokabular:
  - pii.name                    Personen-Eigennamen (Vor- und/oder Nachname).
  - pii.address                 Vollständige Postadressen (Straße + Hausnr + PLZ/Ort).
  - pii.phone_de                Deutsche Telefonnummern, auch ohne +49 (z.B. 030 12345678, 0151-12345678).
  - pii.id_number               Ausweis-, Steuer-, Mitarbeiter- oder Kunden-IDs.
  - business.contract_clause    Vertragsklauseln, Verschwiegenheits-/Geheimhaltungspassagen.
  - business.financial_data     Beträge, Gehälter, Umsätze, EBIT-Zahlen, Konditionen.

Antwortformat — STRIKT:
  {"hits": [{"type": <type>, "value": <substring>, "start": <utf16-offset>, "end": <utf16-offset-exklusiv>, "confidence": <0..1>}]}

Regeln:
  1. KEIN Markdown, KEIN Erklärungstext, KEIN Wrap mit \`\`\`json — nur JSON.
  2. \`value\` MUSS ein 1:1 Substring des Eingabetexts sein, byte-identisch.
  3. \`start\` und \`end\` sind 0-indexierte UTF-16-Offsets; \`end\` ist exklusiv.
  4. \`confidence\` ist ein Float in [0, 1].
  5. Bei null Treffern → {"hits": []}.
  6. Verwende ausschliesslich das Type-Vokabular oben — keine eigenen Typen.
  7. Keine Strukturen ausserhalb des \`hits\`-Arrays.
  8. E-Mail-Adressen, IBANs, Kreditkarten und API-Keys sind NICHT deine Aufgabe (übernimmt der Regex-Detector).`;

/** Few-shot examples in `messages` form — used as alternating user/assistant
 *  pairs in the chat completion request. Each `assistant` content is a
 *  JSON-string the schema validator accepts, so the example output is a
 *  contract the model should mimic verbatim. */
export const NER_FEW_SHOT: ReadonlyArray<{ user: string; assistant: string }> = [
  {
    user: 'Wann hat John Doe Urlaub beantragt?',
    assistant: '{"hits":[{"type":"pii.name","value":"John Doe","start":10,"end":21,"confidence":0.96}]}',
  },
  {
    user:
      'Mitarbeiter-Liste:\n' +
      'Name | Telefon | Gehalt\n' +
      'Anna Schmidt | 030 12345678 | 5500 EUR\n' +
      'Bernd Klein  | 0151-998877 | 4800 EUR',
    assistant:
      '{"hits":[' +
      '{"type":"pii.name","value":"Anna Schmidt","start":36,"end":48,"confidence":0.95},' +
      '{"type":"pii.phone_de","value":"030 12345678","start":51,"end":63,"confidence":0.93},' +
      '{"type":"business.financial_data","value":"5500 EUR","start":66,"end":74,"confidence":0.9},' +
      '{"type":"pii.name","value":"Bernd Klein","start":75,"end":86,"confidence":0.95},' +
      '{"type":"pii.phone_de","value":"0151-998877","start":89,"end":100,"confidence":0.93},' +
      '{"type":"business.financial_data","value":"4800 EUR","start":103,"end":111,"confidence":0.9}' +
      ']}',
  },
  {
    user: 'Wie ist das Wetter heute in Berlin?',
    assistant: '{"hits":[]}',
  },
];

/**
 * Build the messages array for an Ollama `/api/chat` call. System prompt
 * first, then few-shot user/assistant pairs, then the live user input.
 * Keeping few-shot in messages-form (rather than baked into the system
 * prompt) lets a 3b model lean on the conversational pattern, which
 * empirically improves JSON adherence on small models.
 */
export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export function buildNerMessages(text: string): readonly ChatMessage[] {
  const out: ChatMessage[] = [{ role: 'system', content: NER_SYSTEM_PROMPT }];
  for (const ex of NER_FEW_SHOT) {
    out.push({ role: 'user', content: ex.user });
    out.push({ role: 'assistant', content: ex.assistant });
  }
  out.push({ role: 'user', content: text });
  return out;
}

/**
 * Parse the model's raw response string. Returns the validated
 * `NerResponse` on success, `undefined` on any failure. Caller logs +
 * fail-opens — the detector contract treats invalid output as "zero hits".
 *
 * Robustness: tries straight JSON.parse first, then a permissive
 * substring extraction (everything from the first `{` to the matching
 * last `}`) since small models occasionally leak a single trailing
 * sentence after the JSON. We do NOT attempt regex-based extraction of
 * arbitrary embedded JSON — too easy to misparse.
 */
export function parseNerResponse(raw: string): NerResponse | undefined {
  if (raw.length === 0) return undefined;
  const candidate = extractJsonObject(raw);
  if (candidate === undefined) return undefined;

  let value: unknown;
  try {
    value = JSON.parse(candidate);
  } catch {
    return undefined;
  }
  const result = NerResponseSchema.safeParse(value);
  if (!result.success) return undefined;
  return result.data;
}

function extractJsonObject(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
  // Scan for the outermost balanced `{...}` block. Bail on the first
  // mismatch — better to drop the whole response than guess at slicing.
  const first = trimmed.indexOf('{');
  if (first < 0) return undefined;
  let depth = 0;
  for (let i = first; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return trimmed.slice(first, i + 1);
    }
  }
  return undefined;
}
