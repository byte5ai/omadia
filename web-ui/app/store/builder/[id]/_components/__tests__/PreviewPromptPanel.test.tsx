import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as api from '../../../../../_lib/api';
import { PreviewPromptPanel } from '../PreviewPromptPanel';

/**
 * Issue #55 — PreviewPromptPanel vitest cases.
 *
 * Coverage:
 *   - Mount triggers a fetch and renders sections per kind
 *   - Token count + health label render
 *   - Aktualisieren button refetches
 *   - Bumping `refetchKey` refetches
 *   - API error surfaces inline alert
 */

describe('<PreviewPromptPanel />', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: any;

  beforeEach(() => {
    fetchSpy = vi.spyOn(api, 'fetchBuilderPreviewPrompt');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches on mount and renders all sections by kind', async () => {
    fetchSpy.mockResolvedValueOnce({
      systemPrompt: '# Hi\n\n---\n\n<persona>...</persona>',
      tokens: 124,
      sections: [
        { label: 'Header', content: '# Hi', kind: 'header' },
        { label: 'Persona', content: '<persona>...</persona>', kind: 'persona' },
        { label: 'Sycophancy Guard', content: '## Critical Thinking', kind: 'sycophancy' },
      ],
    });
    render(<PreviewPromptPanel draftId="draft-1" />);
    await waitFor(() => {
      expect(screen.getByTestId('preview-prompt-section-header')).toBeInTheDocument();
    });
    expect(screen.getByTestId('preview-prompt-section-persona')).toBeInTheDocument();
    expect(screen.getByTestId('preview-prompt-section-sycophancy')).toBeInTheDocument();
    expect(screen.getByTestId('preview-prompt-tokens')).toHaveTextContent('124 Tokens');
  });

  it('Aktualisieren button refetches the prompt', async () => {
    fetchSpy.mockResolvedValue({
      systemPrompt: '# Hi',
      tokens: 1,
      sections: [{ label: 'Header', content: '# Hi', kind: 'header' }],
    });
    render(<PreviewPromptPanel draftId="draft-1" />);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId('preview-prompt-refresh'));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
  });

  it('bumping refetchKey refetches after the 500ms debounce', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      fetchSpy.mockResolvedValue({
        systemPrompt: '# Hi',
        tokens: 1,
        sections: [{ label: 'Header', content: '# Hi', kind: 'header' }],
      });
      const { rerender } = render(<PreviewPromptPanel draftId="draft-1" refetchKey={0} />);
      // Initial mount fetches immediately
      await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
      rerender(<PreviewPromptPanel draftId="draft-1" refetchKey={1} />);
      // Before debounce: still 1 call
      await vi.advanceTimersByTimeAsync(250);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      // After 500ms total: the second call fires
      await vi.advanceTimersByTimeAsync(300);
      await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces a burst of refetchKey bumps into one debounced fetch', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      fetchSpy.mockResolvedValue({
        systemPrompt: '# Hi',
        tokens: 1,
        sections: [{ label: 'Header', content: '# Hi', kind: 'header' }],
      });
      const { rerender } = render(<PreviewPromptPanel draftId="draft-1" refetchKey={0} />);
      await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
      // Three rapid bumps within 250ms each — only the last one survives
      // the debounce
      rerender(<PreviewPromptPanel draftId="draft-1" refetchKey={1} />);
      await vi.advanceTimersByTimeAsync(100);
      rerender(<PreviewPromptPanel draftId="draft-1" refetchKey={2} />);
      await vi.advanceTimersByTimeAsync(100);
      rerender(<PreviewPromptPanel draftId="draft-1" refetchKey={3} />);
      // Still only the initial mount fetch
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(600);
      await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders inline alert when fetch fails', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('boom'));
    render(<PreviewPromptPanel draftId="draft-1" />);
    await waitFor(() => {
      expect(screen.getByTestId('preview-prompt-error')).toHaveTextContent('boom');
    });
  });

  it('token-health label tracks token thresholds', async () => {
    fetchSpy.mockResolvedValueOnce({
      systemPrompt: 'x'.repeat(10),
      tokens: 1500,
      sections: [{ label: 'Header', content: '# Hi', kind: 'header' }],
    });
    render(<PreviewPromptPanel draftId="draft-1" />);
    await waitFor(() => {
      expect(screen.getByTestId('preview-prompt-tokens')).toHaveTextContent('gut');
    });
  });
});
