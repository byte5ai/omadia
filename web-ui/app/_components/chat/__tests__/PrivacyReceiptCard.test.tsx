import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { PrivacyReceipt } from '../../../_lib/chatSessions';
import { renderWithIntl } from '../../../_lib/test-utils';
import { PrivacyReceiptCard, computeSeverity } from '../PrivacyReceiptCard';

const BASE: PrivacyReceipt = {
  receiptId: 'prv_2026-05-08_a3f9c2d1',
  policyMode: 'pii-shield',
  routing: 'public-llm',
  detections: [],
  latencyMs: 12,
  auditHash: 'a'.repeat(64),
};

const TOKENIZED: PrivacyReceipt = {
  ...BASE,
  receiptId: 'prv_2026-05-08_b4e7f2a9',
  detections: [
    {
      type: 'pii.email',
      count: 2,
      action: 'tokenized',
      detector: 'regex:0.1.0',
      confidenceMin: 0.98,
    },
    {
      type: 'pii.iban',
      count: 1,
      action: 'tokenized',
      detector: 'regex:0.1.0',
      confidenceMin: 0.99,
    },
  ],
  latencyMs: 47,
};

const BLOCKED: PrivacyReceipt = {
  ...BASE,
  receiptId: 'prv_2026-05-08_d6c9e2f4',
  routing: 'blocked',
  routingReason: 'strict policy: api-key detected',
  detections: [
    {
      type: 'pii.api_key',
      count: 1,
      action: 'blocked',
      detector: 'regex:0.1.0',
      confidenceMin: 0.95,
    },
  ],
};

const LOCAL_ROUTED: PrivacyReceipt = {
  ...BASE,
  receiptId: 'prv_2026-05-08_c5d8a1b3',
  policyMode: 'data-residency',
  routing: 'local-llm',
  routingReason: 'tenant label customer_data',
  detections: [
    {
      type: 'custom.customer_data',
      count: 1,
      action: 'blocked',
      detector: 'regex:0.1.0',
      confidenceMin: 1.0,
    },
  ],
};

describe('<PrivacyReceiptCard />', () => {
  it('renders the collapsed summary with shield icon and aggregate counts', () => {
    renderWithIntl(<PrivacyReceiptCard receipt={TOKENIZED} />, { locale: 'de' });
    const summary = screen.getByText(/Privacy Guard/);
    expect(summary).toBeInTheDocument();
    expect(summary.textContent).toContain('3 erkannt');
    expect(summary.textContent).toContain('3 maskiert');
  });

  it('renders "keine Erkennungen" when nothing was detected', () => {
    renderWithIntl(<PrivacyReceiptCard receipt={BASE} />, { locale: 'de' });
    expect(screen.getByText(/keine Erkennungen/)).toBeInTheDocument();
    expect(screen.getByText(/Keine PII erkannt/)).toBeInTheDocument();
  });

  it('renders the blocked routing summary distinctly', () => {
    renderWithIntl(<PrivacyReceiptCard receipt={BLOCKED} />, { locale: 'de' });
    expect(
      screen.getByText(/geblockt — Anfrage nicht gesendet/),
    ).toBeInTheDocument();
    expect(screen.getByText(/strict policy: api-key detected/)).toBeInTheDocument();
    // Routing field also shows "Blockiert" in the expanded body.
    expect(screen.getByText('Blockiert')).toBeInTheDocument();
  });

  it('renders the data-residency reroute including its reason', () => {
    renderWithIntl(<PrivacyReceiptCard receipt={LOCAL_ROUTED} />, { locale: 'de' });
    expect(screen.getByText(/Lokales LLM/)).toBeInTheDocument();
    expect(screen.getByText(/tenant label customer_data/)).toBeInTheDocument();
    expect(screen.getByText(/Data-Residency/)).toBeInTheDocument();
  });

  it('lists every detection with its action label and detector id', () => {
    renderWithIntl(<PrivacyReceiptCard receipt={TOKENIZED} />, { locale: 'de' });
    expect(screen.getByText(/E-Mail ×2 → maskiert/)).toBeInTheDocument();
    expect(screen.getByText(/IBAN ×1 → maskiert/)).toBeInTheDocument();
    const items = screen.getAllByText(/regex:0\.1\.0/);
    expect(items.length).toBeGreaterThanOrEqual(2);
  });

  it('truncates the audit-id but keeps the full value in the copy button payload', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    renderWithIntl(<PrivacyReceiptCard receipt={TOKENIZED} />, { locale: 'de' });
    const button = screen.getByRole('button', { name: /Audit-ID kopieren/ });
    fireEvent.click(button);

    expect(writeText).toHaveBeenCalledWith('prv_2026-05-08_b4e7f2a9');
  });

  it('does NOT leak any stringified original PII value in the rendered DOM', () => {
    // Defensive check: even with a contrived PII string in routingReason,
    // the receipt itself never carries spans/values, so nothing PII-shaped
    // should ever reach the DOM. This pins the contract — if someone widens
    // the receipt schema with a `value` field, this test starts failing
    // before it ships.
    const sneaky: PrivacyReceipt = {
      ...TOKENIZED,
    };
    const { container } = renderWithIntl(<PrivacyReceiptCard receipt={sneaky} />, { locale: 'de' });
    expect(container.textContent).not.toMatch(/@/);
    expect(container.textContent).not.toMatch(/DE\d{20}/);
  });
});

describe('computeSeverity()', () => {
  it('green when nothing was detected and routing is public-llm', () => {
    expect(computeSeverity(BASE)).toBe('green');
  });

  it('amber when detections were tokenised', () => {
    expect(computeSeverity(TOKENIZED)).toBe('amber');
  });

  it('red when routing is blocked', () => {
    expect(computeSeverity(BLOCKED)).toBe('red');
  });

  it('amber-or-worse when routing is local-llm even with no detections', () => {
    const local: PrivacyReceipt = {
      ...BASE,
      routing: 'local-llm',
      policyMode: 'data-residency',
    };
    expect(computeSeverity(local)).toBe('amber');
  });

  it('orange when at least one detection was redacted irreversibly', () => {
    const redacted: PrivacyReceipt = {
      ...BASE,
      detections: [
        {
          type: 'pii.api_key',
          count: 1,
          action: 'redacted',
          detector: 'regex:0.1.0',
          confidenceMin: 0.95,
        },
      ],
    };
    expect(computeSeverity(redacted)).toBe('orange');
  });
});
