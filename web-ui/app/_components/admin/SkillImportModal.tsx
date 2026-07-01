'use client';

import { useCallback, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

import {
  importSkill,
  previewImportSkill,
  type SkillImportResult,
} from '../../_lib/agentBuilder';
import { ApiError } from '../../_lib/api';

/**
 * Import a SKILL.md (paste or file) into the skills registry. Shows a dry-run
 * preview (name / description / outcome — no size or "slot" talk) before the
 * user confirms. Only the SKILL.md is ingested; bundled executable code is not
 * run here, which the note makes explicit.
 */
export function SkillImportModal({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: (result: SkillImportResult) => void;
}): React.ReactElement {
  const t = useTranslations('admin.builder.import');
  const [raw, setRaw] = useState('');
  const [sourcePath, setSourcePath] = useState<string | undefined>(undefined);
  const [preview, setPreview] = useState<SkillImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const onFile = useCallback((file: File | null) => {
    if (!file) return;
    void file.text().then((text) => {
      setRaw(text);
      setSourcePath(file.name);
      setPreview(null);
      setError(null);
    });
  }, []);

  const runPreview = useCallback(async () => {
    if (!raw.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setPreview(await previewImportSkill({ raw, sourcePath }));
    } catch (err) {
      setError(err instanceof ApiError ? err.body : String(err));
    } finally {
      setBusy(false);
    }
  }, [raw, sourcePath]);

  const confirm = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      onImported(await importSkill({ raw, sourcePath }));
    } catch (err) {
      setError(err instanceof ApiError ? err.body : String(err));
      setBusy(false);
    }
  }, [raw, sourcePath, onImported]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-xl flex-col gap-4 overflow-auto rounded-lg border border-[color:var(--border)] bg-[color:var(--card)] p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-[color:var(--fg-strong)]">{t('title')}</h2>
        <p className="text-xs text-[color:var(--fg-muted)]">{t('hint')}</p>

        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="rounded-md border border-dashed border-[color:var(--border-strong)] px-3 py-3 text-sm text-[color:var(--fg-muted)] hover:border-[color:var(--accent)]"
        >
          {sourcePath ? t('fileChosen', { name: sourcePath }) : t('chooseFile')}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".md,text/markdown,text/plain"
          className="hidden"
          onChange={(e) => onFile(e.target.files?.[0] ?? null)}
        />

        <textarea
          value={raw}
          onChange={(e) => {
            setRaw(e.target.value);
            setPreview(null);
          }}
          rows={10}
          placeholder={t('pastePlaceholder')}
          className="w-full rounded-md border border-[color:var(--border)] bg-[color:var(--bg-soft)] p-2 font-mono text-xs text-[color:var(--fg-strong)]"
        />

        {preview && (
          <div className="rounded-md border border-[color:var(--border)] bg-[color:var(--bg-soft)] p-3 text-sm">
            <div className="font-medium text-[color:var(--fg-strong)]">{preview.skill.name}</div>
            {preview.skill.description && (
              <div className="text-xs text-[color:var(--fg-muted)]">{preview.skill.description}</div>
            )}
            <div className="mt-1 text-xs text-[color:var(--accent)]">
              {t(`outcome.${preview.outcome}`)}
            </div>
            {preview.risks.length > 0 && (
              <div className="mt-2 rounded-md border border-[color:var(--warning)]/40 bg-[color:var(--warning)]/10 p-2 text-xs text-[color:var(--warning)]">
                <div className="font-semibold">{t('risks.title')}</div>
                <ul className="mt-1 flex flex-col gap-1">
                  {preview.risks.map((r) => (
                    <li key={r.code}>
                      <span className="font-medium">{t(`risks.code.${r.code}`)}</span>
                      <span className="text-[color:var(--fg-muted)]"> — “{r.excerpt}”</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {error && (
          <p className="rounded-md bg-[color:var(--danger)]/10 px-2 py-1 text-xs text-[color:var(--danger)]">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-[color:var(--border)] px-3 py-1.5 text-sm text-[color:var(--fg-muted)]"
          >
            {t('cancel')}
          </button>
          {!preview ? (
            <button
              type="button"
              disabled={busy || !raw.trim()}
              onClick={() => void runPreview()}
              className="rounded-md bg-[color:var(--accent)] px-3 py-1.5 text-sm text-white disabled:opacity-50"
            >
              {t('preview')}
            </button>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => void confirm()}
              className="rounded-md bg-[color:var(--accent)] px-3 py-1.5 text-sm text-white disabled:opacity-50"
            >
              {t('confirm')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
