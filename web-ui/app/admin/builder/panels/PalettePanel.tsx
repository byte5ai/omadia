'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import type { CanvasNodeKind } from '../../../_lib/agentBuilder';
import { SkillImportModal } from '../../../_components/admin/SkillImportModal';

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
  onImported?: () => void;
}): React.ReactElement {
  const t = useTranslations('admin.builder');
  const [importing, setImporting] = useState(false);
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
      <button
        type="button"
        onClick={() => setImporting(true)}
        className="mt-2 rounded-md border border-dashed border-[color:var(--border-strong)] px-3 py-2 text-[13px] text-[color:var(--fg-muted)] hover:border-[color:var(--accent)]"
      >
        {t('palette.importSkill')}
      </button>
      {importing && (
        <SkillImportModal
          onClose={() => setImporting(false)}
          onImported={() => {
            setImporting(false);
            onImported?.();
          }}
        />
      )}
    </aside>
  );
}
