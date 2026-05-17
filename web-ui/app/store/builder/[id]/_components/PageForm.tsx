'use client';

import { useCallback } from 'react';

import type {
  JsonPatch,
  ToolSpec,
  UiRoute,
  UiRouteRenderMode,
  UiRouteUiTemplate,
} from '../../../../_lib/builderTypes';

import { InlineSlotEditor } from './InlineSlotEditor';
import { PagePreviewFrame } from './PagePreviewFrame';

interface PageFormProps {
  route: UiRoute;
  tools: ReadonlyArray<ToolSpec>;
  /** Draft id — needed to wire the live-preview iframe to the right
   *  `/api/v1/builder/drafts/:id/preview/ui-route/:routeId` endpoint. */
  draftId: string;
  /** Initial slot values from the draft — feeds InlineSlotEditor on
   *  mount. Subsequent slot updates flow through patchBuilderSlot
   *  directly; this prop is NOT a live mirror (avoid clobbering
   *  in-progress edits). */
  slots: Record<string, string | undefined>;
  /** Patches are scoped to the route subtree — caller (PagesList) rebases
   *  them onto `/ui_routes/<index>` before forwarding to PATCH /spec. */
  onPatch: (patches: JsonPatch[]) => Promise<void> | void;
}

const RENDER_MODE_DESCRIPTIONS: Record<UiRouteRenderMode, string> = {
  library: 'Kuratierte Tailwind-Templates (list-card / kpi-tiles). Schnell, kein Build-Step.',
  'react-ssr': 'TSX-Component (server-rendered). Volle React-DX, server-rendered, Tailwind via CDN.',
  'free-form-html': 'Freies html`…`-Slot. Du schreibst Express-Route-Body selbst.',
};

const UI_TEMPLATE_DESCRIPTIONS: Record<UiRouteUiTemplate, string> = {
  'list-card': 'Liste von Cards (title + subtitle + url). Standard für „zeig mir X-Items".',
  'kpi-tiles': '1–4 Zahlen-Kacheln (label + value + optional hint). Für Counts/KPIs.',
};

/**
 * B.12-5 — Inline-edit form for a single ui_route. All fields persist via
 * JSON-Patch on blur/change (no save button — same flow as ToolForm).
 *
 * Mode-conditional fields:
 *   - library: ui_template + data_binding.tool_id + (list-card)
 *              item_template (title/subtitle/meta/url)
 *   - react-ssr / free-form-html: data_binding.tool_id only; the actual
 *              component/render body lives in the global SlotEditor as
 *              `ui-<id>-component` / `ui-<id>-render` respectively.
 */
export function PageForm({
  route,
  tools,
  draftId,
  slots,
  onPatch,
}: PageFormProps): React.ReactElement {
  const patchField = useCallback(
    (path: string, value: unknown) => {
      void onPatch([{ op: 'replace', path, value }]);
    },
    [onPatch],
  );

  const addItemTemplate = useCallback(() => {
    void onPatch([
      { op: 'add', path: '/item_template', value: { title: '${item.title}' } },
    ]);
  }, [onPatch]);

  const onRenderModeChange = useCallback(
    (next: UiRouteRenderMode) => {
      const patches: JsonPatch[] = [{ op: 'replace', path: '/render_mode', value: next }];
      // Mode-specific defaults: when switching INTO library, seed ui_template
      // + item_template if missing. When switching AWAY, optionally remove
      // them — we keep them (operator may switch back; data loss not worth it).
      if (next === 'library') {
        if (!route.ui_template) {
          patches.push({ op: 'add', path: '/ui_template', value: 'list-card' });
        }
        if (route.ui_template === 'list-card' && !route.item_template) {
          patches.push({
            op: 'add',
            path: '/item_template',
            value: { title: '${item.title}' },
          });
        }
      }
      void onPatch(patches);
    },
    [route.ui_template, route.item_template, onPatch],
  );

  const componentSlotKey = `ui-${route.id}-component`;
  const renderSlotKey = `ui-${route.id}-render`;

  return (
    <div className="space-y-4 text-[12px]">
      {/* Identity row */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Field
          label="Route-ID (slug)"
          value={route.id}
          help="Lowercase, Bindestriche erlaubt. Bestimmt Slot-Keys + Filename."
          onChange={(v) => patchField('/id', v)}
        />
        <Field
          label="Path"
          value={route.path}
          help="Relativ zum Plugin-Mount. Endgültig: /p/<id><path>."
          onChange={(v) => patchField('/path', v)}
        />
        <Field
          label="Tab-Label (Teams Hub)"
          value={route.tab_label}
          help="Max 24 Zeichen. Wird in Teams-Tab + Hub-Card angezeigt."
          maxLength={24}
          onChange={(v) => patchField('/tab_label', v)}
        />
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field
          label="Page-Title (<title>)"
          value={route.page_title}
          help="Voller Page-Title im HTML-Doc. Max 80 Zeichen."
          maxLength={80}
          onChange={(v) => patchField('/page_title', v)}
        />
        <Field
          label="Refresh (s)"
          type="number"
          value={String(route.refresh_seconds)}
          help="Meta-Refresh-Intervall. 0 = kein Auto-Reload."
          onChange={(v) => {
            const n = Number(v);
            if (Number.isFinite(n) && n >= 0 && n <= 3600 && Number.isInteger(n)) {
              patchField('/refresh_seconds', n);
            }
          }}
        />
      </div>

      {/* Render mode */}
      <div>
        <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-[color:var(--fg-muted)]">
          Render-Mode
        </div>
        <div className="space-y-1">
          {(['library', 'react-ssr', 'free-form-html'] as const).map((mode) => (
            <label
              key={mode}
              className="flex cursor-pointer items-start gap-2 rounded-md border border-[color:var(--border)] bg-[color:var(--bg)] px-2.5 py-2 hover:border-[color:var(--accent)]"
            >
              <input
                type="radio"
                name={`render_mode-${route.id}`}
                checked={route.render_mode === mode}
                onChange={() => onRenderModeChange(mode)}
                className="mt-0.5"
              />
              <span className="flex-1">
                <span className="font-medium text-[color:var(--fg-strong)]">
                  {mode === 'library'
                    ? 'Library'
                    : mode === 'react-ssr'
                      ? 'React SSR'
                      : 'Free-form HTML'}
                </span>
                <span className="ml-2 text-[color:var(--fg-muted)]">
                  {RENDER_MODE_DESCRIPTIONS[mode]}
                </span>
              </span>
            </label>
          ))}
        </div>
      </div>

      {/* Library-mode fields */}
      {route.render_mode === 'library' ? (
        <div className="space-y-3 rounded-md border border-emerald-200 bg-emerald-50/40 p-3">
          <div>
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-emerald-800">
              UI-Template
            </div>
            <div className="space-y-1">
              {(['list-card', 'kpi-tiles'] as const).map((t) => (
                <label
                  key={t}
                  className="flex cursor-pointer items-start gap-2 rounded-md border border-emerald-200/60 bg-white px-2.5 py-1.5 hover:border-emerald-400"
                >
                  <input
                    type="radio"
                    name={`ui_template-${route.id}`}
                    checked={route.ui_template === t}
                    onChange={() => patchField('/ui_template', t)}
                    className="mt-0.5"
                  />
                  <span className="flex-1">
                    <span className="font-medium">{t}</span>
                    <span className="ml-2 text-[color:var(--fg-muted)]">
                      {UI_TEMPLATE_DESCRIPTIONS[t]}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          {route.ui_template === 'list-card' ? (
            <ItemTemplateEditor
              itemTemplate={route.item_template ?? null}
              onPatch={(patches) => {
                if (!route.item_template) {
                  // Need to add the wrapper first, then re-apply replace
                  // operations. For simplicity: ensure it exists, then patch.
                  void addItemTemplate();
                  setTimeout(() => void onPatch(patches), 0);
                  return;
                }
                void onPatch(patches);
              }}
            />
          ) : null}
        </div>
      ) : null}

      {/* Data binding (all modes) */}
      <div className="space-y-2 rounded-md border border-[color:var(--border)] bg-[color:var(--bg)] p-3">
        <div className="text-[11px] font-medium uppercase tracking-wide text-[color:var(--fg-muted)]">
          Datenquelle
        </div>
        <label className="flex items-center gap-2">
          <span className="w-24 shrink-0 text-[color:var(--fg-muted)]">Tool:</span>
          <select
            value={route.data_binding?.tool_id ?? ''}
            onChange={(e) => {
              const id = e.target.value;
              if (id === '') {
                if (route.data_binding) {
                  void onPatch([{ op: 'remove', path: '/data_binding' }]);
                }
                return;
              }
              if (!route.data_binding) {
                void onPatch([
                  {
                    op: 'add',
                    path: '/data_binding',
                    value: { source: 'tool', tool_id: id },
                  },
                ]);
              } else {
                patchField('/data_binding/tool_id', id);
              }
            }}
            className="flex-1 rounded-md border border-[color:var(--border)] bg-[color:var(--bg)] px-2 py-1.5 text-[12px]"
          >
            <option value="">— Kein Tool gebunden —</option>
            {tools.map((t) => (
              <option key={t.id} value={t.id}>
                {t.id}
              </option>
            ))}
          </select>
        </label>
        <p className="text-[11px] text-[color:var(--fg-muted)]">
          Das gewählte Tool wird bei jedem Page-Request mit leerem Input aufgerufen; Output
          fließt als Props in die Render-Funktion.
        </p>
      </div>

      {/* B.13 — Interactive (client-side hydration) toggle. Only available
          for react-ssr mode; lint rejects interactive=true for library/
          free-form-html (no React component to hydrate). */}
      {route.render_mode === 'react-ssr' ? (
        <label className="flex items-start gap-2 rounded-md border border-sky-200 bg-sky-50/40 px-2.5 py-2 hover:border-sky-400">
          <input
            type="checkbox"
            checked={route.interactive === true}
            onChange={(e) => patchField('/interactive', e.target.checked)}
            className="mt-0.5"
          />
          <span className="flex-1 text-[12px]">
            <span className="font-medium text-sky-900">Interactive (Hydration)</span>
            <span className="ml-2 text-[color:var(--fg-muted)]">
              SSR + Client-Side-Hydration via esm.sh-Importmap. Setze auf true
              wenn dein Component <code>useState</code>, <code>onClick</code>{' '}
              o.ä. nutzt. Root-Element MUSS{' '}
              <code>data-omadia-page=&quot;{route.id}&quot;</code> tragen.
            </span>
          </span>
        </label>
      ) : null}

      {/* Inline slot editor for react-ssr / free-form-html. The global
          SlotEditor is still authoritative for slot-merge-conflict cases —
          this surface is the operator's fast path for the common case. */}
      {route.render_mode === 'react-ssr' ? (
        <InlineSlotEditor
          draftId={draftId}
          slotKey={componentSlotKey}
          initialValue={slots[componentSlotKey] ?? defaultReactSsrStub(route.id)}
          label="Component (TSX, default-export)"
          hint="Props: { data: unknown; fetchError: string | null }"
        />
      ) : null}

      {route.render_mode === 'free-form-html' ? (
        <InlineSlotEditor
          draftId={draftId}
          slotKey={renderSlotKey}
          initialValue={
            slots[renderSlotKey] ?? defaultFreeFormStub(route.page_title)
          }
          label="Render-Slot (renderRoute-Callback-Body)"
          hint="Return: HtmlFragment (e.g. htmlDoc({ title, body }))"
        />
      ) : null}

      <PagePreviewFrame
        draftId={draftId}
        routeId={route.id}
        label={route.tab_label || route.id}
      />
    </div>
  );
}

interface FieldProps {
  label: string;
  value: string;
  help?: string;
  type?: 'text' | 'number';
  maxLength?: number;
  onChange: (next: string) => void;
}

function Field({
  label,
  value,
  help,
  type = 'text',
  maxLength,
  onChange,
}: FieldProps): React.ReactElement {
  return (
    <label className="block">
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-[color:var(--fg-muted)]">
        {label}
      </div>
      <input
        type={type}
        value={value}
        maxLength={maxLength}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-[color:var(--border)] bg-[color:var(--bg)] px-2 py-1.5 text-[12px]"
      />
      {help ? (
        <p className="mt-1 text-[11px] text-[color:var(--fg-muted)]">{help}</p>
      ) : null}
    </label>
  );
}

interface ItemTemplateEditorProps {
  itemTemplate: UiRoute['item_template'] | null;
  onPatch: (patches: JsonPatch[]) => void;
}

function defaultReactSsrStub(routeId: string): string {
  const componentName = pascalize(routeId);
  // B.13 — the root element MUST carry `data-omadia-page="<routeId>"` so
  // the client-side hydration script can locate the mount node. If
  // operator edits drop the attribute, hydration silently no-ops.
  return `interface PageProps {
  data: unknown;
  fetchError: string | null;
}

// IMPORTANT (B.13): keep \`data-omadia-page="${routeId}"\` on the root
// element. The hydration script uses this attribute to find the mount.
export default function ${componentName}Page({ data, fetchError }: PageProps) {
  if (fetchError) {
    return (
      <main data-omadia-page="${routeId}" className="max-w-3xl mx-auto p-6">
        <div className="rounded-md border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
          Daten konnten nicht gelesen werden: {fetchError}
        </div>
      </main>
    );
  }
  const items = Array.isArray(data) ? data : [];
  if (items.length === 0) {
    return (
      <main data-omadia-page="${routeId}" className="max-w-3xl mx-auto p-6 text-center text-slate-500">
        Keine Daten.
      </main>
    );
  }
  return (
    <main data-omadia-page="${routeId}" className="max-w-3xl mx-auto p-6 space-y-2">
      <h1 className="text-2xl font-semibold mb-3">${componentName}</h1>
      <pre className="text-xs bg-slate-100 p-3 rounded">{JSON.stringify(items, null, 2)}</pre>
    </main>
  );
}
`;
}

function defaultFreeFormStub(pageTitle: string): string {
  return `return htmlDoc({
  title: ${JSON.stringify(pageTitle)},
  refreshSeconds: 60,
  body: html\`
    <main class="max-w-3xl mx-auto p-6">
      <h1 class="text-2xl font-semibold mb-4">${pageTitle}</h1>
      <p class="text-sm text-slate-500">Replace this with your own rendering.</p>
    </main>
  \`,
});
`;
}

function pascalize(id: string): string {
  return id
    .split('-')
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join('');
}

function ItemTemplateEditor({
  itemTemplate,
  onPatch,
}: ItemTemplateEditorProps): React.ReactElement {
  const update = (field: 'title' | 'subtitle' | 'meta' | 'url', value: string) => {
    const path = `/item_template/${field}`;
    if (value === '') {
      if (field !== 'title') onPatch([{ op: 'remove', path }]);
      // title can't be empty — schema requires min(1); ignore the remove
      return;
    }
    if (!itemTemplate || itemTemplate[field] === undefined) {
      onPatch([{ op: 'add', path, value }]);
    } else {
      onPatch([{ op: 'replace', path, value }]);
    }
  };

  return (
    <div className="space-y-2">
      <div className="text-[11px] font-medium uppercase tracking-wide text-emerald-800">
        Item-Template (Path-Interpolation: <code>{'${item.feldname}'}</code>)
      </div>
      <Field
        label="Title (required)"
        value={itemTemplate?.title ?? '${item.title}'}
        onChange={(v) => update('title', v)}
      />
      <Field
        label="Subtitle (optional)"
        value={itemTemplate?.subtitle ?? ''}
        onChange={(v) => update('subtitle', v)}
      />
      <Field
        label="Meta (optional)"
        value={itemTemplate?.meta ?? ''}
        onChange={(v) => update('meta', v)}
      />
      <Field
        label="URL (optional — macht das Item klickbar)"
        value={itemTemplate?.url ?? ''}
        onChange={(v) => update('url', v)}
      />
      <p className="text-[11px] text-[color:var(--fg-muted)]">
        Whitelisted Suffixe: <code>{'.join(", ")'}</code> für Arrays,{' '}
        <code>.toLocaleString()</code> für Zahlen. Sonstige Function-Calls werden ignoriert.
      </p>
    </div>
  );
}
