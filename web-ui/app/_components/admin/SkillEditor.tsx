'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import {
  exportSkill,
  forkSkill,
  patchSkill,
  type SkillNode,
} from '../../_lib/agentBuilder';
import { ApiError } from '../../_lib/api';
import { Field, inputCls, SaveButton } from '../../admin/builder/panels/InspectorControls';

/**
 * The one skill content editor, reused wherever a skill is shown (node-graph
 * inspector + registry). Editing an imported (source:'file') skill forks it
 * into an editable db copy first (fork-on-edit), so imports are never frozen
 * and their provenance is preserved.
 */
export function SkillEditor({
  skill,
  onSaved,
}: {
  skill: SkillNode;
  onSaved: (updated?: SkillNode) => void;
}): React.ReactElement {
  const t = useTranslations('skills.editor');
  const [name, setName] = useState(skill.name);
  const [description, setDescription] = useState(skill.description ?? '');
  const [body, setBody] = useState(skill.body);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Once an imported skill has been forked, subsequent saves patch the fork
  // rather than minting another one.
  const [forkId, setForkId] = useState<string | null>(null);
  const willFork = skill.source === 'file' && forkId === null;

  async function save(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      let targetId = forkId ?? skill.id;
      if (willFork) {
        const fork = await forkSkill(skill.id);
        targetId = fork.id;
        setForkId(fork.id);
      }
      const updated = await patchSkill(targetId, {
        name: name.trim(),
        description: description.trim() || null,
        body,
      });
      onSaved(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.body : String(err));
    } finally {
      setPending(false);
    }
  }

  function download(): void {
    void exportSkill(skill.id)
      .then((md) => {
        const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = `${skill.slug}.SKILL.md`;
        a.click();
        URL.revokeObjectURL(url);
      })
      .catch((err: unknown) => setError(err instanceof ApiError ? err.body : String(err)));
  }

  return (
    <div className="flex flex-col gap-3">
      {willFork && (
        <p className="rounded-md bg-[color:var(--accent)]/10 px-2 py-1 text-xs text-[color:var(--accent)]">
          {t('forkNotice')}
        </p>
      )}
      <Field label={t('name')}>
        <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
      </Field>
      <Field label={t('description')}>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className={inputCls}
        />
      </Field>
      <Field label={t('body')}>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={12}
          className={`${inputCls} font-mono text-xs`}
        />
      </Field>
      {error && <p className="text-xs text-[color:var(--danger)]">{error}</p>}
      <div className="flex gap-2">
        <SaveButton
          onClick={() => void save()}
          pending={pending}
          label={willFork ? t('forkAndSave') : t('save')}
        />
        <button
          type="button"
          onClick={download}
          className="rounded-md border border-[color:var(--border)] px-3 py-1.5 text-sm text-[color:var(--fg-muted)]"
        >
          {t('export')}
        </button>
      </div>
    </div>
  );
}
