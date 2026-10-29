import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import en from '../../../../messages/en.json';
import { renderWithIntl } from '../../../_lib/test-utils';

/**
 * #1552 / #1573 — `/operator/receipts?turn=<turnId>` shows that one turn's
 * receipt, expanded, with a way back to the full list. Miss reports and the
 * chat's receipt card link here.
 */

const { mockGetReceipt, mockListReceipts, mockKey } = vi.hoisted(() => ({
  mockGetReceipt: vi.fn(),
  mockListReceipts: vi.fn(),
  mockKey: vi.fn(),
}));

vi.mock('next-intl/server', async () => {
  const { createTranslator } = await import('next-intl');
  const messages = (await import('../../../../messages/en.json')).default;
  return {
    getTranslations: async (namespace: string) =>
      createTranslator({ locale: 'en', messages, namespace: namespace as never }),
  };
});

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock('../../../_lib/receipts', () => ({
  getReceipt: mockGetReceipt,
  listReceipts: mockListReceipts,
}));
vi.mock('../../../_lib/provenance', () => ({ getProvenancePublicKey: mockKey }));
vi.mock('../../../_lib/authRedirect', () => ({ redirectIfUnauthorized: vi.fn() }));
vi.mock('../_components/ChainStatusCard', () => ({
  ChainStatusCard: () => <div data-testid="chain-status" />,
}));
vi.mock('../../../_components/chat/PrivacyReceiptCard', () => ({
  PrivacyReceiptCard: () => <div data-testid="receipt-card" />,
}));

const { default: OperatorReceiptsPage } = await import('../page');

const t = en.operatorReceipts;
const TURN = 'turn-0123456789abcdef';

function row(turnId: string): unknown {
  return {
    turnId,
    receipt: { fieldsMasked: 2, datasetsInterned: 0 },
    createdAt: '2026-10-28T08:00:00.000Z',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockKey.mockResolvedValue(null);
  mockListReceipts.mockResolvedValue({ items: [row('a'), row('b')] });
});

describe('OperatorReceiptsPage — ?turn= deep link', () => {
  it('loads and expands the one receipt, with a link back', async () => {
    mockGetReceipt.mockResolvedValue(row(TURN));
    renderWithIntl(
      await OperatorReceiptsPage({ searchParams: Promise.resolve({ turn: TURN }) }),
    );

    expect(mockGetReceipt).toHaveBeenCalledWith(TURN);
    expect(mockListReceipts).not.toHaveBeenCalled();
    const details = screen.getByTestId(`receipt-row-${TURN}`) as HTMLDetailsElement;
    expect(details.open).toBe(true);
    expect(screen.getByRole('link', { name: t.backToAll }).getAttribute('href')).toBe(
      '/operator/receipts',
    );
  });

  it('says so when the turn has no stored receipt', async () => {
    mockGetReceipt.mockResolvedValue(null);
    renderWithIntl(
      await OperatorReceiptsPage({ searchParams: Promise.resolve({ turn: TURN }) }),
    );
    expect(screen.getByTestId('receipt-not-found').textContent).toBe(t.turnNotFound);
    expect(screen.getByRole('link', { name: t.backToAll })).toBeTruthy();
  });

  it('lists every receipt collapsed without the param', async () => {
    renderWithIntl(await OperatorReceiptsPage({ searchParams: Promise.resolve({}) }));
    expect(mockListReceipts).toHaveBeenCalledWith({ limit: 25 });
    expect(mockGetReceipt).not.toHaveBeenCalled();
    expect((screen.getByTestId('receipt-row-a') as HTMLDetailsElement).open).toBe(false);
    expect(screen.queryByRole('link', { name: t.backToAll })).toBeNull();
  });
});
