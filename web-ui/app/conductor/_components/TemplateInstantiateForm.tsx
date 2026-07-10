'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import {
  ApiError,
  getConductorActions,
  getConductorAgents,
  getConductorEventCatalog,
  getConductorRoles,
  instantiateConductorTemplate,
  resolveConductorTemplate,
  type ConductorTemplate,
  type ConductorTemplateSlot,
  type ConductorTemplateSlotMapping,
} from '@/app/_lib/api';

import { ChannelSelect, gcLbl } from './GuidedControls';

/**
 * Workflow-template slot-mapping form (#429): ONE upfront form for the whole template
 * (never per-node walking). The operator maps every declared slot to an install-local
 * entity, then either publishes directly ("Create workflow" → POST instantiate) or
 * hands the resolved graph to the designer for editing before publish ("Open in
 * designer" → POST resolve, no persistence).
 *
 * The client-side completeness gate (slug + every slot mapped) mirrors the server's
 * missingSlotMappings check for fast feedback — the server stays authoritative, and
 * its error envelope maps back to inline field errors here (fail-clear). Lume: error
 * and warning colors are TEXT and EDGE only; in-flight is verb + animated dots via
 * the Button busy recipe, never a spinner.
 */

type SlotKind = 'roles' | 'agents' | 'actions' | 'events' | 'channels';

/** Render order — matches the gallery's "you will map" summary. */
const SLOT_KINDS: readonly SlotKind[] = ['roles', 'agents', 'actions', 'events', 'channels'];

const GROUP_LABEL_KEY: Record<SlotKind, string> = {
  roles: 'templateSlotGroupRoles',
  agents: 'templateSlotGroupAgents',
  actions: 'templateSlotGroupActions',
  events: 'templateSlotGroupEvents',
  channels: 'templateSlotGroupChannels',
};

/** Wire shape of the b3 error envelope (parsed out of ApiError.body). */
interface TemplateErrorBody {
  code?: string;
  message?: string;
  missing?: Array<{ kind: string; key: string; label: string }>;
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

type CatalogOptions = Array<{ value: string; label: string }>;
type Catalogs = Partial<Record<Exclude<SlotKind, 'channels'>, CatalogOptions>>;

// The base input class WITHOUT a border color (unlike gcInput), so the error edge is
// applied by swapping the color class instead of stacking two arbitrary-value border
// utilities whose CSS order would be undefined.
const FIELD_BASE = 'w-full rounded-md border bg-transparent px-2 py-1 text-[13px] text-[color:var(--fg-strong)]';

function fieldClass(invalid: boolean): string {
  return `${FIELD_BASE} ${invalid ? 'border-[color:var(--danger-edge)]' : 'border-[color:var(--border)]'}`;
}

export interface TemplateInstantiateFormProps {
  template: ConductorTemplate;
  onCreated: (slug: string) => void;
  /** Receives the resolved (substituted + validated) graph for canvas hydration. */
  onOpenInDesigner: (graph: unknown) => void;
  onCancel: () => void;
}

export function TemplateInstantiateForm({
  template,
  onCreated,
  onOpenInDesigner,
  onCancel,
}: TemplateInstantiateFormProps): React.JSX.Element {
  const t = useTranslations('conductor');

  const [slug, setSlug] = useState(template.defaultSlug);
  const [name, setName] = useState(template.name);
  const [enable, setEnable] = useState(false);
  // Channel slots are prefilled with the ChannelSelect's displayed default ('teams') so
  // the mapping state never diverges from what the operator sees in the select.
  const [mapping, setMapping] = useState<Record<SlotKind, Record<string, string>>>(() => {
    const channels: Record<string, string> = {};
    for (const slot of template.slots.channels ?? []) channels[slot.key] = 'teams';
    return { roles: {}, agents: {}, actions: {}, events: {}, channels };
  });
  const [catalogs, setCatalogs] = useState<Catalogs>({});
  const [pending, setPending] = useState<'create' | 'resolve' | null>(null);
  // Server-error surfaces (fail-clear): per-slot flags, slug conflict, graph-validation
  // messages, and a single generic line for everything else.
  const [flaggedSlots, setFlaggedSlots] = useState<ReadonlySet<string>>(new Set());
  const [slugError, setSlugError] = useState<string | null>(null);
  const [graphErrors, setGraphErrors] = useState<string[]>([]);
  const [genericError, setGenericError] = useState<string | null>(null);

  // Load only the catalogs the template actually declares slots for.
  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const next: Catalogs = {};
        await Promise.all([
          (template.slots.roles ?? []).length > 0
            ? getConductorRoles().then((r) => {
                next.roles = r.roles.map((role) => ({ value: role.key, label: role.label ?? role.key }));
              })
            : Promise.resolve(),
          (template.slots.agents ?? []).length > 0
            ? getConductorAgents().then((r) => {
                next.agents = r.agents.map((agent) => ({ value: agent.slug, label: agent.name }));
              })
            : Promise.resolve(),
          (template.slots.actions ?? []).length > 0
            ? getConductorActions().then((r) => {
                next.actions = r.actions.map((action) => ({ value: action, label: action }));
              })
            : Promise.resolve(),
          (template.slots.events ?? []).length > 0
            ? getConductorEventCatalog().then((r) => {
                next.events = r.events.map((event) => ({ value: event, label: event }));
              })
            : Promise.resolve(),
        ]);
        if (!cancelled) setCatalogs(next);
      } catch (err) {
        if (!cancelled) {
          setGenericError(t('templateRequestFailed', { message: err instanceof Error ? err.message : String(err) }));
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [template, t]);

  const declaredSlots = useMemo(
    () => SLOT_KINDS.flatMap((kind) => (template.slots[kind] ?? []).map((slot) => ({ kind, slot }))),
    [template],
  );

  // Mirror of the server's completeness check — fast feedback only, the server stays
  // authoritative (its incomplete/invalid envelopes still render inline below).
  const complete =
    slug.trim().length > 0 &&
    declaredSlots.every(({ kind, slot }) => (mapping[kind][slot.key] ?? '').trim().length > 0);

  const scheduled = (template.graph.triggers ?? []).some((trigger) => trigger.kind === 'cron');

  const setSlotValue = (kind: SlotKind, key: string, value: string): void => {
    setMapping((m) => ({ ...m, [kind]: { ...m[kind], [key]: value } }));
    setFlaggedSlots((prev) => {
      const id = `${kind}:${key}`;
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const clearErrors = (): void => {
    setFlaggedSlots(new Set());
    setSlugError(null);
    setGraphErrors([]);
    setGenericError(null);
  };

  const handleFailure = (err: unknown): void => {
    if (err instanceof ApiError) {
      const body = parseErrorBody(err.body);
      if (body.code === 'conductor.template_slot_mapping_incomplete' && Array.isArray(body.missing)) {
        setFlaggedSlots(new Set(body.missing.map((m) => `${m.kind}:${m.key}`)));
        return;
      }
      if (err.status === 409 || body.code === 'conductor.slug_exists') {
        setSlugError(t('templateSlugExistsError'));
        return;
      }
      if (body.code === 'conductor.invalid_graph' && Array.isArray(body.errors)) {
        setGraphErrors(body.errors.map((e) => e.message));
        return;
      }
      setGenericError(t('templateRequestFailed', { message: body.message ?? err.message }));
      return;
    }
    setGenericError(t('templateRequestFailed', { message: err instanceof Error ? err.message : String(err) }));
  };

  /** Only declared kinds go over the wire (mirrors TemplateSlotMapping semantics). */
  const buildMapping = (): ConductorTemplateSlotMapping => {
    const out: ConductorTemplateSlotMapping = {};
    for (const kind of SLOT_KINDS) {
      if ((template.slots[kind] ?? []).length > 0) out[kind] = { ...mapping[kind] };
    }
    return out;
  };

  const handleCreate = async (): Promise<void> => {
    const trimmedSlug = slug.trim();
    setPending('create');
    clearErrors();
    try {
      await instantiateConductorTemplate(template.id, {
        slug: trimmedSlug,
        name: name.trim(),
        mapping: buildMapping(),
        enable,
      });
      onCreated(trimmedSlug);
    } catch (err) {
      handleFailure(err);
    } finally {
      setPending(null);
    }
  };

  const handleResolve = async (): Promise<void> => {
    setPending('resolve');
    clearErrors();
    try {
      const res = await resolveConductorTemplate(template.id, buildMapping());
      onOpenInDesigner(res.graph);
    } catch (err) {
      handleFailure(err);
    } finally {
      setPending(null);
    }
  };

  const renderSlotField = (kind: SlotKind, slot: ConductorTemplateSlot): React.JSX.Element => {
    const flagged = flaggedSlots.has(`${kind}:${slot.key}`);
    if (kind === 'channels') {
      return (
        <div key={slot.key} className="grid gap-1">
          <ChannelSelect
            label={slot.label}
            value={mapping.channels[slot.key] ?? ''}
            onChange={(channel) => setSlotValue('channels', slot.key, channel)}
          />
          {slot.description ? <span className="text-[11px] text-[color:var(--fg-muted)]">{slot.description}</span> : null}
          {flagged ? <span className="text-[12px] text-[color:var(--danger)]">{t('templateSlotMissing')}</span> : null}
        </div>
      );
    }
    return (
      <label key={slot.key} className={gcLbl}>
        <span className={flagged ? 'text-[color:var(--danger)]' : undefined}>{slot.label}</span>
        <select
          className={fieldClass(flagged)}
          value={mapping[kind][slot.key] ?? ''}
          aria-invalid={flagged || undefined}
          onChange={(e) => setSlotValue(kind, slot.key, e.target.value)}
        >
          <option value="">—</option>
          {(catalogs[kind] ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {slot.description ? <span className="text-[11px] text-[color:var(--fg-muted)]">{slot.description}</span> : null}
        {flagged ? <span className="text-[12px] text-[color:var(--danger)]">{t('templateSlotMissing')}</span> : null}
      </label>
    );
  };

  const busyDisabled = !complete || pending !== null;

  return (
    <div className="rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4">
      <h3 className="text-[15px] font-medium text-[color:var(--fg-strong)]">
        {t('templateFormHeading', { name: template.name })}
      </h3>
      <p className="mt-1 max-w-2xl text-[13px] leading-[1.55] text-[color:var(--fg-muted)]">{template.description}</p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className={gcLbl}>
          <span className={slugError ? 'text-[color:var(--danger)]' : undefined}>{t('templateSlugLabel')}</span>
          <input
            className={`${fieldClass(slugError !== null)} font-mono`}
            value={slug}
            aria-invalid={slugError !== null || undefined}
            onChange={(e) => {
              setSlug(e.target.value);
              setSlugError(null);
            }}
          />
          {slugError ? <span className="text-[12px] text-[color:var(--danger)]">{slugError}</span> : null}
        </label>
        <label className={gcLbl}>
          {t('templateNameLabel')}
          <input className={fieldClass(false)} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
      </div>

      {SLOT_KINDS.map((kind) => {
        const slots = template.slots[kind] ?? [];
        if (slots.length === 0) return null;
        return (
          <fieldset key={kind} className="mt-4">
            <legend className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]">
              {t(GROUP_LABEL_KEY[kind])}
            </legend>
            <div className="grid gap-3 sm:grid-cols-2">{slots.map((slot) => renderSlotField(kind, slot))}</div>
            {kind === 'roles' && catalogs.roles !== undefined && catalogs.roles.length === 0 ? (
              <p className="mt-2 text-[12px] text-[color:var(--accent)]">{t('templateRolesEmptyHint')}</p>
            ) : null}
          </fieldset>
        );
      })}

      <label className="mt-5 flex items-center gap-2 text-[13px] text-[color:var(--fg)]">
        <input
          type="checkbox"
          className="accent-[color:var(--accent)]"
          checked={enable}
          onChange={(e) => setEnable(e.target.checked)}
        />
        {t('templateEnableLabel')}
      </label>
      {/* Schedule transparency (must-have): persistent warning-colored TEXT (no fill),
          shown whenever a cron-triggered template is about to go live on create. */}
      {enable && scheduled ? (
        <p className="mt-2 max-w-2xl text-[12px] leading-[1.5] text-[color:var(--warning)]">
          {t('templateScheduleNotice')}
        </p>
      ) : null}

      {graphErrors.length > 0 ? (
        <div className="mt-3 text-[13px] text-[color:var(--danger)]">
          <p>{t('templateInvalidGraphHeading')}</p>
          <ul className="mt-1 list-disc pl-5">
            {graphErrors.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {genericError ? <p className="mt-3 text-[13px] text-[color:var(--danger)]">{genericError}</p> : null}

      <div className="mt-5 flex flex-wrap gap-2">
        <Button
          variant="primary"
          busy={pending === 'create'}
          busyLabel={t('templateCreating')}
          disabled={busyDisabled}
          onClick={() => void handleCreate()}
        >
          {t('templateCreateButton')}
        </Button>
        <Button
          variant="secondary"
          busy={pending === 'resolve'}
          busyLabel={t('templatePreparing')}
          disabled={busyDisabled}
          onClick={() => void handleResolve()}
        >
          {t('templateOpenDesignerButton')}
        </Button>
        <Button variant="ghost" disabled={pending !== null} onClick={onCancel}>
          {t('templateCancelButton')}
        </Button>
      </div>
    </div>
  );
}
