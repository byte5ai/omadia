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
  type ConductorTemplateGraph,
} from '@/app/_lib/api';

import { gcLbl } from './GuidedControls';
import {
  fieldClass,
  REF_KINDS,
  RefSlotSection,
  StepTextsSection,
  TEXT_KEY_RE,
  TEXT_TOKEN_RE,
  TextSlotSection,
  type EditableRefSlot,
  type EditableStepText,
  type EditableTextSlot,
} from './SaveAsTemplateSlotEditors';

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

/** Template ids are kebab-case machine identifiers (mirrors the bundled catalog). */
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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

/** Narrow view of a (wire-opaque) graph step: just the two designated text fields
 *  of conductor-core's textSlotFields walk (`step.prompt`, `step.human.message`). */
interface StepTextView {
  id?: unknown;
  prompt?: unknown;
  human?: { message?: unknown } | null;
}

/** Enumerate the designated text fields of the draft graph, in step order. */
function stepTextFields(graph: ConductorTemplateGraph): EditableStepText[] {
  const fields: EditableStepText[] = [];
  for (const step of graph.steps) {
    if (typeof step !== 'object' || step === null) continue;
    const s = step as StepTextView;
    if (typeof s.id !== 'string') continue;
    if (typeof s.prompt === 'string') fields.push({ stepId: s.id, field: 'prompt', value: s.prompt });
    if (s.human && typeof s.human === 'object' && typeof s.human.message === 'string') {
      fields.push({ stepId: s.id, field: 'message', value: s.human.message });
    }
  }
  return fields;
}

/** Write the (token-bearing) edited step texts back onto a clone of the draft
 *  graph — the structural mirror of stepTextFields, never a JSON string-replace. */
function applyStepTexts(graph: ConductorTemplateGraph, fields: EditableStepText[]): ConductorTemplateGraph {
  const cloned = structuredClone(graph);
  const steps = cloned.steps.filter((step): step is StepTextView => typeof step === 'object' && step !== null);
  for (const field of fields) {
    const step = steps.find((s) => s.id === field.stepId);
    if (!step) continue;
    if (field.field === 'prompt' && typeof step.prompt === 'string') {
      (step as { prompt: string }).prompt = field.value;
    } else if (field.field === 'message' && step.human && typeof step.human === 'object' && typeof step.human.message === 'string') {
      (step.human as { message: string }).message = field.value;
    }
  }
  return cloned;
}

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
  const [stepTexts, setStepTexts] = useState<EditableStepText[]>([]);
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
        setStepTexts(stepTextFields(inferred.graph));
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

  // Backend contract: every declared text slot must be USED — its token placed in
  // at least one step text (else `template_text_slot_unused`). Gate client-side.
  const placedTokenKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const field of stepTexts) {
      for (const match of field.value.matchAll(TEXT_TOKEN_RE)) keys.add(match[1]!);
    }
    return keys;
  }, [stepTexts]);
  const validTextKeys = useMemo(
    () => [...new Set(textSlots.map((slot) => slot.key.trim()).filter((key) => TEXT_KEY_RE.test(key)))],
    [textSlots],
  );
  const textUnplaced = validTextKeys.some((key) => !placedTokenKeys.has(key));

  const submitBlocked =
    draft === null || pending || trimmedId.length === 0 || idInvalid || enMissing || textKeysInvalid || textUnplaced ||
    publishMode.kind === 'taken';

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
      // The edited step texts carry the placed `slot:text:<key>` tokens.
      graph: applyStepTexts(base.graph, stepTexts),
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

          <RefSlotSection slots={refSlots} onPatch={setRefSlot} />

          <TextSlotSection
            slots={textSlots}
            onPatch={setTextSlot}
            onAdd={() => setTextSlots((slots) => [...slots, { key: '', labelEn: '', labelDe: '', defaultValue: '' }])}
            onRemove={(index) => setTextSlots((slots) => slots.filter((_, i) => i !== index))}
          />

          {/* Token placement: only relevant while text slots are declared. */}
          {textSlots.length > 0 ? (
            <StepTextsSection
              fields={stepTexts}
              tokenKeys={validTextKeys}
              onChange={(index, value) =>
                setStepTexts((fields) => fields.map((f, i) => (i === index ? { ...f, value } : f)))
              }
              onInsert={(index, key) =>
                setStepTexts((fields) =>
                  fields.map((f, i) =>
                    i === index ? { ...f, value: `${f.value}${f.value.length === 0 || f.value.endsWith(' ') ? '' : ' '}slot:text:${key}` } : f,
                  ),
                )
              }
            />
          ) : null}

          {/* Version mode: copy-not-reference transparency before the PUT. */}
          {publishMode.kind === 'version' ? (
            <p className="mt-4 max-w-2xl text-[12px] leading-[1.5] text-[color:var(--warning)]">
              {t('saveTemplateVersionNote')}
            </p>
          ) : null}
          {enMissing ? (
            <p className="mt-3 text-[12px] text-[color:var(--danger)]">{t('saveTemplateEnRequired')}</p>
          ) : null}
          {textUnplaced ? (
            <p className="mt-3 text-[12px] text-[color:var(--danger)]">{t('saveTemplateTextSlotUnplaced')}</p>
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
