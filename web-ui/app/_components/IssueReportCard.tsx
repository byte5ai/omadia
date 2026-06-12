'use client';

import type React from 'react';
import { useState } from 'react';
import { useTranslations } from 'next-intl';

import {
  ApiError,
  confirmBuilderIssue,
  createBuilderIssue,
} from '../_lib/api';

/**
 * Issue #206 (v1.2) — core-bug report confirmation card.
 *
 * Rendered when the builder agent calls `omadia_report_core_bug` and the
 * `issue_report_pending` spec-event arrives. Because a public-repo issue is
 * irreversible, the operator MUST see the sanitized body and explicitly
 * confirm before anything is filed — this card is that human checkpoint.
 *
 *   - `created-pending` → server files directly via the GitHub App on
 *     confirm (`createBuilderIssue`). If the App is unavailable (409) the
 *     card surfaces the error so the operator can retry/report manually.
 *   - `browser-submit`  → opens the pre-filled GitHub tab; the operator
 *     submits under their own account, then pastes the issue number back
 *     here to link the workaround (`confirmBuilderIssue`).
 *
 * Copy lives in `messages/{en,de}.json` under `builder.issueReport`
 * (omadia uses plain-JSON i18n — see web-ui/CLAUDE.md).
 */

export interface PendingIssueReport {
  pendingId: string;
  mode: 'created-pending' | 'browser-submit';
  title: string;
  summary: string;
  fingerprint: string;
  fingerprintMarker: string;
  sanitizedBody: string;
  githubNewUrl?: string;
}

type Phase = 'idle' | 'awaiting-number' | 'submitting' | 'done' | 'error';

export function IssueReportCard({
  draftId,
  report,
  onResolved,
}: {
  draftId: string;
  report: PendingIssueReport;
  onResolved: () => void;
}): React.ReactElement {
  const t = useTranslations('builder.issueReport');
  const [phase, setPhase] = useState<Phase>('idle');
  const [issueNumberInput, setIssueNumberInput] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [filed, setFiled] = useState<{ number: number; url: string } | null>(null);

  const busy = phase === 'submitting';

  async function confirmDirectCreate(): Promise<void> {
    setPhase('submitting');
    setErrorMessage(null);
    try {
      const res = await createBuilderIssue({
        draftId,
        title: report.title,
        body: report.sanitizedBody,
        fingerprint: report.fingerprint,
        summary: report.summary,
      });
      const ref = res.issueRef ?? res.workaround.issueRef;
      setFiled({ number: ref.number, url: ref.url });
      setPhase('done');
    } catch (err) {
      setPhase('error');
      setErrorMessage(
        err instanceof ApiError && err.status === 409
          ? t('errorNoApp')
          : t('errorCreateFailed'),
      );
    }
  }

  function openGithubTab(): void {
    if (report.githubNewUrl) {
      window.open(report.githubNewUrl, '_blank', 'noopener,noreferrer');
    }
    setPhase('awaiting-number');
  }

  async function confirmBrowserSubmit(): Promise<void> {
    const issueNumber = Number(issueNumberInput.trim());
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      setErrorMessage(t('errorInvalidNumber'));
      return;
    }
    setPhase('submitting');
    setErrorMessage(null);
    try {
      const res = await confirmBuilderIssue({
        draftId,
        issueNumber,
        fingerprint: report.fingerprint,
        summary: report.summary,
      });
      setFiled({
        number: res.workaround.issueRef.number,
        url: res.workaround.issueRef.url,
      });
      setPhase('done');
    } catch (err) {
      setPhase('awaiting-number');
      setErrorMessage(
        err instanceof Error
          ? t('errorConfirm', { message: err.message })
          : t('errorConfirmFailed'),
      );
    }
  }

  return (
    <div className="mt-3 rounded border border-[color:var(--warning)]/50 bg-[color:var(--warning)]/10 p-3">
      <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-[color:var(--warning)]">
        <span aria-hidden>⚠</span> {t('kicker')}
      </div>

      {phase === 'done' && filed ? (
        <div className="text-sm text-[color:var(--fg-strong)]">
          {t.rich('filed', {
            number: filed.number,
            issueLink: (chunks) => (
              <a
                href={filed.url}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium underline"
              >
                {chunks}
              </a>
            ),
          })}
        </div>
      ) : (
        <>
          <div className="mb-2 text-sm font-medium text-[color:var(--fg-strong)]">
            {report.title}
          </div>
          <p className="mb-2 text-xs text-[color:var(--fg-muted)]">
            {t.rich('publicWarning', {
              strong: (chunks) => <strong>{chunks}</strong>,
            })}
          </p>
          <pre className="mb-3 max-h-48 overflow-auto rounded bg-[color:var(--bg-soft)] p-2 text-[11px] leading-snug whitespace-pre-wrap text-[color:var(--fg)]">
            {report.sanitizedBody}
          </pre>

          {errorMessage && (
            <div className="mb-2 text-xs text-[color:var(--danger,#dc2626)]">
              {errorMessage}
            </div>
          )}

          {report.mode === 'created-pending' && (
            <div className="flex flex-wrap gap-2">
              <PrimaryButton
                disabled={busy}
                onClick={() => void confirmDirectCreate()}
              >
                {busy ? t('creating') : t('confirmCreate')}
              </PrimaryButton>
              <SecondaryButton disabled={busy} onClick={onResolved}>
                {t('dismiss')}
              </SecondaryButton>
            </div>
          )}

          {report.mode === 'browser-submit' && phase !== 'awaiting-number' && (
            <div className="flex flex-wrap gap-2">
              <PrimaryButton disabled={busy} onClick={openGithubTab}>
                {t('openGithub')}
              </PrimaryButton>
              <SecondaryButton disabled={busy} onClick={onResolved}>
                {t('dismiss')}
              </SecondaryButton>
            </div>
          )}

          {report.mode === 'browser-submit' && phase === 'awaiting-number' && (
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="number"
                min={1}
                value={issueNumberInput}
                onChange={(e) => {
                  setIssueNumberInput(e.target.value);
                }}
                placeholder={t('issueNumberPlaceholder')}
                className="w-28 rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)] px-2 py-1.5 text-xs text-[color:var(--fg)]"
              />
              <PrimaryButton
                disabled={busy}
                onClick={() => void confirmBrowserSubmit()}
              >
                {busy ? t('linking') : t('confirmNumber')}
              </PrimaryButton>
              <SecondaryButton disabled={busy} onClick={onResolved}>
                {t('dismiss')}
              </SecondaryButton>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function PrimaryButton({
  children,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded border border-[color:var(--warning)] bg-[color:var(--warning)] px-3 py-1.5 text-xs font-medium text-[color:var(--fg-on-dark)] transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function SecondaryButton({
  children,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)] px-3 py-1.5 text-xs font-medium text-[color:var(--fg)] transition hover:border-[color:var(--border-strong)] disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}
