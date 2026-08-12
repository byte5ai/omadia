/**
 * Static provenance marking embedded in every Office file omadia generates
 * (#645, part of the AI-Act Art. 50 epic #642).
 *
 * `.docx` and `.xlsx` are the only omadia artifacts with a real, standardized
 * metadata slot (OOXML core + custom properties), so this is where a
 * machine-readable "AI-generated" marker belongs — read by Word, LibreOffice
 * and any OOXML parser without inventing a format.
 *
 * Invariant — everything here MUST stay constant. Both office pipelines are
 * content-addressed: `officeService` keys the storage object on the sha256 of
 * the file bytes and skips the write on a cache hit. A timestamp, turn-id or
 * model-id in the properties would make every file unique and defeat that
 * dedup. Turn-scoped provenance therefore lives in the API envelope and the
 * audit trail (#647), never in the file. Adding a per-render value below is a
 * correctness bug, not a tweak.
 */

/** Generator name, also written as the OOXML `creator`. */
export const PROVENANCE_GENERATOR = 'Omadia';

/** The regulation this marking implements — kept human-readable on purpose. */
export const PROVENANCE_STANDARD = 'EU AI Act Art. 50';

/**
 * Core-property `description` (docx `dc:description`, xlsx `description`).
 * Bilingual so the marker is legible to a German operator and an English
 * OOXML tool alike.
 */
export const PROVENANCE_DESCRIPTION =
  'KI-generiert von Omadia (AI-generated). Maschinenlesbare Provenance-Kennzeichnung gemäß EU AI Act Art. 50.';

/** Core-property `keywords`, comma-separated (docx `cp:keywords`). */
export const PROVENANCE_KEYWORDS = 'AI-generated, KI-generiert, Omadia, provenance';

/**
 * Core-property `category`. exceljs exposes no reliable custom-property API, so
 * `.xlsx` gets this coarser core-property marker in place of the structured
 * custom properties `.docx` carries — a deliberate, documented limitation (see
 * the package README).
 */
export const PROVENANCE_CATEGORY = 'AI-generated';

/** Custom-property names (docx `docProps/custom.xml`). */
export const PROVENANCE_PROP_AI_GENERATED = 'AIGenerated';
export const PROVENANCE_PROP_GENERATOR = 'Generator';
export const PROVENANCE_PROP_STANDARD = 'ProvenanceStandard';

/**
 * Structured custom properties written into `.docx`. Machine-readable flag +
 * generator + the standard, so a parser can branch on `AIGenerated === "true"`
 * without string-matching the free-text description.
 */
export const PROVENANCE_CUSTOM_PROPERTIES: readonly { readonly name: string; readonly value: string }[] =
  [
    { name: PROVENANCE_PROP_AI_GENERATED, value: 'true' },
    { name: PROVENANCE_PROP_GENERATOR, value: PROVENANCE_GENERATOR },
    { name: PROVENANCE_PROP_STANDARD, value: PROVENANCE_STANDARD },
  ];
