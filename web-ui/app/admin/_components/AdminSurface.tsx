'use client';

import { useState } from 'react';

import { useFormatter, useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import { ApiError } from '../../_lib/api';

/**
 * #2320 — small building blocks the credentials, skills, sandbox and publish
 * admin pages share: page frame, status line, a two-step confirm button and
 * date formatting through next-intl. Copy lives under `adminSurface.*`.
 */

export function SurfaceFrame({
  title,
  intro,
  children,
}: {
  title: string;
  intro: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <main className="mx-auto max-w-[1080px] px-6 py-12 lg:px-8 lg:py-16">
      <header className="mb-8">
        <h1 className="font-display text-[clamp(1.75rem,3.5vw,2.5rem)] leading-[1.1] text-[color:var(--fg-strong)]">
          {title}
        </h1>
        <p className="mt-3 max-w-2xl text-[15px] leading-[1.55] text-[color:var(--fg-muted)]">{intro}</p>
      </header>
      <div className="flex flex-col gap-10">{children}</div>
    </main>
  );
}

export function SurfaceSection({
  heading,
  hint,
  children,
}: {
  heading: string;
  hint?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section>
      <h2 className="text-xs font-semibold tracking-wider text-[color:var(--fg-muted)] uppercase">{heading}</h2>
      {hint ? <p className="mt-1 text-sm text-[color:var(--fg-muted)]">{hint}</p> : null}
      <div className="mt-3">{children}</div>
    </section>
  );
}

export function ErrorLine({ text }: { text: string }): React.ReactElement {
  return (
    <p
      role="alert"
      className="rounded-md border border-[color:var(--danger-edge)]/40 bg-[color:var(--danger)]/5 px-3 py-2 text-sm text-[color:var(--danger)]"
    >
      {text}
    </p>
  );
}

export function MutedLine({ text }: { text: string }): React.ReactElement {
  return <p className="text-sm text-[color:var(--fg-muted)]">{text}</p>;
}

export function Mono({ children }: { children: React.ReactNode }): React.ReactElement {
  return <span className="type-mono-data break-all text-xs">{children}</span>;
}

/** A destructive action that needs a second click to run. */
export function ConfirmButton({
  label,
  confirmLabel,
  busy,
  disabled = false,
  onConfirm,
}: {
  label: string;
  confirmLabel: string;
  busy: boolean;
  disabled?: boolean;
  onConfirm: () => void;
}): React.ReactElement {
  const t = useTranslations('adminSurface');
  const [armed, setArmed] = useState(false);
  if (!armed) {
    return (
      <Button variant="danger" size="sm" disabled={busy || disabled} onClick={() => setArmed(true)}>
        {label}
      </Button>
    );
  }
  return (
    <span className="inline-flex gap-2">
      <Button
        variant="danger"
        size="sm"
        busy={busy}
        busyLabel={t('working')}
        onClick={() => {
          setArmed(false);
          onConfirm();
        }}
      >
        {confirmLabel}
      </Button>
      <Button variant="ghost" size="sm" onClick={() => setArmed(false)}>
        {t('cancel')}
      </Button>
    </span>
  );
}

export function useDateText(): (iso: string | null) => string {
  const format = useFormatter();
  const t = useTranslations('adminSurface');
  return (iso) => {
    if (!iso) return t('never');
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return format.dateTime(date, { dateStyle: 'short', timeStyle: 'short' });
  };
}

/**
 * Catalog copy for a failed call: a page-specific code map first, then the
 * shared auth/network/status lines. Never the raw server body.
 */
export function useErrorText(codes: Readonly<Record<string, string>> = {}): (err: unknown) => string {
  const t = useTranslations('adminSurface.errors');
  return (err) => {
    if (err instanceof ApiError) {
      const mapped = err.code ? codes[err.code] : undefined;
      if (mapped) return mapped;
      if (err.status === 401) return t('authRequired');
      if (err.status === 503) return t('unavailable');
      return t('generic', { status: err.status });
    }
    return t('network');
  };
}

export const TABLE_CLASS = 'w-full text-left text-sm';
export const THEAD_CLASS =
  'bg-[color:var(--card)]/40 text-[12px] uppercase tracking-[0.16em] text-[color:var(--fg-muted)]';
export const ROW_CLASS = 'border-t border-[color:var(--border)]/50 align-top';
export const CELL_CLASS = 'px-4 py-3';

export function TableFrame({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div className="overflow-x-auto rounded-lg border border-[color:var(--border)]">
      <table className={TABLE_CLASS}>{children}</table>
    </div>
  );
}
