'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Check, Loader2, ShieldQuestion, Sparkles, X } from 'lucide-react';

import { cn } from '../../_lib/cn';
import {
  approveSelfExtensionProposal,
  denySelfExtensionProposal,
  installSelfExtensionProposal,
  listSelfExtensionProposals,
  proposeSelfExtension,
  ApiError,
  type SelfExtensionProposalView,
} from '../../_lib/api';
import type { JsonPatch } from '../../_lib/builderTypes';

/**
 * Operator-facing panel for the plugin self-extension lifecycle. Surfaced on
 * the store-detail page for an INSTALLED plugin. Lets the operator:
 *   - submit a proposal (rationale + RFC-6902 spec patches),
 *   - read the escalation guard's verdict (auto-denied proposals show the
 *     exact privilege widenings — they can never be approved),
 *   - approve / deny a pending proposal, and install an approved one
 *     (which rebuilds the plugin and hot-reactivates it).
 *
 * The non-escalation guarantee is enforced server-side; this panel only
 * renders the verdict. See docs/harness-platform/DESIGN-plugin-self-extension.md.
 */

function errMessage(err: unknown): string {
  if (err instanceof ApiError) {
    try {
      const parsed = JSON.parse(err.body) as { message?: string };
      if (parsed?.message) return parsed.message;
    } catch {
      // fall through
    }
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

export function SelfExtensionPanel({ agentId }: { agentId: string }): React.ReactElement {
  const t = useTranslations('selfExtension');
  const router = useRouter();

  const [proposals, setProposals] = useState<SelfExtensionProposalView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // compose form
  const [rationale, setRationale] = useState('');
  const [patchesText, setPatchesText] = useState('');
  const [composeBusy, setComposeBusy] = useState(false);
  const [composeError, setComposeError] = useState<string | null>(null);

  // per-proposal action state
  const [actionBusyId, setActionBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{ id: string; message: string } | null>(null);
  const [denyFor, setDenyFor] = useState<string | null>(null);
  const [denyReason, setDenyReason] = useState('');

  async function reload(): Promise<void> {
    try {
      const list = await listSelfExtensionProposals(agentId);
      setProposals(list);
      setLoadError(null);
    } catch (err) {
      setLoadError(errMessage(err));
      setProposals([]);
    }
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await listSelfExtensionProposals(agentId);
        if (!cancelled) {
          setProposals(list);
          setLoadError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setLoadError(errMessage(err));
          setProposals([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  async function handlePropose(): Promise<void> {
    setComposeError(null);
    let patches: JsonPatch[];
    try {
      const parsed = JSON.parse(patchesText) as unknown;
      if (!Array.isArray(parsed)) throw new Error('not an array');
      patches = parsed as JsonPatch[];
    } catch {
      setComposeError(t('invalidPatchesJson'));
      return;
    }
    setComposeBusy(true);
    try {
      await proposeSelfExtension(agentId, { rationale, patches });
      setRationale('');
      setPatchesText('');
      await reload();
    } catch (err) {
      setComposeError(errMessage(err));
    } finally {
      setComposeBusy(false);
    }
  }

  async function runAction(id: string, fn: () => Promise<unknown>): Promise<void> {
    setActionBusyId(id);
    setActionError(null);
    try {
      await fn();
      await reload();
    } catch (err) {
      setActionError({ id, message: errMessage(err) });
    } finally {
      setActionBusyId(null);
      setDenyFor(null);
      setDenyReason('');
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-[12px] leading-relaxed text-[color:var(--fg-muted)]">{t('intro')}</p>

      {/* compose */}
      <div className="rounded-[10px] border border-[color:var(--border)] bg-[color:var(--bg-soft)] p-3">
        <label className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--fg-muted)]">
          <Sparkles className="size-3.5" aria-hidden />
          {t('composeTitle')}
        </label>
        <input
          type="text"
          value={rationale}
          onChange={(e) => setRationale(e.target.value)}
          placeholder={t('rationalePlaceholder')}
          className="mt-2 w-full rounded border border-[color:var(--border)] bg-[color:var(--bg)] px-2 py-1.5 text-[13px] focus:outline-none focus:ring-1 focus:ring-[color:var(--accent)]"
        />
        <textarea
          value={patchesText}
          onChange={(e) => setPatchesText(e.target.value)}
          placeholder={t('patchesPlaceholder')}
          rows={4}
          className="font-mono-num mt-2 w-full rounded border border-[color:var(--border)] bg-[color:var(--bg)] px-2 py-1.5 text-[12px] focus:outline-none focus:ring-1 focus:ring-[color:var(--accent)]"
        />
        {composeError ? (
          <p className="font-mono-num mt-1.5 text-[11px] text-[color:var(--danger,#b03030)]">{composeError}</p>
        ) : null}
        <button
          type="button"
          onClick={() => void handlePropose()}
          disabled={composeBusy || rationale.trim().length === 0 || patchesText.trim().length === 0}
          className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-[color:var(--accent)] px-4 py-1.5 text-[12px] font-semibold text-[color:var(--accent-fg)] disabled:opacity-60"
        >
          {composeBusy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
          {composeBusy ? t('proposing') : t('propose')}
        </button>
      </div>

      {/* list */}
      {proposals === null ? (
        <div className="inline-flex items-center gap-2 text-[12px] text-[color:var(--fg-subtle)]">
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          {t('loading')}
        </div>
      ) : loadError ? (
        <p className="text-[12px] text-[color:var(--danger,#b03030)]">{t('loadError', { message: loadError })}</p>
      ) : proposals.length === 0 ? (
        <p className="text-[12px] italic text-[color:var(--fg-subtle)]">{t('empty')}</p>
      ) : (
        <ul className="space-y-3">
          {proposals.map((p) => (
            <li key={p.id} className="rounded-[10px] border border-[color:var(--border)] bg-[color:var(--bg)] p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <DecisionBadge decision={p.decision} status={p.status} t={t} />
                <span className="font-mono-num text-[10px] text-[color:var(--fg-subtle)]">
                  {t('patchCount', { count: p.patchCount })}
                </span>
              </div>
              <p className="mt-2 text-[13px] text-[color:var(--fg)]">{p.rationale}</p>

              {p.escalations.length > 0 ? (
                <div className="mt-2 rounded border border-[color:var(--danger,#b03030)]/40 bg-[color:var(--danger,#b03030)]/6 p-2">
                  <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--danger,#b03030)]">
                    <AlertTriangle className="size-3.5" aria-hidden />
                    {t('escalationsTitle')}
                  </div>
                  <ul className="mt-1 space-y-1">
                    {p.escalations.map((e, i) => (
                      <li key={i} className="font-mono-num text-[11px] text-[color:var(--danger,#b03030)]">
                        {e.dimension}: {e.item}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {p.invalidReason ? (
                <p className="font-mono-num mt-2 text-[11px] text-[color:var(--danger,#b03030)]">{p.invalidReason}</p>
              ) : null}
              {p.denialReason && p.escalations.length === 0 && !p.invalidReason ? (
                <p className="mt-2 text-[11px] text-[color:var(--fg-muted)]">{t('denied', { reason: p.denialReason })}</p>
              ) : null}
              {p.installFailureReason ? (
                <p className="font-mono-num mt-2 text-[11px] text-[color:var(--danger,#b03030)]">
                  {t('installFailed', { reason: p.installFailureReason })}
                </p>
              ) : null}

              {actionError?.id === p.id ? (
                <p className="font-mono-num mt-2 text-[11px] text-[color:var(--danger,#b03030)]">{actionError.message}</p>
              ) : null}

              {/* actions */}
              {p.status === 'pending' ? (
                denyFor === p.id ? (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <input
                      type="text"
                      value={denyReason}
                      onChange={(e) => setDenyReason(e.target.value)}
                      placeholder={t('denyReasonPlaceholder')}
                      className="flex-1 rounded border border-[color:var(--border)] bg-[color:var(--bg-soft)] px-2 py-1 text-[12px] focus:outline-none focus:ring-1 focus:ring-[color:var(--accent)]"
                    />
                    <button
                      type="button"
                      disabled={actionBusyId === p.id || denyReason.trim().length === 0}
                      onClick={() => void runAction(p.id, () => denySelfExtensionProposal(p.id, denyReason))}
                      className="rounded-full bg-[color:var(--danger,#b03030)] px-3 py-1 text-[12px] font-semibold text-white disabled:opacity-60"
                    >
                      {t('confirmDeny')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setDenyFor(null);
                        setDenyReason('');
                      }}
                      className="text-[11px] text-[color:var(--fg-subtle)] hover:text-[color:var(--fg)]"
                    >
                      {t('cancel')}
                    </button>
                  </div>
                ) : (
                  <div className="mt-3 flex items-center gap-2">
                    <button
                      type="button"
                      disabled={actionBusyId === p.id}
                      onClick={() => void runAction(p.id, () => approveSelfExtensionProposal(p.id))}
                      className="inline-flex items-center gap-1.5 rounded-full bg-[color:var(--accent)] px-3 py-1 text-[12px] font-semibold text-[color:var(--accent-fg)] disabled:opacity-60"
                    >
                      {actionBusyId === p.id ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Check className="size-3.5" aria-hidden />}
                      {t('approve')}
                    </button>
                    <button
                      type="button"
                      disabled={actionBusyId === p.id}
                      onClick={() => setDenyFor(p.id)}
                      className="inline-flex items-center gap-1.5 rounded-full bg-[color:var(--bg-soft)] px-3 py-1 text-[12px] font-semibold text-[color:var(--fg-muted)] ring-1 ring-inset ring-[color:var(--border)]"
                    >
                      <X className="size-3.5" aria-hidden />
                      {t('deny')}
                    </button>
                  </div>
                )
              ) : null}

              {p.status === 'approved' ? (
                <button
                  type="button"
                  disabled={actionBusyId === p.id}
                  onClick={() =>
                    void runAction(p.id, async () => {
                      await installSelfExtensionProposal(p.id);
                      router.refresh();
                    })
                  }
                  className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-[color:var(--accent)] px-3 py-1 text-[12px] font-semibold text-[color:var(--accent-fg)] disabled:opacity-60"
                >
                  {actionBusyId === p.id ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
                  {actionBusyId === p.id ? t('installing') : t('install')}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DecisionBadge({
  decision,
  status,
  t,
}: {
  decision: SelfExtensionProposalView['decision'];
  status: SelfExtensionProposalView['status'];
  t: ReturnType<typeof useTranslations>;
}): React.ReactElement {
  const tone =
    status === 'installed'
      ? 'text-[color:var(--success)] border-[color:var(--success)]/40 bg-[color:var(--success)]/10'
      : status === 'approved'
        ? 'text-[color:var(--accent)] border-[color:var(--accent)]/40 bg-[color:var(--accent)]/10'
        : status === 'denied' || status === 'install_failed'
          ? 'text-[color:var(--danger,#b03030)] border-[color:var(--danger,#b03030)]/40 bg-[color:var(--danger,#b03030)]/6'
          : 'text-[color:var(--fg-muted)] border-[color:var(--border)] bg-[color:var(--bg-soft)]';
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold', tone)}>
      <ShieldQuestion className="size-3.5" aria-hidden />
      {t(`status_${status}`)} · {t(`decision_${decision}`)}
    </span>
  );
}
