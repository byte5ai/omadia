'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, CheckCircle2, Loader2, ShieldCheck, X } from 'lucide-react';

import { installBuilderDraft, patchBuilderSpec } from '../../../../_lib/api';
import { cn } from '../../../../_lib/cn';
import type {
  Draft,
  InstallFailureReason,
  InstallResponse,
} from '../../../../_lib/builderTypes';

/**
 * Frontend mirror of middleware's `bumpPatchVersion` (Theme C). Strips
 * any prerelease tag and increments the patch segment. Returns input
 * unchanged for non-semver garbage so the operator's typo stays
 * surfaced rather than silently rewritten.
 *
 * Examples: 0.1.0 → 0.1.1, 1.2.3-alpha.4 → 1.2.4, 'whatever' → 'whatever'.
 */
function bumpPatchVersion(version: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-[A-Za-z0-9.-]+)?$/.exec(version);
  if (!m) return version;
  const [, major, minor, patch] = m;
  return `${major}.${minor}.${String(Number(patch) + 1)}`;
}

/**
 * Install-Diff-Gate (B.6-2 / M3 from the master plan).
 *
 * Shows the operator the full surface that will be committed to the plugin
 * registry, then POSTs `/api/v1/builder/drafts/:id/install` and reacts to
 * the orchestrator's discriminated `InstallResponse`:
 *
 *   reason: undefined (ok=true)  → flash success then push /store?highlight=…
 *   reason: 'conflict'          → inline banner ("ID schon installiert" /
 *                                  "Version bereits hochgeladen") with hint;
 *                                  user has to change spec and rebuild
 *   reason: 'build_failed' /     → banner with the structured tsc errors / Zod
 *           'codegen_failed' /    issues — operator goes back to the Editor pane
 *           'spec_invalid'
 *   reason: 'manifest_invalid' / → generic banner; rare in B.6 because we
 *           'too_large'           always build from a fresh codegen
 *   reason: 'pipeline_failed' /  → banner with raw message; treat as 5xx
 *           'ingest_failed'
 *
 * The modal does NOT pre-check for conflicts client-side: the server is the
 * single source of truth for the registry state, and the round-trip is
 * already required for the actual commit. Reserved-prefix/peer-dep checks
 * are server-side too (B.7+).
 */

export interface InstallDiffModalProps {
  draft: Draft;
  open: boolean;
  onClose: () => void;
  /** Optional override for tests — defaults to the real installBuilderDraft. */
  install?: (draftId: string) => Promise<InstallResponse>;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'installing' }
  | { kind: 'failed'; failure: InstallFailureBody }
  | { kind: 'succeeded'; installedAgentId: string; version: string };

interface InstallFailureBody {
  reason: InstallFailureReason;
  code: string;
  message: string;
  details?: unknown;
}

export function InstallDiffModal({
  draft,
  open,
  onClose,
  install,
}: InstallDiffModalProps): React.ReactElement | null {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  if (!open) return null;

  const busy = phase.kind === 'installing';

  const handleInstall = async (): Promise<void> => {
    setPhase({ kind: 'installing' });
    try {
      const fn = install ?? installBuilderDraft;
      const result = await fn(draft.id);
      if (result.ok) {
        setPhase({
          kind: 'succeeded',
          installedAgentId: result.installedAgentId,
          version: result.version,
        });
        // Brief delay so the user sees the success banner before the redirect.
        window.setTimeout(() => {
          router.push(
            `/store?highlight=${encodeURIComponent(result.installedAgentId)}`,
          );
        }, 600);
        return;
      }
      setPhase({
        kind: 'failed',
        failure: {
          reason: result.reason,
          code: result.code,
          message: result.message,
          ...(result.details !== undefined ? { details: result.details } : {}),
        },
      });
    } catch (err) {
      setPhase({
        kind: 'failed',
        failure: {
          reason: 'ingest_failed',
          code: 'builder.transport_error',
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  };

  const handleClose = (): void => {
    if (busy) return;
    setPhase({ kind: 'idle' });
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4 py-6"
      role="dialog"
      aria-modal="true"
      aria-label="Plugin installieren"
    >
      <button
        type="button"
        onClick={handleClose}
        aria-label="Modal schließen"
        disabled={busy}
        className="absolute inset-0 bg-[color:var(--ink)]/40 backdrop-blur-sm transition disabled:cursor-wait"
      />

      <div
        className={cn(
          'relative z-10 flex w-full max-w-4xl flex-col',
          'border border-[color:var(--rule-strong)] bg-[color:var(--paper)]',
          'shadow-[0_30px_80px_-20px_rgba(0,0,0,0.4)]',
          'max-h-[90vh] overflow-hidden',
        )}
      >
        <header className="flex items-start justify-between gap-6 border-b border-[color:var(--rule)] px-7 py-5">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.22em] text-[color:var(--accent)]">
              <ShieldCheck className="size-3.5" aria-hidden />
              Install-Diff-Gate
            </div>
            <h2 className="font-display mt-1 text-2xl font-medium leading-tight text-[color:var(--ink)]">
              Plugin installieren
            </h2>
            <p className="mt-2 text-[12px] leading-relaxed text-[color:var(--muted-ink)]">
              Diese Surface wird in den Plugin-Store geschrieben. Nach „Installieren&ldquo;
              ist <span className="font-mono-num">{draft.spec.id}</span> v
              {draft.spec.version} für alle Agents im Tenant verfügbar.
            </p>
          </div>
          <button
            type="button"
            onClick={handleClose}
            disabled={busy}
            className="text-[color:var(--muted-ink)] transition hover:text-[color:var(--ink)] disabled:opacity-40"
            aria-label="Schließen"
          >
            <X className="size-4" aria-hidden />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-7 py-6">
          {phase.kind === 'failed' ? (
            <FailureBanner
              failure={phase.failure}
              onRetry={() => setPhase({ kind: 'idle' })}
              currentVersion={draft.spec.version}
              onBumpAndRetry={async () => {
                // Theme C, retry-path: server-side auto-bump only
                // triggers at clone-from-installed. Drafts that predate
                // that fix (or where the operator manually re-edited
                // the version back) still hit duplicate_version. This
                // handler patches the spec.version inline and immediately
                // retries the install — zero-friction self-fix without
                // forcing the operator to navigate to the spec editor.
                const next = bumpPatchVersion(draft.spec.version);
                if (next === draft.spec.version) {
                  setPhase({
                    kind: 'failed',
                    failure: {
                      reason: 'conflict',
                      code: 'builder.bump_invalid_semver',
                      message: `Version '${draft.spec.version}' ist kein Semver — manuell anpassen im Spec-Editor.`,
                    },
                  });
                  return;
                }
                try {
                  await patchBuilderSpec(draft.id, [
                    { op: 'replace', path: '/version', value: next },
                  ]);
                } catch (err) {
                  setPhase({
                    kind: 'failed',
                    failure: {
                      reason: 'conflict',
                      code: 'builder.bump_patch_failed',
                      message:
                        err instanceof Error ? err.message : String(err),
                    },
                  });
                  return;
                }
                // Server now has the bumped spec; re-trigger install.
                await handleInstall();
              }}
            />
          ) : null}
          {phase.kind === 'succeeded' ? (
            <SuccessBanner
              installedAgentId={phase.installedAgentId}
              version={phase.version}
            />
          ) : null}

          <DiffBody draft={draft} />
        </div>

        <footer className="flex items-center justify-end gap-3 border-t border-[color:var(--rule)] px-7 py-4">
          <button
            type="button"
            onClick={handleClose}
            disabled={busy}
            className={cn(
              'rounded-md px-4 py-2 text-[12px] font-semibold uppercase tracking-[0.18em]',
              'text-[color:var(--fg-muted)] transition-colors',
              'hover:bg-[color:var(--bg-soft)] hover:text-[color:var(--fg-strong)]',
              'disabled:opacity-40 disabled:cursor-not-allowed',
            )}
          >
            Zurück
          </button>
          <button
            type="button"
            onClick={() => void handleInstall()}
            disabled={busy || phase.kind === 'succeeded'}
            className={cn(
              'inline-flex items-center gap-2 rounded-md px-5 py-2 text-[12px] font-semibold uppercase tracking-[0.18em]',
              'bg-[color:var(--accent)] text-white shadow-[var(--shadow-cta)]',
              'transition-opacity',
              'disabled:opacity-50 disabled:cursor-not-allowed',
            )}
          >
            {busy ? (
              <>
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                Installiere …
              </>
            ) : phase.kind === 'succeeded' ? (
              <>
                <CheckCircle2 className="size-3.5" aria-hidden />
                Erfolgreich
              </>
            ) : (
              'Installieren'
            )}
          </button>
        </footer>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Body sections
// ---------------------------------------------------------------------------

function DiffBody({ draft }: { draft: Draft }): React.ReactElement {
  const spec = draft.spec;
  const skillPromptSlot = draft.slots['skill-prompt'];
  return (
    <div className="space-y-6">
      <Section title="Identität">
        <KV k="ID" v={<span className="font-mono-num">{spec.id}</span>} />
        <KV k="Name" v={spec.name} />
        <KV k="Version" v={<span className="font-mono-num">{spec.version}</span>} />
        <KV k="Kategorie" v={spec.category} />
        <KV
          k="Domain"
          v={<span className="font-mono-num">{spec.domain || '—'}</span>}
        />
        <KV k="Template" v={spec.template ?? 'agent-integration'} />
        <KV k="Beschreibung" v={spec.description} />
      </Section>

      <Section title="Skill / System-Prompt">
        <KV k="Rolle" v={spec.skill.role} />
        {spec.skill.tonality ? <KV k="Tonalität" v={spec.skill.tonality} /> : null}
        {skillPromptSlot ? (
          <details className="mt-2 rounded-md border border-[color:var(--divider)] bg-[color:var(--bg-soft)]">
            <summary className="cursor-pointer px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--fg-muted)]">
              skill-prompt slot ({skillPromptSlot.length} Zeichen)
            </summary>
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words border-t border-[color:var(--divider)] px-3 py-2 text-[11px] font-mono leading-relaxed text-[color:var(--fg-strong)]">
              {skillPromptSlot}
            </pre>
          </details>
        ) : (
          <p className="text-[11px] italic text-[color:var(--fg-subtle)]">
            Kein dediziertes skill-prompt-Slot — der Agent läuft mit der
            Boilerplate-Default-Anweisung.
          </p>
        )}
      </Section>

      <Section
        title="Tools"
        subtitle={`${String(spec.tools.length)} ${spec.tools.length === 1 ? 'Tool' : 'Tools'}`}
      >
        {spec.tools.length === 0 ? (
          <EmptyHint>Keine Tools definiert.</EmptyHint>
        ) : (
          <ul className="space-y-2">
            {spec.tools.map((t) => (
              <li
                key={t.id}
                className="rounded-md border border-[color:var(--divider)] bg-[color:var(--bg-soft)] px-3 py-2"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-mono-num text-[12px] font-semibold text-[color:var(--fg-strong)]">
                    {t.id}
                  </span>
                </div>
                <p className="mt-1 text-[11px] text-[color:var(--fg-muted)]">
                  {t.description}
                </p>
                {t.input ? (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--fg-subtle)]">
                      input schema
                    </summary>
                    <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border border-[color:var(--divider)] bg-[color:var(--paper)] px-2 py-1.5 text-[10px] font-mono leading-relaxed text-[color:var(--fg-strong)]">
                      {JSON.stringify(t.input, null, 2)}
                    </pre>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Abhängigkeiten"
        subtitle="depends_on (gewährt Vault-Scopes)"
      >
        {spec.depends_on.length === 0 ? (
          <EmptyHint>Keine Plugin-Abhängigkeiten.</EmptyHint>
        ) : (
          <ul className="space-y-1">
            {spec.depends_on.map((d) => (
              <li
                key={d}
                className="font-mono-num text-[12px] text-[color:var(--fg-strong)]"
              >
                {d}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Netzwerk"
        subtitle="permissions.network.outbound"
      >
        {spec.network.outbound.length === 0 ? (
          <EmptyHint>Keine ausgehenden Hosts deklariert.</EmptyHint>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {spec.network.outbound.map((h) => (
              <li
                key={h}
                className="font-mono-num rounded-full border border-[color:var(--divider)] bg-[color:var(--bg-soft)] px-2.5 py-0.5 text-[11px] text-[color:var(--fg-strong)]"
              >
                {h}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Setup-Felder"
        subtitle="vom Operator beim Aktivieren auszufüllen"
      >
        {spec.setup_fields.length === 0 ? (
          <EmptyHint>Kein Setup nötig.</EmptyHint>
        ) : (
          <ul className="space-y-1">
            {spec.setup_fields.map((f) => (
              <li
                key={f.key}
                className="flex items-baseline justify-between gap-3 rounded-md border border-[color:var(--divider)] px-3 py-1.5"
              >
                <span className="font-mono-num text-[12px] text-[color:var(--fg-strong)]">
                  {f.key}
                </span>
                <span className="text-[10px] uppercase tracking-[0.18em] text-[color:var(--fg-subtle)]">
                  {f.type ?? 'string'}
                  {f.required ? ' · required' : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section>
      <div className="mb-2 flex items-baseline gap-2">
        <h3 className="font-display text-[14px] font-semibold text-[color:var(--fg-strong)]">
          {title}
        </h3>
        {subtitle ? (
          <span className="text-[11px] text-[color:var(--fg-subtle)]">{subtitle}</span>
        ) : null}
      </div>
      <div className="space-y-1.5 text-[12px]">{children}</div>
    </section>
  );
}

function KV({
  k,
  v,
}: {
  k: string;
  v: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="grid grid-cols-[140px_1fr] items-baseline gap-3">
      <dt className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[color:var(--fg-subtle)]">
        {k}
      </dt>
      <dd className="text-[12px] text-[color:var(--fg-strong)]">{v}</dd>
    </div>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <p className="text-[11px] italic text-[color:var(--fg-subtle)]">{children}</p>
  );
}

// ---------------------------------------------------------------------------
// Banners
// ---------------------------------------------------------------------------

function FailureBanner({
  failure,
  onRetry,
  currentVersion,
  onBumpAndRetry,
}: {
  failure: InstallFailureBody;
  onRetry: () => void;
  currentVersion: string;
  onBumpAndRetry: () => void | Promise<void>;
}): React.ReactElement {
  const heading = HEADINGS[failure.reason] ?? 'Installation fehlgeschlagen';
  const hint = HINTS[failure.reason];
  // Theme C: only the duplicate_version sub-case of `conflict` is fixable
  // by bumping. We can't reliably distinguish from `id` collisions on
  // reason alone, so we ALSO check the code prefix. `package.duplicate_version`
  // is the canonical code emitted by packageUploadService.
  const isDuplicateVersion =
    failure.reason === 'conflict' &&
    failure.code.includes('duplicate_version');
  const bumped = isDuplicateVersion ? bumpPatchVersion(currentVersion) : null;
  const canBump = bumped !== null && bumped !== currentVersion;

  return (
    <div className="mb-6 rounded-md border border-[color:var(--danger)]/40 bg-[color:var(--danger)]/6 px-4 py-3">
      <div className="flex items-start gap-3">
        <AlertTriangle
          className="mt-0.5 size-4 shrink-0 text-[color:var(--danger)]"
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-3">
            <p className="font-display text-[13px] font-semibold text-[color:var(--danger)]">
              {heading}
            </p>
            <span className="font-mono-num text-[10px] uppercase tracking-[0.16em] text-[color:var(--fg-subtle)]">
              {failure.code}
            </span>
          </div>
          <p className="mt-1 text-[12px] text-[color:var(--fg-strong)]">
            {failure.message}
          </p>
          {hint ? (
            <p className="mt-2 text-[11px] italic text-[color:var(--fg-muted)]">
              {hint}
            </p>
          ) : null}
          <FailureDetails failure={failure} />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {canBump ? (
              <button
                type="button"
                onClick={() => void onBumpAndRetry()}
                className="inline-flex items-center gap-2 rounded-md bg-[color:var(--accent)] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-white shadow-sm transition-opacity hover:opacity-90"
              >
                Version anheben ({currentVersion} → {bumped}) + Installieren
              </button>
            ) : null}
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex items-center gap-2 rounded-md border border-[color:var(--divider)] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-[color:var(--fg-strong)] transition-colors hover:bg-[color:var(--bg-soft)]"
            >
              Erneut versuchen
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function FailureDetails({
  failure,
}: {
  failure: InstallFailureBody;
}): React.ReactElement | null {
  const details = failure.details;
  if (!details || typeof details !== 'object') return null;

  // build_failed → { errors: BuildError[], stderrTail, ... }
  if (failure.reason === 'build_failed') {
    const errors = (details as { errors?: unknown[] }).errors;
    if (Array.isArray(errors) && errors.length > 0) {
      return (
        <details className="mt-2">
          <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-[0.16em] text-[color:var(--fg-muted)]">
            {String(errors.length)} TypeScript-Fehler
          </summary>
          <ul className="mt-1.5 space-y-1">
            {errors.slice(0, 10).map((e, i) => {
              const row = e as {
                path?: string;
                line?: number;
                col?: number;
                code?: string;
                message?: string;
              };
              return (
                <li
                  key={i}
                  className="rounded border border-[color:var(--divider)] bg-[color:var(--paper)] px-2 py-1.5 text-[10px] font-mono leading-relaxed"
                >
                  <span className="text-[color:var(--fg-subtle)]">
                    {row.path ?? '?'}:{row.line ?? '?'}:{row.col ?? '?'}
                  </span>
                  <span className="ml-2 text-[color:var(--danger)]">
                    {row.code ?? ''}
                  </span>
                  <div className="mt-0.5 text-[color:var(--fg-strong)]">
                    {row.message ?? ''}
                  </div>
                </li>
              );
            })}
          </ul>
        </details>
      );
    }
  }

  // codegen_failed → { issues: CodegenIssue[] }
  if (failure.reason === 'codegen_failed') {
    const issues = (details as { issues?: unknown[] }).issues;
    if (Array.isArray(issues) && issues.length > 0) {
      return (
        <details className="mt-2">
          <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-[0.16em] text-[color:var(--fg-muted)]">
            {String(issues.length)} Codegen-Issue{issues.length === 1 ? '' : 's'}
          </summary>
          <ul className="mt-1.5 space-y-1">
            {issues.map((i, idx) => {
              const row = i as { code?: string; detail?: string };
              return (
                <li
                  key={idx}
                  className="rounded border border-[color:var(--divider)] bg-[color:var(--paper)] px-2 py-1.5 text-[11px]"
                >
                  <span className="font-mono-num text-[10px] uppercase tracking-[0.14em] text-[color:var(--fg-subtle)]">
                    {row.code ?? '?'}
                  </span>
                  <div className="mt-0.5 text-[color:var(--fg-strong)]">
                    {row.detail ?? ''}
                  </div>
                </li>
              );
            })}
          </ul>
        </details>
      );
    }
  }

  return null;
}

function SuccessBanner({
  installedAgentId,
  version,
}: {
  installedAgentId: string;
  version: string;
}): React.ReactElement {
  return (
    <div className="mb-6 rounded-md border border-[color:var(--success)]/40 bg-[color:var(--success)]/6 px-4 py-3">
      <div className="flex items-start gap-3">
        <CheckCircle2
          className="mt-0.5 size-4 shrink-0 text-[color:var(--success)]"
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <p className="font-display text-[13px] font-semibold text-[color:var(--success)]">
            Plugin installiert
          </p>
          <p className="mt-1 text-[12px] text-[color:var(--fg-strong)]">
            <span className="font-mono-num">{installedAgentId}</span> v{version}{' '}
            ist im Store sichtbar. Weiterleitung läuft …
          </p>
        </div>
      </div>
    </div>
  );
}

const HEADINGS: Partial<Record<InstallFailureReason, string>> = {
  conflict: 'Plugin-ID-Konflikt',
  build_failed: 'Build fehlgeschlagen (tsc)',
  codegen_failed: 'Codegen fehlgeschlagen',
  spec_invalid: 'Spec-Validierung fehlgeschlagen',
  manifest_invalid: 'manifest.yaml ungültig',
  too_large: 'Package zu groß',
  pipeline_failed: 'Build-Pipeline-Fehler',
  ingest_failed: 'Ingest-Fehler',
  draft_not_found: 'Draft nicht gefunden',
};

const HINTS: Partial<Record<InstallFailureReason, string>> = {
  conflict:
    'Lösch das existierende Plugin im Store oder ändere `id` / `version` in der Spec.',
  build_failed:
    'Geh zurück in den Slot-Editor und korrigiere die Stellen, die der Compiler markiert.',
  codegen_failed:
    'Die Spec hat fehlende Pflichtfelder oder unaufgelöste Platzhalter — siehe Issue-Liste.',
  spec_invalid:
    'Die Spec hat ein Schema-Problem. Prüfe Pflichtfelder im Spec-Editor.',
  too_large:
    'Reduziere Slot-Inhalte oder Asset-Größen — der Server-Limit ist erreicht.',
};
