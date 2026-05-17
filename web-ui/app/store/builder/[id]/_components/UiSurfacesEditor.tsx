'use client';

import { LayoutDashboard, ShieldCheck } from 'lucide-react';
import { useCallback } from 'react';

import type { JsonPatch, ToolSpec, UiRoute } from '../../../../_lib/builderTypes';

import { InlineSlotEditor } from './InlineSlotEditor';
import { PagesList } from './PagesList';

interface UiSurfacesEditorProps {
  adminUiPath: string | undefined;
  uiRoutes: ReadonlyArray<UiRoute>;
  tools: ReadonlyArray<ToolSpec>;
  draftId: string;
  slots: Record<string, string | undefined>;
  /** All patches flow through here — SpecEditor's debounced PATCH /spec. */
  onPatch: (patches: JsonPatch[]) => Promise<void> | void;
}

const ADMIN_UI_BODY_SLOT = 'admin-ui-body';

/**
 * UI-Surfaces — Schritt 4 im Plugin-Authoring-Flow.
 *
 * Bündelt die zwei UI-Mechanismen, die ein Plugin operator-/end-user-facing
 * exposen kann:
 *
 *   - **Admin UI** (S+7.7): Single-Page iframe in der Store-Detail nach
 *     Install. Für operator-pflegte Daten (MAC↔Person-Zuordnungen, Custom-
 *     Tags, etc.). Plugin setzt `admin_ui_path` im Manifest, mountet die
 *     Static-Files via `ctx.routes.register()`, Body-Inhalt kommt aus dem
 *     `admin-ui-body`-Slot (assets/admin-ui/index.html). EIN Pfad pro Plugin.
 *
 *   - **Dashboard Pages** (B.12): N viele Browser-/Teams-Tab-rendernde
 *     Routes. Für end-user-facing Dashboards (PR-Inbox, Birthdays, KPIs).
 *     Plugin deklariert `ui_routes[]` im Spec, Codegen synthesisiert pro
 *     Eintrag einen Express-UiRouter, der von channel-teams als Tab-Card
 *     entdeckt wird.
 *
 * Beide Surface-Typen folgen demselben Pattern (Plugin serviert HTML,
 * Workspace zeigt das gerenderte Ergebnis), unterscheiden sich aber im
 * Konsum-Pfad — Admin UI ist Operator-Tool, Dashboards sind End-User-
 * Surface. Der Editor zeigt beide nebeneinander, damit Plugin-Autor weiß
 * welche Option das Richtige ist (oder beides nutzt).
 */
export function UiSurfacesEditor({
  adminUiPath,
  uiRoutes,
  tools,
  draftId,
  slots,
  onPatch,
}: UiSurfacesEditorProps): React.ReactElement {
  const adminUiEnabled = typeof adminUiPath === 'string' && adminUiPath.length > 0;

  const toggleAdminUi = useCallback(() => {
    if (adminUiEnabled) {
      // Remove the path. The admin-ui-body slot stays intact — operator
      // toggling off is reversible without losing content. Codegen
      // simply omits the manifest field when path is unset.
      void onPatch([{ op: 'remove', path: '/admin_ui_path' }]);
    } else {
      // Default convention: `/api/<slug>/admin/index.html`. The slug
      // isn't trivially available here (spec.id needs sanitisation),
      // so we seed a placeholder the operator can refine inline.
      void onPatch([
        {
          op: 'add',
          path: '/admin_ui_path',
          value: '/api/<slug>/admin/index.html',
        },
      ]);
    }
  }, [adminUiEnabled, onPatch]);

  const updateAdminUiPath = useCallback(
    (next: string) => {
      const op = adminUiEnabled ? 'replace' : 'add';
      void onPatch([{ op, path: '/admin_ui_path', value: next }]);
    },
    [adminUiEnabled, onPatch],
  );

  return (
    <div className="space-y-4">
      {/* ─── Admin UI Sub-Card ─── */}
      <SurfaceCard
        icon={<ShieldCheck className="size-4 text-slate-500" />}
        title="Admin UI"
        subtitle="Ein iframe in der Store-Detail, operator-only. Für Daten-Pflege die nicht aus der API kommt."
      >
        <label className="flex items-start gap-2 rounded-md border border-[color:var(--border)] bg-[color:var(--bg)] px-3 py-2 text-[12px] hover:border-[color:var(--accent)]">
          <input
            type="checkbox"
            checked={adminUiEnabled}
            onChange={toggleAdminUi}
            className="mt-0.5"
          />
          <span className="flex-1">
            <span className="font-medium text-[color:var(--fg-strong)]">
              Admin UI bereitstellen
            </span>
            <span className="ml-2 text-[color:var(--fg-muted)]">
              Plugin mountet eine HTML-Page unter <code>admin_ui_path</code>.
              Web-UI embed sie als <code>&lt;iframe&gt;</code> auf der
              Store-Detail-Seite nach Install.
            </span>
          </span>
        </label>

        {adminUiEnabled ? (
          <div className="mt-3 space-y-3">
            <label className="block text-[12px]">
              <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-[color:var(--fg-muted)]">
                Pfad (absolut, endet auf <code>index.html</code>)
              </span>
              <input
                type="text"
                value={adminUiPath ?? ''}
                onChange={(e) => updateAdminUiPath(e.target.value)}
                placeholder="/api/<slug>/admin/index.html"
                className="w-full rounded-md border border-[color:var(--border)] bg-[color:var(--bg)] px-2 py-1.5 font-mono text-[12px]"
              />
            </label>

            <InlineSlotEditor
              draftId={draftId}
              slotKey={ADMIN_UI_BODY_SLOT}
              initialValue={slots[ADMIN_UI_BODY_SLOT] ?? defaultAdminUiStub()}
              label="Admin UI Body (HTML)"
              hint="Inhalt zwischen den Marker-Regions. inline <style> + <script> erlaubt."
              heightPx={280}
            />

            <p className="rounded-md border border-amber-200 bg-amber-50/40 px-3 py-2 text-[11px] text-amber-900">
              <strong>Operator-Contract:</strong> Frontend-Fetches müssen{' '}
              <strong>relative URLs</strong> nutzen (
              <code>fetch(&apos;api/devices&apos;)</code>, nicht{' '}
              <code>fetch(&apos;/api/...&apos;)</code>) — die UI läuft hinter
              einem <code>/bot-api/*</code>-Rewrite. JSON-Responses brauchen das{' '}
              <code>{'{ ok: boolean, ... }'}</code>-Schema, sonst flagged der
              RuntimeSmoke sie als kaputt.
            </p>
          </div>
        ) : (
          <p className="mt-2 text-[11px] text-[color:var(--fg-muted)]">
            Aus. Plugins ohne <code>admin_ui_path</code> haben keine Admin-Tile in
            der Store-Detail-Seite — das ist der Default.
          </p>
        )}
      </SurfaceCard>

      {/* ─── Dashboard Pages Sub-Card ─── */}
      <SurfaceCard
        icon={<LayoutDashboard className="size-4 text-slate-500" />}
        title="Dashboard Pages"
        subtitle="Browser-/Teams-Tab-rendernde Routes. Für end-user-facing Anzeigen (PR-Inbox, KPIs, Listen)."
      >
        <PagesList
          uiRoutes={uiRoutes}
          tools={tools}
          draftId={draftId}
          slots={slots}
          onPatch={onPatch}
        />
      </SurfaceCard>
    </div>
  );
}

interface SurfaceCardProps {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}

function SurfaceCard({
  icon,
  title,
  subtitle,
  children,
}: SurfaceCardProps): React.ReactElement {
  return (
    <section className="rounded-lg border border-[color:var(--border)] bg-[color:var(--bg-subtle)] p-4">
      <header className="mb-3 flex items-start gap-2">
        <div className="mt-0.5">{icon}</div>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold text-[color:var(--fg-strong)]">
            {title}
          </div>
          <div className="mt-0.5 text-[11px] text-[color:var(--fg-muted)]">
            {subtitle}
          </div>
        </div>
      </header>
      {children}
    </section>
  );
}

function defaultAdminUiStub(): string {
  return `<!-- #region builder:admin-ui-body -->
<main class="harness-main">
  <h1 class="harness-h1">{{AGENT_NAME}}</h1>
  <p class="harness-text">{{AGENT_DESCRIPTION_DE}}</p>
  <p class="harness-text">
    Editier diesen Block via fill_slot('admin-ui-body', ...) oder direkt im Workspace.
  </p>
</main>
<!-- #endregion -->`;
}
