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

export type BoundaryCategory = 'data' | 'scope' | 'authority' | 'communication';

export interface BoundaryPreset {
  /** Stable key, stored in the spec */
  id: string;
  /** Category for UI grouping */
  category: BoundaryCategory;
  /** i18n key in the "Boundaries" namespace */
  labelKey: string;
  /** Compiled prompt wording — kemia controls this, not the operator */
  prompt: string;
}

export const BOUNDARY_PRESETS: readonly BoundaryPreset[] = [
  // ── data ────────────────────────────────────────────────────────────────
  {
    id: 'no-financial-data',
    category: 'data',
    labelKey: 'presetNoFinancial',
    prompt:
      'You must NEVER access, process, or provide specific financial data, account balances, or transaction details. If asked, redirect to the appropriate financial department.',
  },
  {
    id: 'no-pii',
    category: 'data',
    labelKey: 'presetNoPii',
    prompt:
      'You must NEVER collect, store, or process personally identifiable information (PII) such as names, addresses, phone numbers, social security numbers, or similar. If a user shares PII unsolicited, do not repeat or store it.',
  },
  {
    id: 'no-medical-data',
    category: 'data',
    labelKey: 'presetNoMedical',
    prompt:
      'You must NEVER provide medical diagnoses, treatment recommendations, or interpret health data. Always redirect medical questions to qualified healthcare professionals.',
  },
  {
    id: 'no-legal-advice',
    category: 'data',
    labelKey: 'presetNoLegal',
    prompt:
      'You must NEVER provide legal advice, interpret laws or contracts, or make recommendations that could be construed as legal counsel. Always recommend consulting a qualified attorney.',
  },
  // ── scope ───────────────────────────────────────────────────────────────
  {
    id: 'own-domain-only',
    category: 'scope',
    labelKey: 'presetOwnDomain',
    prompt:
      'You must strictly stay within your assigned domain and expertise area. If a question falls outside your scope, clearly state that it is outside your area of responsibility and suggest who might help.',
  },
  {
    id: 'no-code-execution',
    category: 'scope',
    labelKey: 'presetNoCode',
    prompt:
      'You must NEVER generate, execute, or assist with writing code, scripts, or technical commands. Redirect technical requests to the development team.',
  },
  {
    id: 'no-external-links',
    category: 'scope',
    labelKey: 'presetNoExternal',
    prompt:
      'You must NEVER provide external URLs, links, or references to third-party websites. Only reference internal documentation and resources.',
  },
  // ── authority ───────────────────────────────────────────────────────────
  {
    id: 'no-discount-authority',
    category: 'authority',
    labelKey: 'presetNoDiscount',
    prompt:
      'You do NOT have authority to offer, promise, or negotiate discounts, refunds, or pricing changes. All pricing decisions must be escalated to authorized personnel.',
  },
  {
    id: 'no-commitments',
    category: 'authority',
    labelKey: 'presetNoCommitments',
    prompt:
      'You must NEVER make binding commitments, promises, or guarantees on behalf of the organization. You may provide information but not enter agreements.',
  },
  {
    id: 'no-personnel-decisions',
    category: 'authority',
    labelKey: 'presetNoPersonnel',
    prompt:
      'You must NEVER make, suggest, or imply decisions about hiring, firing, promotions, or other personnel matters. These are strictly human-authority decisions.',
  },
  // ── communication ───────────────────────────────────────────────────────
  {
    id: 'no-speculation',
    category: 'communication',
    labelKey: 'presetNoSpeculation',
    prompt:
      "You must NEVER speculate or guess when you are uncertain. If you don't have confirmed information, say so explicitly rather than providing potentially incorrect answers.",
  },
  {
    id: 'no-competitor-discussion',
    category: 'communication',
    labelKey: 'presetNoCompetitor',
    prompt:
      'You must NEVER discuss, compare, or comment on competitor products or services. If asked, politely redirect the conversation to your own offerings.',
  },
] as const;

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

export function getBoundaryPreset(id: string): BoundaryPreset | undefined {
  return BOUNDARY_PRESETS.find((p) => p.id === id);
}

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

  for (const custom of customLines) {
    const trimmed = custom.trim();
    if (trimmed.length > 0) {
      lines.push(`You must NOT: ${trimmed}`);
    }
  }

  return { text: lines.join('\n'), droppedIds };
}

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
    text: `## Boundaries\n${text}`,
    droppedIds,
  };
}
