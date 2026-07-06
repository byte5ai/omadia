// Shared Lume UI-preference contract (issue #287). Single home for the palette
// + appearance enums and the cookie shape, imported by the API client
// (`_lib/api.ts`), the `ThemeControls` widget, and the RSC layout pre-paint —
// so the three can't drift when the spec adds a palette or appearance.

export const PALETTES = ['lagoon', 'petrol', 'atelier'] as const;
export type PaletteName = (typeof PALETTES)[number];

export const APPEARANCES = ['system', 'light', 'dark'] as const;
export type Appearance = (typeof APPEARANCES)[number];

export interface UiPrefs {
  palette?: PaletteName;
  appearance?: Appearance;
}

/** Non-secret cookie the client mirrors the choice into for the no-FOUC
 *  pre-paint. Value: `encodeURIComponent(JSON.stringify({ palette, appearance }))`. */
export const UI_PREFS_COOKIE = 'omadia-ui-prefs';

export function isPalette(v: string | null | undefined): v is PaletteName {
  return v != null && (PALETTES as readonly string[]).includes(v);
}

export function isAppearance(v: string | null | undefined): v is Appearance {
  return v != null && (APPEARANCES as readonly string[]).includes(v);
}

/**
 * Decode the UI-prefs cookie for the RSC layout. Returns the validated palette
 * (defaulting to `lagoon`) and the pinned theme — `null` for `system`/absent,
 * so the layout omits `data-theme` and CSS `light-dark()` follows the OS.
 */
export function parseUiPrefsCookie(raw: string | undefined): {
  palette: PaletteName;
  theme: 'light' | 'dark' | null;
} {
  let palette: PaletteName = 'lagoon';
  let theme: 'light' | 'dark' | null = null;
  if (raw) {
    try {
      const v = JSON.parse(decodeURIComponent(raw)) as {
        palette?: unknown;
        appearance?: unknown;
      };
      if (typeof v.palette === 'string' && isPalette(v.palette)) {
        palette = v.palette;
      }
      if (v.appearance === 'light' || v.appearance === 'dark') {
        theme = v.appearance;
      }
    } catch {
      /* malformed cookie — fall back to the lagoon/system defaults */
    }
  }
  return { palette, theme };
}
