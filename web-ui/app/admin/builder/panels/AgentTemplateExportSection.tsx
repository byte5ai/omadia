'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import {
  agentTemplateDownloadUrl,
  getAgentTemplateExport,
  type AgentTemplateEntryDto,
} from '../../../_lib/agentTemplates';

/**
 * #2049 — "Export as template" on the agent node of the Agent Builder
 * inspector (spec 2042 §5.2): the agent as one `agent_templates:` entry —
 * identity, persona, quality and the granted capability plugin ids, never
 * secrets, memory or bindings. YAML as a download; the JSON shown inline.
 */
export function AgentTemplateExportSection({ slug }: { slug: string }): React.ReactElement {
  const t = useTranslations('admin.builder.exportTemplate');
  const [entry, setEntry] = useState<AgentTemplateEntryDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleJson = async (): Promise<void> => {
    if (entry) {
      setEntry(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setEntry(await getAgentTemplateExport(slug));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="flex flex-col gap-2" data-testid="builder-export-template">
      <p className="text-[13px] font-semibold text-[color:var(--fg-strong)]">{t('title')}</p>
      <p className="text-xs text-[color:var(--fg-muted)]">{t('hint')}</p>
      <div className="flex flex-wrap gap-2">
        <a
          href={agentTemplateDownloadUrl(slug)}
          download
          data-testid="builder-export-template-download"
          className="rounded-md border border-[color:var(--border)] px-3 py-1.5 text-sm hover:border-[color:var(--accent)]"
        >
          {t('download')}
        </a>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          data-testid="builder-export-template-json"
          disabled={loading}
          onClick={() => void toggleJson()}
        >
          {entry ? t('hideJson') : t('showJson')}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-[color:var(--danger)]">
          {t('loadError', { detail: error })}
        </p>
      )}
      {entry && (
        <pre
          data-testid="builder-export-template-preview"
          className="max-h-64 overflow-auto rounded border border-[color:var(--border)] bg-[color:var(--bg-soft)]/40 p-2 text-[11px]"
        >
          {JSON.stringify({ agent_templates: [entry] }, null, 2)}
        </pre>
      )}
    </section>
  );
}
