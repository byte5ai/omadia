'use client';

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Eye,
  Hammer,
  KeyRound,
  Loader2,
  RefreshCw,
  Send,
  StopCircle,
  Wrench,
  XCircle,
} from 'lucide-react';

import {
  ApiError,
  getPreviewSecretsStatus,
  refreshPreview,
  streamPreviewTurn,
} from '../../../../_lib/api';
import type {
  BuildErrorRow,
  CodegenIssueRow,
  PreviewStreamEvent,
  SetupField,
  TranscriptEntry,
} from '../../../../_lib/builderTypes';
import { cn } from '../../../../_lib/cn';

import { BuilderMarkdown } from './BuilderMarkdown';
import { SecretsDrawer } from './SecretsDrawer';

type ChatItem =
  | { kind: 'message'; key: string; role: 'user' | 'assistant'; text: string }
  | {
      kind: 'tool';
      key: string;
      useId: string;
      toolId: string;
      input: unknown;
      output: string | null;
      isError: boolean | null;
      durationMs: number | null;
    }
  | {
      kind: 'build';
      key: string;
      phase: 'building' | 'ok' | 'failed';
      reason?: string;
      buildN?: number;
      errors?: ReadonlyArray<BuildErrorRow>;
      codegenIssues?: ReadonlyArray<CodegenIssueRow>;
    };

export interface BuildStatusSnapshot {
  phase: 'idle' | 'building' | 'ok' | 'failed';
  buildN?: number;
  reason?: string;
  errorCount?: number;
  /** Structured tsc diagnostics — surfaced both as Monaco markers in the
   *  Slot-Editor and as the expanded error list in the Preview pane. */
  errors?: ReadonlyArray<BuildErrorRow>;
}

export interface AgentStuckSnapshot {
  slotKey: string;
  attempts: number;
  lastReason: string;
  lastSummary: string;
  lastErrorCount: number;
}

export interface RuntimeSmokeSnapshot {
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
}

interface PreviewChatPaneProps {
  draftId: string;
  initialTranscript: TranscriptEntry[];
  /** Declared setup_fields on the draft.spec — drives the secrets-drawer
   *  form. Empty when the spec has no setup_fields yet. */
  setupFields: ReadonlyArray<SetupField>;
  /** Lifts build_status events to the parent so the workspace footer can
   *  show a global indicator that survives Preview-pane scrolling. */
  onBuildStatus?: (status: BuildStatusSnapshot) => void;
  /** B.7-6: Builder-Agent gave up after 3 failed fill_slot retries on
   *  this slot. Banner appears at the top of the pane until cleared. */
  agentStuck?: AgentStuckSnapshot | null;
  /** Callback for the banner's dismiss button. Workspace owns the state
   *  and clears it on slot_patch automatically — this is the manual
   *  override for "I read the message, hide the banner". */
  onClearAgentStuck?: () => void;
  /** B.9-4: Latest runtime-smoke status, surfaced as compact strip
   *  above the chat-scroll area. */
  runtimeSmoke?: RuntimeSmokeSnapshot | null;
  /** Option-C, C-2: when smoke fails the strip exposes a
   *  "Fix mit Builder"-Button. The Workspace owns composeFixPrompt and
   *  pendingChatInput, so the click bubbles up and the parent injects
   *  the pre-filled message into the BuilderChatPane. */
  onFixSmokeWithBuilder?: () => void;
  /** Live-fix: lifted from local state so the Workspace can also derive
   *  its missingRequiredCredentials counter from the same source. */
  onBufferedSecretKeysChange?: (keys: readonly string[]) => void;
}

/**
 * Preview-Chat-Pane (Phase B.5-7).
 *
 * Drives the Preview-Agent (the freshly-built draft). Each turn rebuilds
 * the preview if the spec/slots changed since last run, then runs the
 * agent against the user's message and streams events back. The
 * `build_status` event surfaces compile errors inline so the user can
 * fix them without leaving the workspace; the rest of the wire shape is
 * the same chat / tool_use / tool_result flow as the BuilderChatPane.
 */
export function PreviewChatPane({
  draftId,
  initialTranscript,
  setupFields,
  onBuildStatus,
  agentStuck,
  onClearAgentStuck,
  runtimeSmoke,
  onFixSmokeWithBuilder,
  onBufferedSecretKeysChange,
}: PreviewChatPaneProps): React.ReactElement {
  const [items, setItems] = useState<ChatItem[]>(() =>
    initialTranscript.map((entry, i) => ({
      kind: 'message' as const,
      key: `init-${String(i)}`,
      role: entry.role,
      text: entry.content,
    })),
  );
  const [input, setInput] = useState('');
  const [inflight, setInflight] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Quick-win: elapsed-counter for the inflight badge.
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null);
  const [elapsedNow, setElapsedNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!inflight) return;
    const t = setInterval(() => setElapsedNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [inflight]);
  // Rebuild-Click confirmation: green strip that auto-clears after a few
  // seconds so the operator knows the click landed even when the build_status
  // events are off-screen in the chat scroll.
  const [rebuildPending, setRebuildPending] = useState(false);
  const [rebuildSuccess, setRebuildSuccess] = useState<{ buildN: number } | null>(null);
  const [secretsOpen, setSecretsOpen] = useState(false);
  const [bufferedSecretKeys, setBufferedSecretKeys] = useState<string[]>([]);
  // Stable callbacks for SecretsDrawer — without these, the inline arrows
  // got recreated on every render, and SecretsDrawer's `useEffect(..., [..., onStatusChange])`
  // re-fired in a tight loop whenever the drawer was open.
  const handleSecretsClose = useCallback(() => setSecretsOpen(false), []);
  const handleSecretsStatusChange = useCallback(
    (keys: readonly string[]) => {
      const next = [...keys];
      setBufferedSecretKeys(next);
      onBufferedSecretKeysChange?.(next);
    },
    [onBufferedSecretKeysChange],
  );
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputId = useId();

  // Bootstrap the buffered-key badge so it's correct on first render even
  // before the user opens the drawer.
  useEffect(() => {
    let alive = true;
    void getPreviewSecretsStatus(draftId)
      .then((res) => {
        if (!alive) return;
        setBufferedSecretKeys(res.keys);
        onBufferedSecretKeysChange?.(res.keys);
      })
      .catch(() => {
        // non-fatal — drawer will refetch on open.
      });
    return () => {
      alive = false;
    };
  }, [draftId, onBufferedSecretKeysChange]);
  const counterRef = useRef(0);
  const nextKey = useCallback((prefix: string) => {
    counterRef.current += 1;
    return `${prefix}-${String(counterRef.current)}`;
  }, []);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [items]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const onSend = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || inflight) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setError(null);
    setInflight(true);
    setTurnStartedAt(Date.now());
    setInput('');

    try {
      for await (const ev of streamPreviewTurn(draftId, trimmed, {
        signal: controller.signal,
      })) {
        applyEvent(ev);
        if (ev.type === 'turn_done') break;
        if (ev.type === 'error') {
          setError(`${ev.code}: ${ev.message}`);
          break;
        }
      }
    } catch (err) {
      if (controller.signal.aborted) {
        // user-initiated stop
      } else if (err instanceof ApiError) {
        setError(humanizeApiError(err));
      } else if (err instanceof Error) {
        setError(`Verbindung verloren: ${err.message}`);
      } else {
        setError('Unbekannter Fehler beim Preview-Turn');
      }
    } finally {
      setInflight(false);
      setTurnStartedAt(null);
      abortRef.current = null;
    }

    function applyEvent(ev: PreviewStreamEvent): void {
      if (ev.type === 'chat_message') {
        setItems((prev) => [
          ...prev,
          {
            kind: 'message',
            key: nextKey('msg'),
            role: ev.role,
            text: ev.text,
          },
        ]);
      } else if (ev.type === 'tool_use') {
        setItems((prev) => [
          ...prev,
          {
            kind: 'tool',
            key: nextKey('tool'),
            useId: ev.useId,
            toolId: ev.toolId,
            input: ev.input,
            output: null,
            isError: null,
            durationMs: null,
          },
        ]);
      } else if (ev.type === 'tool_result') {
        setItems((prev) => {
          const i = lastIndexWhere(
            prev,
            (item) =>
              item.kind === 'tool' &&
              item.useId === ev.useId &&
              item.output === null,
          );
          if (i === -1) return prev;
          const next = prev.slice();
          const target = next[i];
          if (target?.kind === 'tool') {
            next[i] = {
              ...target,
              output: ev.output,
              isError: ev.isError,
              durationMs: ev.durationMs,
            };
          }
          return next;
        });
      } else if (ev.type === 'build_status') {
        const newItem: ChatItem = {
          kind: 'build',
          key: nextKey('build'),
          phase: ev.phase,
          ...(ev.reason !== undefined ? { reason: ev.reason } : {}),
          ...(ev.buildN !== undefined ? { buildN: ev.buildN } : {}),
          ...(ev.errors !== undefined ? { errors: ev.errors } : {}),
          ...(ev.codegenIssues !== undefined
            ? { codegenIssues: ev.codegenIssues }
            : {}),
        };
        const totalIssueCount =
          (ev.errors?.length ?? 0) + (ev.codegenIssues?.length ?? 0);
        const snapshot: BuildStatusSnapshot = {
          phase: ev.phase,
          ...(ev.buildN !== undefined ? { buildN: ev.buildN } : {}),
          ...(ev.reason !== undefined ? { reason: ev.reason } : {}),
          ...(totalIssueCount > 0 ? { errorCount: totalIssueCount } : {}),
        };
        onBuildStatus?.(snapshot);
        setItems((prev) => {
          // Replace a previous "building" entry with the resolved phase
          // when one is in flight — keeps the transcript readable.
          const i = lastIndexWhere(
            prev,
            (item) => item.kind === 'build' && item.phase === 'building',
          );
          if (i === -1 || ev.phase === 'building') {
            return [...prev, newItem];
          }
          const next = prev.slice();
          next[i] = newItem;
          return next;
        });
      }
    }
  }, [draftId, inflight, input, nextKey]);

  const onStop = useCallback(() => {
    abortRef.current?.abort();
    // Defense in depth: force-clear inflight 5s after Stop click in case
    // the abort path hangs on a slow fetch / NDJSON parser.
    setTimeout(() => {
      setInflight(false);
      setTurnStartedAt(null);
      abortRef.current = null;
    }, 5000);
  }, []);

  const onRefresh = useCallback(async () => {
    setError(null);
    setRebuildSuccess(null);
    setRebuildPending(true);
    try {
      const result = await refreshPreview(draftId);
      setRebuildSuccess({ buildN: result.buildN });
    } catch (err) {
      setError(humanizeApiError(err));
    } finally {
      setRebuildPending(false);
    }
  }, [draftId]);

  // Auto-clear the success strip after 4s so it doesn't linger across builds.
  useEffect(() => {
    if (!rebuildSuccess) return;
    const t = setTimeout(() => setRebuildSuccess(null), 4000);
    return () => clearTimeout(t);
  }, [rebuildSuccess]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void onSend();
      }
    },
    [onSend],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-[color:var(--divider)] px-5 py-2 text-[11px] text-[color:var(--fg-muted)]">
        <Eye
          className="size-3 text-[color:var(--fg-subtle)]"
          aria-hidden
        />
        <span>Preview-Agent</span>
        <button
          type="button"
          onClick={() => setSecretsOpen(true)}
          className={cn(
            'ml-auto inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em]',
            setupFields.length > 0 && bufferedSecretKeys.length === 0
              ? 'bg-[color:var(--warning)]/15 text-[color:var(--warning)] hover:bg-[color:var(--warning)]/25'
              : 'bg-[color:var(--bg-soft)] text-[color:var(--fg-muted)] hover:bg-[color:var(--gray-100)] hover:text-[color:var(--fg-strong)]',
          )}
          title="Test-Credentials für die Preview verwalten"
        >
          <KeyRound className="size-3" aria-hidden />
          Credentials{' '}
          {setupFields.length > 0
            ? `(${String(bufferedSecretKeys.length)}/${String(setupFields.length)})`
            : ''}
        </button>
        <button
          type="button"
          onClick={() => void onRefresh()}
          disabled={rebuildPending}
          className="inline-flex items-center gap-1 rounded-md bg-[color:var(--bg-soft)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--fg-muted)] hover:bg-[color:var(--gray-100)] hover:text-[color:var(--fg-strong)] disabled:opacity-50"
        >
          {rebuildPending ? (
            <Loader2 className="size-3 animate-spin" aria-hidden />
          ) : (
            <RefreshCw className="size-3" aria-hidden />
          )}
          Rebuild
        </button>
      </div>

      <SecretsDrawer
        draftId={draftId}
        fields={setupFields}
        open={secretsOpen}
        onClose={handleSecretsClose}
        onStatusChange={handleSecretsStatusChange}
      />

      {rebuildSuccess ? (
        <div className="mx-5 mt-3 flex items-center gap-2 rounded-md border border-[color:var(--success)]/30 bg-[color:var(--success)]/8 px-3 py-2 text-[12px] text-[color:var(--success)]">
          <CheckCircle2 className="size-3.5 shrink-0" aria-hidden />
          <span className="font-mono-num text-[11px]">
            Rebuild #{String(rebuildSuccess.buildN)} ✓ — Preview ist bereit
          </span>
        </div>
      ) : null}

      {runtimeSmoke ? (
        <RuntimeSmokeStrip
          snap={runtimeSmoke}
          onFixWithBuilder={onFixSmokeWithBuilder}
        />
      ) : null}

      {agentStuck ? (
        <div className="mx-5 mt-3 flex items-start gap-2 rounded-md border border-[color:var(--warning)]/40 bg-[color:var(--warning)]/8 px-3 py-2 text-[12px] text-[color:var(--warning)]">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <div className="min-w-0 flex-1 break-words">
            <div className="font-semibold">
              Builder-Agent kommt bei Slot{' '}
              <code className="font-mono text-[11px]">{agentStuck.slotKey}</code>{' '}
              nicht weiter ({String(agentStuck.attempts)} Versuche)
            </div>
            <div className="mt-1 text-[11px] text-[color:var(--fg-muted)]">
              {agentStuck.lastSummary}. Öffne den Slot-Editor, prüf die
              Errors manuell und korrigier den Code — der Agent versucht
              es nicht von alleine erneut.
            </div>
          </div>
          {onClearAgentStuck ? (
            <button
              type="button"
              onClick={onClearAgentStuck}
              className="rounded-sm px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--fg-muted)] hover:bg-[color:var(--gray-100)] hover:text-[color:var(--fg-strong)]"
              title="Banner schließen"
            >
              Schließen
            </button>
          ) : null}
        </div>
      ) : null}

      <div
        ref={scrollRef}
        className="flex-1 space-y-3 overflow-y-auto px-5 py-4"
      >
        {items.length === 0 ? (
          <EmptyHint />
        ) : (
          items.map((item) => <ChatItemView key={item.key} item={item} />)
        )}
      </div>

      {error ? (
        // Theme A: external_reads-driven `is not registered` errors are
        // EXPECTED in Preview — Solution A leaves the ServicesAccessor as a
        // no-op stub and lets the agent's null-guard fire. We render those
        // as warnings (yellow) with a hint that Install is required for
        // real lookups; everything else stays a hard error (red).
        // Source: HANDOFF-2026-05-04-preview-services-undefined.md.
        /is not registered/.test(error) ? (
          <div className="mx-5 mb-2 flex items-start gap-2 rounded-md border border-[color:var(--warning)]/40 bg-[color:var(--warning)]/8 px-3 py-2 text-[12px] text-[color:var(--warning)]">
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <div className="min-w-0 flex-1 break-words">
              <div>{error}</div>
              <div className="mt-1 text-[11px] text-[color:var(--fg-muted)]">
                Preview führt Cross-Integration-Lookups (<code>spec.external_reads</code>)
                nicht aus — der Agent erkennt den fehlenden Service korrekt
                und wirft. Installiere den Agent in den Plattform-Store, um
                den echten Datenpfad zu testen.
              </div>
            </div>
          </div>
        ) : (
          <div className="mx-5 mb-2 flex items-start gap-2 rounded-md border border-[color:var(--danger)]/40 bg-[color:var(--danger)]/8 px-3 py-2 text-[12px] text-[color:var(--danger)]">
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span className="break-words">{error}</span>
          </div>
        )
      ) : null}

      <div className="border-t border-[color:var(--divider)] px-5 py-3">
        <label className="sr-only" htmlFor={inputId}>
          Preview-Nachricht
        </label>
        <div className="flex items-end gap-2">
          <textarea
            id={inputId}
            value={input}
            disabled={inflight}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            rows={2}
            placeholder={
              inflight
                ? 'Preview-Agent antwortet …'
                : 'Teste den Agent. Enter zum Senden.'
            }
            className="min-h-[44px] flex-1 resize-none rounded-md border border-[color:var(--border)] bg-[color:var(--bg)] px-3 py-2 text-[13px] leading-snug text-[color:var(--fg-strong)] placeholder:text-[color:var(--fg-subtle)] focus:border-[color:var(--accent)] focus:outline-none disabled:opacity-60"
          />
          {inflight ? (
            <button
              type="button"
              onClick={onStop}
              className="inline-flex h-[44px] shrink-0 items-center gap-1.5 rounded-md border border-[color:var(--danger)]/40 px-3 py-2 text-[12px] font-semibold text-[color:var(--danger)] transition-colors hover:bg-[color:var(--danger)]/10"
            >
              <StopCircle className="size-4" aria-hidden />
              Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void onSend()}
              disabled={input.trim().length === 0}
              className="inline-flex h-[44px] shrink-0 items-center gap-1.5 rounded-md bg-[color:var(--accent)] px-3 py-2 text-[12px] font-semibold text-white shadow-[var(--shadow-cta)] disabled:opacity-40"
            >
              <Send className="size-4" aria-hidden />
              Senden
            </button>
          )}
        </div>
        {inflight ? (
          <p className="font-mono-num mt-2 inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] text-[color:var(--fg-subtle)]">
            <Loader2 className="size-3 animate-spin" aria-hidden />
            Stream live · {formatElapsed(turnStartedAt, elapsedNow)}
          </p>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function RuntimeSmokeStrip({
  snap,
  onFixWithBuilder,
}: {
  snap: RuntimeSmokeSnapshot;
  onFixWithBuilder?: () => void;
}): React.ReactElement | null {
  const total = snap.results?.length ?? 0;
  const failed = snap.results?.filter(
    (r) => r.status === 'threw' || r.status === 'timeout',
  ).length ?? 0;

  let icon: React.ReactNode;
  let toneClass: string;
  let label: string;

  if (snap.phase === 'running') {
    icon = <Loader2 className="size-3 animate-spin" aria-hidden />;
    toneClass =
      'border-[color:var(--divider)] bg-[color:var(--bg-soft)] text-[color:var(--fg-muted)]';
    label = `smoke #${String(snap.buildN)} läuft …`;
  } else if (snap.phase === 'ok') {
    icon = <CheckCircle2 className="size-3" aria-hidden />;
    toneClass =
      'border-[color:var(--success)]/30 bg-[color:var(--success)]/8 text-[color:var(--success)]';
    if (snap.reason === 'no_tools') {
      label = `smoke #${String(snap.buildN)} ✓ (keine Tools deklariert)`;
    } else {
      label = `smoke #${String(snap.buildN)} ✓ (${String(total)} tool${total === 1 ? '' : 's'} ok)`;
    }
  } else {
    icon = <XCircle className="size-3" aria-hidden />;
    toneClass =
      'border-[color:var(--danger)]/40 bg-[color:var(--danger)]/8 text-[color:var(--danger)]';
    if (snap.reason === 'activate_failed') {
      label = `smoke #${String(snap.buildN)} ✗ — preview activate failed${snap.activateError ? `: ${snap.activateError}` : ''}`;
    } else {
      label = `smoke #${String(snap.buildN)} ✗ — ${String(failed)}/${String(total)} tool${total === 1 ? '' : 's'} failed`;
    }
  }

  return (
    <div
      className={cn(
        'mx-5 mt-3 flex items-start gap-2 rounded-md border px-3 py-2 text-[12px]',
        toneClass,
      )}
    >
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0 flex-1 break-words">
        <div className="font-mono-num text-[11px]">{label}</div>
        {snap.phase === 'failed' && snap.results && snap.results.length > 0 ? (
          <ul className="mt-1 space-y-0.5 text-[11px] text-[color:var(--fg-muted)]">
            {snap.results
              .filter((r) => r.status !== 'ok' && r.status !== 'validation_failed')
              .slice(0, 5)
              .map((r) => (
                <li key={r.toolId}>
                  <code className="font-mono">{r.toolId}</code> · {r.status}
                  {r.errorMessage ? ` — ${r.errorMessage.slice(0, 200)}` : ''}
                </li>
              ))}
          </ul>
        ) : null}
        {snap.phase === 'failed' && onFixWithBuilder ? (
          <button
            type="button"
            onClick={onFixWithBuilder}
            className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-[color:var(--danger)]/40 bg-[color:var(--danger)]/10 px-2 py-1 text-[11px] font-mono-num uppercase tracking-[0.18em] text-[color:var(--danger)] transition-colors hover:bg-[color:var(--danger)]/15"
          >
            <Wrench className="size-3" aria-hidden />
            Fix mit Builder
          </button>
        ) : null}
      </div>
    </div>
  );
}

function EmptyHint(): React.ReactElement {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
      <Eye className="size-5 text-[color:var(--fg-subtle)]" aria-hidden />
      <p className="font-display text-[16px] text-[color:var(--fg-muted)]">
        Teste den Preview-Agent.
      </p>
      <p className="font-mono-num text-[11px] text-[color:var(--fg-subtle)]">
        Spec + Slots werden vor jedem Turn neu kompiliert, falls etwas
        geändert wurde.
      </p>
    </div>
  );
}

function ChatItemView({ item }: { item: ChatItem }): React.ReactElement | null {
  if (item.kind === 'message') {
    const isUser = item.role === 'user';
    return (
      <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
        <div
          className={cn(
            'max-w-[88%] rounded-[12px] px-3 py-2 text-[13px] leading-snug',
            isUser
              ? 'bg-[color:var(--accent)] text-white'
              : 'bg-[color:var(--bg-soft)] text-[color:var(--fg-strong)]',
          )}
        >
          {isUser ? (
            <p className="whitespace-pre-wrap break-words">{item.text}</p>
          ) : (
            <BuilderMarkdown source={item.text} />
          )}
        </div>
      </div>
    );
  }

  if (item.kind === 'tool') {
    return <ToolCard item={item} />;
  }

  if (item.kind === 'build') {
    const palette =
      item.phase === 'ok'
        ? 'border-[color:var(--success)]/40 bg-[color:var(--success)]/8 text-[color:var(--success)]'
        : item.phase === 'failed'
          ? 'border-[color:var(--danger)]/40 bg-[color:var(--danger)]/8 text-[color:var(--danger)]'
          : 'border-[color:var(--divider)] bg-[color:var(--bg-soft)] text-[color:var(--fg-muted)]';
    const Icon =
      item.phase === 'ok'
        ? CheckCircle2
        : item.phase === 'failed'
          ? XCircle
          : Hammer;
    return (
      <div className={cn('rounded-[10px] border px-3 py-2 text-[12px]', palette)}>
        <div className="flex items-center gap-2">
          <Icon className="size-3.5" aria-hidden />
          <span className="font-mono-num text-[10px] uppercase tracking-[0.16em]">
            build {item.phase}
          </span>
          {item.buildN !== undefined ? (
            <span className="font-mono-num text-[10px] text-[color:var(--fg-subtle)]">
              #{String(item.buildN)}
            </span>
          ) : null}
          {item.phase === 'building' ? (
            <Loader2 className="ml-auto size-3 animate-spin" aria-hidden />
          ) : null}
        </div>
        {item.reason ? (
          <p className="mt-1 break-words text-[11px]">{item.reason}</p>
        ) : null}
        {item.codegenIssues && item.codegenIssues.length > 0 ? (
          <ul className="mt-2 space-y-1 text-[11px]">
            {item.codegenIssues.map((iss, i) => (
              <li
                key={`codegen-${String(i)}`}
                className="rounded border border-current/20 bg-white/40 px-2 py-1"
              >
                <span className="font-mono-num text-[10px] uppercase tracking-[0.16em] opacity-80">
                  {iss.code}
                </span>
                <p className="mt-0.5 break-words font-normal">{iss.detail}</p>
              </li>
            ))}
          </ul>
        ) : null}
        {item.errors && item.errors.length > 0 ? (
          <ul className="mt-2 space-y-0.5 text-[11px]">
            {item.errors.map((err, i) => (
              <li key={`${err.file}-${String(i)}`} className="font-mono-num">
                {err.file}:{err.line}:{err.column} — {err.code} {err.message}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  }

  return null;
}

function ToolCard({
  item,
}: {
  item: Extract<ChatItem, { kind: 'tool' }>;
}): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const pending = item.output === null;
  return (
    <div className="rounded-[10px] border border-[color:var(--divider)] bg-[color:var(--bg-soft)]/60 text-[12px]">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[color:var(--fg-muted)] hover:bg-[color:var(--bg-soft)] focus:outline-none"
      >
        {expanded ? (
          <ChevronDown className="size-3" aria-hidden />
        ) : (
          <ChevronRight className="size-3" aria-hidden />
        )}
        <Wrench className="size-3" aria-hidden />
        <span className="font-mono-num font-semibold text-[color:var(--fg-strong)]">
          {item.toolId}
        </span>
        {pending ? (
          <Loader2
            className="ml-auto size-3 animate-spin text-[color:var(--accent)]"
            aria-hidden
          />
        ) : item.isError ? (
          <span className="ml-auto inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.16em] text-[color:var(--danger)]">
            error
          </span>
        ) : (
          <span className="font-mono-num ml-auto text-[10px] text-[color:var(--fg-subtle)]">
            {formatDuration(item.durationMs)}
          </span>
        )}
      </button>
      {expanded ? (
        <div className="space-y-1.5 border-t border-[color:var(--divider)] px-3 py-2">
          <pre className="font-mono-num overflow-x-auto whitespace-pre-wrap break-words rounded bg-[color:var(--bg)] px-2 py-1 text-[11px] text-[color:var(--fg-muted)]">
            {jsonPreview(item.input)}
          </pre>
          {!pending && item.output ? (
            <pre
              className={cn(
                'font-mono-num overflow-x-auto whitespace-pre-wrap break-words rounded px-2 py-1 text-[11px]',
                item.isError
                  ? 'bg-[color:var(--danger)]/8 text-[color:var(--danger)]'
                  : 'bg-[color:var(--bg)] text-[color:var(--fg-strong)]',
              )}
            >
              {item.output}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

function lastIndexWhere<T>(arr: T[], pred: (item: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i -= 1) {
    const item = arr[i];
    if (item !== undefined && pred(item)) return i;
  }
  return -1;
}

function jsonPreview(input: unknown): string {
  try {
    const text = JSON.stringify(input, null, 0);
    return text.length > 200 ? `${text.slice(0, 200)}…` : text;
  } catch {
    return String(input);
  }
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '';
  if (ms < 1000) return `${String(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatElapsed(startedAt: number | null, now: number): string {
  if (startedAt === null) return '0:00';
  const totalSec = Math.max(0, Math.floor((now - startedAt) / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${String(min)}:${sec.toString().padStart(2, '0')}`;
}

function humanizeApiError(err: unknown): string {
  if (err instanceof ApiError) {
    try {
      const body = JSON.parse(err.body) as { code?: string; message?: string };
      if (body.code && body.message) return `${body.code}: ${body.message}`;
      if (body.message) return body.message;
    } catch {
      // ignore
    }
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}
