'use client';

import { useTranslations } from 'next-intl';
import {
  NATIVE_TOOLS,
  type McpServerNode,
} from '../../../_lib/agentBuilder';

export const TOOL_DND_MIME = 'application/x-omadia-builder-tool';

export interface ToolDragPayload {
  toolKind: 'native' | 'mcp';
  toolRef: string;
  mcpServerId: string | null;
}

/**
 * Right rail — toolbox. Lists native tools plus each MCP server's
 * discovered tools. Dragging a tool onto an agent / sub-agent creates a
 * `tool_grant` edge (handled by the canvas `onDrop`).
 */
export function ToolboxPanel({
  mcpServers,
}: {
  mcpServers: McpServerNode[];
}): React.ReactElement {
  const t = useTranslations('admin.builder');

  function onDragStart(e: React.DragEvent, payload: ToolDragPayload): void {
    e.dataTransfer.setData(TOOL_DND_MIME, JSON.stringify(payload));
    e.dataTransfer.effectAllowed = 'link';
  }

  return (
    <aside className="flex w-[220px] shrink-0 flex-col gap-3 overflow-y-auto border-l border-[color:var(--border)] bg-[color:var(--card)]/30 p-3">
      <section>
        <h2 className="mb-2 px-1 text-[11px] uppercase tracking-[0.16em] text-[color:var(--fg-muted)]">
          {t('toolbox.native')}
        </h2>
        <div className="flex flex-col gap-1.5">
          {NATIVE_TOOLS.map((ref) => (
            <div
              key={ref}
              draggable
              onDragStart={(e) =>
                onDragStart(e, { toolKind: 'native', toolRef: ref, mcpServerId: null })
              }
              className="cursor-grab rounded-md border border-[color:var(--border)] bg-[color:var(--card)] px-2.5 py-1.5 text-[12px] text-[color:var(--fg-strong)] hover:border-[color:var(--accent)] active:cursor-grabbing"
            >
              {ref}
            </div>
          ))}
        </div>
      </section>

      {mcpServers.map((server) => (
        <section key={server.id}>
          <h2 className="mb-2 px-1 text-[11px] uppercase tracking-[0.16em] text-[color:var(--fg-muted)]">
            {server.name}
          </h2>
          {server.discoveredTools.length === 0 ? (
            <p className="px-1 text-[11px] text-[color:var(--fg-muted)]">
              {t('toolbox.noTools')}
            </p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {server.discoveredTools.map((tool) => (
                <div
                  key={tool.name}
                  draggable
                  title={tool.description}
                  onDragStart={(e) =>
                    onDragStart(e, {
                      toolKind: 'mcp',
                      toolRef: tool.name,
                      mcpServerId: server.id,
                    })
                  }
                  className="cursor-grab rounded-md border border-[color:var(--border)] bg-[color:var(--card)] px-2.5 py-1.5 text-[12px] text-[color:var(--fg-strong)] hover:border-[color:var(--accent)] active:cursor-grabbing"
                >
                  {tool.name}
                </div>
              ))}
            </div>
          )}
        </section>
      ))}
    </aside>
  );
}
