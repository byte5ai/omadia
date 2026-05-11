'use client';

import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Loader2, X } from 'lucide-react';

import { cn } from '../../_lib/cn';
import {
  ApiError,
  configureInstallJob,
  createInstallJob,
} from '../../_lib/api';
import type {
  CapabilityProviderRef,
  InstallChainResolution,
  InstallJob,
  InstallSetupField,
  UnresolvedCapabilityEntry,
} from '../../_lib/storeTypes';
import { Chip } from './Chip';
import { FieldRow, extractValues } from './setupForm';

/**
 * RequiresWizard — modal-dialog operator-flow for an
 * `install.missing_capability` 409. The middleware computes the full
 * install-chain server-side (`InstallChainResolution`) and returns it
 * as the response `details`; this component renders that verbatim.
 *
 * Marcel-Architektur (S+8.5, A1+B2+C2):
 *   - Frontend stays thin: no client-side recursion, no transitive walk
 *     in JS. Server is the source of truth.
 *   - At N=1 providers per capability we auto-preselect with an
 *     "Empfohlen"-Badge. At N>1 the operator picks via radio-group.
 *   - Chained install is sequential: deepest pre-requisites first
 *     (the `unresolved_requires` order), then finally the target.
 *   - When a provider has setup-fields, the wizard surfaces the form
 *     inline at that step and pauses for input — same FieldRow widgets
 *     as the regular install drawer (`setupForm.tsx`), no UX divergence.
 */

interface RequiresWizardProps {
  targetPluginId: string;
  targetPluginName: string;
  resolution: InstallChainResolution;
  onClose: () => void;
}

interface ProviderSelection {
  /** Capability string from `unresolved_requires`, e.g. `"knowledgeGraph@^1"`. */
  capability: string;
  /** Plugin id of the chosen provider. `null` if no candidate exists
   *  (operator must upload a provider package first). */
  providerId: string | null;
  /** All catalog candidates — needed to render the radio group + the
   *  resolved name/version after selection. */
  candidates: CapabilityProviderRef[];
}

type Phase =
  | { kind: 'review' }
  | {
      kind: 'installing';
      stepIndex: number;
      stepCount: number;
      currentLabel: string;
      currentJob: InstallJob | null;
      requiresForm: boolean;
      stepError: string | null;
    }
  | { kind: 'success' }
  | { kind: 'error'; message: string };

export function RequiresWizard({
  targetPluginId,
  targetPluginName,
  resolution,
  onClose,
}: RequiresWizardProps): React.ReactElement {
  const router = useRouter();

  const initialSelections = useMemo<ProviderSelection[]>(
    () =>
      resolution.available_providers.map((entry) => ({
        capability: entry.capability,
        providerId: defaultProviderForEntry(entry),
        candidates: entry.providers,
      })),
    [resolution],
  );

  const [selections, setSelections] = useState<ProviderSelection[]>(
    initialSelections,
  );
  const [phase, setPhase] = useState<Phase>({ kind: 'review' });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const formRef = useRef<HTMLFormElement | null>(null);
  // Promise-resolver for the inline pause: when a provider needs setup
  // input, the install-loop awaits this before continuing.
  const formResolverRef = useRef<
    ((values: Record<string, unknown>) => void) | null
  >(null);

  const allResolved = selections.every((s) => s.providerId !== null);
  const installing = phase.kind === 'installing';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4 py-6"
      role="dialog"
      aria-modal="true"
      aria-label={`Voraussetzungen für ${targetPluginName} installieren`}
    >
      <button
        type="button"
        onClick={installing ? undefined : onClose}
        aria-label="Abbrechen"
        disabled={installing}
        className="absolute inset-0 bg-[color:var(--ink)]/40 backdrop-blur-sm transition disabled:cursor-wait"
      />

      <div
        className={cn(
          'relative z-10 flex w-full max-w-2xl flex-col',
          'border border-[color:var(--rule-strong)] bg-[color:var(--paper)]',
          'shadow-[0_30px_80px_-20px_rgba(0,0,0,0.4)]',
          'max-h-[90vh] overflow-hidden',
        )}
      >
        <header className="flex items-start justify-between gap-6 border-b border-[color:var(--rule)] px-7 py-5">
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-[0.22em] text-[color:var(--faint-ink)]">
              Voraussetzungen
            </div>
            <h2 className="font-display mt-1 text-2xl font-medium leading-tight text-[color:var(--ink)]">
              {targetPluginName}
            </h2>
            <p className="mt-2 text-[12px] leading-relaxed text-[color:var(--muted-ink)]">
              Vor der Installation muss die folgende Capability-Kette
              erfüllt sein. Reihenfolge: tiefste Voraussetzung zuerst,
              dann das eigentliche Plugin.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={installing}
            className="text-[color:var(--muted-ink)] transition hover:text-[color:var(--ink)] disabled:opacity-40"
            aria-label="Schließen"
          >
            <X className="size-4" aria-hidden />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-7 py-6">
          {phase.kind === 'review' ? (
            <ReviewBody
              selections={selections}
              targetPluginName={targetPluginName}
              onChange={(idx, providerId) => {
                setSelections((prev) =>
                  prev.map((s, i) => (i === idx ? { ...s, providerId } : s)),
                );
              }}
            />
          ) : phase.kind === 'installing' ? (
            <InstallingBody
              phase={phase}
              fieldErrors={fieldErrors}
              formRef={formRef}
              onFormSubmit={(values) => {
                const resolver = formResolverRef.current;
                if (resolver) {
                  formResolverRef.current = null;
                  resolver(values);
                }
              }}
            />
          ) : phase.kind === 'success' ? (
            <SuccessBody targetPluginName={targetPluginName} />
          ) : (
            <ErrorBody message={phase.message} />
          )}
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-[color:var(--rule)] bg-[color:var(--paper-soft)] px-7 py-4">
          <p className="text-[11px] leading-relaxed text-[color:var(--faint-ink)]">
            {phase.kind === 'review'
              ? `${selections.length} Voraussetzung${selections.length === 1 ? '' : 'en'} → ${targetPluginName}`
              : phase.kind === 'installing'
                ? `Schritt ${phase.stepIndex + 1} von ${phase.stepCount}`
                : phase.kind === 'success'
                  ? 'Alles installiert.'
                  : 'Installation abgebrochen.'}
          </p>
          <div className="flex items-center gap-2">
            {phase.kind === 'review' ? (
              <>
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-full bg-[color:var(--bg)] px-4 py-2 text-[12px] font-semibold text-[color:var(--fg-muted)] ring-1 ring-inset ring-[color:var(--border)]"
                >
                  Abbrechen
                </button>
                <button
                  type="button"
                  onClick={runInstallChain}
                  disabled={!allResolved}
                  className={cn(
                    'inline-flex items-center gap-2 rounded-full px-5 py-2',
                    'bg-[color:var(--accent)] text-[color:var(--accent-fg)] shadow-[var(--shadow-cta)]',
                    'transition-[background,transform] duration-[var(--dur-fast)] ease-[var(--ease-out)]',
                    'hover:bg-[color:var(--accent-hover)] active:translate-y-px',
                    'disabled:cursor-not-allowed disabled:opacity-60',
                  )}
                >
                  <span className="text-[13px] font-semibold">
                    Alle installieren
                  </span>
                </button>
              </>
            ) : phase.kind === 'installing' && phase.requiresForm ? (
              <button
                type="button"
                onClick={() => formRef.current?.requestSubmit()}
                className={cn(
                  'inline-flex items-center gap-2 rounded-full px-5 py-2',
                  'bg-[color:var(--accent)] text-[color:var(--accent-fg)] shadow-[var(--shadow-cta)]',
                )}
              >
                <span className="text-[13px] font-semibold">
                  Schritt bestätigen
                </span>
              </button>
            ) : phase.kind === 'success' ? (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  router.refresh();
                }}
                className="rounded-full bg-[color:var(--accent)] px-5 py-2 text-[13px] font-semibold text-[color:var(--accent-fg)]"
              >
                Schließen
              </button>
            ) : phase.kind === 'error' ? (
              <button
                type="button"
                onClick={onClose}
                className="rounded-full bg-[color:var(--bg)] px-4 py-2 text-[12px] font-semibold text-[color:var(--fg-muted)] ring-1 ring-inset ring-[color:var(--border)]"
              >
                Schließen
              </button>
            ) : null}
          </div>
        </footer>
      </div>
    </div>
  );

  // ---------------------------------------------------------------------
  // Chained-install loop. Sequential per Marcel's fork-#3 decision —
  // provider must activate before consumer install can succeed.
  // ---------------------------------------------------------------------

  async function runInstallChain(): Promise<void> {
    const steps: Array<{ pluginId: string; label: string }> = [];
    for (const sel of selections) {
      if (!sel.providerId) {
        setPhase({
          kind: 'error',
          message: `Kein Provider gewählt für '${sel.capability}'.`,
        });
        return;
      }
      const cand = sel.candidates.find((c) => c.id === sel.providerId);
      const label = cand
        ? `${cand.name} (${sel.capability})`
        : `${sel.providerId} (${sel.capability})`;
      steps.push({ pluginId: sel.providerId, label });
    }
    steps.push({
      pluginId: targetPluginId,
      label: targetPluginName,
    });

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (!step) continue;
      try {
        setPhase({
          kind: 'installing',
          stepIndex: i,
          stepCount: steps.length,
          currentLabel: step.label,
          currentJob: null,
          requiresForm: false,
          stepError: null,
        });
        const created = await createInstallJob(step.pluginId);
        const job = created.job;
        const fields = job.setup_schema?.fields ?? [];
        const requiredFields = fields.filter((f) => f.required);

        // Setup-fields-Pause: if the provider needs operator input
        // (any required field), render the form inline and await
        // formResolverRef.current resolution. Non-required defaults
        // still ship — they round-trip through extractValues.
        let values: Record<string, unknown> = {};
        if (requiredFields.length > 0) {
          setPhase({
            kind: 'installing',
            stepIndex: i,
            stepCount: steps.length,
            currentLabel: step.label,
            currentJob: job,
            requiresForm: true,
            stepError: null,
          });
          values = await new Promise<Record<string, unknown>>((resolve) => {
            formResolverRef.current = resolve;
          });
        }

        const configured = await configureInstallJob(job.id, values);
        if (configured.job.state !== 'active') {
          const message =
            configured.job.error?.message ??
            `Schritt '${step.label}' endete im Zustand '${configured.job.state}'.`;
          setPhase({ kind: 'error', message });
          return;
        }
      } catch (err) {
        const message = describeError(err);
        setPhase({ kind: 'error', message: `${step.label}: ${message}` });
        return;
      }
    }

    setPhase({ kind: 'success' });
  }
}

// ---------------------------------------------------------------------------
// Subviews
// ---------------------------------------------------------------------------

function ReviewBody({
  selections,
  targetPluginName,
  onChange,
}: {
  selections: ProviderSelection[];
  targetPluginName: string;
  onChange: (idx: number, providerId: string | null) => void;
}): React.ReactElement {
  return (
    <div className="space-y-5">
      {selections.map((sel, idx) => (
        <ProviderPickRow
          key={sel.capability}
          index={idx}
          selection={sel}
          onChange={(pid) => onChange(idx, pid)}
        />
      ))}
      <div className="border-t border-[color:var(--rule)] pt-4">
        <div className="flex items-center justify-between text-[11px] uppercase tracking-[0.18em] text-[color:var(--faint-ink)]">
          <span>Final</span>
          <span className="font-mono-num">{selections.length + 1}</span>
        </div>
        <div className="mt-2 flex items-baseline gap-3">
          <span className="text-[14px] font-semibold text-[color:var(--ink)]">
            {targetPluginName}
          </span>
          <Chip tone="accent">Ziel</Chip>
        </div>
      </div>
    </div>
  );
}

function ProviderPickRow({
  index,
  selection,
  onChange,
}: {
  index: number;
  selection: ProviderSelection;
  onChange: (providerId: string | null) => void;
}): React.ReactElement {
  const groupName = `requires-pick-${index}`;
  const noProviders = selection.candidates.length === 0;
  const singleProvider = selection.candidates.length === 1;

  return (
    <div className="border border-[color:var(--rule)] p-4">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <div className="text-[11px] uppercase tracking-[0.18em] text-[color:var(--faint-ink)]">
            Voraussetzung
          </div>
          <div className="font-mono-num mt-1 text-[14px] text-[color:var(--ink)]">
            {selection.capability}
          </div>
        </div>
        <span className="font-mono-num text-[11px] text-[color:var(--faint-ink)]">
          {String(index + 1).padStart(2, '0')}
        </span>
      </div>

      {noProviders ? (
        <p className="mt-3 text-[12px] text-[color:var(--oxblood)]">
          Kein Provider im Katalog. Bitte ein passendes Plugin hochladen
          oder die Capability serverseitig bereitstellen.
        </p>
      ) : (
        <div className="mt-3 space-y-2">
          {selection.candidates.map((cand) => (
            <label
              key={cand.id}
              htmlFor={`${groupName}-${cand.id}`}
              className={cn(
                'flex items-start gap-3 border px-3 py-2 text-sm transition',
                selection.providerId === cand.id
                  ? 'border-[color:var(--accent)] bg-[color:var(--accent)]/5'
                  : 'border-[color:var(--rule)] hover:border-[color:var(--rule-strong)]',
              )}
            >
              <input
                id={`${groupName}-${cand.id}`}
                type="radio"
                name={groupName}
                value={cand.id}
                checked={selection.providerId === cand.id}
                onChange={() => onChange(cand.id)}
                className="mt-1 size-3.5 accent-[color:var(--accent)]"
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="text-[13px] font-semibold text-[color:var(--ink)]">
                    {cand.name}
                  </span>
                  <span className="font-mono-num text-[11px] text-[color:var(--faint-ink)]">
                    v{cand.version}
                  </span>
                  {singleProvider ? <Chip tone="accent">Empfohlen</Chip> : null}
                  {cand.already_installed && cand.active ? (
                    <Chip tone="muted">aktiv</Chip>
                  ) : cand.already_installed ? (
                    <Chip tone="muted">installiert · inaktiv</Chip>
                  ) : null}
                  <Chip tone="mono">{cand.kind}</Chip>
                </div>
                <div className="font-mono-num mt-1 text-[11px] text-[color:var(--faint-ink)]">
                  {cand.id}
                </div>
              </div>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function InstallingBody({
  phase,
  fieldErrors,
  formRef,
  onFormSubmit,
}: {
  phase: Extract<Phase, { kind: 'installing' }>;
  fieldErrors: Record<string, string>;
  formRef: React.MutableRefObject<HTMLFormElement | null>;
  onFormSubmit: (values: Record<string, unknown>) => void;
}): React.ReactElement {
  const fields: InstallSetupField[] = phase.currentJob?.setup_schema?.fields ?? [];

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <Loader2 className="size-5 animate-spin text-[color:var(--accent)]" aria-hidden />
        <div>
          <div className="text-[11px] uppercase tracking-[0.18em] text-[color:var(--faint-ink)]">
            Schritt {phase.stepIndex + 1} / {phase.stepCount}
          </div>
          <div className="font-display text-lg leading-tight text-[color:var(--ink)]">
            {phase.currentLabel}
          </div>
        </div>
      </div>

      {phase.requiresForm && fields.length > 0 ? (
        <form
          ref={formRef}
          onSubmit={(e) => {
            e.preventDefault();
            const formData = new FormData(e.currentTarget);
            onFormSubmit(extractValues(fields, formData));
          }}
          className="space-y-4 border-t border-[color:var(--rule)] pt-4"
        >
          <p className="text-[12px] leading-relaxed text-[color:var(--muted-ink)]">
            Dieses Provider-Plugin braucht Konfiguration, bevor es
            aktiviert werden kann. Werte werden ausschließlich an den
            Vault dieses einen Plugins übergeben.
          </p>
          <div className="space-y-4">
            {fields.map((field) => (
              <FieldRow
                key={field.key}
                field={field}
                error={fieldErrors[field.key]}
                idPrefix={`wizard-step-${phase.stepIndex}`}
              />
            ))}
          </div>
        </form>
      ) : (
        <p className="text-[12px] text-[color:var(--muted-ink)]">
          Wird installiert …
        </p>
      )}

      {phase.stepError ? (
        <div className="border border-[color:var(--oxblood)] bg-[color:var(--oxblood)]/5 px-3 py-2">
          <p className="font-mono-num text-[12px] text-[color:var(--oxblood-ink)]">
            {phase.stepError}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function SuccessBody({
  targetPluginName,
}: {
  targetPluginName: string;
}): React.ReactElement {
  return (
    <div className="flex flex-col items-center gap-3 py-6 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-[color:var(--success)]/10 text-[color:var(--success)]">
        <Check className="size-6" aria-hidden />
      </div>
      <div className="font-display text-xl text-[color:var(--ink)]">
        Alles installiert
      </div>
      <p className="text-[12px] text-[color:var(--muted-ink)]">
        {targetPluginName} und alle Voraussetzungen sind aktiv.
      </p>
    </div>
  );
}

function ErrorBody({ message }: { message: string }): React.ReactElement {
  return (
    <div className="border border-[color:var(--oxblood)] bg-[color:var(--oxblood)]/5 p-4">
      <div className="text-[11px] uppercase tracking-[0.18em] text-[color:var(--oxblood)]">
        Fehler
      </div>
      <p className="font-mono-num mt-2 text-[13px] text-[color:var(--oxblood-ink)]">
        {message}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultProviderForEntry(
  entry: UnresolvedCapabilityEntry,
): string | null {
  // N=0 → operator must upload first (button disabled in ProviderPickRow)
  if (entry.providers.length === 0) return null;
  // N=1 → auto-preselect (Marcel's fork-#4 decision: always present
  // every option but pre-fill the obvious one).
  if (entry.providers.length === 1) {
    const only = entry.providers[0];
    return only ? only.id : null;
  }
  // N>1 → prefer an already-installed (but inactive) provider, then
  // any provider — operator must confirm.
  const reactivatable = entry.providers.find((p) => p.already_installed);
  if (reactivatable) return reactivatable.id;
  const first = entry.providers[0];
  return first ? first.id : null;
}

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    try {
      const body = JSON.parse(err.body) as {
        message?: string;
        code?: string;
      };
      return body.message ?? err.message;
    } catch {
      return err.message;
    }
  }
  return err instanceof Error ? err.message : String(err);
}
