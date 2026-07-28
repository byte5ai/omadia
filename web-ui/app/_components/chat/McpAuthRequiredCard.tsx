'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '../ui/Button';
import { McpConnectModal } from '../mcp/McpConnectModal';

/**
 * Epic #459 W9 — in-chat "this MCP server needs authorization" card.
 *
 * When a tool call hits an OAuth-protected MCP server the caller has not
 * authorized, the middleware returns a tool-result string carrying a machine
 * block:
 *
 *   <mcp-auth-required serverId="…" server="Strava" host="www.strava.com" needsClient="true"></mcp-auth-required>
 *
 * The chat parses that block out of the tool output (mirrors `parseNudgeBlock`),
 * and renders this card at the message level with a **Connect** button. Clicking
 * it opens a modal that reuses the exact Control Center connect flow
 * (`McpAuthSection`) — provider login for brokered servers, or a one-time client
 * registration form for servers that delegate OAuth. Nothing here is
 * provider-specific.
 */

export interface ParsedMcpAuthRequired {
  readonly serverId: string;
  readonly server: string;
  readonly host?: string;
  readonly needsClient: boolean;
}

interface ParseResult {
  readonly cleaned: string;
  readonly auth: ParsedMcpAuthRequired | null;
}

const BLOCK_REGEX = /<mcp-auth-required\b([^>]*?)\/?>(?:<\/mcp-auth-required>)?/;

function decodeXml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
  return m?.[1] !== undefined ? decodeXml(m[1]) : undefined;
}

/** Extract the `<mcp-auth-required>` block from a tool-result string. Returns
 *  the cleaned string (block removed) plus the parsed attributes, if present. */
export function parseMcpAuthRequired(content: string): ParseResult {
  if (!content.includes('<mcp-auth-required')) {
    return { cleaned: content, auth: null };
  }
  const match = BLOCK_REGEX.exec(content);
  if (!match) {
    return { cleaned: content, auth: null };
  }
  const [block, attrsRaw] = match;
  const attrs = attrsRaw ?? '';
  const serverId = attr(attrs, 'serverId');
  const server = attr(attrs, 'server');
  if (!serverId || !server) {
    return { cleaned: content, auth: null };
  }
  const cleaned = (content.slice(0, match.index) + content.slice(match.index + (block ?? '').length))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return {
    cleaned,
    auth: {
      serverId,
      server,
      host: attr(attrs, 'host'),
      needsClient: attr(attrs, 'needsClient') === 'true',
    },
  };
}

export function McpAuthRequiredCard({
  auth,
}: {
  auth: ParsedMcpAuthRequired;
}): React.ReactElement {
  const t = useTranslations('chat');
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-2 rounded-md border border-[color:var(--accent)] bg-[color:var(--accent)]/10 px-3 py-2 text-[12px] ring-1 ring-[color:var(--accent)]/40">
      <div className="mb-1 flex items-center gap-1 text-[11px] font-semibold tracking-wide text-[color:var(--accent)] uppercase">
        <span>🔒</span>
        <span>{t('mcpAuth.kicker')}</span>
      </div>
      <p className="text-[color:var(--fg-default)]">
        {t('mcpAuth.body', { server: auth.server })}
      </p>
      <div className="mt-2">
        <Button size="sm" variant="primary" onClick={() => setOpen(true)}>
          {t('mcpAuth.connect', { server: auth.server })}
        </Button>
      </div>
      {open ? (
        <McpConnectModal
          serverId={auth.serverId}
          serverName={auth.server}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}
