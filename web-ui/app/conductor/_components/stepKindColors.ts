/**
 * Step-kind identity colors, shared by the designer canvas (ConductorCanvas)
 * and the read-only template preview (TemplatePreview, #478 F3) so the preview
 * reads as a miniature of the designer without a duplicated palette.
 *
 * Single source of truth: the "Conductor step-kind palette" token block in
 * app/_lib/theme.css — components consume the tokens through this map and
 * never hardcode hex (Lume gate).
 */
export const KIND_COLOR: Record<string, string> = {
  agent: 'var(--step-kind-agent)',
  action: 'var(--step-kind-action)',
  human: 'var(--step-kind-human)',
};

/** Text color on a kind-colored badge fill (dark in both modes by design). */
export const KIND_BADGE_FG = 'var(--step-kind-badge-fg)';
