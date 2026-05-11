'use client';

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';

import {
  captureSnapshot,
  getSnapshotDiff,
  listSnapshots,
  markSnapshotDeployReady,
  rollbackSnapshot,
  snapshotDownloadUrl,
} from '../../../../_lib/api';
import type {
  AssetDiffEntry,
  SnapshotSummary,
} from '../../../../_lib/snapshotTypes';

/**
 * VersionsTab (OB-83 Slice 3).
 *
 * Builder-side surface for the Phase-2.2 snapshot lifecycle. Lists
 * snapshots for the active draft (`draftId == profileId` per OB-83
 * bridge invariant) and exposes capture / mark-deploy-ready / rollback /
 * download / diff actions.
 *
 * Brand-Constraints from `persona-ui-v1.md` §13:
 *   - State colours: `--accent` for primary, `--warning` for soft, `--danger`
 *     for destructive. NO Magenta on state — reserved for the b5-colon mark.
 *   - Pill-radius (`rounded-full`) only for status badges; cards use
 *     `--radius-md` (Tailwind `rounded-lg`/`rounded-md`).
 *
 * The component is deliberately framework-light: vanilla React state +
 * fetch through `_lib/api.ts`. No SWR / Tanstack Query; refresh on
 * mount, after each mutation, and via the explicit Refresh button.
 */

interface VersionsTabProps {
  draftId: string;
}

type LoadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; snapshots: SnapshotSummary[] }
  | { kind: 'error'; message: string };

export function VersionsTab({ draftId }: VersionsTabProps): React.ReactElement {
  const [state, setState] = useState<LoadState>({ kind: 'idle' });
  const [toast, setToast] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [diffSnapshot, setDiffSnapshot] = useState<SnapshotSummary | null>(null);
  const [rollbackTarget, setRollbackTarget] = useState<SnapshotSummary | null>(null);

  const showToast = useCallback((kind: 'info' | 'error', text: string) => {
    setToast({ kind, text });
    setTimeout(() => setToast(null), 2400);
  }, []);

  const refresh = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const res = await listSnapshots(draftId);
      setState({ kind: 'ready', snapshots: res.snapshots });
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [draftId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onMarkDeployReady = useCallback(
    async (snap: SnapshotSummary) => {
      try {
        await markSnapshotDeployReady(draftId, snap.snapshot_id);
        showToast('info', 'Marked deploy-ready');
        await refresh();
      } catch (err) {
        showToast('error', err instanceof Error ? err.message : String(err));
      }
    },
    [draftId, refresh, showToast],
  );

  return (
    <div className="flex h-full flex-col p-5 text-[var(--fg)]">
      <div className="mb-4 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setCaptureOpen(true)}
          className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
        >
          Snapshot erstellen
        </button>
        <button
          type="button"
          onClick={() => void refresh()}
          className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm hover:border-current"
        >
          Aktualisieren
        </button>
      </div>

      {state.kind === 'loading' && <p className="text-sm opacity-70">Lädt…</p>}
      {state.kind === 'error' && (
        <p className="text-sm text-[var(--danger)]">
          Konnte Snapshots nicht laden: {state.message}
        </p>
      )}
      {state.kind === 'ready' && state.snapshots.length === 0 && (
        <EmptyState />
      )}
      {state.kind === 'ready' && state.snapshots.length > 0 && (
        <SnapshotTable
          draftId={draftId}
          snapshots={state.snapshots}
          onDiff={setDiffSnapshot}
          onMark={onMarkDeployReady}
          onRollback={setRollbackTarget}
        />
      )}

      {captureOpen && (
        <CaptureModal
          draftId={draftId}
          onClose={() => setCaptureOpen(false)}
          onCaptured={async (msg) => {
            setCaptureOpen(false);
            showToast('info', msg);
            await refresh();
          }}
          onError={(msg) => showToast('error', msg)}
        />
      )}

      {diffSnapshot && (
        <DiffModal
          draftId={draftId}
          snapshot={diffSnapshot}
          onClose={() => setDiffSnapshot(null)}
        />
      )}

      {rollbackTarget && (
        <RollbackModal
          draftId={draftId}
          snapshot={rollbackTarget}
          onClose={() => setRollbackTarget(null)}
          onRolledBack={async (msg) => {
            setRollbackTarget(null);
            showToast('info', msg);
            await refresh();
          }}
          onError={(msg) => showToast('error', msg)}
        />
      )}

      {toast && (
        <div
          role="status"
          className={`pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-md px-4 py-2 text-sm ${
            toast.kind === 'error'
              ? 'bg-[var(--danger)] text-white'
              : 'bg-[var(--fg)] text-[var(--bg)]'
          }`}
        >
          {toast.text}
        </div>
      )}
    </div>
  );
}

function EmptyState(): React.ReactElement {
  return (
    <div className="rounded-lg border border-dashed border-[var(--border)] p-6 text-center text-sm opacity-70">
      Noch keine Snapshots. &bdquo;Snapshot erstellen&ldquo; hält den aktuellen
      Stand fest, damit du später dorthin zurückrollen kannst.
    </div>
  );
}

interface SnapshotTableProps {
  draftId: string;
  snapshots: SnapshotSummary[];
  onDiff: (s: SnapshotSummary) => void;
  onMark: (s: SnapshotSummary) => void;
  onRollback: (s: SnapshotSummary) => void;
}

function SnapshotTable({
  draftId,
  snapshots,
  onDiff,
  onMark,
  onRollback,
}: SnapshotTableProps): React.ReactElement {
  return (
    <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
      <table className="w-full text-sm">
        <thead className="bg-[var(--bg-soft)] text-xs uppercase tracking-wide opacity-70">
          <tr>
            <th className="px-3 py-2 text-left">Erstellt</th>
            <th className="px-3 py-2 text-left">Hash</th>
            <th className="px-3 py-2 text-left">Von</th>
            <th className="px-3 py-2 text-left">Notiz</th>
            <th className="px-3 py-2 text-left">Status</th>
          </tr>
        </thead>
        <tbody>
          {snapshots.map((s) => (
            // Each snapshot renders as TWO rows: a data row + an actions
            // row spanning all columns. This keeps the action buttons
            // horizontally laid out (instead of stacking vertically in a
            // narrow Aktionen column) regardless of viewport width.
            <Fragment key={s.snapshot_id}>
              <tr className="border-t border-[var(--border)] align-top">
                <td className="px-3 pt-2 whitespace-nowrap">
                  {new Date(s.created_at).toLocaleString()}
                </td>
                <td className="px-3 pt-2 font-mono text-xs">
                  {s.bundle_hash.slice(0, 12)}
                </td>
                <td className="px-3 pt-2">{s.created_by}</td>
                <td className="px-3 pt-2 max-w-xs truncate">{s.notes ?? '—'}</td>
                <td className="px-3 pt-2">
                  <StatusPills snapshot={s} />
                </td>
              </tr>
              <tr>
                <td colSpan={5} className="px-3 pb-3 pt-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <SmallButton onClick={() => onDiff(s)}>
                      Diff vs. Live
                    </SmallButton>
                    <SmallButton
                      onClick={() => onMark(s)}
                      disabled={s.is_deploy_ready}
                    >
                      Deploy-ready
                    </SmallButton>
                    <SmallButton danger onClick={() => onRollback(s)}>
                      Rollback
                    </SmallButton>
                    <a
                      href={snapshotDownloadUrl(draftId, s.snapshot_id)}
                      className="rounded-md border border-[var(--border)] px-2 py-1 text-xs hover:border-current"
                      download
                      title="Plugin-ZIP — direkt installierbar via /install/packages/upload (inkl. AGENT.md mit persona/quality)"
                    >
                      Plugin
                    </a>
                    <a
                      href={`${snapshotDownloadUrl(draftId, s.snapshot_id)}?format=bundle`}
                      className="rounded-md border border-[var(--border)] px-2 py-1 text-xs hover:border-current"
                      download
                      title="Profile-Bundle — für cross-instance-Migration via /api/v1/profiles/import-bundle"
                    >
                      Bundle
                    </a>
                  </div>
                </td>
              </tr>
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatusPills({ snapshot }: { snapshot: SnapshotSummary }): React.ReactElement {
  return (
    <div className="flex flex-wrap gap-1">
      {snapshot.is_deploy_ready ? (
        <span className="rounded-full border border-[var(--success)] bg-[color-mix(in_srgb,var(--success)_12%,transparent)] px-2 py-0.5 text-xs font-medium text-[var(--success)]">
          deploy-ready
        </span>
      ) : null}
    </div>
  );
}

interface SmallButtonProps {
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}

function SmallButton({
  children,
  onClick,
  danger,
  disabled,
}: SmallButtonProps): React.ReactElement {
  const base =
    'rounded-md px-2 py-1 text-xs hover:border-current disabled:opacity-50 disabled:cursor-not-allowed';
  const cls = danger
    ? `${base} border border-[var(--danger)] text-[var(--danger)]`
    : `${base} border border-[var(--border)]`;
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={cls}>
      {children}
    </button>
  );
}

interface CaptureModalProps {
  draftId: string;
  onClose: () => void;
  onCaptured: (msg: string) => void | Promise<void>;
  onError: (msg: string) => void;
}

function CaptureModal({
  draftId,
  onClose,
  onCaptured,
  onError,
}: CaptureModalProps): React.ReactElement {
  const [notes, setNotes] = useState('');
  const [vendor, setVendor] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      const body: { notes?: string; vendor?: boolean } = { vendor };
      const trimmed = notes.trim();
      if (trimmed.length > 0) body.notes = trimmed;
      const res = await captureSnapshot(draftId, body);
      await onCaptured(
        res.was_existing
          ? 'Kein Unterschied seit letztem Snapshot'
          : `Snapshot erstellt (${res.bundle_hash.slice(0, 12)})`,
      );
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell title="Snapshot erstellen" onClose={onClose}>
      <label className="block text-xs uppercase tracking-wide opacity-70">
        Notiz (optional)
      </label>
      <textarea
        className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--bg)] p-2 text-sm text-[var(--fg)] placeholder:text-[var(--fg-subtle)]"
        rows={3}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Warum dieser Stand?"
      />
      <label className="mt-3 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={vendor}
          onChange={(e) => setVendor(e.target.checked)}
        />
        Plugin-ZIPs ins Bundle packen (Air-Gap-Export)
      </label>
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm"
        >
          Abbrechen
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy}
          className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          Erstellen
        </button>
      </div>
    </ModalShell>
  );
}

interface DiffModalProps {
  draftId: string;
  snapshot: SnapshotSummary;
  onClose: () => void;
}

function DiffModal({
  draftId,
  snapshot,
  onClose,
}: DiffModalProps): React.ReactElement {
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'ready'; diffs: AssetDiffEntry[] }
    | { kind: 'error'; message: string }
  >({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await getSnapshotDiff(draftId, snapshot.snapshot_id, 'live');
        if (!cancelled) setState({ kind: 'ready', diffs: res.diffs });
      } catch (err) {
        if (!cancelled) {
          setState({
            kind: 'error',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [draftId, snapshot.snapshot_id]);

  return (
    <ModalShell title={`Diff: Snapshot vs. Live`} onClose={onClose} wide>
      <p className="text-xs opacity-70">
        Snapshot{' '}
        <span className="font-mono">{snapshot.bundle_hash.slice(0, 12)}</span>{' '}
        vs. aktueller Builder-Stand
      </p>
      {state.kind === 'loading' && (
        <p className="mt-3 text-sm opacity-70">Lädt…</p>
      )}
      {state.kind === 'error' && (
        <p className="mt-3 text-sm text-[var(--danger)]">
          {state.message}
        </p>
      )}
      {state.kind === 'ready' && state.diffs.length === 0 && (
        <p className="mt-3 text-sm opacity-70">Keine Unterschiede.</p>
      )}
      {state.kind === 'ready' && state.diffs.length > 0 && (
        <table className="mt-3 w-full text-sm">
          <thead className="text-xs uppercase tracking-wide opacity-70">
            <tr>
              <th className="px-2 py-1 text-left">Pfad</th>
              <th className="px-2 py-1 text-left">Status</th>
              <th className="px-2 py-1 text-left">Snapshot</th>
              <th className="px-2 py-1 text-left">Live</th>
            </tr>
          </thead>
          <tbody>
            {state.diffs.map((d) => (
              <tr
                key={d.path}
                className="border-t border-[var(--border)]"
              >
                <td className="px-2 py-1">{d.path}</td>
                <td className="px-2 py-1">
                  <DiffStatusPill status={d.status} />
                </td>
                <td className="px-2 py-1 font-mono text-xs">
                  {d.base_sha256?.slice(0, 12) ?? '—'}
                </td>
                <td className="px-2 py-1 font-mono text-xs">
                  {d.target_sha256?.slice(0, 12) ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </ModalShell>
  );
}

function DiffStatusPill({
  status,
}: {
  status: AssetDiffEntry['status'];
}): React.ReactElement {
  const tone =
    status === 'added'
      ? 'text-[var(--success)]'
      : status === 'removed'
        ? 'text-[var(--danger)]'
        : status === 'modified'
          ? 'text-[var(--warning)]'
          : 'opacity-60';
  return <span className={`text-xs font-medium ${tone}`}>{status}</span>;
}

interface RollbackModalProps {
  draftId: string;
  snapshot: SnapshotSummary;
  onClose: () => void;
  onRolledBack: (msg: string) => void | Promise<void>;
  onError: (msg: string) => void;
}

function RollbackModal({
  draftId,
  snapshot,
  onClose,
  onRolledBack,
  onError,
}: RollbackModalProps): React.ReactElement {
  const expectedPrefix = useMemo(
    () => snapshot.bundle_hash.slice(0, 12),
    [snapshot.bundle_hash],
  );
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const matches = input === expectedPrefix;

  const submit = async () => {
    if (!matches) return;
    setBusy(true);
    try {
      const res = await rollbackSnapshot(draftId, snapshot.snapshot_id);
      await onRolledBack(
        `Rollback abgeschlossen · ${res.diverged_assets.length} Datei(en) wiederhergestellt`,
      );
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell title="Rollback bestätigen" onClose={onClose}>
      <p className="text-sm">
        Live-<code>agent.md</code> + Knowledge-Dateien werden auf den
        Snapshot-Stand zurückgesetzt. Plugin-Pins bleiben unverändert.
      </p>
      <p className="mt-3 text-xs opacity-70">
        Tippe die ersten 12 Zeichen des Bundle-Hashes ein, um zu bestätigen.
        Erwartet: <span className="font-mono">{expectedPrefix}</span>
      </p>
      <input
        type="text"
        className={`mt-1 w-full rounded-md border bg-[var(--bg)] p-2 font-mono text-sm text-[var(--fg)] placeholder:text-[var(--fg-subtle)] ${
          matches
            ? 'border-[var(--success)]'
            : 'border-[var(--border)]'
        }`}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        maxLength={12}
        autoComplete="off"
      />
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm"
        >
          Abbrechen
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!matches || busy}
          className="rounded-md bg-[var(--danger)] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          Rollback durchführen
        </button>
      </div>
    </ModalShell>
  );
}

interface ModalShellProps {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}

function ModalShell({
  title,
  children,
  onClose,
  wide,
}: ModalShellProps): React.ReactElement {
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/55 p-6"
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`max-h-[80vh] overflow-auto rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] p-5 text-[var(--fg)] shadow-xl ${
          wide ? 'w-full max-w-3xl' : 'w-full max-w-md'
        }`}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-xl leading-none opacity-60 hover:opacity-100"
            aria-label="Schließen"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
