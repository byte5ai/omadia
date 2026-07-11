'use client';

import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';

import { gcLbl } from './GuidedControls';

/**
 * Slot editor sections of the save-as-template dialog (#478 F1), split out of
 * SaveAsTemplateDialog.tsx to keep both files within the repo's 500-line rule.
 * Pure presentation over the dialog's editable-slot state: the dialog owns the
 * arrays and validation gates; these sections render them and report patches.
 */

export type RefKind = 'roles' | 'agents' | 'actions' | 'events' | 'channels';

/** Render order — matches the instantiate form's grouping order. */
export const REF_KINDS: readonly RefKind[] = ['roles', 'agents', 'actions', 'events', 'channels'];

const KIND_BADGE_KEY: Record<RefKind, string> = {
  roles: 'templateSlotGroupRoles',
  agents: 'templateSlotGroupAgents',
  actions: 'templateSlotGroupActions',
  events: 'templateSlotGroupEvents',
  channels: 'templateSlotGroupChannels',
};

/** conductor-core's text-slot token grammar. */
export const TEXT_KEY_RE = /^[A-Za-z0-9_-]+$/;

/** Token occurrences inside step texts (`slot:text:<key>`, key grammar as above). */
export const TEXT_TOKEN_RE = /slot:text:([A-Za-z0-9_-]+)/g;

/** One designated text field of the draft graph (`step.prompt` / `human.message`) —
 *  the dialog edits these so declared text-slot tokens can actually be PLACED. */
export interface EditableStepText {
  stepId: string;
  field: 'prompt' | 'message';
  value: string;
}

export interface EditableRefSlot {
  kind: RefKind;
  key: string;
  /** the concrete ref the slot replaced — the draft proposes it as the label. */
  originalRef: string;
  labelEn: string;
  labelDe: string;
}

export interface EditableTextSlot {
  key: string;
  labelEn: string;
  labelDe: string;
  defaultValue: string;
}

const FIELD_BASE = 'w-full rounded-md border bg-transparent px-2 py-1 text-[13px] text-[color:var(--fg-strong)]';

export function fieldClass(invalid: boolean): string {
  return `${FIELD_BASE} ${invalid ? 'border-[color:var(--danger-edge)]' : 'border-[color:var(--border)]'}`;
}

/** Kind badge — text + edge only, never a filled pill (Lume state-color rule). */
const BADGE =
  'rounded-full border border-[color:var(--border-strong)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]';

const SECTION_HEADING = 'mt-5 text-[12px] font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]';
const SECTION_HINT = 'mt-1 max-w-2xl text-[12px] text-[color:var(--fg-muted)]';

/** Inferred ref slots — one per distinct concrete ref, labels editable. */
export function RefSlotSection({
  slots,
  onPatch,
}: {
  slots: EditableRefSlot[];
  onPatch: (index: number, patch: Partial<EditableRefSlot>) => void;
}): React.JSX.Element {
  const t = useTranslations('conductor');
  return (
    <>
      <h4 className={SECTION_HEADING}>{t('saveTemplateRefSlotsHeading')}</h4>
      <p className={SECTION_HINT}>{t('saveTemplateRefSlotsHint')}</p>
      {slots.length === 0 ? (
        <p className="mt-2 text-[13px] text-[color:var(--fg-muted)]">{t('saveTemplateNoRefSlots')}</p>
      ) : (
        <div className="mt-2 grid gap-3">
          {slots.map((slot, index) => (
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
                    onChange={(e) => onPatch(index, { labelEn: e.target.value })}
                  />
                </label>
                <label className={gcLbl}>
                  {t('saveTemplateSlotLabelDeLabel')}
                  <input
                    className={fieldClass(false)}
                    value={slot.labelDe}
                    onChange={(e) => onPatch(index, { labelDe: e.target.value })}
                  />
                </label>
              </div>
            </fieldset>
          ))}
        </div>
      )}
    </>
  );
}

/** Text slots — never inferred; authored here. */
export function TextSlotSection({
  slots,
  onPatch,
  onAdd,
  onRemove,
}: {
  slots: EditableTextSlot[];
  onPatch: (index: number, patch: Partial<EditableTextSlot>) => void;
  onAdd: () => void;
  onRemove: (index: number) => void;
}): React.JSX.Element {
  const t = useTranslations('conductor');
  return (
    <>
      <h4 className={SECTION_HEADING}>{t('saveTemplateTextSlotsHeading')}</h4>
      <p className={SECTION_HINT}>{t('saveTemplateTextSlotsHint')}</p>
      <div className="mt-2 grid gap-3">
        {slots.map((slot, index) => {
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
                    onChange={(e) => onPatch(index, { key: e.target.value })}
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
                    onChange={(e) => onPatch(index, { defaultValue: e.target.value })}
                  />
                </label>
                <label className={gcLbl}>
                  {t('saveTemplateSlotLabelEnLabel')}
                  <input
                    className={fieldClass(false)}
                    value={slot.labelEn}
                    onChange={(e) => onPatch(index, { labelEn: e.target.value })}
                  />
                </label>
                <label className={gcLbl}>
                  {t('saveTemplateSlotLabelDeLabel')}
                  <input
                    className={fieldClass(false)}
                    value={slot.labelDe}
                    onChange={(e) => onPatch(index, { labelDe: e.target.value })}
                  />
                </label>
              </div>
              <div className="mt-2">
                <Button variant="ghost" size="sm" onClick={() => onRemove(index)}>
                  {t('saveTemplateRemoveTextSlot')}
                </Button>
              </div>
            </fieldset>
          );
        })}
        <div>
          <Button variant="secondary" size="sm" onClick={onAdd}>
            {t('saveTemplateAddTextSlot')}
          </Button>
        </div>
      </div>
    </>
  );
}

/**
 * Step texts — the UI path that places `slot:text:<key>` tokens into the graph's
 * designated text fields (a declared-but-unplaced slot is rejected server-side as
 * `template_text_slot_unused`). Rendered only while text slots are declared: the
 * author inserts each token via the per-field buttons or by typing, and may adjust
 * the surrounding prose. The edited values replace the fields in the manifest.
 */
export function StepTextsSection({
  fields,
  tokenKeys,
  onChange,
  onInsert,
}: {
  fields: EditableStepText[];
  /** valid (grammar-checked, trimmed) declared text-slot keys, insertion order. */
  tokenKeys: string[];
  onChange: (index: number, value: string) => void;
  onInsert: (index: number, key: string) => void;
}): React.JSX.Element {
  const t = useTranslations('conductor');
  return (
    <>
      <h4 className={SECTION_HEADING}>{t('saveTemplateStepTextsHeading')}</h4>
      <p className={SECTION_HINT}>{t('saveTemplateStepTextsHint')}</p>
      {fields.length === 0 ? (
        <p className="mt-2 text-[13px] text-[color:var(--fg-muted)]">{t('saveTemplateNoStepTexts')}</p>
      ) : (
        <div className="mt-2 grid gap-3">
          {fields.map((field, index) => {
            const label = t(field.field === 'prompt' ? 'saveTemplateStepTextPromptLabel' : 'saveTemplateStepTextMessageLabel', {
              stepId: field.stepId,
            });
            return (
              <div key={`${field.stepId}:${field.field}`} className="rounded-md border border-[color:var(--border)] p-3">
                <label className={gcLbl}>
                  {label}
                  <textarea
                    className={`${fieldClass(false)} min-h-[64px] resize-y font-mono`}
                    rows={3}
                    value={field.value}
                    onChange={(e) => onChange(index, e.target.value)}
                  />
                </label>
                {tokenKeys.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {tokenKeys.map((key) => (
                      <Button key={key} variant="ghost" size="sm" onClick={() => onInsert(index, key)}>
                        {t('saveTemplateInsertTokenButton', { token: `slot:text:${key}` })}
                      </Button>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
