/**
 * omadia operator UI — Design Tokens (TypeScript mirror of the Lume tokens)
 * ---------------------------------------------------------------------------
 * The authoritative source is `theme.css` (Lume, omadia visual spec v0.4).
 * This mirror exists for the few cases where CSS `var()` isn't reachable —
 * Cytoscape canvas styles, chart libs, canvas-drawn components. KEEP IN SYNC
 * with theme.css.
 *
 * Note on palette + mode: theme.css resolves three accent palettes (Petrol,
 * Atelier, Lagoon) across light/dark via `light-dark()` + `[data-palette]`.
 * This static mirror can only hold one snapshot, so it carries the **Lagoon
 * light** defaults (the spec's default palette, §2.5.3). Canvas/chart surfaces
 * that must follow the live palette/mode should read the CSS custom properties
 * off `getComputedStyle(document.documentElement)` instead of these constants.
 */

export const tokens = {
  /** Accent — the three Lume palettes' base fills (light mode, spec §2.5). */
  accentPalette: {
    lagoon:  '#1F8FA3',
    petrol:  '#0F7AB8',
    atelier: '#B36B2E',
  },

  /** SYSTEM — semantic roles (Lagoon light snapshot). */
  color: {
    // bg / fg semantic roles (light mode)
    bg:            '#F7F8FB',
    bgSoft:        '#F2F3F7',
    bgElevated:    '#FFFFFF',
    bgInverse:     '#1B1D24',

    fg:            '#1B1D24',
    fgStrong:      '#1B1D24',
    fgMuted:       '#5B5F6B',
    fgSubtle:      '#8D9099',
    fgOnDark:      '#FCFCFD',
    fgOnAccent:    '#FCFCFD',

    accent:        '#1F8FA3',
    accentHover:   '#197D90',
    accentPress:   '#146B7C',

    highlight:     '#1F8FA3',

    border:        '#E3E4E8',
    borderStrong:  '#CDCED4',

    success:       '#3F7A55',
    warning:       '#8C6A1F',
    danger:        '#A8443B',
    info:          '#1F8FA3',
  },

  /** Neutral ramp (50…900), hue ~250 to match the Lume surface family. */
  gray: {
    50:  '#F7F8FB',
    100: '#ECEDF2',
    200: '#DCDEE3',
    300: '#BFC1C6',
    400: '#8D9099',
    500: '#5B5F6B',
    600: '#3E414C',
    700: '#2A2D38',
    800: '#1F2127',
    900: '#16181E',
  },

  typography: {
    sansFamily:
      "'Geist', system-ui, -apple-system, 'Segoe UI', sans-serif",
    serifFamily:
      "'Source Serif 4', Charter, 'Iowan Old Style', Georgia, serif",
    monoFamily:
      "'Geist Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
  },

  /** Lume radius scale (spec §2.9). */
  radii: {
    none:   '0',
    sm:     '6px',
    md:     '8px',
    lg:     '12px',
    pill:   '999px',
    circle: '50%',
  },

  /** Lume motion tokens (spec §2.11). */
  motion: {
    standard: 'cubic-bezier(0.22, 0.61, 0.36, 1)',
    emphasis: 'cubic-bezier(0.4, 0, 0.2, 1)',
    quick:    '100ms',
    smooth:   '200ms',
    deliberate: '320ms',
  },
} as const;

/**
 * Map from token key → CSS custom-property name. Helper for components that
 * prefer the CSS var() form (keeps a single list of known token names).
 */
export type SemanticColorKey =
  | 'bg' | 'bgSoft' | 'bgElevated' | 'bgInverse'
  | 'fg' | 'fgStrong' | 'fgMuted' | 'fgSubtle' | 'fgOnDark' | 'fgOnAccent'
  | 'accent' | 'accentHover' | 'accentPress'
  | 'highlight' | 'border' | 'borderStrong'
  | 'success' | 'warning' | 'danger' | 'info';

const CSS_VAR_NAME: Record<SemanticColorKey, string> = {
  bg: '--bg',
  bgSoft: '--bg-soft',
  bgElevated: '--bg-elevated',
  bgInverse: '--bg-inverse',
  fg: '--fg',
  fgStrong: '--fg-strong',
  fgMuted: '--fg-muted',
  fgSubtle: '--fg-subtle',
  fgOnDark: '--fg-on-dark',
  fgOnAccent: '--fg-on-accent',
  accent: '--accent',
  accentHover: '--accent-hover',
  accentPress: '--accent-press',
  highlight: '--highlight',
  border: '--border',
  borderStrong: '--border-strong',
  success: '--success',
  warning: '--warning',
  danger: '--danger',
  info: '--info',
};

export function cssVar(key: SemanticColorKey): string {
  return `var(${CSS_VAR_NAME[key]})`;
}
