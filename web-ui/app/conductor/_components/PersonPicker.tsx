'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';

import {
  searchConductorPeople,
  type ConductorPersonCandidate,
} from '@/app/_lib/api';

import { gcInput, gcLbl } from './GuidedControls';

const gcHint = 'text-[11px] text-[color:var(--fg-muted)]';

type SearchStatus = 'idle' | 'loading' | 'success' | 'error';

function isPersonCandidate(value: unknown): value is ConductorPersonCandidate {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.principalRef === 'string' &&
    typeof candidate.displayName === 'string' &&
    typeof candidate.channelType === 'string' &&
    (candidate.email === undefined || typeof candidate.email === 'string')
  );
}

function parsePeopleResponse(
  value: unknown,
): { people: ConductorPersonCandidate[]; partial: boolean } | null {
  if (typeof value !== 'object' || value === null) return null;
  const response = value as Record<string, unknown>;
  if (!Array.isArray(response.people) || !response.people.every(isPersonCandidate)) return null;
  return { people: response.people, partial: response.partial === true };
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'AbortError'
  );
}

export function PersonPicker(props: {
  value: string;
  onChange: (ref: string, candidate?: ConductorPersonCandidate) => void;
  channel?: string;
  placeholder?: string;
  label?: string;
}): React.JSX.Element {
  const t = useTranslations('conductor');
  const listId = useId();
  const suppressNextValue = useRef<string | null>(null);
  const [people, setPeople] = useState<ConductorPersonCandidate[]>([]);
  const [partial, setPartial] = useState(false);
  const [status, setStatus] = useState<SearchStatus>('idle');
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (suppressNextValue.current === props.value) {
      suppressNextValue.current = null;
      setPeople([]);
      setPartial(false);
      setStatus('idle');
      setOpen(false);
      return;
    }

    const query = props.value.trim();
    if (query.length < 2) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- short queries must synchronously discard stale async results
      setPeople([]);
      setPartial(false);
      setStatus('idle');
      setOpen(false);
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    setPeople([]);
    setPartial(false);
    setStatus('loading');
    setOpen(true);

    const timer = window.setTimeout(() => {
      void searchConductorPeople(query, {
        channel: props.channel,
        limit: 8,
        signal: controller.signal,
      })
        .then((response) => {
          if (cancelled) return;
          const parsed = parsePeopleResponse(response);
          if (!parsed) {
            setStatus('error');
            return;
          }
          setPeople(parsed.people);
          setPartial(parsed.partial);
          setStatus('success');
        })
        .catch((error: unknown) => {
          if (cancelled || isAbortError(error)) return;
          setStatus('error');
        });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [props.channel, props.value]);

  const handleInputChange = (event: ChangeEvent<HTMLInputElement>): void => {
    suppressNextValue.current = null;
    props.onChange(event.target.value);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') setOpen(false);
  };

  const selectCandidate = (candidate: ConductorPersonCandidate): void => {
    suppressNextValue.current = candidate.principalRef;
    setOpen(false);
    props.onChange(candidate.principalRef, candidate);
  };

  const picker = (
    <div className="relative min-w-0 w-full">
      <input
        aria-autocomplete="list"
        aria-controls={listId}
        aria-expanded={open}
        className={gcInput}
        data-testid="person-picker-input"
        placeholder={props.placeholder ?? t('personPicker.placeholder')}
        role="combobox"
        value={props.value}
        onChange={handleInputChange}
        onKeyDown={handleKeyDown}
      />
      {open ? (
        <div
          id={listId}
          role="listbox"
          className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-[color:var(--border)] bg-[color:var(--surface)] p-1 shadow-lg"
        >
          {people.map((candidate) => (
            /* eslint-disable-next-line no-restricted-syntax -- native button is the listbox suggestion affordance */
            <button
              key={`${candidate.channelType}:${candidate.principalRef}`}
              aria-selected={false}
              className="flex w-full items-start justify-between gap-2 rounded px-2 py-1.5 text-left hover:bg-[color:var(--surface-hover)]"
              data-testid="person-picker-option"
              role="option"
              type="button"
              onClick={() => selectCandidate(candidate)}
              onMouseDown={(event) => event.preventDefault()}
            >
              <span className="min-w-0">
                <span className="block truncate text-[13px] text-[color:var(--fg-strong)]">
                  {candidate.displayName}
                </span>
                <span className={gcHint}>{candidate.email ?? candidate.principalRef}</span>
              </span>
              <span className="shrink-0 rounded-full border border-[color:var(--border)] px-1.5 py-0.5 text-[10px] text-[color:var(--fg-muted)]">
                {candidate.channelType}
              </span>
            </button>
          ))}
          {status === 'loading' ? (
            <div className={gcHint} data-testid="person-picker-loading">
              {t('personPicker.searching')}
            </div>
          ) : null}
          {status === 'success' && people.length === 0 ? (
            <div className={gcHint} data-testid="person-picker-empty">
              {t('personPicker.noResults')}
            </div>
          ) : null}
          {status === 'error' ? (
            <div className={gcHint} data-testid="person-picker-error">
              {t('personPicker.searchFailed')}
            </div>
          ) : null}
          {partial ? (
            <div className={gcHint} data-testid="person-picker-partial">
              {t('personPicker.partialHint')}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );

  return props.label ? (
    <label className={gcLbl}>
      {props.label}
      {picker}
    </label>
  ) : (
    picker
  );
}
