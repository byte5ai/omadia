'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import {
  ApiError,
  createConductorTemplate,
  fetchConductorTemplate,
  saveWorkflowAsTemplate,
  updateConductorTemplate,
  type ConductorLocalizedText,
  type ConductorTemplate,
} from '@/app/_lib/api';

import { gcLbl } from './GuidedControls';

/**
 * Save-as-template dialog (#478 F1): authoring UX over the backend's inference
 * draft. POST /:slug/save-as-template returns a manifest whose concrete refs were
 * replaced by declared slots (proposed label = the original ref); the author edits
 * metadata + slot labels, optionally declares text slots, and publishes.
 *
 * Owner-aware primary action (the v2-publish path): the entered id is resolved
 * against the loaded catalog — unused id → POST "Publish template"; an existing
 * USER template owned by the viewer → PUT "Publish as v{latestVersion+1}"; any
 * other collision (bundled/plugin/foreign) → inline "id taken" error. A 409 race
 * on POST re-fetches the template and, when it turns out viewer-owned, switches
 * the dialog into the PUT state instead of dead-ending.
 *
 * Lume: state colors are TEXT and EDGE only, in-flight is the Button busy recipe
 * (verb + animated dots, never a spinner), loading uses .lume-skeleton.
 */

type RefKind = 'roles' | 'agents' | 'actions' | 'events' | 'channels';

/** Render order — matches the instantiate form's grouping order. */
const REF_KINDS: readonly RefKind[] = ['roles', 'agents', 'actions', 'events', 'channels'];

const KIND_BADGE_KEY: Record<RefKind, string> = {
  roles: 'templateSlotGroupRoles',
  agents: 'templateSlotGroupAgents',
  actions: 'templateSlotGroupActions',
  events: 'templateSlotGroupEvents',
  channels: 'templateSlotGroupChannels',
};

/** Template ids are kebab-case machine identifiers (mirrors the bundled catalog). */
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** conductor-core's text-slot token grammar. */
const TEXT_KEY_RE = /^[A-Za-z0-9_-]+$/;

interface EditableRefSlot {
  kind: RefKind;
  key: string;
  /** the concrete ref the slot replaced — the draft proposes it as the label. */
  originalRef: string;
  labelEn: string;
  labelDe: string;
}

interface EditableTextSlot {
  key: string;
  labelEn: string;
  labelDe: string;
  defaultValue: string;
}

function textEn(value: ConductorLocalizedText): string {
  return typeof value === 'string' ? value : value.en;
}

function textDe(value: ConductorLocalizedText): string {
  return typeof value === 'string' ? '' : (value.de ?? '');
}

/** en + optional de → manifest LocalizedText (plain string = English-only). */
function loc(en: string, de: string): ConductorLocalizedText {
  const d = de.trim();
  return d ? { en: en.trim(), de: d } : en.trim();
}

/** Wire shape of the template error envelopes (parsed out of ApiError.body). */
interface TemplateErrorBody {
  code?: string;
  message?: string;
  errors?: Array<{ message: string }>;
}

function parseErrorBody(raw: string): TemplateErrorBody {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as TemplateErrorBody) : {};
  } catch {
    return {};
  }
}

const FIELD_BASE = 'w-full rounded-md border bg-transparent px-2 py-1 text-[13px] text-[color:var(--fg-strong)]';

function fieldClass(invalid: boolean): string {
  return `${FIELD_BASE} ${invalid ? 'border-[color:var(--danger-edge)]' : 'border-[color:var(--border)]'}`;
}

/** Kind badge — text + edge only, never a filled pill (Lume state-color rule). */
const BADGE =
  'rounded-full border border-[color:var(--border-strong)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]';

export interface SaveAsTemplateDialogProps {
  workflowSlug: string;
  /** loaded catalog (viewer-scoped: includes the viewer's own templates in every
   *  status) — the ownership pre-check resolves the entered id against it. */
  templates: ConductorTemplate[];
  /** backend viewer identity (AuthUser.id = session sub); null while unknown. */
  viewer: string | null;
  onPublished: (result: { id: string; version: number }) => void;
  onCancel: () => void;
}

export function SaveAsTemplateDialog({
  workflowSlug,
  templates,
  viewer,
  onPublished,
  onCancel,
}: SaveAsTemplateDialogProps): React.JSX.Element {
  const t = useTranslations('conductor');

  const [draft, setDraft] = useState<ConductorTemplate | null>(null);
  const [idValue, setIdValue] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [nameDe, setNameDe] = useState('');
  const [descEn, setDescEn] = useState('');
  const [descDe, setDescDe] = useState('');
  const [useCaseEn, setUseCaseEn] = useState('');
  const [useCaseDe, setUseCaseDe] = useState('');
  const [refSlots, setRefSlots] = useState<EditableRefSlot[]>([]);
  const [textSlots, setTextSlots] = useState<EditableTextSlot[]>([]);
  const [pending, setPending] = useState(false);
  // 409-race recovery: the re-fetched, viewer-owned template overrides the (stale)
  // catalog lookup so the dialog can switch into "Publish as v{n+1}" mode.
  const [raceOwned, setRaceOwned] = useState<ConductorTemplate | null>(null);
  const [idError, setIdError] = useState<string | null>(null);
  const [manifestErrors, setManifestErrors] = useState<string[]>([]);
  const [genericError, setGenericError] = useState<string | null>(null);

  // Fetch the inference draft once per workflow (the dialog is re-keyed per slug).
  useEffect(() => {
    let cancelled = false;
    saveWorkflowAsTemplate(workflowSlug)
      .then(({ draft: inferred }) => {
        if (cancelled) return;
        setDraft(inferred);
        setIdValue(inferred.id);
        setNameEn(textEn(inferred.name));
        setNameDe(textDe(inferred.name));
        setDescEn(textEn(inferred.description));
        setDescDe(textDe(inferred.description));
        setUseCaseEn(textEn(inferred.useCase));
        setUseCaseDe(textDe(inferred.useCase));
        setRefSlots(
          REF_KINDS.flatMap((kind) =>
            (inferred.slots[kind] ?? []).map((slot) => ({
              kind,
              key: slot.key,
              originalRef: textEn(slot.label),
              labelEn: textEn(slot.label),
              labelDe: textDe(slot.label),
            })),
          ),
        );
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setGenericError(t('templateRequestFailed', { message: err instanceof Error ? err.message : String(err) }));
      });
    return () => {
      cancelled = true;
    };
  }, [workflowSlug, t]);

  const trimmedId = idValue.trim();

  // Ownership pre-check against the loaded catalog, overridden by a 409-race
  // re-fetch. Under B2 the viewer-scoped list contains the viewer's own templates
  // in every status, so an owned id is always resolvable here.
  const existing = useMemo(() => {
    if (raceOwned && raceOwned.id === trimmedId) return raceOwned;
    return templates.find((tpl) => tpl.id === trimmedId);
  }, [templates, trimmedId, raceOwned]);

  const publishMode: { kind: 'create' } | { kind: 'version'; next: number } | { kind: 'taken' } = useMemo(() => {
    if (!existing) return { kind: 'create' };
    if (existing.source === 'user' && viewer !== null && existing.createdBy === viewer) {
      return { kind: 'version', next: (existing.latestVersion ?? existing.version ?? 1) + 1 };
    }
    return { kind: 'taken' };
  }, [existing, viewer]);

  const idInvalid = trimmedId.length > 0 && !ID_RE.test(trimmedId);
  // Every localizable field needs its English base (the universal fallback).
  const enMissing =
    nameEn.trim().length === 0 ||
    descEn.trim().length === 0 ||
    useCaseEn.trim().length === 0 ||
    refSlots.some((slot) => slot.labelEn.trim().length === 0) ||
    textSlots.some((slot) => slot.labelEn.trim().length === 0);
  const textKeysInvalid =
    textSlots.some((slot) => !TEXT_KEY_RE.test(slot.key.trim())) ||
    new Set(textSlots.map((slot) => slot.key.trim())).size !== textSlots.length;

  const submitBlocked =
    draft === null || pending || trimmedId.length === 0 || idInvalid || enMissing || textKeysInvalid || publishMode.kind === 'taken';

  const setRefSlot = (index: number, patch: Partial<EditableRefSlot>): void => {
    setRefSlots((slots) => slots.map((slot, i) => (i === index ? { ...slot, ...patch } : slot)));
  };

  const setTextSlot = (index: number, patch: Partial<EditableTextSlot>): void => {
    setTextSlots((slots) => slots.map((slot, i) => (i === index ? { ...slot, ...patch } : slot)));
  };

  const buildManifest = (base: ConductorTemplate): ConductorTemplate => {
    const slots: ConductorTemplate['slots'] = {};
    for (const kind of REF_KINDS) {
      const declared = refSlots.filter((slot) => slot.kind === kind);
      if (declared.length > 0) {
        slots[kind] = declared.map((slot) => ({ key: slot.key, label: loc(slot.labelEn, slot.labelDe) }));
      }
    }
    if (textSlots.length > 0) {
      slots.text = textSlots.map((slot) => ({
        key: slot.key.trim(),
        label: loc(slot.labelEn, slot.labelDe),
        ...(slot.defaultValue.trim().length > 0 ? { default: slot.defaultValue } : {}),
      }));
    }
    return {
      id: trimmedId,
      name: loc(nameEn, nameDe),
      description: loc(descEn, descDe),
      useCase: loc(useCaseEn, useCaseDe),
      defaultSlug: base.defaultSlug,
      graph: base.graph,
      slots,
    };
  };

  const handleFailure = async (err: unknown): Promise<void> => {
    if (err instanceof ApiError) {
      const body = parseErrorBody(err.body);
      if (err.status === 409 || body.code === 'conductor.template_id_exists') {
        // Race: the id appeared between catalog load and submit. Re-check
        // ownership — if it is now the viewer's own template, switch to the
        // "Publish as v{n+1}" state instead of dead-ending on the error.
        try {
          const { template } = await fetchConductorTemplate(trimmedId);
          if (template.source === 'user' && viewer !== null && template.createdBy === viewer) {
            setRaceOwned(template);
            return;
          }
        } catch {
          // invisible (foreign private) — fall through to the id-taken error
        }
        setIdError(t('saveTemplateIdTaken'));
        return;
      }
      if (body.code === 'conductor.template_invalid' && Array.isArray(body.errors)) {
        setManifestErrors(body.errors.map((e) => e.message));
        return;
      }
      setGenericError(t('templateRequestFailed', { message: body.message ?? err.message }));
      return;
    }
    setGenericError(t('templateRequestFailed', { message: err instanceof Error ? err.message : String(err) }));
  };

  const handlePublish = async (): Promise<void> => {
    if (draft === null) return;
    setPending(true);
    setIdError(null);
    setManifestErrors([]);
    setGenericError(null);
    const manifest = buildManifest(draft);
    try {
      if (publishMode.kind === 'version') {
        const res = await updateConductorTemplate(trimmedId, manifest);
        onPublished({ id: trimmedId, version: res.template.latestVersion ?? publishMode.next });
      } else {
        const res = await createConductorTemplate(manifest);
        onPublished({ id: trimmedId, version: res.template.version ?? 1 });
      }
    } catch (err) {
      await handleFailure(err);
    } finally {
      setPending(false);
    }
  };

  if (draft === null && genericError === null) {
    // Draft inference in flight — Lume loading surface (.lume-skeleton, no spinner).
    return (
      <div className="rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4" data-testid="save-template-loading">
        <div className="lume-skeleton h-5 w-1/3" />
        <div className="lume-skeleton mt-3 h-4 w-2/3" />
        <div className="lume-skeleton mt-3 h-4 w-1/2" />
      </div>
    );
  }

  const idFieldInvalid = idInvalid || idError !== null || publishMode.kind === 'taken';

  return (
    <div className="rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4">
      <h3 className="text-[15px] font-medium text-[color:var(--fg-strong)]">
        {t('saveTemplateHeading', { slug: workflowSlug })}
      </h3>
      <p className="mt-1 max-w-2xl text-[13px] leading-[1.55] text-[color:var(--fg-muted)]">{t('saveTemplateHint')}</p>

      {draft !== null && (
        <>
          {/* Metadata — en required (the manifest's universal fallback), de optional. */}
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className={gcLbl}>
              <span className={idFieldInvalid ? 'text-[color:var(--danger)]' : undefined}>{t('saveTemplateIdLabel')}</span>
              <input
                className={`${fieldClass(idFieldInvalid)} font-mono`}
                value={idValue}
                aria-invalid={idFieldInvalid || undefined}
                onChange={(e) => {
                  setIdValue(e.target.value);
                  setIdError(null);
                }}
              />
              {idInvalid ? <span className="text-[12px] text-[color:var(--danger)]">{t('saveTemplateIdInvalid')}</span> : null}
              {publishMode.kind === 'taken' || idError !== null ? (
                <span className="text-[12px] text-[color:var(--danger)]">{t('saveTemplateIdTaken')}</span>
              ) : null}
            </label>
            <div />
            <label className={gcLbl}>
              {t('saveTemplateNameEnLabel')}
              <input className={fieldClass(false)} value={nameEn} onChange={(e) => setNameEn(e.target.value)} />
            </label>
            <label className={gcLbl}>
              {t('saveTemplateNameDeLabel')}
              <input className={fieldClass(false)} value={nameDe} onChange={(e) => setNameDe(e.target.value)} />
            </label>
            <label className={gcLbl}>
              {t('saveTemplateDescriptionEnLabel')}
              <input className={fieldClass(false)} value={descEn} onChange={(e) => setDescEn(e.target.value)} />
            </label>
            <label className={gcLbl}>
              {t('saveTemplateDescriptionDeLabel')}
              <input className={fieldClass(false)} value={descDe} onChange={(e) => setDescDe(e.target.value)} />
            </label>
            <label className={gcLbl}>
              {t('saveTemplateUseCaseEnLabel')}
              <input className={fieldClass(false)} value={useCaseEn} onChange={(e) => setUseCaseEn(e.target.value)} />
            </label>
            <label className={gcLbl}>
              {t('saveTemplateUseCaseDeLabel')}
              <input className={fieldClass(false)} value={useCaseDe} onChange={(e) => setUseCaseDe(e.target.value)} />
            </label>
          </div>

          {/* Inferred ref slots — one per distinct concrete ref, labels editable. */}
          <h4 className="mt-5 text-[12px] font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]">
            {t('saveTemplateRefSlotsHeading')}
          </h4>
          <p className="mt-1 max-w-2xl text-[12px] text-[color:var(--fg-muted)]">{t('saveTemplateRefSlotsHint')}</p>
          {refSlots.length === 0 ? (
            <p className="mt-2 text-[13px] text-[color:var(--fg-muted)]">{t('saveTemplateNoRefSlots')}</p>
          ) : (
            <div className="mt-2 grid gap-3">
              {refSlots.map((slot, index) => (
                <fieldset
                  key={`${slot.kind}:${slot.key}`}
                  className="rounded-md border border-[color:var(--border)] p-3"
                >
                  <legend className="flex items-center gap-2 px-1">
                    <span className={BADGE}>{t(KIND_BADGE_KEY[slot.kind])}</span>
                    <span className="font-mono text-[12px] text-[color:var(--fg-strong)]">{slot.key}</span>
                    <span className="text-[11px] text-[color:var(--fg-muted)]">
                      {t('saveTemplateOriginalRef', { ref: slot.originalRef })}
                    </span>
                  </legend>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className={gcLbl}>
                      {t('saveTemplateSlotLabelEnLabel')}
                      <input
                        className={fieldClass(false)}
                        value={slot.labelEn}
                        onChange={(e) => setRefSlot(index, { labelEn: e.target.value })}
                      />
                    </label>
                    <label className={gcLbl}>
                      {t('saveTemplateSlotLabelDeLabel')}
                      <input
                        className={fieldClass(false)}
                        value={slot.labelDe}
                        onChange={(e) => setRefSlot(index, { labelDe: e.target.value })}
                      />
                    </label>
                  </div>
                </fieldset>
              ))}
            </div>
          )}

          {/* Text slots — never inferred; authored here. */}
          <h4 className="mt-5 text-[12px] font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]">
            {t('saveTemplateTextSlotsHeading')}
          </h4>
          <p className="mt-1 max-w-2xl text-[12px] text-[color:var(--fg-muted)]">{t('saveTemplateTextSlotsHint')}</p>
          <div className="mt-2 grid gap-3">
            {textSlots.map((slot, index) => {
              const keyInvalid = !TEXT_KEY_RE.test(slot.key.trim());
              return (
                <fieldset key={index} className="rounded-md border border-[color:var(--border)] p-3">
                  <legend className="px-1 font-mono text-[12px] text-[color:var(--fg-muted)]">
                    {t('saveTemplateTextSlotToken', { token: `slot:text:${slot.key.trim() || '…'}` })}
                  </legend>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className={gcLbl}>
                      <span className={keyInvalid ? 'text-[color:var(--danger)]' : undefined}>
                        {t('saveTemplateTextSlotKeyLabel')}
                      </span>
                      <input
                        className={`${fieldClass(keyInvalid)} font-mono`}
                        value={slot.key}
                        aria-invalid={keyInvalid || undefined}
                        onChange={(e) => setTextSlot(index, { key: e.target.value })}
                      />
                      {keyInvalid ? (
                        <span className="text-[12px] text-[color:var(--danger)]">{t('saveTemplateTextSlotKeyInvalid')}</span>
                      ) : null}
                    </label>
                    <label className={gcLbl}>
                      {t('saveTemplateTextSlotDefaultLabel')}
                      <input
                        className={fieldClass(false)}
                        value={slot.defaultValue}
                        onChange={(e) => setTextSlot(index, { defaultValue: e.target.value })}
                      />
                    </label>
                    <label className={gcLbl}>
                      {t('saveTemplateSlotLabelEnLabel')}
                      <input
                        className={fieldClass(false)}
                        value={slot.labelEn}
                        onChange={(e) => setTextSlot(index, { labelEn: e.target.value })}
                      />
                    </label>
                    <label className={gcLbl}>
                      {t('saveTemplateSlotLabelDeLabel')}
                      <input
                        className={fieldClass(false)}
                        value={slot.labelDe}
                        onChange={(e) => setTextSlot(index, { labelDe: e.target.value })}
                      />
                    </label>
                  </div>
                  <div className="mt-2">
                    <Button variant="ghost" size="sm" onClick={() => setTextSlots((slots) => slots.filter((_, i) => i !== index))}>
                      {t('saveTemplateRemoveTextSlot')}
                    </Button>
                  </div>
                </fieldset>
              );
            })}
            <div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setTextSlots((slots) => [...slots, { key: '', labelEn: '', labelDe: '', defaultValue: '' }])}
              >
                {t('saveTemplateAddTextSlot')}
              </Button>
            </div>
          </div>

          {/* Version mode: copy-not-reference transparency before the PUT. */}
          {publishMode.kind === 'version' ? (
            <p className="mt-4 max-w-2xl text-[12px] leading-[1.5] text-[color:var(--warning)]">
              {t('saveTemplateVersionNote')}
            </p>
          ) : null}
          {enMissing ? (
            <p className="mt-3 text-[12px] text-[color:var(--danger)]">{t('saveTemplateEnRequired')}</p>
          ) : null}
          {manifestErrors.length > 0 ? (
            <div className="mt-3 text-[13px] text-[color:var(--danger)]">
              <p>{t('saveTemplateInvalidHeading')}</p>
              <ul className="mt-1 list-disc pl-5">
                {manifestErrors.map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
      {genericError ? <p className="mt-3 text-[13px] text-[color:var(--danger)]">{genericError}</p> : null}

      <div className="mt-5 flex flex-wrap gap-2">
        {draft !== null && (
          <Button
            variant="primary"
            busy={pending}
            busyLabel={t('saveTemplatePublishing')}
            disabled={submitBlocked}
            onClick={() => void handlePublish()}
          >
            {publishMode.kind === 'version'
              ? t('saveTemplatePublishVersionButton', { version: publishMode.next })
              : t('saveTemplatePublishButton')}
          </Button>
        )}
        <Button variant="ghost" disabled={pending} onClick={onCancel}>
          {t('templateCancelButton')}
        </Button>
      </div>
    </div>
  );
}
