'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { listMcpServers, type McpServerNode } from '@/app/_lib/agentBuilder';

import { McpAddConnectStep } from './McpAddServerModal.connect';
import { McpAddFindStep, McpAddPickStep } from './McpAddServerModal.steps';

export interface McpAddServerResolution {
  serverId: string;
  serverName: string;
  toolName: string;
  actionId: string;
}

export interface McpAddServerModalProps {
  initialQuery?: string;
  missingRef?: string;
  /** Re-open for an already connected server (the card's "Change"): skips Find and goes
   *  straight to connect → discover → pick, so the operator can choose another tool. */
  initialServerId?: string;
  onResolve: (resolution: McpAddServerResolution) => void;
  onClose: () => void;
}

type ModalStep = 'find' | 'connect' | 'pick';

export function McpAddServerModal({ initialQuery = '', missingRef, initialServerId, onResolve, onClose }: McpAddServerModalProps): React.ReactElement {
  const t = useTranslations('adminMcp');
  const [step, setStep] = useState<ModalStep>(initialServerId ? 'connect' : 'find');
  const [server, setServer] = useState<McpServerNode | null>(null);
  const [initialLoadError, setInitialLoadError] = useState<string | null>(null);
  const missingTool = (missingRef?.split('.').at(-1) ?? missingRef ?? '').toLowerCase();

  useEffect(() => {
    if (!initialServerId) return;
    let cancelled = false;
    listMcpServers()
      .then(({ servers }) => {
        if (cancelled) return;
        const found = servers.find((s) => s.id === initialServerId);
        if (found) setServer(found);
        else {
          setInitialLoadError(t('addModal.initialServerMissing'));
          setStep('find');
        }
      })
      .catch(() => {
        if (!cancelled) {
          setInitialLoadError(t('addModal.initialServerMissing'));
          setStep('find');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [initialServerId, t]);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function beginConnect(created: McpServerNode): void {
    setServer(created);
    setStep('connect');
  }

  function backToFind(): void {
    setServer(null);
    setStep('find');
  }

  function resolve(toolName: string): void {
    if (!server) return;
    onResolve({
      serverId: server.id,
      serverName: server.name,
      toolName,
      actionId: `mcp:${server.id}:${toolName}`,
    });
  }

  return (
    <div role="dialog" aria-modal="true" aria-label={t('addModal.title')} className="fixed inset-0 z-50 flex items-center justify-center bg-[color:var(--bg-modal-overlay)] p-4" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="w-full max-w-xl rounded-lg border border-[color:var(--border)] bg-[color:var(--bg-elevated)] p-4 shadow-lg">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-[color:var(--fg-strong)]">{t('addModal.title')}</h2>
            {missingRef ? <p className="mt-1 text-sm text-[color:var(--fg-muted)]">{t('addModal.missingRef', { ref: missingRef })}</p> : null}
          </div>
          {/* eslint-disable-next-line no-restricted-syntax -- icon-only chrome (✕ close glyph) */}
          <button type="button" onClick={onClose} aria-label={t('addModal.close')} className="text-[color:var(--fg-muted)] hover:text-[color:var(--fg-strong)]">✕</button>
        </div>
        <StepIndicator step={step} />
        {initialLoadError ? <p className="mt-3 text-sm text-[color:var(--danger)]">{initialLoadError}</p> : null}
        {step === 'find' ? <McpAddFindStep initialQuery={initialQuery} onServerCreated={beginConnect} /> : null}
        {step === 'connect' && server ? <McpAddConnectStep server={server} onServerChange={setServer} onDiscovered={(discovered) => { setServer(discovered); setStep('pick'); }} onBack={backToFind} /> : null}
        {step === 'pick' && server ? <McpAddPickStep server={server} missingTool={missingTool} onPick={resolve} onClose={onClose} onServerChange={setServer} /> : null}
      </div>
    </div>
  );
}

function StepIndicator({ step }: { step: ModalStep }): React.ReactElement {
  const t = useTranslations('adminMcp');
  const steps: Array<{ id: ModalStep; label: string }> = [
    { id: 'find', label: t('addModal.steps.find') },
    { id: 'connect', label: t('addModal.steps.connect') },
    { id: 'pick', label: t('addModal.steps.pick') },
  ];
  return (
    <ol data-testid="mcp-add-step-indicator" className="mt-4 flex items-center gap-2 text-xs text-[color:var(--fg-muted)]">
      {steps.map((item, index) => <li key={item.id} aria-current={item.id === step ? 'step' : undefined} className={item.id === step ? 'font-semibold text-[color:var(--accent)]' : undefined}>{index + 1} {item.label}{index < steps.length - 1 ? <span aria-hidden="true" className="ml-2">·</span> : null}</li>)}
    </ol>
  );
}
