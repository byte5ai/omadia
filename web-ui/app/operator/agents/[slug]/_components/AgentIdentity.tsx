'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
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
import { humanizeApiError } from '../../_components/AgentsDashboard';

/**
 * The agent's own identity (#914) — name, descriptions, behaviour, accent
 * colour, avatar.
 *
 * THIS REPLACES THE BUILDER LINK. Before this component the section in this
 * slot said persona and behaviour were designed in the Agent Builder and
 * linked there through a draft-matching heuristic that could not resolve a
 * draft for any agent the Builder never authored — which is most of them. The
 * Builder authors agent PLUGINS; an agent's identity is a property of the
 * deployed agent, and this is where it is authored. There is deliberately no
 * link back: the two are separate concerns, and a link would re-suggest they
 * are one.
 *
 * EMPTY MEANS INHERIT, and the placeholders say what would be inherited: the
 * server returns the authored values AND the resolved ones, so the form can
 * show "leave this empty and the agent is still called X" without deriving
 * the fallback a second time.
 *
 * The avatar is its own write path (upload / remove), not a form field: it is
 * a separate request with a separate failure mode, and folding it into save
 * would mean an unrelated text edit could fail on an image.
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

/** Form → server DTO. Blank goes back as `null`: "inherit", not "empty". */
function toInput(form: IdentityForm): AgentIdentityInput {
  const value = (raw: string): string | null => {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  };
  return {
    display_name: value(form.displayName),
    short_description: value(form.shortDescription),
    long_description: value(form.longDescription),
    instructions: value(form.instructions),
    accent_color: value(form.accentColor),
  };
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
  const [form, setForm] = useState<IdentityForm>(EMPTY_FORM);
  const [saved, setSaved] = useState<IdentityForm>(EMPTY_FORM);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'save' | 'avatar' | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Last write's Teams outcome. Cleared on the next edit — a stale "queued"
   *  next to an unsaved change would claim something that did not happen. */
  const [republish, setRepublish] =
    useState<AgentIdentityRepublishOutcome | null>(null);
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
    setSaved(asForm);
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

  const dirty = useMemo(() => !sameForm(form, saved), [form, saved]);

  function edit<K extends keyof IdentityForm>(key: K, value: string): void {
    setRepublish(null);
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  const save = useCallback(async (): Promise<void> => {
    setBusy('save');
    try {
      const res = await saveAgentIdentity(props.slug, toInput(form));
      apply(res);
      setRepublish(res.republish);
      setError(null);
    } catch (err: unknown) {
      // The operator's edits stay in the form: re-reading the server value
      // here would erase the change the failed write was for.
      setError(localizeError(err));
    } finally {
      setBusy(null);
    }
  }, [props.slug, form, apply, localizeError]);

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
      <h2 className="mb-1 text-lg font-medium">{t('heading')}</h2>
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
          <div className="mb-4 flex flex-wrap items-start gap-4">
            <div
              className="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded border border-[color:var(--border)] bg-[color:var(--bg-soft)]/60"
              data-testid="agent-identity-avatar"
            >
              {previewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={previewUrl}
                  alt={t('avatarAlt', { name: dto.resolved.display_name })}
                  className="size-full object-cover"
                />
              ) : (
                <span className="text-[11px] uppercase tracking-[0.14em] text-[color:var(--fg-muted)]">
                  {t('avatarNone')}
                </span>
              )}
            </div>
            <div className="min-w-[16rem] flex-1">
              <p className="text-sm font-medium">{dto.resolved.display_name}</p>
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
                  {busy === 'avatar' ? t('avatarBusy') : t('avatarUpload')}
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
              <label className={LABEL_CLASS} htmlFor="agent-identity-name">
                {t('fields.displayName')}
              </label>
              <input
                id="agent-identity-name"
                className={FIELD_CLASS}
                value={form.displayName}
                maxLength={120}
                placeholder={dto.resolved.display_name}
                disabled={disabled}
                onChange={(e) => edit('displayName', e.target.value)}
              />
              <p className={HINT_CLASS}>{t('fields.displayNameHint')}</p>
            </div>
            <div>
              <label className={LABEL_CLASS} htmlFor="agent-identity-accent">
                {t('fields.accentColor')}
              </label>
              <input
                id="agent-identity-accent"
                className={FIELD_CLASS}
                value={form.accentColor}
                maxLength={7}
                placeholder="#714B67"
                disabled={disabled}
                onChange={(e) => edit('accentColor', e.target.value)}
              />
              <p className={HINT_CLASS}>{t('fields.accentColorHint')}</p>
            </div>
            <div className="md:col-span-2">
              <label className={LABEL_CLASS} htmlFor="agent-identity-short">
                {t('fields.shortDescription')}
              </label>
              <input
                id="agent-identity-short"
                className={FIELD_CLASS}
                value={form.shortDescription}
                maxLength={80}
                disabled={disabled}
                onChange={(e) => edit('shortDescription', e.target.value)}
              />
              <p className={HINT_CLASS}>{t('fields.shortDescriptionHint')}</p>
            </div>
            <div className="md:col-span-2">
              <label className={LABEL_CLASS} htmlFor="agent-identity-long">
                {t('fields.longDescription')}
              </label>
              <textarea
                id="agent-identity-long"
                className={`${FIELD_CLASS} min-h-[5rem]`}
                value={form.longDescription}
                maxLength={4000}
                disabled={disabled}
                onChange={(e) => edit('longDescription', e.target.value)}
              />
            </div>
            <div className="md:col-span-2">
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
                onChange={(e) => edit('instructions', e.target.value)}
              />
              <p className={HINT_CLASS}>{t('fields.instructionsHint')}</p>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-3">
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
          </div>
        </>
      )}
    </section>
  );
}
