/**
 * Presidio entity-type → Privacy-Proxy `pii.*` vocabulary mapping
 * (Slice 3.4).
 *
 * Presidio's recognizer set is broad and English-named. We narrow + rename
 * to the same vocabulary the Ollama NER detector emits, so the receipt
 * UI's `humanLabelForType` table covers both detectors with one entry.
 *
 * Anything Presidio emits that doesn't have an explicit mapping here
 * gets passed through under a `pii.<lower-snake>` synthetic name —
 * better than dropping it silently. The `humanLabelForType` UI fallback
 * shows the raw type for unknowns.
 */

/**
 * Confidence floor below which we drop Presidio hits even if they pass
 * the sidecar's `score_threshold`. The sidecar defaults to 0.4; we
 * keep an additional 0.4 floor here as a safety net, but the source of
 * truth is the operator's `presidio_score_threshold` config.
 */
export const PRESIDIO_DETECTOR_VERSION = '0.1.0';

/**
 * Map a Presidio `entity_type` (and optional language hint, since
 * `PHONE_NUMBER` semantics differ per locale) to our internal pii.*
 * type. Returns `undefined` for entity types we deliberately exclude.
 *
 * Excluded types:
 *   - `DATE_TIME` — Presidio is aggressive on dates, including non-PII
 *     dates like calendar references in the system prompt. We rely on
 *     domain-specific date markers in the user message rather than
 *     Presidio's noisy detection.
 *   - `URL` — also non-PII by default (and likely already in the
 *     system prompt as Tool-Doc links).
 */
export function mapPresidioType(entityType: string, language: string): string | undefined {
  const upper = entityType.toUpperCase();
  switch (upper) {
    // ── Names / Identity ────────────────────────────────────────────
    case 'PERSON':
      return 'pii.name';

    // ── Locations ───────────────────────────────────────────────────
    case 'LOCATION':
    case 'GPE':
      return 'pii.address';

    // ── Organisations ───────────────────────────────────────────────
    case 'ORG':
    case 'ORGANIZATION':
      return 'pii.organization';

    // ── Structured PII (overlap with the Slice-1b regex detector;
    //   span-overlap-dedup keeps the higher-confidence winner) ──────
    case 'EMAIL_ADDRESS':
      return 'pii.email';
    case 'IBAN_CODE':
      return 'pii.iban';
    case 'CREDIT_CARD':
      return 'pii.credit_card';
    case 'PHONE_NUMBER':
      // German/EU tenants typically deal with DE-format numbers; we
      // surface them under the same bucket the Ollama NER uses for
      // domestic-format phones (the regex detector emits `pii.phone`
      // for international `+CC` shape, so the buckets stay distinct).
      return language === 'de' ? 'pii.phone_de' : 'pii.phone';
    case 'IP_ADDRESS':
      return 'pii.ip_address';
    case 'CRYPTO':
      return 'pii.crypto_address';

    // ── Country-specific IDs ────────────────────────────────────────
    case 'US_SSN':
    case 'US_ITIN':
    case 'UK_NHS':
    case 'IT_FISCAL_CODE':
    case 'ES_NIF':
    case 'AU_ABN':
    case 'AU_ACN':
    case 'AU_TFN':
    case 'AU_MEDICARE':
    case 'IN_PAN':
    case 'IN_AADHAAR':
    case 'SG_NRIC_FIN':
    case 'DE_STEUER_ID':
    case 'DE_PERSONALAUSWEIS':
      return 'pii.id_number';

    // ── Driver's licenses / passports ───────────────────────────────
    case 'US_DRIVER_LICENSE':
    case 'US_PASSPORT':
    case 'IT_DRIVER_LICENSE':
    case 'IT_PASSPORT':
    case 'IT_IDENTITY_CARD':
      return 'pii.id_number';

    // ── Banking ─────────────────────────────────────────────────────
    case 'US_BANK_NUMBER':
    case 'IT_VAT_CODE':
    case 'AU_TAX_FILE_NUMBER':
      return 'pii.id_number';

    // ── Medical ─────────────────────────────────────────────────────
    case 'MEDICAL_LICENSE':
      return 'pii.id_number';

    // ── Explicitly excluded (noisy / non-PII) ───────────────────────
    case 'DATE_TIME':
    case 'URL':
    case 'NRP':
      return undefined;

    // ── Unknown but plausibly PII — pass through as a synthetic
    //   pii.<snake>. UI falls back to the raw type label. ──────────
    default:
      return `pii.${upper.toLowerCase()}`;
  }
}

/**
 * Whether a hit at this entity type should be retained at all. Used to
 * filter out the explicit-exclude list before the rest of the pipeline
 * sees it. Equivalent to `mapPresidioType(...) !== undefined` but
 * exposed separately so the detector can also check before allocating
 * objects on the hot path.
 */
export function isPresidioTypeRelevant(entityType: string): boolean {
  const upper = entityType.toUpperCase();
  return upper !== 'DATE_TIME' && upper !== 'URL' && upper !== 'NRP';
}
