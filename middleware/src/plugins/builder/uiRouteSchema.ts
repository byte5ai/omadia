/**
 * UiRouteSchema (B.12-1) — Dashboard-Capable-Builder spec extension.
 *
 * Each entry in `AgentSpec.ui_routes[]` declares one browser-/Teams-tab-
 * fähigen Dashboard-Pfad, der vom Codegen (B.12-2) zu einem dedizierten
 * Express-`UiRouter` und einer `ctx.uiRoutes.register(...)`-Eintragung im
 * `activate-body`-Slot expandiert wird. Drei Render-Modes ab Tag 1:
 *
 *   - 'library'         — Tailwind-html-Helper-Templates (list-card,
 *                         kpi-tiles). Kein Build-Step, kein React. LLM
 *                         füllt nur Data-Binding-Felder, kein freier Code.
 *   - 'react-ssr'       — TSX-Component-Slot (`ui-<id>-component`),
 *                         server-rendered via `renderToString`. Tailwind
 *                         via PostCSS-Build im Plugin. Volle React-DX.
 *   - 'free-form-html'  — Freier `html\`...\``-Slot (`ui-<id>-render`).
 *                         Plugin-Autor-Escape-Hatch, full Express-Route-
 *                         hoheit, kein Library-Constraint.
 *
 * `interactive: boolean` ist forward-compatible für B.13 (Client-Side-
 * Hydration); in B.12 lehnt der Linter `interactive=true` ab.
 *
 * Cross-Field-Checks (Lint-Layer, nicht Zod) leben in
 *   - agentSpec.ts:validateSpecForCodegen() — data_binding.tool_id-
 *     Resolution, render_mode/ui_template-Binding
 *   - manifestLinter.ts:validateSpec() — Pfad-Eindeutigkeit, tab_label-
 *     Eindeutigkeit, interactive=false-Enforcement
 */

import { z } from 'zod';

// Route-id is slug-style — lowercase letters/digits/dashes, must start
// with a letter. Maps to slot keys (`ui-<id>-component`) and to the
// generated UiRouter-Filename (`<id>UiRouter.ts(x)`), so it must be
// FS-safe and JS-identifier-friendly when camelCased.
const UiRouteIdSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]*$/,
    'ui_route id must be lowercase letters/digits/dashes, starting with a letter',
  );

// Path is relative to the plugin mount (`/p/<pluginId>`). Allowed
// characters mirror the existing `routes.register`-Konvention:
// lowercase segments, slash-separated, no trailing slash. Single
// leading slash required.
const UiRoutePathSchema = z
  .string()
  .regex(
    /^\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/,
    'path must start with `/` and contain only lowercase letters/digits/dashes (no trailing slash)',
  );

// Render-mode picker. Library covers 80% of dashboard-cases via
// curated Tailwind-helpers; react-ssr is the React-DX-path that LLMs
// know from training (Next.js-style JSX); free-form-html is the
// escape-hatch for either special HTML layouts or migration-from-
// hand-written-plugins.
export const RenderModeSchema = z.enum(['library', 'react-ssr', 'free-form-html']);
export type RenderMode = z.infer<typeof RenderModeSchema>;

// Library-template picker. Only relevant when render_mode='library';
// other modes leave this empty. List grows with B.12-3 (kpi-tiles +
// list-card MVP; table-filter + empty-state in Folgephase if Use-Case).
export const UiTemplateSchema = z.enum(['list-card', 'kpi-tiles']);
export type UiTemplate = z.infer<typeof UiTemplateSchema>;

// Data-binding. Today the only source is `tool` (re-uses an existing
// tool from spec.tools[] — Single Source of Truth Chat + Tab). Future
// sources (`service` for direct ctx.services.get() calls; `static` for
// build-time-frozen JSON) lassen sich als Union erweitern, ohne dass
// das Schema-Shape sich verändert.
export const DataBindingSchema = z
  .object({
    source: z.literal('tool'),
    tool_id: z.string().regex(/^[a-z][a-z0-9_]*$/, 'tool_id must match snake_case tool id'),
    args: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type DataBinding = z.infer<typeof DataBindingSchema>;

// Item-template for `library` + `list-card`. Each value is a path-
// interpolation-Expression — `${item.title}`, `${item.repo}#${item.number}`
// etc. — die der renderListCard-Helper sicher auflöst (Object-Path-
// Lookup + html-escape; KEIN eval). Mehr Details in
// harness-ui-helpers/templates/interpolate.ts (B.12-3).
export const ItemTemplateSchema = z
  .object({
    title: z.string().min(1),
    subtitle: z.string().optional(),
    meta: z.string().optional(),
    url: z.string().optional(),
  })
  .strict();

export type ItemTemplate = z.infer<typeof ItemTemplateSchema>;

// Main schema. `.strict()` so unknown fields fail loud — the Builder-
// LLM tends to add advisory metadata, and for ui_routes we'd rather
// catch it here than ship a half-typed field downstream.
export const UiRouteSchema = z
  .object({
    id: UiRouteIdSchema,
    path: UiRoutePathSchema,
    tab_label: z.string().min(1).max(24),
    page_title: z.string().min(1).max(80),
    /**
     * Auto-refresh interval in seconds. 0 = no auto-refresh.
     * Maps to `htmlDoc({ refreshSeconds })` from harness-ui-helpers
     * — heute ein meta-refresh, der dem Tab einen Full-Reload triggert.
     * Phase 2 (mit Hydration) kann das auf SWR-Style fetch-revalidate
     * umstellen, ohne dass das Schema sich ändert.
     */
    refresh_seconds: z.number().int().min(0).max(3600).default(60),
    render_mode: RenderModeSchema.default('library'),
    /** Required when render_mode='library'; ignored otherwise. */
    ui_template: UiTemplateSchema.optional(),
    /**
     * B.13 reserve: client-side hydration toggle. B.12 lint-rejects
     * `interactive=true` so we don't ship half-working hydration; the
     * schema column stays so B.13 can flip it on without a migration.
     */
    interactive: z.boolean().default(false),
    data_binding: DataBindingSchema.optional(),
    /** Required when render_mode='library' AND ui_template='list-card'. */
    item_template: ItemTemplateSchema.optional(),
    /**
     * Optional slot-key. When set, the slot's value is a 1-Funktions-
     * Source-String `(toolOut: unknown) => unknown[]` (für list-card) or
     * `(toolOut: unknown) => Tile[]` (für kpi-tiles), die den raw Tool-
     * Output in die Template-Contract-Shape übersetzt. Identity-Default
     * (`(x) => x`) wenn nicht gesetzt.
     */
    output_transform_slot: z.string().optional(),
  })
  .strict();

export type UiRoute = z.infer<typeof UiRouteSchema>;

/**
 * Tab-label-suitability check — used by the Builder-UI to warn the
 * operator about Teams-Tab-Pinning-Konflikten. Tab labels über 24
 * Zeichen werden in Teams truncated; das Schema enforced das hart.
 */
export function isTabLabelValid(label: string): boolean {
  return label.trim().length > 0 && label.length <= 24;
}
