import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Message } from '../../_lib/chatSessions';
import { renderWithIntl } from '../../_lib/test-utils';
import { MessageRow } from '../page';

/**
 * Spec 2042 §6 criteria 29 and 31 — a settled answer in the web chat holds
 * its text and only the decorations the registry declares for `web`. The
 * trace, verification, system-data provenance, consulted agents, mode and
 * privacy receipt are reachable in the one collapsed answer-details element,
 * not as chips or footers around the answer.
 */

const NOOP = (): void => {};
// The registry lives in the channel SDK. web-ui has no build-time dependency
// on middleware packages (its Docker build context is web-ui/ alone), so the
// module is loaded at test time through a path the compiler does not resolve.
const DECORATIONS_MODULE = path.resolve(
  __dirname,
  '../../../../middleware/packages/harness-channel-sdk/src/decorations.ts',
);
const registry = (await import(/* @vite-ignore */ DECORATIONS_MODULE)) as {
  REMOVED_DECORATIONS: readonly string[];
  decorationsFor: (channel: string) => readonly { id: string }[];
};
const { REMOVED_DECORATIONS, decorationsFor } = registry;
const WEB = new Set(decorationsFor('web').map((d) => d.id));
/** Content of the answer itself, not a decoration (INV-4 speaker, notices). */
const ANSWER_PARTS = new Set(['speaker', 'prose', 'notice', 'attachments']);

function decorated(overrides: Partial<Message> = {}): Message {
  return {
    id: 'a1',
    role: 'assistant',
    content: 'Es sind 3 Rechnungen offen.',
    startedAt: 1_800_000_000_000,
    finishedAt: 1_800_000_004_000,
    speaker: { kind: 'agent', agentId: 'a-mira', slug: 'mira', displayName: 'Mira' },
    tools: [{ id: 't1', name: 'odoo_read', input: {}, output: '[]', durationMs: 120 }],
    telemetry: { tool_calls: 1, iterations: 2 },
    model: 'claude-sonnet-4-5',
    turnId: 'turn:s:1',
    systemData: true,
    verifier: {
      badge: 'verified',
      status: 'approved',
      claimCount: 3,
      contradictionCount: 0,
      unverifiedCount: 0,
      retryCount: 0,
      latencyMs: 40,
      mode: 'enforce',
    },
    agentsConsulted: [{ label: 'Strategist', status: 'success' }],
    answerVerbosity: { effective: 'standard', source: 'configured' },
    workingMode: { bucket: 'matched', classifierModel: 'haiku', skillId: 'invoices', modeName: 'Invoices' },
    followUpOptions: [{ label: 'Details zu Rechnung 1', prompt: 'Zeig mir Rechnung 1' }],
    ...overrides,
  };
}

function bubbleOf(container: HTMLElement): HTMLElement {
  const bubble = container.firstElementChild?.firstElementChild;
  if (!(bubble instanceof HTMLElement)) throw new Error('no message bubble');
  return bubble;
}

describe('web chat answer row — decoration registry (criterion 31)', () => {
  it('criterion 31: a settled answer renders only answer parts and decorations declared for web', () => {
    const { container } = renderWithIntl(
      <MessageRow message={decorated()} disabled={false} onChoose={NOOP} onResize={NOOP} onDiscardAutoPromoted={NOOP} />,
    );
    const children = [...bubbleOf(container).children];
    expect(children.length).toBeGreaterThan(0);
    for (const child of children) {
      const decoration = child.getAttribute('data-decoration');
      const part = child.getAttribute('data-answer-part');
      if (decoration !== null) {
        expect(WEB.has(decoration), `'${decoration}' is not declared for web`).toBe(true);
        continue;
      }
      expect(part !== null && ANSWER_PARTS.has(part), `undeclared element above/below the answer: ${child.outerHTML.slice(0, 160)}`).toBe(true);
    }
    for (const removed of REMOVED_DECORATIONS) expect(WEB.has(removed)).toBe(false);
  });

  it('criterion 29: verification, system data, trace and consulted agents are inside the collapsed answer details', () => {
    const { container } = renderWithIntl(
      <MessageRow message={decorated()} disabled={false} onChoose={NOOP} onResize={NOOP} onDiscardAutoPromoted={NOOP} />,
    );
    const details = container.querySelector('details[data-decoration="answer_details"]');
    expect(details).not.toBeNull();
    expect(details?.hasAttribute('open')).toBe(false);
    expect(details?.querySelector('[data-verifier-state="verified"]')).not.toBeNull();
    expect(details?.querySelector('[data-system-data="true"]')).not.toBeNull();
    expect(details?.textContent).toContain('odoo_read');
    expect(details?.textContent).toContain('Strategist');
    // and nothing of it outside
    const outside = [...bubbleOf(container).children].filter((c) => c !== details);
    for (const el of outside) {
      expect(el.querySelector('[data-verifier-state], [data-system-data]')).toBeNull();
    }
  });

  it('while the turn runs, progress stays in view and no details element exists yet', () => {
    const { container } = renderWithIntl(
      <MessageRow
        message={decorated({ streaming: true, finishedAt: undefined, verifier: undefined, systemData: undefined })}
        disabled={false}
        onChoose={NOOP}
        onDiscardAutoPromoted={NOOP}
      />,
    );
    expect(container.querySelector('details[data-decoration="answer_details"]')).toBeNull();
    expect(container.textContent).toContain('odoo_read');
  });
});
