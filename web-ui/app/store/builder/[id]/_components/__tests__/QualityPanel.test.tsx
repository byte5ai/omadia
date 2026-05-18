import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as api from '../../../../../_lib/api';
import { QualityPanel } from '../QualityPanel';

/**
 * Issue #52 — QualityPanel vitest cases.
 *
 * Coverage:
 *   - Score badge in header, sweetspot + token-health pills
 *   - Expand toggle reveals the 4 dimension bars
 *   - Suggestion list renders by suggestion code
 *   - Aktualisieren button refetches
 *   - API error surfaces inline alert
 */

describe('<QualityPanel />', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: any;

  beforeEach(() => {
    fetchSpy = vi.spyOn(api, 'fetchBuilderQuality');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockOk(overrides: Partial<api.BuilderQualityResult> = {}): api.BuilderQualityResult {
    return {
      draftId: 'draft-1',
      score: 72,
      dimensions: {
        completeness: 75,
        tokenEfficiency: 90,
        ruleQuality: 60,
        specificity: 70,
      },
      sweetspot: 'sweet',
      tokenHealth: 'ok',
      suggestions: [],
      ...overrides,
    };
  }

  it('fetches on mount and renders the header score + sweetspot + token-health', async () => {
    fetchSpy.mockResolvedValueOnce(mockOk());
    render(<QualityPanel draftId="draft-1" />);
    await waitFor(() => {
      expect(screen.getByTestId('quality-sweetspot')).toHaveTextContent('Sweet Spot');
    });
    expect(screen.getByTestId('quality-token-health')).toHaveTextContent('OK');
    expect(screen.getByTestId('quality-toggle')).toHaveTextContent('72/100');
  });

  it('expand toggle reveals 4 dimension bars', async () => {
    fetchSpy.mockResolvedValueOnce(mockOk());
    render(<QualityPanel draftId="draft-1" />);
    await waitFor(() => expect(screen.getByTestId('quality-toggle')).toBeInTheDocument());
    // collapsed by default
    expect(screen.queryByTestId('quality-bar-completeness')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('quality-toggle'));
    expect(screen.getByTestId('quality-bar-completeness')).toBeInTheDocument();
    expect(screen.getByTestId('quality-bar-tokenEfficiency')).toBeInTheDocument();
    expect(screen.getByTestId('quality-bar-ruleQuality')).toBeInTheDocument();
    expect(screen.getByTestId('quality-bar-specificity')).toBeInTheDocument();
  });

  it('renders suggestions when present', async () => {
    fetchSpy.mockResolvedValueOnce(
      mockOk({
        suggestions: [
          { code: 'missing_field', message: 'Beschreibung fehlt.', dimension: 'completeness' },
          { code: 'vague_rule', message: 'Regel zu kurz.', dimension: 'ruleQuality' },
        ],
      }),
    );
    render(<QualityPanel draftId="draft-1" />);
    await waitFor(() => expect(screen.getByTestId('quality-toggle')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('quality-toggle'));
    expect(screen.getByTestId('quality-suggestion-missing_field')).toBeInTheDocument();
    expect(screen.getByTestId('quality-suggestion-vague_rule')).toBeInTheDocument();
  });

  it('Aktualisieren button refetches', async () => {
    fetchSpy.mockResolvedValue(mockOk());
    render(<QualityPanel draftId="draft-1" />);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId('quality-refresh'));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
  });

  it('renders inline alert on fetch failure', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('boom'));
    render(<QualityPanel draftId="draft-1" />);
    await waitFor(() => {
      expect(screen.getByTestId('quality-error')).toHaveTextContent('boom');
    });
  });
});
