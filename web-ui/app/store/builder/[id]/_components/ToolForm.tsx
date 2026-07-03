'use client';

import { Save } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState } from 'react';

import { Button } from '@/app/_components/ui/Button';

import type { JsonPatch, ToolSpec } from '../../../../_lib/builderTypes';
import { cn } from '../../../../_lib/cn';
import { savePersonalTemplate } from '../../../../_lib/toolTemplates';
import {
  validateToolDescription,
  validateToolId,
  type ToolFieldErrors,
} from '../../../../_lib/zodSchemaForToolSpec';

import { ToolInputSchemaBuilder } from './ToolInputSchemaBuilder';
import { ToolInputSchemaJsonTab } from './ToolInputSchemaJsonTab';

interface ToolFormProps {
  tool: ToolSpec;
  index: number;
  /** Sibling tool ids (excluding this row) — used for collision detection. */
  otherToolIds: ReadonlyArray<string>;
  onPatch: (patches: JsonPatch[]) => Promise<void> | void;
}

/**
 * B.11-2: Inline-expanded form body for a single tool row.
 *
 * - `id` (snake_case) and `description` are debounced (500 ms) so quick
 *   typing doesn't fire one PATCH per keystroke.
 * - Validation happens up-front via the FE zod-mirror (see
 *   `_lib/zodSchemaForToolSpec.ts`); invalid drafts surface inline and
 *   are NOT sent to the server.
 * - Cmd/Ctrl+S inside any field flushes the pending edit immediately,
 *   matching the SpecEditor convention.
 * - Renaming a tool is encoded as `{ remove old/index, add same/index
 *   with new id }` — the server's strict ToolSpecSchema rejects keys
 *   that don't match the regex even when the row already exists, so a
 *   partial replace would surface as a 400. The atomic remove/add pair
 *   matches what the dnd-kit reorder uses (B.11-1).
 *
 * The input-schema editor is intentionally a placeholder here — that's
 * the B.11-3 surface. JSON output goes server-only via patch_spec until
 * B.11-3 lands.
 */
export function ToolForm({
  tool,
  index,
  otherToolIds,
  onPatch,
}: ToolFormProps): React.ReactElement {
  const t = useTranslations('builder.tools.form');
  const tValidation = useTranslations('builder.tools.validation');
  const idFieldId = useId();
  const descFieldId = useId();
  const [draftId, setDraftId] = useState<string>(tool.id);
  const [draftDesc, setDraftDesc] = useState<string>(tool.description ?? '');
  const [errors, setErrors] = useState<ToolFieldErrors>({});
  const idTimer = useRef<number | null>(null);
  const descTimer = useRef<number | null>(null);
  const lastCommittedRef = useRef<{ id: string; description: string }>({
    id: tool.id,
    description: tool.description ?? '',
  });

  // When the server-canonical tool object catches up, sync the form
  // state — but only if the field isn't actively dirty (i.e. the draft
  // already matches what the parent gave us).
  useEffect(() => {
    setDraftId((prev) =>
      prev === lastCommittedRef.current.id ? tool.id : prev,
    );
    setDraftDesc((prev) =>
      prev === lastCommittedRef.current.description
        ? tool.description ?? ''
        : prev,
    );
    lastCommittedRef.current = {
      id: tool.id,
      description: tool.description ?? '',
    };
  }, [tool.id, tool.description]);

  useEffect(() => {
    return () => {
      if (idTimer.current !== null) window.clearTimeout(idTimer.current);
      if (descTimer.current !== null) window.clearTimeout(descTimer.current);
    };
  }, []);

  function commitId(nextId: string): void {
    if (nextId === tool.id) return;
    const idErr = validateToolId(nextId, tValidation);
    if (idErr) {
      setErrors((e) => ({ ...e, id: idErr }));
      return;
    }
    if (otherToolIds.includes(nextId)) {
      setErrors((e) => ({ ...e, id: t('idTaken') }));
      return;
    }
    setErrors((e) => ({ ...e, id: undefined }));
    // Atomic rename: remove + add with same content but new id.
    const renamed: ToolSpec = { ...tool, id: nextId };
    void onPatch([
      { op: 'remove', path: `/tools/${index}` },
      { op: 'add', path: `/tools/${index}`, value: renamed },
    ]);
  }

  function commitDescription(nextDesc: string): void {
    if (nextDesc === (tool.description ?? '')) return;
    const descErr = validateToolDescription(nextDesc, tValidation);
    if (descErr) {
      setErrors((e) => ({ ...e, description: descErr }));
      return;
    }
    setErrors((e) => ({ ...e, description: undefined }));
    void onPatch([
      { op: 'replace', path: `/tools/${index}/description`, value: nextDesc },
    ]);
  }

  function scheduleId(value: string): void {
    setDraftId(value);
    if (idTimer.current !== null) window.clearTimeout(idTimer.current);
    idTimer.current = window.setTimeout(() => {
      idTimer.current = null;
      commitId(value);
    }, 500);
  }

  function scheduleDesc(value: string): void {
    setDraftDesc(value);
    if (descTimer.current !== null) window.clearTimeout(descTimer.current);
    descTimer.current = window.setTimeout(() => {
      descTimer.current = null;
      commitDescription(value);
    }, 500);
  }

  function onKeyDown(
    e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
    flushKind: 'id' | 'description',
  ): void {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (flushKind === 'id') {
        if (idTimer.current !== null) {
          window.clearTimeout(idTimer.current);
          idTimer.current = null;
        }
        commitId(draftId);
      } else {
        if (descTimer.current !== null) {
          window.clearTimeout(descTimer.current);
          descTimer.current = null;
        }
        commitDescription(draftDesc);
      }
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <label
          htmlFor={idFieldId}
          className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.18em] text-[color:var(--fg-subtle)]"
        >
          {t('idLabel')}
        </label>
        <input
          id={idFieldId}
          type="text"
          value={draftId}
          onChange={(e) => scheduleId(e.target.value)}
          onBlur={() => {
            if (idTimer.current !== null) {
              window.clearTimeout(idTimer.current);
              idTimer.current = null;
            }
            commitId(draftId);
          }}
          onKeyDown={(e) => onKeyDown(e, 'id')}
          className={cn(
            'w-full rounded-md border bg-[color:var(--bg)] px-3 py-2 font-mono-num text-[12px] text-[color:var(--fg-strong)] placeholder:text-[color:var(--fg-subtle)] focus:outline-none',
            errors.id
              ? 'border-[color:var(--danger)] focus:border-[color:var(--danger)]'
              : 'border-[color:var(--border)] focus:border-[color:var(--accent)]',
          )}
          placeholder={t('idPlaceholder')}
          spellCheck={false}
        />
        {errors.id ? (
          <p className="mt-1 text-[11px] text-[color:var(--danger)]">{errors.id}</p>
        ) : null}
      </div>

      <div>
        <label
          htmlFor={descFieldId}
          className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.18em] text-[color:var(--fg-subtle)]"
        >
          {t('descriptionLabel')}
        </label>
        <textarea
          id={descFieldId}
          value={draftDesc}
          rows={2}
          onChange={(e) => scheduleDesc(e.target.value)}
          onBlur={() => {
            if (descTimer.current !== null) {
              window.clearTimeout(descTimer.current);
              descTimer.current = null;
            }
            commitDescription(draftDesc);
          }}
          onKeyDown={(e) => onKeyDown(e, 'description')}
          className={cn(
            'w-full resize-y rounded-md border bg-[color:var(--bg)] px-3 py-2 text-[12px] leading-snug text-[color:var(--fg-strong)] focus:outline-none',
            errors.description
              ? 'border-[color:var(--danger)] focus:border-[color:var(--danger)]'
              : 'border-[color:var(--border)] focus:border-[color:var(--accent)]',
          )}
          placeholder={t('descriptionPlaceholder')}
        />
        {errors.description ? (
          <p className="mt-1 text-[11px] text-[color:var(--danger)]">
            {errors.description}
          </p>
        ) : null}
      </div>

      <InputSchemaSection
        value={tool.input}
        onChange={(next) =>
          void onPatch([
            { op: 'replace', path: `/tools/${index}/input`, value: next },
          ])
        }
      />

      <SavePersonalTemplateButton tool={tool} />
    </div>
  );
}

function SavePersonalTemplateButton({
  tool,
}: {
  tool: ToolSpec;
}): React.ReactElement {
  const t = useTranslations('builder.tools.form');
  const [stamp, setStamp] = useState<'idle' | 'saved'>('idle');
  return (
    <div className="border-t border-[color:var(--border)] pt-2">
      <Button
        variant="secondary"
        size="sm"
        onClick={() => {
          const label = window.prompt(
            t('templateNamePrompt'),
            tool.id || t('templateNameDefault'),
          );
          if (!label || label.trim().length === 0) return;
          savePersonalTemplate({ label: label.trim(), tool });
          setStamp('saved');
          window.setTimeout(() => setStamp('idle'), 1400);
        }}
      >
        <Save className="size-3" aria-hidden />
        {t('saveAsTemplate')}
      </Button>
      {stamp === 'saved' ? (
        <span className="ml-2 text-[10px] text-[color:var(--fg-muted)]">
          {t('saved')}
        </span>
      ) : null}
    </div>
  );
}

function InputSchemaSection({
  value,
  onChange,
}: {
  value: Record<string, unknown> | undefined;
  onChange: (next: Record<string, unknown>) => void;
}): React.ReactElement {
  const t = useTranslations('builder.tools.form');
  const [tab, setTab] = useState<'form' | 'json'>('form');
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="block text-[10px] font-semibold uppercase tracking-[0.18em] text-[color:var(--fg-subtle)]">
          {t('inputSchema')}
        </span>
        <div
          role="tablist"
          aria-label={t('schemaModeLabel')}
          className="inline-flex overflow-hidden rounded border border-[color:var(--border)]"
        >
          <button
            role="tab"
            aria-selected={tab === 'form'}
            type="button"
            onClick={() => setTab('form')}
            className={cn(
              'px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em]',
              tab === 'form'
                ? 'bg-[color:var(--accent)] text-[color:var(--fg-on-dark)]'
                : 'bg-[color:var(--bg)] text-[color:var(--fg-subtle)] hover:text-[color:var(--fg-strong)]',
            )}
          >
            {t('tabForm')}
          </button>
          <button
            role="tab"
            aria-selected={tab === 'json'}
            type="button"
            onClick={() => setTab('json')}
            className={cn(
              'px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em]',
              tab === 'json'
                ? 'bg-[color:var(--accent)] text-[color:var(--fg-on-dark)]'
                : 'bg-[color:var(--bg)] text-[color:var(--fg-subtle)] hover:text-[color:var(--fg-strong)]',
            )}
          >
            {t('tabRawJson')}
          </button>
        </div>
      </div>
      {tab === 'form' ? (
        <ToolInputSchemaBuilder value={value} onChange={onChange} />
      ) : (
        <ToolInputSchemaJsonTab value={value} onChange={onChange} />
      )}
    </div>
  );
}
