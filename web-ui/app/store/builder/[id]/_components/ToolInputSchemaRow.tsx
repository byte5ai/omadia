'use client';

import { ChevronDown, ChevronRight, X } from 'lucide-react';
import { useEffect, useId, useState } from 'react';

import { cn } from '../../../../_lib/cn';
import {
  fetchEntityVocabulary,
  matchVocabulary,
  type VocabularyEntry,
} from '../../../../_lib/entityVocabulary';
import {
  blankNodeForType,
  detectType,
  isValidPropertyKey,
  type JsonSchemaNode,
  type SupportedType,
} from '../../../../_lib/jsonSchemaShape';

export interface ToolInputSchemaRowProps {
  /** Property key on the parent object. */
  fieldKey: string;
  /** This property's schema node. */
  node: JsonSchemaNode;
  /** Whether the parent object marks this key as `required`. */
  required: boolean;
  /** Sibling keys (for collision detection). */
  siblingKeys: ReadonlyArray<string>;
  /** Nesting depth — purely visual (indent). */
  depth: number;
  onRename: (nextKey: string) => void;
  onChangeNode: (nextNode: JsonSchemaNode) => void;
  onRemove: () => void;
  onToggleRequired: (next: boolean) => void;
}

/**
 * B.11-3: Single property row inside the ToolInputSchemaBuilder.
 *
 * Renders type-specific constraint editors and recurses for `object` /
 * `array` types. State is fully controlled — every edit calls back
 * into the parent which holds the canonical schema and emits the
 * resulting JsonPatch. The row itself owns one piece of UI state: the
 * collapsed/expanded toggle for the constraints panel.
 */
export function ToolInputSchemaRow({
  fieldKey,
  node,
  required,
  siblingKeys,
  depth,
  onRename,
  onChangeNode,
  onRemove,
  onToggleRequired,
}: ToolInputSchemaRowProps): React.ReactElement {
  const [expanded, setExpanded] = useState<boolean>(depth === 0);
  const keyId = useId();
  const t = detectType(node);
  const collisions = siblingKeys.filter((k) => k === fieldKey);
  const keyInvalid = !isValidPropertyKey(fieldKey);
  const keyDup = collisions.length > 1;

  function changeType(next: SupportedType): void {
    const blank = blankNodeForType(next);
    // Preserve description if present.
    if (node.description) blank.description = node.description;
    onChangeNode(blank);
  }

  return (
    <div
      className={cn(
        'rounded-md border border-[color:var(--border)] bg-[color:var(--bg)]',
        depth > 0 && 'ml-3',
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5 px-2 py-1.5">
        <button
          type="button"
          onClick={() => setExpanded((p) => !p)}
          aria-expanded={expanded}
          aria-label={expanded ? 'Constraints einklappen' : 'Constraints aufklappen'}
          className="rounded p-0.5 text-[color:var(--fg-subtle)] hover:bg-[color:var(--bg-soft)]"
        >
          {expanded ? (
            <ChevronDown className="size-3" aria-hidden />
          ) : (
            <ChevronRight className="size-3" aria-hidden />
          )}
        </button>
        <input
          id={keyId}
          aria-label="Property-Key"
          type="text"
          value={fieldKey}
          onChange={(e) => onRename(e.target.value)}
          className={cn(
            'min-w-0 flex-1 rounded border bg-[color:var(--bg)] px-2 py-1 font-mono-num text-[12px] text-[color:var(--fg-strong)] focus:outline-none',
            keyInvalid || keyDup
              ? 'border-[color:var(--danger)]'
              : 'border-[color:var(--border)] focus:border-[color:var(--accent)]',
          )}
          placeholder="property_name"
          spellCheck={false}
        />
        <select
          aria-label="Property-Typ"
          value={t}
          onChange={(e) => changeType(e.target.value as SupportedType)}
          className="rounded border border-[color:var(--border)] bg-[color:var(--bg)] px-1.5 py-1 text-[11px] font-mono-num text-[color:var(--fg-strong)] focus:border-[color:var(--accent)] focus:outline-none"
        >
          <option value="string">string</option>
          <option value="number">number</option>
          <option value="integer">integer</option>
          <option value="boolean">boolean</option>
          <option value="enum">enum</option>
          <option value="array">array</option>
          <option value="object">object</option>
        </select>
        <label className="inline-flex items-center gap-1 text-[11px] text-[color:var(--fg-muted)]">
          <input
            type="checkbox"
            checked={required}
            onChange={(e) => onToggleRequired(e.target.checked)}
            className="size-3"
          />
          required
        </label>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Property ${fieldKey} entfernen`}
          className="rounded p-0.5 text-[color:var(--fg-subtle)] hover:bg-[color:var(--danger)]/10 hover:text-[color:var(--danger)]"
        >
          <X className="size-3" aria-hidden />
        </button>
      </div>
      {keyInvalid || keyDup ? (
        <p className="px-2 pb-1 text-[10px] text-[color:var(--danger)]">
          {keyInvalid
            ? 'Property-Key muss [a-zA-Z_][a-zA-Z0-9_]* sein'
            : 'Property-Key bereits vergeben'}
        </p>
      ) : null}

      {expanded ? (
        <div className="space-y-2 border-t border-[color:var(--border)] bg-[color:var(--bg-soft)] px-2 py-2">
          <DescriptionInput
            value={node.description ?? ''}
            onChange={(v) =>
              onChangeNode({ ...node, description: v.length > 0 ? v : undefined })
            }
          />
          <TypeConstraintsEditor node={node} onChange={onChangeNode} depth={depth} />
        </div>
      ) : null}
    </div>
  );
}

function DescriptionInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}): React.ReactElement {
  const id = useId();
  const [vocab, setVocab] = useState<ReadonlyArray<VocabularyEntry>>([]);
  const [focused, setFocused] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;
    void fetchEntityVocabulary()
      .then((entries) => {
        if (!cancelled) setVocab(entries);
      })
      .catch(() => {
        // Vocabulary is best-effort UI candy. If the endpoint is down,
        // the field still works.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Match against last word in the description so casual typing suggests
  // entries — e.g. "Lookup the DocumentRef" → suggests entity://DocumentRef.
  const lastWord = value.split(/\s+/).pop() ?? '';
  const matches = focused ? matchVocabulary(lastWord, vocab, 4) : [];

  return (
    <div>
      <label
        htmlFor={id}
        className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.18em] text-[color:var(--fg-subtle)]"
      >
        Beschreibung
      </label>
      <input
        id={id}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          // Defer blur so a click on a suggestion still registers.
          window.setTimeout(() => setFocused(false), 120);
        }}
        className="w-full rounded border border-[color:var(--border)] bg-[color:var(--bg)] px-2 py-1 text-[11px] text-[color:var(--fg-strong)] focus:border-[color:var(--accent)] focus:outline-none"
        placeholder="Vom LLM gelesener Hint"
      />
      {matches.length > 0 ? (
        <ul className="mt-1 flex flex-wrap gap-1">
          {matches.map((m) => (
            <li key={m.$id}>
              <button
                type="button"
                onClick={() => {
                  // Replace the matched last word with the canonical $id
                  // wrapped in backticks so the description still reads
                  // human.
                  const head = value.slice(0, value.length - lastWord.length);
                  onChange(`${head}\`${m.$id}\``);
                }}
                title={m.summary ?? `Entity ${m.name} (v${m.version})`}
                className="inline-flex items-center gap-1 rounded border border-[color:var(--accent)]/40 bg-[color:var(--accent)]/8 px-1.5 py-0.5 font-mono-num text-[10px] text-[color:var(--accent)] hover:bg-[color:var(--accent)]/15"
              >
                {m.$id}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function TypeConstraintsEditor({
  node,
  onChange,
  depth,
}: {
  node: JsonSchemaNode;
  onChange: (next: JsonSchemaNode) => void;
  depth: number;
}): React.ReactElement | null {
  const t = detectType(node);
  if (t === 'string') {
    return (
      <div className="grid grid-cols-2 gap-2">
        <NumberConstraint
          label="minLength"
          value={node.minLength}
          onChange={(v) => onChange({ ...node, minLength: v })}
        />
        <NumberConstraint
          label="maxLength"
          value={node.maxLength}
          onChange={(v) => onChange({ ...node, maxLength: v })}
        />
        <TextConstraint
          label="pattern (regex)"
          value={node.pattern ?? ''}
          mono
          onChange={(v) => onChange({ ...node, pattern: v.length > 0 ? v : undefined })}
        />
        <TextConstraint
          label="format"
          value={node.format ?? ''}
          mono
          onChange={(v) => onChange({ ...node, format: v.length > 0 ? v : undefined })}
          placeholder="email | uri | date-time | uuid"
        />
      </div>
    );
  }
  if (t === 'number' || t === 'integer') {
    return (
      <div className="grid grid-cols-2 gap-2">
        <NumberConstraint
          label="minimum"
          value={node.minimum}
          onChange={(v) => onChange({ ...node, minimum: v })}
        />
        <NumberConstraint
          label="maximum"
          value={node.maximum}
          onChange={(v) => onChange({ ...node, maximum: v })}
        />
      </div>
    );
  }
  if (t === 'boolean') {
    return (
      <p className="text-[11px] italic text-[color:var(--fg-muted)]">
        Boolean — keine zusätzlichen Constraints.
      </p>
    );
  }
  if (t === 'enum') {
    const values = (node.enum ?? []).map((v) => String(v));
    return (
      <EnumValuesEditor
        values={values}
        onChange={(next) => onChange({ ...node, enum: next })}
      />
    );
  }
  if (t === 'array') {
    return (
      <ArrayItemsEditor
        node={node}
        depth={depth}
        onChange={onChange}
      />
    );
  }
  if (t === 'object') {
    // Objects are recursively rendered by the parent ToolInputSchemaBuilder
    // — this editor only surfaces a hint so the row stays self-explanatory.
    return (
      <p className="text-[11px] italic text-[color:var(--fg-muted)]">
        Object — verschachtelte Properties unten editieren.
      </p>
    );
  }
  return null;
}

function NumberConstraint({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | undefined;
  onChange: (v: number | undefined) => void;
}): React.ReactElement {
  const id = useId();
  return (
    <div>
      <label
        htmlFor={id}
        className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.18em] text-[color:var(--fg-subtle)]"
      >
        {label}
      </label>
      <input
        id={id}
        type="number"
        value={value === undefined ? '' : value}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === '') {
            onChange(undefined);
            return;
          }
          const num = Number(raw);
          if (Number.isFinite(num)) onChange(num);
        }}
        className="w-full rounded border border-[color:var(--border)] bg-[color:var(--bg)] px-2 py-1 font-mono-num text-[11px] text-[color:var(--fg-strong)] focus:border-[color:var(--accent)] focus:outline-none"
      />
    </div>
  );
}

function TextConstraint({
  label,
  value,
  onChange,
  placeholder,
  mono = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
}): React.ReactElement {
  const id = useId();
  return (
    <div>
      <label
        htmlFor={id}
        className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.18em] text-[color:var(--fg-subtle)]"
      >
        {label}
      </label>
      <input
        id={id}
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          'w-full rounded border border-[color:var(--border)] bg-[color:var(--bg)] px-2 py-1 text-[11px] text-[color:var(--fg-strong)] focus:border-[color:var(--accent)] focus:outline-none',
          mono && 'font-mono-num',
        )}
      />
    </div>
  );
}

function EnumValuesEditor({
  values,
  onChange,
}: {
  values: ReadonlyArray<string>;
  onChange: (next: string[]) => void;
}): React.ReactElement {
  const [draft, setDraft] = useState<string>('');
  return (
    <div>
      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.18em] text-[color:var(--fg-subtle)]">
        Erlaubte Werte
      </span>
      {values.length > 0 ? (
        <ul className="mb-1 flex flex-wrap gap-1">
          {values.map((v, i) => (
            <li
              key={`${v}-${String(i)}`}
              className="inline-flex items-center gap-1 rounded bg-[color:var(--bg)] px-2 py-0.5 font-mono-num text-[11px] text-[color:var(--fg-strong)]"
            >
              {v}
              <button
                type="button"
                onClick={() => onChange(values.filter((_, j) => j !== i))}
                aria-label={`Wert ${v} entfernen`}
                className="rounded p-0.5 text-[color:var(--fg-subtle)] hover:text-[color:var(--danger)]"
              >
                <X className="size-2.5" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex gap-1">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && draft.trim()) {
              e.preventDefault();
              onChange([...values, draft.trim()]);
              setDraft('');
            }
          }}
          placeholder="Wert + Enter"
          className="flex-1 rounded border border-[color:var(--border)] bg-[color:var(--bg)] px-2 py-1 font-mono-num text-[11px] text-[color:var(--fg-strong)] focus:border-[color:var(--accent)] focus:outline-none"
        />
        <button
          type="button"
          onClick={() => {
            if (!draft.trim()) return;
            onChange([...values, draft.trim()]);
            setDraft('');
          }}
          disabled={!draft.trim()}
          className="rounded bg-[color:var(--accent)] px-2 py-1 text-[11px] font-semibold text-white disabled:opacity-40"
        >
          +
        </button>
      </div>
    </div>
  );
}

function ArrayItemsEditor({
  node,
  depth,
  onChange,
}: {
  node: JsonSchemaNode;
  depth: number;
  onChange: (next: JsonSchemaNode) => void;
}): React.ReactElement {
  const items = (node.items as JsonSchemaNode | undefined) ?? { type: 'string' };
  const itemType = detectType(items);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[color:var(--fg-subtle)]">
          Item-Typ
        </span>
        <select
          value={itemType}
          onChange={(e) => {
            const next = blankNodeForType(e.target.value as SupportedType);
            onChange({ ...node, items: next });
          }}
          className="rounded border border-[color:var(--border)] bg-[color:var(--bg)] px-1.5 py-1 text-[11px] font-mono-num text-[color:var(--fg-strong)] focus:border-[color:var(--accent)] focus:outline-none"
        >
          <option value="string">string</option>
          <option value="number">number</option>
          <option value="integer">integer</option>
          <option value="boolean">boolean</option>
          <option value="object">object</option>
        </select>
      </div>
      {itemType === 'object' ? (
        <p className="text-[10px] italic text-[color:var(--fg-muted)]">
          Item-Properties werden im verschachtelten Builder unten editiert
          (Tiefe {String(depth + 1)}).
        </p>
      ) : null}
    </div>
  );
}
