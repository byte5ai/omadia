'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '../ui/Button';
import { McpAuthSection } from '../mcp/McpAuthSection';

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

function ConnectModal({
  auth,
  onClose,
}: {
  auth: ParsedMcpAuthRequired;
  onClose: () => void;
}): React.ReactElement {
  const t = useTranslations('chat');

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('mcpAuth.modalTitle', { server: auth.server })}
      className="fixed inset-0 z-50 flex items-center justify-center bg-[color:var(--bg-modal-overlay)] p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-lg border border-[color:var(--border)] bg-[color:var(--bg-elevated)] p-4 shadow-lg">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-base font-semibold text-[color:var(--fg-strong)]">
            {t('mcpAuth.modalTitle', { server: auth.server })}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('mcpAuth.close')}
            className="text-[color:var(--fg-muted)] hover:text-[color:var(--fg-strong)]"
          >
            ✕
          </button>
        </div>
        <p className="mt-2 text-sm text-[color:var(--fg-muted)]">
          {t('mcpAuth.modalBody', { server: auth.server })}
        </p>
        <div className="mt-3">
          <McpAuthSection serverId={auth.serverId} />
        </div>
        <div className="mt-4 flex justify-end">
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t('mcpAuth.close')}
          </Button>
        </div>
      </div>
    </div>
  );
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
      {open ? <ConnectModal auth={auth} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}
