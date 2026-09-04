'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import {
  DEFAULT_MODEL_POLICY,
  getAgentModelPolicy,
  isModelRef,
  parseOperatorAgentErrorCode,
  setAgentModelPolicy,
  type ModelPolicy,
  type ModelPolicyEffort,
  type ModelRef,
} from '../../../../_lib/agents';
import { listBuilderModels } from '../../../../_lib/api';
import type { BuilderModelInfo, BuilderProviderGroup } from '../../../../_lib/builderTypes';
import { humanizeApiError } from '../../_components/AgentsDashboard';

interface AgentModelPolicyProps {
  readonly slug: string;
}

type Slot = 'primary' | 'fallback';

/**
 * #1033 — the "Model" section of an agent: which LLM answers under its name
 * (provider + model + effort) and which one steps in when that is
 * unavailable. Mounted right after Identity: *who the agent is* → *how it
 * thinks* → *what it can use*.
 *
 * Everything offered here comes from `GET /v1/builder/models`: the
 * providers the host has adapters for (built-in or installed as plugins),
 * whether each holds a key (`usable`), and the effort levels each model
 * declares. Nothing about models is known to this bundle — a provider that
 * gains a key or a plugin that adds a model shows up without a UI release.
 *
 * Both rows are a radio: **Auto** (what the platform resolves today, with a
 * read-out of the concrete model) or **a specific model**. The fallback
 * additionally offers **None** (today's behaviour: the turn fails once the
 * retries are spent). A provider without a key is shown, but disabled, with
 * a pointer to the Providers page — the operator should see what a key would
 * unlock rather than wonder why an option is missing.
 */
export function AgentModelPolicy(props: AgentModelPolicyProps): React.ReactElement {
  const t = useTranslations('operatorAgents.modelPolicy');
  const tErr = useTranslations('operatorAgents');
  const [saved, setSaved] = useState<ModelPolicy | null>(null);
  const [draft, setDraft] = useState<ModelPolicy>(DEFAULT_MODEL_POLICY);
  const [effectiveModel, setEffectiveModel] = useState<string | null>(null);
  const [activeProvider, setActiveProvider] = useState<string | null>(null);
  const [deferredProvider, setDeferredProvider] = useState<string | undefined>(undefined);
  const [vision, setVision] = useState<{ primary?: boolean | null; fallback?: boolean | null }>({});
  const [providers, setProviders] = useState<BuilderProviderGroup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const localizeError = useCallback(
    (err: unknown): string => {
      const code = parseOperatorAgentErrorCode(err);
      return code !== null
        ? tErr(`detailErrors.${code}`)
        : tErr('detailErrors.unknown', { detail: humanizeApiError(err) });
    },
    [tErr],
  );

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const [policy, catalog] = await Promise.all([
        getAgentModelPolicy(props.slug),
        listBuilderModels(),
      ]);
      setSaved(policy.policy);
      setDraft(policy.policy);
      setEffectiveModel(policy.effectiveModel);
      setActiveProvider(policy.activeProvider);
      setDeferredProvider(policy.deferredProvider);
      setVision(policy.vision ?? {});
      // A pre-W1 middleware has no `providers` — fall back to grouping the
      // scoped `models` list so the section still renders something honest.
      setProviders(
        catalog.providers ??
          groupLegacy(catalog.models),
      );
      setError(null);
    } catch (err: unknown) {
      setError(localizeError(err));
    } finally {
      setLoading(false);
    }
  }, [props.slug, localizeError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const dirty = saved !== null && JSON.stringify(saved) !== JSON.stringify(draft);
  const sameProvider =
    isModelRef(draft.primary) && isModelRef(draft.fallback) && draft.primary.provider === draft.fallback.provider;
  const sameRef =
    isModelRef(draft.primary) &&
    isModelRef(draft.fallback) &&
    draft.primary.provider === draft.fallback.provider &&
    draft.primary.model === draft.fallback.model;
  const canSave = dirty && !sameRef && !saving;

  const save = useCallback(async (): Promise<void> => {
    setSaving(true);
    try {
      const res = await setAgentModelPolicy(props.slug, draft);
      setSaved(res.policy);
      setDraft(res.policy);
      setVision(res.vision);
      setDeferredProvider(res.deferredProvider);
      setError(null);
      // The effective model may have moved with the policy; re-read it.
      const after = await getAgentModelPolicy(props.slug);
      setEffectiveModel(after.effectiveModel);
    } catch (err: unknown) {
      setError(localizeError(err));
    } finally {
      setSaving(false);
    }
  }, [props.slug, draft, localizeError]);

  const setSlot = (slot: Slot, value: ModelPolicy['fallback']): void => {
    setDraft((d) => (slot === 'primary' ? { ...d, primary: value as ModelPolicy['primary'] } : { ...d, fallback: value }));
  };

  const summary = useMemo(() => describe(draft, effectiveModel, providers, t), [draft, effectiveModel, providers, t]);

  return (
    <section className="rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)] p-4">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-medium">{t('heading')}</h2>
        {saved !== null && (
          <span className="text-xs text-[color:var(--fg-muted)]">{summary}</span>
        )}
      </div>
      <p className="mb-3 text-xs text-[color:var(--fg-muted)]">{t('hint')}</p>

      {error && (
        <div
          role="alert"
          className="mb-3 rounded border border-[color:var(--danger-edge)] bg-[color:var(--danger)]/8 p-3 text-sm text-[color:var(--danger)]"
        >
          {error}
        </div>
      )}

      {loading && saved === null && !error && (
        <p className="text-sm text-[color:var(--fg-muted)]">{t('loading')}</p>
      )}

      {saved !== null && (
        <>
          <SlotEditor
            slot="primary"
            slug={props.slug}
            value={draft.primary}
            effectiveModel={effectiveModel}
            providers={providers}
            disabled={saving}
            onChange={(v) => setSlot('primary', v)}
            t={t}
          />
          <SlotEditor
            slot="fallback"
            slug={props.slug}
            value={draft.fallback}
            effectiveModel={effectiveModel}
            providers={providers}
            disabled={saving}
            onChange={(v) => setSlot('fallback', v)}
            t={t}
          />

          <div className="mt-3 flex flex-col gap-1 text-xs">
            {sameRef && (
              <p className="text-[color:var(--danger)]">{t('sameRef')}</p>
            )}
            {!sameRef && sameProvider && (
              <p className="text-[color:var(--warning)]">{t('sameProvider')}</p>
            )}
            {deferredProvider && (
              <p className="text-[color:var(--warning)]">
                {t('deferred', { provider: deferredProvider, active: activeProvider ?? '' })}
              </p>
            )}
            {vision.fallback === false && (
              <p className="text-[color:var(--warning)]">{t('fallbackNoVision')}</p>
            )}
            {vision.primary === false && (
              <p className="text-[color:var(--warning)]">{t('primaryNoVision')}</p>
            )}
          </div>

          <div className="mt-3 flex items-center gap-2">
            <Button
              size="sm"
              busy={saving}
              busyLabel={t('saving')}
              disabled={!canSave}
              onClick={() => void save()}
            >
              {t('save')}
            </Button>
            {!dirty && !saving && (
              <span className="text-xs text-[color:var(--fg-muted)]">{t('unchanged')}</span>
            )}
          </div>
        </>
      )}
    </section>
  );
}

type Tr = ReturnType<typeof useTranslations<'operatorAgents.modelPolicy'>>;

function SlotEditor(props: {
  slot: Slot;
  slug: string;
  value: ModelPolicy['primary'] | ModelPolicy['fallback'];
  effectiveModel: string | null;
  providers: BuilderProviderGroup[];
  disabled: boolean;
  onChange: (v: ModelPolicy['fallback']) => void;
  t: Tr;
}): React.ReactElement {
  const { slot, value, providers, disabled, onChange, t } = props;
  const ref = isModelRef(value) ? value : undefined;
  const mode: 'auto' | 'none' | 'ref' = ref ? 'ref' : value === 'none' ? 'none' : 'auto';
  const group = ref ? providers.find((p) => p.id === ref.provider) : undefined;
  const model = ref && group ? group.models.find((m) => m.model_id === ref.model) : undefined;
  const efforts = model?.effort_levels ?? [];
  const firstUsable = providers.find((p) => p.usable) ?? providers[0];
  const name = `model-policy-${slot}-${props.slug}`;

  const toRef = (provider: string, modelId?: string, effort?: string): ModelRef => {
    const grp = providers.find((p) => p.id === provider);
    const m = (modelId && grp?.models.find((x) => x.model_id === modelId)) || grp?.models[0];
    const levels = m?.effort_levels ?? [];
    return {
      provider,
      model: m?.model_id ?? modelId ?? '',
      ...(effort && (levels as readonly string[]).includes(effort)
        ? { effort: effort as ModelPolicyEffort }
        : {}),
    };
  };

  return (
    <fieldset className="mt-3 flex flex-col gap-2 rounded border border-[color:var(--border)]/60 p-3">
      <legend className="px-1 text-sm font-medium text-[color:var(--fg-strong)]">
        {t(`${slot}.label`)}
      </legend>
      <label className="flex cursor-pointer items-start gap-2 text-sm">
        <input
          type="radio"
          className="mt-1"
          name={name}
          checked={mode === 'auto'}
          disabled={disabled}
          onChange={() => onChange('auto')}
        />
        <span>
          <span className="font-medium">{t('auto')}</span>
          <span className="block text-xs text-[color:var(--fg-muted)]">
            {props.effectiveModel
              ? t('autoResolves', { model: props.effectiveModel })
              : t('autoUnknown')}
          </span>
        </span>
      </label>
      {slot === 'fallback' && (
        <label className="flex cursor-pointer items-start gap-2 text-sm">
          <input
            type="radio"
            className="mt-1"
            name={name}
            checked={mode === 'none'}
            disabled={disabled}
            onChange={() => onChange('none')}
          />
          <span>
            <span className="font-medium">{t('none')}</span>
            <span className="block text-xs text-[color:var(--fg-muted)]">{t('noneHint')}</span>
          </span>
        </label>
      )}
      <label className="flex cursor-pointer items-start gap-2 text-sm">
        <input
          type="radio"
          className="mt-1"
          name={name}
          checked={mode === 'ref'}
          disabled={disabled || !firstUsable}
          onChange={() => firstUsable && onChange(toRef(firstUsable.id))}
        />
        <span className="flex-1">
          <span className="font-medium">{t('specific')}</span>
          {mode === 'ref' && ref && (
            <span className="mt-2 flex flex-wrap items-center gap-2">
              <select
                className="rounded border border-[color:var(--border)] bg-[color:var(--bg)] px-2 py-1 text-sm"
                value={ref.provider}
                disabled={disabled}
                onChange={(e) => onChange(toRef(e.target.value))}
                aria-label={t('providerLabel')}
              >
                {providers.map((p) => (
                  <option key={p.id} value={p.id} disabled={!p.usable}>
                    {p.usable ? p.id : t('providerNoKey', { provider: p.id })}
                  </option>
                ))}
              </select>
              <select
                className="rounded border border-[color:var(--border)] bg-[color:var(--bg)] px-2 py-1 text-sm"
                value={ref.model}
                disabled={disabled || !group}
                onChange={(e) => onChange(toRef(ref.provider, e.target.value, ref.effort))}
                aria-label={t('modelLabel')}
              >
                {(group?.models ?? []).map((m) => (
                  <option key={m.id} value={m.model_id}>
                    {m.label}
                  </option>
                ))}
              </select>
              {efforts.length > 0 && (
                <select
                  className="rounded border border-[color:var(--border)] bg-[color:var(--bg)] px-2 py-1 text-sm"
                  value={ref.effort ?? ''}
                  disabled={disabled}
                  onChange={(e) => onChange(toRef(ref.provider, ref.model, e.target.value || undefined))}
                  aria-label={t('effortLabel')}
                >
                  <option value="">{t('effortDefault')}</option>
                  {efforts.map((lvl) => (
                    <option key={lvl} value={lvl}>
                      {t(`effort.${lvl}`)}
                    </option>
                  ))}
                </select>
              )}
              {group && !group.usable && (
                <a
                  href="/admin/providers"
                  className="text-xs text-[color:var(--accent)] hover:underline"
                >
                  {t('configureProvider')}
                </a>
              )}
            </span>
          )}
        </span>
      </label>
    </fieldset>
  );
}

/** A pre-W1 middleware sends only the scoped `models` list: group it. */
function groupLegacy(models: BuilderModelInfo[]): BuilderProviderGroup[] {
  const byProvider = new Map<string, BuilderModelInfo[]>();
  for (const m of models) byProvider.set(m.provider, [...(byProvider.get(m.provider) ?? []), m]);
  return [...byProvider.entries()].map(([id, ms]) => ({ id, usable: true, active: false, models: ms }));
}

function labelOf(ref: ModelRef, providers: BuilderProviderGroup[]): string {
  const m = providers.find((p) => p.id === ref.provider)?.models.find((x) => x.model_id === ref.model);
  return m?.label ?? `${ref.provider}:${ref.model}`;
}

function describe(
  policy: ModelPolicy,
  effectiveModel: string | null,
  providers: BuilderProviderGroup[],
  t: Tr,
): string {
  const primary = isModelRef(policy.primary)
    ? labelOf(policy.primary, providers) + (policy.primary.effort ? ` (${t(`effort.${policy.primary.effort}`)})` : '')
    : effectiveModel
      ? t('summaryAuto', { model: effectiveModel })
      : t('auto');
  if (policy.fallback === 'none') return t('summaryNoFallback', { primary });
  const fallback = isModelRef(policy.fallback)
    ? labelOf(policy.fallback, providers)
    : effectiveModel
      ? t('summaryAuto', { model: effectiveModel })
      : t('auto');
  return t('summaryWithFallback', { primary, fallback });
}
