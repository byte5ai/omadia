'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Check, ShieldQuestion, Sparkles, X } from 'lucide-react';

import { cn } from '../../_lib/cn';
import { Button } from '@/app/_components/ui/Button';
import {
  approveSelfExtensionProposal,
  denySelfExtensionProposal,
  installSelfExtensionProposal,
  listSelfExtensionProposals,
  listSelfExtensionTemplates,
  proposeSelfExtension,
  ApiError,
  type SelfExtensionProposalView,
  type SelfExtensionTemplateView,
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

  // compose form (spec / patches)
  const [rationale, setRationale] = useState('');
  const [patchesText, setPatchesText] = useState('');
  const [composeBusy, setComposeBusy] = useState(false);
  const [composeError, setComposeError] = useState<string | null>(null);

  // template compose (standalone plugins)
  const [templates, setTemplates] = useState<SelfExtensionTemplateView[]>([]);
  const [tplId, setTplId] = useState('');
  const [tplRationale, setTplRationale] = useState('');
  const [tplParamsText, setTplParamsText] = useState('{}');
  const [tplBusy, setTplBusy] = useState(false);
  const [tplError, setTplError] = useState<string | null>(null);

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

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await listSelfExtensionTemplates(agentId);
        if (!cancelled) {
          setTemplates(list);
          if (list[0]) setTplId(list[0].id);
        }
      } catch {
        // templates are optional (Builder plugins have none) — ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  async function handleProposeTemplate(): Promise<void> {
    setTplError(null);
    let params: Record<string, unknown>;
    try {
      const parsed = JSON.parse(tplParamsText) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('not an object');
      }
      params = parsed as Record<string, unknown>;
    } catch {
      setTplError(t('invalidParamsJson'));
      return;
    }
    setTplBusy(true);
    try {
      await proposeSelfExtension(agentId, { rationale: tplRationale, templateId: tplId, params });
      setTplRationale('');
      setTplParamsText('{}');
      await reload();
    } catch (err) {
      setTplError(errMessage(err));
    } finally {
      setTplBusy(false);
    }
  }

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
      <div className="rounded-md border border-[color:var(--border)] bg-[color:var(--bg-soft)] p-3">
        <label className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--fg-muted)]">
          <Sparkles className="size-3.5" aria-hidden />
          {t('composeTitle')}
        </label>
        <input
          type="text"
          value={rationale}
          onChange={(e) => setRationale(e.target.value)}
          placeholder={t('rationalePlaceholder')}
          className="mt-2 w-full rounded border border-[color:var(--border)] bg-[color:var(--bg)] px-2 py-2 text-[13px] focus:outline-none focus:ring-1 focus:ring-[color:var(--accent)]"
        />
        <textarea
          value={patchesText}
          onChange={(e) => setPatchesText(e.target.value)}
          placeholder={t('patchesPlaceholder')}
          rows={4}
          className="font-mono-num mt-2 w-full rounded border border-[color:var(--border)] bg-[color:var(--bg)] px-2 py-2 text-[12px] focus:outline-none focus:ring-1 focus:ring-[color:var(--accent)]"
        />
        {composeError ? (
          <p className="font-mono-num mt-2 text-[11px] text-[color:var(--danger,#b03030)]">{composeError}</p>
        ) : null}
        <Button
          variant="primary"
          pill
          onClick={() => void handlePropose()}
          disabled={composeBusy || rationale.trim().length === 0 || patchesText.trim().length === 0}
          busy={composeBusy}
          busyLabel={t('proposing')}
          className="mt-2"
        >
          {t('propose')}
        </Button>
      </div>

      {/* template compose (standalone plugins that expose selfExtend templates) */}
      {templates.length > 0 ? (
        <div className="rounded-md border border-[color:var(--border)] bg-[color:var(--bg-soft)] p-3">
          <label className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--fg-muted)]">
            <Sparkles className="size-3.5" aria-hidden />
            {t('templateComposeTitle')}
          </label>
          <select
            value={tplId}
            onChange={(e) => setTplId(e.target.value)}
            className="mt-2 w-full rounded border border-[color:var(--border)] bg-[color:var(--bg)] px-2 py-2 text-[13px] focus:outline-none focus:ring-1 focus:ring-[color:var(--accent)]"
          >
            {templates.map((tpl) => (
              <option key={tpl.id} value={tpl.id}>
                {tpl.title} — {tpl.id}
              </option>
            ))}
          </select>
          {templates.find((x) => x.id === tplId)?.description ? (
            <p className="mt-2 text-[11px] leading-relaxed text-[color:var(--fg-subtle)]">
              {templates.find((x) => x.id === tplId)?.description}
            </p>
          ) : null}
          <input
            type="text"
            value={tplRationale}
            onChange={(e) => setTplRationale(e.target.value)}
            placeholder={t('rationalePlaceholder')}
            className="mt-2 w-full rounded border border-[color:var(--border)] bg-[color:var(--bg)] px-2 py-2 text-[13px] focus:outline-none focus:ring-1 focus:ring-[color:var(--accent)]"
          />
          <textarea
            value={tplParamsText}
            onChange={(e) => setTplParamsText(e.target.value)}
            placeholder={t('templateParamsPlaceholder')}
            rows={3}
            className="font-mono-num mt-2 w-full rounded border border-[color:var(--border)] bg-[color:var(--bg)] px-2 py-2 text-[12px] focus:outline-none focus:ring-1 focus:ring-[color:var(--accent)]"
          />
          {tplError ? (
            <p className="font-mono-num mt-2 text-[11px] text-[color:var(--danger,#b03030)]">{tplError}</p>
          ) : null}
          <Button
            variant="primary"
            pill
            onClick={() => void handleProposeTemplate()}
            disabled={tplBusy || tplRationale.trim().length === 0 || tplId.length === 0}
            busy={tplBusy}
            busyLabel={t('proposing')}
            className="mt-2"
          >
            {t('proposeTemplate')}
          </Button>
        </div>
      ) : null}

      {/* list */}
      {proposals === null ? (
        <div className="inline-flex items-center gap-2 text-[12px] text-[color:var(--fg-subtle)]">
          <span className="lume-busy-dots" aria-hidden />
          {t('loading')}
        </div>
      ) : loadError ? (
        <p className="text-[12px] text-[color:var(--danger,#b03030)]">{t('loadError', { message: loadError })}</p>
      ) : proposals.length === 0 ? (
        <p className="text-[12px] italic text-[color:var(--fg-subtle)]">{t('empty')}</p>
      ) : (
        <ul className="space-y-3">
          {proposals.map((p) => (
            <li key={p.id} className="rounded-md border border-[color:var(--border)] bg-[color:var(--bg)] p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <DecisionBadge decision={p.decision} status={p.status} t={t} />
                <span className="font-mono-num text-[10px] text-[color:var(--fg-subtle)]">
                  {p.kind === 'template' ? p.templateId : t('patchCount', { count: p.patchCount ?? 0 })}
                </span>
              </div>
              <p className="mt-2 text-[13px] text-[color:var(--fg)]">{p.rationale}</p>

              {p.escalations.length > 0 ? (
                <div className="mt-2 rounded border border-[color:var(--danger,#b03030)]/40 bg-[color:var(--danger,#b03030)]/6 p-2">
                  <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--danger,#b03030)]">
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
                    <Button
                      variant="danger"
                      pill
                      size="sm"
                      disabled={actionBusyId === p.id || denyReason.trim().length === 0}
                      onClick={() => void runAction(p.id, () => denySelfExtensionProposal(p.id, denyReason))}
                    >
                      {t('confirmDeny')}
                    </Button>
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
                    <Button
                      variant="primary"
                      pill
                      size="sm"
                      disabled={actionBusyId === p.id}
                      onClick={() => void runAction(p.id, () => approveSelfExtensionProposal(p.id))}
                      busy={actionBusyId === p.id}
                      busyLabel={t('approve')}
                    >
                      <Check className="size-3.5" aria-hidden />
                      {t('approve')}
                    </Button>
                    <Button
                      variant="secondary"
                      pill
                      size="sm"
                      disabled={actionBusyId === p.id}
                      onClick={() => setDenyFor(p.id)}
                      className="font-semibold text-[color:var(--fg-muted)]"
                    >
                      <X className="size-3.5" aria-hidden />
                      {t('deny')}
                    </Button>
                  </div>
                )
              ) : null}

              {p.status === 'approved' ? (
                <Button
                  variant="primary"
                  pill
                  size="sm"
                  disabled={actionBusyId === p.id}
                  onClick={() =>
                    void runAction(p.id, async () => {
                      await installSelfExtensionProposal(p.id);
                      router.refresh();
                    })
                  }
                  busy={actionBusyId === p.id}
                  busyLabel={t('installing')}
                  className="mt-3"
                >
                  {t('install')}
                </Button>
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
    <span className={cn('inline-flex items-center gap-2 rounded-full border px-3 py-0.5 text-[11px] font-semibold', tone)}>
      <ShieldQuestion className="size-3.5" aria-hidden />
      {t(`status_${status}`)} · {t(`decision_${decision}`)}
    </span>
  );
}
