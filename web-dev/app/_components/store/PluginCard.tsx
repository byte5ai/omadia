import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';

import type { Plugin } from '../../_lib/storeTypes';
import { Chip } from './Chip';
import { PluginIcon } from './PluginIcon';
import { StateBadge } from './StateBadge';

interface PluginCardProps {
  plugin: Plugin;
  index: number;
}

export function PluginCard({
  plugin,
  index,
}: PluginCardProps): React.ReactElement {
  const isLegacy = plugin.categories.includes('legacy');
  const visibleCategories = plugin.categories
    .filter((c) => c !== 'legacy')
    .slice(0, 3);
  const visibleIntegrations = plugin.integrations_summary.slice(0, 2);

  return (
    <Link
      href={`/store/${encodeURIComponent(plugin.id)}`}
      className="group relative flex flex-col rounded-[14px] bg-[color:var(--bg-elevated)] p-6 shadow-[0_2px_6px_rgba(0,75,115,0.08)] transition-[transform,box-shadow] duration-[var(--dur-base)] ease-[var(--ease-out)] hover:-translate-y-0.5 hover:shadow-[0_8px_24px_rgba(0,75,115,0.10)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--accent)]"
    >
      {/* Card index — subtle tick */}
      <span className="font-mono-num absolute right-4 top-4 text-[10px] text-[color:var(--fg-subtle)]">
        № {formatIndex(index)}
      </span>

      <div className="flex items-start gap-4">
        <PluginIcon
          name={plugin.name}
          iconUrl={plugin.icon_url}
          size="md"
          tone={isLegacy ? 'legacy' : 'default'}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <h3 className="font-display text-[22px] leading-[1.15] text-[color:var(--fg-strong)]">
            {plugin.name}
          </h3>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[color:var(--fg-muted)]">
            <span className="font-mono-num">{plugin.id}</span>
            <span className="text-[color:var(--fg-subtle)]">·</span>
            <span className="font-mono-num">v{plugin.version}</span>
          </div>
        </div>
      </div>

      <p className="mt-5 line-clamp-3 text-[14px] leading-relaxed text-[color:var(--fg-muted)]">
        {plugin.description || <em>Keine Beschreibung hinterlegt.</em>}
      </p>

      {/* Metadata row */}
      <div className="mt-5 flex flex-wrap items-center gap-1.5">
        <StateBadge state={plugin.install_state} isLegacy={isLegacy} />
        {visibleCategories.map((cat) => (
          <Chip key={cat} tone="muted">
            {cat}
          </Chip>
        ))}
      </div>

      {/* Integrations pinned at bottom */}
      {visibleIntegrations.length > 0 ? (
        <div className="mt-5 border-t border-[color:var(--divider)] pt-3">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[11px]">
            <span className="uppercase tracking-[0.18em] text-[color:var(--fg-subtle)]">
              Integration
            </span>
            <span className="text-[color:var(--fg-muted)]">
              {visibleIntegrations.join(' · ')}
              {plugin.integrations_summary.length >
                visibleIntegrations.length && (
                <span className="text-[color:var(--fg-subtle)]">
                  {' '}
                  +{plugin.integrations_summary.length - visibleIntegrations.length}
                </span>
              )}
            </span>
          </div>
        </div>
      ) : null}

      <ArrowUpRight
        className="absolute bottom-5 right-5 size-4 text-[color:var(--accent)] opacity-0 transition group-hover:opacity-100"
        aria-hidden
      />
    </Link>
  );
}

function formatIndex(n: number): string {
  return String(n).padStart(2, '0');
}
