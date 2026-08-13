'use client';

import { useCallback, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

import {
  importSkill,
  previewImportSkill,
  type SkillImportResult,
} from '../../_lib/agentBuilder';
import { supportDetail } from '../../_lib/scanFailure';
import { Button } from '../ui/Button';

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
      setError(supportDetail(err));
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
      setError(supportDetail(err));
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

        {/* eslint-disable-next-line no-restricted-syntax -- bespoke dashed file-dropzone affordance, not a §4.2 Button variant */}
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
          accept=".md,.txt,.json,text/markdown,text/plain,application/json"
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
            {(preview.unparsedFrontmatter?.length ?? 0) > 0 && (
              <div className="mt-2 rounded-md border border-[color:var(--warning)]/40 bg-[color:var(--warning)]/10 p-2 text-xs text-[color:var(--warning)]">
                <div className="font-semibold">{t('unparsedFrontmatter.title')}</div>
                <p className="mt-1 text-[color:var(--fg-muted)]">
                  {t('unparsedFrontmatter.explain')}
                </p>
                <ul className="mt-1 flex flex-col gap-1 font-mono">
                  {preview.unparsedFrontmatter?.map((line) => (
                    <li key={line} className="break-all text-[color:var(--fg-muted)]">
                      {line}
                    </li>
                  ))}
                </ul>
              </div>
            )}
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

        {/* OM-26 — the raw API body is never the headline. `supportDetail`
            has already stripped request ids and key-shaped tokens; what is
            left sits behind a disclosure aimed at a support thread. */}
        {error && (
          <div className="rounded-md bg-[color:var(--danger)]/10 px-2 py-1 text-xs text-[color:var(--danger)]">
            <p>{t('importFailed')}</p>
            <details className="mt-1">
              <summary className="cursor-pointer text-[color:var(--fg-muted)]">
                {t('supportDetails')}
              </summary>
              <pre className="mt-1 whitespace-pre-wrap break-all text-[color:var(--fg-muted)]">
                {error}
              </pre>
            </details>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('cancel')}
          </Button>
          {!preview ? (
            <Button
              disabled={busy || !raw.trim()}
              onClick={() => void runPreview()}
            >
              {t('preview')}
            </Button>
          ) : (
            <Button disabled={busy} onClick={() => void confirm()}>
              {t('confirm')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
