'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import {
  acknowledgeSkillVerdict,
  exportSkill,
  forkSkill,
  getSkill,
  patchSkill,
  triggerSkillVerdictLlmScan,
  type SkillNode,
  type SkillVerdict,
} from '../../_lib/agentBuilder';
import { ApiError } from '../../_lib/api';
import { Field, inputCls, SaveButton } from '../../admin/builder/panels/InspectorControls';
import { SkillCapabilityBindings } from './SkillCapabilityBindings';
import { SkillVerdictBadge } from './SkillVerdictBadge';

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
  const t = useTranslations('skills');
  /** Falls back to a humanized raw code for a risk code without a catalog
   *  entry yet (e.g. a newly added verifier pattern), so an unmapped code
   *  degrades gracefully instead of crashing the render. */
  function riskCodeLabel(code: string): string {
    const key = `verdict.riskCode.${code}`;
    return t.has(key) ? t(key) : code.replace(/_/g, ' ');
  }
  const [name, setName] = useState(skill.name);
  const [description, setDescription] = useState(skill.description ?? '');
  const [body, setBody] = useState(skill.body);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Once an imported skill has been forked, subsequent saves patch the fork
  // rather than minting another one.
  const [forkId, setForkId] = useState<string | null>(null);
  const willFork = skill.source === 'file' && forkId === null;
  const [verdict, setVerdict] = useState<SkillVerdict | undefined>(skill.verdict);
  const [ackPending, setAckPending] = useState(false);
  const [scanPending, setScanPending] = useState(false);
  const severity = verdict?.severity ?? 'not_yet_scanned';
  const showWhy = severity === 'flagged' || severity === 'high_risk';
  const alreadyAcked = Boolean(verdict?.ackedAt);
  // Post-review fix: excluding 'not_yet_scanned' created a circular lockout —
  // a fresh/un-backfilled skill could never be deep-scanned since the button
  // only appeared once *something* had scanned it. Only exclude 'pending'
  // (a scan is already in flight for this exact model+prompt identity).
  const canRunDeepScan = severity !== 'pending';

  async function acknowledge(): Promise<void> {
    setAckPending(true);
    try {
      const updated = await acknowledgeSkillVerdict(forkId ?? skill.id);
      setVerdict(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.body : String(err));
    } finally {
      setAckPending(false);
    }
  }

  async function runDeepScan(): Promise<void> {
    setScanPending(true);
    try {
      await triggerSkillVerdictLlmScan(forkId ?? skill.id);
      // The trigger returns almost instantly with a `pending` row — the
      // actual LLM call runs in the background (usually a few seconds).
      // Post-review fix: a single immediate re-fetch almost always lands on
      // that `pending` state and no follow-up render happens, so the badge
      // reads "Scanning…" forever with no visible progress. Poll until the
      // result is terminal (or give up after ~30s so this can't hang the UI
      // indefinitely on a stuck scan).
      for (let attempt = 0; attempt < 15; attempt++) {
        const detail = await getSkill(forkId ?? skill.id);
        setVerdict(detail.verdict);
        if (detail.verdict?.severity !== 'pending') break;
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.body : String(err));
    } finally {
      setScanPending(false);
    }
  }

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
      <div className="flex items-center gap-2">
        <SkillVerdictBadge severity={severity} />
        {canRunDeepScan && (
          <button
            type="button"
            onClick={() => void runDeepScan()}
            disabled={scanPending}
            className="rounded-md border border-[color:var(--border)] px-2 py-0.5 text-xs text-[color:var(--fg-muted)]"
          >
            {t('verdict.runDeepScan')}
          </button>
        )}
        {showWhy && !alreadyAcked && (
          <button
            type="button"
            onClick={() => void acknowledge()}
            disabled={ackPending}
            className="rounded-md border border-[color:var(--border)] px-2 py-0.5 text-xs text-[color:var(--fg-muted)]"
          >
            {t('verdict.acknowledge')}
          </button>
        )}
        {alreadyAcked && (
          <span className="text-xs text-[color:var(--fg-muted)]">
            {t('verdict.acked', { by: verdict?.ackedBy ?? '' })}
          </span>
        )}
      </div>
      {showWhy && verdict && verdict.riskCodes.length > 0 && (
        <p className="rounded-md border border-[color:var(--warning)]/50 bg-[color:var(--warning)]/10 px-2 py-1.5 text-xs text-[color:var(--warning)]">
          {t('verdict.why', { codes: verdict.riskCodes.map(riskCodeLabel).join(', ') })}
        </p>
      )}
      {verdict?.llm?.rationale && (
        <p className="rounded-md border border-[color:var(--border)] bg-[color:var(--bg-soft)] px-2 py-1.5 text-xs text-[color:var(--fg-muted)]">
          {t('verdict.llmRationale', { rationale: verdict.llm.rationale })}
        </p>
      )}
      {willFork && (
        <p className="rounded-md bg-[color:var(--accent)]/10 px-2 py-1 text-xs text-[color:var(--accent)]">
          {t('editor.forkNotice')}
        </p>
      )}
      <SkillCapabilityBindings skillId={forkId ?? skill.id} />
      <Field label={t('editor.name')}>
        <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
      </Field>
      <Field label={t('editor.description')}>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className={inputCls}
        />
      </Field>
      <Field label={t('editor.body')}>
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
          label={willFork ? t('editor.forkAndSave') : t('editor.save')}
        />
        <button
          type="button"
          onClick={download}
          className="rounded-md border border-[color:var(--border)] px-3 py-1.5 text-sm text-[color:var(--fg-muted)]"
        >
          {t('editor.export')}
        </button>
      </div>
    </div>
  );
}
