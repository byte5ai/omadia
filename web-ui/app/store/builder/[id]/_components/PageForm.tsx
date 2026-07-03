'use client';

import { useTranslations } from 'next-intl';
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

// Maps the technical render-mode / ui-template tokens to translation-key
// suffixes under `builder.uiSurfaces.pageForm.*`. The tokens themselves are
// spec values and stay verbatim.
const RENDER_MODE_DESC_KEYS: Record<UiRouteRenderMode, string> = {
  library: 'renderMode.libraryDesc',
  'react-ssr': 'renderMode.reactSsrDesc',
  'free-form-html': 'renderMode.freeFormHtmlDesc',
};

const UI_TEMPLATE_DESC_KEYS: Record<UiRouteUiTemplate, string> = {
  'list-card': 'uiTemplate.listCardDesc',
  'kpi-tiles': 'uiTemplate.kpiTilesDesc',
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
  const t = useTranslations('builder.uiSurfaces.pageForm');
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
          label={t('fields.routeIdLabel')}
          value={route.id}
          help={t('fields.routeIdHelp')}
          onChange={(v) => patchField('/id', v)}
        />
        <Field
          label={t('fields.pathLabel')}
          value={route.path}
          help={t('fields.pathHelp')}
          onChange={(v) => patchField('/path', v)}
        />
        <Field
          label={t('fields.tabLabelLabel')}
          value={route.tab_label}
          help={t('fields.tabLabelHelp')}
          maxLength={24}
          onChange={(v) => patchField('/tab_label', v)}
        />
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field
          label={t('fields.pageTitleLabel')}
          value={route.page_title}
          help={t('fields.pageTitleHelp')}
          maxLength={80}
          onChange={(v) => patchField('/page_title', v)}
        />
        <Field
          label={t('fields.refreshLabel')}
          type="number"
          value={String(route.refresh_seconds)}
          help={t('fields.refreshHelp')}
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
          {t('renderMode.heading')}
        </div>
        <div className="space-y-1">
          {(['library', 'react-ssr', 'free-form-html'] as const).map((mode) => (
            <label
              key={mode}
              className="flex cursor-pointer items-start gap-2 rounded-md border border-[color:var(--border)] bg-[color:var(--bg)] px-3 py-2 hover:border-[color:var(--accent)]"
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
                  {t(RENDER_MODE_DESC_KEYS[mode])}
                </span>
              </span>
            </label>
          ))}
        </div>
      </div>

      {/* Library-mode fields */}
      {route.render_mode === 'library' ? (
        <div className="space-y-3 rounded-md border border-[color:var(--success)] bg-[color:var(--success)]/10 p-3">
          <div>
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-[color:var(--success)]">
              {t('uiTemplate.heading')}
            </div>
            <div className="space-y-1">
              {(['list-card', 'kpi-tiles'] as const).map((ut) => (
                <label
                  key={ut}
                  className="flex cursor-pointer items-start gap-2 rounded-md border border-[color:var(--success)]/60 bg-[color:var(--bg-elevated)] px-3 py-2 hover:border-[color:var(--success)]"
                >
                  <input
                    type="radio"
                    name={`ui_template-${route.id}`}
                    checked={route.ui_template === ut}
                    onChange={() => patchField('/ui_template', ut)}
                    className="mt-0.5"
                  />
                  <span className="flex-1">
                    <span className="font-medium">{ut}</span>
                    <span className="ml-2 text-[color:var(--fg-muted)]">
                      {t(UI_TEMPLATE_DESC_KEYS[ut])}
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
          {t('dataBinding.heading')}
        </div>
        <label className="flex items-center gap-2">
          <span className="w-24 shrink-0 text-[color:var(--fg-muted)]">
            {t('dataBinding.toolLabel')}
          </span>
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
            className="flex-1 rounded-md border border-[color:var(--border)] bg-[color:var(--bg)] px-2 py-2 text-[12px]"
          >
            <option value="">{t('dataBinding.noToolOption')}</option>
            {tools.map((t) => (
              <option key={t.id} value={t.id}>
                {t.id}
              </option>
            ))}
          </select>
        </label>
        <p className="text-[11px] text-[color:var(--fg-muted)]">
          {t('dataBinding.help')}
        </p>
      </div>

      {/* B.13 — Interactive (client-side hydration) toggle. Only available
          for react-ssr mode; lint rejects interactive=true for library/
          free-form-html (no React component to hydrate). */}
      {route.render_mode === 'react-ssr' ? (
        <label className="flex items-start gap-2 rounded-md border border-[color:var(--accent)] bg-[color:var(--accent)]/10 px-3 py-2 hover:border-[color:var(--accent)]">
          <input
            type="checkbox"
            checked={route.interactive === true}
            onChange={(e) => patchField('/interactive', e.target.checked)}
            className="mt-0.5"
          />
          <span className="flex-1 text-[12px]">
            <span className="font-medium text-[color:var(--accent)]">
              {t('interactive.label')}
            </span>
            <span className="ml-2 text-[color:var(--fg-muted)]">
              {t.rich('interactive.help', {
                code: (chunks) => <code>{chunks}</code>,
                routeId: route.id,
              })}
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
          initialValue={slots[componentSlotKey] ?? defaultReactSsrStub(route.id, t)}
          label={t('componentSlot.label')}
          hint={t('componentSlot.hint')}
        />
      ) : null}

      {route.render_mode === 'free-form-html' ? (
        <InlineSlotEditor
          draftId={draftId}
          slotKey={renderSlotKey}
          initialValue={
            slots[renderSlotKey] ?? defaultFreeFormStub(route.page_title)
          }
          label={t('renderSlot.label')}
          hint={t('renderSlot.hint')}
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
        className="w-full rounded-md border border-[color:var(--border)] bg-[color:var(--bg)] px-2 py-2 text-[12px]"
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

// Minimal translator signature (messages/README.md "Helper functions that
// need to translate") — keeps the stub builders unit-testable with a fake
// translator instead of coupling them to React hook rules.
type TFn = (key: string, values?: Record<string, string | number>) => string;

function defaultReactSsrStub(routeId: string, t: TFn): string {
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
        <div className="rounded-md border border-[color:var(--danger-edge)] bg-[color:var(--danger)]/8 p-4 text-sm text-[color:var(--danger)]">
          ${t('stub.fetchErrorPrefix')} {fetchError}
        </div>
      </main>
    );
  }
  const items = Array.isArray(data) ? data : [];
  if (items.length === 0) {
    return (
      <main data-omadia-page="${routeId}" className="max-w-3xl mx-auto p-6 text-center text-[color:var(--fg-muted)]">
        ${t('stub.noData')}
      </main>
    );
  }
  return (
    <main data-omadia-page="${routeId}" className="max-w-3xl mx-auto p-6 space-y-2">
      <h1 className="text-2xl font-semibold mb-3">${componentName}</h1>
      <pre className="text-xs bg-[color:var(--bg-soft)] p-3 rounded">{JSON.stringify(items, null, 2)}</pre>
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
      <p class="text-sm text-[color:var(--fg-muted)]">Replace this with your own rendering.</p>
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
  const t = useTranslations('builder.uiSurfaces.pageForm');
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
      <div className="text-[11px] font-medium uppercase tracking-wide text-[color:var(--success)]">
        {t.rich('itemTemplate.heading', {
          code: (chunks) => <code>{chunks}</code>,
        })}
      </div>
      <Field
        label={t('itemTemplate.titleLabel')}
        value={itemTemplate?.title ?? '${item.title}'}
        onChange={(v) => update('title', v)}
      />
      <Field
        label={t('itemTemplate.subtitleLabel')}
        value={itemTemplate?.subtitle ?? ''}
        onChange={(v) => update('subtitle', v)}
      />
      <Field
        label={t('itemTemplate.metaLabel')}
        value={itemTemplate?.meta ?? ''}
        onChange={(v) => update('meta', v)}
      />
      <Field
        label={t('itemTemplate.urlLabel')}
        value={itemTemplate?.url ?? ''}
        onChange={(v) => update('url', v)}
      />
      <p className="text-[11px] text-[color:var(--fg-muted)]">
        {t.rich('itemTemplate.suffixHelp', {
          code: (chunks) => <code>{chunks}</code>,
        })}
      </p>
    </div>
  );
}
