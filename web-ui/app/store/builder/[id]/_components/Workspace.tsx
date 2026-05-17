'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { LayoutGroup, motion } from 'framer-motion';
import {
  ArrowLeft,
  MessageSquare,
  Eye,
  Activity,
  Rocket,
  Wrench,
  Loader2,
  AlertTriangle,
  X,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type ImperativePanelGroupHandle,
  type ImperativePanelHandle,
} from 'react-resizable-panels';

import {
  getBuilderDraft,
  getPreviewSecretsStatus,
  getPreviewStatus,
  getTemplateSlots,
  listBuilderTemplates,
  patchBuilderModel,
  patchBuilderSpec,
} from '../../../../_lib/api';
import { cn } from '../../../../_lib/cn';
import { composeFixPrompt } from '../../../../_lib/composeFixPrompt';
import { useIsDesktop } from '../../../../_lib/useMediaQuery';
import type {
  BuilderModelId,
  BuilderTemplateInfo,
  Draft,
  TemplateSlotDef,
} from '../../../../_lib/builderTypes';

import { BuilderChatPane } from './BuilderChatPane';
import { InstallDiffModal } from './InstallDiffModal';
import { PaneCard } from './PaneCard';
import { PersonaPillar } from './PersonaPillar';
import {
  PreviewChatPane,
  type BuildStatusSnapshot,
} from './PreviewChatPane';
import { SlotEditor } from './SlotEditor';
import { SpecEditor } from './SpecEditor';
import { SpecOverview } from './SpecOverview';
import { UiSurfacesTabPane } from './UiSurfacesTabPane';
import { VersionsTab } from './VersionsTab';
import { useSpecEvents } from './useSpecEvents';

interface WorkspaceProps {
  initialDraft: Draft;
}

type EditorTab = 'overview' | 'spec' | 'slots' | 'persona' | 'versions';
type MobilePane = 'chat' | 'editor' | 'preview' | 'ui-surfaces';

const TAB_LABEL: Record<EditorTab, string> = {
  overview: 'Übersicht',
  spec: 'Spec',
  slots: 'Slots',
  persona: 'Persona',
  versions: 'Versionen',
};

const MODEL_LABEL: Record<BuilderModelId, string> = {
  haiku: 'Haiku',
  sonnet: 'Sonnet',
  opus: 'Opus',
};

const STATUS_LABEL: Record<Draft['status'], string> = {
  draft: 'Entwurf',
  installed: 'Installiert',
  archived: 'Archiviert',
};

/**
 * Workspace shell — Phase B.5-1.
 *
 * Holds the draft in local state and lays out the 4-pane builder workspace
 * (chat / editor-tabs / preview-chat / build-status). Each pane body is a
 * placeholder in B.5-1; subsequent sub-commits replace them in place:
 *
 *   B.5-2  → Builder-Chat-Pane (NDJSON consumer + reconnect)
 *   B.5-4  → SpecEventBus subscription (multi-tab sync)
 *   B.5-5  → Spec-Editor (Zod-form via PATCH /spec)
 *   B.5-6  → Slot-Editor (Monaco + TS-LSP)
 *   B.5-7  → Preview-Chat pane
 *   B.5-8  → Build-Status indicator (Stream-Subscribe)
 *
 * The shell already accepts the `Draft` shape so later panes can reuse the
 * same workspace state without churning the layout.
 */
export function Workspace({ initialDraft }: WorkspaceProps): React.ReactElement {
  const [draft, setDraft] = useState<Draft>(initialDraft);
  const [tab, setTab] = useState<EditorTab>('overview');
  const [busStatus, setBusStatus] = useState<'open' | 'closed' | 'error'>(
    'closed',
  );
  const [buildStatus, setBuildStatus] = useState<BuildStatusSnapshot>({
    phase: 'idle',
  });
  // B.7-6: Builder-Agent retried fill_slot 3× and is stuck. Cleared
  // automatically on the next slot_patch for the same slotKey (agent
  // succeeded after intervention) — see useSpecEvents handler below.
  const [agentStuck, setAgentStuck] = useState<{
    slotKey: string;
    attempts: number;
    lastReason: string;
    lastSummary: string;
    lastErrorCount: number;
  } | null>(null);
  // B.9-4: Latest runtime-smoke result surfaced as compact preview-pane
  // indicator. Replaced with each new event so the UI shows the most
  // recent build's state.
  const [runtimeSmoke, setRuntimeSmoke] = useState<{
    phase: 'running' | 'ok' | 'failed';
    buildN: number;
    reason?: 'ok' | 'activate_failed' | 'tool_failures' | 'no_tools';
    activateError?: string;
    results?: ReadonlyArray<{
      toolId: string;
      status: 'ok' | 'timeout' | 'threw' | 'validation_failed';
      durationMs: number;
      errorMessage?: string;
    }>;
  } | null>(null);
  // C-4: Latest AutoFix lifecycle frame. `triggered` is transient (cleared
  // on the next build_status:ok). `stopped_loop` is sticky — the operator
  // dismisses it (X button) or re-enables auto-fix.
  const [autoFix, setAutoFix] = useState<{
    phase: 'triggered' | 'stopped_loop';
    kind: 'build_failed' | 'smoke_failed';
    buildN: number;
    identicalCount?: number;
  } | null>(null);
  // Bridge so SlotEditor's "Frag den Agent"-Button can inject a
  // pre-filled prompt into the BuilderChatPane's input — and immediately
  // submit it when `autoSubmit` is true so the user does not have to
  // also click Senden. The Workspace owns the canonical state because
  // pane-internal local state would not be reachable from the editor
  // pane.
  const [pendingChatInput, setPendingChatInput] = useState<{
    text: string;
    autoSubmit?: boolean;
  } | null>(null);
  // Pane collapse state — chat is the only pane that starts open. Editor +
  // Preview start collapsed so the user has the maximum width for the
  // initial conversation; expanding either is one click on the rail.
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const [editorCollapsed, setEditorCollapsed] = useState(true);
  const [previewCollapsed, setPreviewCollapsed] = useState(true);
  // B.12-followup: UI-Surfaces is a peer pane to chat/editor/preview.
  // Default-collapsed so the historical 3-pane layout doesn't shift on
  // first-time-after-upgrade — operator expands the rail to author
  // Admin-UI or Dashboard-Pages.
  const [uiSurfacesCollapsed, setUiSurfacesCollapsed] = useState(true);
  // Mobile-Layout (B.6-5). Below 1280px the 3-pane grid becomes
  // unusable (each pane < ~400px); we collapse to a single visible pane
  // with a tab strip on top. Active tab persists in component state for
  // the lifetime of the workspace; SSE consumers stay mounted across
  // tab switches because mobile-mode keeps every pane in the React tree
  // (we toggle `display`, not the React node, so BuilderChatPane's NDJSON
  // stream and useSpecEvents subscription survive the switch).
  const isDesktop = useIsDesktop();
  const [mobilePane, setMobilePane] = useState<MobilePane>('chat');
  // react-resizable-panels imperative refs (B.6-4). Each Panel exposes
  // collapse() / expand() / resize() — we drive them from the existing
  // collapsed state so the rail click remains the canonical gesture, and
  // mirror the panel's own onCollapse/onExpand callbacks back into state
  // so dragging the handle past the threshold also collapses cleanly.
  const chatPanelRef = useRef<ImperativePanelHandle | null>(null);
  const editorPanelRef = useRef<ImperativePanelHandle | null>(null);
  const previewPanelRef = useRef<ImperativePanelHandle | null>(null);
  const uiSurfacesPanelRef = useRef<ImperativePanelHandle | null>(null);
  const panelGroupRef = useRef<ImperativePanelGroupHandle | null>(null);

  // Maximize-helper: sets the whole 3-pane layout in a single atomic
  // setLayout call so two simultaneous collapses don't fight each other.
  // The Panel's onCollapse / onExpand callbacks will fire as side effects
  // and bring the chat/editor/previewCollapsed flags back in sync — which
  // in turn drives the per-pane sync useEffect harmlessly (already-correct
  // state means no-op collapse/expand).
  const maximizePane = useCallback(
    (
      which: 'chat' | 'editor' | 'preview' | 'ui-surfaces',
      restore: boolean,
    ): void => {
      const group = panelGroupRef.current;
      // 4-pane layout: chat | editor | preview | ui-surfaces.
      // Restore default keeps ui-surfaces collapsed at 3% — matches
      // the initial-mount default. Maximize one = collapse the other three.
      if (restore) {
        group?.setLayout([30, 32, 32, 6]);
        setChatCollapsed(false);
        setEditorCollapsed(false);
        setPreviewCollapsed(false);
        setUiSurfacesCollapsed(true);
        return;
      }
      const layout =
        which === 'chat'
          ? [91, 3, 3, 3]
          : which === 'editor'
            ? [3, 91, 3, 3]
            : which === 'preview'
              ? [3, 3, 91, 3]
              : [3, 3, 3, 91];
      group?.setLayout(layout);
      setChatCollapsed(which !== 'chat');
      setEditorCollapsed(which !== 'editor');
      setPreviewCollapsed(which !== 'preview');
      setUiSurfacesCollapsed(which !== 'ui-surfaces');
    },
    [],
  );

  // Option-C, C-2: shared "Fix mit Builder"-trigger reused by both error
  // surfaces. BuildStatusStrip (build_status:failed) and RuntimeSmokeStrip
  // (runtime_smoke_status:failed) compose a fix prompt via composeFixPrompt
  // and call this helper to inject + auto-submit it through the same
  // pendingChatInput bridge SlotEditor's "Frag den Agent"-Button already
  // uses. Auto-submit so the operator only confirms by clicking the
  // button — no extra Senden-click.
  const triggerFixWithBuilder = useCallback(
    (text: string) => {
      setPendingChatInput({ text, autoSubmit: true });
      setChatCollapsed(false);
      if (!isDesktop) setMobilePane('chat');
    },
    [isDesktop],
  );

  // Template-slot manifest + buffered preview-secret keys — both feed
  // into the per-pane "missing required X" warning surfaces (collapsed-
  // rail dot, tab badges, header chip). Hoisted to the workspace so the
  // SlotEditor + the Editor's tab strip + the Preview pane all read the
  // same source of truth instead of each pane fetching independently.
  const [templateSlots, setTemplateSlots] = useState<TemplateSlotDef[]>([]);
  const [bufferedSecretKeys, setBufferedSecretKeys] = useState<string[]>([]);
  // Stable callback refs for child components — without these the inline
  // arrow forms got recreated on every Workspace render, and PreviewChatPane's
  // bootstrap-effect (with onBufferedSecretKeysChange in its dep array) fired
  // on every render, GET /preview/secrets in a tight loop (~500 req/sec
  // observed in dev). Same fix-shape applies to onClearAgentStuck below.
  const handleBufferedSecretKeysChange = useCallback(
    (keys: readonly string[]) => setBufferedSecretKeys([...keys]),
    [],
  );
  const handleClearAgentStuck = useCallback(() => setAgentStuck(null), []);
  // Template catalog (B.6-9). Fetched once per workspace mount; the
  // Switcher in the header populates from this list.
  const [templates, setTemplates] = useState<BuilderTemplateInfo[]>([]);

  useEffect(() => {
    let alive = true;
    void getTemplateSlots(draft.id)
      .then((res) => {
        if (alive) setTemplateSlots(res.slots);
      })
      .catch(() => {
        // Non-fatal — workspace just won't show the warning indicators.
      });
    return () => {
      alive = false;
    };
  }, [draft.id]);

  useEffect(() => {
    let alive = true;
    void getPreviewSecretsStatus(draft.id)
      .then((res) => {
        if (alive) setBufferedSecretKeys(res.keys);
      })
      .catch(() => {
        // ignore
      });
    return () => {
      alive = false;
    };
  }, [draft.id]);

  // Re-hydrate buildStatus on mount: page reload loses the SSE event
  // stream, but the preview-cache may still hold a successful build.
  // Without this, installEnabled is stuck on 'phase=idle' until the
  // user manually clicks Rebuild.
  useEffect(() => {
    let alive = true;
    void getPreviewStatus(draft.id)
      .then((res) => {
        if (!alive) return;
        if (res.phase === 'ok' && res.buildN !== undefined) {
          setBuildStatus({ phase: 'ok', buildN: res.buildN });
        }
      })
      .catch(() => {
        // ignore — falls back to 'idle'
      });
    return () => {
      alive = false;
    };
  }, [draft.id]);

  useEffect(() => {
    let alive = true;
    void listBuilderTemplates()
      .then((res) => {
        if (alive) setTemplates(res.templates);
      })
      .catch(() => {
        // Non-fatal — switcher just renders without a list and disables.
      });
    return () => {
      alive = false;
    };
  }, []);
  const refetchPendingRef = useRef<number | null>(null);

  // Coalesce bursts of bus events inside a 250ms window before re-fetching
  // the draft. The BuilderAgent often emits several patches in a row inside
  // one tool-call, and the inline-editor likewise dispatches a batched
  // PATCH; either way we want one fetch per burst, not N. Re-fetch keeps
  // the frontend thin (server stays the source of truth) instead of
  // re-implementing the JSON-Patch applier client-side.
  const scheduleRefetch = useCallback((): void => {
    if (refetchPendingRef.current !== null) return;
    const id = window.setTimeout(() => {
      refetchPendingRef.current = null;
      void getBuilderDraft(initialDraft.id)
        .then((env) => {
          setDraft(env.draft);
        })
        .catch(() => {
          // Re-fetch failures are non-fatal — the bus event already told the
          // user the mutation happened; we just leave the editor pane state
          // stale until the next event lands.
        });
    }, 250);
    refetchPendingRef.current = id;
  }, [initialDraft.id]);

  useEffect(() => {
    return () => {
      if (refetchPendingRef.current !== null) {
        window.clearTimeout(refetchPendingRef.current);
      }
    };
  }, []);

  // SSE subscription to the per-draft SpecEventBus (B.5-4 + B.6-6). Both
  // agent-cause (BuilderAgent tool calls) and user-cause (inline-editor
  // PATCH from this tab OR a sibling tab) events flow through here, so the
  // BuilderChatPane no longer needs to also drive re-fetch — we listen to
  // one canonical stream instead. `build_status` events from the rebuild
  // scheduler (B.6-6) get routed straight into the existing setBuildStatus
  // sink so the workspace header shows live status for out-of-band rebuilds.
  useSpecEvents(
    draft.id,
    (ev) => {
      if (ev.type === 'build_status') {
        const snap: BuildStatusSnapshot = { phase: ev.phase };
        if (ev.buildN !== undefined) snap.buildN = ev.buildN;
        if (ev.errorCount !== undefined) snap.errorCount = ev.errorCount;
        if (ev.reason !== undefined) snap.reason = ev.reason;
        if (ev.errors !== undefined) snap.errors = ev.errors;
        setBuildStatus(snap);
        // Clear the transient auto-fix-running pill once a new build
        // event fires — either the auto-fix turn produced an ok build
        // (resolution) or another failure (the orchestrator will fire
        // again or stop). Sticky `stopped_loop` survives so the operator
        // sees it even after a subsequent rebuild.
        setAutoFix((prev) =>
          prev && prev.phase === 'triggered' ? null : prev,
        );
        return;
      }
      if (ev.type === 'auto_fix_status') {
        setAutoFix({
          phase: ev.phase,
          kind: ev.kind,
          buildN: ev.buildN,
          ...(ev.identicalCount !== undefined
            ? { identicalCount: ev.identicalCount }
            : {}),
        });
        return;
      }
      if (ev.type === 'agent_stuck') {
        // B.7-6: stash the stuck state for the PreviewChatPane banner.
        // Don't refetch — no draft data has changed.
        setAgentStuck({
          slotKey: ev.slotKey,
          attempts: ev.attempts,
          lastReason: ev.lastReason,
          lastSummary: ev.lastSummary,
          lastErrorCount: ev.lastErrorCount,
        });
        return;
      }
      if (ev.type === 'runtime_smoke_status') {
        // B.9-4: Update preview-pane indicator. Latest event wins.
        setRuntimeSmoke({
          phase: ev.phase,
          buildN: ev.buildN,
          ...(ev.reason !== undefined ? { reason: ev.reason } : {}),
          ...(ev.activateError !== undefined ? { activateError: ev.activateError } : {}),
          ...(ev.results !== undefined ? { results: ev.results } : {}),
        });
        return;
      }
      if (ev.type === 'slot_patch') {
        // Auto-clear the stuck banner if the agent (or user) finally
        // patched the slot we were stuck on.
        setAgentStuck((prev) =>
          prev && prev.slotKey === ev.slotKey ? null : prev,
        );
      }
      scheduleRefetch();
    },
    { onStatus: setBusStatus },
  );

  // Derived warning counts. These drive the badges on the editor tabs +
  // the per-pane warning chip / collapsed-rail dot so the user sees at a
  // glance which menu has unfinished business — no "test the preview
  // first and then discover three required slots are empty" anti-loop.
  const filledSlotKeys = Object.keys(draft.slots);
  const missingRequiredSlots = templateSlots.filter(
    (s) => s.required && !filledSlotKeys.includes(s.key),
  ).length;

  const declaredSetupFields = draft.spec.setup_fields ?? [];
  const missingRequiredCredentials = declaredSetupFields.filter(
    (f) => f.required && !bufferedSecretKeys.includes(f.key),
  ).length;

  // Editor pane aggregates its tabs' warnings — collapsed-rail + header
  // chip should fire if ANY tab has missing items.
  const editorWarnings: Record<EditorTab, number> = {
    overview: 0,
    spec: 0,
    slots: missingRequiredSlots,
    persona: 0,
    versions: 0,
  };
  const editorWarningTotal = Object.values(editorWarnings).reduce(
    (a, b) => a + b,
    0,
  );

  // Install-Diff-Modal (B.6-2 / M3). Enabled iff every required surface is
  // green: no missing slots, no missing setup-credentials, last build OK.
  // Server is the source of truth for ID-conflicts — we only surface a
  // pre-flight gate, not a pre-flight check.
  const [installModalOpen, setInstallModalOpen] = useState(false);

  // Template-Switcher is always enabled. Identity (id, name, description,
  // skill, playbook, setup_fields, network.outbound) is template-agnostic
  // and survives the switch unchanged. Template-shape-specific fields
  // (slots, tools, depends_on) become unused by the new template's codegen
  // — they sit in the spec without effect until the operator either fills
  // the new template's equivalent slots or switches back. That's a
  // trade-off operators should be able to make mid-draft: an earlier
  // "only-when-empty" gate blocked exactly the case where switching is
  // most useful (operator realises after some Builder chat that they
  // picked the wrong shape).
  const isDraftSwitchable = true;

  // Sync collapsed-state → Panel API (B.6-4). The Panel's autoSaveId
  // restores the user's last drag-resized layout from localStorage on
  // mount; this effect then enforces the per-pane collapsed flag so the
  // rail-button gesture wins over a stale persisted size. Calling
  // collapse()/expand() is a no-op when the panel is already in the
  // requested state, so this is safe to run on every state change.
  useEffect(() => {
    const r = chatPanelRef.current;
    if (!r) return;
    if (chatCollapsed) r.collapse();
    else r.expand();
  }, [chatCollapsed]);
  useEffect(() => {
    const r = editorPanelRef.current;
    if (!r) return;
    if (editorCollapsed) r.collapse();
    else r.expand();
  }, [editorCollapsed]);
  useEffect(() => {
    const r = previewPanelRef.current;
    if (!r) return;
    if (previewCollapsed) r.collapse();
    else r.expand();
  }, [previewCollapsed]);
  useEffect(() => {
    const r = uiSurfacesPanelRef.current;
    if (!r) return;
    if (uiSurfacesCollapsed) r.collapse();
    else r.expand();
  }, [uiSurfacesCollapsed]);
  const installEnabled =
    editorWarningTotal === 0 &&
    missingRequiredCredentials === 0 &&
    buildStatus.phase === 'ok';

  return (
    <main className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 px-4 py-6 lg:px-6 lg:py-8 2xl:max-w-[1900px] 3xl:max-w-[2300px]">
      <WorkspaceHeader
        draft={draft}
        installEnabled={installEnabled}
        installDisabledReason={
          buildStatus.phase !== 'ok'
            ? 'Letzter Build muss erfolgreich sein'
            : editorWarningTotal > 0
              ? `${String(editorWarningTotal)} Editor-Warnung${
                  editorWarningTotal === 1 ? '' : 'en'
                }`
              : missingRequiredCredentials > 0
                ? `${String(missingRequiredCredentials)} fehlende Test-Credential${
                    missingRequiredCredentials === 1 ? '' : 's'
                  }`
                : null
        }
        onInstallClick={() => setInstallModalOpen(true)}
        templates={templates}
        currentTemplate={draft.spec.template ?? 'agent-integration'}
        templateSwitchEnabled={isDraftSwitchable}
        onTemplateChange={async (next) => {
          try {
            const env = await patchBuilderSpec(draft.id, [
              { op: 'replace', path: '/template', value: next },
            ]);
            setDraft(env.draft);
          } catch {
            // Non-fatal — the dropdown stays on the new value visually
            // until the next refetch reverts it; the SSE bus will fire
            // a spec_patch event on success and trigger a refetch.
          }
        }}
        autoFixEnabled={
          draft.spec.builder_settings?.auto_fix_enabled ?? false
        }
        onAutoFixToggle={async (next) => {
          try {
            const env = await patchBuilderSpec(draft.id, [
              {
                op: 'add',
                path: '/builder_settings',
                value: { auto_fix_enabled: next },
              },
            ]);
            setDraft(env.draft);
          } catch {
            // Non-fatal — toggle reverts on next refetch via the SSE bus.
          }
        }}
        onCodegenModelChange={async (next) => {
          try {
            const env = await patchBuilderModel(draft.id, {
              codegenModel: next,
            });
            setDraft(env.draft);
          } catch {
            // Non-fatal — selector reverts visually on next refetch.
          }
        }}
        onPreviewModelChange={async (next) => {
          try {
            const env = await patchBuilderModel(draft.id, {
              previewModel: next,
            });
            setDraft(env.draft);
          } catch {
            // Non-fatal — selector reverts visually on next refetch.
          }
        }}
      />

      <InstallDiffModal
        draft={draft}
        open={installModalOpen}
        onClose={() => setInstallModalOpen(false)}
      />

      {autoFix ? (
        <AutoFixIndicator
          snap={autoFix}
          onDismiss={() => setAutoFix(null)}
        />
      ) : null}

      {/* Pane content — extracted as local renderers so desktop (PanelGroup)
          and mobile (single pane + tabs) layouts share the exact same
          component tree. Mobile keeps all 3 mounted via display:none so
          SSE / Monaco state survives tab switches. */}
      {(() => {
        const chatPaneBody = (
          <BuilderChatPane
            draftId={draft.id}
            model={draft.codegenModel}
            initialTranscript={draft.transcript}
            pendingInput={pendingChatInput}
            onPendingInputConsumed={() => setPendingChatInput(null)}
          />
        );
        const editorPaneBody = (
          <>
            {tab === 'overview' && (
              <div className="overflow-y-auto">
                <SpecOverview spec={draft.spec} slots={draft.slots} />
              </div>
            )}
            {tab === 'spec' && (
              <div className="overflow-y-auto">
                <SpecEditor
                  draftId={draft.id}
                  spec={draft.spec}
                  agentStuck={agentStuck}
                />
              </div>
            )}
            {tab === 'slots' && (
              <SlotEditor
                draftId={draft.id}
                slots={draft.slots}
                templateSlots={templateSlots}
                buildErrors={buildStatus.errors}
                onPrefillBuilderChat={(prompt, opts) => {
                  setPendingChatInput({
                    text: prompt,
                    autoSubmit: opts?.autoSubmit ?? false,
                  });
                  setChatCollapsed(false);
                  if (!isDesktop) setMobilePane('chat');
                }}
              />
            )}
            {tab === 'persona' && (
              <div className="overflow-y-auto">
                <PersonaPillar
                  draftId={draft.id}
                  initialPersona={draft.spec.persona ?? {}}
                  {...(draft.spec.quality ? { quality: draft.spec.quality } : {})}
                  onPersisted={(next) => {
                    setDraft((prev) => ({
                      ...prev,
                      spec: { ...prev.spec, persona: next },
                    }));
                  }}
                />
              </div>
            )}
            {tab === 'versions' && <VersionsTab draftId={draft.id} />}
          </>
        );
        const previewPaneBody = (
          <PreviewChatPane
            draftId={draft.id}
            initialTranscript={draft.previewTranscript}
            setupFields={draft.spec.setup_fields ?? []}
            onBuildStatus={setBuildStatus}
            agentStuck={agentStuck}
            onClearAgentStuck={handleClearAgentStuck}
            runtimeSmoke={runtimeSmoke}
            onFixSmokeWithBuilder={
              runtimeSmoke && runtimeSmoke.phase === 'failed'
                ? () =>
                    triggerFixWithBuilder(
                      composeFixPrompt({
                        kind: 'smoke_failed',
                        buildN: runtimeSmoke.buildN,
                        smokeResults: runtimeSmoke.results,
                      }),
                    )
                : undefined
            }
            onBufferedSecretKeysChange={handleBufferedSecretKeysChange}
          />
        );

        if (isDesktop) {
          return (
            <LayoutGroup>
              <PanelGroup
                ref={panelGroupRef}
                direction="horizontal"
                autoSaveId="builder-workspace-panes-v2"
                className="flex min-h-[640px] gap-0"
                style={{ height: 'calc(100vh - 240px)' }}
              >
                <Panel
                  id="chat"
                  order={1}
                  ref={chatPanelRef}
                  collapsible
                  collapsedSize={3}
                  minSize={18}
                  defaultSize={30}
                  onCollapse={() => setChatCollapsed(true)}
                  onExpand={() => setChatCollapsed(false)}
                  className="flex"
                >
                  <PaneCard
                    index="01"
                    title="Builder-Chat"
                    meta={<ChatMeta />}
                    fill
                    collapsed={chatCollapsed}
                    onToggleCollapsed={() => setChatCollapsed((c) => !c)}
                    onMaximize={() => {
                      const isMax =
                        !chatCollapsed &&
                        editorCollapsed &&
                        previewCollapsed &&
                        uiSurfacesCollapsed;
                      maximizePane('chat', isMax);
                    }}
                    isMaximized={
                      !chatCollapsed &&
                      editorCollapsed &&
                      previewCollapsed &&
                      uiSurfacesCollapsed
                    }
                  >
                    {chatPaneBody}
                  </PaneCard>
                </Panel>

                <ResizeHandle />

                <Panel
                  id="editor"
                  order={2}
                  ref={editorPanelRef}
                  collapsible
                  collapsedSize={3}
                  minSize={18}
                  defaultSize={32}
                  onCollapse={() => setEditorCollapsed(true)}
                  onExpand={() => setEditorCollapsed(false)}
                  className="flex"
                >
                  <PaneCard
                    index="02"
                    title="Editor"
                    meta={
                      <EditorTabs
                        current={tab}
                        onChange={setTab}
                        warnings={editorWarnings}
                      />
                    }
                    warningCount={editorWarningTotal}
                    fill
                    collapsed={editorCollapsed}
                    onToggleCollapsed={() => setEditorCollapsed((c) => !c)}
                    onMaximize={() => {
                      const isMax =
                        !editorCollapsed &&
                        chatCollapsed &&
                        previewCollapsed &&
                        uiSurfacesCollapsed;
                      maximizePane('editor', isMax);
                    }}
                    isMaximized={
                      !editorCollapsed &&
                      chatCollapsed &&
                      previewCollapsed &&
                      uiSurfacesCollapsed
                    }
                  >
                    {editorPaneBody}
                  </PaneCard>
                </Panel>

                <ResizeHandle />

                <Panel
                  id="preview"
                  order={3}
                  ref={previewPanelRef}
                  collapsible
                  collapsedSize={3}
                  minSize={18}
                  defaultSize={32}
                  onCollapse={() => setPreviewCollapsed(true)}
                  onExpand={() => setPreviewCollapsed(false)}
                  className="flex"
                >
                  <PaneCard
                    index="03"
                    title="Preview"
                    meta={<PreviewMeta model={draft.previewModel} />}
                    warningCount={missingRequiredCredentials}
                    fill
                    collapsed={previewCollapsed}
                    onToggleCollapsed={() => setPreviewCollapsed((c) => !c)}
                    onMaximize={() => {
                      const isMax =
                        !previewCollapsed &&
                        chatCollapsed &&
                        editorCollapsed &&
                        uiSurfacesCollapsed;
                      maximizePane('preview', isMax);
                    }}
                    isMaximized={
                      !previewCollapsed &&
                      chatCollapsed &&
                      editorCollapsed &&
                      uiSurfacesCollapsed
                    }
                  >
                    {previewPaneBody}
                  </PaneCard>
                </Panel>

                <ResizeHandle />

                <Panel
                  id="ui-surfaces"
                  order={4}
                  ref={uiSurfacesPanelRef}
                  collapsible
                  collapsedSize={3}
                  minSize={18}
                  defaultSize={6}
                  onCollapse={() => setUiSurfacesCollapsed(true)}
                  onExpand={() => setUiSurfacesCollapsed(false)}
                  className="flex"
                >
                  <PaneCard
                    index="04"
                    title="UI-Surfaces"
                    fill
                    collapsed={uiSurfacesCollapsed}
                    onToggleCollapsed={() =>
                      setUiSurfacesCollapsed((c) => !c)
                    }
                    onMaximize={() => {
                      const isMax =
                        !uiSurfacesCollapsed &&
                        chatCollapsed &&
                        editorCollapsed &&
                        previewCollapsed;
                      maximizePane('ui-surfaces', isMax);
                    }}
                    isMaximized={
                      !uiSurfacesCollapsed &&
                      chatCollapsed &&
                      editorCollapsed &&
                      previewCollapsed
                    }
                  >
                    <UiSurfacesTabPane
                      draftId={draft.id}
                      spec={draft.spec}
                      draftSlots={draft.slots ?? {}}
                    />
                  </PaneCard>
                </Panel>
              </PanelGroup>
            </LayoutGroup>
          );
        }

        // Mobile: tab nav + single visible pane. All 3 stay mounted via
        // hidden classes so SSE / Monaco state survives tab switches.
        return (
          <div
            className="flex min-h-[600px] flex-col"
            style={{ height: 'calc(100vh - 240px)' }}
          >
            <MobilePaneTabs
              active={mobilePane}
              onChange={setMobilePane}
              warnings={{
                chat: 0,
                editor: editorWarningTotal,
                preview: missingRequiredCredentials,
                'ui-surfaces': 0,
              }}
            />
            <div className="flex min-h-0 flex-1 flex-col">
              <div
                className={cn(
                  'flex min-h-0 flex-1 flex-col',
                  mobilePane === 'chat' ? '' : 'hidden',
                )}
              >
                <PaneCard
                  index="01"
                  title="Builder-Chat"
                  meta={<ChatMeta />}
                  fill
                  collapsed={false}
                  onToggleCollapsed={() => setMobilePane('chat')}
                >
                  {chatPaneBody}
                </PaneCard>
              </div>
              <div
                className={cn(
                  'flex min-h-0 flex-1 flex-col',
                  mobilePane === 'editor' ? '' : 'hidden',
                )}
              >
                <PaneCard
                  index="02"
                  title="Editor"
                  meta={
                    <EditorTabs
                      current={tab}
                      onChange={setTab}
                      warnings={editorWarnings}
                    />
                  }
                  warningCount={editorWarningTotal}
                  fill
                  collapsed={false}
                  onToggleCollapsed={() => setMobilePane('editor')}
                >
                  {editorPaneBody}
                </PaneCard>
              </div>
              <div
                className={cn(
                  'flex min-h-0 flex-1 flex-col',
                  mobilePane === 'preview' ? '' : 'hidden',
                )}
              >
                <PaneCard
                  index="03"
                  title="Preview"
                  meta={<PreviewMeta model={draft.previewModel} />}
                  warningCount={missingRequiredCredentials}
                  fill
                  collapsed={false}
                  onToggleCollapsed={() => setMobilePane('preview')}
                >
                  {previewPaneBody}
                </PaneCard>
              </div>
              <div
                className={cn(
                  'flex min-h-0 flex-1 flex-col',
                  mobilePane === 'ui-surfaces' ? '' : 'hidden',
                )}
              >
                <PaneCard
                  index="04"
                  title="UI-Surfaces"
                  fill
                  collapsed={false}
                  onToggleCollapsed={() => setMobilePane('ui-surfaces')}
                >
                  <UiSurfacesTabPane
                    draftId={draft.id}
                    spec={draft.spec}
                    draftSlots={draft.slots ?? {}}
                  />
                </PaneCard>
              </div>
            </div>
          </div>
        );
      })()}

      <BuildStatusStrip
        busStatus={busStatus}
        buildStatus={buildStatus}
        onFixWithBuilder={
          buildStatus.phase === 'failed'
            ? () =>
                triggerFixWithBuilder(
                  composeFixPrompt({
                    kind: 'build_failed',
                    buildN: buildStatus.buildN,
                    reason: buildStatus.reason,
                    errors: buildStatus.errors,
                  }),
                )
            : undefined
        }
      />
    </main>
  );
}

// ---------------------------------------------------------------------------
// Mobile pane tabs (B.6-5)
// ---------------------------------------------------------------------------

/**
 * Tab strip for the mobile (`< 1280px`) workspace. Three pills — Builder-
 * Chat / Editor / Preview — each surfacing the same red warning-count
 * badge as the desktop collapsed-rail dot so the operator never has to
 * switch tabs to discover unfinished business.
 */
function MobilePaneTabs({
  active,
  onChange,
  warnings,
}: {
  active: MobilePane;
  onChange: (next: MobilePane) => void;
  warnings: Record<MobilePane, number>;
}): React.ReactElement {
  const items: Array<{ id: MobilePane; label: string; index: string }> = [
    { id: 'chat', label: 'Chat', index: '01' },
    { id: 'editor', label: 'Editor', index: '02' },
    { id: 'preview', label: 'Preview', index: '03' },
    { id: 'ui-surfaces', label: 'UI', index: '04' },
  ];
  return (
    <nav
      role="tablist"
      aria-label="Workspace-Pane wählen"
      className="mb-3 flex items-center gap-1.5 overflow-x-auto rounded-[12px] border border-[color:var(--divider)] bg-[color:var(--bg-elevated)] p-1.5"
    >
      {items.map((it) => {
        const isActive = it.id === active;
        const w = warnings[it.id];
        return (
          <button
            key={it.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(it.id)}
            className={cn(
              'inline-flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-2',
              'text-[12px] font-semibold uppercase tracking-[0.18em] transition-colors',
              isActive
                ? 'bg-[color:var(--accent)] text-white shadow-[var(--shadow-cta)]'
                : 'text-[color:var(--fg-muted)] hover:bg-[color:var(--bg-soft)] hover:text-[color:var(--fg-strong)]',
              w > 0 && !isActive && 'text-[color:var(--danger)]',
            )}
          >
            <span className="font-mono-num text-[10px] opacity-70">{it.index}</span>
            {it.label}
            {w > 0 ? (
              <span
                className={cn(
                  'font-mono-num inline-flex min-w-[1rem] items-center justify-center rounded-full px-1 text-[10px] font-semibold',
                  isActive
                    ? 'bg-white/25 text-white'
                    : 'bg-[color:var(--danger)] text-white',
                )}
                aria-label={`${String(w)} Pflicht-Felder fehlen`}
              >
                {w}
              </span>
            ) : null}
          </button>
        );
      })}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Resize handle (B.6-4)
// ---------------------------------------------------------------------------

/**
 * Visual chrome for the drag-resize handle between Workspace panes.
 * 4px wide; expands and shifts to the brand accent on hover so the user
 * spots the gesture without it dominating the layout in idle. Touch-target
 * is enlarged via padding so trackpad-only operators can still grab it.
 */
function ResizeHandle(): React.ReactElement {
  return (
    <PanelResizeHandle className="group relative w-1 cursor-col-resize bg-transparent transition-colors data-[resize-handle-state=hover]:bg-[color:var(--accent)]/40 data-[resize-handle-state=drag]:bg-[color:var(--accent)]">
      <span
        aria-hidden
        className="absolute inset-y-0 -inset-x-1 group-hover:bg-[color:var(--accent)]/0"
      />
    </PanelResizeHandle>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function WorkspaceHeader({
  draft,
  installEnabled,
  installDisabledReason,
  onInstallClick,
  templates,
  currentTemplate,
  templateSwitchEnabled,
  onTemplateChange,
  autoFixEnabled,
  onAutoFixToggle,
  onCodegenModelChange,
  onPreviewModelChange,
}: {
  draft: Draft;
  installEnabled: boolean;
  installDisabledReason: string | null;
  onInstallClick: () => void;
  templates: BuilderTemplateInfo[];
  currentTemplate: string;
  templateSwitchEnabled: boolean;
  onTemplateChange: (next: string) => void | Promise<void>;
  autoFixEnabled: boolean;
  onAutoFixToggle: (next: boolean) => void | Promise<void>;
  onCodegenModelChange: (next: BuilderModelId) => void | Promise<void>;
  onPreviewModelChange: (next: BuilderModelId) => void | Promise<void>;
}): React.ReactElement {
  // John feedback 2026-05-06: model switch is a pure metadata change
  // for the next codegen run and independent of the
  // Edit-from-Store-Reopen loop (B.6-3) — therefore allowed for installed
  // drafts as well. Only `archived` stays read-only (frozen state).
  const modelEditingEnabled = draft.status !== 'archived';
  return (
    <header className="flex flex-col gap-4 rounded-[14px] border border-[color:var(--divider)] bg-[color:var(--bg-elevated)] px-5 py-4 lg:flex-row lg:items-center">
      <Link
        href="/store/builder"
        className="inline-flex items-center gap-2 self-start rounded-md px-2 py-1 text-[12px] font-semibold uppercase tracking-[0.18em] text-[color:var(--fg-muted)] transition-colors hover:bg-[color:var(--bg-soft)] hover:text-[color:var(--fg-strong)]"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Drafts
      </Link>

      <div className="flex min-w-0 flex-1 items-baseline gap-3">
        <h1 className="font-display truncate text-[26px] leading-none text-[color:var(--fg-strong)]">
          {draft.name}
        </h1>
        <StatusBadge status={draft.status} />
      </div>

      <dl className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px]">
        <TemplateSwitcher
          templates={templates}
          current={currentTemplate}
          enabled={templateSwitchEnabled}
          onChange={onTemplateChange}
        />
        <ModelSelector
          label="Codegen"
          value={draft.codegenModel}
          enabled={modelEditingEnabled}
          onChange={onCodegenModelChange}
        />
        <ModelSelector
          label="Preview"
          value={draft.previewModel}
          enabled={modelEditingEnabled}
          onChange={onPreviewModelChange}
        />
        <AutoFixToggle enabled={autoFixEnabled} onChange={onAutoFixToggle} />
        <span className="font-mono-num text-[color:var(--fg-subtle)]">
          ID: {draft.id.slice(0, 8)}
        </span>
      </dl>

      <button
        type="button"
        onClick={installEnabled ? onInstallClick : undefined}
        disabled={!installEnabled}
        title={installDisabledReason ?? undefined}
        className={cn(
          'inline-flex items-center gap-2 rounded-md px-4 py-2 text-[12px] font-semibold uppercase tracking-[0.18em] transition-opacity',
          installEnabled
            ? 'bg-[color:var(--accent)] text-white shadow-[var(--shadow-cta)] hover:opacity-90'
            : 'cursor-not-allowed bg-[color:var(--bg-soft)] text-[color:var(--fg-subtle)]',
        )}
      >
        <Rocket className="size-3.5" aria-hidden />
        Installieren
      </button>
    </header>
  );
}

function StatusBadge({ status }: { status: Draft['status'] }): React.ReactElement {
  const palette: Record<Draft['status'], string> = {
    draft: 'bg-[color:var(--bg-soft)] text-[color:var(--fg-muted)]',
    installed: 'bg-[color:var(--accent)]/12 text-[color:var(--accent)]',
    archived: 'bg-[color:var(--gray-100)] text-[color:var(--fg-subtle)]',
  };
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.16em]',
        palette[status],
      )}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

/**
 * Interactive model selector for codegen / preview model. Renders the
 * same label-on-left + value-on-right typography as the legacy ModelChip
 * but the value is a native `<select>` with a chevron, so operators can
 * switch models per draft without leaving the workspace header.
 *
 * - `enabled=false` (installed/archived drafts) renders read-only text
 *   to match the historic ModelChip behaviour.
 * - `onChange` is fire-and-forget (Promise return); failures revert the
 *   selector visually on the next SSE-triggered refetch (same pattern
 *   als `TemplateSwitcher` + `AutoFixToggle`).
 */
function ModelSelector({
  label,
  value,
  enabled,
  onChange,
}: {
  label: string;
  value: BuilderModelId;
  enabled: boolean;
  onChange: (next: BuilderModelId) => void | Promise<void>;
}): React.ReactElement {
  if (!enabled) {
    return (
      <div className="flex items-baseline gap-1.5">
        <dt className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[color:var(--fg-subtle)]">
          {label}
        </dt>
        <dd className="font-mono-num text-[12px] font-semibold text-[color:var(--fg-strong)]">
          {MODEL_LABEL[value]}
        </dd>
      </div>
    );
  }
  return (
    <label className="flex items-baseline gap-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[color:var(--fg-subtle)]">
        {label}
      </span>
      <span className="relative inline-flex items-center">
        <select
          value={value}
          onChange={(e) => {
            const next = e.target.value as BuilderModelId;
            void onChange(next);
          }}
          className={cn(
            'cursor-pointer appearance-none rounded-md border border-[color:var(--divider)] bg-[color:var(--bg-soft)] py-0.5 pl-2 pr-6',
            'font-mono-num text-[12px] font-semibold text-[color:var(--fg-strong)]',
            'transition-colors hover:bg-[color:var(--bg-elevated)] focus:outline-none focus:ring-1 focus:ring-[color:var(--accent)]',
          )}
          aria-label={`${label}-Modell wechseln`}
        >
          <option value="haiku">{MODEL_LABEL.haiku}</option>
          <option value="sonnet">{MODEL_LABEL.sonnet}</option>
          <option value="opus">{MODEL_LABEL.opus}</option>
        </select>
        <span
          aria-hidden
          className="pointer-events-none absolute right-1.5 text-[10px] text-[color:var(--fg-subtle)]"
        >
          ▾
        </span>
      </span>
    </label>
  );
}


/**
 * AutoFix-Toggle (Option-C, C-3). Pure-frontend opt-in for the AutoFix-Loop:
 * when enabled, the C-4 backend AutoFixOrchestrator will fire a synthetic
 * Builder-turn after every build_status:failed / runtime_smoke_status:failed
 * with a composeFixPrompt() user message. Disabled by default — operator
 * decides per draft whether the loop should self-close.
 *
 * State is persisted in `spec.builder_settings.auto_fix_enabled` and
 * patched via `patchBuilderSpec(/builder_settings)`. Optimistic updates
 * happen via `setDraft(env.draft)` in the parent's onAutoFixToggle handler.
 */
function AutoFixToggle({
  enabled,
  onChange,
}: {
  enabled: boolean;
  onChange: (next: boolean) => void | Promise<void>;
}): React.ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      title={
        enabled
          ? 'Auto-Fix aktiv: Build/Smoke-Failures triggern automatisch einen Builder-Turn'
          : 'Auto-Fix aus: Failures zeigen nur den "Fix mit Builder"-Button'
      }
      onClick={() => {
        void onChange(!enabled);
      }}
      className="flex items-center gap-1.5"
    >
      <dt className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[color:var(--fg-subtle)]">
        Auto-Fix
      </dt>
      <dd
        className={cn(
          'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono-num text-[10px] font-semibold uppercase tracking-[0.18em] transition-colors',
          enabled
            ? 'border-[color:var(--accent)]/40 bg-[color:var(--accent)]/12 text-[color:var(--accent)]'
            : 'border-[color:var(--divider)] bg-[color:var(--bg-soft)] text-[color:var(--fg-subtle)] hover:bg-[color:var(--bg-elevated)]',
        )}
      >
        <span
          className={cn(
            'inline-block size-1.5 rounded-full',
            enabled ? 'bg-[color:var(--accent)]' : 'bg-[color:var(--fg-subtle)]',
          )}
        />
        {enabled ? 'on' : 'off'}
      </dd>
    </button>
  );
}

/**
 * AutoFix lifecycle indicator (Option-C, C-4).
 *
 *   `triggered`    — accent-coloured pill with a spinner: "Auto-Fix
 *                    läuft (#N · build/smoke)". Auto-clears on the
 *                    next build_status event in the parent's handler.
 *   `stopped_loop` — orange dismissable banner: "Auto-Fix nach 3
 *                    identischen Fehlern gestoppt — bitte manuell
 *                    eingreifen". The toggle was already PATCHed back
 *                    to `auto_fix_enabled: false` server-side so we
 *                    only need to surface the message; dismissing X
 *                    just hides the banner.
 */
function AutoFixIndicator({
  snap,
  onDismiss,
}: {
  snap: {
    phase: 'triggered' | 'stopped_loop';
    kind: 'build_failed' | 'smoke_failed';
    buildN: number;
    identicalCount?: number;
  };
  onDismiss: () => void;
}): React.ReactElement {
  const kindLabel = snap.kind === 'build_failed' ? 'Build' : 'Smoke';

  if (snap.phase === 'triggered') {
    return (
      <div className="inline-flex w-fit items-center gap-2 rounded-full border border-[color:var(--accent)]/40 bg-[color:var(--accent)]/10 px-3 py-1.5 text-[12px] text-[color:var(--accent)]">
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        <span className="font-mono-num text-[11px]">
          Auto-Fix läuft (#{String(snap.buildN)} · {kindLabel})
        </span>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2 rounded-md border border-[color:var(--warning)]/40 bg-[color:var(--warning)]/8 px-3 py-2 text-[12px] text-[color:var(--warning)]">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1 break-words">
        <div className="font-semibold">
          Auto-Fix nach {String(snap.identicalCount ?? 3)} identischen{' '}
          {kindLabel}-Fehlern gestoppt
        </div>
        <div className="mt-1 text-[11px] text-[color:var(--fg-muted)]">
          Der Builder-Agent kommt mit derselben Fehlerklasse nicht weiter.
          Auto-Fix wurde automatisch ausgeschaltet — prüf den Code manuell
          oder schalte den Toggle wieder ein, sobald du eingegriffen hast.
        </div>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="text-[color:var(--fg-subtle)] transition-colors hover:text-[color:var(--fg-strong)]"
        aria-label="Hinweis ausblenden"
      >
        <X className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}

function TemplateSwitcher({
  templates,
  current,
  enabled,
  onChange,
}: {
  templates: BuilderTemplateInfo[];
  current: string;
  enabled: boolean;
  onChange: (next: string) => void | Promise<void>;
}): React.ReactElement {
  // Always include the current template even if it's not in the fetched
  // list yet (e.g. a draft pinned to a template that's been removed
  // server-side). Renders with a strikethrough so the operator sees the
  // mismatch but can still pick something else.
  const options = templates.some((t) => t.id === current)
    ? templates
    : [
        { id: current, description: '(unbekanntes Template)' },
        ...templates,
      ];
  const tooltip = enabled
    ? 'Template wechseln (verlustfrei — nur Slots / Tools / depends_on sind template-spezifisch)'
    : 'Template-Wechsel deaktiviert — der Draft hat bereits Slots, Tools oder `depends_on`-Einträge, die beim Switch verloren gingen. Lege einen neuen Draft an oder lösche die betreffenden Felder zuerst.';
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[color:var(--fg-subtle)]">
        Template
      </dt>
      <dd>
        <select
          value={current}
          onChange={(e) => void onChange(e.target.value)}
          disabled={!enabled || options.length <= 1}
          title={tooltip}
          className={cn(
            'font-mono-num rounded-md border bg-[color:var(--bg)] px-2 py-0.5 text-[12px] font-semibold transition-colors',
            enabled
              ? 'border-[color:var(--border)] text-[color:var(--fg-strong)] hover:border-[color:var(--accent)]'
              : 'cursor-not-allowed border-[color:var(--divider)] text-[color:var(--fg-subtle)] opacity-70',
          )}
        >
          {options.map((t) => (
            <option key={t.id} value={t.id}>
              {t.id}
            </option>
          ))}
        </select>
      </dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editor tab strip
// ---------------------------------------------------------------------------

function EditorTabs({
  current,
  onChange,
  warnings,
}: {
  current: EditorTab;
  onChange: (next: EditorTab) => void;
  warnings?: Record<EditorTab, number>;
}): React.ReactElement {
  return (
    <div role="tablist" className="flex items-center gap-1">
      {(['overview', 'spec', 'slots', 'persona', 'versions'] as EditorTab[]).map((t) => {
        const active = t === current;
        const warningCount = warnings?.[t] ?? 0;
        return (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t)}
            className={cn(
              'inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] transition-colors',
              active
                ? 'bg-[color:var(--accent)] text-white'
                : 'text-[color:var(--fg-muted)] hover:bg-[color:var(--bg-soft)] hover:text-[color:var(--fg-strong)]',
              warningCount > 0 &&
                !active &&
                'text-[color:var(--danger)] hover:bg-[color:var(--danger)]/10',
            )}
          >
            {TAB_LABEL[t]}
            {warningCount > 0 ? (
              <span
                className={cn(
                  'font-mono-num inline-flex min-w-[1rem] items-center justify-center rounded-full px-1 text-[10px] font-semibold',
                  active
                    ? 'bg-white/25 text-white'
                    : 'bg-[color:var(--danger)] text-white',
                )}
                aria-label={`${String(warningCount)} fehlt`}
              >
                {warningCount}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pane meta-row helpers
// ---------------------------------------------------------------------------

function ChatMeta(): React.ReactElement {
  return (
    <span className="font-mono-num inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] text-[color:var(--fg-subtle)]">
      <MessageSquare className="size-3" aria-hidden />
      NDJSON
    </span>
  );
}

function PreviewMeta({
  model,
}: {
  model: BuilderModelId;
}): React.ReactElement {
  return (
    <span className="font-mono-num inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] text-[color:var(--fg-subtle)]">
      <Eye className="size-3" aria-hidden />
      {MODEL_LABEL[model]}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Pane placeholders (replaced in subsequent sub-commits)
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Build status footer
// ---------------------------------------------------------------------------

function BuildStatusStrip({
  busStatus,
  buildStatus,
  onFixWithBuilder,
}: {
  busStatus: 'open' | 'closed' | 'error';
  buildStatus: BuildStatusSnapshot;
  onFixWithBuilder?: () => void;
}): React.ReactElement {
  const [errorsExpanded, setErrorsExpanded] = useState(false);

  const busColor =
    busStatus === 'open'
      ? 'bg-[color:var(--success)]'
      : busStatus === 'error'
        ? 'bg-[color:var(--warning)]'
        : 'bg-[color:var(--fg-subtle)]';
  const busLabel =
    busStatus === 'open' ? 'live' : busStatus === 'error' ? 'reconnecting' : 'idle';

  const buildPalette: Record<BuildStatusSnapshot['phase'], string> = {
    idle: 'text-[color:var(--fg-subtle)]',
    building: 'text-[color:var(--accent)]',
    ok: 'text-[color:var(--success)]',
    failed: 'text-[color:var(--danger)]',
  };
  const buildLabel =
    buildStatus.phase === 'idle'
      ? 'idle'
      : buildStatus.phase === 'building'
        ? 'building'
        : buildStatus.phase === 'ok'
          ? `ok${buildStatus.buildN !== undefined ? ` #${String(buildStatus.buildN)}` : ''}`
          : `failed${buildStatus.errorCount ? ` (${String(buildStatus.errorCount)} err)` : ''}`;

  const errors = buildStatus.errors ?? [];
  const canExpand = buildStatus.phase === 'failed' && errors.length > 0;
  const showErrorList = canExpand && errorsExpanded;

  const buildPillClasses = cn(
    'font-mono-num inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.18em]',
    buildPalette[buildStatus.phase],
  );

  const buildPillIndicator =
    buildStatus.phase === 'building' ? (
      <span className="inline-block size-1.5 animate-pulse rounded-full bg-current" />
    ) : (
      <span className="inline-block size-1.5 rounded-full bg-current" />
    );

  return (
    <div className="flex flex-col gap-2">
      {showErrorList ? (
        <div
          id="builder-tsc-error-list"
          className="rounded-[14px] border border-[color:var(--danger)]/30 bg-[color:var(--bg-elevated)] px-5 py-3"
        >
          <div className="font-mono-num mb-2 flex items-center justify-between text-[10px] uppercase tracking-[0.18em] text-[color:var(--fg-subtle)]">
            <span>
              {String(errors.length)} TypeScript-Fehler
              {buildStatus.buildN !== undefined
                ? ` · build #${String(buildStatus.buildN)}`
                : ''}
            </span>
            <button
              type="button"
              onClick={() => setErrorsExpanded(false)}
              className="inline-flex items-center gap-1 rounded text-[color:var(--fg-subtle)] hover:text-[color:var(--fg-default)]"
              aria-label="Fehlerliste schließen"
            >
              <X className="size-3" aria-hidden />
            </button>
          </div>
          <ul className="font-mono-num max-h-[40vh] space-y-1.5 overflow-y-auto text-[11px] leading-relaxed text-[color:var(--fg-default)]">
            {errors.map((e, i) => (
              <li
                key={`${e.file}:${String(e.line)}:${String(e.column)}:${e.code}:${String(i)}`}
                className="break-words"
              >
                <span className="text-[color:var(--fg-muted)]">
                  {e.file}:{String(e.line)}:{String(e.column)}
                </span>{' '}
                <span className="text-[color:var(--danger)]">{e.code}</span>{' '}
                <span className="whitespace-pre-wrap">{e.message}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <footer className="flex items-center gap-3 rounded-[14px] border border-[color:var(--divider)] bg-[color:var(--bg-elevated)] px-5 py-3 text-[11px]">
        <span className="font-mono-num inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] text-[color:var(--fg-subtle)]">
          <Activity className="size-3" aria-hidden />
          Build-Status
        </span>
        {canExpand ? (
          <button
            type="button"
            onClick={() => setErrorsExpanded((v) => !v)}
            aria-expanded={errorsExpanded}
            aria-controls="builder-tsc-error-list"
            title={
              errorsExpanded
                ? 'Fehlerliste ausblenden'
                : 'Fehlerliste anzeigen'
            }
            className={cn(
              buildPillClasses,
              'rounded transition-colors hover:underline',
            )}
          >
            {buildPillIndicator}
            {buildLabel}
            {errorsExpanded ? (
              <ChevronUp className="size-3" aria-hidden />
            ) : (
              <ChevronDown className="size-3" aria-hidden />
            )}
          </button>
        ) : (
          <span className={buildPillClasses}>
            {buildPillIndicator}
            {buildLabel}
          </span>
        )}
        {buildStatus.reason ? (
          <span className="text-[color:var(--fg-muted)]">
            {buildStatus.reason}
          </span>
        ) : null}
        {onFixWithBuilder ? (
          <button
            type="button"
            onClick={onFixWithBuilder}
            className="inline-flex items-center gap-1.5 rounded-md border border-[color:var(--danger)]/40 bg-[color:var(--danger)]/10 px-2 py-1 font-mono-num text-[10px] uppercase tracking-[0.18em] text-[color:var(--danger)] transition-colors hover:bg-[color:var(--danger)]/15"
          >
            <Wrench className="size-3" aria-hidden />
            Fix mit Builder
          </button>
        ) : null}
        <span className="font-mono-num inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] text-[color:var(--fg-subtle)]">
          <span className={`inline-block size-1.5 rounded-full ${busColor}`} />
          SSE {busLabel}
        </span>
        <span className="ml-auto font-mono-num text-[color:var(--fg-subtle)]">
          Phase B.5 (Workspace-UI)
        </span>
      </footer>
    </div>
  );
}
