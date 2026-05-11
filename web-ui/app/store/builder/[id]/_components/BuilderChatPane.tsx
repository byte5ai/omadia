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
  ChevronDown,
  ChevronRight,
  Loader2,
  MessageSquare,
  Send,
  StopCircle,
  Wrench,
} from 'lucide-react';

import { ApiError, streamBuilderTurn } from '../../../../_lib/api';
import type {
  BuilderModelId,
  BuilderTurnEvent,
  JsonPatch,
  SpecBusCause,
  TranscriptEntry,
} from '../../../../_lib/builderTypes';
import { cn } from '../../../../_lib/cn';

import { BuilderMarkdown } from './BuilderMarkdown';

type ChatItem =
  | { kind: 'message'; key: string; role: 'user' | 'assistant'; text: string; ts: number }
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
      kind: 'spec_patch';
      key: string;
      patches: JsonPatch[];
      cause: SpecBusCause;
      ts: number;
    }
  | {
      kind: 'slot_patch';
      key: string;
      slotKey: string;
      cause: SpecBusCause;
      ts: number;
    }
  | {
      kind: 'lint';
      key: string;
      issueCount: number;
      cause: SpecBusCause;
      ts: number;
    };

interface BuilderChatPaneProps {
  draftId: string;
  /** Codegen model resolved from the draft. Sent on each turn so model
   *  switches in the header take effect immediately. */
  model: BuilderModelId;
  /** Persisted transcript loaded with the draft. */
  initialTranscript: TranscriptEntry[];
  /** Surfaces structured agent-side mutations (spec/slot/lint) so the
   *  Workspace can hot-update other panes without re-fetching the draft.
   *  No-op in B.5-2; B.5-4 wires it up via a dedicated SSE channel and
   *  stops piggy-backing on the turn stream. */
  onAgentMutation?: (event: BuilderTurnEvent) => void;
  /** When this prop changes to a non-null value the chat input is
   *  populated with `text` (cursor at end). When `autoSubmit` is true the
   *  turn fires immediately — used by the Slot-Editor's "Frag den Agent"
   *  button so the user does not have to also click Senden. The
   *  Workspace resets it back to null after the consumer has applied it. */
  pendingInput?: { text: string; autoSubmit?: boolean } | null;
  /** Called once the pending input has been applied so the parent can
   *  reset its state and avoid re-applying the same value. */
  onPendingInputConsumed?: () => void;
}

/**
 * Builder-Chat-Pane (Phase B.5-2).
 *
 * NDJSON consumer for `POST /drafts/:id/turn`. Renders the chronological
 * transcript (persisted entries + live tool calls + structured agent
 * mutations) and hosts the input form. Aborts the in-flight turn when the
 * user navigates away or hits Stop.
 *
 * Reconnect: B.5-2 surfaces a dropped connection to the user with a clear
 * error banner — the LLM has already started spending tokens, so silently
 * re-issuing the POST would double-bill. B.5-3 layers a `Last-Event-Id`
 * resume endpoint on top so the client can re-attach without a fresh turn.
 */
export function BuilderChatPane({
  draftId,
  model,
  initialTranscript,
  onAgentMutation,
  pendingInput,
  onPendingInputConsumed,
}: BuilderChatPaneProps): React.ReactElement {
  const [items, setItems] = useState<ChatItem[]>(() =>
    initialTranscript.map((entry, idx) => ({
      kind: 'message' as const,
      key: `init-${String(idx)}`,
      role: entry.role,
      text: entry.content,
      ts: entry.timestamp,
    })),
  );
  const [input, setInput] = useState('');
  const [inflight, setInflight] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Quick-win: elapsed-counter for the inflight badge so a slow Opus turn
  // (30+ tool calls) reads as "still progressing" instead of "stuck".
  // Reset to null when a turn ends; the tick effect below refreshes the
  // derived `now` once per second to drive the displayed mm:ss.
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null);
  const [elapsedNow, setElapsedNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!inflight) return;
    const t = setInterval(() => setElapsedNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [inflight]);
  // B.6-7 — per-turn telemetry shown above the input. Resets on
  // `turn_started`, accumulates on each `tool_result`. Persists between
  // turns so the operator can glance at the previous turn's footprint
  // even after sending a new message (`isLive` flips to `false`).
  const [turnStats, setTurnStats] = useState<TurnStats | null>(null);
  // Theme E0 — liveness pulse from the middleware. Updated on every
  // `heartbeat` event (~ every 2s while the turn is in flight). Cleared
  // when the turn ends or a new one starts so the badge does not show
  // stale counters from the previous turn.
  //
  // Theme E1 — `phase` and `tokensThisIter` arrive on the heartbeat once
  // the middleware has seen its first stream event; both stay undefined
  // on a turn that ends before any heartbeat fires.
  const [liveness, setLiveness] = useState<{
    sinceLastActivityMs: number;
    iteration: number;
    toolCallsThisIter: number;
    phase?: 'thinking' | 'streaming' | 'tool_running' | 'idle';
    tokensThisIter?: number;
  } | null>(null);
  // Theme E1 — live token-stream telemetry. tokensPerSec ticks per
  // stream_token_chunk (every text/tool-input delta), so it updates
  // sub-second instead of riding the 2s heartbeat. Cleared on
  // turn_started so the previous turn's last rate does not leak.
  const [tokensPerSec, setTokensPerSec] = useState<number>(0);
  // Theme E1 — authoritative usage from iteration_usage events. Drives
  // the cache-hit indicator (🟢 when cacheReadInputTokens > 0). Carries
  // the latest iteration's totals; replaced on every iteration_usage so
  // the indicator reflects the most recent cache decision the API made.
  const [lastUsage, setLastUsage] = useState<{
    inputTokens: number;
    cacheReadInputTokens: number;
  } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputId = useId();
  const counterRef = useRef(0);
  const nextKey = useCallback((prefix: string) => {
    counterRef.current += 1;
    return `${prefix}-${String(counterRef.current)}`;
  }, []);

  // Scroll-to-bottom whenever the transcript grows. Only matters when the
  // user is already at/near the bottom; we cheap out and always scroll
  // since the pane is short and a hard scroll on each new event reads as
  // attentive rather than jarring.
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [items]);

  // Make sure we don't leak an in-flight stream across unmount.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const onSend = useCallback(async (messageOverride?: string) => {
    const source = messageOverride ?? input;
    const trimmed = source.trim();
    if (!trimmed || inflight) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setError(null);
    setInflight(true);
    setTurnStartedAt(Date.now());
    setInput('');

    try {
      for await (const ev of streamBuilderTurn(draftId, trimmed, {
        model,
        signal: controller.signal,
      })) {
        applyEvent(ev);
        if (
          (ev.type === 'spec_patch' ||
            ev.type === 'slot_patch' ||
            ev.type === 'lint_result') &&
          ev.cause === 'agent'
        ) {
          onAgentMutation?.(ev);
        }
        if (ev.type === 'turn_done') break;
        if (ev.type === 'error') {
          setError(`${ev.code}: ${ev.message}`);
          break;
        }
      }
    } catch (err) {
      if (controller.signal.aborted) {
        // User-initiated stop — don't surface as an error.
      } else if (err instanceof ApiError) {
        setError(humanizeApiError(err));
      } else if (err instanceof Error) {
        setError(`Verbindung verloren: ${err.message}`);
      } else {
        setError('Unbekannter Fehler beim Builder-Turn');
      }
    } finally {
      setInflight(false);
      setTurnStartedAt(null);
      setLiveness(null);
      setTokensPerSec(0);
      setLastUsage(null);
      abortRef.current = null;
    }

    function applyEvent(ev: BuilderTurnEvent): void {
      if (ev.type === 'turn_started') {
        setTurnStats({
          turnId: ev.turnId,
          isLive: true,
          totalLatencyMs: 0,
          toolCount: 0,
          patchSpecCount: 0,
          fillSlotCount: 0,
          startedAt: Date.now(),
        });
        setLiveness(null);
        setTokensPerSec(0);
        setLastUsage(null);
        return;
      }
      if (ev.type === 'heartbeat') {
        setLiveness({
          sinceLastActivityMs: ev.sinceLastActivityMs,
          iteration: ev.currentIteration,
          toolCallsThisIter: ev.toolCallsThisIter,
          ...(ev.phase ? { phase: ev.phase } : {}),
          ...(typeof ev.tokensStreamedThisIter === 'number'
            ? { tokensThisIter: ev.tokensStreamedThisIter }
            : {}),
        });
        return;
      }
      if (ev.type === 'stream_token_chunk') {
        // Sub-second rate update — heartbeat alone would lag 2s behind
        // every burst. Also reflect the cumulative count optimistically
        // on `liveness` so the displayed counter doesn't snap to a new
        // value only when the next heartbeat fires.
        setTokensPerSec(ev.tokensPerSec);
        setLiveness((prev) =>
          prev
            ? { ...prev, tokensThisIter: ev.cumulativeOutputTokens }
            : prev,
        );
        return;
      }
      if (ev.type === 'iteration_usage') {
        setLastUsage({
          inputTokens: ev.inputTokens,
          cacheReadInputTokens: ev.cacheReadInputTokens,
        });
        return;
      }
      if (ev.type === 'tool_result') {
        setTurnStats((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            totalLatencyMs: prev.totalLatencyMs + ev.durationMs,
            toolCount: prev.toolCount + 1,
            patchSpecCount:
              prev.patchSpecCount + (ev.toolId === 'patch_spec' ? 1 : 0),
            fillSlotCount:
              prev.fillSlotCount + (ev.toolId === 'fill_slot' ? 1 : 0),
          };
        });
      }
      if (ev.type === 'turn_done') {
        setTurnStats((prev) => (prev ? { ...prev, isLive: false } : prev));
      }
      if (ev.type === 'chat_message') {
        setItems((prev) => [
          ...prev,
          {
            kind: 'message',
            key: nextKey('msg'),
            role: ev.role,
            text: ev.text,
            ts: Date.now(),
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
      } else if (ev.type === 'spec_patch') {
        setItems((prev) => [
          ...prev,
          {
            kind: 'spec_patch',
            key: nextKey('spec'),
            patches: ev.patches,
            cause: ev.cause,
            ts: Date.now(),
          },
        ]);
      } else if (ev.type === 'slot_patch') {
        setItems((prev) => [
          ...prev,
          {
            kind: 'slot_patch',
            key: nextKey('slot'),
            slotKey: ev.slotKey,
            cause: ev.cause,
            ts: Date.now(),
          },
        ]);
      } else if (ev.type === 'lint_result') {
        setItems((prev) => [
          ...prev,
          {
            kind: 'lint',
            key: nextKey('lint'),
            issueCount: ev.issues.length,
            cause: ev.cause,
            ts: Date.now(),
          },
        ]);
      }
    }
  }, [draftId, inflight, input, model, nextKey, onAgentMutation]);

  const onStop = useCallback(() => {
    abortRef.current?.abort();
    // Defense in depth: if the abort path takes longer than 5s to clean up
    // (pathological hang in fetch / NDJSON parser / resume loop), force-clear
    // inflight so the operator can resend. setInflight(false) is idempotent
    // — the natural cleanup running first is harmless.
    setTimeout(() => {
      setInflight(false);
      setTurnStartedAt(null);
      abortRef.current = null;
    }, 5000);
  }, []);

  // Apply a pre-filled prompt when the parent passes one in (e.g. Slot-
  // Editor's "Frag den Agent" button). When `autoSubmit` is true we
  // bypass the input-state round-trip and pass the message straight to
  // onSend — calling onSend right after setInput would race the React
  // re-render. Defined AFTER onSend so the closure captures the latest
  // version. The consumer-callback resets the parent state so the next
  // identical pre-fill still triggers an effect.
  useEffect(() => {
    if (
      pendingInput === null ||
      pendingInput === undefined ||
      typeof pendingInput.text !== 'string' ||
      pendingInput.text.length === 0
    ) {
      return;
    }
    if (pendingInput.autoSubmit) {
      setInput('');
      void onSend(pendingInput.text);
    } else {
      setInput(pendingInput.text);
    }
    onPendingInputConsumed?.();
  }, [pendingInput, onPendingInputConsumed, onSend]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void onSend();
      }
    },
    [onSend],
  );

  const empty = items.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        ref={scrollRef}
        className="flex-1 space-y-3 overflow-y-auto px-5 py-4"
      >
        {empty ? (
          <EmptyHint />
        ) : (
          items.map((item) => <ChatItemView key={item.key} item={item} />)
        )}
      </div>

      {error ? (
        <div className="mx-5 mb-2 flex items-start gap-2 rounded-md border border-[color:var(--danger)]/40 bg-[color:var(--danger)]/8 px-3 py-2 text-[12px] text-[color:var(--danger)]">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span className="break-words">{error}</span>
        </div>
      ) : null}

      {turnStats ? <TurnStatsLine stats={turnStats} /> : null}

      <div className="border-t border-[color:var(--divider)] px-5 py-3">
        <label className="sr-only" htmlFor={inputId}>
          Builder-Nachricht
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
                ? 'Builder denkt nach …'
                : 'Beschreibe was der Agent tun soll. Enter zum Senden, Shift+Enter für Zeilenumbruch.'
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
              className="inline-flex h-[44px] shrink-0 items-center gap-1.5 rounded-md bg-[color:var(--accent)] px-3 py-2 text-[12px] font-semibold text-white shadow-[var(--shadow-cta)] transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              <Send className="size-4" aria-hidden />
              Senden
            </button>
          )}
        </div>
        {inflight ? (
          <p
            className={
              liveness && liveness.sinceLastActivityMs > 30000
                ? 'font-mono-num mt-2 inline-flex flex-wrap items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] text-[color:var(--danger)]'
                : 'font-mono-num mt-2 inline-flex flex-wrap items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] text-[color:var(--fg-subtle)]'
            }
          >
            <Loader2 className="size-3 animate-spin" aria-hidden />
            Stream live · {formatElapsed(turnStartedAt, elapsedNow)} · model {model}
            {liveness?.phase ? (
              <span className={phasePillClass(liveness.phase)}>
                {liveness.phase.replace('_', ' ')}
              </span>
            ) : null}
            {typeof liveness?.tokensThisIter === 'number' &&
            liveness.tokensThisIter > 0 ? (
              <span>
                · {String(liveness.tokensThisIter)}t
                {tokensPerSec > 0
                  ? ` @ ${formatTokenRate(tokensPerSec)}/s`
                  : ''}
              </span>
            ) : null}
            {lastUsage && lastUsage.cacheReadInputTokens > 0 ? (
              <span className="text-emerald-600">
                · 🟢 cache ({String(lastUsage.cacheReadInputTokens)}t)
              </span>
            ) : null}
            {liveness ? (
              <span>
                · Iter {liveness.iteration} · last activity{' '}
                {formatLivenessGap(liveness.sinceLastActivityMs)}
                {liveness.toolCallsThisIter > 0
                  ? ` · ${String(liveness.toolCallsThisIter)} tools this iter`
                  : ''}
                {liveness.sinceLastActivityMs > 30000
                  ? ' · vermutlich hängt — Stop drücken?'
                  : ''}
              </span>
            ) : null}
          </p>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-turn telemetry (B.6-7)
// ---------------------------------------------------------------------------

interface TurnStats {
  turnId: string;
  /** True while the turn is still streaming, false after `turn_done`. */
  isLive: boolean;
  /** Sum of `tool_result.durationMs` across every tool call this turn. */
  totalLatencyMs: number;
  /** Total tool_result count (including patch_spec, fill_slot, others). */
  toolCount: number;
  patchSpecCount: number;
  fillSlotCount: number;
  /** Wall-clock start of the turn, for the future "took N ms wall" stat. */
  startedAt: number;
}

function TurnStatsLine({ stats }: { stats: TurnStats }): React.ReactElement {
  const tools: string[] = [];
  if (stats.patchSpecCount > 0) {
    tools.push(`${String(stats.patchSpecCount)} patch_spec`);
  }
  if (stats.fillSlotCount > 0) {
    tools.push(`${String(stats.fillSlotCount)} fill_slot`);
  }
  const others = stats.toolCount - stats.patchSpecCount - stats.fillSlotCount;
  if (others > 0) tools.push(`${String(others)} other`);
  const toolsLabel = tools.length > 0 ? tools.join(' · ') : '0 tools';
  return (
    <div className="font-mono-num mx-5 mb-2 inline-flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] uppercase tracking-[0.18em] text-[color:var(--fg-subtle)]">
      <span>
        {stats.isLive ? 'Turn live' : 'Letzter Turn'}: {toolsLabel}
      </span>
      <span className="text-[color:var(--fg-muted)]">
        {(stats.totalLatencyMs / 1000).toFixed(2)} s tool-time
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------

function EmptyHint(): React.ReactElement {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
      <MessageSquare
        className="size-5 text-[color:var(--fg-subtle)]"
        aria-hidden
      />
      <p className="font-display text-[16px] text-[color:var(--fg-muted)]">
        Sag dem Builder, womit du anfangen willst.
      </p>
      <p className="font-mono-num text-[11px] text-[color:var(--fg-subtle)]">
        z.B. „Bau einen Confluence-Reader-Agent mit Tools page_read und page_search.“
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

  if (item.kind === 'spec_patch') {
    return (
      <EventChip
        label="spec_patch"
        cause={item.cause}
        detail={`${String(item.patches.length)} op${item.patches.length === 1 ? '' : 's'}`}
      />
    );
  }

  if (item.kind === 'slot_patch') {
    return (
      <EventChip
        label="slot_patch"
        cause={item.cause}
        detail={item.slotKey}
      />
    );
  }

  if (item.kind === 'lint') {
    return (
      <EventChip
        label="lint_result"
        cause={item.cause}
        detail={`${String(item.issueCount)} issue${item.issueCount === 1 ? '' : 's'}`}
      />
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

function EventChip({
  label,
  cause,
  detail,
}: {
  label: string;
  cause: SpecBusCause;
  detail: string;
}): React.ReactElement {
  return (
    <div className="font-mono-num inline-flex items-center gap-2 rounded-md bg-[color:var(--bg-soft)] px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-[color:var(--fg-muted)]">
      <span className="text-[color:var(--accent)]">{label}</span>
      <span className="rounded bg-[color:var(--bg)] px-1.5 py-0.5 normal-case tracking-normal text-[color:var(--fg-strong)]">
        {detail}
      </span>
      <span className="text-[color:var(--fg-subtle)]">{cause}</span>
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

function formatLivenessGap(ms: number): string {
  if (ms < 1000) return `${String(Math.max(0, Math.round(ms)))}ms ago`;
  return `${(ms / 1000).toFixed(1)}s ago`;
}

function phasePillClass(
  phase: 'thinking' | 'streaming' | 'tool_running' | 'idle',
): string {
  const base =
    'inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.16em]';
  switch (phase) {
    case 'streaming':
      return `${base} bg-[color:var(--accent)]/15 text-[color:var(--accent)]`;
    case 'tool_running':
      return `${base} bg-amber-500/15 text-amber-600`;
    case 'thinking':
    case 'idle':
    default:
      return `${base} bg-[color:var(--bg-soft)] text-[color:var(--fg-subtle)]`;
  }
}

function formatTokenRate(rate: number): string {
  if (rate < 10) return rate.toFixed(1);
  return String(Math.round(rate));
}

function humanizeApiError(err: ApiError): string {
  try {
    const parsed = JSON.parse(err.body) as { code?: string; message?: string };
    if (parsed.code && parsed.message) {
      return `${parsed.code}: ${parsed.message}`;
    }
    if (parsed.message) return parsed.message;
  } catch {
    // ignore
  }
  return err.message;
}
