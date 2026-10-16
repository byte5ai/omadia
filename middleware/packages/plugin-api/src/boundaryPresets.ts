/**
 * The ONE boundary-preset library (#1104).
 *
 * Two surfaces let an operator forbid an agent something: the per-agent
 * "Boundaries" tab (Agent Builder / operator agent editor) and the install-wide
 * defaults of a `responseGuard@1` provider (`@omadia/plugin-quality-guard`).
 * They used to carry two hard-coded libraries — 12 English ids here, 10 German
 * ids in the plugin — that shared only `no-legal-advice` and `no-speculation`,
 * so an id copied from the agent UI into the plugin field was silently dropped.
 *
 * The library lives on the plugin-api surface so the kernel's builder, the
 * provider plugin and (through its pinned mirror in
 * `web-ui/app/_lib/boundaryPresets.ts`) the web UI all read the same ids and the
 * same rule wording. Ported from `byte5ai/kemia` (src/lib/boundary-presets.ts),
 * 12 presets across 4 categories.
 *
 * Adding a preset is additive (minor). Renaming or removing an id is a major:
 * ids are persisted in agent specs and in provider-plugin config strings.
 */

export type BoundaryPresetCategory =
  | 'data'
  | 'scope'
  | 'authority'
  | 'communication';

export interface BoundaryPreset {
  /** Stable key, persisted in agent specs and provider config. */
  readonly id: string;
  /** Category for UI grouping. */
  readonly category: BoundaryPresetCategory;
  /** i18n leaf under the web UI's boundaries namespace. */
  readonly labelKey: string;
  /** Rule wording compiled into the system prompt — curated, not operator-edited. */
  readonly prompt: string;
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
];

/** The preset for `id`, or undefined when `id` is not in the library. */
export function getBoundaryPreset(id: string): BoundaryPreset | undefined {
  return BOUNDARY_PRESETS.find((p) => p.id === id);
}
