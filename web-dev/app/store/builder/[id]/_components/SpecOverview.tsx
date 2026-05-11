import type { AgentSpecSkeleton } from '../../../../_lib/builderTypes';

interface SpecOverviewProps {
  spec: AgentSpecSkeleton;
  slots: Record<string, string>;
}

/**
 * Read-only summary of the current spec. Lives in the Spec/Slot tab area
 * during B.5-1 — a humane placeholder that proves the draft loaded and
 * gives the user something to look at before B.5-5 wires the structured
 * spec form and B.5-6 the Monaco slot editor.
 */
export function SpecOverview({ spec, slots }: SpecOverviewProps): React.ReactElement {
  const toolCount = spec.tools?.length ?? 0;
  const dependsOnCount = spec.depends_on?.length ?? 0;
  const setupFieldCount = spec.setup_fields?.length ?? 0;
  const slotKeys = Object.keys(slots);
  const slotCount = slotKeys.length;
  const networkCount = spec.network?.outbound?.length ?? 0;

  return (
    <div className="grid grid-cols-1 gap-4 p-5 md:grid-cols-2">
      <Field label="Agent-ID" value={spec.id || '—'} mono />
      <Field label="Name" value={spec.name || '—'} />
      <Field label="Version" value={spec.version || '—'} mono />
      <Field label="Template" value={spec.template ?? 'agent-integration'} mono />
      <Field label="Kategorie" value={spec.category || '—'} />
      <Field
        label="Domain"
        value={spec.domain || '—'}
        mono
      />
      <Field
        label="Skill-Rolle"
        value={spec.skill?.role || '—'}
      />
      <Field
        label="Tools"
        value={toolCount === 0 ? 'keine' : `${toolCount}`}
      />
      <Field
        label="Slots"
        value={slotCount === 0 ? 'keine' : `${slotCount}`}
      />
      <Field
        label="depends_on"
        value={dependsOnCount === 0 ? '—' : `${dependsOnCount}`}
      />
      <Field
        label="Setup-Felder"
        value={setupFieldCount === 0 ? 'keine' : `${setupFieldCount}`}
      />
      <Field
        label="Outbound"
        value={networkCount === 0 ? '—' : `${networkCount} Hosts`}
      />
      <Field
        label="Beschreibung"
        value={spec.description || '—'}
        wide
      />
      {spec.playbook?.when_to_use ? (
        <Field
          label="when_to_use"
          value={spec.playbook.when_to_use}
          wide
        />
      ) : null}
      {slotCount > 0 ? (
        <div className="md:col-span-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[color:var(--fg-subtle)]">
            Slot-Keys
          </p>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {slotKeys.map((key) => (
              <li
                key={key}
                className="font-mono-num rounded-md bg-[color:var(--bg-soft)] px-2 py-0.5 text-[11px] text-[color:var(--fg-muted)]"
              >
                {key}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function Field({
  label,
  value,
  mono = false,
  wide = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  wide?: boolean;
}): React.ReactElement {
  return (
    <div className={wide ? 'md:col-span-2' : undefined}>
      <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[color:var(--fg-subtle)]">
        {label}
      </p>
      <p
        className={[
          'mt-1 break-words text-[14px] text-[color:var(--fg-strong)]',
          mono ? 'font-mono-num' : '',
        ].join(' ')}
      >
        {value}
      </p>
    </div>
  );
}
