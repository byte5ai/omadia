'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import { ConflictBanner } from '@/app/_components/persona/ConflictBanner';
import {
  AVATAR_ACCEPT,
  avatarPreviewUrl,
  deleteAgentAvatar,
  getAgentIdentity,
  saveAgentIdentity,
  uploadAgentAvatar,
  type AgentIdentityDto,
  type AgentIdentityInput,
  type AgentIdentityRepublishOutcome,
} from '../../../../_lib/agentIdentity';
import { parseOperatorAgentErrorCode } from '../../../../_lib/agents';
import type { QualityConfig } from '../../../../_lib/builderTypes';
import { detectPersonaConflicts } from '../../../../_lib/personaConflicts';
import type { PersonaConfig } from '../../../../_lib/personaTypes';
import { humanizeApiError } from '../../_components/AgentsDashboard';
import { AgentBoundariesEditor } from './AgentBoundariesEditor';
import { AgentPersonaEditor } from './AgentPersonaEditor';

/**
 * The agent's own identity (#914): who it is, how it sounds, what it must not
 * do — and the prompt all of that compiles to.
 *
 * THIS REPLACED THE BUILDER LINK. The section in this slot used to say
 * persona and behaviour were designed in the Agent Builder and link there
 * through a draft-matching heuristic that resolved nothing for any agent the
 * Builder never authored. The Builder authors agent PLUGINS; an agent's
 * character belongs to the agent, and this is where it is authored — with the
 * same 12-axis model, archetypes, culture presets and boundary library the
 * platform already speaks everywhere else.
 *
 * FOUR TABS, ONE SAVE. Profile / character / limits / prompt are four views
 * of ONE document: the server validates and compiles them together, and a
 * per-tab save would let an operator ship half a character. So the dirty
 * state and the save button live here, above the tabs, and switching tabs
 * never loses an edit.
 *
 * The compiled prompt is shown, not hidden. Twelve sliders that silently turn
 * into a paragraph are a guess; the same sliders next to the paragraph they
 * produce are a tool.
 *
 * The avatar keeps its own write path (upload / remove): a separate request
 * with a separate failure mode, which must not be able to fail a text edit.
 */
interface AgentIdentityProps {
  /** Slug of the agent whose identity is edited. */
  readonly slug: string;
}

/** The five authored text fields, as the form holds them (`''` = inherit). */
interface IdentityForm {
  displayName: string;
  shortDescription: string;
  longDescription: string;
  instructions: string;
  accentColor: string;
}

const EMPTY_FORM: IdentityForm = {
  displayName: '',
  shortDescription: '',
  longDescription: '',
  instructions: '',
  accentColor: '',
};

const TABS = ['profile', 'character', 'boundaries', 'prompt'] as const;
type IdentityTab = (typeof TABS)[number];

/** Server DTO → form. `null` (not authored) and `''` (cleared) are the same
 *  thing to the operator, so the form only ever holds strings. */
function toForm(dto: AgentIdentityDto): IdentityForm {
  const i = dto.identity;
  return {
    displayName: i.display_name ?? '',
    shortDescription: i.short_description ?? '',
    longDescription: i.long_description ?? '',
    instructions: i.instructions ?? '',
    accentColor: i.accent_color ?? '',
  };
}

/** Blank goes back as `null`: "inherit", not "empty". */
function trimmedOrNull(raw: string): string | null {
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function sameForm(a: IdentityForm, b: IdentityForm): boolean {
  return (
    a.displayName.trim() === b.displayName.trim() &&
    a.shortDescription.trim() === b.shortDescription.trim() &&
    a.longDescription.trim() === b.longDescription.trim() &&
    a.instructions.trim() === b.instructions.trim() &&
    a.accentColor.trim() === b.accentColor.trim()
  );
}

/** An empty document and an absent one mean the same thing to the server. */
function compact<T extends object>(value: T): T | null {
  return Object.keys(value).length > 0 ? value : null;
}

const FIELD_CLASS =
  'w-full rounded border border-[color:var(--border)] bg-[color:var(--bg-soft)]/40 px-3 py-2 text-sm';
const LABEL_CLASS = 'mb-1 block text-xs font-medium';
const HINT_CLASS = 'mt-1 text-[11px] text-[color:var(--fg-muted)]';

export function AgentIdentity(props: AgentIdentityProps): React.ReactElement {
  const t = useTranslations('operatorAgents.identity');
  // Errors come from the page-wide catalogue, not a second one of this
  // section's own: every operator-agents surface maps the same machine codes,
  // and two catalogues would drift the moment a route grows a code.
  const tError = useTranslations('operatorAgents');
  const [dto, setDto] = useState<AgentIdentityDto | null>(null);
  const [tab, setTab] = useState<IdentityTab>('profile');
  const [form, setForm] = useState<IdentityForm>(EMPTY_FORM);
  const [savedForm, setSavedForm] = useState<IdentityForm>(EMPTY_FORM);
  const [persona, setPersona] = useState<PersonaConfig>({});
  const [savedPersona, setSavedPersona] = useState<PersonaConfig>({});
  const [quality, setQuality] = useState<QualityConfig>({});
  const [savedQuality, setSavedQuality] = useState<QualityConfig>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'save' | 'avatar' | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Last write's Teams outcome. Cleared on the next edit — a stale "queued"
   *  next to an unsaved change would claim something that did not happen. */
  const [republish, setRepublish] =
    useState<AgentIdentityRepublishOutcome | null>(null);
  const [droppedPresets, setDroppedPresets] = useState<readonly string[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  const localizeError = useCallback(
    (err: unknown): string => {
      const code = parseOperatorAgentErrorCode(err);
      return code !== null
        ? tError(`detailErrors.${code}`)
        : tError('detailErrors.unknown', { detail: humanizeApiError(err) });
    },
    [tError],
  );

  const apply = useCallback((next: AgentIdentityDto): void => {
    setDto(next);
    const asForm = toForm(next);
    setForm(asForm);
    setSavedForm(asForm);
    const nextPersona = next.identity.persona ?? {};
    setPersona(nextPersona);
    setSavedPersona(nextPersona);
    const nextQuality = next.identity.quality ?? {};
    setQuality(nextQuality);
    setSavedQuality(nextQuality);
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      apply(await getAgentIdentity(props.slug));
      setError(null);
    } catch (err: unknown) {
      setError(localizeError(err));
    } finally {
      setLoading(false);
    }
  }, [props.slug, apply, localizeError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const dirty = useMemo(
    () =>
      !sameForm(form, savedForm) ||
      JSON.stringify(persona) !== JSON.stringify(savedPersona) ||
      JSON.stringify(quality) !== JSON.stringify(savedQuality),
    [form, savedForm, persona, savedPersona, quality, savedQuality],
  );

  /** Conflicts between the character and its limits — the same detector the
   *  Builder uses, so both surfaces warn about the same combinations. */
  const warnings = useMemo(
    () => detectPersonaConflicts(quality, persona),
    [quality, persona],
  );

  function editField<K extends keyof IdentityForm>(
    key: K,
    value: string,
  ): void {
    setRepublish(null);
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  const payload = useCallback(
    (): AgentIdentityInput => ({
      display_name: trimmedOrNull(form.displayName),
      short_description: trimmedOrNull(form.shortDescription),
      long_description: trimmedOrNull(form.longDescription),
      instructions: trimmedOrNull(form.instructions),
      accent_color: trimmedOrNull(form.accentColor),
      persona: compact(persona),
      quality: compact(quality),
    }),
    [form, persona, quality],
  );

  const save = useCallback(async (): Promise<void> => {
    setBusy('save');
    try {
      const res = await saveAgentIdentity(props.slug, payload());
      apply(res);
      setRepublish(res.republish);
      setDroppedPresets(res.dropped_boundary_presets ?? []);
      setError(null);
    } catch (err: unknown) {
      // The operator's edits stay in the form: re-reading the server value
      // here would erase the change the failed write was for.
      setError(localizeError(err));
    } finally {
      setBusy(null);
    }
  }, [props.slug, payload, apply, localizeError]);

  const upload = useCallback(
    async (file: File): Promise<void> => {
      setBusy('avatar');
      try {
        const res = await uploadAgentAvatar(props.slug, file);
        apply(res);
        setRepublish(res.republish);
        setError(null);
      } catch (err: unknown) {
        setError(localizeError(err));
      } finally {
        setBusy(null);
        // Let the same file be picked again after a failure.
        if (fileInput.current) fileInput.current.value = '';
      }
    },
    [props.slug, apply, localizeError],
  );

  const removeAvatar = useCallback(async (): Promise<void> => {
    setBusy('avatar');
    try {
      const res = await deleteAgentAvatar(props.slug);
      apply(res);
      setRepublish(res.republish);
      setError(null);
    } catch (err: unknown) {
      setError(localizeError(err));
    } finally {
      setBusy(null);
    }
  }, [props.slug, apply, localizeError]);

  const previewUrl = dto ? avatarPreviewUrl(dto.identity) : null;
  const disabled = busy !== null;

  return (
    <section className="rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)] p-4">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-medium">{t('heading')}</h2>
        {dto && (
          <span className="text-[11px] text-[color:var(--fg-muted)]">
            {t('revision', { revision: dto.identity.revision })}
          </span>
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

      {loading && dto === null && !error && (
        <p className="text-sm text-[color:var(--fg-muted)]">{t('loading')}</p>
      )}

      {dto && (
        <>
          {/* Conflicts are rendered above the tabs on purpose: a warning
              about a combination of character and limits belongs to neither
              tab alone, and hiding it behind one would hide it from the
              operator who caused it in the other. */}
          <ConflictBanner warnings={warnings} />

          <div
            role="tablist"
            aria-label={t('heading')}
            className="mb-4 flex flex-wrap gap-1 border-b border-[color:var(--border)]"
          >
            {TABS.map((id) => (
              // eslint-disable-next-line no-restricted-syntax -- tab, not a §4.2 CTA
              <button
                key={id}
                type="button"
                role="tab"
                id={`agent-identity-tab-${id}`}
                aria-selected={tab === id}
                aria-controls={`agent-identity-panel-${id}`}
                data-testid={`agent-identity-tab-${id}`}
                onClick={() => setTab(id)}
                className={`-mb-px border-b-2 px-3 py-2 text-xs font-medium transition-colors ${
                  tab === id
                    ? 'border-[color:var(--accent)] text-[color:var(--accent)]'
                    : 'border-transparent text-[color:var(--fg-muted)] hover:text-[color:var(--fg)]'
                }`}
              >
                {t(`tabs.${id}`)}
              </button>
            ))}
          </div>

          <div
            role="tabpanel"
            id={`agent-identity-panel-${tab}`}
            aria-labelledby={`agent-identity-tab-${tab}`}
          >
            {tab === 'profile' && (
              <>
                <div className="mb-4 flex flex-wrap items-start gap-4">
                  <div
                    className="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded border border-[color:var(--border)] bg-[color:var(--bg-soft)]/60"
                    data-testid="agent-identity-avatar"
                  >
                    {previewUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={previewUrl}
                        alt={t('avatarAlt', {
                          name: dto.resolved.display_name,
                        })}
                        className="size-full object-cover"
                      />
                    ) : (
                      <span className="text-[11px] uppercase tracking-[0.14em] text-[color:var(--fg-muted)]">
                        {t('avatarNone')}
                      </span>
                    )}
                  </div>
                  <div className="min-w-[16rem] flex-1">
                    <p className="text-sm font-medium">
                      {dto.resolved.display_name}
                    </p>
                    <p className={HINT_CLASS}>{t('avatarHint')}</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <input
                        ref={fileInput}
                        type="file"
                        accept={AVATAR_ACCEPT}
                        className="hidden"
                        aria-label={t('avatarUpload')}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) void upload(file);
                        }}
                      />
                      <Button
                        type="button"
                        variant="secondary"
                        disabled={disabled}
                        onClick={() => fileInput.current?.click()}
                      >
                        {busy === 'avatar'
                          ? t('avatarBusy')
                          : t('avatarUpload')}
                      </Button>
                      {dto.identity.avatar && (
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={disabled}
                          onClick={() => void removeAvatar()}
                        >
                          {t('avatarRemove')}
                        </Button>
                      )}
                    </div>
                  </div>
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <div>
                    <label
                      className={LABEL_CLASS}
                      htmlFor="agent-identity-name"
                    >
                      {t('fields.displayName')}
                    </label>
                    <input
                      id="agent-identity-name"
                      className={FIELD_CLASS}
                      value={form.displayName}
                      maxLength={120}
                      placeholder={dto.resolved.display_name}
                      disabled={disabled}
                      onChange={(e) => editField('displayName', e.target.value)}
                    />
                    <p className={HINT_CLASS}>{t('fields.displayNameHint')}</p>
                  </div>
                  <div>
                    <label
                      className={LABEL_CLASS}
                      htmlFor="agent-identity-accent"
                    >
                      {t('fields.accentColor')}
                    </label>
                    <input
                      id="agent-identity-accent"
                      className={FIELD_CLASS}
                      value={form.accentColor}
                      maxLength={7}
                      placeholder="#714B67"
                      disabled={disabled}
                      onChange={(e) => editField('accentColor', e.target.value)}
                    />
                    <p className={HINT_CLASS}>{t('fields.accentColorHint')}</p>
                  </div>
                  <div className="md:col-span-2">
                    <label
                      className={LABEL_CLASS}
                      htmlFor="agent-identity-short"
                    >
                      {t('fields.shortDescription')}
                    </label>
                    <input
                      id="agent-identity-short"
                      className={FIELD_CLASS}
                      value={form.shortDescription}
                      maxLength={80}
                      disabled={disabled}
                      onChange={(e) =>
                        editField('shortDescription', e.target.value)
                      }
                    />
                    <p className={HINT_CLASS}>
                      {t('fields.shortDescriptionHint')}
                    </p>
                  </div>
                  <div className="md:col-span-2">
                    <label
                      className={LABEL_CLASS}
                      htmlFor="agent-identity-long"
                    >
                      {t('fields.longDescription')}
                    </label>
                    <textarea
                      id="agent-identity-long"
                      className={`${FIELD_CLASS} min-h-[5rem]`}
                      value={form.longDescription}
                      maxLength={4000}
                      disabled={disabled}
                      onChange={(e) =>
                        editField('longDescription', e.target.value)
                      }
                    />
                  </div>
                </div>
              </>
            )}

            {tab === 'character' && (
              <div className="space-y-5">
                <div>
                  <label
                    className={LABEL_CLASS}
                    htmlFor="agent-identity-instructions"
                  >
                    {t('fields.instructions')}
                  </label>
                  <textarea
                    id="agent-identity-instructions"
                    className={`${FIELD_CLASS} min-h-[7rem] font-mono text-xs`}
                    value={form.instructions}
                    maxLength={20000}
                    disabled={disabled}
                    onChange={(e) => editField('instructions', e.target.value)}
                  />
                  <p className={HINT_CLASS}>{t('fields.instructionsHint')}</p>
                </div>
                <AgentPersonaEditor
                  value={persona}
                  onChange={(next) => {
                    setRepublish(null);
                    setPersona(next);
                  }}
                  warnings={warnings}
                  {...(disabled ? { disabled: true } : {})}
                />
              </div>
            )}

            {tab === 'boundaries' && (
              <AgentBoundariesEditor
                value={quality}
                onChange={(next) => {
                  setRepublish(null);
                  setQuality(next);
                }}
                {...(disabled ? { disabled: true } : {})}
              />
            )}

            {tab === 'prompt' && (
              <div className="space-y-2">
                <p className="text-xs text-[color:var(--fg-muted)]">
                  {dto.composed_family
                    ? t('prompt.hintWithFamily', {
                        family: dto.composed_family,
                      })
                    : t('prompt.hint')}
                </p>
                {dirty && (
                  <p className="text-[11px] text-[color:var(--warning)]">
                    {t('prompt.stale')}
                  </p>
                )}
                <pre
                  data-testid="agent-identity-composed-prompt"
                  className="max-h-[28rem] overflow-auto whitespace-pre-wrap rounded border border-[color:var(--border)] bg-[color:var(--bg-soft)]/40 p-3 font-mono text-[11px] leading-relaxed"
                >
                  {dto.composed_prompt ?? t('prompt.empty')}
                </pre>
              </div>
            )}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-[color:var(--border)] pt-3">
            <Button
              type="button"
              disabled={!dirty || disabled}
              onClick={() => void save()}
            >
              {busy === 'save' ? t('saving') : t('save')}
            </Button>
            {dirty && (
              <span className="text-xs text-[color:var(--fg-muted)]">
                {t('unsaved')}
              </span>
            )}
            {!dirty && republish !== null && (
              <span
                data-testid="agent-identity-republish"
                className="text-xs text-[color:var(--fg-muted)]"
              >
                {t(`republish.${republish}`)}
              </span>
            )}
            {!dirty && droppedPresets.length > 0 && (
              <span
                data-testid="agent-identity-dropped-presets"
                className="text-xs text-[color:var(--warning)]"
              >
                {t('droppedPresets', { ids: droppedPresets.join(', ') })}
              </span>
            )}
          </div>
        </>
      )}
    </section>
  );
}
