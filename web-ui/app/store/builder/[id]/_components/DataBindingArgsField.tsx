'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';

interface DataBindingArgsFieldProps {
  /** `data_binding.args` as stored in the spec. */
  args: Readonly<Record<string, unknown>> | undefined;
  /** Required input fields of the bound tool (its JSON schema `required`). */
  requiredFields: ReadonlyArray<string>;
  /** Writes the args; `null` removes them. */
  onCommit: (args: Record<string, unknown> | null) => void;
}

/** The bound tool's required input fields from its JSON schema. */
export function requiredInputFields(input: Record<string, unknown> | undefined): string[] {
  const required = input?.['required'];
  return Array.isArray(required) ? required.filter((r): r is string => typeof r === 'string') : [];
}

/**
 * #1808 — fixed input for the page's data-source tool (`data_binding.args`).
 * Without it the generated route called the tool with `{}`, and a tool with a
 * required field could never render. A JSON object, committed on blur; the
 * required fields the args still lack are named right here, before deploy.
 */
export function DataBindingArgsField({
  args,
  requiredFields,
  onCommit,
}: DataBindingArgsFieldProps): React.ReactElement {
  const t = useTranslations('builder.uiSurfaces.pageForm.dataBinding');
  const [text, setText] = useState(() => (args ? JSON.stringify(args, null, 2) : ''));
  const [invalid, setInvalid] = useState(false);

  const missing = requiredFields.filter((f) => !(args && f in args));

  const commit = (): void => {
    const trimmed = text.trim();
    if (trimmed === '') {
      setInvalid(false);
      onCommit(null);
      return;
    }
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        setInvalid(true);
        return;
      }
      setInvalid(false);
      onCommit(parsed as Record<string, unknown>);
    } catch {
      setInvalid(true);
    }
  };

  return (
    <div className="space-y-1">
      <label className="flex items-start gap-2">
        <span className="w-24 shrink-0 pt-2 text-[color:var(--fg-muted)]">{t('argsLabel')}</span>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          rows={3}
          spellCheck={false}
          placeholder={t('argsPlaceholder')}
          className="flex-1 rounded-md border border-[color:var(--border)] bg-[color:var(--bg)] px-2 py-2 font-mono text-[12px]"
        />
      </label>
      {invalid ? (
        <p className="text-[11px] text-[color:var(--danger)]">{t('argsInvalid')}</p>
      ) : null}
      {!invalid && missing.length > 0 ? (
        <p className="text-[11px] text-[color:var(--warning)]">
          {t('argsMissing', { fields: missing.join(', '), count: missing.length })}
        </p>
      ) : null}
    </div>
  );
}
