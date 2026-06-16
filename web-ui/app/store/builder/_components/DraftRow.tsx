'use client';

import { useCallback, useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, Check, Pencil, Trash2, Undo2, X } from 'lucide-react';

import { ApiError } from '../../../_lib/api';
import {
  deleteBuilderDraft,
  restoreBuilderDraft,
  updateBuilderDraft,
} from '../../../_lib/api';
import type {
  BuilderModelId,
  DraftSummary,
} from '../../../_lib/builderTypes';
import { cn } from '../../../_lib/cn';
import { Button } from '@/app/_components/ui/Button';
import { ExportDraftButton } from './ExportDraftButton';

interface DraftRowProps {
  draft: DraftSummary;
  /** If `true`, actions change to "restore" + hard-delete-disabled. */
  deleted?: boolean;
}

const SLUG_LABEL: Record<string, string> = {
  haiku: 'Haiku',
  sonnet: 'Sonnet',
  opus: 'Opus',
};

function modelShortLabel(id: BuilderModelId): string {
  if (SLUG_LABEL[id]) return SLUG_LABEL[id];
  return id.includes(':') ? id.slice(id.indexOf(':') + 1) : id;
}

export function DraftRow({ draft, deleted = false }: DraftRowProps): React.ReactElement {
  const t = useTranslations('builder.drafts.row');
  const router = useRouter();
  const statusLabel: Record<DraftSummary['status'], string> = {
    draft: t('status.draft'),
    published: t('status.published'),
    archived: t('status.archived'),
  };
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(draft.name);
  const [error, setError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);

  const onRename = useCallback(() => {
    const next = name.trim();
    if (!next || next === draft.name) {
      setEditing(false);
      setName(draft.name);
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        await updateBuilderDraft(draft.id, { name: next });
        setEditing(false);
        router.refresh();
      } catch (err) {
        setError(humanizeError(err));
        setName(draft.name);
      }
    });
  }, [draft.id, draft.name, name, router]);

  const onDelete = useCallback(() => {
    if (!confirm(t('confirmDelete', { name: draft.name }))) return;
    setError(null);
    startTransition(async () => {
      try {
        await deleteBuilderDraft(draft.id);
        router.refresh();
      } catch (err) {
        setError(humanizeError(err));
      }
    });
  }, [draft.id, draft.name, router, t]);

  const onRestore = useCallback(() => {
    setError(null);
    startTransition(async () => {
      try {
        await restoreBuilderDraft(draft.id);
        router.refresh();
      } catch (err) {
        setError(humanizeError(err));
      }
    });
  }, [draft.id, router]);

  return (
    <div
      className={cn(
        'group relative flex items-start gap-4 rounded-lg border border-[color:var(--divider)] bg-[color:var(--bg-elevated)] p-4 transition-[box-shadow] duration-[var(--dur-base)]',
        'hover:shadow-[0_4px_14px_rgba(0,75,115,0.08)]',
        pending && 'opacity-60',
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col">
        {editing ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              onRename();
            }}
            className="flex items-center gap-2"
          >
            <input
              ref={nameInputRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setEditing(false);
                  setName(draft.name);
                }
              }}
              maxLength={200}
              className="w-full rounded-md border border-[color:var(--border)] bg-[color:var(--bg)] px-2 py-1 font-display text-[20px] leading-tight text-[color:var(--fg-strong)] focus:border-[color:var(--accent)] focus:outline-none"
            />
            <button
              type="submit"
              aria-label={t('save')}
              className="rounded-md p-2 text-[color:var(--accent)] hover:bg-[color:var(--bg-soft)]"
              disabled={pending}
            >
              <Check className="size-4" aria-hidden />
            </button>
            <button
              type="button"
              aria-label={t('cancel')}
              onClick={() => {
                setEditing(false);
                setName(draft.name);
              }}
              className="rounded-md p-2 text-[color:var(--fg-muted)] hover:bg-[color:var(--bg-soft)]"
              disabled={pending}
            >
              <X className="size-4" aria-hidden />
            </button>
          </form>
        ) : (
          <div className="flex items-baseline gap-3">
            <h3 className="font-display truncate text-[22px] leading-tight text-[color:var(--fg-strong)]">
              {draft.name}
            </h3>
            {!deleted && (
              <button
                type="button"
                aria-label={t('rename')}
                onClick={() => setEditing(true)}
                className="rounded-md p-1 text-[color:var(--fg-subtle)] opacity-0 transition-opacity group-hover:opacity-100 hover:bg-[color:var(--bg-soft)] hover:text-[color:var(--fg-strong)]"
              >
                <Pencil className="size-3.5" aria-hidden />
              </button>
            )}
          </div>
        )}

        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[color:var(--fg-muted)]">
          <span className="inline-flex items-center gap-1">
            <span
              className={cn(
                'inline-block size-1.5 rounded-full',
                draft.status === 'published'
                  ? 'bg-[color:var(--success)]'
                  : draft.status === 'archived'
                    ? 'bg-[color:var(--fg-subtle)]'
                    : 'bg-[color:var(--accent)]',
              )}
            />
            <span className="uppercase tracking-[0.14em]">
              {statusLabel[draft.status]}
            </span>
          </span>
          <span className="font-mono-num">
            {modelShortLabel(draft.codegenModel)}
          </span>
          <span className="font-mono-num">
            {t('lastUpdated', { relative: formatRelative(draft.updatedAt, t) })}
          </span>
          {draft.publishedAgentId ? (
            <span className="font-mono-num text-[color:var(--fg-subtle)]">
              → {draft.publishedAgentId}
            </span>
          ) : null}
        </div>

        {error ? (
          <p className="mt-2 text-[11px] text-[color:var(--danger)]">{error}</p>
        ) : null}
      </div>

      <div className="flex items-center gap-1">
        {deleted ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={onRestore}
            disabled={pending}
            className="text-[11px] font-semibold text-[color:var(--fg-muted)] hover:text-[color:var(--fg-strong)]"
          >
            <Undo2 className="size-3.5" aria-hidden />
            {t('restore')}
          </Button>
        ) : (
          <>
            {draft.status === 'published' ? (
              <ExportDraftButton draftId={draft.id} />
            ) : null}
            <Link
              href={`/store/builder/${encodeURIComponent(draft.id)}`}
              className="inline-flex items-center gap-2 rounded-md bg-[color:var(--accent)]/10 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-[color:var(--accent)] transition-colors hover:bg-[color:var(--accent)] hover:text-[color:var(--fg-on-dark)]"
            >
              {t('workspace')}
              <ArrowRight className="size-3.5" aria-hidden />
            </Link>
            <button
              type="button"
              onClick={onDelete}
              disabled={pending}
              aria-label={t('delete')}
              className="rounded-md p-2 text-[color:var(--fg-muted)] hover:bg-[color:var(--danger)]/10 hover:text-[color:var(--danger)] disabled:opacity-50"
            >
              <Trash2 className="size-4" aria-hidden />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function humanizeError(err: unknown): string {
  if (err instanceof ApiError) {
    try {
      const body = JSON.parse(err.body) as { message?: string };
      return body.message ?? err.message;
    } catch {
      return err.message;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

function formatRelative(
  timestamp: number,
  t: ReturnType<typeof useTranslations<'builder.drafts.row'>>,
): string {
  const diffMs = Date.now() - timestamp;
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return t('relative.justNow');
  if (mins < 60) return t('relative.minutes', { count: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t('relative.hours', { count: hours });
  const days = Math.floor(hours / 24);
  if (days < 7) return t('relative.days', { count: days });
  return new Date(timestamp).toLocaleDateString('de-DE', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}
