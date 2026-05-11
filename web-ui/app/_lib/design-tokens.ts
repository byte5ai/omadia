/**
 * Harness Platform — Design Tokens (TypeScript mirror of byte5 brand)
 * ---------------------------------------------------------------------------
 * The authoritative source is `theme.css`. This mirror exists for cases
 * where CSS var() isn't an option (Cytoscape canvas styles, chart libs,
 * canvas-drawn components). KEEP IN SYNC with theme.css.
 *
 * Brand summary (per byte5 README):
 *   - Core palette: only 5 colours (Blau, Blau dunkel, Weiss, Schwarz, Magenta).
 *   - Magenta is reserved for the signature ":" device — no state / UI chrome.
 *   - Typography: Days One for display/logo only; Nunito Sans for body.
 *   - Radii: pill (9999px) for CTAs + small (8–14px) for cards. No mid radii.
 */

export const tokens = {
  /** CORE — the five brand-official colours. */
  brand: {
    blau:        '#009FE3',
    blauDunkel:  '#004B73',
    weiss:       '#FFFFFF',
    schwarz:     '#000000',
    magenta:     '#EA5172',
  },

  /** SYSTEM — grayscale + semantic roles derived to harmonise with core. */
  color: {
    // bg / fg semantic roles (light mode)
    bg:            '#FFFFFF',
    bgSoft:        '#F4F7FA',
    bgElevated:    '#FFFFFF',
    bgInverse:     '#004B73',

    fg:            '#004B73',
    fgStrong:      '#004B73',
    fgMuted:       '#5F6E7B',
    fgSubtle:      '#8A99A6',
    fgOnDark:      '#FFFFFF',
    fgOnAccent:    '#FFFFFF',

    accent:        '#009FE3',
    accentHover:   '#0086C0',
    accentPress:   '#006C9C',

    highlight:     '#EA5172',

    border:        '#D3DDE5',
    borderStrong:  '#B4C2CD',

    success:       '#15A06B',
    warning:       '#E0A82E',
    danger:        '#D9354C',
    info:          '#009FE3',
  },

  /** Grayscale ramp (50…900). */
  gray: {
    50:  '#F4F7FA',
    100: '#E8EEF3',
    200: '#D3DDE5',
    300: '#B4C2CD',
    400: '#8A99A6',
    500: '#5F6E7B',
    600: '#3F4D59',
    700: '#283540',
    800: '#15212B',
    900: '#0A1420',
  },

  typography: {
    displayFamily:
      "'Days One', 'Nunito Sans', system-ui, sans-serif",
    textFamily:
      "'Nunito Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
    monoFamily:
      "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace",
  },

  radii: {
    xs:     '4px',
    sm:     '8px',
    md:     '14px',
    lg:     '22px',
    pill:   '9999px',
    circle: '50%',
  },

  motion: {
    easeOut:   'cubic-bezier(0.22, 0.61, 0.36, 1)',
    easeInOut: 'cubic-bezier(0.65, 0, 0.35, 1)',
    durFast:   '140ms',
    durBase:   '220ms',
    durSlow:   '360ms',
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
