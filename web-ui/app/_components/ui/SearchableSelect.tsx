'use client';

import { useId, useMemo, useState } from 'react';

/**
 * A single-choice list you can type into — the ARIA 1.2 combobox pattern.
 *
 * WHY IT EXISTS. A native `<select>` is the right control until the list gets
 * long: the byte5 tenant alone publishes thirty teams, and a chat whose topic
 * is unset renders as a `19:…` stem, so the alphabetical wall an operator has
 * to scroll is exactly the part they cannot read. Typing to filter is the only
 * affordance that scales with the tenant.
 *
 * WHY NOT `<datalist>`, which this repo already uses in `GuidedControls` and
 * `ConditionBuilder`. Those fields accept ANY string and the datalist is a
 * convenience over free text, so browser-owned matching is fine. Here two
 * things are required that a datalist cannot give: matching over text the
 * option DISPLAYS (a chat's topic, its members) while the value is an opaque
 * id, and a "nothing matched" state that says so in a sentence. A datalist
 * matches on the option's `value` and renders an empty popup for a miss —
 * which reads like a broken list rather than like an answer.
 *
 * KEYBOARD AND SCREEN READER PARITY IS THE ACCEPTANCE BAR, not a nicety: this
 * replaces a native control, so anything a `<select>` did must still work.
 * ArrowDown/ArrowUp move the active option (wrapping), Enter picks it, Escape
 * closes and — pressed again on a closed list — clears the query, Home/End
 * jump to the ends, Tab leaves. The input carries `role="combobox"` with
 * `aria-expanded`, `aria-controls` and `aria-activedescendant`, so focus stays
 * in the field while the announced option follows the arrow keys. A live
 * region reports how many options remain after each keystroke, because a
 * filter that silently shrinks a list IS worse than a `<select>` for anyone
 * who cannot see it shrink.
 *
 * IT DOES NOT OWN THE VALUE. `value` is the id the caller holds, which may
 * well be one this list has never heard of (hand-typed elsewhere). That is not
 * an error state and is not corrected here: the matching row is marked
 * selected when there is one, and otherwise nothing is. The control must never
 * claim a choice the operator did not make.
 */

export interface SearchableOption {
  readonly id: string;
  /** What the row shows, and the primary thing the query matches. */
  readonly label: string;
  /**
   * Extra text the query matches but the row does not repeat — a chat's
   * member names, for instance, which are how a human recognises a chat whose
   * topic is empty but which would double the length of every row.
   */
  readonly keywords?: readonly string[];
}

export interface SearchableSelectProps {
  /** Visible label, and the input's accessible name. */
  readonly label: string;
  readonly placeholder: string;
  readonly options: readonly SearchableOption[];
  /** The id the caller currently holds. May be absent from `options`. */
  readonly value: string;
  readonly disabled: boolean;
  /** One sentence for "your query matched nothing" — never an empty list. */
  readonly noMatchText: (query: string) => string;
  /** Live-region text for the number of remaining options. */
  readonly matchCountText: (count: number) => string;
  readonly onSelect: (id: string) => void;
}

/** Case- and accent-insensitive, so `muller` finds `Müller`. */
function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

function matches(option: SearchableOption, needle: string): boolean {
  if (needle === '') return true;
  // The id is searched too: an operator who pasted an id from somewhere else
  // should see it light up in the list rather than wonder whether it is known.
  const haystack = [option.label, option.id, ...(option.keywords ?? [])];
  return haystack.some((part) => fold(part).includes(needle));
}

export function SearchableSelect({
  label,
  placeholder,
  options,
  value,
  disabled,
  noMatchText,
  matchCountText,
  onSelect,
}: SearchableSelectProps): React.JSX.Element {
  const listboxId = useId();
  const inputId = useId();
  const optionIdPrefix = useId();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const needle = fold(query.trim());
  const filtered = useMemo(
    () => options.filter((option) => matches(option, needle)),
    [options, needle],
  );

  // Clamped rather than reset: a filter that narrows under the cursor must
  // leave a VALID active option, and index 0 is the only one always present.
  const active = filtered.length === 0 ? -1 : Math.min(activeIndex, filtered.length - 1);
  const noMatch = query.trim() !== '' && filtered.length === 0;
  const expanded = open && filtered.length > 0;

  function commit(index: number): void {
    const option = filtered[index];
    if (option === undefined) return;
    onSelect(option.id);
    // Showing what was picked is the whole point of a searchable list; the
    // id itself stays visible in the field this writes into.
    setQuery(option.label);
    setOpen(false);
    setActiveIndex(0);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      if (filtered.length === 0) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((active + step + filtered.length) % filtered.length);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      if (!open || filtered.length === 0) return;
      event.preventDefault();
      setActiveIndex(event.key === 'Home' ? 0 : filtered.length - 1);
      return;
    }
    if (event.key === 'Enter') {
      if (!open || active < 0) return;
      event.preventDefault();
      commit(active);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      // Two escapes, two different jobs — dismiss the popup, then undo the
      // filter. Collapsing them would make Escape destroy a query the
      // operator only wanted to stop covering the page.
      if (open) setOpen(false);
      else setQuery('');
      return;
    }
    if (event.key === 'Tab') setOpen(false);
  }

  return (
    <div className="flex flex-col gap-1 text-[11px] text-[color:var(--fg-muted)]">
      {/* A real `<label>`, so clicking it focuses the field exactly as it did
          when this was a `<select>`. It is also the input's accessible name —
          there is no `aria-label` competing with it. */}
      <label htmlFor={inputId}>{label}</label>
      <div className="relative">
        <input
          id={inputId}
          type="text"
          role="combobox"
          aria-expanded={expanded}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={
            expanded && active >= 0 ? `${optionIdPrefix}-${active}` : undefined
          }
          autoComplete="off"
          placeholder={placeholder}
          value={query}
          disabled={disabled}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIndex(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          // A click lands on the option before the blur closes the list, so
          // the close is deferred past the pointer sequence rather than
          // guessed at from `relatedTarget` (which is empty in Safari).
          onBlur={() => window.setTimeout(() => setOpen(false), 0)}
          onKeyDown={onKeyDown}
          className="w-full rounded-md border border-[color:var(--border)] bg-transparent px-2 py-1 text-sm text-[color:var(--fg-strong)]"
        />
        {expanded && (
          <ul
            id={listboxId}
            role="listbox"
            aria-label={label}
            className="absolute z-10 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-[color:var(--border)] bg-[color:var(--bg-elevated)] py-1 shadow-lg"
          >
            {filtered.map((option, index) => (
              <li
                key={option.id}
                id={`${optionIdPrefix}-${index}`}
                role="option"
                aria-selected={option.id === value}
                // Keeps focus in the input so `aria-activedescendant` stays
                // the single thing describing "where am I" in this widget.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => commit(index)}
                onMouseEnter={() => setActiveIndex(index)}
                className={`cursor-pointer px-2 py-1 text-sm ${
                  index === active
                    ? 'bg-[color:var(--accent)]/15 text-[color:var(--fg-strong)]'
                    : 'text-[color:var(--fg-strong)]'
                }`}
              >
                {option.label}
              </li>
            ))}
          </ul>
        )}
      </div>
      {noMatch && (
        <p role="status" className="text-[11px] text-[color:var(--fg-muted)]">
          {noMatchText(query.trim())}
        </p>
      )}
      {/* Announced, not shown: a sighted operator watches the list shrink, and
          repeating the count under every field would be noise. Bare
          `aria-live` rather than `role="status"` on purpose — the visible
          "nothing matched" sentence above owns that role, and two status
          landmarks per field would make the real one impossible to address. */}
      <span aria-live="polite" aria-atomic="true" className="sr-only">
        {matchCountText(filtered.length)}
      </span>
    </div>
  );
}
