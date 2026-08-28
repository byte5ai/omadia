'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import type { CanvasNodeKind, SkillImportResult } from '../../../_lib/agentBuilder';
import { SkillImportModal } from '../../../_components/admin/SkillImportModal';
import { SkillVerdictBadge } from '../../../_components/admin/SkillVerdictBadge';

/** Node kinds the operator can drag onto the canvas to create new entities. */
const ADDABLE: ReadonlyArray<Exclude<CanvasNodeKind, 'agent' | 'tool'>> = [
  'channel',
  'subagent',
  'skill',
  'mcp',
  'schedule',
];

export const DND_MIME = 'application/x-omadia-builder-node';

/**
 * Left rail — drag-to-add palette. Sets a typed drag payload the canvas
 * reads in `onDrop` to spawn a fresh node of that kind at the drop point.
 */
export function PalettePanel({
  onImported,
}: {
  /** Called after a skill is imported so the canvas can reload its graph. */
  /** OM-25 — receives the import result so a caller can react to a flagged
   *  verdict. Optional payload keeps existing callers source-compatible. */
  onImported?: (result: SkillImportResult) => void;
}): React.ReactElement {
  const t = useTranslations('admin.builder');
  const [importing, setImporting] = useState(false);
  // OM-25 — a flagged verdict must be visible WHERE the import happened, not
  // only later in the skills registry. Held locally until the next import.
  const [lastVerdict, setLastVerdict] = useState<SkillImportResult['verdict']>();
  return (
    <aside className="flex w-[180px] shrink-0 flex-col gap-2 border-r border-[color:var(--border)] bg-[color:var(--card)]/30 p-3">
      <h2 className="px-1 text-[11px] uppercase tracking-[0.16em] text-[color:var(--fg-muted)]">
        {t('palette.title')}
      </h2>
      {ADDABLE.map((kind) => (
        <div
          key={kind}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData(DND_MIME, kind);
            e.dataTransfer.effectAllowed = 'move';
          }}
          className="cursor-grab rounded-md border border-[color:var(--border)] bg-[color:var(--card)] px-3 py-2 text-[13px] text-[color:var(--fg-strong)] hover:border-[color:var(--accent)] active:cursor-grabbing"
        >
          {t(`nodes.${kind}`)}
        </div>
      ))}
      {/* eslint-disable-next-line no-restricted-syntax -- bespoke dashed add affordance, no §4.2 variant */}
      <button
        type="button"
        onClick={() => setImporting(true)}
        className="mt-2 rounded-md border border-dashed border-[color:var(--border-strong)] px-3 py-2 text-[13px] text-[color:var(--fg-muted)] hover:border-[color:var(--accent)]"
      >
        {t('palette.importSkill')}
      </button>
      {lastVerdict && lastVerdict.severity !== 'no_signals' ? (
        <div className="mt-1 px-1">
          <SkillVerdictBadge severity={lastVerdict.severity} />
        </div>
      ) : null}
      {importing && (
        <SkillImportModal
          onClose={() => setImporting(false)}
          // OM-25 — the import result (which now carries the security verdict)
          // used to be dropped on the floor here. Forward it so the canvas host
          // can surface a flagged import instead of silently adding the node.
          onImported={(result) => {
            setImporting(false);
            setLastVerdict(result.verdict);
            onImported?.(result);
          }}
        />
      )}
    </aside>
  );
}
