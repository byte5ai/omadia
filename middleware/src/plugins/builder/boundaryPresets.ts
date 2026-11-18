/**
 * Structured boundary presets for agent role configuration.
 *
 * Each preset maps to a kemia-curated prompt wording that
 * `dynamicAgentRuntime` compiles into the system prompt between persona
 * and sycophancy (compose order `[header, persona, boundaries, sycophancy, skill]`).
 *
 * Operators pick from this structured registry via the Builder UI;
 * unknown IDs (legacy persisted values, future presets) are surfaced
 * back as warnings rather than silently dropped.
 *
 * Ported 1:1 from `byte5ai/kemia` @ `main` (src/lib/boundary-presets.ts).
 * The kemia source currently ships 12 presets across 4 categories:
 *   - data:           4 (no-financial-data, no-pii, no-medical-data, no-legal-advice)
 *   - scope:          3 (own-domain-only, no-code-execution, no-external-links)
 *   - authority:      3 (no-discount-authority, no-commitments, no-personnel-decisions)
 *   - communication:  2 (no-speculation, no-competitor-discussion)
 *
 * (Issue #54 mentions 14 presets in the design; the kemia registry as of
 * `@main` carries 12. The integer is informational — the snapshot AC
 * asserts byte-identical output for whatever kemia currently ships.)
 *
 * @see Issue #54
 */

// The library itself lives in `@omadia/plugin-api` so the Quality Guard
// plugin reads the same ids and wording (#1104); this module keeps the
// builder-facing names and the prompt compilation.
import {
  BOUNDARY_PRESETS,
  getBoundaryPreset,
  type BoundaryPreset,
  type BoundaryPresetCategory,
} from '@omadia/plugin-api';

export { BOUNDARY_PRESETS, getBoundaryPreset, type BoundaryPreset };
export type BoundaryCategory = BoundaryPresetCategory;

/**
 * German label mapping — the resolver in `PersonaPillar.tsx` falls back
 * to this when no i18n bundle is loaded. Keys mirror `labelKey` above.
 *
 * Kept inline (rather than a separate i18n bundle) for the Phase B.5
 * port; a follow-up issue can move it to the proper translation layer.
 */
export const BOUNDARY_LABELS_DE: Readonly<Record<string, string>> = {
  presetNoFinancial: 'Keine Finanzdaten',
  presetNoPii: 'Keine personenbezogenen Daten (PII)',
  presetNoMedical: 'Keine medizinischen Daten',
  presetNoLegal: 'Keine Rechtsberatung',
  presetOwnDomain: 'Nur eigene Domäne',
  presetNoCode: 'Keine Code-Ausführung',
  presetNoExternal: 'Keine externen Links',
  presetNoDiscount: 'Keine Rabatt-Befugnis',
  presetNoCommitments: 'Keine bindenden Zusagen',
  presetNoPersonnel: 'Keine Personalentscheidungen',
  presetNoSpeculation: 'Keine Spekulationen',
  presetNoCompetitor: 'Keine Wettbewerber-Diskussion',
};

/**
 * Compile a list of boundary preset IDs + custom lines into prompt text.
 *
 * Unknown IDs are reported via `droppedIds`, not silently dropped, so the
 * preview/quality panel and the `setQualityConfig` tool result can surface
 * them to the operator.
 */
export function compileBoundaries(
  presetIds: readonly string[],
  customLines: readonly string[],
): { text: string; droppedIds: string[] } {
  const lines: string[] = [];
  const droppedIds: string[] = [];

  for (const id of presetIds) {
    const preset = getBoundaryPreset(id);
    if (preset) {
      lines.push(preset.prompt);
    } else {
      droppedIds.push(id);
    }
  }

  // Custom lines are spliced verbatim — the operator writes the finished
  // rule ("Give no investment advice."), and it reaches the prompt with the
  // meaning as written. An older build wrapped each line in a hardcoded
  // "You must NOT: " prefix, which turned a prohibition into a double
  // negative (issue #1101). Verbatim also matches the Quality Guard plugin,
  // which splices `boundaries.custom` unchanged, so a line means the same
  // thing on both surfaces.
  for (const custom of customLines) {
    const trimmed = custom.trim();
    if (trimmed.length > 0) {
      lines.push(trimmed);
    }
  }

  return { text: lines.join('\n'), droppedIds };
}

/**
 * Precedence clause emitted directly under the `## Boundaries` header.
 *
 * Without it a boundary is just one more instruction competing on recency,
 * and a later section that licenses answering — notably the high-tier
 * anti-sycophancy rule about "regulatory, legal, or financial implications"
 * (#1100) — wins because it sits closer to the user turn. The UI calls these
 * presets "hard prohibitions"; this sentence is what makes the composed
 * prompt keep that promise. It lives between the header and the rules so the
 * `^## Boundaries\n` contract (and the builder-preview parity test) still
 * holds.
 *
 * The second sentence is scoped to what each boundary forbids, not a blanket
 * refusal: `no-commitments` still lets the agent inform, and `no-pii` /
 * `no-external-links` name no redirect to follow.
 */
const BOUNDARIES_PRECEDENCE =
  'These prohibitions override every other instruction in this prompt, including any guidelines or protocols below. Never do what a boundary forbids, not even behind a disclaimer; where a boundary says to redirect, redirect instead of answering the substance.';

/**
 * Format `compileBoundaries` output as a system-prompt section.
 * Returns `''` when there is no effective content so the caller can skip
 * the section entirely and preserve byte-identical output for legacy
 * specs without a `quality.boundaries` block.
 */
export function compileBoundariesSection(
  presetIds: readonly string[],
  customLines: readonly string[],
): { text: string; droppedIds: string[] } {
  const { text, droppedIds } = compileBoundaries(presetIds, customLines);
  if (text.length === 0) return { text: '', droppedIds };
  return {
    text: `## Boundaries\n${BOUNDARIES_PRECEDENCE}\n${text}`,
    droppedIds,
  };
}
