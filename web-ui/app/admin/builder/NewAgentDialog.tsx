'use client';

import { useEffect, useId, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import { AgentAvailabilityEditor } from '@/app/_components/agents/AgentAvailabilityEditor';
import { useBroadReachConfirm } from '@/app/_components/agents/useBroadReachConfirm';
import {
  NEW_AGENT_AVAILABILITY,
  setAgentAvailability,
  type AgentAvailability,
} from '../../_lib/agentAvailability';
import {
  runAgentCreateFlow,
  slugFromName,
  type AgentCreateResult,
} from '../../_lib/agentCreateFlow';
import { saveAgentIdentity } from '../../_lib/agentIdentity';
import {
  createOperatorAgent,
  patchOperatorAgent,
  replaceAgentPlugins,
  STANDARD_ARCHETYPE,
} from '../../_lib/agents';
import {
  getAgentTemplatePrefill,
  isOfferedCapability,
  listAgentTemplates,
  type AgentTemplatePrefillDto,
  type AgentTemplateSummaryDto,
} from '../../_lib/agentTemplates';
import { NewAgentOutcome } from './NewAgentOutcome';

export interface NewAgentDialogProps {
  onClose: () => void;
  /** The agent exists (enabled or as a draft); select it. */
  onCreated: (slug: string) => void;
}

type Templates =
  | { kind: 'loading' }
  | { kind: 'error'; detail: string }
  | { kind: 'ready'; items: AgentTemplateSummaryDto[] };

const BLANK = '';
const keyOf = (t: AgentTemplateSummaryDto): string => `${t.plugin_id}::${t.template_id}`;
const inputCls =
  'w-full rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)] px-2 py-1 text-sm';

/**
 * #2049 — "New agent" in the Agent Builder (spec 2042 §5.2, §5.10): blank or
 * from an agent template of an installed plugin. The template prefills name,
 * description and identity; the operator picks the capabilities to grant
 * (nothing is ticked for them, INV-8), says who may reach the agent and
 * whether to enable it now. Runs `runAgentCreateFlow`; a failed step is
 * named and the draft stays.
 */
export function NewAgentDialog({ onClose, onCreated }: NewAgentDialogProps): React.ReactElement {
  const t = useTranslations('admin.builder.newAgent');
  const broadReach = useBroadReachConfirm();
  const ids = {
    source: useId(),
    name: useId(),
    slug: useId(),
    description: useId(),
  };
  const [templates, setTemplates] = useState<Templates>({ kind: 'loading' });
  const [source, setSource] = useState(BLANK);
  const [prefill, setPrefill] = useState<AgentTemplatePrefillDto | null>(null);
  const [prefillError, setPrefillError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [availability, setAvailability] = useState<AgentAvailability>(NEW_AGENT_AVAILABILITY);
  const [enable, setEnable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AgentCreateResult | null>(null);

  useEffect(() => {
    let alive = true;
    listAgentTemplates()
      .then((items) => alive && setTemplates({ kind: 'ready', items }))
      .catch(
        (err: unknown) =>
          alive &&
          setTemplates({
            kind: 'error',
            detail: err instanceof Error ? err.message : String(err),
          }),
      );
    return () => {
      alive = false;
    };
  }, []);

  const applyName = (next: string): void => {
    setName(next);
    if (!slugTouched) setSlug(slugFromName(next));
  };

  const chooseSource = async (key: string): Promise<void> => {
    setSource(key);
    setPrefill(null);
    setPrefillError(null);
    setChosen(new Set());
    if (key === BLANK || templates.kind !== 'ready') return;
    const tpl = templates.items.find((x) => keyOf(x) === key);
    if (!tpl) return;
    try {
      const loaded = await getAgentTemplatePrefill(tpl.plugin_id, tpl.template_id);
      setPrefill(loaded);
      applyName(loaded.agent.name);
      setDescription(loaded.agent.description ?? '');
    } catch (err) {
      setPrefillError(err instanceof Error ? err.message : String(err));
    }
  };

  const toggle = (id: string): void =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    const agentName = name.trim();
    const outcome = await runAgentCreateFlow(
      {
        slug: slug.trim(),
        agent: {
          name: agentName,
          ...(description.trim() ? { description: description.trim() } : {}),
          archetype: prefill?.agent.archetype ?? STANDARD_ARCHETYPE,
        },
        identity: prefill ? { ...prefill.identity, accent_color: null, verbosity: null } : null,
        availability,
        pluginIds: [...chosen],
        enable,
      },
      {
        createDraft: (input) => createOperatorAgent(input),
        saveIdentity: (s, identity) => saveAgentIdentity(s, identity),
        setAvailability: (s, a) => setAgentAvailability(s, a),
        grant: async (s, pluginIds) =>
          (await broadReach.guard(agentName, async (confirm) => {
            await replaceAgentPlugins(
              s,
              pluginIds.map((id) => ({ id, enabled: true })),
              { confirmBroadReach: confirm },
            );
            return true;
          })) === true,
        enable: (s) => patchOperatorAgent(s, { status: 'enabled' }),
      },
    );
    setBusy(false);
    if (outcome.ok) onCreated(outcome.slug);
    else setResult(outcome);
  };

  const selectedTemplate =
    templates.kind === 'ready' ? templates.items.find((x) => keyOf(x) === source) : undefined;
  const templateBlocked = selectedTemplate !== undefined && !selectedTemplate.archetype_available;
  const waitingForPrefill = source !== BLANK && prefill === null;
  const canSubmit =
    !busy && !templateBlocked && !waitingForPrefill && name.trim() !== '' && slug.trim() !== '';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('title')}
      data-testid="new-agent-dialog"
      className="fixed inset-0 z-50 flex items-center justify-center bg-[color:var(--bg-modal-overlay)] p-4"
    >
      {broadReach.dialog}
      <div className="max-h-full w-full max-w-2xl overflow-y-auto rounded-lg border border-[color:var(--border)] bg-[color:var(--bg-elevated,var(--bg))] p-5 text-[color:var(--fg)] shadow-xl">
        <h2 className="text-lg font-semibold text-[color:var(--fg-strong)]">{t('title')}</h2>
        {result && !result.ok ? (
          <NewAgentOutcome result={result} onClose={onClose} onKeep={onCreated} />
        ) : (
          <form className="mt-4 space-y-4" onSubmit={(e) => void submit(e)}>
            <div>
              <label
                className="block text-xs font-medium text-[color:var(--fg-muted)]"
                htmlFor={ids.source}
              >
                {t('sourceLabel')}
              </label>
              <select
                id={ids.source}
                data-testid="new-agent-source"
                value={source}
                disabled={busy}
                onChange={(e) => void chooseSource(e.target.value)}
                className={inputCls}
              >
                <option value={BLANK}>{t('blank')}</option>
                {templates.kind === 'ready' &&
                  templates.items.map((tpl) => (
                    <option key={keyOf(tpl)} value={keyOf(tpl)}>
                      {t('templateOption', {
                        name: tpl.name,
                        plugin: tpl.plugin_name,
                      })}
                    </option>
                  ))}
              </select>
              <p
                className="mt-1 text-xs text-[color:var(--fg-muted)]"
                data-testid="new-agent-templates-state"
              >
                {templates.kind === 'loading' && t('templatesLoading')}
                {templates.kind === 'error' && t('templatesError', { detail: templates.detail })}
                {templates.kind === 'ready' && templates.items.length === 0 && t('templatesEmpty')}
                {source === BLANK &&
                  templates.kind === 'ready' &&
                  templates.items.length > 0 &&
                  t('blankHint')}
                {selectedTemplate?.short_description ?? ''}
              </p>
              {templateBlocked && (
                <p
                  role="alert"
                  className="text-xs text-[color:var(--danger)]"
                  data-testid="new-agent-archetype-unavailable"
                >
                  {t('archetypeUnavailable', {
                    archetype: selectedTemplate.archetype,
                  })}
                </p>
              )}
              {prefillError && (
                <p role="alert" className="text-xs text-[color:var(--danger)]">
                  {t('prefillError', { detail: prefillError })}
                </p>
              )}
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label
                  className="block text-xs font-medium text-[color:var(--fg-muted)]"
                  htmlFor={ids.name}
                >
                  {t('nameLabel')}
                </label>
                <input
                  id={ids.name}
                  data-testid="new-agent-name"
                  className={inputCls}
                  maxLength={120}
                  required
                  value={name}
                  disabled={busy}
                  onChange={(e) => applyName(e.target.value)}
                />
              </div>
              <div>
                <label
                  className="block text-xs font-medium text-[color:var(--fg-muted)]"
                  htmlFor={ids.slug}
                >
                  {t('slugLabel')}
                </label>
                <input
                  id={ids.slug}
                  data-testid="new-agent-slug"
                  className={inputCls}
                  maxLength={64}
                  required
                  pattern="[a-z0-9]+(-[a-z0-9]+)*"
                  value={slug}
                  disabled={busy}
                  onChange={(e) => {
                    setSlugTouched(true);
                    setSlug(e.target.value);
                  }}
                />
                <p className="mt-1 text-xs text-[color:var(--fg-muted)]">{t('slugHint')}</p>
              </div>
            </div>
            <div>
              <label
                className="block text-xs font-medium text-[color:var(--fg-muted)]"
                htmlFor={ids.description}
              >
                {t('descriptionLabel')}
              </label>
              <input
                id={ids.description}
                className={inputCls}
                maxLength={2000}
                value={description}
                disabled={busy}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>

            {prefill && (
              <fieldset className="text-sm" data-testid="new-agent-capabilities">
                <legend className="text-xs font-medium text-[color:var(--fg-muted)]">
                  {t('capabilitiesLabel')}
                </legend>
                <p className="text-xs text-[color:var(--fg-muted)]">{t('capabilitiesHint')}</p>
                {prefill.template.suggested_capabilities.length === 0 ? (
                  <p className="mt-1 text-xs text-[color:var(--fg-muted)]">
                    {t('capabilitiesNone')}
                  </p>
                ) : (
                  <ul className="mt-2 space-y-1">
                    {prefill.template.suggested_capabilities.map((c) => {
                      const offered = isOfferedCapability(c);
                      return (
                        <li key={c.plugin_id}>
                          <label className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              data-testid={`new-agent-capability-${c.plugin_id}`}
                              checked={chosen.has(c.plugin_id)}
                              disabled={busy || !offered}
                              onChange={() => toggle(c.plugin_id)}
                            />
                            <span>
                              {!c.installed
                                ? t('capabilityNotInstalled', {
                                    plugin: c.plugin_id,
                                  })
                                : !c.grantable
                                  ? t('capabilityNotGrantable', {
                                      plugin: c.plugin_id,
                                    })
                                  : c.plugin_id}
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </fieldset>
            )}

            <AgentAvailabilityEditor
              value={availability}
              onChange={setAvailability}
              disabled={busy}
            />

            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                data-testid="new-agent-enable"
                checked={enable}
                disabled={busy}
                onChange={(e) => setEnable(e.target.checked)}
              />
              <span>
                {t('enableLabel')}
                <span className="block text-xs text-[color:var(--fg-muted)]">
                  {t('enableHint')}
                </span>
              </span>
            </label>

            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={onClose} disabled={busy}>
                {t('cancel')}
              </Button>
              <Button type="submit" size="sm" data-testid="new-agent-create" disabled={!canSubmit}>
                {busy ? t('creating') : t('create')}
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
