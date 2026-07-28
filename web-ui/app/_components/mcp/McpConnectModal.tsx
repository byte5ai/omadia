'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '../ui/Button';
import { McpAuthSection } from './McpAuthSection';

/**
 * Shared MCP connect/login modal (epic #459). Wraps the Control Center connect
 * flow (`McpAuthSection`) in a dialog so both the chat auth-required card and the
 * Control Center's discover "needs authorization" prompt open the exact same
 * login experience. Uses the `chat.mcpAuth.*` copy so the two surfaces stay in
 * sync.
 */
export function McpConnectModal({
  serverId,
  serverName,
  onClose,
}: {
  serverId: string;
  serverName: string;
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
      aria-label={t('mcpAuth.modalTitle', { server: serverName })}
      className="fixed inset-0 z-50 flex items-center justify-center bg-[color:var(--bg-modal-overlay)] p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-lg border border-[color:var(--border)] bg-[color:var(--bg-elevated)] p-4 shadow-lg">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-base font-semibold text-[color:var(--fg-strong)]">
            {t('mcpAuth.modalTitle', { server: serverName })}
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
          {t('mcpAuth.modalBody', { server: serverName })}
        </p>
        <div className="mt-3">
          <McpAuthSection serverId={serverId} />
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
